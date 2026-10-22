/**
 * Rejoin matrix e2e: duo + squad, full and half-filled lobbies.
 *
 * For each scenario: start match → disconnect each seat → rejoinMatch with
 * reclaimPlayerId (page-reload style) → assert same playerId.
 *
 * Also runs an immediate (0ms) reclaim race on the first seat of each scenario.
 *
 * Requires `bun run dev` (API :8000 + game).
 * Run: bun scripts/test-rejoin-matrix-e2e.ts
 */
import { GameConfig } from "../shared/gameConfig.ts";
import * as net from "../shared/net/net.ts";

const TEAM_WS = "ws://127.0.0.1:8000/team_v2";
const REGION = "main";

type Scenario = {
    name: string;
    /** 1 = duo, 2 = squad (matches default modes order). */
    gameModeIdx: number;
    squadSize: number;
    /** How many humans join before play. */
    players: number;
};

const scenarios: Scenario[] = [
    { name: "duo-full", gameModeIdx: 1, squadSize: 2, players: 2 },
    { name: "duo-half", gameModeIdx: 1, squadSize: 2, players: 1 },
    { name: "squad4-full", gameModeIdx: 2, squadSize: 4, players: 4 },
    { name: "squad4-half", gameModeIdx: 2, squadSize: 4, players: 2 },
    { name: "squad8-full", gameModeIdx: 2, squadSize: 8, players: 8 },
    { name: "squad8-half", gameModeIdx: 2, squadSize: 8, players: 4 },
];

function waitMsg(
    ws: WebSocket,
    pred: (msg: { type: string; data?: unknown }) => boolean,
    ms = 15_000,
): Promise<{ type: string; data?: any }> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`timeout waiting for message (${ms}ms)`)),
            ms,
        );
        const onMsg = (ev: MessageEvent) => {
            let msg: { type: string; data?: unknown };
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (pred(msg)) {
                clearTimeout(t);
                ws.removeEventListener("message", onMsg);
                resolve(msg);
            }
        };
        ws.addEventListener("message", onMsg);
    });
}

function connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error(`ws error ${url}`));
        setTimeout(() => reject(new Error(`open timeout ${url}`)), 10_000);
    });
}

function encodeJoin(matchPriv: string, name: string): ArrayBuffer {
    const joinMessage = new net.JoinMsg();
    joinMessage.protocol = GameConfig.protocolVersion;
    joinMessage.matchPriv = matchPriv;
    joinMessage.name = name;
    joinMessage.useTouch = false;
    joinMessage.isMobile = false;
    joinMessage.bot = false;
    joinMessage.loadout = {
        outfit: "outfitBase",
        melee: "fists",
        heal: "heal_basic",
        boost: "boost_basic",
        emotes: ["", "", "", "", "", ""],
    };
    const stream = new net.MsgStream(new ArrayBuffer(8192));
    stream.serializeMsg(net.MsgType.Join, joinMessage);
    return stream.getBuffer();
}

function resolveGameUrl(urls: string[] | undefined, gameId: string): string {
    const raw = urls?.[0] ?? "";
    const m = raw.match(/\/g\/(\d+)\/play/);
    const port = m?.[1] ?? "9000";
    const q = gameId ? `?gameId=${encodeURIComponent(gameId)}` : "";
    return `ws://127.0.0.1:${port}/play${q}`;
}

async function joinGameSocket(
    gameUrl: string,
    token: string,
    name: string,
): Promise<{
    type: string;
    playerId?: number;
    reason?: string;
    code?: number;
    ws?: WebSocket;
}> {
    const gws = await connect(gameUrl);
    return await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            try {
                gws.close();
            } catch {
                // ignore
            }
            reject(new Error("no Joined msg"));
        }, 12_000);

        gws.onmessage = (ev) => {
            try {
                const ms = new net.MsgStream(ev.data as ArrayBuffer);
                while (true) {
                    const type = ms.deserializeMsgType();
                    if (type === net.MsgType.None) break;
                    if (type === net.MsgType.Joined) {
                        const joined = new net.JoinedMsg();
                        joined.deserialize(ms.getStream());
                        clearTimeout(t);
                        resolve({
                            type: "Joined",
                            playerId: joined.playerId,
                            ws: gws,
                        });
                        return;
                    }
                    ms.stream.readAlignToNextByte();
                }
            } catch {
                // ignore partial frames
            }
        };
        gws.onclose = (e) => {
            clearTimeout(t);
            resolve({ type: "closed", reason: e.reason, code: e.code });
        };
        gws.send(encodeJoin(token, name));
    });
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

type Seat = {
    i: number;
    name: string;
    teamWs: WebSocket;
    gameWs: WebSocket | null;
    playerId: number | null;
    gameId: string;
    urls: string[];
};

type ScenarioResult = {
    name: string;
    ok: boolean;
    detail: string;
    skipped?: boolean;
};

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
    const sockets: WebSocket[] = [];
    const track = (ws: WebSocket) => {
        sockets.push(ws);
        return ws;
    };
    const cleanup = async () => {
        for (const ws of sockets) {
            try {
                ws.close();
            } catch {
                // ignore
            }
        }
        await sleep(200);
    };

    try {
        const tag = `r${Date.now().toString(36).slice(-5)}`;
        const host = track(await connect(TEAM_WS));
        host.send(
            JSON.stringify({
                type: "create",
                data: {
                    roomData: {
                        roomUrl: "",
                        findingGame: false,
                        lastError: null,
                        region: REGION,
                        autoFill: false,
                        gameModeIdx: scenario.gameModeIdx,
                        mapName: "random",
                        difficulty: "recruit",
                        endless: true,
                        squadSize: scenario.squadSize,
                        squadName: scenario.name.slice(0, 16),
                    },
                    playerData: { name: `${tag}A`, clientId: `${tag}-0` },
                },
            }),
        );

        const hostState = await waitMsg(host, (m) => m.type === "state");
        const roomUrl = hostState.data.room.roomUrl as string;
        const maxPlayers = hostState.data.room.maxPlayers as number;

        if (maxPlayers < scenario.players) {
            return {
                name: scenario.name,
                ok: true,
                skipped: true,
                detail: `skip: lobby maxPlayers=${maxPlayers} < ${scenario.players}`,
            };
        }

        const seats: Seat[] = [
            {
                i: 0,
                name: `${tag}A`,
                teamWs: host,
                gameWs: null,
                playerId: null,
                gameId: "",
                urls: [],
            },
        ];

        for (let i = 1; i < scenario.players; i++) {
            const ws = track(await connect(TEAM_WS));
            const letter = String.fromCharCode(65 + i); // B, C, ...
            const name = `${tag}${letter}`;
            const sp = waitMsg(
                ws,
                (m) => m.type === "state" && (m.data as any)?.players?.length >= i + 1,
            );
            ws.send(
                JSON.stringify({
                    type: "join",
                    data: {
                        roomUrl,
                        playerData: { name, clientId: `${tag}-${i}` },
                    },
                }),
            );
            await sp;
            seats.push({
                i,
                name,
                teamWs: ws,
                gameWs: null,
                playerId: null,
                gameId: "",
                urls: [],
            });
        }

        const joinGameWaiters = seats.map((seat) =>
            waitMsg(
                seat.teamWs,
                (m) =>
                    m.type === "joinGame"
                    || m.type === "error"
                    || (m.type === "state"
                        && !!(m.data as { room?: { lastError?: string } })?.room?.lastError),
                30_000,
            ).then((m) => ({ seat, m }))
        );

        host.send(
            JSON.stringify({
                type: "playGame",
                data: {
                    version: GameConfig.protocolVersion,
                    region: REGION,
                    zones: [REGION],
                },
            }),
        );

        const joinGames = await Promise.all(joinGameWaiters);
        for (const { seat, m } of joinGames) {
            if (m.type === "error") {
                throw new Error(`play error: ${JSON.stringify(m.data)}`);
            }
            if (m.type === "state") {
                throw new Error(`findGame lastError: ${m.data?.room?.lastError}`);
            }
            const token = m.data.data as string;
            const gameId = m.data.gameId as string;
            const urls = m.data.urls as string[];
            seat.gameId = gameId;
            seat.urls = urls;
            const got = await joinGameSocket(resolveGameUrl(urls, gameId), token, seat.name);
            if (got.type !== "Joined" || typeof got.playerId !== "number") {
                throw new Error(`initial join failed: ${JSON.stringify(got)}`);
            }
            seat.playerId = got.playerId;
            seat.gameWs = got.ws ?? null;
            if (got.ws) track(got.ws);
        }

        const uniqueIds = new Set(seats.map((s) => s.playerId));
        if (uniqueIds.size !== scenario.players) {
            throw new Error(`expected ${scenario.players} unique ids, got ${uniqueIds.size}`);
        }

        // Immediate race on first seat (page-reload style: no delay).
        {
            const seat = seats[0]!;
            const beforeId = seat.playerId!;
            if (seat.gameWs) {
                try {
                    seat.gameWs.close();
                } catch {
                    // ignore
                }
                seat.gameWs = null;
            }
            const joinWait = waitMsg(
                seat.teamWs,
                (m) => m.type === "joinGame" || m.type === "error",
                20_000,
            );
            seat.teamWs.send(
                JSON.stringify({
                    type: "rejoinMatch",
                    data: { playerId: beforeId, playerName: seat.name },
                }),
            );
            const m = await joinWait;
            if (m.type === "error") {
                throw new Error(`immediate rejoin error: ${JSON.stringify(m.data)}`);
            }
            const got = await joinGameSocket(
                resolveGameUrl(m.data.urls || seat.urls, m.data.gameId || seat.gameId),
                m.data.data as string,
                seat.name,
            );
            if (got.type !== "Joined" || got.playerId !== beforeId) {
                throw new Error(
                    `immediate reclaim failed: ${beforeId} → ${JSON.stringify(got)}`,
                );
            }
            seat.playerId = got.playerId;
            seat.gameWs = got.ws ?? null;
            if (got.ws) track(got.ws);
        }

        // Remaining seats (and first again if only one) with short delay.
        for (let idx = 0; idx < seats.length; idx++) {
            // First seat already did immediate reclaim; still verify delayed reclaim
            // for multi-player, skip re-testing seat 0 when alone already covered.
            if (idx === 0 && seats.length === 1) continue;

            const seat = seats[idx]!;
            const beforeId = seat.playerId!;
            if (seat.gameWs) {
                try {
                    seat.gameWs.close();
                } catch {
                    // ignore
                }
                seat.gameWs = null;
            }
            await sleep(idx === 0 ? 0 : 400);

            const joinWait = waitMsg(
                seat.teamWs,
                (m) => m.type === "joinGame" || m.type === "error",
                20_000,
            );
            seat.teamWs.send(
                JSON.stringify({
                    type: "rejoinMatch",
                    data: { playerId: beforeId, playerName: seat.name },
                }),
            );
            const m = await joinWait;
            if (m.type === "error") {
                throw new Error(`rejoin error ${seat.name}: ${JSON.stringify(m.data)}`);
            }
            const got = await joinGameSocket(
                resolveGameUrl(m.data.urls || seat.urls, m.data.gameId || seat.gameId),
                m.data.data as string,
                seat.name,
            );
            if (got.type !== "Joined" || typeof got.playerId !== "number") {
                throw new Error(`Joined failed ${seat.name}: ${JSON.stringify(got)}`);
            }
            if (got.playerId !== beforeId) {
                throw new Error(
                    `seat changed ${seat.name}: ${beforeId} → ${got.playerId}`,
                );
            }
            seat.playerId = got.playerId;
            seat.gameWs = got.ws ?? null;
            if (got.ws) track(got.ws);
        }

        return {
            name: scenario.name,
            ok: true,
            detail: `ok: ${scenario.players}/${maxPlayers} players reclaimed`,
        };
    } catch (e) {
        return {
            name: scenario.name,
            ok: false,
            detail: e instanceof Error ? e.message : String(e),
        };
    } finally {
        await cleanup();
    }
}

const results: ScenarioResult[] = [];
console.log("=== rejoin matrix e2e ===");

for (const scenario of scenarios) {
    console.log(`\n--- ${scenario.name} (players=${scenario.players}, squadSize=${scenario.squadSize}) ---`);
    const result = await runScenario(scenario);
    results.push(result);
    console.log(
        result.skipped ? `SKIP ${result.detail}` : result.ok ? `PASS ${result.detail}` : `FAIL ${result.detail}`,
    );
    await sleep(500);
}

const ran = results.filter((r) => !r.skipped);
const failed = ran.filter((r) => !r.ok);
console.log("\n=== SUMMARY ===");
console.log({
    passed: ran.filter((r) => r.ok).length,
    failed: failed.length,
    skipped: results.filter((r) => r.skipped).length,
    results,
});

if (failed.length) {
    console.error("FAILURE — reclaim matrix had seat mismatches");
    process.exitCode = 1;
} else if (!ran.length) {
    console.error("FAILURE — every scenario was skipped");
    process.exitCode = 1;
} else {
    console.log("SUCCESS — all runnable scenarios reclaimed seats");
}
