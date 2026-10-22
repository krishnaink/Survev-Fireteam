import { afterEach, beforeEach, describe, expect, test } from "vitest";

const saved: {
    IS_DEV?: boolean;
    window?: typeof globalThis.window;
    PROXY_DEFS?: unknown;
} = {};

describe("api URL resolution", () => {
    beforeEach(() => {
        saved.IS_DEV = (globalThis as unknown as { IS_DEV?: boolean }).IS_DEV;
        saved.window = globalThis.window;
        saved.PROXY_DEFS = (globalThis as unknown as { PROXY_DEFS?: unknown }).PROXY_DEFS;

        (globalThis as unknown as { IS_DEV: boolean }).IS_DEV = false;
        (globalThis as unknown as { API_PUBLIC_URL: string }).API_PUBLIC_URL = "";
        (globalThis as unknown as { PROXY_DEFS: unknown }).PROXY_DEFS = {
            default: { apiUrl: "https://api.other.com" },
        };
        if (!globalThis.window) {
            (globalThis as unknown as { window: Window & typeof globalThis }).window = {
                location: {
                    protocol: "https:",
                    hostname: "play.example.com",
                    host: "play.example.com",
                    port: "",
                },
            } as Window & typeof globalThis;
        } else {
            Object.assign(globalThis.window.location, {
                protocol: "https:",
                hostname: "play.example.com",
                host: "play.example.com",
                port: "",
            });
        }
    });

    afterEach(() => {
        if (saved.IS_DEV !== undefined) {
            (globalThis as unknown as { IS_DEV: boolean }).IS_DEV = saved.IS_DEV;
        }
        if (saved.PROXY_DEFS !== undefined) {
            (globalThis as unknown as { PROXY_DEFS: unknown }).PROXY_DEFS = saved.PROXY_DEFS;
        }
        if (saved.window !== undefined) {
            (globalThis as unknown as { window: typeof globalThis.window }).window = saved.window;
        }
    });

    test("production resolveUrl stays same-origin", async () => {
        const { api } = await import("../../client/src/api.ts");
        expect(api.resolveUrl("/api/find_game_v2")).toBe("/api/find_game_v2");
    });

    test("production ping WS is same-origin only", async () => {
        const { api } = await import("../../client/src/api.ts");
        expect(api.resolvePingWsUrls(true)).toEqual(["wss://play.example.com/ptc"]);
    });

    test("production ping WS prefers region public host", async () => {
        const { api } = await import("../../client/src/api.ts");
        expect(api.resolvePingWsUrls(true, "eu.example.com")).toEqual([
            "wss://eu.example.com/ptc",
            "wss://play.example.com/ptc",
        ]);
    });

    test("production team WS is same-origin only", async () => {
        const { api } = await import("../../client/src/api.ts");
        expect(api.resolveTeamWsUrls()).toEqual(["wss://play.example.com/team_v2"]);
    });

    test("production game WS joins child host directly", async () => {
        const { api } = await import("../../client/src/api.ts");
        const urls = api.resolveGameWsUrls(["ws://127.0.0.1:8002/play"]);
        expect(urls).toEqual(["wss://127.0.0.1:8002/play"]);
    });

    test("production game WS tunnels when match is on page host", async () => {
        const { api } = await import("../../client/src/api.ts");
        const urls = api.resolveGameWsUrls(["ws://play.example.com:8002/play"]);
        expect(urls).toEqual(["wss://play.example.com/g/8002/play"]);
    });

    test("dev session find stays same-origin", async () => {
        (globalThis as unknown as { IS_DEV: boolean }).IS_DEV = true;
        Object.assign(globalThis.window.location, {
            protocol: "http:",
            hostname: "97.122.217.13",
            host: "97.122.217.13:3000",
            origin: "http://97.122.217.13:3000",
            port: "3000",
        });
        const { api } = await import("../../client/src/api.ts");
        expect(api.resolveSessionFindUrl("https://fireteam.bbyte.app/session/find_game"))
            .toBe("http://97.122.217.13:3000/session/find_game");
    });

    test("dev ping WS stays same-origin", async () => {
        (globalThis as unknown as { IS_DEV: boolean }).IS_DEV = true;
        Object.assign(globalThis.window.location, {
            protocol: "http:",
            hostname: "97.122.217.13",
            host: "97.122.217.13:3000",
            origin: "http://97.122.217.13:3000",
            port: "3000",
        });
        const { api } = await import("../../client/src/api.ts");
        expect(api.resolvePingWsUrls(true, "fireteam.bbyte.app")).toEqual([
            "ws://97.122.217.13:3000/ptc",
        ]);
    });

    test("dev game WS tunnels live CDN urls via the page", async () => {
        (globalThis as unknown as { IS_DEV: boolean }).IS_DEV = true;
        Object.assign(globalThis.window.location, {
            protocol: "http:",
            hostname: "97.122.217.13",
            host: "97.122.217.13:3000",
            origin: "http://97.122.217.13:3000",
            port: "3000",
        });
        const { api } = await import("../../client/src/api.ts");
        const urls = api.resolveGameWsUrls([
            "wss://fireteam.bbyte.app/g/9001/play?gameId=abc",
        ]);
        expect(urls).toEqual([
            "ws://97.122.217.13:3000/g/9001/play?gameId=abc",
        ]);
    });
});
