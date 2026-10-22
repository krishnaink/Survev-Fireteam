import type { MapDefKey } from "../../shared/defs/mapDefs.ts";
import { GameConfig } from "../../shared/gameConfig.ts";
import loadout from "../../shared/utils/loadout.ts";
import { util } from "../../shared/utils/util.ts";
import { v2 } from "../../shared/utils/v2.ts";
import {
    advancedDefaultsForQuality,
    clampRenderScale,
    COMMUNITY_ANNOUNCEMENT_VERSION,
    defaultRenderScaleForQuality,
    detectRecommendedQuality,
    type GraphicsQuality,
    parseGraphicsQuality,
} from "./graphicsQuality.ts";
import type { Locale } from "./ui/localization.ts";

export const debugToolsConfig = {
    enabled: false,

    zoomEnabled: false,
    zoom: GameConfig.scopeZoomRadius.desktop["1xscope"],

    speedEnabled: false,
    speed: GameConfig.player.moveSpeed,

    gameSpeedEnabled: false,
    gameSpeed: 1,

    mapSeed: 0,

    loot: "",
    role: "",

    noClip: false,
    godMode: false,
    teleportToPings: false,
    moveObjs: false,
    preventGameStart: false,

    spawnNpcKind: "enemy" as "enemy" | "ally" | "sentry" | "glory_executioner" | "glory_helpers",
    spawnNpcType: "militia",
    spawnNpcCount: 1,
    npcIgnoreOperators: false,

    // Cheat panel
    cheatGiveItem: "",
    cheatGiveCount: 1,
    cheatSetHealth: 100,
    cheatSetWave: 1,
};

export const debugRenderConfig = {
    enabled: false,
    players: false,
    obstacles: false,
    loot: false,
    explosions: false,
    rivers: false,
    buildings: {
        buildingBounds: false,
        obstacleBounds: false,
        bridge: false,
        waterEdge: false,
        ceiling: false,
        floors: false,
        minimap: false,
    },
    structures: {
        buildingBounds: false,
        obstacleBounds: false,
        bridge: false,
        waterEdge: false,
        stairs: false,
        layerMasks: false,
    },
};

export const debugHUDConfig = {
    enabled: false,
    position: false,
    objectPools: false,
    fps: {
        show: false,
        showGraph: false,
    },
    ping: {
        show: false,
        showGraph: false,
    },
    netIn: {
        show: false,
        showGraph: false,
    },
    updateInterval: {
        show: false,
        showGraph: false,
    },
};

export type DebugRenderOpts = typeof debugRenderConfig;

export const BuildingEditorConfig = {
    zoom: 1,
    pos: v2.create(0, 0),
    layer: 0,
    object: "house_red_01",
    ori: 0,
    map: "main" as MapDefKey,
    hideCeilings: false,
    showGrid: true,
};

const defaultConfig = {
    muteAudio: false,
    masterVolume: 1,
    soundVolume: 1,
    musicVolume: 1,
    /** low | medium | high — base preset for particles / audio / resolution ceiling. */
    graphicsQuality: "high" as GraphicsQuality,
    /** Extra resolution scale 0.5–1.0 (multiplies PIXI resolution). */
    renderScale: 1,
    highResTex: true,
    /** When true, PIXI ticker is uncapped (vs 60 FPS). */
    uncapFps: false,
    /** Cull off-screen trees/bushes. */
    foliageCulling: true,
    /** Biome camera ambient emitters (leaves/snow). */
    ambientParticles: true,
    /** Hide aura / dual-gun / nameplates on distant non-local players. */
    simplifyDistantNpcs: false,
    /** Thin / hide distant smoke on lower presets. */
    reduceSmokeFx: false,
    /** Hide community announcement until this unix ms (0 = show when due). */
    announcementHideUntil: 0,
    /** Last community announcement version the player snoozed/closed for 14d. */
    announcementVersionSeen: 0,
    interpolation: true,
    localRotation: false,
    screenShake: true,
    anonPlayerNames: false,
    touchMoveStyle: "anywhere" as "locked" | "anywhere",
    touchAimStyle: "anywhere" as "locked" | "anywhere",
    touchAimLine: true,
    profile: null as { slug: string } | null,
    playerName: "",
    region: "",
    gameModeIdx: 2,
    teamAutoFill: true,
    teamMapName: "random",
    teamSquadSize: 4,
    teamSquadName: "",
    teamDifficulty: "regular",
    teamEndless: undefined as boolean | undefined,
    language: "en" as Locale,
    prerollGamesPlayed: 0,
    totalGamesPlayed: 0,
    promptAppRate: true,
    regionSelected: false,
    lastNewsTimestamp: 0,
    perkModeRole: "",
    loadout: loadout.defaultLoadout(),
    sessionCookie: "" as string | null,
    binds: "",
    cachedBgImg: "img/main_splash.png",
    version: 1,
    /* STRIP_FROM_PROD_CLIENT:START */
    debugTools: debugToolsConfig,
    debugRenderer: debugRenderConfig,
    /* STRIP_FROM_PROD_CLIENT:END */
    debugHUD: debugHUDConfig,
    buildingEditor: BuildingEditorConfig,
};

export type ConfigType = typeof defaultConfig;
export type ConfigKey = keyof ConfigType;

export class ConfigManager {
    loaded = false;
    localStorageAvailable = true;
    config = {} as ConfigType;
    onModifiedListeners: Array<(key?: string) => void> = [];

    load(onLoadCompleteCb: () => void) {
        const onLoaded = (strConfig: string) => {
            let data: Record<string, unknown> = {};
            try {
                const parsed = JSON.parse(strConfig);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    data = parsed as Record<string, unknown>;
                }
            } catch (_e) {}
            this.config = util.mergeDeep({}, defaultConfig, data);
            // First-time / unset quality: migrate from highResTex or probe hardware.
            if (!Object.prototype.hasOwnProperty.call(data, "graphicsQuality")) {
                let q: ReturnType<typeof detectRecommendedQuality>;
                if (Object.prototype.hasOwnProperty.call(data, "highResTex")) {
                    q = data.highResTex ? "high" : "medium";
                } else {
                    q = detectRecommendedQuality();
                    this.config.highResTex = q === "high";
                }
                this.config.graphicsQuality = q;
                if (!Object.prototype.hasOwnProperty.call(data, "renderScale")) {
                    this.config.renderScale = defaultRenderScaleForQuality(q);
                }
            } else {
                this.config.graphicsQuality = parseGraphicsQuality(
                    this.config.graphicsQuality,
                );
            }
            this.config.renderScale = clampRenderScale(this.config.renderScale);
            // Keep legacy highResTex aligned when unset.
            if (!Object.prototype.hasOwnProperty.call(data, "highResTex")) {
                this.config.highResTex = this.config.graphicsQuality === "high";
            }
            // Seed advanced toggles from the active preset when first introduced.
            const adv = advancedDefaultsForQuality(this.config.graphicsQuality);
            if (!Object.prototype.hasOwnProperty.call(data, "ambientParticles")) {
                this.config.ambientParticles = adv.ambientParticles;
            }
            if (!Object.prototype.hasOwnProperty.call(data, "simplifyDistantNpcs")) {
                this.config.simplifyDistantNpcs = adv.simplifyDistantNpcs;
            }
            if (!Object.prototype.hasOwnProperty.call(data, "reduceSmokeFx")) {
                this.config.reduceSmokeFx = adv.reduceSmokeFx;
            }
            if (!Object.prototype.hasOwnProperty.call(data, "foliageCulling")) {
                this.config.foliageCulling = adv.foliageCulling;
            }
            if (!Object.prototype.hasOwnProperty.call(data, "uncapFps")) {
                this.config.uncapFps = false;
            }
            // Drop stale announcement snooze when version bumps.
            if (
                (this.config.announcementVersionSeen || 0) < COMMUNITY_ANNOUNCEMENT_VERSION
            ) {
                this.config.announcementHideUntil = 0;
            }
            this.checkUpgradeConfig();
            this.onModified();
            this.loaded = true;
            onLoadCompleteCb();
        };
        let storedConfig = "{}";
        try {
            storedConfig = localStorage.getItem("surviv_config") || "{}";
        } catch (_err) {
            this.localStorageAvailable = false;
        }
        onLoaded(storedConfig);
    }

    store() {
        const strData = JSON.stringify(this.config);
        if (this.localStorageAvailable) {
            // In browsers, like Safari, localStorage setItem is
            // disabled in private browsing mode.
            // This try/catch is here to handle that situation.
            try {
                localStorage.setItem("surviv_config", strData);
            } catch (_e) {}
        }
    }

    set<T extends ConfigKey>(key: T, value: ConfigType[T]) {
        if (!key) {
            return;
        }
        const path = key.split(".");

        let elem = this.config;
        while (path.length > 1) {
            // @ts-expect-error bleh
            elem = elem[path.shift()];
        }
        // @ts-expect-error bleh
        elem[path.shift()] = value;

        this.store();
        this.onModified(key);
    }

    get<T extends ConfigKey>(key: T): ConfigType[T] | undefined {
        if (!key) {
            return undefined;
        }

        const path = key.split(".");
        let elem = this.config as any;
        for (let i = 0; i < path.length; i++) {
            elem = elem[path[i]];
        }
        return elem;
    }

    addModifiedListener(e: (key?: string) => void) {
        this.onModifiedListeners.push(e);
    }

    onModified(key?: string) {
        for (let i = 0; i < this.onModifiedListeners.length; i++) {
            this.onModifiedListeners[i](key);
        }
    }

    checkUpgradeConfig() {
        // validation logic
        this.config.loadout = loadout.validate(this.config.loadout);

        // seem not to be implemeted yet
        // this.get("version");
        // // @TODO: Put upgrade code here
        // this.set("version", 1);
    }
}
