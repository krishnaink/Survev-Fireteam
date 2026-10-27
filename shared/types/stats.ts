import { z } from "zod";
import { MapId, TeamMode } from "../gameConfig.ts";

//
// Match History
//

/**
 * sent by the client when to teammode filter is selected
 */
export const ALL_TEAM_MODES = 7;
export const zMatchHistoryRequest = z.object({
    slug: z.string(),
    offset: z.number(),
    count: z.number(),
    teamModeFilter: z.union([
        z.literal(TeamMode.Solo),
        z.literal(TeamMode.Duo),
        z.literal(TeamMode.Squad),
        z.literal(ALL_TEAM_MODES),
    ]),
});

export type MatchHistoryParams = z.infer<typeof zMatchHistoryRequest>;

export type MatchHistory = {
    guid: string;
    region: string;
    map_id: number;
    team_mode: number;
    team_count: number;
    team_total: number;
    end_time: string | Date;
    time_alive: number;
    rank: number;
    waves_survived: number;
    kills: number;
    team_kills: number;
    damage_dealt: number;
    damage_taken: number;
};
export type MatchHistoryResponse = MatchHistory[];

//
// Match Data
//
export const zMatchDataRequest = z.object({
    gameId: z.string(),
});

export type MatchDataRequest = z.infer<typeof zMatchDataRequest>;
export type MatchDataResponse = MatchData[];

export type MatchData = {
    slug: string | null;
    username: string;
    player_id: number;
    team_id: number;
    time_alive: number;
    rank: number;
    died: boolean;
    kills: number;
    damage_dealt: number;
    damage_taken: number;
    killer_id: number;
    killed_ids: number[];
    role: string;
};

//
// User Stats
//
export const ALL_MAPS = "-1";
const VALID_MAP_IDS = Object.values(MapId)
    .filter((id) => typeof id === "number")
    .map((id) => id.toString()) as [string, ...string[]];

export const zUserStatsRequest = z.object({
    interval: z.enum(["daily", "weekly", "alltime"]),
    slug: z.string().min(1),
    mapIdFilter: z.enum([ALL_MAPS, ...VALID_MAP_IDS]),
});

export type UserStatsRequest = z.infer<typeof zUserStatsRequest>;

export type UserStatsResponse = {
    slug: string;
    username: string;
    player_icon: string;
    banned: boolean;
    wins: number;
    kills: number;
    games: number;
    kpg: string;
    modes: Mode[];
};

export interface Mode {
    teamMode: number;
    games: number;
    wins: number;
    kills: number;
    winPct: string;
    mostKills: number;
    mostDamage: number;
    kpg: string;
    avgDamage: number;
    avgTimeAlive: number;
}

//
// Leaderboard
//
const teamModeMap = {
    solo: TeamMode.Solo,
    duo: TeamMode.Duo,
    squad: TeamMode.Squad,
};

/** Menu / default board size. Full stats page passes 0 for every ranked row. */
export const LEADERBOARD_DEFAULT_COUNT = 100;
/** Soft ceiling when a positive maxCount is requested (abuse guard). */
export const LEADERBOARD_HARD_MAX_COUNT = 50_000;

export const zLeaderboardsRequest = z.object({
    interval: z.enum(["daily", "weekly", "alltime"]),
    mapId: z.enum(VALID_MAP_IDS).transform((v) => Number(v)),
    type: z.enum([
        "most_kills",
        "most_damage_dealt",
        "kpg",
        "kills",
        "wins",
        "longest_survived",
        "waves_survived",
    ]),
    teamMode: z.enum(["solo", "duo", "squad"]).transform((mode) => teamModeMap[mode]),
    /**
     * How many ranked rows to return.
     * - omitted → top 100 (menu sidebar)
     * - 0 → all rows (full stats page)
     * - 1..HARD_MAX → that many rows
     */
    maxCount: z.number().int().min(0).max(LEADERBOARD_HARD_MAX_COUNT).optional(),
});

/** Resolve SQL LIMIT; `null` means no limit (return every ranked row). */
export function resolveLeaderboardLimit(maxCount: number | undefined): number | null {
    if (maxCount === 0) return null;
    if (maxCount === undefined) return LEADERBOARD_DEFAULT_COUNT;
    return Math.min(maxCount, LEADERBOARD_HARD_MAX_COUNT);
}

export interface LeaderboardCombatStats {
    kills?: number | null;
    /** Times this operator was downed, rather than enemies downed. */
    downs?: number | null;
    revives?: number | null;
}

export interface LeaderboardMember extends LeaderboardCombatStats {
    username: string;
}

export type LeaderboardResponse =
    & LeaderboardCombatStats
    & {
        val: number;
        region: string;
        /**
         * not used
         */
        active?: boolean;
        /**
         * required for all types except most_kills & win_streak
         */
        games?: number;
        /**
         * Optional survived time in seconds, shown as a secondary Spec Ops metric.
         */
        time?: number;
        /**
         * Fireteam release that produced this score (e.g. "1.6"). Empty for legacy rows.
         */
        version?: string;
        /**
         * Spec Ops difficulty for the best run (recruit / regular / hardened / veteran).
         */
        difficulty?: string;
        /**
         * ISO timestamp when the best score row was saved.
         */
        submittedAt?: string;
        /**
         * Duo/squad: players on the best-scoring run (full board expand; menu may show count).
         */
        members?: string[];
        /** Saved squad-creation name, or the existing generated roster name. */
        fireteamName?: string;
        memberStats?: LeaderboardMember[];
    }
    & (
        | {
            slug: string | null;
            username: string;
        }
        | {
            slugs: (string | null)[];
            usernames: string[];
        }
    );

export type LeaderboardRequest = z.infer<typeof zLeaderboardsRequest>;
