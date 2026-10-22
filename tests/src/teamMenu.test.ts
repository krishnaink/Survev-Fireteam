import { expect, test } from "vitest";
import { ensureTeamSocketData, getTeamSocketData } from "../../server/src/teamSocketState.ts";
import {
    applyTeamJoin,
    clientRoomPayload,
    findTeamPlayerReclaimIndex,
    normalizeTeamRoomKey,
    resolveTeamJoinSlot,
    type TeamPlayerIdentity,
} from "../../shared/types/teamHelpers.ts";

/**
 * Regression: joining a team lobby used to desync/resync everyone until Start.
 *
 * Causes:
 * 1. Bun API websocket idleTimeout defaulted to 10s while keepAlive is 10s.
 * 2. Reclaim keyed seats by display name (+ IP). Default callname is "Player",
 *    and LAN/proxy clients often share an IP, so a second joiner stole the
 *    first seat, the victim reconnected, and they ping-ponged forever.
 * 3. Host applied "state" then echoed setRoomProps, which broadcast again.
 * 4. URL hash rewrite on every state packet re-fired tryJoinTeam for the room.
 * 5. Hono recreates WSContext per event. Storing Player on that context (or
 *    replacing ws.raw) spawned a ghost Player whose 15s "not in room" timer
 *    closed the live socket → UI remove → client reconnect ~1s later → loop.
 *
 * Seats are keyed by clientId (tab) / userId (account), never by callname.
 */

function seat(
    partial: Partial<TeamPlayerIdentity> & Pick<TeamPlayerIdentity, "clientId" | "name">,
): TeamPlayerIdentity {
    return {
        disconnected: false,
        userId: null,
        ip: "1.1.1.1",
        ...partial,
    };
}

test("normalizeTeamRoomKey strips a leading hash", () => {
    expect(normalizeTeamRoomKey("#AbC1")).toBe("AbC1");
    expect(normalizeTeamRoomKey("AbC1")).toBe("AbC1");
    expect(normalizeTeamRoomKey("")).toBe("");
});

test("clientRoomPayload only sends client-owned room fields", () => {
    const room = {
        roomUrl: "#AbC1",
        findingGame: false,
        lastError: undefined,
        region: "local",
        autoFill: true,
        enabledGameModeIdxs: [1, 2],
        gameModeIdx: 2,
        maxPlayers: 4,
        captchaEnabled: false,
        mapName: "random",
        difficulty: "regular",
        endless: false,
        squadSize: 4,
        squadName: "Alpha",
    };

    const payload = clientRoomPayload(room);
    expect(payload).toEqual({
        roomUrl: "#AbC1",
        findingGame: false,
        lastError: undefined,
        region: "local",
        autoFill: true,
        gameModeIdx: 2,
        mapName: "random",
        difficulty: "regular",
        endless: false,
        squadSize: 4,
        squadName: "Alpha",
    });
    expect("maxPlayers" in payload).toBe(false);
    expect("enabledGameModeIdxs" in payload).toBe(false);
});

test("two players with the same name both get a seat", () => {
    const players: TeamPlayerIdentity[] = [];
    const a = applyTeamJoin(
        players,
        seat({ clientId: "tab-a", name: "Player", ip: "10.0.0.1" }),
        4,
    );
    const b = applyTeamJoin(
        players,
        seat({ clientId: "tab-b", name: "Player", ip: "10.0.0.1" }),
        4,
    );
    expect(a.type).toBe("join");
    expect(b.type).toBe("join");
    expect(players).toHaveLength(2);
    expect(players[0]!.disconnected).toBe(false);
    expect(players[1]!.disconnected).toBe(false);
    expect(players[0]!.clientId).toBe("tab-a");
    expect(players[1]!.clientId).toBe("tab-b");
    expect(players[0]!.name).toBe("Player");
    expect(players[1]!.name).toBe("Player");
});

test("joining a third player does not disconnect existing sockets", () => {
    const players: TeamPlayerIdentity[] = [
        seat({ clientId: "host", name: "Alice", ip: "1.1.1.1" }),
        seat({ clientId: "two", name: "Bob", ip: "2.2.2.2" }),
    ];
    const decision = applyTeamJoin(
        players,
        seat({ clientId: "three", name: "Carol", ip: "3.3.3.3" }),
        4,
    );
    expect(decision.type).toBe("join");
    expect(decision).not.toHaveProperty("replacedClientId");
    expect(players).toHaveLength(3);
    expect(players[0]!.disconnected).toBe(false);
    expect(players[1]!.disconnected).toBe(false);
    expect(players[0]!.clientId).toBe("host");
    expect(players[1]!.clientId).toBe("two");
    expect(players[2]!.clientId).toBe("three");
    // Host/joiner reconnect still maps to their own seat, not a teammate's.
    expect(findTeamPlayerReclaimIndex(players, { userId: null, clientId: "host" })).toBe(0);
    expect(findTeamPlayerReclaimIndex(players, { userId: null, clientId: "two" })).toBe(1);
});

test("same name and same IP does not steal a live seat", () => {
    const players = [
        seat({ clientId: "host", name: "Player", ip: "127.0.0.1" }),
    ];
    expect(
        resolveTeamJoinSlot(
            players,
            { userId: null, clientId: "joiner", name: "Player", ip: "127.0.0.1" },
            4,
        ),
    ).toEqual({ type: "join" });
});

test("reclaim prefers a disconnected slot with the same clientId", () => {
    const players = [
        seat({ clientId: "host", name: "Host", ip: "1.1.1.1" }),
        seat({ disconnected: true, clientId: "joiner", name: "Joiner", ip: "2.2.2.2" }),
    ];
    expect(
        findTeamPlayerReclaimIndex(players, {
            userId: null,
            clientId: "joiner",
            name: "Joiner",
            ip: "9.9.9.9",
        }),
    ).toBe(1);
});

test("reconnect that beats the old close takes over the live slot", () => {
    const players = [
        seat({ clientId: "host", name: "Host", ip: "1.1.1.1" }),
        seat({ clientId: "joiner", name: "Joiner", ip: "2.2.2.2" }),
    ];
    // Duo lobby is already full; without takeover this join would be join_full
    // and the client would reconnect forever.
    expect(
        findTeamPlayerReclaimIndex(players, {
            userId: null,
            clientId: "joiner",
            name: "Joiner",
            ip: "2.2.2.2",
        }),
    ).toBe(1);
});

test("logged-in reconnect without clientId takes over a disconnected account slot", () => {
    const players = [
        seat({ userId: "user-a", clientId: "a", name: "A", ip: "1.1.1.1" }),
        seat({
            disconnected: true,
            userId: "user-b",
            clientId: "b",
            name: "B",
            ip: "2.2.2.2",
        }),
    ];
    expect(
        findTeamPlayerReclaimIndex(players, {
            userId: "user-b",
            clientId: "",
            name: "B-renamed",
            ip: "8.8.8.8",
        }),
    ).toBe(1);
});

test("two tabs of the same account do not steal a live seat", () => {
    const players = [
        seat({ userId: "user-a", clientId: "tab-1", name: "A", ip: "1.1.1.1" }),
    ];
    expect(
        resolveTeamJoinSlot(
            players,
            { userId: "user-a", clientId: "tab-2", name: "A", ip: "1.1.1.1" },
            4,
        ),
    ).toEqual({ type: "join" });
});

test("a new player does not steal another live slot", () => {
    const players = [
        seat({ clientId: "host", name: "Host", ip: "1.1.1.1" }),
        seat({ clientId: "joiner", name: "Joiner", ip: "2.2.2.2" }),
    ];
    expect(
        findTeamPlayerReclaimIndex(players, {
            userId: null,
            clientId: "third",
            name: "Third",
            ip: "3.3.3.3",
        }),
    ).toBe(-1);
});

test("second join does not disconnect player 1 or immediately remove player 2", () => {
    const players: TeamPlayerIdentity[] = [];
    const host = applyTeamJoin(
        players,
        seat({ clientId: "p1", name: "Player", ip: "10.0.0.1" }),
        4,
    );
    const joiner = applyTeamJoin(
        players,
        seat({ clientId: "p2", name: "Player", ip: "10.0.0.2" }),
        4,
    );
    expect(host.type).toBe("join");
    expect(joiner.type).toBe("join");
    expect(players).toHaveLength(2);
    expect(players[0]!.disconnected).toBe(false);
    expect(players[1]!.disconnected).toBe(false);
    expect(players[0]!.clientId).toBe("p1");
    expect(players[1]!.clientId).toBe("p2");
    // A later keepAlive/join from p2 must not mark p1 disconnected or drop p2.
    expect(
        resolveTeamJoinSlot(
            players,
            { userId: null, clientId: "p2", name: "Player", ip: "10.0.0.2" },
            4,
        ),
    ).toEqual({ type: "reclaim", index: 1 });
    expect(players[0]!.disconnected).toBe(false);
    expect(players[1]!.disconnected).toBe(false);
    expect(players[0]!.clientId).toBe("p1");
    expect(players[1]!.clientId).toBe("p2");
});

test("full room rejects a new clientId without closing existing seats", () => {
    const players = [
        seat({ clientId: "a", name: "Player", ip: "1.1.1.1" }),
        seat({ clientId: "b", name: "Player", ip: "1.1.1.1" }),
    ];
    const snapshot = players.map((p) => ({ ...p }));
    expect(
        applyTeamJoin(
            players,
            seat({ clientId: "c", name: "Player", ip: "1.1.1.1" }),
            2,
        ),
    ).toEqual({ type: "full" });
    expect(players).toEqual(snapshot);
});

/** Mirrors Room.joinPlayersToMatch gameId selection (team rejoin after match ends). */
function teamLobbyFindGameId(
    create: boolean | undefined,
    hasActiveMatch: boolean,
    activeGameId: string | undefined,
): string | undefined {
    // playGame passes create → new match. Rejoin keeps activeMatch.gameId even
    // when every seat momentarily has inGame=false (solo / last-operator reload).
    return create || !hasActiveMatch ? undefined : activeGameId;
}

test("finished match must not reuse stale gameId when starting again", () => {
    const staleId = "11111111-1111-1111-1111-111111111111";
    expect(teamLobbyFindGameId(true, false, staleId)).toBeUndefined();
    expect(teamLobbyFindGameId(undefined, false, staleId)).toBeUndefined();
});

test("in-progress match rejoin keeps gameId for late lobby reconnects", () => {
    const liveId = "22222222-2222-2222-2222-222222222222";
    expect(teamLobbyFindGameId(undefined, true, liveId)).toBe(liveId);
    expect(teamLobbyFindGameId(true, true, liveId)).toBeUndefined();
});

/**
 * Mirrors Room.addPlayer: only auto-resume when reclaimPlayerId is already set.
 * Blind auto-join on lobby reconnect races page reload and spawns duplicates.
 */
function shouldAutoResumeMatchAfterReclaim(
    hasReclaimPlayerId: boolean,
    oldInGame: boolean,
    hasActiveMatch: boolean,
    matchInProgressAfterReplace: boolean,
    newInGame: boolean,
): boolean {
    if (!hasReclaimPlayerId) return false;
    const resumeMatch = oldInGame && hasActiveMatch;
    return (resumeMatch || matchInProgressAfterReplace) && !newInGame;
}

test("lobby seat reclaim does not auto-join without reclaimPlayerId", () => {
    expect(shouldAutoResumeMatchAfterReclaim(false, true, true, false, false)).toBe(false);
    expect(shouldAutoResumeMatchAfterReclaim(true, true, true, false, false)).toBe(true);
    expect(shouldAutoResumeMatchAfterReclaim(true, false, true, true, false)).toBe(true);
    expect(shouldAutoResumeMatchAfterReclaim(false, false, true, true, false)).toBe(false);
});

test("Hono WSContext clones share one player via the raw socket", () => {
    const raw = {};
    const openCtx = { raw };
    const data = ensureTeamSocketData<{ clientId: string }>(openCtx, "10.0.0.1");
    expect(data.player).toBeUndefined();
    data.player = { clientId: "p1" };

    // First client message uses a new WSContext wrapping the same Bun socket.
    const msgCtx = { raw };
    const again = ensureTeamSocketData<{ clientId: string }>(msgCtx, "10.0.0.1");
    expect(again).toBe(data);
    expect(again.player?.clientId).toBe("p1");

    const joinRaw = {};
    const joinOpen = { raw: joinRaw };
    const joinData = ensureTeamSocketData<{ clientId: string }>(joinOpen, "10.0.0.2");
    joinData.player = { clientId: "p2" };
    const joinMsg = { raw: joinRaw };
    expect(getTeamSocketData<{ clientId: string }>(joinMsg)?.player?.clientId).toBe("p2");
    expect(getTeamSocketData<{ clientId: string }>(openCtx)?.player?.clientId).toBe("p1");
});
