import type { CompactGameModes, InstanceRole, PartialConfig, ServerMode } from "./configType.ts";
import { TeamMode } from "./shared/gameConfig.ts";

function q(value: string): string {
    return JSON.stringify(value);
}

function bool(value: boolean | undefined, fallback: boolean): string {
    return String(value ?? fallback);
}

function num(value: number | undefined, fallback: number): string {
    return String(value ?? fallback);
}

function parseRole(value: unknown): InstanceRole {
    const key = String(value ?? "all").toLowerCase().trim();
    const known: InstanceRole[] = [
        "all",
        "api",
        "game",
        "frontend",
        "api+game",
        "api+frontend",
        "game+frontend",
    ];
    if ((known as string[]).includes(key)) return key as InstanceRole;
    if (key === "both" || key === "full") return "all";
    if (key === "web" || key === "client") return "frontend";
    return "all";
}

function flagsFromRole(role: InstanceRole): {
    api: boolean;
    game: boolean;
    client: boolean;
} {
    return {
        api: role === "all" || role === "api" || role === "api+game" || role === "api+frontend",
        game: role === "all" || role === "game" || role === "api+game" || role === "game+frontend",
        client: role === "all"
            || role === "frontend"
            || role === "api+frontend"
            || role === "game+frontend",
    };
}

type TemplateValues = PartialConfig & {
    modes?: PartialConfig["modes"] | CompactGameModes;
    maxGames?: number;
    maxSessions?: number;
    thisRegion?: string;
    role?: string;
    apiUrl?: string;
    apiPublicUrl?: string;
    proxyIPHeader?: string;
    database?: PartialConfig["database"] & { name?: string };
    api?: { enabled?: boolean; port?: number };
    game?: {
        enabled?: boolean;
        port?: number;
        firstMatch?: number;
        maxGames?: number;
        id?: string;
        thisRegion?: string;
        name?: string;
        url?: string;
        address?: string;
        apiUrl?: string;
        regions?: PartialConfig["regions"];
    };
    client?: { enabled?: boolean; port?: number };
};

function formatModes(
    modes: PartialConfig["modes"] | CompactGameModes | undefined,
    mapName: string,
): string {
    if (modes && !Array.isArray(modes)) {
        return `{
    solo: ${bool(modes.solo, true)}
    duo: ${bool(modes.duo, true)}
    squad: ${bool(modes.squad, true)}
  }`;
    }

    if (modes?.length) {
        const expected = [TeamMode.Solo, TeamMode.Duo, TeamMode.Squad];
        const standard = modes.length === 3 && modes.every((mode, i) =>
            (mode?.mapName ?? mapName) === mapName
            && (mode?.teamMode ?? expected[i]) === expected[i]
        );
        if (!standard) {
            const lines = modes.map((mode) => {
                const name = mode?.mapName ?? mapName;
                const teamMode = mode?.teamMode ?? TeamMode.Solo;
                const enabled = mode?.enabled ?? true;
                return `    { mapName: ${q(name)}, teamMode: ${teamMode}, enabled: ${enabled} }`;
            });
            return `[\n${lines.join("\n")}\n  ]`;
        }
    }

    const list = modes?.length
        ? modes
        : [{ enabled: true }, { enabled: true }, { enabled: true }];
    return `{
    solo: ${bool(list[0]?.enabled, true)}
    duo: ${bool(list[1]?.enabled, true)}
    squad: ${bool(list[2]?.enabled, true)}
  }`;
}

function formatSecrets(secrets: PartialConfig["secrets"]): string {
    const lines = [
        `  SURVEV_API_KEY: ${q(secrets?.SURVEV_API_KEY ?? "")}`,
        `  SURVEV_IP_SECRET: ${q(secrets?.SURVEV_IP_SECRET ?? "")}`,
    ];
    const skip = new Set(["SURVEV_API_KEY", "SURVEV_IP_SECRET"]);
    for (const [key, value] of Object.entries(secrets ?? {})) {
        if (skip.has(key) || value == null || value === "") continue;
        lines.push(`  ${key}: ${q(String(value))}`);
    }
    return lines.join("\n");
}

function resolveGameIdentity(values: TemplateValues, live: boolean) {
    const regions = values.game?.regions ?? values.regions ?? {};
    const id = (
        values.game?.id
        || values.game?.thisRegion
        || values.thisRegion
        || values.gameServer?.thisRegion
        || Object.keys(regions)[0]
        || (live ? "main" : "local")
    ).trim();
    const entry = regions[id] ?? Object.values(regions)[0];
    return {
        id,
        name: values.game?.name || entry?.name || (live ? "Main" : "Local"),
        url: values.game?.url
            || entry?.url
            || (entry?.publicAddress
                ? `${entry.https ? "https" : "http"}://${entry.publicAddress}`
                : (live ? "https://survev.example.com" : "")),
        address: values.game?.address
            || entry?.address
            || "127.0.0.1:8001",
    };
}

/**
 * Compact sectioned HJSON for the repo-root config file.
 */
export function buildCommentedConfigHjson(
    values: TemplateValues,
    opts?: { forProduction?: boolean },
): string {
    const forProduction = opts?.forProduction ?? false;
    const serverMode: ServerMode = values.serverMode
        ?? (forProduction ? "live" : "dev");
    const live = serverMode === "live";

    const vitePort = values.client?.port ?? values.vite?.port ?? 3000;
    const apiPort = values.api?.port ?? values.apiServer?.port ?? 8000;
    const gamePort = values.game?.port ?? values.gameServer?.port ?? 8001;
    const firstGamePort = values.game?.firstMatch
        ?? values.gameServer?.firstGamePort
        ?? 9000;

    const bind = values.bind
        ?? values.apiServer?.host
        ?? values.vite?.host
        ?? (live ? "127.0.0.1" : "0.0.0.0");

    const maxGames = values.game?.maxGames
        ?? values.maxGames
        ?? values.maxSessions
        ?? values.gameServer?.maxGames
        ?? (live ? 16 : 64);
    const mapName = values.mapName
        ?? (Array.isArray(values.modes) ? values.modes[0]?.mapName : undefined)
        ?? "specops";

    let apiOn = values.api?.enabled ?? values.apiServer?.enabled;
    let gameOn = values.game?.enabled ?? values.gameServer?.enabled;
    let clientOn = values.client?.enabled ?? values.vite?.enabled;
    if (apiOn === undefined && gameOn === undefined && clientOn === undefined) {
        const flags = flagsFromRole(parseRole(values.instanceRole ?? values.role ?? "all"));
        apiOn = flags.api;
        gameOn = flags.game;
        clientOn = flags.client;
    } else {
        apiOn ??= true;
        gameOn ??= true;
        clientOn ??= true;
    }

    const apiUrl = (
        values.game?.apiUrl
        || values.apiUrl
        || values.gameServer?.apiServerUrl
        || ""
    ).trim();
    const proxyHeader = values.proxyIPHeader
        ?? values.apiServer?.proxyIPHeader
        ?? values.gameServer?.proxyIPHeader
        ?? (forProduction ? "X-Real-IP" : "");

    const oauth = values.oauthRedirectURI
        ?? (forProduction ? "https://survev.example.com" : "");

    const db = values.database;
    const identity = resolveGameIdentity(values, live);
    const advertise = values.advertiseHost?.trim() ?? "";

    const extra: string[] = [];
    if (values.apiPublicUrl) extra.push(`apiPublicUrl: ${q(String(values.apiPublicUrl))}`);
    if (values.clientTheme && values.clientTheme !== "main") {
        extra.push(`clientTheme: ${q(values.clientTheme)}`);
    }
    if (values.passType !== undefined && values.passType !== "pass_survivr1") {
        extra.push(`passType: ${q(values.passType)}`);
    }
    if (values.oauthBasePath && values.oauthBasePath !== "/") {
        extra.push(`oauthBasePath: ${q(values.oauthBasePath)}`);
    }

    const apiUrlLine = !apiOn
        ? `  apiUrl: ${q(apiUrl || "https://fireteam.example.com")}  // master website/API\n`
        : "";

    const urlLine = identity.url
        ? `  url: ${q(identity.url)}                   // players (nginx)\n`
        : `  url: "http://127.0.0.1:${gamePort}"         // players\n`;

    return `serverMode: ${q(serverMode)}                 // "dev" | "live"
bind: ${q(bind)}                   // listen host; game nodes often "0.0.0.0"
advertiseHost: ${q(advertise)}
${proxyHeader ? `proxyIPHeader: ${q(proxyHeader)}\n` : ""}${extra.length ? `${extra.join("\n")}\n` : ""}
api: {
  enabled: ${bool(apiOn, true)}                     // master matchmaking
  port: ${apiPort}
}

game: {
  enabled: ${bool(gameOn, true)}
  port: ${gamePort}
  firstMatch: ${firstGamePort}
  maxGames: ${maxGames}
${apiUrlLine}  id: ${q(identity.id)}                         // unique on this host
  name: ${q(identity.name)}                   // Server dropdown label
${urlLine}  address: ${q(identity.address)}           // master → this game (:8001)

  mapName: ${q(mapName)}
  difficulty: ${q(values.difficulty ?? "regular")}           // recruit | regular | hardened | veteran
  endless: ${bool(values.endless, false)}
  contractsEnabled: ${bool(values.contractsEnabled, true)}
  maxSquadSize: ${num(values.maxSquadSize, 4)}                  // 2-8
  maxPlayersPerGame: ${num(values.maxPlayersPerGame, 0)}             // 0 = map default
  modes: ${formatModes(values.modes, mapName)}
}

client: {
  enabled: ${bool(clientOn, true)}                  // website
  port: ${vitePort}
}

database: {
  engine: ${q(db?.engine ?? "sqlite")}              // sqlite (default) | postgres | mariadb | mongodb

  sqlite: {
    path: ${q(db?.sqlitePath ?? "data/specops-local.db")}
  }
  postgres: {
    host: "127.0.0.1"
    port: 5432
    name: "survev"
    user: "survev"
    password: "survev"
  }
  mariadb: {
    host: "127.0.0.1"
    port: 3306
    name: "survev"
    user: "survev"
    password: "survev"
  }
  mongodb: {
    host: "127.0.0.1"
    port: 27017
    name: "survev"
    // uri: "mongodb://127.0.0.1:27017"
  }
}

secrets: {
${formatSecrets(values.secrets)}
}

captchaEnabled: ${bool(values.captchaEnabled, false)}
rateLimitsEnabled: ${bool(values.rateLimitsEnabled, live)}
uniqueInGameNames: ${bool(values.uniqueInGameNames, true)}
cachingEnabled: ${bool(values.cachingEnabled, false)}
${oauth ? `oauthRedirectURI: ${q(oauth)}\n` : ""}
debug: {
  enabled: ${bool(values.debug?.enabled, !live)}
  allowBots: ${bool(values.debug?.allowBots, !live)}
  allowEditMsg: ${bool(values.debug?.allowEditMsg, !live)}
  allowMockAccount: ${bool(values.debug?.allowMockAccount, !live)}
  allowNpcSpawn: ${bool(values.debug?.allowNpcSpawn, false)}
}

gameTps: ${num(values.gameTps, 100)}
netSyncTps: ${num(values.netSyncTps, 33)}

logging: {
  logDate: ${bool(values.logging?.logDate, true)}
  infoLogs: ${bool(values.logging?.infoLogs, true)}
  debugLogs: ${bool(values.logging?.debugLogs, !live)}
  warnLogs: ${bool(values.logging?.warnLogs, true)}
  errorLogs: ${bool(values.logging?.errorLogs, true)}
  clientLogs: ${bool(values.logging?.clientLogs, true)}
  clientLogDir: ${q(values.logging?.clientLogDir || "logs/client")}
}
`;
}
