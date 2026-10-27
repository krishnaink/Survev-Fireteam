import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveFireteamSquadName } from "../../server/src/utils/badWords.ts";
import { MapId } from "../../shared/gameConfig.ts";
import type { LeaderboardResponse } from "../../shared/types/stats.ts";
import { leaderboardName, leaderboardRunDetails, leaderboardStat } from "../../shared/utils/leaderboard.ts";

describe("leaderboard run summaries", () => {
    test("uses the squad-creation name, with existing player-name fallback", () => {
        expect(resolveFireteamSquadName("Night Watch", ["Krish", "Ghost"])).toBe("Night Watch");
        expect(resolveFireteamSquadName("", ["Krish", "Ghost"])).toBe("Ghost · Krish");
        const base = { val: 8, region: "na", slug: null, username: "Ghost · Krish", members: ["Ghost", "Krish"] };
        expect(leaderboardName({ ...base, fireteamName: "Night Watch" })).toBe("Night Watch");
        expect(leaderboardName(base)).toBe("Ghost · Krish");
        expect(leaderboardName({ val: 8, region: "na", slugs: [null, null], usernames: ["A", "B"] })).toBe("A · B");
    });

    test("unknown counters stay unknown, including partially recorded team runs", () => {
        const details = leaderboardRunDetails([
            { username: "A", kills: 10, downs: 0, revives: 2 },
            { username: "B", kills: 20, downs: null },
        ], "Team");
        expect(details.kills).toBe(30);
        expect(details.downs).toBeNull();
        expect(details.revives).toBeNull();
        expect(leaderboardStat(0)).toBe("0");
        expect(leaderboardStat(null)).toBe("—");
        expect(leaderboardStat(undefined)).toBe("—");
        expect(leaderboardRunDetails([]).kills).toBeNull();
    });

    test("SQLite selects one ranked run, isolates teams, saves counters and upgrades old tables", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "fireteam-leaderboard-"));
        const root = path.resolve(import.meta.dirname, "../..");
        const dbPath = path.join(dir, "stats.db");
        try {
            const output = execFileSync("bun", ["tests/src/leaderboardStore.fixture.ts", dbPath], {
                cwd: root,
                encoding: "utf8",
            });
            const { modern, solo, sqlBoards, envelopes } = JSON.parse(output.split("RESULT:")[1]!) as {
                modern: LeaderboardResponse[];
                solo: LeaderboardResponse[];
                sqlBoards: { username: string; game_id: string; games: number }[][];
                envelopes: number[][];
            };
            expect(envelopes).toEqual([[1], [2], [3]]);
            for (const board of sqlBoards) {
                expect(board).toHaveLength(modern.length);
                expect(board.find((r) => r.username === "Night Watch")?.games).toBe(2);
            }
            const team = modern.find((r) => r.fireteamName === "Night Watch")!;
            expect(team.kills).toBe(50);
            expect(team.downs).toBe(3);
            expect(team.revives).toBe(4);
            expect(team.members).toEqual(["Ghost", "Krish"]);
            expect(team.memberStats?.find((p) => p.username === "Krish")?.revives).toBe(3);
            expect(solo[0].kills).toBe(12);
            expect(solo[0].downs).toBe(0);
            expect(solo[0].fireteamName).toBeUndefined();
            expect(modern.find((r) => "username" in r && r.username === "Unnamed")?.kills).toBe(14);
            expect(modern.find((r) => r.fireteamName === "Alpha · Bravo")?.kills).toBe(15);

            const script = `
                import { Config } from './server/src/config.ts';
                Config.database.enabled = false;
                Config.database.sqlitePath = process.argv[1];
                const { queryLocalLeaderboard } = await import('./server/src/api/db/localMatchStore.ts');
                console.log('RESULT:' + JSON.stringify(queryLocalLeaderboard({type:'waves_survived',interval:'alltime',teamMode:4,mapId:${MapId.SpecOps},maxCount:0})));
            `;
            const upgraded = execFileSync("bun", ["-e", script, dbPath], { cwd: root, encoding: "utf8" });
            const legacy = JSON.parse(upgraded.split("RESULT:")[1]!) as LeaderboardResponse[];
            const oldTeam = legacy.find((r) => r.fireteamName === "Night Watch")!;
            expect(oldTeam.kills).toBe(50);
            expect(oldTeam.downs).toBeNull();
            expect(oldTeam.revives).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
