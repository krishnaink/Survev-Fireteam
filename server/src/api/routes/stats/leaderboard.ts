import { and, count, eq, gte, inArray, ne, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { TeamMode } from "../../../../../shared/gameConfig.ts";
import {
    type LeaderboardRequest,
    type LeaderboardResponse,
    resolveLeaderboardLimit,
    zLeaderboardsRequest,
} from "../../../../../shared/types/stats.ts";
import { Config } from "../../../config.ts";
import { server } from "../../apiServer.ts";
import { rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { leaderboardCache } from "../../cache/leaderboard.ts";
import { isMongo, sqlMatchedUsersAgg } from "../../db/dialect.ts";
import { db } from "../../db/index.ts";
import { queryLocalLeaderboard } from "../../db/localMatchStore.ts";
import { mongoStore } from "../../db/mongoStore.ts";
import { matchDataTable, usersTable } from "../../db/schema.ts";
import { sqlCreatedAtSinceDays, sqlNowMinusDays } from "../../db/sqlHelpers.ts";
import type { Context } from "../../index.ts";
export const leaderboardRouter = new Hono<Context>();

const MinGames = {
    kpg: {
        daily: 15,
        weekly: 50,
        alltime: 100,
    },
} as Record<LeaderboardRequest["type"], Record<LeaderboardRequest["interval"], number>>;

leaderboardRouter.post(
    "/",
    rateLimitMiddleware(40, 60 * 1000),
    validateParams(zLeaderboardsRequest),
    async (c) => {
        const params = c.req.valid("json");

        if (!Config.database.enabled) {
            const data = queryLocalLeaderboard(params);
            return c.json<LeaderboardResponse[]>(data, 200);
        }

        if (isMongo()) {
            const data = await mongoStore.leaderboard(params);
            if (data.length) await leaderboardCache.set(params, data);
            return c.json<LeaderboardResponse[]>(data, 200);
        }

        const { type, teamMode } = params;
        const cachedResult = await leaderboardCache.get(params);

        if (cachedResult) {
            server.logger.debug(
                `[CACHE HIT] -> ${leaderboardCache.getCacheKey("leaderboard", params)}`,
            );
            return c.json(cachedResult, 200);
        }

        const startTime = performance.now();
        const data = (type === "most_kills" && teamMode != TeamMode.Solo)
            ? await multiplePlayersQuery(params)
            : await soloLeaderboardQuery(params);
        logQueryPerformance(startTime, params);

        // TODO: decide if we should cache empty results;
        if (data.length != 0) {
            await leaderboardCache.set(params, data);
        }

        return c.json<LeaderboardResponse[]>(data, 200);
    },
);

const typeToQuery: Record<LeaderboardRequest["type"], string> = {
    kills: "SUM(match_data.kills)",
    most_damage_dealt: "MAX(match_data.damage_dealt)",
    kpg: "ROUND(SUM(match_data.kills) * 1.0 / COUNT(*), 1)",
    most_kills: "match_data.kills",
    wins: "COUNT(CASE WHEN match_data.rank = 1 THEN 1 END)",
    longest_survived: "MAX(match_data.time_alive)",
    waves_survived: "MAX(match_data.waves_survived)",
};

const intervalFilter = {
    daily: gte(matchDataTable.createdAt, sqlNowMinusDays(1)),
    weekly: gte(matchDataTable.createdAt, sqlNowMinusDays(7)),
};

async function soloLeaderboardQuery(params: LeaderboardRequest) {
    const { interval, mapId, teamMode, type } = params;

    if (type === "waves_survived") {
        return wavesSurvivedLeaderboardQuery(params);
    }

    const minGames = type === "kpg" ? MinGames[type][interval] : 1;
    const limit = resolveLeaderboardLimit(params.maxCount);

    const usernameQuery = type === "most_kills" ? matchDataTable.username : usersTable.username;

    const query = db
        .select({
            username: usernameQuery,
            mapId: matchDataTable.mapId,
            region: matchDataTable.region,
            teamMode: matchDataTable.teamMode,
            games: count(sql`DISTINCT(match_data.game_id)`),
            slug: usersTable.slug,
            val: sql.raw(`${typeToQuery[type]} as val`) as SQL<number>,
        })
        .from(matchDataTable)
        .leftJoin(usersTable, eq(usersTable.id, matchDataTable.userId))
        .where(
            and(
                eq(matchDataTable.teamMode, teamMode),
                eq(usersTable.banned, false),
                interval === "alltime" ? undefined : intervalFilter[interval],
                ne(matchDataTable.userId, ""),
                eq(matchDataTable.mapId, mapId),
            ),
        )
        .groupBy(
            matchDataTable.mapId,
            usersTable.slug,
            matchDataTable.region,
            matchDataTable.teamMode,
            usernameQuery,
            sql`${type === "most_kills" ? matchDataTable.kills : ""}`,
        )
        .having(gte(count(sql`DISTINCT(match_data.game_id)`), minGames))
        .orderBy(sql`val DESC`);

    const result = limit == null ? await query : await query.limit(limit);

    return result as LeaderboardResponse[];
}

/**
 * Spec Ops rounds board with Fireteam version + submission date from the best run.
 * Duo/squad: named fireteams collapse to one row; empty squad_name stays per-player.
 */
async function wavesSurvivedLeaderboardQuery(
    params: LeaderboardRequest,
): Promise<LeaderboardResponse[]> {
    const { interval, mapId, teamMode } = params;
    const limit = resolveLeaderboardLimit(params.maxCount);
    const intervalSql = interval === "alltime"
        ? sql``
        : interval === "daily"
        ? sqlCreatedAtSinceDays(1)
        : sqlCreatedAtSinceDays(7);
    const limitSql = limit == null ? sql`` : sql`LIMIT ${limit}`;
    const useFireteamNames = teamMode === TeamMode.Duo || teamMode === TeamMode.Squad;

    const playerPartition = sql`
        SELECT
            username,
            region,
            game_id,
            0 AS is_team,
            waves_survived AS val,
            time_alive AS time,
            created_at AS submitted_at,
            COALESCE(game_version, '') AS version,
            COALESCE(difficulty, '') AS difficulty,
            COUNT(DISTINCT game_id) OVER (PARTITION BY username, region) AS games,
            ROW_NUMBER() OVER (
                PARTITION BY username, region
                ORDER BY waves_survived DESC,
                    CASE LOWER(COALESCE(difficulty, ''))
                        WHEN 'veteran' THEN 4
                        WHEN 'hardened' THEN 3
                        WHEN 'regular' THEN 2
                        WHEN 'recruit' THEN 1
                        ELSE 0
                    END DESC,
                    time_alive ASC, created_at DESC
            ) AS rn
        FROM match_data
        WHERE team_mode = ${teamMode}
            AND map_id = ${mapId}
            AND waves_survived > 0
            AND COALESCE(user_banned, false) = false
            ${useFireteamNames ? sql`AND COALESCE(squad_name, '') = ''` : sql``}
            ${intervalSql}
    `;

    const squadPartition = sql`
        SELECT
            squad_name AS username,
            region,
            game_id,
            1 AS is_team,
            waves_survived AS val,
            time_alive AS time,
            created_at AS submitted_at,
            COALESCE(game_version, '') AS version,
            COALESCE(difficulty, '') AS difficulty,
            COUNT(DISTINCT game_id) OVER (PARTITION BY squad_name, region) AS games,
            ROW_NUMBER() OVER (
                PARTITION BY squad_name, region
                ORDER BY waves_survived DESC,
                    CASE LOWER(COALESCE(difficulty, ''))
                        WHEN 'veteran' THEN 4
                        WHEN 'hardened' THEN 3
                        WHEN 'regular' THEN 2
                        WHEN 'recruit' THEN 1
                        ELSE 0
                    END DESC,
                    time_alive ASC, created_at DESC
            ) AS rn
        FROM match_data
        WHERE team_mode = ${teamMode}
            AND map_id = ${mapId}
            AND waves_survived > 0
            AND COALESCE(user_banned, false) = false
            AND COALESCE(squad_name, '') != ''
            ${intervalSql}
    `;

    const result = useFireteamNames
        ? await db.execute(sql`
            SELECT username, region, game_id, is_team, val, time, games, submitted_at, version, difficulty FROM (
                SELECT * FROM (${playerPartition}) p WHERE rn = 1
                UNION ALL
                SELECT * FROM (${squadPartition}) s WHERE rn = 1
            ) ranked
            ORDER BY val DESC,
                CASE LOWER(COALESCE(difficulty, ''))
                    WHEN 'veteran' THEN 4
                    WHEN 'hardened' THEN 3
                    WHEN 'regular' THEN 2
                    WHEN 'recruit' THEN 1
                    ELSE 0
                END DESC,
                time ASC
            ${limitSql}
        `)
        : await db.execute(sql`
            SELECT username, region, game_id, is_team, val, time, games, submitted_at, version, difficulty FROM (
                ${playerPartition}
            ) ranked
            WHERE rn = 1
            ORDER BY val DESC,
                CASE LOWER(COALESCE(difficulty, ''))
                    WHEN 'veteran' THEN 4
                    WHEN 'hardened' THEN 3
                    WHEN 'regular' THEN 2
                    WHEN 'recruit' THEN 1
                    ELSE 0
                END DESC,
                time ASC
            ${limitSql}
        `);

    const rows = (result as unknown as {
        rows?: Array<{
            username: string;
            region: string;
            game_id: string;
            is_team: number | boolean;
            val: number;
            time: number;
            games: number;
            submitted_at: string | Date;
            version: string;
            difficulty: string;
        }>;
    }).rows ?? (result as unknown as Array<{
        username: string;
        region: string;
        game_id: string;
        is_team: number | boolean;
        val: number;
        time: number;
        games: number;
        submitted_at: string | Date;
        version: string;
        difficulty: string;
    }>);

    const out: LeaderboardResponse[] = [];
    for (const row of rows) {
        let members: string[] | undefined;
        const isTeam = row.is_team === true || row.is_team === 1;
        if (useFireteamNames && isTeam && row.game_id) {
            const memberRes = await db.execute(sql`
                SELECT DISTINCT username
                FROM match_data
                WHERE game_id = ${row.game_id}
                    AND team_mode = ${teamMode}
                    AND map_id = ${mapId}
                    AND COALESCE(squad_name, '') = ${row.username}
                ORDER BY username ASC
            `);
            const memberRows = (memberRes as unknown as {
                rows?: Array<{ username: string }>;
            }).rows ?? (memberRes as unknown as Array<{ username: string }>);
            members = memberRows.map((m) => m.username).filter(Boolean);
            if (!members.length) members = undefined;
        }

        out.push({
            username: row.username,
            slug: null,
            region: row.region,
            val: Number(row.val),
            games: Number(row.games),
            time: Number(row.time),
            version: row.version || undefined,
            difficulty: row.difficulty || undefined,
            submittedAt: toIsoSubmittedAt(row.submitted_at),
            members,
        });
    }
    return out;
}

function toIsoSubmittedAt(value: string | Date | null | undefined): string | undefined {
    if (!value) return undefined;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    }
    const raw = String(value).trim();
    if (!raw) return undefined;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

async function multiplePlayersQuery(params: LeaderboardRequest): Promise<LeaderboardResponse[]> {
    const { interval, mapId, teamMode } = params;
    const limit = resolveLeaderboardLimit(params.maxCount);

    const baseQuery = db
        .select({
            matchedUsers: sqlMatchedUsersAgg(
                matchDataTable.username,
                matchDataTable.userId,
            ) as SQL<{ username: string; userId: string | null }[]>,
            region: matchDataTable.region,
            val: sql<number>`SUM(${matchDataTable.kills}) as val`,
        })
        .from(matchDataTable)
        .where(
            and(
                interval === "alltime" ? undefined : intervalFilter[interval],
                eq(matchDataTable.userBanned, false),
                eq(matchDataTable.teamMode, teamMode),
                eq(matchDataTable.mapId, mapId),
            ),
        )
        .groupBy(matchDataTable.gameId, matchDataTable.teamId, matchDataTable.region)
        // make sure at least one member of the duo / squad is logged in
        .having(sql`count(case when user_id!='' then 1 end) >= 1`)
        .orderBy(sql`val DESC`);

    const data = limit == null ? await baseQuery : await baseQuery.limit(limit);

    // get slugs using userIds
    // @NOTE: previously this was done in SQL using a join
    // but performance degraded significantly with larger table
    // splitting it into two separate queries is much faster

    const userIds: string[] = [];
    for (const row of data) {
        for (const { userId } of row.matchedUsers) {
            if (!userId) continue;
            userIds.push(userId);
        }
    }

    const slugsFromUserIds = await db
        .select({
            slug: usersTable.slug,
            id: usersTable.id,
        })
        .from(usersTable)
        .where(and(inArray(usersTable.id, userIds), eq(usersTable.banned, false)));

    const slugMap = Object.fromEntries(
        slugsFromUserIds.map(({ id, slug }) => [id, slug]),
    );

    return data.map((row) => {
        const usernames = [];
        const slugs = [];
        for (const { userId, username } of row.matchedUsers) {
            usernames.push(username);
            slugs.push(userId ? slugMap[userId] || null : null);
        }

        return {
            region: row.region,
            slugs,
            usernames,
            val: row.val,
        };
    }) satisfies LeaderboardResponse[];
}

function logQueryPerformance(startTime: number, params: LeaderboardRequest) {
    const endTime = performance.now();
    const executionTime = endTime - startTime;
    const timeString = executionTime > 1000
        ? `${(executionTime / 1000).toFixed(2)}s`
        : `${executionTime.toFixed(2)}ms`;
    server.logger[executionTime > 1000 ? "warn" : "debug"](
        `leaderboard | Execution time: ${timeString} | ${leaderboardCache.getCacheKey("debug" as any, params)}`,
    );
}
