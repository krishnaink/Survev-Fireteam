/**
 * Production web entrypoint on :3000 (or ports.client in config).
 * Serves client/dist and proxies API HTTP + game WebSockets — no nginx required.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { getConfig } from "../config.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const distRoot = join(root, "client/dist");
const Config = getConfig(true, root);

const publicPort = Config.vite.port;
/** When frontend is split, proxy HTTP/WS to the remote (or local) API URL. */
function resolveBackend(urlStr: string): { host: string; port: number; https: boolean } {
    try {
        const u = new URL(urlStr);
        return {
            host: u.hostname || "127.0.0.1",
            port: u.port
                ? Number(u.port)
                : (u.protocol === "https:" ? 443 : 80),
            https: u.protocol === "https:",
        };
    } catch {
        return { host: "127.0.0.1", port: Config.apiServer.port, https: false };
    }
}

const apiTarget = resolveBackend(
    Config.apiUrl || Config.gameServer.apiServerUrl || `http://127.0.0.1:${Config.apiServer.port}`,
);
const apiHost = apiTarget.host;
const apiPort = apiTarget.port;
const gameMgrPort = Config.gameServer.port;
const firstGamePort = Config.gameServer.firstGamePort;

const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wasm": "application/wasm",
};

if (!existsSync(join(distRoot, "index.html"))) {
    console.error("[web] client/dist is missing. Run: bun run build");
    process.exit(1);
}

function clientIp(req: IncomingMessage): string {
    const xReal = req.headers["x-real-ip"];
    const xff = req.headers["x-forwarded-for"];
    const pick = (raw: string | string[] | undefined): string | undefined => {
        if (!raw) return undefined;
        const first = (Array.isArray(raw) ? raw[0] : raw).split(",")[0]?.trim();
        if (!first) return undefined;
        return first.replace(/^::ffff:/, "");
    };
    return pick(xReal) || pick(xff) || (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function relayWebSocket(client: WebSocket, targetUrl: string, ip?: string) {
    const headers: Record<string, string> = {};
    if (ip) {
        headers["X-Real-IP"] = ip;
        headers["X-Forwarded-For"] = ip;
    }

    const MAX_PENDING_FRAMES = 64;
    const CONNECT_TIMEOUT_MS = 10_000;

    let closed = false;
    const pendingToBackend: { data: WebSocket.RawData; isBinary: boolean }[] = [];
    const pendingToClient: { data: WebSocket.RawData; isBinary: boolean }[] = [];

    const enqueue = (
        queue: { data: WebSocket.RawData; isBinary: boolean }[],
        item: { data: WebSocket.RawData; isBinary: boolean },
    ) => {
        queue.push(item);
        while (queue.length > MAX_PENDING_FRAMES) {
            queue.shift();
        }
    };

    const backend = new WebSocket(targetUrl, {
        headers,
        perMessageDeflate: false,
    });

    const connectTimeout = setTimeout(() => {
        if (backend.readyState === WebSocket.CONNECTING) {
            console.error(`[web] WS connect timeout: ${targetUrl}`);
            backend.terminate();
            if (!closed && client.readyState === WebSocket.OPEN) {
                client.close(1014, "backend timeout");
            }
        }
    }, CONNECT_TIMEOUT_MS);

    const stopPing = () => clearInterval(pingIv);
    const cleanup = () => {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimeout);
        stopPing();
    };

    const flushPendingToBackend = () => {
        for (const msg of pendingToBackend) {
            backend.send(msg.data, { binary: msg.isBinary });
        }
        pendingToBackend.length = 0;
    };

    const flushPendingToClient = () => {
        if (client.readyState !== WebSocket.OPEN) return;
        for (const msg of pendingToClient) {
            client.send(msg.data, { binary: msg.isBinary });
        }
        pendingToClient.length = 0;
    };

    client.on("message", (data, isBinary) => {
        if (closed) return;
        if (backend.readyState === WebSocket.OPEN) {
            backend.send(data, { binary: isBinary });
        } else if (backend.readyState === WebSocket.CONNECTING) {
            enqueue(pendingToBackend, { data, isBinary });
        }
    });

    backend.on("open", () => {
        clearTimeout(connectTimeout);
        flushPendingToBackend();
        flushPendingToClient();
    });

    backend.on("message", (data, isBinary) => {
        if (closed) return;
        if (client.readyState === WebSocket.OPEN) {
            client.send(data, { binary: isBinary });
        } else {
            enqueue(pendingToClient, { data, isBinary });
        }
    });

    const pingIv = setInterval(() => {
        if (closed) return;
        if (client.readyState === WebSocket.OPEN) client.ping();
        if (backend.readyState === WebSocket.OPEN) backend.ping();
    }, 25_000);

    const closeBoth = () => {
        if (closed) return;
        cleanup();
        if (backend.readyState === WebSocket.OPEN || backend.readyState === WebSocket.CONNECTING) {
            backend.close();
        }
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.close();
        }
    };

    client.on("close", closeBoth);
    backend.on("close", closeBoth);
    client.on("error", (err) => {
        console.error(`[web] client WS error (${targetUrl}):`, err.message);
        closeBoth();
    });
    backend.on("error", (err) => {
        console.error(`[web] backend WS error (${targetUrl}):`, err.message);
        closeBoth();
    });
}

function resolveGameWsTarget(pathname: string, search: string): string | null {
    if (pathname === "/team_v2" || pathname.startsWith("/team_v2/")) {
        const proto = apiTarget.https ? "wss" : "ws";
        return `${proto}://${apiHost}:${apiPort}/team_v2${search}`;
    }
    if (pathname === "/ptc" || pathname.startsWith("/ptc/")) {
        // Ping lives on the game manager. Prefer local game; else try api host:game port
        // (colocated). Multi-region clients should hit each region's publicAddress/ptc.
        return `ws://127.0.0.1:${gameMgrPort}/ptc${search}`;
    }
    const m = /^\/g\/(\d+)(\/.*)?$/.exec(pathname);
    if (m) {
        const port = Number(m[1]);
        if (port < firstGamePort || port >= firstGamePort + Config.gameServer.maxGames) {
            return null;
        }
        const rest = m[2] || "/";
        return `ws://127.0.0.1:${port}${rest}${search}`;
    }
    return null;
}

function proxyApi(req: IncomingMessage, res: ServerResponse) {
    const headers = { ...req.headers } as http.OutgoingHttpHeaders;
    const ip = clientIp(req);
    if (ip) headers["x-real-ip"] = ip;

    const proxyReq = http.request(
        {
            hostname: apiHost,
            port: apiPort,
            path: req.url,
            method: req.method,
            headers,
        },
        (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
        },
    );

    proxyReq.on("error", (err) => {
        console.error("[web] api:", err.message);
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("API server is not ready yet.");
        }
    });

    req.pipe(proxyReq);
}

function safeDistPath(urlPath: string): string | null {
    const rel = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = join(distRoot, rel);
    if (!full.startsWith(distRoot)) return null;
    return full;
}

function sendFile(filePath: string, res: ServerResponse) {
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mime[ext] ?? "application/octet-stream" });
    createReadStream(filePath).pipe(res);
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith("/stats") && !pathname.endsWith("/") && !extname(pathname)) {
        res.writeHead(301, { Location: pathname + "/" + url.search });
        res.end();
        return;
    }

    if (pathname === "/" || pathname === "") {
        pathname = "/index.html";
    } else if (pathname.startsWith("/stats/") && !extname(pathname)) {
        pathname = "/stats/index.html";
    }

    const filePath = safeDistPath(pathname);
    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
        sendFile(filePath, res);
        return;
    }

    if (!extname(pathname)) {
        const fallback = safeDistPath("/index.html");
        if (fallback && existsSync(fallback)) {
            sendFile(fallback, res);
            return;
        }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
}

function proxyGameSession(req: IncomingMessage, res: ServerResponse) {
    const headers = { ...req.headers } as http.OutgoingHttpHeaders;
    const ip = clientIp(req);
    if (ip) headers["x-real-ip"] = ip;

    const proxyReq = http.request(
        {
            hostname: "127.0.0.1",
            port: gameMgrPort,
            path: req.url,
            method: req.method,
            headers,
        },
        (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
        },
    );

    proxyReq.on("error", (err) => {
        console.error("[web] session:", err.message);
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Game session endpoint is not ready yet.");
        }
    });

    req.pipe(proxyReq);
}

function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/session/find_game" || url.pathname.startsWith("/session/")) {
        proxyGameSession(req, res);
        return;
    }
    if (
        url.pathname === "/api" || url.pathname.startsWith("/api/")
        || url.pathname === "/private" || url.pathname.startsWith("/private/")
    ) {
        proxyApi(req, res);
        return;
    }
    serveStatic(req, res);
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const server = http.createServer(handleHttp);

server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const wsTarget = resolveGameWsTarget(url.pathname, url.search);
    if (!wsTarget) {
        socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
        relayWebSocket(client, wsTarget, clientIp(req));
    });
});

server.listen(publicPort, "0.0.0.0", () => {
    console.log(`[web] http://0.0.0.0:${publicPort} (client/dist + /api + WS /team_v2 /ptc /g/*)`);
});
