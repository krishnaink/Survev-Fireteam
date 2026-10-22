import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { randomUUID } from "node:crypto";
import { parseSpecOpsDifficulty } from "../../shared/defs/maps/specOpsShop.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import type { FindGamePrivateError } from "../../shared/types/api.ts";
import {
    type ClientRoomData,
    type ClientToServerTeamMsg,
    normalizeTeamRoomKey,
    resolveTeamJoinSlot,
    type RoomData,
    type ServerToClientTeamMsg,
    type TeamErrorMsg,
    type TeamMenuErrorType,
    type TeamMenuPlayer,
    type TeamPlayGameMsg,
    zTeamClientMsg,
} from "../../shared/types/team.ts";
import { assert, util } from "../../shared/utils/util.ts";
import { getFindGamePlayerData, getHonoIp, verifyTurnsStile } from "./api/apiHelpers.ts";
import type { ApiServer } from "./api/apiServer.ts";
import { validateSessionToken } from "./api/auth/index.ts";
import { hashIp, isBanned } from "./api/routes/private/ModerationRouter.ts";
import { clampMaxSquadSize, Config, teamSizeForMode } from "./config.ts";
import {
    bindTeamSocketData,
    ensureTeamSocketData,
    getTeamSocketData,
    type TeamSocketState,
} from "./teamSocketState.ts";
import { validateSquadName, validateUserName } from "./utils/badWords.ts";
import { ServerLogger } from "./utils/logger.ts";
import { isBehindProxy } from "./utils/proxyCheck.ts";
import { HTTPRateLimit, WebSocketRateLimit } from "./utils/rateLimit.ts";
import type { FindGamePrivateBody } from "./utils/types.ts";

type SocketData = TeamSocketState<Player>;

/** Keep lobby slots after a socket drop so host/joiner can reconnect (WAN proxy, tab switch). */
const DISCONNECT_GRACE_MS = 90_000;

class Player {
    room?: Room;

    name = "Player";

    /** Per-tab lobby id from the client. Seats are keyed by this, not display name. */
    clientId = "";

    inGame = false;

    disconnected = false;

    /** In-game network id to reclaim on mid-match rejoin (page reload). */
    reclaimPlayerId?: number;
    /** Exact in-game name after uniqueInGameNames (page reload). */
    reclaimPlayerName?: string;

    reconnectTimer?: ReturnType<typeof setTimeout>;

    get isLeader() {
        // first player is always leader
        return !!this.room && this.room.players[0] == this;
    }

    get playerId() {
        return this.room ? this.room.players.indexOf(this) : -1;
    }

    get data(): TeamMenuPlayer {
        return {
            name: this.name,
            inGame: this.inGame,
            isLeader: this.isLeader,
            playerId: this.playerId,
        };
    }

    lastMsgTime = Date.now();

    disconnectTimeout: ReturnType<typeof setTimeout>;

    encodedIp: string;

    constructor(
        public socket: WSContext<SocketData>,
        public teamMenu: TeamMenu,
        public userId: string | null,
        public ip: string,
    ) {
        this.encodedIp = hashIp(ip);
        // disconnect if didn't join a room in 15 seconds (WAN clients can be slow)
        this.disconnectTimeout = setTimeout(() => {
            if (!this.room) {
                this.socket.close();
            }
        }, 15_000);
        this.disconnectTimeout.unref?.();
    }

    setName(name: string) {
        this.name = validateUserName(name).validName;
    }

    send<T extends ServerToClientTeamMsg["type"]>(
        type: T,
        data: (ServerToClientTeamMsg & { type: T })["data"],
    ) {
        this.socket.send(
            JSON.stringify({
                type,
                data,
            }),
        );
    }
}

class Room {
    players: Player[] = [];

    data: RoomData = {
        roomUrl: "",
        findingGame: false,
        lastError: undefined,
        region: "",
        autoFill: true,
        enabledGameModeIdxs: [],
        gameModeIdx: 1,
        maxPlayers: 4,
        captchaEnabled: false,
        mapName: "random",
        difficulty: Config.difficulty ?? "regular",
        endless: Config.endless ?? false,
        squadSize: Config.maxSquadSize,
        squadName: "",
    };

    constructor(
        public teamMenu: TeamMenu,
        public id: string,
        initialData: ClientRoomData,
    ) {
        this.data.roomUrl = `#${id}`;
        this.data.enabledGameModeIdxs = teamMenu.allowedGameModeIdxs();
        this.data.captchaEnabled = teamMenu.server.captchaEnabled;

        this.setProps(initialData);
    }

    addPlayer(player: Player) {
        const decision = resolveTeamJoinSlot(this.players, player, this.data.maxPlayers);

        if (decision.type === "full") return;

        let resumeMatch = false;
        if (decision.type === "reclaim") {
            const old = this.players[decision.index]!;
            // Seat reclaim replaces the Player object and would drop inGame=false,
            // which made matchInProgress() flip off so rejoinMatch became a no-op
            // and the client sat forever with rejoinPending / no play button.
            resumeMatch = old.inGame && !!this.activeMatch;
            clearTimeout(old.reconnectTimer);
            old.room = undefined;
            old.disconnected = true;
            this.players[decision.index] = player;
            if (old.socket !== player.socket && old.socket.readyState === 1) {
                old.socket.close();
            }
        } else {
            this.players.push(player);
        }

        player.room = this;
        player.disconnected = false;
        clearTimeout(player.reconnectTimer);

        clearTimeout(player.disconnectTimeout);

        this.sendState();

        // Never auto-mint a join token on lobby reconnect without an explicit
        // reclaim id — that races page reload and spawns duplicate operators.
        // Client sends rejoinMatch with playerId after reconnect.
        if (
            player.reclaimPlayerId
            && (resumeMatch || this.matchInProgress())
            && !player.inGame
        ) {
            void this.joinPlayersToMatch([player]).then(() => {
                this.sendState();
            });
        }
    }

    onMsg(player: Player, msg: ClientToServerTeamMsg) {
        if (player.room !== this) return;

        player.lastMsgTime = Date.now();
        switch (msg.type) {
            case "changeName": {
                player.setName(msg.data.name);
                this.sendState();
                break;
            }
            case "keepAlive": {
                player.send("keepAlive", {});
                break;
            }
            case "gameComplete": {
                player.inGame = false;
                if (!this.matchInProgress()) {
                    this.activeMatch = undefined;
                }
                // Do not auto-rejoin on gameComplete — that left reload/quit flows
                // fighting the lobby. Explicit rejoinMatch / seat reclaim resumes.
                this.sendState();
                break;
            }
            case "rejoinMatch": {
                if (!this.activeMatch) break;
                // Always mint a fresh join token. inGame can still be true after a
                // match-socket drop if gameComplete never arrived (page reload).
                player.inGame = false;
                player.reclaimPlayerId = msg.data?.playerId;
                player.reclaimPlayerName = msg.data?.playerName;
                void this.joinPlayersToMatch([player]).then(() => {
                    this.sendState();
                });
                break;
            }
            case "setRoomProps": {
                if (!player.isLeader) break;
                this.setProps(msg.data);
                break;
            }
            case "kick": {
                if (!player.isLeader) break;
                this.kick(msg.data.playerId);
                break;
            }
            case "playGame": {
                if (!player.isLeader) break;
                this.findGame(msg.data);
                break;
            }
        }
    }

    setProps(props: ClientRoomData) {
        let region = props.region;
        const liveRegions = this.teamMenu.server.regions;
        if (!(region in liveRegions)) {
            region = Object.keys(liveRegions)[0];
        }

        let gameModeIdx = props.gameModeIdx;

        const modes = this.teamMenu.server.modes;

        if (!this.data.enabledGameModeIdxs.includes(gameModeIdx)) {
            gameModeIdx = modes.findIndex((mode) => mode.enabled);
            if (gameModeIdx < 0) gameModeIdx = 0;
        }

        const squadSize = clampMaxSquadSize(
            props.squadSize ?? this.data.squadSize ?? Config.maxSquadSize,
        );

        const maxPlayers = teamSizeForMode(
            modes[gameModeIdx].teamMode,
            squadSize,
        );

        const mapNameRaw = props.mapName || "random";
        const mapName = mapNameRaw === "specops" ? "random" : mapNameRaw;
        const difficulty = parseSpecOpsDifficulty(
            props.difficulty ?? this.data.difficulty ?? Config.difficulty,
        );
        const endless = typeof props.endless === "boolean"
            ? props.endless
            : (this.data.endless ?? Config.endless ?? false);
        const squadName = validateSquadName(props.squadName ?? this.data.squadName);

        const unchanged = this.data.region === region
            && this.data.gameModeIdx === gameModeIdx
            && this.data.maxPlayers === maxPlayers
            && this.data.squadSize === squadSize
            && this.data.autoFill === props.autoFill
            && this.data.mapName === mapName
            && this.data.difficulty === difficulty
            && this.data.endless === endless
            && this.data.squadName === squadName;
        if (unchanged) return;

        this.data.region = region;
        this.data.gameModeIdx = gameModeIdx;
        this.data.maxPlayers = maxPlayers;
        this.data.squadSize = squadSize;
        this.data.autoFill = props.autoFill;
        this.data.mapName = mapName;
        this.data.difficulty = difficulty;
        this.data.endless = endless;
        this.data.squadName = squadName;

        // kick players that don't fit on the new max players
        while (this.players.length > this.data.maxPlayers) {
            this.kick(this.players.length - 1);
        }

        this.sendState();
    }

    kick(playerId: number) {
        const player = this.players[playerId];
        if (!player) return;

        player.send("kicked", {});

        this.removePlayer(player);
    }

    onPlayerDisconnect(player: Player) {
        if (player.disconnected) return;

        player.disconnected = true;
        clearTimeout(player.reconnectTimer);
        player.reconnectTimer = setTimeout(() => {
            this.removePlayer(player);
        }, DISCONNECT_GRACE_MS);

        this.sendState();
    }

    removePlayer(player: Player) {
        if (!util.removeFrom(this.players, player)) {
            return;
        }

        clearTimeout(player.reconnectTimer);
        player.disconnected = false;
        player.room = undefined;

        if (player.socket.readyState === 1) {
            player.socket.close();
        }

        this.sendState();

        if (!this.players.length) {
            this.teamMenu.removeRoom(this);
        }
    }

    findGameCooldown = 0;
    activeMatch?: { gameId: string; urls: string[] };

    /** True while at least one lobby member is still in the active game. */
    matchInProgress() {
        return !!this.activeMatch && this.players.some((p) => p.inGame);
    }

    async findGame(data: TeamPlayGameMsg["data"]) {
        if (this.data.findingGame) return;
        const waiting = this.players.filter((p) => !p.inGame && !p.disconnected);
        if (!waiting.length) return;
        const roomLeader = waiting[0];
        if (!roomLeader) return;

        // New play request — drop a stale match handle so seats are not stuck
        // "in progress" after a reload wiped inGame flags.
        if (!this.matchInProgress()) {
            this.activeMatch = undefined;
        }

        this.data.findingGame = true;
        // Fail-fast room lock — child session call is ≤2s; don't hold lobby for a minute.
        this.findGameCooldown = Date.now() + 5_000;
        this.sendState();

        let region = data.region;
        const regions = this.teamMenu.server.regions;
        if (!regions[region]?.isAlive) {
            region = Object.keys(regions).find((id) => regions[id]?.isAlive) ?? region;
        }
        this.data.region = region;

        const mode = this.teamMenu.server.modes[this.data.gameModeIdx];
        if (!mode || !mode.enabled) {
            this.data.findingGame = false;
            this.sendState();
            return;
        }

        if (this.data.captchaEnabled) {
            if (!data.turnstileToken) {
                this.data.lastError = "find_game_invalid_captcha";
                this.data.findingGame = false;
                this.sendState();
                return;
            }

            try {
                if (!(await verifyTurnsStile(data.turnstileToken, roomLeader.ip))) {
                    this.data.lastError = "find_game_invalid_captcha";
                    this.data.findingGame = false;
                    this.sendState();
                    return;
                }
            } catch (err) {
                this.teamMenu.logger.error("Failed verifying turnstile:", err);
                this.data.lastError = "find_game_error";
                this.data.findingGame = false;
                this.sendState();
                return;
            }
        }

        const ok = await this.joinPlayersToMatch(waiting, {
            region,
            version: data.version,
            autoFill: this.data.autoFill,
            mapName: this.data.mapName,
            teamMode: mode.teamMode,
            squadSize: this.data.squadSize,
            difficulty: this.data.difficulty,
            endless: this.data.endless,
            contractsEnabled: Config.contractsEnabled,
            squadName: mode.teamMode === TeamMode.Solo ? "" : this.data.squadName,
        });

        this.data.findingGame = false;
        this.findGameCooldown = Date.now() + 1000;
        this.sendState();
    }

    private async joinPlayersToMatch(
        players: Player[],
        create?: {
            region: string;
            version: number;
            autoFill: boolean;
            mapName: string;
            teamMode: number;
            squadSize?: number;
            difficulty?: string;
            endless?: boolean;
            contractsEnabled?: boolean;
            squadName?: string;
        },
    ): Promise<boolean> {
        const joining = players.filter((p) => !p.inGame);
        if (!joining.length) return true;

        const tokenMap = new Map<Player, string>();
        const playerData = await getFindGamePlayerData(
            joining.map((player) => {
                const token = randomUUID();
                tokenMap.set(player, token);
                return {
                    token,
                    userId: player.userId,
                    ip: player.ip,
                    reclaimPlayerId: player.reclaimPlayerId,
                } satisfies FindGamePrivateBody["playerData"][0];
            }),
        );

        const mode = this.teamMenu.server.modes[this.data.gameModeIdx];
        const squadSize = create?.squadSize ?? this.data.squadSize;
        const teamMode = create?.teamMode ?? mode.teamMode;
        const squadName = teamMode === TeamMode.Solo
            ? ""
            : validateSquadName(create?.squadName ?? this.data.squadName);
        const res = await this.teamMenu.server.completeSessionFindGame(
            create?.region ?? this.data.region,
            {
                mapName: create?.mapName ?? mode.mapName,
                teamMode,
                squadSize,
                autoFill: create?.autoFill ?? this.data.autoFill,
                region: create?.region ?? this.data.region,
                version: create?.version ?? GameConfig.protocolVersion,
                // playGame always passes `create` (new match). Rejoin/resume omit it and
                // must keep activeMatch.gameId even when every seat has inGame=false
                // (solo / last-operator page reload).
                gameId: create ? undefined : this.activeMatch?.gameId,
                difficulty: create?.difficulty ?? this.data.difficulty,
                endless: create?.endless ?? this.data.endless,
                contractsEnabled: create?.contractsEnabled ?? Config.contractsEnabled,
                squadName,
                playerData,
            },
        );

        if ("error" in res) {
            const errMap: Partial<Record<FindGamePrivateError, TeamMenuErrorType>> = {
                full: "find_game_full",
                invalid_protocol: "find_game_invalid_protocol",
            };

            this.data.lastError = errMap[res.error] || "find_game_error";
            // Failed rejoin of a dead/ended match — clear so the lobby can start fresh.
            if (!create && this.activeMatch) {
                this.activeMatch = undefined;
                for (const p of this.players) {
                    p.inGame = false;
                }
            }
            return false;
        }

        this.activeMatch = { gameId: res.gameId, urls: res.urls };
        this.data.lastError = undefined;

        for (const player of joining) {
            const token = tokenMap.get(player);
            if (!token) {
                this.teamMenu.logger.warn(`Missing token for player ${player.name}`);
                continue;
            }
            player.inGame = true;
            player.send("joinGame", {
                zone: "",
                data: token,
                gameId: res.gameId,
                urls: res.urls,
            });
        }
        return true;
    }

    sendState() {
        const activePlayers = this.players.filter((p) => !p.disconnected);
        const players = activePlayers.map((p) => p.data);
        // all players must be logged in to disable it
        this.data.captchaEnabled = this.teamMenu.server.captchaEnabled
            && !activePlayers.every((p) => !!p.userId);
        for (const player of activePlayers) {
            player.send("state", {
                localPlayerId: player.playerId,
                room: this.data,
                players,
            });
        }
    }
}

const teamCodeCharacters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789";
function generateTeamCode(): string {
    let str = "";
    for (let i = 0; i < 4; i++) {
        str += teamCodeCharacters.charAt(
            Math.floor(Math.random() * teamCodeCharacters.length),
        );
    }
    return `${str}`;
}

export class TeamMenu {
    rooms = new Map<string, Room>();

    logger = new ServerLogger("TeamMenu");

    playersByIp = new Map<string, Set<Player>>();

    constructor(public server: ApiServer) {
        const tick = setInterval(() => {
            for (const room of this.rooms.values()) {
                // just making sure ig
                if (!room.players.length) {
                    this.removeRoom(room);
                    continue;
                }
                if (room.data.findingGame && room.findGameCooldown < Date.now()) {
                    room.data.findingGame = false;
                    room.sendState();
                }

                // kick players that haven't sent a keep alive msg in over a minute
                // client sends it every 45 seconds
                for (const player of room.players) {
                    if (player.disconnected) continue;
                    if (player.lastMsgTime < Date.now() - 8 * 60 * 1000) {
                        player.send("error", { type: "lost_conn" });
                        room.removePlayer(player);
                    }
                }
            }
        }, 1000);
        tick.unref?.();
    }

    allowedGameModeIdxs() {
        return this.server.modes
            .map((_, i) => i)
            .filter((i) => {
                const mode = this.server.modes[i];
                return mode.enabled;
            });
    }

    init(app: Hono, upgradeWebSocket: UpgradeWebSocket) {
        const teamMenu = this;

        // Mobile Safari and shared carrier NATs retry the lobby WS often.
        // Keep a cap, but do not treat a normal Create Team tap as abuse.
        const httpRateLimit = new HTTPRateLimit(40, 10_000);
        const wsRateLimit = new WebSocketRateLimit(80, 1000, 24);

        app.get(
            "/team_v2",
            upgradeWebSocket((c) => {
                const ip = getHonoIp(c, Config.apiServer.proxyIPHeader);

                const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || !ip;
                let closeReason: TeamMenuErrorType | undefined;
                if (
                    (!isLoopback && !ip && Config.rateLimitsEnabled)
                    || (!isLoopback && ip && httpRateLimit.isRateLimited(ip))
                    || (!isLoopback && ip && wsRateLimit.isIpRateLimited(ip))
                ) {
                    closeReason = "rate_limited";
                }

                // Vite may omit the client IP on some upgrades; keep team lobby usable in local LAN.
                const clientIp = ip || "127.0.0.1";
                const sessionId = getCookie(c, "session") ?? null;

                return {
                    onOpen(_event, ws) {
                        // Bind to the Bun websocket (ws.raw). Do not replace
                        // ws.raw — Hono recreates WSContext per event.
                        ensureTeamSocketData<Player>(ws, clientIp);

                        if (closeReason) {
                            ws.send(
                                JSON.stringify(
                                    {
                                        type: "error",
                                        data: {
                                            type: closeReason as TeamMenuErrorType,
                                        },
                                    } satisfies TeamErrorMsg,
                                ),
                            );
                            teamMenu.logger.warn(`closed socket for ${closeReason}`);
                            ws.close();
                            return;
                        }

                        wsRateLimit.ipConnected(clientIp);
                        // Create the player immediately so the first client message
                        // (create/join) is not dropped while async checks run.
                        teamMenu.onOpen(ws as WSContext<SocketData>, null, clientIp);

                        void (async () => {
                            let userId: string | null = null;

                            if (sessionId) {
                                try {
                                    const account = await validateSessionToken(sessionId);
                                    userId = account.user?.id || null;

                                    if (account.user?.banned) {
                                        userId = null;
                                    }
                                } catch (err) {
                                    teamMenu.logger.error(`Failed to validate session:`, err);
                                }
                            }

                            let denyReason: TeamMenuErrorType | undefined;
                            if (await isBanned(clientIp)) {
                                denyReason = "banned";
                            } else if (await isBehindProxy(clientIp, !userId)) {
                                denyReason = "behind_proxy";
                            }

                            const player = getTeamSocketData<Player>(ws)?.player;
                            if (!player || ws.readyState !== 1) return;

                            if (denyReason) {
                                player.send("error", { type: denyReason });
                                teamMenu.logger.warn(`closed socket for ${denyReason}`);
                                ws.close();
                                return;
                            }

                            player.userId = userId;
                        })();
                    },

                    onMessage(event, ws) {
                        const data = ensureTeamSocketData<Player>(ws, clientIp);

                        if (wsRateLimit.isRateLimited(data.rateLimit)) {
                            teamMenu.logger.warn("Rate limited, closing socket.");
                            ws.close();
                            return;
                        }

                        try {
                            teamMenu.onMsg(
                                ws as WSContext<SocketData>,
                                event.data as string,
                            );
                        } catch (err) {
                            teamMenu.logger.error("Error processing message:", err);
                            ws.close();
                        }
                    },

                    onClose(_event, ws) {
                        teamMenu.onClose(ws as WSContext<SocketData>);

                        const data = getTeamSocketData<Player>(ws);
                        if (data?.ip) {
                            wsRateLimit.ipDisconnected(data.ip);
                        }
                    },
                };
            }),
        );
    }

    onOpen(ws: WSContext<SocketData>, userId: string | null, ip: string) {
        const data = ensureTeamSocketData<Player>(ws, ip);
        if (data.player) {
            data.player.socket = ws;
            if (userId) data.player.userId = userId;
            return;
        }

        const player = new Player(ws, this, userId, ip);
        data.player = player;
        bindTeamSocketData(ws, data);

        let players = this.playersByIp.get(player.encodedIp);
        if (!players) {
            players = new Set();
            this.playersByIp.set(player.encodedIp, players);
        }
        players.add(player);
    }

    onMsg(ws: WSContext<SocketData>, data: string) {
        let player = getTeamSocketData<Player>(ws)?.player;
        if (!player) {
            const ip = getTeamSocketData<Player>(ws)?.ip ?? "127.0.0.1";
            this.onOpen(ws, null, ip);
            player = getTeamSocketData<Player>(ws)?.player;
        }
        if (!player) {
            this.logger.warn("Player not found, closing socket.");
            ws.close();
            return;
        }
        player.socket = ws;

        let msg: ClientToServerTeamMsg;
        try {
            assert(data.length < 1024);
            const raw = JSON.parse(data);
            const parsed = zTeamClientMsg.safeParse(raw);
            if (!parsed.success) {
                this.logger.warn("Failed to parse message.", parsed.error);
                const rawType = typeof raw === "object" && raw && "type" in raw
                    ? (raw as { type: string }).type
                    : undefined;
                if (!player.room) {
                    if (rawType === "create") {
                        player.send("error", { type: "create_failed" });
                    } else if (rawType === "join") {
                        player.send("error", { type: "join_failed" });
                    }
                    ws.close();
                } else {
                    player.room.data.findingGame = false;
                    player.room.data.lastError = "find_game_error";
                    player.room.sendState();
                }
                return;
            }
            msg = parsed.data;
        } catch (e) {
            this.logger.warn("Failed to parse message, closing socket.", e);
            ws.close();
            return;
        }

        // handle creation and joining messages
        if (!player.room) {
            if (msg.type === "keepAlive") {
                player.send("keepAlive", {});
                return;
            }

            switch (msg.type) {
                case "create": {
                    // don't allow creating a team if there's no team mode enabled
                    if (!this.allowedGameModeIdxs().length) {
                        player.send("error", { type: "create_failed" });
                        break;
                    }

                    player.setName(msg.data.playerData.name);
                    player.clientId = (msg.data.playerData.clientId || "").trim();

                    const room = this.createRoom(msg.data.roomData);
                    room.addPlayer(player);

                    break;
                }
                case "join": {
                    const roomKey = normalizeTeamRoomKey(msg.data.roomUrl);
                    const room = this.rooms.get(roomKey) ?? this.rooms.get(msg.data.roomUrl);
                    if (!room) {
                        player.send("error", { type: "join_not_found" });
                        break;
                    }

                    player.setName(msg.data.playerData.name);
                    player.clientId = (msg.data.playerData.clientId || "").trim();

                    // Reclaim (same clientId/userId) before the full check so a
                    // reconnect that races the old socket close is not join_full.
                    // Display name is not an identity — two "Player"s both join.
                    const decision = resolveTeamJoinSlot(
                        room.players,
                        player,
                        room.data.maxPlayers,
                    );
                    if (decision.type === "full") {
                        player.send("error", { type: "join_full" });
                        break;
                    }

                    room.addPlayer(player);
                    break;
                }
            }

            if (!player.room) {
                this.logger.debug("Player not in room, closing socket.");
                ws.close();
                return;
            }

            if (msg.type === "create" || msg.type === "join") {
                return;
            }
        }

        // handle messages for when the player is already inside a room
        player.room.onMsg(player, msg);
    }

    onClose(ws: WSContext<SocketData>) {
        const player = getTeamSocketData<Player>(ws)?.player;

        if (!player) {
            this.logger.debug("Player not found, closing socket.");
            ws.close();
            return;
        }

        const byIp = this.playersByIp.get(player.encodedIp);
        if (byIp) {
            byIp.delete(player);
            if (byIp.size === 0) {
                this.playersByIp.delete(player.encodedIp);
            }
        }

        // meh just to make sure we dont keep timeouts with references hanging
        // not like it matters because its 5 seconds...
        clearTimeout(player.disconnectTimeout);

        if (player.room) {
            player.room.onPlayerDisconnect(player);
        }
    }

    createRoom(data: ClientRoomData) {
        let roomUrl = generateTeamCode();
        while (this.rooms.has(roomUrl)) {
            roomUrl = generateTeamCode();
        }

        const room = new Room(this, roomUrl, data);
        this.rooms.set(roomUrl, room);
        return room;
    }

    removeRoom(room: Room) {
        this.rooms.delete(room.id);
    }

    disconnectPlayers(encodedIp: string) {
        const players = this.playersByIp.get(encodedIp);
        if (!players) return;

        for (const player of players) {
            player.socket.close();
        }
        players.clear();
        this.playersByIp.delete(encodedIp);
    }
}
