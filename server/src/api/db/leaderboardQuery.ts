import { sql } from "drizzle-orm";
import { TeamMode } from "../../../../shared/gameConfig.ts";
import { type LeaderboardRequest, resolveLeaderboardLimit } from "../../../../shared/types/stats.ts";
import { sqlCreatedAtSinceDays } from "./sqlHelpers.ts";

/** PostgreSQL and MariaDB both reject COUNT(DISTINCT ...) as a window function. */
export function wavesLeaderboardQuery(params: LeaderboardRequest) {
    const { interval, mapId, teamMode } = params;
    const useNames = teamMode === TeamMode.Duo || teamMode === TeamMode.Squad;
    const limit = resolveLeaderboardLimit(params.maxCount);
    const intervalSql = interval === "alltime" ? sql`` : sqlCreatedAtSinceDays(interval === "daily" ? 1 : 7);
    return sql`
        WITH eligible AS (
            SELECT *,
                CASE WHEN ${useNames} AND COALESCE(squad_name, '') != '' THEN squad_name ELSE username END AS board_name,
                CASE WHEN ${useNames} AND COALESCE(squad_name, '') != '' THEN 1 ELSE 0 END AS is_team,
                CASE LOWER(COALESCE(difficulty, ''))
                    WHEN 'veteran' THEN 4 WHEN 'hardened' THEN 3
                    WHEN 'regular' THEN 2 WHEN 'recruit' THEN 1 ELSE 0
                END AS difficulty_rank
            FROM match_data
            WHERE team_mode = ${teamMode} AND map_id = ${mapId}
                AND waves_survived > 0 AND COALESCE(user_banned, false) = false
                ${intervalSql}
        ), ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY board_name, region, is_team
                ORDER BY waves_survived DESC, difficulty_rank DESC, time_alive ASC, created_at DESC, player_id ASC
            ) AS rn FROM eligible
        ), game_counts AS (
            SELECT board_name, region, is_team, COUNT(DISTINCT game_id) AS games
            FROM eligible GROUP BY board_name, region, is_team
        )
        SELECT r.board_name AS username, r.region, r.game_id, r.team_id, r.player_id,
            r.is_team, r.waves_survived AS val, r.time_alive AS time,
            r.created_at AS submitted_at, r.game_version AS version, r.difficulty, c.games, r.kills, r.downs, r.revives
        FROM ranked r JOIN game_counts c
            ON r.board_name = c.board_name AND r.region = c.region AND r.is_team = c.is_team
        WHERE r.rn = 1
        ORDER BY r.waves_survived DESC, r.difficulty_rank DESC, r.time_alive ASC
        ${limit == null ? sql`` : sql`LIMIT ${limit}`}
    `;
}

/** Drizzle's PostgreSQL and MySQL execute methods return different envelopes. */
export function sqlResultRows<T>(result: unknown): T[] {
    if (Array.isArray(result)) return (Array.isArray(result[0]) ? result[0] : result) as T[];
    return (result as { rows: T[] }).rows;
}
