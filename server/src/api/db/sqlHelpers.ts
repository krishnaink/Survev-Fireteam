import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { Config } from "../../config.ts";
import { isMysql } from "./dialect.ts";
import { db } from "./index.ts";

/** Insert rows, ignoring primary/unique conflicts (PG onConflictDoNothing / MySQL IGNORE). */
export async function insertIgnore(
    // drizzle table + values are intentionally loose across dialects
    table: any,
    values: any,
): Promise<void> {
    if (isMysql()) {
        await (db as any).insert(table).ignore().values(values);
        return;
    }
    await (db as any).insert(table).values(values).onConflictDoNothing();
}

export function sqlNowMinusDays(days: number): SQL {
    const n = Math.max(0, Math.floor(days));
    if (Config.database.engine === "mariadb") {
        return sql.raw(`NOW() - INTERVAL ${n} DAY`);
    }
    return sql.raw(`NOW() - INTERVAL '${n} ${n === 1 ? "day" : "days"}'`);
}

export function sqlCreatedAtSinceDays(days: number): SQL {
    const n = Math.max(0, Math.floor(days));
    if (Config.database.engine === "mariadb") {
        return sql.raw(`AND created_at >= NOW() - INTERVAL ${n} DAY`);
    }
    return sql.raw(
        `AND created_at >= NOW() - INTERVAL '${n} ${n === 1 ? "day" : "days"}'`,
    );
}
