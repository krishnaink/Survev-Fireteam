import { Cron } from "croner";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import pkgJson from "../../../package.json" with { type: "json" };
import {
    type FindGameResponse,
    type PublicGamesResponse,
    type SiteInfoRes,
    zFindGameBody,
} from "../../../shared/types/api.ts";
import { Config, loadedConfigPath } from "../config.ts";
import { appendClientLog, appendClientLogs } from "../utils/clientLogStore.ts";
import { GIT_VERSION } from "../utils/gitRevision.ts";
import { logErrorToWebhook } from "../utils/logger.ts";
import { isBehindProxy } from "../utils/proxyCheck.ts";
import { HTTPRateLimit } from "../utils/rateLimit.ts";
import { getFindGamePlayerData } from "./apiHelpers.ts";
import { getHonoIp, verifyTurnsStile } from "./apiHelpers.ts";
import { server } from "./apiServer.ts";
import { deleteExpiredSessions, validateSessionToken } from "./auth/index.ts";
import { rateLimitMiddleware, validateParams } from "./auth/middleware.ts";
import { initAccountsDatabase } from "./db/index.ts";
import { backupLocalMatchDatabase, drainLocalMatchStore } from "./db/localMatchStore.ts";
import type { SessionTableSelect, UsersTableSelect } from "./db/schema.ts";
import { cleanupOldLogs, isBanned } from "./routes/private/ModerationRouter.ts";
import { PrivateRouter } from "./routes/private/private.ts";
import { StatsRouter } from "./routes/stats/StatsRouter.ts";
import { AuthRouter } from "./routes/user/AuthRouter.ts";
import { UserRouter } from "./routes/user/UserRouter.ts";

export type Context = {
    Variables: {
        user: UsersTableSelect | null;
        session: SessionTableSelect | null;
    };
};

process.on("uncaughtException", async (err) => {
    console.error(err);

    await logErrorToWebhook("server", "API server error:", err);

    process.exit(1);
});

const app = new Hono();

app.onError((err: unknown, c) => {
    server.logger.error(`${c.req.path} Error:`, err);
    if (err instanceof HTTPException) {
        return err.getResponse();
    }
    return c.text("Internal Server Error", 500);
});

if (server.logger.config.debugLogs) {
    app.use("*", async (ctx, next) => {
        const url = ctx.req.path;
        server.logger.debug(`start: ${url}`);
        const start = performance.now();
        await next();

        const time = Math.round(performance.now() - start);
        server.logger.debug(`end  : ${url} time: ${time}ms`);
    });
}

app.use(
    "*",
    cors({
        origin: "*",
        credentials: true,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: [
            "Origin",
            "Content-Type",
            "Accept",
            "X-Requested-With",
            "survev-api-key",
        ],
        maxAge: 3600,
    }),
);

// @TODO: figure out the origins for this..
// app.use(csrf())

app.route("/api/user/", UserRouter);
app.route("/api/auth/", AuthRouter);
app.route("/api/", StatsRouter);
app.route("/private/", PrivateRouter);

server.init(app, upgradeWebSocket);

app.get("/api/site_info", (c) => {
    return c.json<SiteInfoRes>(server.getSiteInfo(), 200);
});

app.get("/api/public_games", (c) => {
    return c.json<PublicGamesResponse>({ games: server.publicGames }, 200);
});

// not using the middleware here to not add extra indentation... smh
const findGameRateLimit = new HTTPRateLimit(5, 3000);

app.post("/api/find_game", (c) => {
    return c.json({ error: "invalid_protocol" });
});

app.post("/api/find_game_v2", validateParams(zFindGameBody), async (c) => {
    const ip = getHonoIp(c, Config.apiServer.proxyIPHeader);

    if (!ip) {
        return c.json<FindGameResponse>({ type: "error", error: "invalid_ip" }, 500);
    }

    if (findGameRateLimit.isRateLimited(ip)) {
        return c.json<FindGameResponse>({ type: "error", error: "rate_limited" }, 429);
    }

    const banData = await isBanned(ip);
    if (banData) {
        return c.json<FindGameResponse>({
            type: "banned",
            reason: banData.reason,
            permanent: banData.permanent,
            expiresIn: banData.expiresIn,
        });
    }

    const token = randomUUID();
    let user: UsersTableSelect | null = null;

    const sessionId = getCookie(c, "session") ?? null;

    if (sessionId) {
        try {
            const account = await validateSessionToken(sessionId);
            user = account.user;

            if (account.user?.banned) {
                user = null;
            }
        } catch (err) {
            server.logger.error("/api/find_game: Failed to validate session", err);
            user = null;
        }
    }

    if (await isBehindProxy(ip, !user)) {
        return c.json<FindGameResponse>({ type: "error", error: "behind_proxy" });
    }

    const body = c.req.valid("json");

    const mode = server.modes[body.gameModeIdx];
    if (!mode || !mode.enabled) {
        return c.json<FindGameResponse>({ type: "error", error: "mode_disabled" });
    }

    if (server.captchaEnabled && !user) {
        if (!body.turnstileToken) {
            return c.json<FindGameResponse>({ type: "error", error: "invalid_captcha" });
        }

        try {
            if (!(await verifyTurnsStile(body.turnstileToken, ip))) {
                return c.json<FindGameResponse>({ type: "error", error: "invalid_captcha" });
            }
        } catch (err) {
            server.logger.error("/api/find_game: Failed verifying turnstile: ", err);
            return c.json<FindGameResponse>({ type: "error", error: "invalid_captcha" }, 500);
        }
    }

    const playerData = await getFindGamePlayerData([
        {
            token,
            userId: user?.id || null,
            ip,
            reclaimPlayerId: body.reclaimPlayerId,
        },
    ]);

    // Directory + ticket only — client completes find_game on the child host.
    // Master never waits on a down region (Plutonium-style).
    const session = server.issueFindGameSession(body.region, {
        region: body.region,
        version: body.version,
        mapName: mode.mapName,
        teamMode: mode.teamMode,
        autoFill: body.autoFill,
        difficulty: body.difficulty ?? Config.difficulty,
        endless: typeof body.endless === "boolean" ? body.endless : Config.endless,
        contractsEnabled: Config.contractsEnabled,
        playerData,
        gameId: body.gameId,
    });

    if ("error" in session) {
        return c.json<FindGameResponse>({ type: "error", error: session.error });
    }

    return c.json<FindGameResponse>({
        type: "session",
        res: {
            data: token,
            findUrl: session.findUrl,
            ticket: session.ticket,
            region: body.region,
        },
    });
});

const clientLogsRateLimit = new HTTPRateLimit(30, 60_000);
const clientErrorRateLimit = new HTTPRateLimit(5, 60_000);

app.post("/api/report_error", async (c) => {
    const ip = getHonoIp(c, Config.apiServer.proxyIPHeader) || "unknown";
    if (clientErrorRateLimit.isRateLimited(ip)) {
        return c.json({ error: "rate_limited" }, 429);
    }

    const content = await c.req.json();

    let stackTrace: string | undefined;
    if (
        typeof content.data === "object"
        && content.data
        && "stacktrace" in content.data
        && typeof content.data.stacktrace === "string"
        && content.data.stacktrace
    ) {
        stackTrace = `### Stacktrace:\n \`\`\`${content.data.stacktrace.replaceAll("`", "\\`")}\`\`\``;
        delete content.data.stacktrace;
    }

    void appendClientLog({
        ts: new Date().toISOString(),
        ip,
        loc: typeof content.loc === "string" ? content.loc : "report_error",
        level: "error",
        message: typeof content.loc === "string" ? content.loc : "client_error",
        data: content.data ?? content,
        sessionId: typeof content.data?.id === "string" ? content.data.id : undefined,
        userAgent: typeof content.data?.browser === "string" ? content.data.browser : undefined,
        protocol: typeof content.data?.protocol === "number" ? content.data.protocol : undefined,
        clientGitVersion: typeof content.data?.clientGitVersion === "string"
            ? content.data.clientGitVersion
            : undefined,
    });

    if (stackTrace) {
        logErrorToWebhook("client", content, stackTrace);
    } else {
        logErrorToWebhook("client", content);
    }
    return c.json({ success: true }, 200);
});

/** Batched browser console lines → logs/client/YYYY-MM-DD.jsonl */
app.post("/api/client_logs", async (c) => {
    const ip = getHonoIp(c, Config.apiServer.proxyIPHeader) || "unknown";
    if (clientLogsRateLimit.isRateLimited(ip)) {
        return c.json({ error: "rate_limited" }, 429);
    }

    const body = await c.req.json().catch(() => null) as {
        sessionId?: string;
        href?: string;
        userAgent?: string;
        entries?: Array<{
            ts?: string;
            level?: string;
            message?: string;
            data?: unknown;
        }>;
    } | null;

    const entries = Array.isArray(body?.entries) ? body!.entries.slice(0, 50) : [];
    if (!entries.length) {
        return c.json({ success: true, written: 0 }, 200);
    }

    const now = new Date().toISOString();
    await appendClientLogs(
        entries.map((e) => ({
            ts: typeof e.ts === "string" ? e.ts : now,
            ip,
            sessionId: typeof body?.sessionId === "string" ? body.sessionId : undefined,
            href: typeof body?.href === "string" ? body.href.slice(0, 512) : undefined,
            userAgent: typeof body?.userAgent === "string" ? body.userAgent.slice(0, 512) : undefined,
            level: typeof e.level === "string" ? e.level.slice(0, 32) : "log",
            loc: "console",
            message: typeof e.message === "string" ? e.message.slice(0, 4000) : "",
            data: e.data,
        })),
    );

    return c.json({ success: true, written: entries.length }, 200);
});

// Heartbeat watchdog: hide / drop game nodes that stop posting update_region.
setInterval(() => {
    server.pruneStaleRegions();
}, 15_000);

const apiTls = Config.apiServer.ssl
    ? {
        key: await Bun.file(Config.apiServer.ssl.keyFile).text(),
        cert: await Bun.file(Config.apiServer.ssl.certFile).text(),
    }
    : undefined;

const apiHost = Config.apiServer.host === "::" ? "[::]" : Config.apiServer.host;

Bun.serve({
    hostname: apiHost,
    port: Config.apiServer.port,
    tls: apiTls,
    fetch(req, bunServer) {
        return app.fetch(req, bunServer);
    },
    // Bun's default idleTimeout is 10s. Team keepAlive is 10s, so the lobby
    // WS was racing idle-close → client reconnect → sendState flicker for
    // everyone in the room. 120s leaves ample margin for keepAlive.
    websocket: {
        ...websocket,
        idleTimeout: 120,
        // Compression + the wan-proxy `ws` relay has dropped sibling lobby
        // sockets when a new /team_v2 upgrade arrived.
        perMessageDeflate: false,
    },
});

// Midnight: expire sessions / IP logs, and snapshot the local SQLite DB.
new Cron("0 0 * * *", async () => {
    try {
        await cleanupOldLogs();
        await deleteExpiredSessions();
        server.logger.info("Deleted old logs and expired sessions");
    } catch (err) {
        server.logger.error("Failed to run cleanup script", err);
    }
    backupLocalMatchDatabase(server.logger);
});

server.logger.info(`Survev API Server v${pkgJson.version} - GIT ${GIT_VERSION}`);
server.logger.info(`Config: ${loadedConfigPath}`);
server.logger.info(`Region: ${Config.gameServer.thisRegion}`);
server.logger.info(`Listening on ${Config.apiServer.host}:${Config.apiServer.port} (HTTP / team lobby)`);
server.logger.info("Press Ctrl+C to exit.");

// Take today's backup on boot (no-op if already present), then prune >90d copies.
backupLocalMatchDatabase(server.logger);

if (Config.database.enabled) {
    void initAccountsDatabase()
        .then(() => drainLocalMatchStore(server.logger))
        .catch((err) => {
            server.logger.error("Failed to init accounts DB / drain local matches", err);
        });
}
