import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { TeamMode } from "../../../../shared/gameConfig.ts";
import {
    type LeaderboardRequest,
    type LeaderboardResponse,
    resolveLeaderboardLimit,
} from "../../../../shared/types/stats.ts";
import { Config } from "../../config.ts";
import type { SaveGameBody } from "../../utils/types.ts";
import { isMongo } from "./dialect.ts";
import { mongoStore } from "./mongoStore.ts";
import { matchDataTable } from "./schema.ts";
import { insertIgnore } from "./sqlHelpers.ts";

const DB_PATH = path.resolve(Config.database.sqlitePath || "data/specops-local.db");
/** Daily copies live beside the live DB: `<db-dir>/db-backups/specops-local-YYYY-MM-DD.db`. */
const BACKUP_DIR = path.join(path.dirname(DB_PATH), "db-backups");
const BACKUP_RETENTION_DAYS = 90;
const BACKUP_NAME_RE = /^specops-local-(\d{4}-\d{2}-\d{2})\.db$/;

type MatchRow = SaveGameBody["matchData"][number];
type StoreLogger = {
    info: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
};

let sqlite: Database | null = null;

function getDb() {
    if (!sqlite) {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        sqlite = new Database(DB_PATH);
        // WAL + busy timeout: game processes insert while the API reads leaderboards.
        sqlite.exec("PRAGMA journal_mode = WAL;");
        sqlite.exec("PRAGMA synchronous = NORMAL;");
        sqlite.exec("PRAGMA busy_timeout = 5000;");
        sqlite.exec(`CREATE TABLE IF NOT EXISTS local_match_data (
            user_id TEXT DEFAULT '',
            user_banned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            region TEXT NOT NULL,
            map_id INTEGER NOT NULL,
            game_id TEXT NOT NULL,
            map_seed INTEGER NOT NULL,
            username TEXT NOT NULL,
            player_id INTEGER NOT NULL,
            team_mode INTEGER NOT NULL,
            team_count INTEGER NOT NULL,
            team_total INTEGER NOT NULL,
            team_id INTEGER NOT NULL,
            time_alive INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            died INTEGER NOT NULL,
            kills INTEGER NOT NULL,
            team_kills INTEGER NOT NULL DEFAULT 0,
            damage_dealt INTEGER NOT NULL,
            damage_taken INTEGER NOT NULL,
            killer_id INTEGER NOT NULL,
            killed_ids TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT '',
            waves_survived INTEGER NOT NULL DEFAULT 0,
            squad_name TEXT NOT NULL DEFAULT '',
            game_version TEXT NOT NULL DEFAULT '',
            difficulty TEXT NOT NULL DEFAULT '',
            synced INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (game_id, player_id)
        )`);
        sqlite.exec(
            `CREATE INDEX IF NOT EXISTS idx_local_match_leaderboard
            ON local_match_data (team_mode, map_id, time_alive DESC)`,
        );
        try {
            sqlite.exec(
                `ALTER TABLE local_match_data ADD COLUMN waves_survived INTEGER NOT NULL DEFAULT 0`,
            );
        } catch {
            // Column already exists on upgraded local DBs.
        }
        try {
            sqlite.exec(
                `ALTER TABLE local_match_data ADD COLUMN squad_name TEXT NOT NULL DEFAULT ''`,
            );
        } catch {
            // Column already exists on upgraded local DBs.
        }
        try {
            sqlite.exec(
                `ALTER TABLE local_match_data ADD COLUMN game_version TEXT NOT NULL DEFAULT ''`,
            );
        } catch {
            // Column already exists on upgraded local DBs.
        }
        try {
            sqlite.exec(
                `ALTER TABLE local_match_data ADD COLUMN difficulty TEXT NOT NULL DEFAULT ''`,
            );
        } catch {
            // Column already exists on upgraded local DBs.
        }
        sqlite.exec(
            `CREATE INDEX IF NOT EXISTS idx_local_match_waves
            ON local_match_data (team_mode, map_id, waves_survived DESC)`,
        );
        sqlite.exec(
            `CREATE INDEX IF NOT EXISTS idx_local_match_squad_name
            ON local_match_data (team_mode, map_id, squad_name)`,
        );
    }
    return sqlite;
}

function rowToMatchInsert(row: MatchRow) {
    return {
        userId: row.userId ?? "",
        userBanned: false,
        region: row.region,
        mapId: row.mapId,
        gameId: row.gameId,
        mapSeed: row.mapSeed,
        username: row.username,
        playerId: row.playerId,
        teamMode: row.teamMode,
        teamCount: row.teamCount,
        teamTotal: row.teamTotal,
        teamId: row.teamId,
        timeAlive: row.timeAlive,
        rank: row.rank,
        died: row.died,
        kills: row.kills,
        teamKills: row.teamKills,
        damageDealt: row.damageDealt,
        damageTaken: row.damageTaken,
        killerId: row.killerId,
        killedIds: row.killedIds,
        role: row.role ?? "",
        wavesSurvived: row.wavesSurvived ?? 0,
        squadName: row.squadName ?? "",
        gameVersion: row.gameVersion ?? "",
        difficulty: row.difficulty ?? "",
    };
}

export function insertLocalMatchData(rows: MatchRow[]) {
    if (!rows.length) return;

    const database = getDb();
    const insert = database.prepare(
        `INSERT OR IGNORE INTO local_match_data (
            user_id, user_banned, region, map_id, game_id, map_seed, username, player_id,
            team_mode, team_count, team_total, team_id, time_alive, rank, died, kills,
            team_kills, damage_dealt, damage_taken, killer_id, killed_ids, role,
            waves_survived, squad_name, game_version, difficulty, synced
        ) VALUES (
            $userId, $userBanned, $region, $mapId, $gameId, $mapSeed, $username, $playerId,
            $teamMode, $teamCount, $teamTotal, $teamId, $timeAlive, $rank, $died, $kills,
            $teamKills, $damageDealt, $damageTaken, $killerId, $killedIds, $role,
            $wavesSurvived, $squadName, $gameVersion, $difficulty, 0
        )`,
    );

    const tx = database.transaction((batch: MatchRow[]) => {
        for (const row of batch) {
            insert.run({
                $userId: row.userId ?? "",
                $userBanned: 0,
                $region: row.region,
                $mapId: row.mapId,
                $gameId: row.gameId,
                $mapSeed: row.mapSeed,
                $username: row.username,
                $playerId: row.playerId,
                $teamMode: row.teamMode,
                $teamCount: row.teamCount,
                $teamTotal: row.teamTotal,
                $teamId: row.teamId,
                $timeAlive: row.timeAlive,
                $rank: row.rank,
                $died: row.died ? 1 : 0,
                $kills: row.kills,
                // Coerce missing / legacy snake_case so INSERT OR IGNORE cannot
                // silently drop rows on NOT NULL team_kills.
                $teamKills: row.teamKills
                    ?? (row as { team_kills?: number }).team_kills
                    ?? 0,
                $damageDealt: row.damageDealt,
                $damageTaken: row.damageTaken,
                $killerId: row.killerId,
                $killedIds: JSON.stringify(row.killedIds ?? []),
                $role: row.role ?? "",
                $wavesSurvived: row.wavesSurvived ?? 0,
                $squadName: row.squadName ?? "",
                $gameVersion: row.gameVersion ?? "",
                $difficulty: row.difficulty ?? "",
            } as Record<string, string | number | null>);
        }
    });

    withSqliteBusyRetry(() => {
        tx(rows);
    });
}

function withSqliteBusyRetry<T>(fn: () => T, attempts = 8): T {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return fn();
        } catch (err) {
            lastErr = err;
            const code = (err as { code?: string })?.code;
            if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw err;
            Bun.sleepSync(25 * (i + 1));
        }
    }
    throw lastErr;
}

export function queryLocalLeaderboard(params: LeaderboardRequest): LeaderboardResponse[] {
    const database = getDb();
    const { interval, mapId, teamMode, type } = params;
    const limit = resolveLeaderboardLimit(params.maxCount);

    if (type !== "longest_survived" && type !== "waves_survived") {
        return [];
    }

    let intervalClause = "";
    if (interval === "daily") {
        intervalClause = "AND created_at >= datetime('now', '-1 day')";
    } else if (interval === "weekly") {
        intervalClause = "AND created_at >= datetime('now', '-7 days')";
    }

    const wavesFilter = type === "waves_survived"
        ? "AND waves_survived > 0"
        : "";

    const limitClause = limit == null ? "" : "LIMIT $limit";
    const scoreOrder = type === "waves_survived"
        ? `waves_survived DESC,
            CASE LOWER(IFNULL(difficulty, ''))
                WHEN 'veteran' THEN 4
                WHEN 'hardened' THEN 3
                WHEN 'regular' THEN 2
                WHEN 'recruit' THEN 1
                ELSE 0
            END DESC,
            time_alive ASC, created_at DESC`
        : "time_alive DESC, created_at DESC";
    const outerOrder = type === "waves_survived"
        ? `ORDER BY val DESC,
            CASE LOWER(IFNULL(difficulty, ''))
                WHEN 'veteran' THEN 4
                WHEN 'hardened' THEN 3
                WHEN 'regular' THEN 2
                WHEN 'recruit' THEN 1
                ELSE 0
            END DESC,
            timeAlive ASC`
        : "ORDER BY val DESC";

    const useFireteamNames = type === "waves_survived"
        && (teamMode === TeamMode.Duo || teamMode === TeamMode.Squad);

    const bestRowSelect = (
        partitionExpr: string,
        nameExpr: string,
        extraWhere: string,
        isTeam: 0 | 1,
    ) => `
        SELECT
            ${nameExpr} AS username,
            region,
            game_id AS gameId,
            ${isTeam} AS isTeam,
            ${type === "waves_survived" ? "waves_survived" : "time_alive"} AS val,
            time_alive AS timeAlive,
            created_at AS submittedAt,
            IFNULL(game_version, '') AS version,
            IFNULL(difficulty, '') AS difficulty,
            COUNT(game_id) OVER (PARTITION BY ${partitionExpr}) AS games,
            ROW_NUMBER() OVER (
                PARTITION BY ${partitionExpr}
                ORDER BY ${scoreOrder}
            ) AS rn
        FROM local_match_data
        WHERE team_mode = $teamMode
            AND map_id = $mapId
            ${intervalClause}
            ${wavesFilter}
            ${extraWhere}
    `;

    const sql = useFireteamNames
        ? `SELECT username, region, gameId, isTeam, val, timeAlive, games, submittedAt, version, difficulty FROM (
                SELECT * FROM (${
            bestRowSelect(
                "username, region",
                "username",
                "AND IFNULL(squad_name, '') = ''",
                0,
            )
        }) WHERE rn = 1

                UNION ALL

                SELECT * FROM (${
            bestRowSelect(
                "squad_name, region",
                "squad_name",
                "AND IFNULL(squad_name, '') != ''",
                1,
            )
        }) WHERE rn = 1
            )
            ${outerOrder}
            ${limitClause}`
        : `SELECT username, region, gameId, 0 AS isTeam, val, timeAlive, games, submittedAt, version, difficulty FROM (
                ${bestRowSelect("username, region", "username", "", 0)}
            ) ranked
            WHERE rn = 1
            ${outerOrder}
            ${limitClause}`;

    const rows = withSqliteBusyRetry(() =>
        database
            .query(sql)
            .all({
                $teamMode: teamMode,
                $mapId: mapId,
                ...(limit == null ? {} : { $limit: limit }),
            }) as Array<{
                username: string;
                region: string;
                gameId: string;
                isTeam: number;
                val: number;
                timeAlive: number;
                games: number;
                submittedAt: string;
                version: string;
                difficulty: string;
            }>
    );

    const memberStmt = useFireteamNames
        ? database.prepare(
            `SELECT DISTINCT username AS name
             FROM local_match_data
             WHERE game_id = $gameId
               AND team_mode = $teamMode
               AND map_id = $mapId
               AND IFNULL(squad_name, '') = $squadName
             ORDER BY username COLLATE NOCASE`,
        )
        : null;

    return rows.map((row) => {
        let members: string[] | undefined;
        if (memberStmt && row.isTeam && row.gameId) {
            const names = withSqliteBusyRetry(() =>
                memberStmt.all({
                    $gameId: row.gameId,
                    $teamMode: teamMode,
                    $mapId: mapId,
                    $squadName: row.username,
                }) as Array<{ name: string }>
            ).map((r) => r.name).filter(Boolean);
            if (names.length) members = names;
        }

        return {
            username: row.username,
            slug: null,
            region: row.region,
            val: row.val,
            games: row.games,
            time: type === "waves_survived" ? row.timeAlive : undefined,
            version: row.version || undefined,
            difficulty: row.difficulty || undefined,
            submittedAt: toIsoSubmittedAt(row.submittedAt),
            members,
        };
    });
}

function toIsoSubmittedAt(value: string | Date | null | undefined): string | undefined {
    if (!value) return undefined;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    }
    const raw = String(value).trim();
    if (!raw) return undefined;
    // SQLite datetime('now') is typically "YYYY-MM-DD HH:MM:SS" (UTC-ish).
    const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
        const fallback = new Date(raw);
        return Number.isNaN(fallback.getTime()) ? undefined : fallback.toISOString();
    }
    return parsed.toISOString();
}

async function insertRowsToPostgres(rows: MatchRow[]) {
    if (!rows.length) return 0;

    const values = rows.map(rowToMatchInsert);
    if (isMongo()) {
        await mongoStore.insertMatchData(values);
    } else {
        await insertIgnore(matchDataTable, values);
    }
    return values.length;
}

function localDateStamp(date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function pruneOldSqliteBackups(logger: StoreLogger) {
    if (!fs.existsSync(BACKUP_DIR)) return;

    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - BACKUP_RETENTION_DAYS);
    const cutoffStamp = localDateStamp(cutoff);

    let removed = 0;
    for (const name of fs.readdirSync(BACKUP_DIR)) {
        const match = BACKUP_NAME_RE.exec(name);
        if (!match) continue;
        if (match[1]! >= cutoffStamp) continue;
        try {
            fs.unlinkSync(path.join(BACKUP_DIR, name));
            removed++;
        } catch (err) {
            logger.error(`Failed to delete old SQLite backup ${name}`, err);
        }
    }
    if (removed) {
        logger.info(
            `Pruned ${removed} SQLite backup(s) older than ${BACKUP_RETENTION_DAYS} days`,
        );
    }
}

/**
 * Online-safe daily snapshot of the local SQLite match DB (VACUUM INTO),
 * then delete backups older than {@link BACKUP_RETENTION_DAYS}.
 */
export function backupLocalMatchDatabase(logger: StoreLogger) {
    try {
        if (!fs.existsSync(DB_PATH)) {
            // Ensure the live DB exists before snapshotting.
            getDb();
        }
        fs.mkdirSync(BACKUP_DIR, { recursive: true });

        const stamp = localDateStamp();
        const dest = path.join(BACKUP_DIR, `specops-local-${stamp}.db`);
        if (fs.existsSync(dest)) {
            pruneOldSqliteBackups(logger);
            return;
        }

        const db = getDb();
        // VACUUM INTO needs a stable absolute path; normalize separators for SQLite.
        const destSql = dest.replaceAll("\\", "/");
        db.exec(`VACUUM INTO ${JSON.stringify(destSql)}`);

        const sizeKb = Math.round(fs.statSync(dest).size / 1024);
        logger.info(`SQLite backup saved (${sizeKb} KB): ${dest}`);
        pruneOldSqliteBackups(logger);
    } catch (err) {
        logger.error("Failed to back up local SQLite database", err);
    }
}

export async function drainLocalMatchStore(logger: StoreLogger) {
    const database = getDb();
    const unsynced = database
        .query(
            `SELECT * FROM local_match_data WHERE synced = 0 ORDER BY created_at ASC`,
        )
        .all() as Array<Record<string, unknown>>;

    if (unsynced.length) {
        const rows: MatchRow[] = unsynced.map((row) => ({
            userId: String(row.user_id ?? ""),
            region: String(row.region),
            mapId: Number(row.map_id),
            gameId: String(row.game_id),
            mapSeed: Number(row.map_seed),
            username: String(row.username),
            playerId: Number(row.player_id),
            teamMode: Number(row.team_mode) as MatchRow["teamMode"],
            teamCount: Number(row.team_count),
            teamTotal: Number(row.team_total),
            teamId: Number(row.team_id),
            timeAlive: Number(row.time_alive),
            rank: Number(row.rank),
            died: Boolean(row.died),
            kills: Number(row.kills),
            team_kills: Number(row.team_kills),
            damageDealt: Number(row.damage_dealt),
            damageTaken: Number(row.damage_taken),
            killerId: Number(row.killer_id),
            killedIds: JSON.parse(String(row.killed_ids || "[]")) as number[],
            wavesSurvived: Number(row.waves_survived ?? 0),
            squadName: String(row.squad_name ?? ""),
            gameVersion: String(row.game_version ?? ""),
            difficulty: String(row.difficulty ?? ""),
            role: String(row.role ?? ""),
            ip: "",
            findGameIp: "",
        }));

        try {
            await insertRowsToPostgres(rows);
            const markSynced = database.prepare(
                `UPDATE local_match_data SET synced = 1
                WHERE game_id = $gameId AND player_id = $playerId`,
            );
            const tx = database.transaction((batch: MatchRow[]) => {
                for (const row of batch) {
                    markSynced.run({ $gameId: row.gameId, $playerId: row.playerId });
                }
            });
            tx(rows);
            logger.info(`Drained ${rows.length} local SQLite match rows into Postgres`);
        } catch (err) {
            logger.error("Failed to drain SQLite match store into Postgres", err);
        }
    }

    const dir = path.resolve("lost_game_data");
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (!files.length) return;

    let drainedFiles = 0;
    for (const fileName of files) {
        const filePath = path.join(dir, fileName);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as MatchRow[];
            if (!Array.isArray(data) || !data.length) {
                fs.unlinkSync(filePath);
                continue;
            }
            await insertRowsToPostgres(data);
            fs.unlinkSync(filePath);
            drainedFiles++;
        } catch (err) {
            logger.error(`Failed to drain lost game file ${fileName}`, err);
        }
    }

    if (drainedFiles) {
        logger.info(`Drained ${drainedFiles} lost_game_data files into Postgres`);
    }
}
