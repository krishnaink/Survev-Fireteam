import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import pg from "pg";
import { Config } from "../../config.ts";

function pgIdent(id: string) {
    return `"${String(id).replace(/"/g, "\"\"")}"`;
}

const engine = Config.database.engine;
const dbName = Config.database.database;

if (engine === "postgres") {
    const pool = new pg.Pool({
        host: Config.database.host,
        port: Config.database.port,
        user: "postgres",
        password: "postgres",
        database: "postgres",
    });

    try {
        await pool.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
            [dbName],
        );
        await pool.query(`DROP DATABASE IF EXISTS ${pgIdent(dbName)}`);
        await pool.query(
            `CREATE DATABASE ${pgIdent(dbName)} OWNER ${pgIdent(Config.database.user)}`,
        );
        console.log("PostgreSQL database wiped successfully");
    } catch (error) {
        console.error("Error wiping PostgreSQL database:", error);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
} else if (engine === "mariadb") {
    const conn = await mysql.createConnection({
        host: Config.database.host,
        port: Config.database.port || 3306,
        user: Config.database.user,
        password: Config.database.password,
    });
    try {
        const safe = dbName.replace(/`/g, "");
        await conn.query(`DROP DATABASE IF EXISTS \`${safe}\``);
        await conn.query(
            `CREATE DATABASE \`${safe}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        );
        console.log("MariaDB database wiped successfully");
    } catch (error) {
        console.error("Error wiping MariaDB database:", error);
        process.exitCode = 1;
    } finally {
        await conn.end();
    }
} else if (engine === "mongodb") {
    const uri = Config.database.uri?.trim()
        || `mongodb://${Config.database.host}:${Config.database.port || 27017}`;
    const client = new MongoClient(uri);
    try {
        await client.connect();
        await client.db(dbName).dropDatabase();
        console.log("MongoDB database wiped successfully");
    } catch (error) {
        console.error("Error wiping MongoDB database:", error);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
} else {
    console.error(`db:wipe does not support engine '${engine}'`);
    process.exitCode = 1;
}
