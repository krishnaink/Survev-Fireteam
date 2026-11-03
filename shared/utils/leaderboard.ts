import { MapId } from "../gameConfig.ts";
import type { LeaderboardCombatStats, LeaderboardMember, LeaderboardResponse } from "../types/stats.ts";

/** Leaderboard sections. Each game mode saves runs under its own map id. */
export const LeaderboardModes = [
    { key: "fireteam", mapId: MapId.SpecOps, label: "Fireteam", desc: "Soldier waves on outdoor maps" },
    { key: "zombies", mapId: MapId.Zombies, label: "Zombies", desc: "Zombie waves in Last Call" },
] as const;

export type LeaderboardModeKey = (typeof LeaderboardModes)[number]["key"];

/** Mode for a `mode=` or `mapId=` URL value; unknown values fall back to Fireteam. */
export function leaderboardMode(value: string | number | null | undefined) {
    const v = String(value ?? "");
    return LeaderboardModes.find((m) => m.key === v || String(m.mapId) === v) ?? LeaderboardModes[0];
}

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
