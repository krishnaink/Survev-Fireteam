import hjson from "hjson";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCommentedConfigHjson } from "./configTemplate.ts";
import type {
    CompactGameModes,
    ConfigType,
    DatabaseEngine,
    InstanceRole,
    PartialConfig,
    ServerMode,
} from "./configType.ts";
import { parseSpecOpsDifficulty } from "./shared/defs/maps/specOpsShop.ts";
import { HudTeammateSlots, TeamMode } from "./shared/gameConfig.ts";
import { util } from "./shared/utils/util.ts";

export const configFileName = "survev-config.hjson";

/** Set by getConfig(); absolute path to the loaded survev-config.hjson. */
export let loadedConfigPath = "";

export const MinSquadSize = 2;
export const MaxSquadSize = HudTeammateSlots;

export function clampMaxSquadSize(value: number): number {
    if (!Number.isFinite(value)) return 4;
    return Math.min(MaxSquadSize, Math.max(MinSquadSize, Math.round(value)));
}

/**
 * Parse a server endpoint from config: https://host, http://ip:port, or bare host:port.
 * Returns host[:port] without scheme/path, and https when the scheme implies it.
 */
export function parseServerEndpoint(raw: string): {
    hostPort: string;
    https?: boolean;
} {
    let s = String(raw ?? "").trim();
    if (!s) return { hostPort: "" };

    let https: boolean | undefined;
    if (/^wss:\/\//i.test(s)) {
        https = true;
        s = s.slice(6);
    } else if (/^ws:\/\//i.test(s)) {
        https = false;
        s = s.slice(5);
    } else if (/^https:\/\//i.test(s)) {
        https = true;
        s = s.slice(8);
    } else if (/^http:\/\//i.test(s)) {
        https = false;
        s = s.slice(7);
    }

    // Drop path / query (…/ptc, trailing slash, etc.)
    s = s.replace(/[?#].*$/, "");
    const slash = s.indexOf("/");
    if (slash >= 0) s = s.slice(0, slash);
    s = s.replace(/\/+$/, "");

    // Strip brackets noise for IPv6 but keep [::1]:port form usable as-is when valid.
    return { hostPort: s, https };
}

function titleCaseServerId(id: string): string {
    if (!id) return "Server";
    return id
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

/**
 * How many players a lobby/group of this mode can hold.
 * Solo always 1, Duo always 2, Squad uses `maxSquadSize` (2–8).
 */
export function teamSizeForMode(teamMode: TeamMode, maxSquadSize: number): number {
    if (teamMode <= TeamMode.Solo) return 1;
    if (teamMode === TeamMode.Duo) return 2;
    return clampMaxSquadSize(maxSquadSize);
}

/** Player cap for a match. Spec Ops uses squad size; BR maps use map default, optionally capped. */
export function maxPlayersForMap(
    specOpsMode: boolean,
    mapMaxPlayers: number,
    maxTeamSize: number,
    maxPlayersPerGame?: number,
): number {
    if (specOpsMode) return maxTeamSize;
    if (maxPlayersPerGame && maxPlayersPerGame > 0) {
        return Math.min(mapMaxPlayers, maxPlayersPerGame);
    }
    return mapMaxPlayers;
}

const DatabaseEngines = ["postgres", "sqlite", "mariadb", "mongodb"] as const;

const InstanceRoles = [
    "all",
    "api",
    "game",
    "frontend",
    "api+game",
    "api+frontend",
    "game+frontend",
] as const;

export function parseInstanceRole(value: unknown): InstanceRole {
    const key = String(value ?? "all").toLowerCase().trim();
    if ((InstanceRoles as readonly string[]).includes(key)) {
        return key as InstanceRole;
    }
    // Friendly aliases
    if (key === "both" || key === "api+game+frontend" || key === "full") return "all";
    if (key === "web" || key === "client") return "frontend";
    if (key === "gameserver" || key === "games") return "game";
    console.warn(`Unknown instanceRole '${value}', defaulting to 'all'`);
    return "all";
}

export function roleFromEnabled(
    api: boolean,
    game: boolean,
    client: boolean,
): InstanceRole {
    if (api && game && client) return "all";
    if (api && game) return "api+game";
    if (api && client) return "api+frontend";
    if (game && client) return "game+frontend";
    if (api) return "api";
    if (game) return "game";
    if (client) return "frontend";
    return "all";
}

export function enabledFromRole(role: InstanceRole): {
    api: boolean;
    game: boolean;
    client: boolean;
} {
    return {
        api: roleRunsApi(role),
        game: roleRunsGame(role),
        client: roleRunsFrontend(role),
    };
}

export function roleRunsApi(role: InstanceRole): boolean {
    return role === "all" || role === "api" || role === "api+game" || role === "api+frontend";
}

export function roleRunsGame(role: InstanceRole): boolean {
    return role === "all" || role === "game" || role === "api+game" || role === "game+frontend";
}

export function roleRunsFrontend(role: InstanceRole): boolean {
    return role === "all"
        || role === "frontend"
        || role === "api+frontend"
        || role === "game+frontend";
}

/** True when this host does not run the API and must point at a remote master. */
export function roleNeedsRemoteApiUrl(role: InstanceRole): boolean {
    return !roleRunsApi(role);
}

export function configRunsApi(config: ConfigType): boolean {
    return config.apiServer.enabled !== false;
}

export function configRunsGame(config: ConfigType): boolean {
    return config.gameServer.enabled !== false;
}

export function configRunsFrontend(config: ConfigType): boolean {
    return config.vite.enabled !== false;
}

function normalizeDatabaseEngine(value: unknown): DatabaseEngine {
    const engine = typeof value === "string" ? value.toLowerCase() : "postgres";
    if ((DatabaseEngines as readonly string[]).includes(engine)) {
        return engine as DatabaseEngine;
    }
    console.error(`engine '${value}' is not implemented yet`);
    throw new Error(`database.engine '${value}' is not implemented yet`);
}

function assertDatabaseEngine(config: ConfigType): void {
    const engine = config.database.engine;
    if (!config.database.enabled) return;
    if (engine === "postgres" || engine === "mariadb" || engine === "mongodb") return;
    const msg = engine === "sqlite"
        ? "database.engine 'sqlite' cannot host accounts/stats; set enabled: false for local leaderboard, or engine: postgres|mariadb|mongodb"
        : `database.engine '${engine}' is not supported`;
    console.error(msg);
    throw new Error(msg);
}

export function databasePoolConfig(database: ConfigType["database"]) {
    return {
        host: database.host,
        port: database.port,
        user: database.user,
        password: database.password,
        database: database.database,
    };
}

/** @deprecated use databasePoolConfig — kept for callers expecting postgres name */
export function postgresPoolConfig(database: ConfigType["database"]) {
    return databasePoolConfig(database);
}

export type CompactPorts = {
    client?: number;
    api?: number;
    game?: number;
    firstMatch?: number;
};

/** Compact hjson `api: { enabled, port, … }` → apiServer. */
type CompactApiSection = {
    enabled?: boolean;
    port?: number;
    host?: string;
    proxyIPHeader?: string;
    ssl?: ConfigType["apiServer"]["ssl"];
};

/** Compact hjson `game: { enabled, port, … }` → gameServer + related fields. */
type CompactGameSection = {
    enabled?: boolean;
    port?: number;
    host?: string;
    firstMatch?: number;
    firstGamePort?: number;
    maxGames?: number;
    /** Server id (handshake / dropdown). Alias of thisRegion. */
    id?: string;
    thisRegion?: string;
    /** Display name in the Server dropdown. */
    name?: string;
    /** Player-facing URL (https://host). */
    url?: string;
    /** Host:port the master API uses to reach this game manager. */
    address?: string;
    apiUrl?: string;
    apiServerUrl?: string;
    proxyIPHeader?: string;
    ssl?: ConfigType["gameServer"]["ssl"];
    /** Legacy multi-entry map — prefer flat id/name/url/address on this host. */
    regions?: ConfigType["regions"];
    mapName?: ConfigType["mapName"];
    difficulty?: ConfigType["difficulty"];
    endless?: boolean;
    contractsEnabled?: boolean;
    maxSquadSize?: number;
    maxPlayersPerGame?: number;
    modes?: ConfigType["modes"] | CompactGameModes;
    gameTps?: number;
    netSyncTps?: number;
};

/** Compact hjson `client: { enabled, port }` → vite. */
type CompactClientSection = {
    enabled?: boolean;
    port?: number;
    host?: string;
};

type SqlEngineBlock = {
    host?: string;
    port?: number;
    name?: string;
    database?: string;
    user?: string;
    password?: string;
};

type CompactDatabase = {
    enabled?: boolean;
    engine?: DatabaseEngine | string;
    // Legacy flat fields
    host?: string;
    port?: number;
    name?: string;
    database?: string;
    user?: string;
    password?: string;
    sqlitePath?: string;
    uri?: string;
    // Per-engine blocks (preferred)
    sqlite?: { path?: string; sqlitePath?: string };
    postgres?: SqlEngineBlock;
    mariadb?: SqlEngineBlock;
    mongodb?: SqlEngineBlock & { uri?: string };
};

type RawLocalConfig = PartialConfig & {
    serverMode?: ServerMode;
    /** Legacy alias for api+game+client enabled combo */
    role?: InstanceRole | string;
    instanceRole?: InstanceRole | string;
    /** Alias for apiUrl / gameServer.apiServerUrl */
    apiUrl?: string;
    apiPublicUrl?: string;
    /** Applied to both apiServer and gameServer when unset on those blocks. */
    proxyIPHeader?: string;
    ports?: CompactPorts;
    maxGames?: number;
    maxSessions?: number;
    thisRegion?: string;
    modes?: ConfigType["modes"] | CompactGameModes;
    database?: CompactDatabase;
    /** Preferred: api: { enabled: true/false, port, … } */
    api?: CompactApiSection;
    /** Preferred: game: { enabled: true/false, … } */
    game?: CompactGameSection;
    /** Preferred: client: { enabled: true/false, port } */
    client?: CompactClientSection;
    web?: CompactClientSection;
    frontend?: CompactClientSection;
};

export function isCompactGameModes(modes: unknown): modes is CompactGameModes {
    return !!modes && typeof modes === "object" && !Array.isArray(modes);
}

/** Expand `modes: { solo, duo, squad }` to the runtime array. Arrays pass through. */
export function expandGameModes(
    modes: ConfigType["modes"] | CompactGameModes | undefined,
    mapName: ConfigType["modes"][number]["mapName"] = "specops",
): ConfigType["modes"] | undefined {
    if (modes === undefined) return undefined;
    if (Array.isArray(modes)) return modes as ConfigType["modes"];
    return [
        { mapName, teamMode: TeamMode.Solo, enabled: modes.solo ?? true },
        { mapName, teamMode: TeamMode.Duo, enabled: modes.duo ?? true },
        { mapName, teamMode: TeamMode.Squad, enabled: modes.squad ?? true },
    ];
}

function applyServiceSections(local: RawLocalConfig): void {
    // api: { enabled, port, … } → apiServer
    if (local.api) {
        const { enabled, port, host, proxyIPHeader, ssl } = local.api;
        local.apiServer ??= {};
        if (enabled !== undefined) local.apiServer.enabled = enabled;
        if (port != null) local.apiServer.port = port;
        if (host != null) local.apiServer.host = host;
        if (proxyIPHeader != null) local.apiServer.proxyIPHeader = proxyIPHeader;
        if (ssl != null) local.apiServer.ssl = ssl;
        delete local.api;
    }

    // game: { enabled, id, name, url, address, … } → gameServer + regions[id]
    if (local.game) {
        const g = local.game;
        local.gameServer ??= {};
        if (g.enabled !== undefined) local.gameServer.enabled = g.enabled;
        if (g.port != null) local.gameServer.port = g.port;
        if (g.host != null) local.gameServer.host = g.host;
        if (g.firstMatch != null) local.gameServer.firstGamePort = g.firstMatch;
        if (g.firstGamePort != null) local.gameServer.firstGamePort = g.firstGamePort;
        if (g.maxGames != null) local.gameServer.maxGames = g.maxGames;
        if (g.proxyIPHeader != null) local.gameServer.proxyIPHeader = g.proxyIPHeader;
        if (g.ssl != null) local.gameServer.ssl = g.ssl;

        const gameApiUrl = (g.apiUrl || g.apiServerUrl || "").trim();
        if (gameApiUrl) {
            local.apiUrl ??= gameApiUrl;
            local.gameServer.apiServerUrl ??= gameApiUrl;
        }

        // One server per config file: flat id/name/url/address (preferred).
        // Legacy `regions: { … }` still works if present.
        if (g.regions && !local.regions) local.regions = { ...g.regions };

        const id = (g.id || g.thisRegion || local.thisRegion || "").trim();
        if (id) {
            local.gameServer.thisRegion = id;
            local.thisRegion = id;
        }

        const hasFlatIdentity = !!(g.name || g.url || g.address || id);
        if (hasFlatIdentity) {
            const regionId = id
                || Object.keys(local.regions ?? {})[0]
                || "main";
            local.gameServer.thisRegion ??= regionId;
            local.thisRegion ??= regionId;
            local.regions ??= {};
            const prev = local.regions[regionId] ?? {};
            local.regions[regionId] = {
                ...prev,
                https: prev.https ?? false,
                address: (g.address ?? prev.address ?? "").trim()
                    || `127.0.0.1:${g.port ?? local.gameServer.port ?? 8001}`,
                ...(g.name != null ? { name: g.name } : {}),
                ...(g.url != null ? { url: g.url } : {}),
                ...(prev.publicAddress ? { publicAddress: prev.publicAddress } : {}),
                ...(prev.l10n ? { l10n: prev.l10n } : {}),
            };
        }

        if (g.mapName != null && local.mapName == null) local.mapName = g.mapName;
        if (g.difficulty != null && local.difficulty == null) {
            local.difficulty = g.difficulty;
        }
        if (g.endless != null && local.endless == null) local.endless = g.endless;
        if (g.contractsEnabled != null && local.contractsEnabled == null) {
            local.contractsEnabled = g.contractsEnabled;
        }
        if (g.maxSquadSize != null && local.maxSquadSize == null) {
            local.maxSquadSize = g.maxSquadSize;
        }
        if (g.maxPlayersPerGame != null && local.maxPlayersPerGame == null) {
            local.maxPlayersPerGame = g.maxPlayersPerGame;
        }
        if (g.modes != null && local.modes == null) {
            local.modes = g.modes as ConfigType["modes"];
        }
        if (g.gameTps != null && local.gameTps == null) local.gameTps = g.gameTps;
        if (g.netSyncTps != null && local.netSyncTps == null) {
            local.netSyncTps = g.netSyncTps;
        }
        if (g.maxGames != null && local.maxGames == null) local.maxGames = g.maxGames;
        delete local.game;
    }

    // client / web / frontend → vite
    const client = local.client ?? local.web ?? local.frontend;
    if (client) {
        local.vite ??= {};
        if (client.enabled !== undefined) local.vite.enabled = client.enabled;
        if (client.port != null) local.vite.port = client.port;
        if (client.host != null) local.vite.host = client.host;
        delete local.client;
        delete local.web;
        delete local.frontend;
    }
}

function applyCompactPorts(local: RawLocalConfig): void {
    const ports = local.ports;
    if (!ports) return;
    if (ports.client != null && local.vite?.port == null) {
        local.vite ??= {};
        local.vite.port = ports.client;
    }
    if (ports.api != null && local.apiServer?.port == null) {
        local.apiServer ??= {};
        local.apiServer.port = ports.api;
    }
    if (ports.game != null && local.gameServer?.port == null) {
        local.gameServer ??= {};
        local.gameServer.port = ports.game;
    }
    if (ports.firstMatch != null && local.gameServer?.firstGamePort == null) {
        local.gameServer ??= {};
        local.gameServer.firstGamePort = ports.firstMatch;
    }
    delete local.ports;
}

function applyCompactBind(local: RawLocalConfig): void {
    if (local.bind == null) return;
    if (local.apiServer?.host == null) {
        local.apiServer ??= {};
        local.apiServer.host = local.bind;
    }
    if (local.gameServer?.host == null) {
        local.gameServer ??= {};
        local.gameServer.host = local.bind;
    }
    if (local.vite?.host == null) {
        local.vite ??= {};
        local.vite.host = local.bind;
    }
}

function applyCompactCaps(local: RawLocalConfig): void {
    const maxGames = local.maxGames ?? local.maxSessions;
    if (maxGames != null) {
        local.gameServer ??= {};
        if (local.gameServer.maxGames == null) {
            local.gameServer.maxGames = maxGames;
        }
    }
    if (local.thisRegion != null) {
        local.gameServer ??= {};
        if (local.gameServer.thisRegion == null) {
            local.gameServer.thisRegion = local.thisRegion;
        }
    }
    // role / instanceRole
    const roleRaw = local.instanceRole ?? local.role;
    if (roleRaw != null) {
        local.instanceRole = parseInstanceRole(roleRaw);
    }
    delete local.role;

    // Top-level apiUrl → gameServer.apiServerUrl + config.apiUrl
    const apiUrl = local.apiUrl?.trim() || local.gameServer?.apiServerUrl?.trim();
    if (apiUrl) {
        local.apiUrl = apiUrl;
        local.gameServer ??= {};
        if (!local.gameServer.apiServerUrl) {
            local.gameServer.apiServerUrl = apiUrl;
        }
    }

    // One proxy header for both processes (nginx / Cloudflare)
    const proxyHeader = local.proxyIPHeader?.trim();
    if (proxyHeader) {
        local.apiServer ??= {};
        local.gameServer ??= {};
        local.apiServer.proxyIPHeader ??= proxyHeader;
        local.gameServer.proxyIPHeader ??= proxyHeader;
        delete local.proxyIPHeader;
    }

    delete local.maxGames;
    delete local.maxSessions;
    delete local.thisRegion;
}

function applyCompactDatabase(local: RawLocalConfig): void {
    const db = local.database as CompactDatabase | undefined;
    if (!db) return;

    const hasNested = !!(db.sqlite || db.postgres || db.mariadb || db.mongodb);
    if (hasNested) {
        const engine = normalizeDatabaseEngine(db.engine ?? "sqlite");
        db.engine = engine;

        // Accounts/stats only for remote engines; sqlite = local leaderboard.
        if (db.enabled === undefined) {
            db.enabled = engine !== "sqlite";
        }

        const sqlitePath = db.sqlite?.path || db.sqlite?.sqlitePath || db.sqlitePath
            || "data/specops-local.db";
        db.sqlitePath = sqlitePath;

        if (engine === "sqlite") {
            db.host ??= "127.0.0.1";
            db.port ??= 0;
            db.user ??= "";
            db.password ??= "";
            db.database ??= "survev";
        } else if (engine === "postgres") {
            const b = db.postgres ?? {};
            db.host = b.host ?? db.host ?? "127.0.0.1";
            db.port = b.port ?? db.port ?? 5432;
            db.user = b.user ?? db.user ?? "survev";
            db.password = b.password ?? db.password ?? "survev";
            db.database = b.name ?? b.database ?? db.name ?? db.database ?? "survev";
        } else if (engine === "mariadb") {
            const b = db.mariadb ?? {};
            db.host = b.host ?? db.host ?? "127.0.0.1";
            db.port = b.port ?? db.port ?? 3306;
            db.user = b.user ?? db.user ?? "survev";
            db.password = b.password ?? db.password ?? "survev";
            db.database = b.name ?? b.database ?? db.name ?? db.database ?? "survev";
        } else if (engine === "mongodb") {
            const b = db.mongodb ?? {};
            db.host = b.host ?? db.host ?? "127.0.0.1";
            db.port = b.port ?? db.port ?? 27017;
            db.user = b.user ?? db.user ?? "";
            db.password = b.password ?? db.password ?? "";
            db.database = b.name ?? b.database ?? db.name ?? db.database ?? "survev";
            if (b.uri) db.uri = b.uri;
        }

        delete db.sqlite;
        delete db.postgres;
        delete db.mariadb;
        delete db.mongodb;
    }

    if (db.name != null && db.database == null) {
        db.database = db.name;
    }
    delete (db as { name?: string }).name;
}

function applyCompactAliases(local: RawLocalConfig): void {
    applyServiceSections(local);
    applyCompactPorts(local);
    applyCompactBind(local);
    applyCompactCaps(local);
    applyCompactDatabase(local);
    const mapName = local.mapName ?? "specops";
    if (isCompactGameModes(local.modes)) {
        local.modes = expandGameModes(local.modes, mapName);
    } else if (local.mapName && !local.modes) {
        local.modes = expandGameModes({ solo: true, duo: true, squad: true }, mapName);
    }
}

/** Bind-all hosts can't be used as connect targets. */
function connectHost(host: string): string {
    if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
    return host;
}

/** Prefer a real LAN/WAN NIC so remote clients get a reachable game address. */
function advertiseHost(fromConfig?: string): string {
    const fromEnv = process.env.SURVEV_ADVERTISE_HOST?.trim();
    if (fromEnv) return fromEnv;
    const fromFile = fromConfig?.trim();
    if (fromFile) return fromFile;

    const nets = os.networkInterfaces();
    const preferred: string[] = [];
    const others: string[] = [];
    // Keep Hyper-V "vEthernet (Realtek…)" — that is often the real LAN IP on Windows.
    const skipName = /vmware|vbox|virtualbox|docker|wsl|loopback|bluetooth|host-only|default switch/i;
    const hostOnlyLan = /^192\.168\.(56|57|58|59|142|154)\./;

    for (const [name, addrs] of Object.entries(nets)) {
        if (!addrs || skipName.test(name)) continue;
        for (const net of addrs) {
            const family = String(net.family);
            if (family !== "IPv4" && family !== "4") continue;
            if (net.internal) continue;
            if (net.address.startsWith("169.254.")) continue;
            if (hostOnlyLan.test(net.address)) continue;
            const lan = net.address.startsWith("192.168.")
                || net.address.startsWith("10.")
                || /^172\.(1[6-9]|2\d|3[01])\./.test(net.address);
            (lan ? preferred : others).push(net.address);
        }
    }

    return preferred[0] ?? others[0] ?? "127.0.0.1";
}

/** Directory containing survev-config.hjson (absolute path or "" = repo root module dir). */
export function resolveConfigDirectory(dir: string): string {
    const moduleDir = import.meta.dirname;
    const candidates: string[] = [];

    const fromEnv = process.env.SURVEV_CONFIG_DIR?.trim();
    if (fromEnv) candidates.push(fromEnv);

    if (dir) {
        candidates.push(path.isAbsolute(dir) ? dir : path.resolve(moduleDir, dir));
    } else {
        candidates.push(moduleDir);
    }

    candidates.push(process.cwd());

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (fs.existsSync(path.join(candidate, configFileName))) return candidate;
    }
    return candidates[0]!;
}

export function getConfig(isProduction: boolean, dir: string) {
    const isDev = !isProduction;

    const config: ConfigType = {
        serverMode: isProduction ? "live" : "dev",
        instanceRole: "all",
        bind: "0.0.0.0",
        apiServer: {
            enabled: true,
            host: "0.0.0.0",
            port: 8000,
        },
        gameServer: {
            enabled: true,
            host: "0.0.0.0",
            port: 8001,
            apiServerUrl: "",
            thisRegion: "local",
            firstGamePort: 9000,
            maxGames: 64,
        },
        vite: {
            enabled: true,
            // Listen on all interfaces so LAN/WAN clients can open the site.
            host: "0.0.0.0",
            port: 3000,
        },
        regions: {},
        proxies: {},
        modes: [
            { mapName: "specops", teamMode: TeamMode.Solo, enabled: true },
            { mapName: "specops", teamMode: TeamMode.Duo, enabled: true },
            { mapName: "specops", teamMode: TeamMode.Squad, enabled: true },
        ],
        mapName: "specops",
        clientTheme: "main",
        passType: "pass_survivr1",
        maxSquadSize: 4,
        difficulty: "regular",
        endless: false,
        contractsEnabled: true,
        gameTps: 100,
        netSyncTps: 33,
        logging: {
            logDate: true,
            infoLogs: true,
            debugLogs: isDev,
            warnLogs: true,
            errorLogs: true,
            clientLogs: true,
            clientLogDir: "logs/client",
        },
        database: {
            enabled: false,
            engine: "sqlite",
            host: "127.0.0.1",
            user: "survev",
            password: "survev",
            database: "survev",
            port: 5432,
            sqlitePath: "data/specops-local.db",
        },
        oauthRedirectURI: "",
        oauthBasePath: "/",
        secrets: {
            SURVEV_API_KEY: "",
            SURVEV_IP_SECRET: "",
        },
        captchaEnabled: false,
        cachingEnabled: false,
        rateLimitsEnabled: isProduction,
        uniqueInGameNames: true,
        debug: {
            enabled: isDev,
            spawnMode: "default",
            allowBots: isDev,
            allowEditMsg: isDev,
            allowMockAccount: isDev,
            allowNpcSpawn: false,
        },
        defaultItems: {},
    };

    const configDir = resolveConfigDirectory(dir);
    const configPath = path.join(configDir, configFileName);
    loadedConfigPath = configPath;

    let localConfig: RawLocalConfig = {};

    if (fs.existsSync(configPath)) {
        console.log(`Sourcing config ${configPath}`);
        const configText = fs.readFileSync(configPath).toString();
        localConfig = hjson.parse(configText) as RawLocalConfig;
    } else {
        console.log("Config file doesn't exist... creating");
        localConfig = {
            serverMode: isProduction ? "live" : "dev",
            // always specify default random keys..
            secrets: {
                SURVEV_API_KEY: randomBytes(64).toString("base64"),
                SURVEV_IP_SECRET: randomBytes(32).toString("base64"),
            },
        };

        fs.writeFileSync(
            configPath,
            buildCommentedConfigHjson(localConfig, { forProduction: isProduction }),
        );
    }

    applyCompactAliases(localConfig);

    const hostOverridden = {
        api: localConfig.apiServer?.host !== undefined,
        game: localConfig.gameServer?.host !== undefined,
        vite: localConfig.vite?.host !== undefined,
    };

    util.mergeDeep(config, localConfig);

    // Prefer explicit api/game/client.enabled; else legacy role; else all on.
    if (
        localConfig.apiServer?.enabled !== undefined
        || localConfig.gameServer?.enabled !== undefined
        || localConfig.vite?.enabled !== undefined
    ) {
        const apiOn = localConfig.apiServer?.enabled ?? true;
        const gameOn = localConfig.gameServer?.enabled ?? true;
        const clientOn = localConfig.vite?.enabled ?? true;
        config.apiServer.enabled = apiOn;
        config.gameServer.enabled = gameOn;
        config.vite.enabled = clientOn;
        config.instanceRole = roleFromEnabled(apiOn, gameOn, clientOn);
    } else {
        config.instanceRole = parseInstanceRole(
            localConfig.instanceRole ?? localConfig.role ?? config.instanceRole,
        );
        const flags = enabledFromRole(config.instanceRole);
        config.apiServer.enabled = flags.api;
        config.gameServer.enabled = flags.game;
        config.vite.enabled = flags.client;
    }

    // Ensure booleans even if merge left undefined
    config.apiServer.enabled = config.apiServer.enabled !== false;
    config.gameServer.enabled = config.gameServer.enabled !== false;
    config.vite.enabled = config.vite.enabled !== false;

    const configuredApiUrl = (localConfig.apiUrl || config.apiUrl || "").trim()
        || (localConfig.gameServer?.apiServerUrl || "").trim();
    if (configuredApiUrl) {
        config.apiUrl = configuredApiUrl;
        config.gameServer.apiServerUrl = configuredApiUrl;
    }
    if (localConfig.apiPublicUrl != null) {
        config.apiPublicUrl = String(localConfig.apiPublicUrl).trim() || undefined;
    }

    const isLive = config.serverMode === "live";
    if (isLive) {
        // Live defaults debug off, but an explicit debug.enabled: true in the
        // config file wins (used for staging / bot-arena debugging on prod hosts).
        if (localConfig.debug?.enabled !== true) {
            config.debug.enabled = false;
        }
        if (localConfig.rateLimitsEnabled === undefined) config.rateLimitsEnabled = true;
        if (!hostOverridden.api) config.apiServer.host = "127.0.0.1";
        if (!hostOverridden.game) config.gameServer.host = "127.0.0.1";
        if (!hostOverridden.vite) config.vite.host = "127.0.0.1";
    } else {
        if (localConfig.debug?.enabled === undefined) config.debug.enabled = true;
        if (localConfig.rateLimitsEnabled === undefined) config.rateLimitsEnabled = false;
        if (!hostOverridden.api) config.apiServer.host = "0.0.0.0";
        if (!hostOverridden.game) config.gameServer.host = "0.0.0.0";
        if (!hostOverridden.vite) config.vite.host = "0.0.0.0";
    }

    if (config.debug.enabled) {
        if (localConfig.debug?.allowBots === undefined) config.debug.allowBots = true;
        if (localConfig.debug?.allowEditMsg === undefined) {
            config.debug.allowEditMsg = true;
        }
        if (localConfig.debug?.allowMockAccount === undefined) {
            config.debug.allowMockAccount = true;
        }
        // allowNpcSpawn stays as configured (default false) unless explicitly set
    }

    config.bind = localConfig.bind ?? config.apiServer.host;
    config.database.engine = normalizeDatabaseEngine(config.database.engine);
    if (!config.database.sqlitePath) {
        config.database.sqlitePath = "data/specops-local.db";
    }
    if (config.database.engine === "sqlite") {
        config.database.enabled = false;
    } else if (localConfig.database?.enabled === undefined) {
        config.database.enabled = true;
    }

    config.maxSquadSize = clampMaxSquadSize(config.maxSquadSize);
    config.difficulty = parseSpecOpsDifficulty(config.difficulty);
    config.endless = !!config.endless;
    config.contractsEnabled = config.contractsEnabled !== false;

    if (config.debug.enabled === false) {
        config.debug.allowBots = false;
        config.debug.allowEditMsg = false;
        config.debug.allowMockAccount = false;
        config.debug.allowNpcSpawn = false;
    } else {
        config.debug.allowBots = !!config.debug.allowBots;
        config.debug.allowEditMsg = !!config.debug.allowEditMsg;
        config.debug.allowMockAccount = !!config.debug.allowMockAccount;
        config.debug.allowNpcSpawn = !!config.debug.allowNpcSpawn;
    }

    const viteConnect = connectHost(config.vite.host);
    const apiConnect = connectHost(config.apiServer.host);
    const publicHost = advertiseHost(config.advertiseHost);

    if (!config.oauthRedirectURI) {
        // apply this default after merging the local config
        // so if the local config changes the vite host and port it will still be right
        config.oauthRedirectURI = `http://${viteConnect}:${config.vite.port}`;
    }
    const baseUrl = new URL(config.oauthRedirectURI);

    if (!config.gameServer.apiServerUrl) {
        if (roleNeedsRemoteApiUrl(config.instanceRole)) {
            const msg = `game.enabled without api.enabled requires game.apiUrl `
                + `(or apiUrl) pointing at your master API host`;
            console.error(msg);
            throw new Error(msg);
        }
        // Local default when this host also runs (or colocates with) the API.
        config.gameServer.apiServerUrl = `http://${apiConnect}:${config.apiServer.port}`;
    }
    config.apiUrl ??= config.gameServer.apiServerUrl;

    // Normalize server (region) endpoints: `url` / protocols → https + publicAddress + address.
    for (const [id, region] of Object.entries(config.regions)) {
        if (!region) continue;

        if (region.url?.trim()) {
            const parsed = parseServerEndpoint(region.url);
            region.publicAddress = parsed.hostPort;
            if (parsed.https !== undefined) region.https = parsed.https;
        }

        if (region.publicAddress?.trim()) {
            const parsed = parseServerEndpoint(region.publicAddress);
            region.publicAddress = parsed.hostPort;
            // Only infer https from publicAddress when url didn't already set it
            // and the string included an explicit scheme.
            if (parsed.https !== undefined && !region.url?.trim()) {
                region.https = parsed.https;
            }
        }

        if (region.address?.trim()) {
            // API → game is always plain HTTP; strip any scheme the admin pasted.
            region.address = parseServerEndpoint(region.address).hostPort;
        } else {
            region.address = `127.0.0.1:${config.gameServer.port}`;
        }

        if (typeof region.https !== "boolean") {
            region.https = false;
        }

        const named = region.name?.trim();
        region.name = named || titleCaseServerId(id);
        if (!region.l10n) region.l10n = `index-${id}`;
    }

    const googleLogin = !!(
        config.secrets.GOOGLE_CLIENT_ID && config.secrets.GOOGLE_SECRET_ID
    );
    const discordLogin = !!(
        config.secrets.DISCORD_CLIENT_ID && config.secrets.DISCORD_SECRET_ID
    );

    config.proxies[baseUrl.hostname] = {
        google: googleLogin,
        discord: discordLogin,
        mock: config.debug.allowMockAccount,
        ...config.proxies[baseUrl.hostname],
    };

    if (isDev) {
        // API talks to the game server over loopback; clients get a LAN/WAN host.
        // Override with SURVEV_ADVERTISE_HOST or regions.local.publicAddress in hjson.
        config.regions.local ??= {
            https: false,
            name: "Local",
            address: `127.0.0.1:${config.gameServer.port}`,
            publicAddress: `${publicHost}:${config.gameServer.port}`,
            l10n: "index-local",
        };
        config.regions.local.name ??= "Local";
        config.regions.local.publicAddress ??= `${publicHost}:${config.gameServer.port}`;
        // API → game manager is always on-machine; never use LAN/WAN address here.
        config.regions.local.address = `127.0.0.1:${config.gameServer.port}`;
        // Vite proxies game WS at /g/<port>/play and sets X-Real-IP.
        config.apiServer.proxyIPHeader ??= "X-Real-IP";
        config.gameServer.proxyIPHeader ??= "X-Real-IP";
        // Postgres is often unset in local LAN play — don't block joins on DB errors.
        if (localConfig.database?.enabled === undefined) {
            config.database.enabled = false;
        }
    }

    assertDatabaseEngine(config);

    const apiKey = config.secrets.SURVEV_API_KEY?.trim() ?? "";
    if (apiKey.length < 16) {
        throw new Error(
            "secrets.SURVEV_API_KEY is missing or shorter than 16 characters. "
                + "Every API and game host must share the same key — without it, "
                + "remote servers cannot handshake with the main host.",
        );
    }
    config.secrets.SURVEV_API_KEY = apiKey;

    // Bot arena / test maps stay opt-in via the team map dropdown (and explicit
    // mapName), not by silently rewriting every Spec Ops mode.

    const services = [
        configRunsApi(config) ? "api" : null,
        configRunsGame(config) ? "game" : null,
        configRunsFrontend(config) ? "client" : null,
    ].filter(Boolean).join("+");
    console.log(
        `Services: ${services || "none"}`
            + (roleNeedsRemoteApiUrl(config.instanceRole)
                ? ` (API at ${config.gameServer.apiServerUrl})`
                : ""),
    );

    return config;
}

export function saveConfig(dir: string, config: PartialConfig) {
    try {
        const configDir = resolveConfigDirectory(dir);
        const configPath = path.join(configDir, configFileName);

        const configText = fs.readFileSync(configPath).toString();
        const localConfig = hjson.parse(configText) as RawLocalConfig;
        applyCompactAliases(localConfig);

        const finalConfig = util.mergeDeep({}, localConfig, config);

        const isProduction = process.env["NODE_ENV"] === "production";
        fs.writeFileSync(
            configPath,
            buildCommentedConfigHjson(finalConfig, { forProduction: isProduction }),
        );
        console.log("Saved config file");
    } catch (err) {
        console.error("Failed saving config", err);
    }
}
