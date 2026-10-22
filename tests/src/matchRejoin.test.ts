import { expect, test } from "vitest";
import {
    type ActiveMatchSession,
    buildRejoinUrl,
    MATCH_REJOIN_TTL_MS,
    mergeRejoinSessions,
    parseRejoinFromLocation,
    rejoinSecondsLeft,
    resolveTeamRoomUrl,
} from "../../client/src/matchRejoin.ts";

test("buildRejoinUrl encodes match parameters", () => {
    const session: ActiveMatchSession = {
        gameId: "abc-123",
        region: "local",
        gameModeIdx: 2,
        playerName: "Op",
        teamRoomUrl: "#AbCd",
        expiresAt: Date.now() + MATCH_REJOIN_TTL_MS,
    };
    const url = new URL(buildRejoinUrl(session, "https://example.com/play"));
    expect(url.searchParams.get("rejoin")).toBe("1");
    expect(url.searchParams.get("gameId")).toBe("abc-123");
    expect(url.searchParams.get("region")).toBe("local");
    expect(url.searchParams.get("mode")).toBe("2");
    expect(url.searchParams.get("team")).toBe("AbCd");
    expect(url.searchParams.get("until")).toBe(String(session.expiresAt));
});

test("parseRejoinFromLocation rejects expired links", () => {
    const params = new URLSearchParams({
        rejoin: "1",
        gameId: "x",
        region: "local",
        mode: "1",
        until: String(Date.now() - 1000),
    });
    expect(parseRejoinFromLocation(`?${params.toString()}`)).toBeUndefined();
});

test("parseRejoinFromLocation accepts valid links", () => {
    const until = Date.now() + 30_000;
    const params = new URLSearchParams({
        rejoin: "1",
        gameId: "live-game",
        region: "eu",
        mode: "0",
        until: String(until),
        team: "Zz99",
    });
    const parsed = parseRejoinFromLocation(`?${params.toString()}`);
    expect(parsed?.gameId).toBe("live-game");
    expect(parsed?.region).toBe("eu");
    expect(parsed?.gameModeIdx).toBe(0);
    expect(parsed?.teamRoomUrl).toBe("#Zz99");
    expect(parsed?.expiresAt).toBe(until);
});

test("rejoinSecondsLeft counts down", () => {
    const session: ActiveMatchSession = {
        gameId: "g",
        region: "local",
        gameModeIdx: 0,
        playerName: "Op",
        expiresAt: Date.now() + 5500,
    };
    expect(rejoinSecondsLeft(session)).toBeGreaterThanOrEqual(5);
    expect(rejoinSecondsLeft(session)).toBeLessThanOrEqual(6);
});

test("parseRejoinFromLocation rejects invalid mode", () => {
    const params = new URLSearchParams({
        rejoin: "1",
        gameId: "x",
        region: "local",
        mode: "not-a-number",
        until: String(Date.now() + 30_000),
    });
    expect(parseRejoinFromLocation(`?${params.toString()}`)).toBeUndefined();
});

test("mergeRejoinSessions keeps token from storage and team from URL", () => {
    const until = Date.now() + 30_000;
    const urlSession: ActiveMatchSession = {
        gameId: "from-url",
        region: "eu",
        gameModeIdx: 1,
        playerName: "",
        teamRoomUrl: "#Squad1",
        expiresAt: until,
    };
    const stored: ActiveMatchSession = {
        gameId: "stored-game",
        region: "local",
        gameModeIdx: 0,
        playerName: "Op",
        token: "secret",
        urls: ["wss://example.com/g/8002/play"],
        expiresAt: until - 5000,
    };
    const merged = mergeRejoinSessions(urlSession, stored);
    expect(merged?.gameId).toBe("from-url");
    expect(merged?.token).toBe("secret");
    expect(merged?.teamRoomUrl).toBe("#Squad1");
    expect(merged?.playerName).toBe("Op");
    expect(merged?.expiresAt).toBe(until);
});

test("resolveTeamRoomUrl normalizes hash and prefers session value", () => {
    expect(resolveTeamRoomUrl({ teamRoomUrl: "AbCd" })).toBe("#AbCd");
    expect(resolveTeamRoomUrl({ teamRoomUrl: "#AbCd" })).toBe("#AbCd");
});
