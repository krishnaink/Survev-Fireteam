/**
 * Public dev entrypoint on :3000. Proxies HTTP (and Vite HMR WebSockets) to an
 * internal Vite server, and relays game/API WebSockets that Bun+Vite cannot proxy.
 *
 * WAN players only need port 3000 forwarded.
 */
import { createProxyServer } from "http-proxy";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { getConfig } from "../config.ts";

const Config = getConfig(false, "");
const publicPort = Config.vite.port;
const viteInternalPort = Number(process.env.SURVEV_VITE_INTERNAL_PORT ?? 3100);
const viteTarget = `http://127.0.0.1:${viteInternalPort}`;
const apiHost = "127.0.0.1";
const apiPort = Config.apiServer.port;
const gameMgrPort = Config.gameServer.port;
const firstGamePort = Config.gameServer.firstGamePort;

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

function relayWebSocket(client: WebSocket, targetUrl: string, clientIp?: string) {
    const headers: Record<string, string> = {};
    if (clientIp) {
        headers["X-Real-IP"] = clientIp;
        headers["X-Forwarded-For"] = clientIp;
    }

    const backend = new WebSocket(targetUrl, {
        headers,
        perMessageDeflate: false,
    });
    const pending: { data: WebSocket.RawData; isBinary: boolean }[] = [];

    const flushPending = () => {
        for (const msg of pending) {
            backend.send(msg.data, { binary: msg.isBinary });
        }
        pending.length = 0;
    };

    client.on("message", (data, isBinary) => {
        if (backend.readyState === WebSocket.OPEN) {
            backend.send(data, { binary: isBinary });
        } else {
            pending.push({ data, isBinary });
        }
    });

    backend.on("open", () => {
        flushPending();
        backend.on("message", (data, isBinary) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data, { binary: isBinary });
            }
        });
    });

    const pingIv = setInterval(() => {
        if (client.readyState === WebSocket.OPEN) client.ping();
        if (backend.readyState === WebSocket.OPEN) backend.ping();
    }, 25_000);

    const stopPing = () => clearInterval(pingIv);

    client.on("close", () => {
        stopPing();
        if (backend.readyState === WebSocket.OPEN || backend.readyState === WebSocket.CONNECTING) {
            backend.close();
        }
    });
    backend.on("close", () => {
        stopPing();
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.close();
        }
    });
    client.on("error", () => {
        stopPing();
        if (backend.readyState === WebSocket.OPEN || backend.readyState === WebSocket.CONNECTING) {
            backend.close();
        }
    });
    backend.on("error", (err) => {
        stopPing();
        console.error(`[wan-proxy] ${targetUrl}:`, err.message);
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.close();
        }
    });
}

function resolveGameWsTarget(pathname: string, search: string): string | null {
    if (pathname === "/team_v2" || pathname.startsWith("/team_v2/")) {
        return `ws://${apiHost}:${apiPort}/team_v2${search}`;
    }
    if (pathname === "/ptc" || pathname.startsWith("/ptc/")) {
        return `ws://${apiHost}:${gameMgrPort}/ptc${search}`;
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

function proxyHttp(req: IncomingMessage, res: ServerResponse) {
    const headers = { ...req.headers } as http.OutgoingHttpHeaders;
    const ip = clientIp(req);
    if (ip) headers["x-real-ip"] = ip;

    const url = new URL(req.url ?? "/", "http://localhost");
    // Session find_game lives on the game manager (child / colocated), not Vite.
    if (url.pathname === "/session/find_game" || url.pathname.startsWith("/session/")) {
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
            console.error("[wan-proxy] session:", err.message);
            if (!res.headersSent) {
                res.writeHead(502, { "Content-Type": "text/plain" });
                res.end("Game session endpoint is not ready yet.");
            }
        });
        req.pipe(proxyReq);
        return;
    }

    const proxyReq = http.request(
        {
            hostname: "127.0.0.1",
            port: viteInternalPort,
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
        console.error("[wan-proxy] vite http:", err.message);
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Vite dev server is not ready yet.");
        }
    });

    req.pipe(proxyReq);
}

const viteWsProxy = createProxyServer({ target: viteTarget, ws: true, changeOrigin: true });
viteWsProxy.on("error", (err, _req, res) => {
    console.error("[wan-proxy] vite ws:", err.message);
    if (res && "writeHead" in res && !res.headersSent) {
        res.writeHead(502);
        res.end();
    }
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const server = http.createServer(proxyHttp);

server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const wsTarget = resolveGameWsTarget(url.pathname, url.search);
    if (wsTarget) {
        wss.handleUpgrade(req, socket, head, (client) => {
            relayWebSocket(client, wsTarget, clientIp(req));
        });
        return;
    }
    viteWsProxy.ws(req, socket, head);
});

server.listen(publicPort, "0.0.0.0", () => {
    console.log(
        `[wan-proxy] http://0.0.0.0:${publicPort} -> vite ${viteTarget} (+ WS relay for /team_v2, /ptc, /g/*)`,
    );
});
