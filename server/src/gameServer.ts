import type { ServerWebSocket } from "bun";
import { Cron } from "croner";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import pkgJson from "../../package.json" with { type: "json" };
import { GameConfig } from "../../shared/gameConfig.ts";
import { Config, loadedConfigPath, teamSizeForMode } from "./config.ts";
import { GameProcessManager, ProcState } from "./game/gameProcessManager.ts";
import { apiKeysMatch, isApiKeyConfigured } from "./utils/apiAuth.ts";
import { apiPrivateRouter } from "./utils/apiRouter.ts";
import { GIT_VERSION } from "./utils/gitRevision.ts";
import { logErrorToWebhook, ServerLogger } from "./utils/logger.ts";
import { HTTPRateLimit, WebSocketRateLimit } from "./utils/rateLimit.ts";
import { resolveClientIp } from "./utils/requestIp.ts";
import { verifyFindGameTicket } from "./utils/sessionTicket.ts";
import {
    type FindGamePrivateBody,
    type FindGamePrivateRes,
    type SaveGameBody,
    zFindGamePrivateBody,
} from "./utils/types.ts";

process.on("uncaughtException", async (err) => {
    console.error(err);

    await logErrorToWebhook("server", "Game server error:", err);

    process.exit(1);
});

class GameServer {
    readonly logger = new ServerLogger("GameServer");

    readonly region = Config.regions[Config.gameServer.thisRegion];
    readonly regionId = Config.gameServer.thisRegion;

    readonly manager = new GameProcessManager();

    /** True after a successful secret handshake with the main API host. */
    linkedToApi = false;
    private handshakeFailLogged = false;
    private lastPublicGamesPush = 0;

    async findGame(body: FindGamePrivateBody): Promise<FindGamePrivateRes> {
        if (body.version !== GameConfig.protocolVersion) {
            return { error: "invalid_protocol" };
        }

        if (body.region !== this.regionId) {
            return { error: "invalid_region" };
        }

        const game = await this.manager.findGame({
            region: body.region,
            version: body.version,
            autoFill: body.autoFill,
            mapName: body.mapName,
            teamMode: body.teamMode,
            squadSize: body.squadSize,
            difficulty: body.difficulty,
            endless: body.endless,
            contractsEnabled: body.contractsEnabled,
            playerData: body.playerData,
            gameId: body.gameId,
        });
        if (!game) {
            return {
                error: "full",
            };
        }

        const protocol = this.region.https ? "wss" : "ws";
        const host = this.region.publicAddress || this.region.address;
        // Match WS is tunneled via the site (/g/<port>/play); game ports are not public.
        const gamePortUrl = new URL(`${protocol}://${host}/g/${game.port}/play`);
        gamePortUrl.searchParams.set("gameId", game.gameData.id);

        return {
            gameId: game.gameData.id,
            urls: [gamePortUrl.toString()],
        };
    }

    /**
     * Prove we share secrets.SURVEV_API_KEY with the API host, then register this
     * node for the Server dropdown. Listing is heartbeat-based (update_region);
     * the master does not probe this host until a player actually find_game's here.
     */
    async handshakeWithApi(): Promise<boolean> {
        if (!isApiKeyConfigured(Config.secrets.SURVEV_API_KEY)) {
            this.linkedToApi = false;
            if (!this.handshakeFailLogged) {
                this.logger.error(
                    "secrets.SURVEV_API_KEY is missing or too short — "
                        + "set the same key as the main API host (min 16 chars).",
                );
                this.handshakeFailLogged = true;
            }
            return false;
        }

        try {
            const res = await apiPrivateRouter.handshake.$post({
                json: {
                    regionId: this.regionId,
                    name: this.region.name,
                    url: this.region.url
                        || (this.region.publicAddress
                            ? `${this.region.https ? "https" : "http"}://${this.region.publicAddress}`
                            : undefined),
                    // Master uses this to reach /api/find_game on this node.
                    address: this.region.address,
                },
            });
            if (!res.ok) {
                this.linkedToApi = false;
                if (!this.handshakeFailLogged) {
                    this.logger.error(
                        `API handshake rejected (${res.status}) — `
                            + "wrong SURVEV_API_KEY, or bad address/url for registration. "
                            + `API: ${Config.gameServer.apiServerUrl}`,
                    );
                    this.handshakeFailLogged = true;
                }
                return false;
            }
            const body = await res.json();
            if (!body?.ok) {
                this.linkedToApi = false;
                if (!this.handshakeFailLogged) {
                    this.logger.error(
                        `API handshake failed: ${(body as { error?: string })?.error ?? "unknown"}`,
                    );
                    this.handshakeFailLogged = true;
                }
                return false;
            }
            if (!this.linkedToApi) {
                const addr = this.region.address || "";
                const loopback = /^(127\.|localhost|::1)/i.test(addr);
                const apiRemote = !/127\.0\.0\.1|localhost/i.test(
                    Config.gameServer.apiServerUrl,
                );
                if (loopback && apiRemote) {
                    this.logger.warn(
                        `Registered with loopback address "${addr}" but API is remote `
                            + `(${Config.gameServer.apiServerUrl}). `
                            + "Set regions.<id>.address to a host:port the master can reach "
                            + "(bind: \"0.0.0.0\" on this node).",
                    );
                }
                this.logger.info(
                    `Linked to API host as server "${this.regionId}" `
                        + `(${Config.gameServer.apiServerUrl})`,
                );
            }
            this.linkedToApi = true;
            this.handshakeFailLogged = false;
            return true;
        } catch (err) {
            this.linkedToApi = false;
            if (!this.handshakeFailLogged) {
                this.logger.error(
                    `API handshake unreachable at ${Config.gameServer.apiServerUrl}: `,
                    err,
                );
                this.handshakeFailLogged = true;
            }
            return false;
        }
    }

    async sendData(forcePublicGames = false) {
        if (!this.linkedToApi) {
            const ok = await this.handshakeWithApi();
            if (!ok) return;
        }

        // Heartbeat is player count only. Public browser list is a separate, rarer push
        // so a busy match list cannot stall directory updates.
        const data: {
            playerCount: number;
            publicGames?: Array<{
                gameId: string;
                mapName: string;
                teamMode: number;
                players: number;
                maxPlayers: number;
                timeRunning: number;
                canJoin: boolean;
            }>;
        } = {
            playerCount: this.manager.getPlayerCount(),
        };

        const now = Date.now();
        if (forcePublicGames || now - this.lastPublicGamesPush >= 30_000) {
            this.lastPublicGamesPush = now;
            data.publicGames = server.manager.processes
                .filter((p) => p.state === ProcState.Running && !p.noFill && p.gameData.browsable)
                .map((p) => ({
                    gameId: p.gameData.id,
                    mapName: p.gameData.mapName,
                    teamMode: p.gameData.teamMode,
                    players: p.gameData.aliveCount,
                    maxPlayers: teamSizeForMode(
                        p.gameData.teamMode,
                        p.gameData.squadSize ?? Config.maxSquadSize,
                    ),
                    timeRunning: Math.round(p.gameData.timeRunning),
                    canJoin: p.gameData.browsable,
                }));
        }

        try {
            const res = await apiPrivateRouter.update_region.$post({
                json: {
                    data,
                    regionId: Config.gameServer.thisRegion,
                },
            });
            if (!res.ok) {
                this.linkedToApi = false;
                this.logger.warn(
                    `update_region rejected (${res.status}) — re-handshake required`,
                );
            }
        } catch (err) {
            this.linkedToApi = false;
            this.logger.error(`Failed to update region: `, err);
        }
    }

    async tryToSaveLostGames() {
        const games: SaveGameBody["matchData"] = [];

        const dir = path.resolve("lost_game_data");

        if (!existsSync(dir)) return;

        const files = await fs.readdir(dir);

        for (const fileName of files) {
            const filePath = path.resolve(dir, fileName);
            const data = JSON.parse(await fs.readFile(filePath, "utf8"));
            games.push(...data);
        }

        if (games.length < 2) return;

        this.logger.info(`${games.length} lost games found, trying to save...`);

        let res:
            | Awaited<
                ReturnType<typeof apiPrivateRouter.save_game.$post>
            >
            | undefined = undefined;
        try {
            res = await apiPrivateRouter.save_game.$post({
                json: {
                    matchData: games,
                },
            });
        } catch (err) {
            this.logger.error(`Failed to fetch API save game:`, err);
        }

        if (res?.ok) {
            this.logger.info(`successfully saved lost games!`);
            for (const fileName of files) {
                const filePath = path.resolve(dir, fileName);
                await fs.rm(filePath);
            }
        }
    }
}

const server = new GameServer();
server.manager.onPublicGamesSync = () => {
    void server.sendData(true);
};

function shutdownGameChildren() {
    server.manager.shutdownAll();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
        shutdownGameChildren();
        process.exit(0);
    });
}

const pingHTTPRateLimit = new HTTPRateLimit(40, 1000);
const pingWsRateLimit = new WebSocketRateLimit(80, 1000, 64);
const sessionFindRateLimit = new HTTPRateLimit(20, 3000);

interface PingSocketData {
    rateLimit: Record<symbol, number>;
    ip: string;
}

function forbidden(): Response {
    return new Response("403 Forbidden", { status: 403 });
}

function corsSessionHeaders(req: Request): HeadersInit {
    const origin = req.headers.get("origin") || "*";
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}

const tls = Config.gameServer.ssl
    ? {
        key: await Bun.file(Config.gameServer.ssl.keyFile).text(),
        cert: await Bun.file(Config.gameServer.ssl.certFile).text(),
    }
    : undefined;

const listenHost = Config.gameServer.host === "::" ? "[::]" : Config.gameServer.host;

Bun.serve<PingSocketData>({
    hostname: listenHost,
    port: Config.gameServer.port,
    tls,
    fetch(req, bunServer) {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/health") {
            return new Response("OK");
        }

        if (req.method === "GET" && url.pathname === "/private/status") {
            if (!apiKeysMatch(req.headers.get("survev-api-key"), Config.secrets.SURVEV_API_KEY)) {
                return forbidden();
            }
            return Response.json({
                gameCount: server.manager.processes.length,
                games: server.manager.processes.map((p) => {
                    return {
                        state: ProcState[p.state],
                        reusedCount: p.reusedCount,
                        avaliableSlots: p.avaliableSlots,
                        port: p.port,
                        gameData: p.gameData,
                    };
                }),
            });
        }

        // Player / team session find — ticket from master, matchmaking stays on this node.
        if (url.pathname === "/session/find_game") {
            const cors = corsSessionHeaders(req);
            if (req.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: cors });
            }
            if (req.method !== "POST") {
                return new Response("Method Not Allowed", { status: 405, headers: cors });
            }

            const ip = resolveClientIp(
                req,
                bunServer.requestIP(req)?.address,
                Config.gameServer.proxyIPHeader,
            ) || "unknown";
            if (sessionFindRateLimit.isRateLimited(ip)) {
                return Response.json(
                    { error: "rate_limited" },
                    { status: 429, headers: cors },
                );
            }

            return req.json()
                .then(async (body: { ticket?: string }) => {
                    const verified = verifyFindGameTicket(
                        body?.ticket ?? "",
                        Config.secrets.SURVEV_API_KEY,
                    );
                    if (!verified) {
                        return Response.json(
                            { error: "invalid_region" },
                            { status: 403, headers: cors },
                        );
                    }
                    if (verified.region !== server.regionId) {
                        return Response.json(
                            { error: "invalid_region" },
                            { status: 403, headers: cors },
                        );
                    }
                    const parsed = zFindGamePrivateBody.parse(verified.findGame);
                    const data = await server.findGame(parsed);
                    return Response.json(data, { headers: cors });
                })
                .catch((error) => {
                    server.logger.warn("/session/find_game error: ", error);
                    return Response.json(
                        { error: "find_game_failed" },
                        { status: 400, headers: cors },
                    );
                });
        }

        // Legacy master→child private find (kept for older tooling; solo/team use /session).
        if (req.method === "POST" && url.pathname === "/api/find_game") {
            if (!apiKeysMatch(req.headers.get("survev-api-key"), Config.secrets.SURVEV_API_KEY)) {
                return forbidden();
            }
            return req.json()
                .then((body) => server.findGame(zFindGamePrivateBody.parse(body)))
                .then((data) => Response.json(data))
                .catch((error) => {
                    server.logger.warn("/api/find_game error: ", error);
                    return new Response("400 Bad Request", { status: 400 });
                });
        }

        if (url.pathname === "/ptc") {
            const ip = resolveClientIp(
                req,
                bunServer.requestIP(req)?.address,
                Config.gameServer.proxyIPHeader,
            );

            if (!ip) {
                server.logger.warn("Invalid IP Found");
                return new Response("403 Forbidden", { status: 403 });
            }

            if (pingHTTPRateLimit.isRateLimited(ip) || pingWsRateLimit.isIpRateLimited(ip)) {
                return new Response("429 Too Many Requests", { status: 429 });
            }

            pingWsRateLimit.ipConnected(ip);

            if (bunServer.upgrade(req, { data: { rateLimit: {}, ip } })) {
                return;
            }

            pingWsRateLimit.ipDisconnected(ip);
            return new Response("Upgrade failed", { status: 500 });
        }

        return new Response("Not Found", { status: 404 });
    },
    websocket: {
        idleTimeout: 10,
        maxPayloadLength: 2,
        message(ws: ServerWebSocket<PingSocketData>, message) {
            if (pingWsRateLimit.isRateLimited(ws.data.rateLimit)) {
                server.logger.warn("Ping websocket rate limited, closing socket.");
                ws.close();
                return;
            }
            ws.send(message);
        },
        close(ws: ServerWebSocket<PingSocketData>) {
            pingWsRateLimit.ipDisconnected(ws.data.ip);
        },
    },
});

server.sendData();
setInterval(() => {
    server.sendData();
}, 5 * 1000);

server.logger.info(`Survev Game Server v${pkgJson.version} - GIT ${GIT_VERSION}`);
server.logger.info(`Config: ${loadedConfigPath}`);
server.logger.info(`Region: ${Config.gameServer.thisRegion}`);
server.logger.info(`Listening on ${Config.gameServer.host}:${Config.gameServer.port} (ping / manager)`);
const matchFirst = Config.gameServer.firstGamePort;
const matchLast = matchFirst + Config.gameServer.maxGames - 1;
server.logger.info(
    `Match WebSockets: ${Config.gameServer.host}:${matchFirst}–${matchLast} (${Config.gameServer.maxGames} slots, spawned on demand)`,
);
server.logger.info("Press Ctrl+C to exit.");

new Cron("0 * * * *", async () => {
    try {
        await server.tryToSaveLostGames();
    } catch (err) {
        server.logger.error("Failed to save lost games", err);
    }
});
