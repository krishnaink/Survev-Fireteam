/**
 * SQL/Mongo dialect helpers for accounts DB.
 */
import { type SQL, sql } from "drizzle-orm";
import { Config } from "../../config.ts";

export function isPostgres(): boolean {
    return Config.database.engine === "postgres";
}

export function isMysql(): boolean {
    return Config.database.engine === "mariadb";
}

export function isMongo(): boolean {
    return Config.database.engine === "mongodb";
}

export function isSqlAccounts(): boolean {
    return Config.database.enabled
        && (Config.database.engine === "postgres" || Config.database.engine === "mariadb");
}

/** Extract player_icon from loadout JSON. */
export function sqlLoadoutPlayerIcon(loadoutColumn: unknown): SQL {
    if (isMysql()) {
        return sql`JSON_UNQUOTE(JSON_EXTRACT(ANY_VALUE(${loadoutColumn}), '$.player_icon'))`;
    }
    return sql`JSON_EXTRACT_PATH(ANY_VALUE(${loadoutColumn}), 'player_icon')`;
}

/** Aggregate teammate username/userId pairs for duo/squad most_kills. */
export function sqlMatchedUsersAgg(
    usernameCol: unknown,
    userIdCol: unknown,
): SQL {
    if (isMysql()) {
        return sql`JSON_ARRAYAGG(JSON_OBJECT('username', ${usernameCol}, 'userId', ${userIdCol}))`;
    }
    return sql`json_agg(json_build_object('username', ${usernameCol}, 'userId', ${userIdCol}))`;
}

/** Quote CTE / alias identifiers for the active SQL dialect. */
export function sqlIdent(name: string): SQL {
    if (isMysql()) {
        return sql.raw(`\`${name}\``);
    }
    return sql.raw(`"${name}"`);
}
