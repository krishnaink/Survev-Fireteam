import enquirer from "enquirer";
import hjson from "hjson";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configFileName } from "./config.ts";
import { buildCommentedConfigHjson } from "./configTemplate.ts";
import type { PartialConfig } from "./configType.ts";
import { util } from "./shared/utils/util.ts";

const prompt = enquirer.prompt;

async function importKeys(config: PartialConfig) {
    config.secrets ??= {};
    const apiKey = await prompt<{ value: string }>({
        message: "Enter the shared SURVEV_API_KEY (same secret as the main/master API host — required handshake):",
        name: "value",
        type: "text",
        required: true,
    });
    config.secrets.SURVEV_API_KEY = apiKey.value;
}

async function askMasterApiUrl(config: PartialConfig, initial?: string) {
    const apiAddress = await prompt<{ value: string }>({
        message:
            "Main / master API URL this host should connect to (e.g. https://api.example.com or http://10.0.0.5:8000)",
        name: "value",
        type: "text",
        required: true,
        initial: initial
            || config.apiUrl
            || config.gameServer?.apiServerUrl
            || "http://127.0.0.1:8000",
        validate(value) {
            return URL.parse(value) !== null;
        },
    });
    config.apiUrl = apiAddress.value;
    config.gameServer ??= {};
    config.gameServer.apiServerUrl = apiAddress.value;
}

async function setupGameServer(config: PartialConfig, opts?: { askApiUrl?: boolean }) {
    config.gameServer ??= {};

    const regionId = await prompt<{ value: string }>({
        message: "Server id for this game host (config key, e.g. main, eu, lan)",
        name: "value",
        type: "text",
        required: true,
        initial: "main",
    });
    config.gameServer.thisRegion = regionId.value;

    config.regions ??= {};

    if (!config.regions[regionId.value]) {
        const name = await prompt<{ value: string }>({
            message: "Display name in the Server dropdown (e.g. Fireteam, Europe)",
            name: "value",
            type: "text",
            initial: regionId.value,
        });

        const url = await prompt<{ value: string }>({
            message: "Player connect URL (https://domain, http://ip:8001, or host:port)",
            name: "value",
            type: "text",
            required: true,
        });

        const address = await prompt<{ value: string }>({
            message: "API → game address on this machine (plain HTTP, usually 127.0.0.1:8001)",
            name: "value",
            type: "text",
            initial: "127.0.0.1:8001",
        });

        config.regions[regionId.value] = {
            name: name.value.trim() || regionId.value,
            url: url.value.trim(),
            address: address.value.trim(),
        };
    }

    if (opts?.askApiUrl !== false && !config.gameServer.apiServerUrl) {
        await askMasterApiUrl(config);
    } else if (!config.gameServer.apiServerUrl) {
        config.gameServer.apiServerUrl = `http://127.0.0.1:${config.apiServer?.port ?? 8000}`;
        config.apiUrl ??= config.gameServer.apiServerUrl;
    }

    await setupProxyIPHeader(config, "gameServer");
    await setupSSL(config, "gameServer");
}

async function setupDatabase(config: PartialConfig, initial = true) {
    const dbEnabled = await prompt<{ value: boolean }>({
        message: "Would you like to setup database support (required for accounts, IP bans, leaderboards etc)",
        name: "value",
        type: "confirm",
        initial,
    });

    config.database = {
        ...config.database,
        enabled: dbEnabled.value,
    };

    if (dbEnabled.value) {
        await setupAccounts(config);

        const setupBot = await prompt<{ value: boolean }>({
            message: "Would you like to setup the moderation bot?",
            name: "value",
            type: "confirm",
            initial: false,
        });

        if (setupBot.value) {
            await setupBotConfig(config);
        }
    }
}

async function setupAccounts(config: PartialConfig) {
    const redirectURI = await prompt<{ value: string }>({
        message: "Enter the full base URL of the website for oauth2 redirects (eg: https://survev.io)",
        name: "value",
        type: "text",
        initial: `http://${config.apiServer?.host ?? "127.0.0.1"}:${config.apiServer?.port ?? 8000}`,
        required: true,
    });

    config.oauthRedirectURI = redirectURI.value;

    const addGoogle = await prompt<{ value: boolean }>({
        message: "Would you like to add google login support",
        name: "value",
        type: "confirm",
        initial: false,
    });

    config.secrets ??= {};

    if (addGoogle.value) {
        const clientId = await prompt<{ value: string }>({
            message: "Enter google client ID",
            name: "value",
            type: "text",
            required: true,
        });

        config.secrets.GOOGLE_CLIENT_ID = clientId.value;

        const clientSecret = await prompt<{ value: string }>({
            message: "Enter google client secret",
            name: "value",
            type: "text",
            required: true,
        });

        config.secrets.GOOGLE_SECRET_ID = clientSecret.value;
    }

    const addDiscord = await prompt<{ value: boolean }>({
        message: "Would you like to add discord login support",
        name: "value",
        type: "confirm",
        initial: false,
    });

    if (addDiscord.value) {
        const clientId = await prompt<{ value: string }>({
            message: "Enter discord client ID",
            name: "value",
            type: "text",
            required: true,
        });
        config.secrets.DISCORD_CLIENT_ID = clientId.value;

        const clientSecret = await prompt<{ value: string }>({
            message: "Enter discord secret secret",
            name: "value",
            type: "text",
            required: true,
        });
        config.secrets.DISCORD_SECRET_ID = clientSecret.value;
    }
}

async function setupAPIServer(config: PartialConfig) {
    const shouldImportKeys = await prompt<{ value: "import" | "random" }>({
        message: "SURVEV_API_KEY for game ↔ API handshake — import an existing key or generate a new one?",
        name: "value",
        type: "select",
        choices: [
            {
                name: "random",
                message: "Generate a new key (use this on the main/master API, then copy to game hosts)",
            },
            {
                name: "import",
                message: "Import existing key (same as the main/master API)",
            },
        ],
    });

    if (shouldImportKeys.value === "import") {
        await importKeys(config);
    }
    await setupProxyIPHeader(config, "apiServer");
    await setupSSL(config, "apiServer");
    await setupDatabase(config);
}

async function setupRegions(config: PartialConfig) {
    config.regions ??= {};

    let addRegion = true;
    while (addRegion) {
        const regionId = await prompt<{ value: string }>({
            message: "Server id (config key shown internally, e.g. main, eu, lan)",
            name: "value",
            type: "text",
            required: true,
        });

        const name = await prompt<{ value: string }>({
            message: "Display name in the Server dropdown (e.g. Fireteam, Europe)",
            name: "value",
            type: "text",
            initial: regionId.value,
        });

        const url = await prompt<{ value: string }>({
            message: "Player connect URL (https://domain, http://ip:8001, or host:port)",
            name: "value",
            type: "text",
            required: true,
        });

        const address = await prompt<{ value: string }>({
            message: "API → game address (plain HTTP from this API host, e.g. 127.0.0.1:8001 or 10.0.0.8:8001)",
            name: "value",
            type: "text",
            initial: "127.0.0.1:8001",
        });

        config.regions[regionId.value] = {
            name: name.value.trim() || regionId.value,
            url: url.value.trim(),
            address: address.value.trim(),
        };

        const addMore = await prompt<{ value: boolean }>({
            message: "Add another game server / region to the master API list?",
            name: "value",
            type: "confirm",
            initial: false,
        });

        addRegion = addMore.value;
    }
}

async function setupProxyCheck(config: PartialConfig) {
    const enableProxyCheck = await prompt<{ value: boolean }>({
        message: "Would you like to enable proxycheck.io to ban VPNs and proxies?",
        name: "value",
        type: "confirm",
        initial: false,
    });
    if (enableProxyCheck.value) {
        const proxycheckKey = await prompt<{ value: string }>({
            message: "Enter proxycheck API key",
            name: "value",
            type: "text",
        });
        config.secrets ??= {};
        config.secrets.PROXYCHECK_KEY = proxycheckKey.value;
    }
}

async function setupProxyIPHeader(
    config: PartialConfig,
    server: "apiServer" | "gameServer",
) {
    const serverName = server == "apiServer" ? "API server" : "game server";
    const isBehindProxy = await prompt<{ value: boolean }>({
        message: `Is the ${serverName} behind a proxy? (e.g nginx or cloudflare)`,
        name: "value",
        type: "confirm",
        initial: false,
    });

    if (isBehindProxy.value) {
        const proxyHeader = await prompt<{ value: string }>({
            message: "Enter the proxy HTTP header",
            name: "value",
            type: "text",
            initial: "X-Real-IP",
        });
        config[server] ??= {};
        config[server].proxyIPHeader = proxyHeader.value;
    }
}

async function setupSSL(config: PartialConfig, server: "apiServer" | "gameServer") {
    const serverName = server == "apiServer" ? "API server" : "game server";

    const enableSSL = await prompt<{ value: boolean }>({
        message: `Would you like enabling SSL for the ${serverName}?`,
        name: "value",
        type: "confirm",
        initial: false,
    });

    if (enableSSL.value) {
        const keyFilePath = await prompt<{ value: string }>({
            message: "Enter SSL key file path",
            name: "value",
            type: "text",
        });
        const certFilePath = await prompt<{ value: string }>({
            message: "Enter SSL cert file path",
            name: "value",
            type: "text",
        });
        config[server] ??= {};
        config[server].ssl = {
            keyFile: keyFilePath.value,
            certFile: certFilePath.value,
        };
    }
}

async function setupProductionConfig(config: PartialConfig) {
    config.debug = {
        enabled: false,
        allowBots: false,
        allowEditMsg: false,
        allowMockAccount: false,
        allowNpcSpawn: false,
    };
    config.apiServer ??= {};
    config.gameServer ??= {};

    // serverMode is already "live" — next decide what THIS host runs.
    const hostRole = await prompt<{
        value: "all" | "api" | "game" | "frontend";
    }>({
        message: "What should this host run?",
        name: "value",
        type: "select",
        choices: [
            {
                name: "all",
                message: "Everything — main server (API + game + website on one box)",
            },
            {
                name: "api",
                message: "Main / master API only (lobbies, matchmaking, stats)",
            },
            {
                name: "game",
                message: "Game server only (points at the main/master API)",
            },
            {
                name: "frontend",
                message: "Website only (points at the main/master API)",
            },
        ],
    });

    config.instanceRole = hostRole.value;
    const flags = hostRole.value === "all"
        ? { api: true, game: true, client: true }
        : hostRole.value === "api"
        ? { api: true, game: false, client: false }
        : hostRole.value === "game"
        ? { api: false, game: true, client: false }
        : { api: false, game: false, client: true };
    config.apiServer = { ...config.apiServer, enabled: flags.api };
    config.gameServer = { ...config.gameServer, enabled: flags.game };
    config.vite = { ...config.vite, enabled: flags.client };

    if (hostRole.value === "api" || hostRole.value === "all") {
        const apiRole = await prompt<{ value: "master" | "point" }>({
            message: "API setup — is this the main/master API, or should it point at another master?",
            name: "value",
            type: "select",
            choices: [
                {
                    name: "master",
                    message: "This host IS the main / master API",
                },
                {
                    name: "point",
                    message: "Point this host at an existing master API (remote matchmaking)",
                },
            ],
        });

        if (apiRole.value === "point") {
            await askMasterApiUrl(config);
            await importKeys(config);

            if (hostRole.value === "all") {
                // Keep game+client locally, but use remote master API.
                config.instanceRole = "game+frontend";
                config.apiServer = { ...config.apiServer, enabled: false };
                config.gameServer = { ...config.gameServer, enabled: true };
                config.vite = { ...config.vite, enabled: true };
                await setupGameServer(config, { askApiUrl: false });
            } else {
                // Was "api" but they want to point elsewhere — website against master.
                config.instanceRole = "frontend";
                config.apiServer = { ...config.apiServer, enabled: false };
                config.gameServer = { ...config.gameServer, enabled: false };
                config.vite = { ...config.vite, enabled: true };
            }
            await setupProxyCheck(config);
            return;
        }

        // Master API on this host
        await setupAPIServer(config);
        await setupRegions(config);

        if (hostRole.value === "all") {
            config.gameServer.apiServerUrl = `http://127.0.0.1:${config.apiServer?.port ?? 8000}`;
            config.apiUrl = config.gameServer.apiServerUrl;
            await setupGameServer(config, { askApiUrl: false });
        }
    } else {
        // Game or frontend only — must point at the master API
        await askMasterApiUrl(config);
        await importKeys(config);

        if (hostRole.value === "game") {
            await setupGameServer(config, { askApiUrl: false });
        }
    }

    await setupProxyCheck(config);
}

async function setupDevelopmentConfig(config: PartialConfig) {
    await setupDatabase(config, false);
}

async function setupBotConfig(config: PartialConfig) {
    config.secrets ??= {};

    if (!config.secrets.DISCORD_CLIENT_ID) {
        const clientId = await prompt<{ value: string }>({
            message: "Enter discord client ID",
            name: "value",
            type: "text",
            required: true,
        });
        config.secrets.DISCORD_CLIENT_ID = clientId.value;
    }

    const discordBotToken = await prompt<{ value: string }>({
        message: "Enter the discord bot token",
        name: "value",
        type: "text",
    });
    config.secrets.DISCORD_BOT_TOKEN = discordBotToken.value;

    const discordGuildId = await prompt<{ value: string }>({
        message: "Enter the guild ID",
        name: "value",
        type: "text",
    });
    config.discordGuildId = discordGuildId.value;

    const discordRoleId = await prompt<{ value: string }>({
        message: "Enter the discord role ID",
        name: "value",
        type: "text",
    });
    config.discordRoleId = discordRoleId.value;
}

const configPath = path.join(import.meta.dirname, configFileName);

async function loadExistingConfig(config: PartialConfig) {
    if (!fs.existsSync(configPath)) return;

    const confirmation = await prompt<{ value: boolean }>({
        message: "A config file already exists, would you like to run this setup anyway?",
        name: "value",
        type: "confirm",
        initial: true,
    });
    if (!confirmation.value) {
        process.exit(0);
    }

    const configText = fs.readFileSync(configPath).toString();
    const localConfig = hjson.parse(configText);
    util.mergeDeep(config, localConfig);
}

async function setupConfig() {
    const config: PartialConfig = {
        secrets: {
            SURVEV_API_KEY: randomBytes(64).toString("base64"),
        },
    };

    console.log("Welcome to Survev.io initial config setup!");

    await loadExistingConfig(config);

    const devOrProd = await prompt<{ value: "development" | "production" }>({
        message: "Are you setting up a local development environment or a production server?",
        name: "value",
        type: "select",
        choices: ["production", "development"],
    });

    if (devOrProd.value === "development") {
        config.serverMode = "dev";
        config.instanceRole = "all";
        config.apiServer = { ...config.apiServer, enabled: true };
        config.gameServer = { ...config.gameServer, enabled: true };
        config.vite = { ...config.vite, enabled: true };
        await setupDevelopmentConfig(config);
    } else {
        config.serverMode = "live";
        await setupProductionConfig(config);
    }

    const isProduction = devOrProd.value === "production";
    const str = buildCommentedConfigHjson(config, { forProduction: isProduction });
    fs.writeFileSync(configPath, str);

    console.log("Wrote config to", configPath, ":");
    console.log(str);
}

await setupConfig();
