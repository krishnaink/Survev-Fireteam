# Zurvev

**Zurvev** is an open-source multiplayer top-down shooter for the browser. It expands the Survev engine with cooperative Fireteam survival, round-based Zombies, and a configurable bot Practice mode.

[Play Zurvev](https://52-162-233-43.sslip.io/)

- Fireteam release: **1.7** (final official release)
- Built on Survev **0.3.12**
- Discord: TBD


## Game modes

| Mode | Description |
|------|-------------|
| **Fireteam** | Fight escalating waves of enemy soldiers across outdoor maps. Revive teammates, purchase equipment, and compete for the highest round. |
| **Zombies** | Survive **Last Call**, an indoor map with unlockable rooms, wall weapons, perk machines, a mystery box, power-ups, and increasingly dangerous zombie waves. |
| **Practice** | Train against configurable bots with selectable maps, weapons, equipment, and combat settings. |

Fireteam and Zombies support solo and team play. Each mode has separate leaderboard records.


## Requirements

- [Bun](https://bun.sh) 1.1 or newer
- Optional database for accounts: PostgreSQL, MariaDB, or MongoDB
- Default leaderboards use SQLite at `data/specops-local.db` (no external DB required)

## Quick start (local)

```sh
bun run survev-setup
```

That installs dependencies and creates `survev-config.hjson` at the repo root.

Edit the config if you want different ports, squad size, difficulty, or database settings.

```sh
bun run dev
```

This starts four processes:

| Process | Role | Typical port |
|---------|------|--------------|
| wan-proxy | Public entry for LAN/WAN play | **3000** |
| api | Matchmaking, team lobby, site API | 8000 |
| game | Ping + match manager | 8001 |
| client | Vite (internal) | 3100 |

Open **http://127.0.0.1:3000** (or your machine IP on port 3000). Only forward **3000** if friends join over the internet in dev.

Do not point the Vite client at production hosts while developing. Dev mode keeps session and match joins on the local stack.

## Production (one machine)

```sh
bun run build
bun run start
```

`bun run start` reads `survev-config.hjson` and launches whatever you enabled:

- `api.enabled`
- `game.enabled`
- `client.enabled` (serves `client/dist` via the built-in web process)

For a public server, put **nginx** in front and only expose 80/443. See `HOSTING.md`.

## Config

Primary file: `survev-config.hjson` (repo root).

Examples:

- `survev-config.production.example.hjson` — live master (api + game + client)
- `survev-config.game-node.example.hjson` — child game node

Compact shape (see the example files for full fields):

```hjson
serverMode: "live"

api: { enabled: true, port: 8000 }
game: {
  enabled: true
  port: 8001
  firstMatch: 9000
  maxGames: 16
  id: "main"
  name: "Fireteam"
  url: "https://your.domain"
  address: "127.0.0.1:8001"
  mapName: "specops"
  maxSquadSize: 8
  modes: { solo: true, duo: true, squad: true }
}
client: { enabled: true, port: 3000 }

database: {
  engine: "sqlite"
  sqlite: { path: "data/specops-local.db" }
}

secrets: {
  SURVEV_API_KEY: "shared-long-secret"
  SURVEV_IP_SECRET: "shared-long-secret"
}
```

`SURVEV_API_KEY` must be identical on every master and game node (min 16 characters).

## Commands

| Command | Purpose |
|---------|---------|
| `bun run survev-setup` | Install + create config |
| `bun run dev` | Local playtest (proxy + api + game + vite) |
| `bun run build` | Build server and client |
| `bun run start` | Production from `survev-config.hjson` |
| `bun run lint` | Lint and format |

## Data and backups

- Live SQLite DB: `data/specops-local.db` (path configurable)
- Daily backups: `data/db-backups/` (kept 90 days; created by the API process)
- These paths are gitignored

## Docs

- `HOSTING.md` — VPS, nginx, systemd, master/child nodes
- `COMMIT_FORMAT.md` — commit messages
- `CODE_OF_CONDUCT.md` — community rules
- `client/public/changelogRec.html` — Fireteam patch notes
- `logs/client/README.md` — client error log folder

## License

GPL-3.0-or-later
