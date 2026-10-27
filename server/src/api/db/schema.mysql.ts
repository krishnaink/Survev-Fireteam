import {
    bigint,
    boolean,
    index,
    int,
    json,
    mysqlTable,
    primaryKey,
    serial,
    text,
    timestamp,
    uniqueIndex,
    varchar,
} from "drizzle-orm/mysql-core";
import { TeamMode } from "../../../../shared/gameConfig.ts";
import { ItemStatus, type Loadout, loadout } from "../../../../shared/utils/loadout.ts";

export const sessionTable = mysqlTable("session", {
    id: text("id").primaryKey(),
    userId: text("user_id")
        .notNull()
        .references(() => usersTable.id, {
            onDelete: "cascade",
            onUpdate: "cascade",
        }),
    expiresAt: timestamp("expires_at").notNull(),
});

export type SessionTableSelect = typeof sessionTable.$inferSelect;

export const usersTable = mysqlTable("users", {
    id: text("id").notNull().primaryKey(),
    authId: text("auth_id").notNull(),
    slug: text("slug").notNull().unique(),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason").notNull().default(""),
    bannedBy: text("banned_by").notNull().default(""),
    username: text("username").notNull().default(""),
    usernameSet: boolean("username_set").notNull().default(false),
    userCreated: timestamp("user_created", { fsp: 3 }).notNull().defaultNow(),
    lastUsernameChangeTime: timestamp("last_username_change_time"),
    linked: boolean("linked").notNull().default(false),
    linkedGoogle: boolean("linked_google").notNull().default(false),
    linkedDiscord: boolean("linked_discord").notNull().default(false),
    loadout: json("loadout")
        .notNull()
        .$type<Loadout>()
        .default(loadout.validate({} as Loadout)),
});

export type UsersTableInsert = typeof usersTable.$inferInsert;
export type UsersTableSelect = typeof usersTable.$inferSelect;

export const itemsTable = mysqlTable(
    "items",
    {
        userId: text("user_id")
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        type: text("type").notNull(),
        timeAcquired: bigint("time_acquired", { mode: "number" }).notNull(),
        source: text("source").notNull().default("unlock_new_account"),
        status: int("status").notNull().default(ItemStatus.New),
    },
    (table) => [uniqueIndex("uq_items_user_type").on(table.userId, table.type)],
);

export const userPassTable = mysqlTable(
    "user_pass",
    {
        userId: text("user_id")
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        passType: text("pass_type").notNull().default("pass_survivr1"),
        totalXp: int("total_xp").notNull().default(0),
        unlocks: json("unlocks").notNull().$type<Record<string, boolean>>().default({}),
        newItems: boolean("new_items").notNull().default(false),
        createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
    },
    (table) => [uniqueIndex("user_pass_user_type").on(table.userId, table.passType)],
);

export type UserPassTableSelect = typeof userPassTable.$inferSelect;

export const userQuestTable = mysqlTable(
    "user_quest",
    {
        id: serial("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        idx: int("idx").notNull(),
        questType: text("quest_type").notNull(),
        progress: int("progress").notNull().default(0),
        target: int("target").notNull(),
        complete: boolean("complete").notNull().default(false),
        rerolled: boolean("rerolled").notNull().default(false),
        timeAcquired: bigint("time_acquired", { mode: "number" }).notNull(),
        nextRefreshAt: bigint("next_refresh_at", { mode: "number" }).notNull(),
    },
    (table) => [uniqueIndex("user_quest_user_idx").on(table.userId, table.idx)],
);

export type UserQuestTableSelect = typeof userQuestTable.$inferSelect;

export const matchDataTable = mysqlTable(
    "match_data",
    {
        userId: text("user_id").default(""),
        userBanned: boolean("user_banned").default(false),
        createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
        region: text("region").notNull(),
        mapId: int("map_id").notNull(),
        gameId: varchar("game_id", { length: 36 }).notNull(),
        mapSeed: bigint("map_seed", { mode: "number" }).notNull(),
        username: text("username").notNull(),
        playerId: int("player_id").notNull(),
        teamMode: int("team_mode").$type<TeamMode>().notNull(),
        teamCount: int("team_count").notNull(),
        teamTotal: int("team_total").notNull(),
        teamId: int("team_id").notNull(),
        timeAlive: int("time_alive").notNull(),
        rank: int("rank").notNull(),
        died: boolean("died").notNull(),
        kills: int("kills").notNull(),
        downs: int("downs"),
        revives: int("revives"),
        teamKills: int("team_kills").notNull().default(0),
        damageDealt: int("damage_dealt").notNull(),
        damageTaken: int("damage_taken").notNull(),
        killerId: int("killer_id").notNull(),
        killedIds: json("killed_ids").$type<number[]>().notNull(),
        role: text("role").notNull().default(""),
        wavesSurvived: int("waves_survived").notNull().default(0),
        squadName: text("squad_name").notNull().default(""),
        gameVersion: text("game_version").notNull().default(""),
        difficulty: text("difficulty").notNull().default(""),
    },
    (table) => [
        index("idx_match_data_user_stats").on(
            table.userId,
            table.teamMode,
            table.rank,
            table.kills,
            table.damageDealt,
            table.timeAlive,
        ),
        index("idx_game_id").on(table.gameId),
        index("idx_user_id").on(table.userId),
        index("idx_match_data_team_query").on(
            table.teamMode,
            table.mapId,
            table.createdAt,
            table.gameId,
            table.teamId,
            table.region,
            table.kills,
        ),
        primaryKey({ columns: [table.gameId, table.playerId] }),
    ],
);

export type MatchDataTable = typeof matchDataTable.$inferInsert;

export const ipLogsTable = mysqlTable(
    "ip_logs",
    {
        id: serial("id").primaryKey(),
        createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
        region: text("region").notNull(),
        gameId: text("game_id").notNull(),
        mapId: int("map_id").notNull(),
        username: text("username").notNull(),
        userId: text("user_id").default(""),
        encodedIp: text("encoded_ip").notNull(),
        teamMode: int("team_mode").$type<TeamMode>().notNull().default(TeamMode.Solo),
        ip: text("ip").notNull(),
        findGameIp: text("find_game_ip").notNull(),
        findGameEncodedIp: text("find_game_encoded_ip").notNull(),
    },
    (table) => [index("name_created_at_idx").on(table.username, table.createdAt)],
);

export type IpLogsTable = typeof ipLogsTable.$inferSelect;

export const bannedIpsTable = mysqlTable("banned_ips", {
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    expiresIn: timestamp("expires_in").notNull(),
    encodedIp: text("encoded_ip").notNull().primaryKey(),
    permanent: boolean("permanent").notNull().default(false),
    reason: text("reason").notNull().default(""),
    bannedBy: text("banned_by").notNull().default("admin"),
});
