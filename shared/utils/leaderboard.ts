import type { LeaderboardCombatStats, LeaderboardMember, LeaderboardResponse } from "../types/stats.ts";

/** All counters come from the selected run; never combine personal-best runs. */
export function leaderboardRunDetails(players: LeaderboardMember[], fireteamName?: string) {
    const totals: LeaderboardCombatStats = {};
    for (const stat of ["kills", "downs", "revives"] as const) {
        totals[stat] = players.length && players.every((p) => p[stat] != null)
            ? players.reduce((sum, p) => sum + p[stat]!, 0)
            : null;
    }
    return {
        ...totals,
        fireteamName: fireteamName || undefined,
        members: fireteamName ? players.map((p) => p.username) : undefined,
        memberStats: players,
    };
}

export function leaderboardName(row: LeaderboardResponse): string {
    return row.fireteamName
        || ("username" in row ? row.username : row.usernames.join(" · "))
        || row.members?.join(" · ")
        || "—";
}

export function leaderboardStat(value: number | null | undefined): string {
    return value == null ? "—" : value.toLocaleString();
}
