/**
 * Bootstrap MariaDB schema when drizzle migrations have not been applied yet.
 */
import type { Pool } from "mysql2/promise";

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT NOT NULL PRIMARY KEY,
  auth_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  banned BOOLEAN NOT NULL DEFAULT false,
  ban_reason TEXT NOT NULL DEFAULT '',
  banned_by TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  username_set BOOLEAN NOT NULL DEFAULT false,
  user_created TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_username_change_time TIMESTAMP NULL,
  linked BOOLEAN NOT NULL DEFAULT false,
  linked_google BOOLEAN NOT NULL DEFAULT false,
  linked_discord BOOLEAN NOT NULL DEFAULT false,
  loadout JSON NOT NULL,
  UNIQUE KEY users_slug_unique (slug(191))
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  CONSTRAINT session_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS items (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  time_acquired BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unlock_new_account',
  status INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_items_user_type (user_id(64), type(64)),
  CONSTRAINT items_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS user_pass (
  user_id TEXT NOT NULL,
  pass_type TEXT NOT NULL DEFAULT 'pass_survivr1',
  total_xp INT NOT NULL DEFAULT 0,
  unlocks JSON NOT NULL,
  new_items BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY user_pass_user_type (user_id(64), pass_type(64)),
  CONSTRAINT user_pass_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS user_quest (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idx INT NOT NULL,
  quest_type TEXT NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  target INT NOT NULL,
  complete BOOLEAN NOT NULL DEFAULT false,
  rerolled BOOLEAN NOT NULL DEFAULT false,
  time_acquired BIGINT NOT NULL,
  next_refresh_at BIGINT NOT NULL,
  UNIQUE KEY user_quest_user_idx (user_id(64), idx),
  CONSTRAINT user_quest_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS match_data (
  user_id TEXT DEFAULT '',
  user_banned BOOLEAN DEFAULT false,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  region TEXT NOT NULL,
  map_id INT NOT NULL,
  game_id VARCHAR(36) NOT NULL,
  map_seed BIGINT NOT NULL,
  username TEXT NOT NULL,
  player_id INT NOT NULL,
  team_mode INT NOT NULL,
  team_count INT NOT NULL,
  team_total INT NOT NULL,
  team_id INT NOT NULL,
  time_alive INT NOT NULL,
  \`rank\` INT NOT NULL,
  died BOOLEAN NOT NULL,
  kills INT NOT NULL,
  downs INT NULL,
  revives INT NULL,
  team_kills INT NOT NULL DEFAULT 0,
  damage_dealt INT NOT NULL,
  damage_taken INT NOT NULL,
  killer_id INT NOT NULL,
  killed_ids JSON NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  waves_survived INT NOT NULL DEFAULT 0,
  squad_name TEXT NOT NULL DEFAULT '',
  game_version TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (game_id, player_id),
  KEY idx_game_id (game_id),
  KEY idx_user_id (user_id(64))
);

CREATE TABLE IF NOT EXISTS ip_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  region TEXT NOT NULL,
  game_id TEXT NOT NULL,
  map_id INT NOT NULL,
  username TEXT NOT NULL,
  user_id TEXT DEFAULT '',
  encoded_ip TEXT NOT NULL,
  team_mode INT NOT NULL DEFAULT 1,
  ip TEXT NOT NULL,
  find_game_ip TEXT NOT NULL,
  find_game_encoded_ip TEXT NOT NULL,
  KEY name_created_at_idx (username(64), created_at)
);

CREATE TABLE IF NOT EXISTS banned_ips (
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_in TIMESTAMP NOT NULL,
  encoded_ip TEXT NOT NULL PRIMARY KEY,
  permanent BOOLEAN NOT NULL DEFAULT false,
  reason TEXT NOT NULL DEFAULT '',
  banned_by TEXT NOT NULL DEFAULT 'admin'
);
`;

export async function ensureMysqlSchema(pool: Pool) {
    const statements = BOOTSTRAP_SQL.split(";")
        .map((s) => s.trim())
        .filter(Boolean);
    const conn = await pool.getConnection();
    try {
        // Nullable columns preserve unknown stats on existing runs.
        statements.push(
            "ALTER TABLE match_data ADD COLUMN IF NOT EXISTS downs INT NULL",
            "ALTER TABLE match_data ADD COLUMN IF NOT EXISTS revives INT NULL",
        );
        for (const statement of statements) {
            await conn.query(statement);
        }
    } finally {
        conn.release();
    }
}
