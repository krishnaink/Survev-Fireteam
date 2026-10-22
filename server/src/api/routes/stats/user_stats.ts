import { and, eq, gte, max, type SQL, sql, sum } from "drizzle-orm";
import { Hono } from "hono";
import {
    ALL_MAPS,
    type UserStatsRequest,
    type UserStatsResponse,
    zUserStatsRequest,
} from "../../../../../shared/types/stats.ts";
import { databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { isMongo, isMysql, sqlIdent, sqlLoadoutPlayerIcon } from "../../db/dialect.ts";
import { db } from "../../db/index.ts";
import { mongoStore } from "../../db/mongoStore.ts";
import { matchDataTable, usersTable } from "../../db/schema.ts";
import { sqlNowMinusDays } from "../../db/sqlHelpers.ts";
import type { Context } from "../../index.ts";

export const UserStatsRouter = new Hono<Context>();

/*
 * minimum data required for the ui to show the user doesn't exist
 */
const emptyState = {
    slug: "",
    username: "",
    modes: [],
};

UserStatsRouter.post(
    "/",
    databaseEnabledMiddleware,
    rateLimitMiddleware(40, 60 * 1000),
    validateParams(zUserStatsRequest),
    async (c) => {
        const { interval, mapIdFilter, slug } = c.req.valid("json");

        if (isMongo()) {
            const user = await mongoStore.findUserBySlug(slug);
            if (!user) return c.json(emptyState, 200);
            const data = await mongoStore.userStats(user.id, mapIdFilter, interval);
            return c.json<UserStatsResponse>(data, 200);
        }

        const result = await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, slug),
            columns: {
                id: true,
                banned: true,
            },
        });

        if (!result) {
            return c.json(emptyState, 200);
        }

        const { id: userId } = result;

        const data = await userStatsSqlQuery(userId, mapIdFilter, interval);

        return c.json<UserStatsResponse>(data, 200);
    },
);

const intervalFilter: Record<string, SQL<unknown>> = {
    daily: gte(matchDataTable.createdAt, sqlNowMinusDays(1)),
    weekly: gte(matchDataTable.createdAt, sqlNowMinusDays(7)),
};

async function userStatsSqlQuery(
    userId: string,
    mapIdFilter: string,
    interval: UserStatsRequest["interval"],
): Promise<UserStatsResponse> {
    const withSelect = db.$with("mode_stats").as(
        db
            .select({
                team_mode: matchDataTable.teamMode,
                games: sql`COUNT(*)`.as("games"),
                // Spec Ops: "wins" is best rounds survived (max waves), not BR #1 finishes.
                wins: max(matchDataTable.wavesSurvived).as("wins"),
                kills: sum(matchDataTable.kills).as("kills"),
                winPct: sql`ROUND(AVG(${matchDataTable.wavesSurvived}) * 1.0, 1)`.as(
                    "winpct",
                ),
                most_kills: max(matchDataTable.kills).as("most_kills"),
                most_damage: max(matchDataTable.damageDealt).as("most_damage"),
                kpg: sql`ROUND(SUM(${matchDataTable.kills}) * 1.0 / COUNT(*), 1)`.as(
                    "kpg",
                ),
                avg_damage: sql`ROUND(AVG(${matchDataTable.damageDealt}))`.as(
                    "avg_damage",
                ),
                avg_time_alive: sql`ROUND(AVG(${matchDataTable.timeAlive}))`.as(
                    "avg_time_alive",
                ),
            })
            .from(matchDataTable)
            .where(
                and(
                    eq(matchDataTable.userId, userId),
                    mapIdFilter !== ALL_MAPS
                        ? eq(matchDataTable.mapId, parseInt(mapIdFilter))
                        : undefined,
                    interval in intervalFilter ? intervalFilter[interval] : undefined,
                ),
            )
            .groupBy(matchDataTable.teamMode),
    );

    const modeStats = sqlIdent("mode_stats");
    const modesJson = isMysql()
        ? sql`COALESCE(JSON_ARRAYAGG(
            CASE WHEN ${modeStats}.team_mode IS NOT NULL THEN
                JSON_OBJECT(
                    'wins', ${modeStats}.wins,
                    'kills', ${modeStats}.kills,
                    'teamMode', ${modeStats}.team_mode,
                    'avgDamage', ${modeStats}.avg_damage,
                    'avgTimeAlive', ${modeStats}.avg_time_alive,
                    'mostDamage', ${modeStats}.most_damage,
                    'kpg', ${modeStats}.kpg,
                    'winPct', ${modeStats}.winPct,
                    'mostKills', ${modeStats}.most_kills,
                    'games', ${modeStats}.games
                )
            END
        ), JSON_ARRAY())`
        : sql`COALESCE(JSON_AGG(
            CASE WHEN ${modeStats}.team_mode IS NOT NULL THEN
                JSON_BUILD_OBJECT(
                    'wins', ${modeStats}.wins,
                    'kills', ${modeStats}.kills,
                    'teamMode', ${modeStats}.team_mode,
                    'avgDamage', ${modeStats}.avg_damage,
                    'avgTimeAlive', ${modeStats}.avg_time_alive,
                    'mostDamage', ${modeStats}.most_damage,
                    'kpg', ${modeStats}.kpg,
                    'winPct', ${modeStats}.winPct,
                    'mostKills', ${modeStats}.most_kills,
                    'games', ${modeStats}.games
                )
            END
        ), '[]')`;

    const res = await db
        .with(withSelect)
        .select({
            slug: usersTable.slug,
            username: usersTable.username,
            banned: usersTable.banned,
            player_icon: sqlLoadoutPlayerIcon(usersTable.loadout),
            games: sql`COALESCE(SUM(${modeStats}.games), 0)`,
            wins: sql`COALESCE(MAX(${modeStats}.wins), 0)`,
            kills: sql`COALESCE(SUM(${modeStats}.kills), 0)`,
            kpg: sql`COALESCE(ROUND(SUM(${modeStats}.kills) * 1.0 / NULLIF(SUM(${modeStats}.games), 0), 1), 0)`,
            modes: modesJson,
        })
        .from(usersTable)
        .leftJoin(withSelect, eq(sql`1`, 1))
        .where(eq(usersTable.id, userId))
        .groupBy(usersTable.slug, usersTable.username, usersTable.banned)
        .limit(1);

    const userStats = res[0] as UserStatsResponse;

    if (!userStats || !userStats.slug) return emptyState as unknown as UserStatsResponse;

    const modes = userStats?.modes;
    const formatedData: UserStatsResponse = {
        ...userStats,
        // sql fuckery, it returns [null] where no result
        modes: modes[0] === null ? [] : modes,
    };
    return formatedData;
}
