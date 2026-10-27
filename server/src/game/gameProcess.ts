import type { ServerWebSocket } from "bun";
import fs from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { FIRETEAM_VERSION } from "../../../shared/fireteamVersion.ts";
import { TeamMode } from "../../../shared/gameConfig.ts";
import type { GameWsDisconnectReason } from "../../../shared/types/api.ts";
import { Logger } from "../../../shared/utils/logger.ts";
import { insertLocalMatchData } from "../api/db/localMatchStore.ts";
import { Config } from "../config.ts";
import { apiPrivateRouter, checkIp } from "../utils/apiRouter.ts";
import { resolveFireteamSquadName } from "../utils/badWords.ts";
import { logErrorToWebhook } from "../utils/logger.ts";
import { HTTPRateLimit, WebSocketRateLimit } from "../utils/rateLimit.ts";
import { resolveClientIp } from "../utils/requestIp.ts";
import type { SaveGameBody } from "../utils/types.ts";
import type { Client } from "./client.ts";
import { Game } from "./game.ts";
import { type ProcessMsg, ProcessMsgType } from "./ipcTypes.ts";
import { ClientSocket } from "./socket.ts";

function sendMsg(msg: ProcessMsg) {
    process.send!(msg);
}

let game: ServerGame | undefined;
let gameWeakRef: WeakRef<ServerGame> | undefined;

const procLogger = new Logger(Config.logging, `GameProc-${process.pid}`);

function broadcastDisconnect(reason: GameWsDisconnectReason) {
    if (game) {
        for (const client of game.clientBarn.clients) {
            client.socket.close(reason);
        }
    }
}
process.on("disconnect", () => {
    broadcastDisconnect("server_restart");
    process.exit();
});

process.on("uncaughtException", async (err) => {
    console.error(err);
    broadcastDisconnect("server_crashed");

    game = undefined;
    await logErrorToWebhook("server", "Game process error", err);

    process.exit(1);
});

function stopGame() {
    game = undefined;

    // make sure game is properly free'd
    // we expose the gc on dev builds
    if (global.gc) {
        setImmediate(async () => {
            await global.gc!({
                execution: "async",
            });
            if (gameWeakRef?.deref()) {
                procLogger.warn("Possible memory leak found, something is keeping a reference to the game object!");
            }
        });
    }
}

//
// Keep saveGame and sendQuestProgress separated from the game class
// This ensures that waiting for the network request doesn't prevent the game instance from being GC'd
//

async function saveGame(gameId: string, values: SaveGameBody["matchData"]) {
    // Local SQLite backup on game nodes / hosts without a primary DB engine.
    // Gameplay stays on this node; only stats are pushed to the API host below.
    if (!Config.database.enabled) {
        try {
            insertLocalMatchData(values);
            procLogger.info(`Saved game ${gameId} to local SQLite (${values.length} players)`);
        } catch (err) {
            procLogger.error(`Failed to save game to local SQLite:`, err);
        }
    }

    // Always push to the API host (master leaderboards / primary DB).
    let res:
        | Awaited<
            ReturnType<typeof apiPrivateRouter.save_game.$post>
        >
        | undefined = undefined;
    try {
        res = await apiPrivateRouter.save_game.$post({
            json: {
                matchData: values,
            },
        });
    } catch (err) {
        procLogger.error(`Failed to fetch API save game:`, err);
    }

    if (!res || !res.ok) {
        const region = Config.gameServer.thisRegion.toUpperCase();
        procLogger.error(
            `[${region}] Failed to save game data to API, keeping lost_game_data backup`,
        );

        const dir = path.resolve("lost_game_data");
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
        }
        fs.writeFileSync(
            path.join(dir, `${gameId}.json`),
            JSON.stringify(values),
            "utf8",
        );
    } else {
        procLogger.info(`Pushed game ${gameId} stats to API host`);
    }
}

async function sendQuestProgress(userId: string, progress: Array<{ id: string; delta: number }>) {
    try {
        const req = await apiPrivateRouter.quest_progress.$post({
            json: {
                userId,
                progress,
            },
        });
        const res = await req.json();
        if (!req.ok || !(res as { success: boolean }).success) {
            procLogger.error(`Failed to save quest progress`, res);
        }
    } catch (err) {
        procLogger.error(`Failed to save quest progress:`, err);
    }
}

/**
 * Implements methods only used when the game is actually running on a server
 */
class ServerGame extends Game {
    override updateData() {
        const pendingJoinTokens = this.pendingJoinTokens();
        sendMsg({
            type: ProcessMsgType.UpdateData,
            id: this.id,
            teamMode: this.teamMode,
            squadSize: this.maxTeamSize,
            mapName: this.mapName,
            canJoin: this.canJoin,
            browsable: this.browsable,
            aliveCount: this.map.specOpsMode
                ? (this.specOps?.operatorCount ?? 0)
                : this.aliveCount,
            pendingJoinTokens,
            startedTime: this.startedTime,
            stopped: this.stopped,
            timeRunning: this.timeRunning,
            difficulty: this.config.difficulty,
            endless: this.config.endless,
        });
        if (this.stopped) {
            stopGame();
        }
    }

    override _saveGameToDatabase() {
        // don't save games that never started
        if (!this.started) return;

        const players = this.modeManager.getPlayersSortedByRank();
        /**
         * teamTotal is for total teams that started the match, i hope?
         *
         * it also seems to be unused by the client so we could also remove it?
         */
        const teamTotal = new Set(players.map(({ player }) => player.teamId)).size;

        const teamKills = players.reduce(
            (acc, curr) => {
                acc[curr.player.teamId] = (acc[curr.player.teamId] ?? 0) + curr.player.kills;
                return acc;
            },
            {} as Record<string, number>,
        );

        // One shared fireteam label for every teammate so duo/squad boards group correctly.
        const fireteamNameByGroupId = new Map<number, string>();
        if (this.teamMode !== TeamMode.Solo) {
            for (const { player } of players) {
                const group = player.group;
                if (!group || fireteamNameByGroupId.has(group.id)) continue;
                const humans = group.players.filter((p) => !p.specOpsAi);
                fireteamNameByGroupId.set(
                    group.id,
                    resolveFireteamSquadName(
                        group.squadName,
                        humans.map((p) => p.name),
                    ),
                );
            }
        }

        const values: SaveGameBody["matchData"] = players.map(({ player, rank }) => {
            return {
                // *NOTE: userId is optional; we save the game stats for non logged users too
                userId: player.userId,
                region: Config.gameServer.thisRegion,
                username: player.name,
                playerId: player.matchDataId,
                teamMode: this.teamMode,
                teamCount: player.group?.players.length ?? 1,
                teamTotal: teamTotal,
                teamId: player.teamId,
                timeAlive: Math.round(player.timeAlive),
                wavesSurvived: this.map.specOpsMode
                    ? Math.max(0, this.specOps?.wave ?? 0)
                    : 0,
                squadName: this.teamMode === TeamMode.Solo
                    ? ""
                    : (fireteamNameByGroupId.get(player.group?.id ?? -1) ?? ""),
                gameVersion: this.map.specOpsMode ? FIRETEAM_VERSION : "",
                difficulty: this.map.specOpsMode
                    ? (this.config.difficulty ?? "")
                    : "",
                died: player.dead,
                kills: player.kills,
                downs: player.downedCount,
                revives: player.revives,
                teamKills: teamKills[player.teamId] ?? 0,
                damageDealt: Math.round(player.damageDealt),
                damageTaken: Math.round(player.damageTaken),
                killerId: player.killedBy?.matchDataId || 0,
                gameId: this.id,
                mapId: this.map.mapId,
                mapSeed: this.map.seed,
                killedIds: player.killedIds,
                rank: rank,
                ip: player.client.ip,
                findGameIp: player.client.findGameIp,
                role: player.role,
            };
        });

        // Spec Ops solo matches should still count on the local leaderboard.
        const minPlayers = this.map.specOpsMode ? 1 : 2;
        if (values.length < minPlayers) return;
        saveGame(this.id, values);
    }

    override sendQuestProgress(userId: string, progress: Array<{ id: string; delta: number }>) {
        sendQuestProgress(userId, progress);
    }
}

let lastMsgTime = Date.now();
process.on("message", (msg: ProcessMsg) => {
    lastMsgTime = Date.now();

    if (msg.type === ProcessMsgType.Create) {
        // Parent may reuse this process before the previous game fully cleared.
        // Always honor Create so findGame cannot hang on a stuck CreatingGame.
        if (game) {
            try {
                game.stop();
            } catch {
                // ignore teardown errors from a dying game
            }
            game = undefined;
        }
        game = new ServerGame(msg.id, msg.config);
        gameWeakRef = new WeakRef(game);
        return;
    }

    if (!game) return;

    switch (msg.type) {
        case ProcessMsgType.AddJoinToken:
            const accepted = game.addJoinTokens(msg.tokens, msg.autoFill, msg.squadName ?? "");
            game.updateData();
            sendMsg({
                type: ProcessMsgType.JoinTokensApplied,
                accepted,
                pendingJoinTokens: game.pendingJoinTokens(),
            });
            break;
    }
});

setInterval(() => {
    if (Date.now() - lastMsgTime > 10000) {
        console.log("Game process has not received a message in 10 seconds, exiting");
        process.exit();
    }

    if (game) {
        game?.updateData();
    } else {
        sendMsg({
            type: ProcessMsgType.KeepAlive,
        });
    }
}, 5000);

let setGameInterval: (cb: () => void, time: number) => void = setInterval;
if (platform() === "win32") {
    const NanoTimer = (await import("nanotimer")).default;
    // setInterval on windows sucks
    // and doesn't give accurate timings
    setGameInterval = (cb: () => void, time: number) => {
        new NanoTimer().setInterval(cb, [], `${time}m`);
    };
}

setGameInterval(() => {
    game?.update();
}, 1000 / Config.gameTps);

setGameInterval(() => {
    game?.netSync();
}, 1000 / Config.netSyncTps);

interface GameSocketData {
    ip: string;
    rateLimit: Record<symbol, number>;
    disconnectReason?: GameWsDisconnectReason;
    clientSocket?: BunGameSocket;
}

class BunGameSocket extends ClientSocket<Client> {
    private _socket: ServerWebSocket<GameSocketData>;
    private _ip: string;

    _closed = false;
    _backpressured = false;
    droppedSends = 0;

    constructor(socket: ServerWebSocket<GameSocketData>, ip: string) {
        super();
        this._socket = socket;
        this._ip = ip;
    }

    ip(): string {
        return this._ip;
    }

    closed(): boolean {
        return this._closed;
    }

    isBackpressured(): boolean {
        return this._backpressured;
    }

    clearBackpressure(): void {
        this._backpressured = false;
    }

    send(data: Uint8Array<ArrayBuffer>): void {
        if (this._closed) return;
        this._socket.cork(() => {
            const result = this._socket.send(data);
            if (result === 0) {
                this.droppedSends++;
            } else if (result < 0) {
                this._backpressured = true;
            }
        });
    }

    close(reason?: GameWsDisconnectReason): void {
        if (this._closed) return;
        this._closed = true;
        this._socket.close(reason ? 3000 : 1000, reason);
    }
}

const gameHTTPRateLimit = new HTTPRateLimit(40, 1000);
// Concurrent WS cap must fit a full squad plus reconnect races (old+new socket
// briefly overlap). Shared CGNAT / mis-forwarded proxy IPs need headroom too.
const gameWsRateLimit = new WebSocketRateLimit(
    800,
    1000,
    Math.max(Config.maxSquadSize * 4, 32),
);

const port = parseInt(process.argv[2]);

const tls = Config.gameServer.ssl
    ? {
        key: await Bun.file(Config.gameServer.ssl.keyFile).text(),
        cert: await Bun.file(Config.gameServer.ssl.certFile).text(),
    }
    : undefined;

const listenHost = Config.gameServer.host === "::" ? "[::]" : Config.gameServer.host;

Bun.serve<GameSocketData>({
    hostname: listenHost,
    port,
    tls,
    fetch(req, bunServer) {
        const url = new URL(req.url);

        if (url.pathname !== "/play") {
            return new Response("Not Found", { status: 404 });
        }

        if (!game) {
            procLogger.warn("Websocket upgrade closed: process not running a game");
            return new Response("503 Service Unavailable", { status: 503 });
        }

        const ip = resolveClientIp(
            req,
            bunServer.requestIP(req)?.address,
            Config.gameServer.proxyIPHeader,
        );

        if (!ip) {
            game.logger.warn("Invalid IP Found");
            return new Response("403 Forbidden", { status: 403 });
        }

        if (gameHTTPRateLimit.isRateLimited(ip) || gameWsRateLimit.isIpRateLimited(ip)) {
            game.logger.warn("Websocket upgrade closed: Rate limited");
            return new Response("429 Too Many Requests", { status: 429 });
        }

        const gameId = url.searchParams.get("gameId");

        if (!gameId) {
            game.logger.warn("Websocket upgrade closed: no game ID");
            return new Response("403 Forbidden", { status: 403 });
        }

        if (game.id !== gameId) {
            game.logger.warn("Websocket upgrade closed: invalid game ID");
            return new Response("403 Forbidden", { status: 403 });
        }

        if (!game.canJoin && game.pendingJoinTokens() <= 0) {
            game.logger.warn("Websocket upgrade closed: game already started");
            return new Response("403 Forbidden", { status: 403 });
        }

        gameWsRateLimit.ipConnected(ip);

        if (
            bunServer.upgrade(req, {
                data: {
                    rateLimit: {},
                    ip,
                    disconnectReason: undefined,
                    clientSocket: undefined,
                },
            })
        ) {
            return;
        }

        gameWsRateLimit.ipDisconnected(ip);
        return new Response("Upgrade failed", { status: 500 });
    },
    websocket: {
        idleTimeout: 30,
        maxPayloadLength: 8192,
        backpressureLimit: 1024 * 1024,
        closeOnBackpressureLimit: false,
        drain(ws: ServerWebSocket<GameSocketData>) {
            ws.data.clientSocket?.clearBackpressure();
        },
        open(ws: ServerWebSocket<GameSocketData>) {
            const data = ws.data;
            data.clientSocket = new BunGameSocket(ws, data.ip);

            void checkIp(data.ip).then((ipData) => {
                const sock = data.clientSocket;
                if (!game || !sock || sock.closed()) return;
                if (ipData?.banned) {
                    sock.close("ip_banned");
                } else if (ipData?.behindProxy) {
                    sock.close("behind_proxy");
                }
            });
        },
        message(ws: ServerWebSocket<GameSocketData>, message) {
            const data = ws.data;
            if (!game || !data.clientSocket) {
                if (data.clientSocket) {
                    data.clientSocket.close();
                } else {
                    ws.close();
                }
                return;
            }
            if (gameWsRateLimit.isRateLimited(data.rateLimit)) {
                procLogger.warn("Game websocket rate limited, closing socket.");
                ws.close(3000, "rate_limited");
                return;
            }
            game.clientBarn.handleMsg(message, data.clientSocket);
        },
        close(ws: ServerWebSocket<GameSocketData>) {
            const data = ws.data;
            gameWsRateLimit.ipDisconnected(data.ip);
            if (data.clientSocket) {
                data.clientSocket._closed = true;
                game?.clientBarn?.handleSocketClose(data.clientSocket);
            }
        },
    },
});

procLogger.info(`Listening on ${Config.gameServer.host}:${port}`);
