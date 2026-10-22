import { Socket } from "node:net";
import { resolve } from "node:path";
import { defineConfig, loadEnv, PluginOption, type ServerOptions } from "vite";
import { getConfig } from "../config.ts";
import { version } from "../package.json" with { type: "json" };
import { GIT_VERSION } from "../server/src/utils/gitRevision.ts";
import { stripBlockPlugin } from "../shared/utils/stripBlockPlugin.ts";
import { atlasBuilderPlugin } from "./atlas-builder/vitePlugin.ts";
import { codefendPlugin } from "./vite-plugins/codefendPlugin.ts";
import { ejsPlugin } from "./vite-plugins/ejsPlugin.ts";

// Bun sockets lack Node's destroySoon(); Vite's WS proxy calls it on teardown.
if (!(Socket.prototype as Socket & { destroySoon?: () => void }).destroySoon) {
    Socket.prototype.destroySoon = function destroySoon(this: Socket) {
        this.destroy();
    };
}

function patchProxySocket(
    socket: { destroy?: () => void; destroySoon?: () => void } | undefined,
) {
    if (
        socket
        && typeof socket.destroy === "function"
        && typeof socket.destroySoon !== "function"
    ) {
        socket.destroySoon = () => socket.destroy!();
    }
}

function configureProxySockets(proxy: {
    on: (event: string, cb: (...args: any[]) => void) => void;
}) {
    proxy.on("proxyReq", (_proxyReq, req: { socket?: unknown }) => {
        patchProxySocket(req.socket as Parameters<typeof patchProxySocket>[0]);
    });
    proxy.on("proxyReqWs", (_proxyReq, req: { socket?: unknown }) => {
        patchProxySocket(req.socket as Parameters<typeof patchProxySocket>[0]);
    });
    proxy.on("open", (socket: unknown) => {
        patchProxySocket(socket as Parameters<typeof patchProxySocket>[0]);
    });
}

export default defineConfig(({ mode }) => {
    const viteEnv = loadEnv(mode, process.cwd(), "VITE_");
    const isDev = mode === "development";

    const Config = getConfig(!isDev, "");

    const viteConnect = Config.vite.host === "0.0.0.0" || Config.vite.host === "::"
        ? "127.0.0.1"
        : Config.vite.host;
    const apiConnect = Config.apiServer.host === "0.0.0.0" || Config.apiServer.host === "::"
        ? "127.0.0.1"
        : Config.apiServer.host;

    process.env.VITE_TURNSTILE_SCRIPT = "";
    if (Config.secrets.TURNSTILE_SITE_KEY) {
        process.env.VITE_TURNSTILE_SCRIPT =
            `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" defer></script>`;
    }

    process.env.VITE_DEBUG_CSS_LINK = isDev
        ? `<link href='css/dev.css' rel="stylesheet" />`
        : "";
    process.env.VITE_GAME_VERSION = version;

    process.env.VITE_SPELLSYNC_PROJECT_ID = Config.secrets.SPELLSYNC_PROJECT_ID;
    process.env.VITE_SPELLSYNC_PUBLIC_TOKEN = Config.secrets.SPELLSYNC_PUBLIC_TOKEN;

    const plugins: PluginOption[] = [ejsPlugin(), ...atlasBuilderPlugin()];

    if (!isDev) {
        plugins.push(codefendPlugin());

        plugins.push(
            stripBlockPlugin({
                start: "STRIP_FROM_PROD_CLIENT:START",
                end: "STRIP_FROM_PROD_CLIENT:END",
            }),
        );
    }

    const argvPortIdx = process.argv.indexOf("--port");
    const cliPort = argvPortIdx >= 0 ? Number(process.argv[argvPortIdx + 1]) : 0;
    const viteInternalPort = cliPort === 3100 ? 3100 : 0;
    const publicVitePort = Config.vite.port;

    const serverOptions: ServerOptions = {
        port: viteInternalPort || Config.vite.port,
        host: Config.vite.host,
        // Allow opening the site via LAN/WAN IP, not only localhost.
        allowedHosts: true,
        // Internal Vite (:3100) is behind wan-proxy on :3000 — HMR must use the public port.
        ...(isDev && viteInternalPort
            ? {
                hmr: {
                    port: viteInternalPort,
                    clientPort: publicVitePort,
                },
            }
            : {}),
        proxy: {
            // this redirects /stats to /stats/
            // because vite is cringe and does not work without trailing slashes at the end of paths 😭
            "^/stats(?!/$).*": {
                target: `http://${viteConnect}:${Config.vite.port}`,
                rewrite: (path) => path.replace(/^\/stats(?!\/$).*/, "/stats/"),
                changeOrigin: true,
                secure: false,
            },
            "/api": {
                target: `http://${apiConnect}:${Config.apiServer.port}`,
                changeOrigin: true,
                secure: false,
                configure: (proxy) => {
                    configureProxySockets(proxy);
                    proxy.on("proxyReq", (proxyReq, req) => {
                        const raw = req.socket.remoteAddress || "";
                        const ip = raw.replace(/^::ffff:/, "");
                        if (ip) proxyReq.setHeader("X-Real-IP", ip);
                    });
                },
            },
            "/session": {
                target: `http://${apiConnect}:${Config.gameServer.port}`,
                changeOrigin: true,
                secure: false,
                configure: configureProxySockets,
            },
            // /team_v2 and /ptc WebSockets are proxied by wsProxyPlugin only.
            // Game child processes listen on 9000+. Tunnel them through the site
            // port as /g/<port>/play so only :3000 must be public.
            // Vite's proxy does not support http-proxy-middleware `router`, so each
            // game port needs its own static target (otherwise all /g/* hit 9000).
            ...Object.fromEntries(
                Array.from({ length: Config.gameServer.maxGames }, (_, i) => {
                    const port = Config.gameServer.firstGamePort + i;
                    return [
                        `/g/${port}`,
                        {
                            target: `http://${viteConnect}:${port}`,
                            changeOrigin: true,
                            secure: false,
                            rewrite: (path: string) => path.replace(`/g/${port}`, ""),
                            configure: configureProxySockets,
                        },
                    ];
                }),
            ),
        },
    };

    return {
        appType: "mpa",
        base: "",
        build: {
            target: "es2022",
            chunkSizeWarningLimit: 2000,
            rollupOptions: {
                input: {
                    main: resolve(import.meta.dirname, "index.html"),
                    stats: resolve(import.meta.dirname, "stats/index.html"),
                    ...(isDev
                        ? {
                            "building-editor": resolve(
                                import.meta.dirname,
                                "building-editor/index.html",
                            ),
                        }
                        : {}),
                },
                output: {
                    assetFileNames(assetInfo) {
                        if (assetInfo.names[0]?.endsWith(".css")) {
                            return "css/[name]-[hash][extname]";
                        }
                        return "assets/[name]-[hash][extname]";
                    },
                    entryFileNames: "js/[hash].js",
                    chunkFileNames: "js/[hash].js",
                },
            },
        },
        resolve: {
            extensions: [".ts", ".js"],
            alias: {
                "@/sdk.ts": viteEnv?.VITE_ENABLE_SURVEV_ADS === "true"
                    ? "./sdk-manager.prod"
                    : "./sdk-manager",
            },
        },
        define: {
            PING_TEST_URLS: Object.entries(Config.regions).map(([key, data]) => {
                // Vite DEV: ping through the site proxy, not production `game.url`.
                return {
                    region: key,
                    zone: key,
                    url: isDev
                        ? (data.address || data.publicAddress)
                        : (data.publicAddress || data.address),
                    https: isDev ? false : data.https,
                };
            }),
            GAME_REGIONS: Object.fromEntries(
                Object.entries(Config.regions).map(([key, data]) => [
                    key,
                    {
                        https: isDev ? false : data.https,
                        address: isDev
                            ? (data.address || data.publicAddress)
                            : (data.publicAddress || data.address),
                        l10n: data.l10n,
                        name: data.name || "",
                    },
                ]),
            ),
            GIT_VERSION: JSON.stringify(GIT_VERSION),
            PASS_TYPE: JSON.stringify(Config.passType),
            AD_PREFIX: JSON.stringify(Config.secrets.AD_PREFIX),
            VITE_GAMEMONETIZE_ID: JSON.stringify(Config.secrets.GAMEMONETIZE_ID),
            SPELLSYNC_PROJECT_ID: JSON.stringify(Config.secrets.SPELLSYNC_PROJECT_ID),
            SPELLSYNC_PUBLIC_TOKEN: JSON.stringify(Config.secrets.SPELLSYNC_PUBLIC_TOKEN),
            API_PUBLIC_URL: JSON.stringify(Config.apiPublicUrl || ""),
            IS_DEV: isDev,
            PROXY_DEFS: JSON.stringify(Config.proxies),
            TURNSTILE_SITE_KEY: JSON.stringify(Config.secrets.TURNSTILE_SITE_KEY),
        },
        plugins,
        json: {
            stringify: true,
        },
        server: serverOptions,
        preview: serverOptions,
    };
});
