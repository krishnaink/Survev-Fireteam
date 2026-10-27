// Runs in Bun because the production local store uses bun:sqlite.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Config } from "../../server/src/config.ts";
import type { SaveGameBody } from "../../server/src/utils/types.ts";
import { MapId, TeamMode } from "../../shared/gameConfig.ts";

Config.database.enabled = false;
Config.database.sqlitePath = process.argv[2]!;
const { insertLocalMatchData, queryLocalLeaderboard } = await import("../../server/src/api/db/localMatchStore.ts");

function player(overrides: Partial<SaveGameBody["matchData"][number]> = {}): SaveGameBody["matchData"][number] {
    return {
        userId: "",
        region: "na",
        mapId: MapId.SpecOps,
        gameId: randomUUID(),
        mapSeed: 1,
        username: "Operator",
        playerId: 1,
        teamMode: TeamMode.Squad,
        teamCount: 2,
        teamTotal: 1,
        teamId: 1,
        timeAlive: 300,
        rank: 1,
        died: true,
        kills: 10,
        downs: 0,
        revives: 0,
        teamKills: 0,
        damageDealt: 0,
        damageTaken: 0,
        killerId: 0,
        killedIds: [],
        role: "",
        wavesSurvived: 8,
        squadName: "Night Watch",
        gameVersion: "1.7",
        difficulty: "regular",
        ip: "",
        findGameIp: "",
        ...overrides,
    };
}

const best = randomUUID();
insertLocalMatchData([
    player({ gameId: best, username: "Krish", kills: 20, downs: 1, revives: 3 }),
    player({ gameId: best, username: "Ghost", playerId: 2, kills: 30, downs: 2, revives: 1 }),
    // Same lobby label in a different team must not inflate the selected team's totals.
    player({ gameId: best, username: "Other team", teamId: 2, playerId: 3, timeAlive: 600, kills: 900 }),
    // A lower-scoring run with more kills must not replace the ranked run's stats.
    player({ wavesSurvived: 7, kills: 999, downs: 99, revives: 99 }),
    player({ username: "Solo", teamMode: TeamMode.Solo, squadName: "", kills: 12, downs: 0, revives: 0 }),
    player({ username: "Unnamed", squadName: "", kills: 14 }),
    player({ username: "Alpha", squadName: "Alpha · Bravo", kills: 15 }),
]);

const params = {
    type: "waves_survived" as const,
    interval: "alltime" as const,
    teamMode: TeamMode.Squad,
    mapId: MapId.SpecOps,
    maxCount: 0,
};
const modern = queryLocalLeaderboard(params);
const solo = queryLocalLeaderboard({ ...params, teamMode: TeamMode.Solo });

// Execute both dialects' parameterized ranking query against the same fixture data.
const { wavesLeaderboardQuery, sqlResultRows } = await import("../../server/src/api/db/leaderboardQuery.ts");
const requireServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { PgDialect } = requireServer("drizzle-orm/pg-core");
const { MySqlDialect } = requireServer("drizzle-orm/mysql-core");
const db = new Database(Config.database.sqlitePath);
db.exec("CREATE VIEW match_data AS SELECT * FROM local_match_data");
const sqlBoards = [new PgDialect(), new MySqlDialect()].map((dialect) => {
    const query = dialect.sqlToQuery(wavesLeaderboardQuery(params));
    return db.query(query.sql).all(...query.params.map((p: unknown) => typeof p === "boolean" ? Number(p) : p));
});
const envelopes = [sqlResultRows({ rows: [1] }), sqlResultRows([[2], []]), sqlResultRows([3])];
// Reopen an actual pre-upgrade table in a separate process to exercise migration.
db.exec(
    "DROP VIEW match_data; ALTER TABLE local_match_data DROP COLUMN downs; ALTER TABLE local_match_data DROP COLUMN revives;",
);
db.close();
console.log("RESULT:" + JSON.stringify({ modern, solo, sqlBoards, envelopes }));
