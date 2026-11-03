import { GameConfig } from "../../gameConfig.ts";
import { util } from "../../utils/util.ts";
import { v2 } from "../../utils/v2.ts";
import type { MapDef } from "../mapDefs.ts";
import { Main, type PartialMapDef } from "./baseDefs.ts";
import { Beach } from "./beachDefs.ts";
import { Cobalt } from "./cobaltDefs.ts";
import { Desert } from "./desertDefs.ts";
import { Halloween } from "./halloweenDefs.ts";
import { Potato } from "./potatoDefs.ts";
import { Savannah } from "./savannahDefs.ts";
import { Snow } from "./snowDefs.ts";
import { SpecOpsBotDebugMapName } from "./specOpsNpcDebug.ts";
import { SpecOpsBagSizes } from "./specOpsShop.ts";
import { Turkey } from "./turkeyDefs.ts";
import { Woods } from "./woodsDefs.ts";

const BugleAudio = [
    { name: "bugle_01", channel: "activePlayer" },
    { name: "bugle_02", channel: "activePlayer" },
    { name: "bugle_03", channel: "activePlayer" },
    { name: "bugle_01", channel: "otherPlayers" },
    { name: "bugle_02", channel: "otherPlayers" },
    { name: "bugle_03", channel: "otherPlayers" },
] as const;

/** Iconic Main-map POIs that specOpsCore previously stripped. */
const SpecOpsMainLandmarks = {
    greenhouse_01: 1,
    bunker_structure_01: 0,
    bunker_structure_02: 0,
    bunker_structure_03: 0,
    bunker_structure_04: 0,
    bunker_structure_05: 0,
    warehouse_complex_01: 1,
    mansion_structure_01: 0,
    police_01: 1,
    bank_01: 1,
    teahouse_complex_01su: 1,
} as const;

const specOpsCore: PartialMapDef = {
    mapId: GameConfig.MapId.SpecOps,
    desc: {
        name: "Fireteam",
        icon: "img/gui/target.svg",
        buttonCss: "btn-mode-specops",
        backgroundImg: "img/main_splash.png",
    },
    gameMode: {
        maxPlayers: 4,
        killLeaderEnabled: true,
        specOpsMode: true,
    },
    assets: {
        audio: [
            ...Main.assets.audio,
            ...BugleAudio,
            // turkey_shoot death FX (perk can appear in Spec Ops loot)
            { name: "cluck_01", channel: "sfx" },
            { name: "cluck_02", channel: "sfx" },
            { name: "feather_01", channel: "sfx" },
        ],
    },
    gameConfig: {
        /* STRIP_FROM_PROD_CLIENT:START */
        planes: {
            timings: [],
        },
        /* STRIP_FROM_PROD_CLIENT:END */
        bagSizes: SpecOpsBagSizes,
    },
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: ["warehouse_01", "house_red_01", "house_red_02", "barn_01"],
        },
        densitySpawns: [
            {
                stone_01: 180,
                barrel_01: 36,
                bush_01: 80,
                tree_01: 220,
                tree_13: 18,
                hedgehog_01: 10,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 8,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 5,
                hut_02: 2,
                hut_03: 2,
                outhouse_01: 5,
                warehouse_01: 3,
                barn_01: 2,
                barn_02d: 1,
                house_red_01: 3,
                house_red_02: 3,
                container_01: 5,
                container_02: 4,
                container_03: 4,
                ...SpecOpsMainLandmarks,
            },
        ],
        randomSpawns: [],
        spawnReplacements: [{}],
        importantSpawns: [
            "warehouse_complex_01",
            "police_01",
            "bank_01",
        ],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
};

function specOpsVariant(overlay: PartialMapDef): MapDef {
    return util.mergeDeep({}, Main, specOpsCore, overlay) as MapDef;
}

/** Default island / woodland-edge layout. */
export const SpecOps = specOpsVariant({});

export const SpecOpsWoods = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Woods.desc.backgroundImg ?? "img/main_splash.png",
    },
    assets: {
        audio: [...Woods.assets.audio, ...BugleAudio],
        atlases: [...Woods.assets.atlases],
    },
    biome: util.cloneDeep(Woods.biome) as MapDef["biome"],
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01: 80,
                barrel_01: 28,
                bush_01: 54,
                hedgehog_01: 10,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 7,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 5,
                hut_02: 2,
                hut_03: 2,
                outhouse_01: 5,
                warehouse_01: 2,
                barn_01: 3,
                house_red_01: 3,
                teahouse_01: 2,
                tree_07: 180,
                tree_08: 160,
                tree_09: 24,
                logging_complex_02: 1,
                logging_complex_03: 1,
                workshop_complex_01: 1,
                bunker_structure_01b: 0,
                bunker_structure_03: 0,
                bunker_structure_07: 0,
            },
        ],
        spawnReplacements: [
            {
                tree_01: "tree_07",
            },
        ],
        importantSpawns: ["logging_complex_01", "workshop_complex_01"],
        customSpawnRules: {
            locationSpawns: [
                {
                    type: "logging_complex_01",
                    pos: v2.create(0.5, 0.5),
                    rad: 200,
                    retryOnFailure: true,
                },
            ],
            placeSpawns: [],
        },
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const SpecOpsDesert = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Desert.desc.backgroundImg,
    },
    assets: {
        audio: [...Desert.assets.audio, ...BugleAudio],
        atlases: [...Desert.assets.atlases],
    },
    biome: util.cloneDeep(Desert.biome) as MapDef["biome"],
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01: 160,
                barrel_01: 40,
                silo_01: 3,
                bush_01: 50,
                tree_06: 90,
                tree_05c: 40,
                hedgehog_01: 8,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 9,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 4,
                hut_02: 2,
                outhouse_01: 4,
                warehouse_01: 3,
                barn_01: 2,
                barn_02d: 2,
                house_red_01: 3,
                house_red_02: 2,
                container_01: 6,
                container_02: 5,
                container_03: 4,
                greenhouse_02: 1,
                bunker_structure_01: 0,
                bunker_structure_03: 0,
            },
        ],
        spawnReplacements: [
            {
                tree_01: "tree_06",
                bush_01: "bush_05",
                stone_01: "stone_01b",
                stone_03: "stone_03b",
            },
        ],
        importantSpawns: [],
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: ["warehouse_01", "house_red_01", "barn_01"],
        },
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const SpecOpsSnow = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Snow.desc.backgroundImg,
    },
    assets: {
        audio: [...Snow.assets.audio, ...BugleAudio],
        atlases: [...Snow.assets.atlases],
    },
    biome: util.cloneDeep(Snow.biome) as MapDef["biome"],
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01x: 140,
                barrel_01: 28,
                bush_01x: 60,
                tree_10: 160,
                tree_11: 12,
                hedgehog_01: 8,
            },
        ],
        fixedSpawns: [
            {
                shack_01x: 8,
                shack_03a: 3,
                shack_03x: 3,
                hut_01x: 4,
                hut_02x: 2,
                hut_03: 2,
                outhouse_01x: 4,
                warehouse_01x: 2,
                barn_01x: 2,
                house_red_01x: 3,
                house_red_02x: 2,
                container_01x: 5,
                container_02: 4,
                container_03: 4,
                greenhouse_02: 1,
                bunker_structure_01: 0,
                bunker_structure_02: 0,
                bunker_structure_03: 0,
                bunker_structure_04: 0,
                bunker_structure_05: 0,
                warehouse_complex_01: 1,
                mansion_structure_01x: 0,
                police_01x: 1,
                bank_01x: 1,
                teahouse_complex_01x: 1,
            },
        ],
        spawnReplacements: [
            {
                tree_01: "tree_10",
                shack_01: "shack_01x",
                stone_03: "stone_03x",
            },
        ],
        importantSpawns: [
            "police_01x",
            "bank_01x",
            "warehouse_complex_01",
        ],
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: ["warehouse_01x", "house_red_01x", "barn_01x"],
        },
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const SpecOpsHalloween = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Halloween.desc.backgroundImg,
    },
    assets: {
        audio: [...Halloween.assets.audio, ...BugleAudio],
        atlases: [...Halloween.assets.atlases],
    },
    biome: util.cloneDeep(Halloween.biome) as MapDef["biome"],
    gameMode: {
        maxPlayers: 4,
        killLeaderEnabled: true,
        specOpsMode: true,
        spookyKillSounds: true,
    },
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01: 90,
                barrel_01: 40,
                bush_01: 50,
                cache_pumpkin_01: 18,
                cache_pumpkin_03: 18,
                hedgehog_01: 8,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 8,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 4,
                hut_02: 2,
                outhouse_01: 5,
                warehouse_01h: 2,
                barn_01h: 2,
                house_red_01h: 3,
                tree_05: 20,
                tree_07: 80,
                tree_08: 40,
                mansion_structure_02: 0,
                bunker_structure_01: 0,
                bunker_structure_03: 0,
                bunker_structure_07: 0,
                junkyard_01: 1,
            },
        ],
        spawnReplacements: [
            {
                tree_01: "tree_07",
                cabin_01: "cabin_02",
            },
        ],
        importantSpawns: ["junkyard_01"],
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: ["warehouse_01h", "house_red_01h", "barn_01h"],
        },
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const SpecOpsCobalt = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Cobalt.desc.backgroundImg,
    },
    assets: {
        audio: [...Cobalt.assets.audio, ...BugleAudio],
        atlases: [...Cobalt.assets.atlases],
    },
    biome: util.cloneDeep(Cobalt.biome) as MapDef["biome"],
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01cb: 160,
                barrel_01: 44,
                silo_01: 4,
                bush_01cb: 40,
                tree_01cb: 90,
                hedgehog_01: 16,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 8,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 4,
                hut_02: 2,
                hut_03: 2,
                outhouse_01: 4,
                warehouse_01: 3,
                barn_01: 2,
                house_red_01: 3,
                house_red_02: 2,
                container_01: 5,
                container_02: 5,
                container_03: 4,
                container_04: 3,
                bunker_structure_01: 0,
                bunker_structure_02: 0,
                bunker_structure_03: 0,
                bunker_structure_04: 0,
                bunker_structure_05: 0,
                warehouse_complex_01: 1,
                teahouse_complex_01cb: 1,
                club_complex_01: 0,
            },
        ],
        spawnReplacements: [
            {
                tree_01: "tree_01cb",
                stone_01: "stone_01cb",
                bush_01: "bush_01cb",
            },
        ],
        importantSpawns: [
            "warehouse_complex_01",
        ],
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: ["warehouse_01", "house_red_01", "barn_01"],
        },
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const SpecOpsPotato = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Potato.desc.backgroundImg ?? "img/main_splash.png",
    },
    assets: {
        audio: [...Potato.assets.audio, ...BugleAudio],
        atlases: [...Potato.assets.atlases],
    },
    biome: util.cloneDeep(Potato.biome) as MapDef["biome"],
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01: 120,
                barrel_01: 32,
                bush_01: 60,
                tree_01: 140,
                potato_01: 40,
                potato_02: 40,
                potato_03: 40,
                hedgehog_01: 8,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 8,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 5,
                hut_02: 2,
                hut_03: 2,
                outhouse_01: 4,
                warehouse_01: 2,
                barn_01: 3,
                house_red_01: 3,
                house_red_02: 2,
                greenhouse_01: 1,
                container_01: 4,
                container_02: 3,
                bunker_structure_01: 0,
                bunker_structure_02: 0,
                bunker_structure_03: 0,
                bunker_structure_04: 0,
                bunker_structure_05: 0,
                warehouse_complex_01: 1,
                mansion_structure_01: 0,
                police_01: 1,
                bank_01: 1,
            },
        ],
        importantSpawns: [
            "warehouse_complex_01",
            "police_01",
            "bank_01",
        ],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const SpecOpsBeach = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Beach.desc.backgroundImg ?? "img/main_splash.png",
    },
    assets: {
        audio: [...Beach.assets.audio, ...BugleAudio],
        atlases: [...Beach.assets.atlases],
    },
    biome: util.cloneDeep(Beach.biome) as MapDef["biome"],
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01: 100,
                barrel_01: 28,
                bush_01: 70,
                tree_01: 120,
                hedgehog_01: 8,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 9,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 6,
                hut_02: 2,
                hut_03: 2,
                outhouse_01: 4,
                warehouse_01: 2,
                barn_01: 2,
                house_red_01: 3,
                house_red_02: 2,
                container_01: 5,
                container_02: 4,
                bunker_structure_01: 0,
                bunker_structure_02: 0,
                bunker_structure_03: 0,
                bunker_structure_04: 0,
                bunker_structure_05: 0,
                warehouse_complex_01: 1,
                mansion_structure_03: 0,
                teahouse_complex_01su: 1,
            },
        ],
        spawnReplacements: [
            {
                bush_01: "bush_03",
                stone_03: "stone_03bh",
            },
        ],
        importantSpawns: ["warehouse_complex_01"],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const SpecOpsSavannah = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Savannah.desc.backgroundImg ?? "img/main_splash.png",
    },
    assets: {
        audio: [...Savannah.assets.audio, ...BugleAudio],
        atlases: [...Savannah.assets.atlases],
    },
    biome: util.cloneDeep(Savannah.biome) as MapDef["biome"],
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01: 90,
                barrel_01: 24,
                bush_01: 40,
                tree_01: 70,
                hedgehog_01: 6,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 7,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 5,
                hut_02: 2,
                outhouse_01: 4,
                warehouse_01: 2,
                barn_01: 2,
                house_red_01: 3,
                house_red_02: 2,
                container_01: 4,
                container_02: 3,
                mansion_structure_01: 0,
                bunker_structure_01sv: 0,
                bunker_structure_03: 0,
                warehouse_03sv: 1,
            },
        ],
        spawnReplacements: [
            {
                tree_01: "tree_01sv",
                bush_01: "bush_01sv",
                stone_03: "stone_03sv",
            },
        ],
        importantSpawns: [],
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: ["warehouse_01", "house_red_01", "barn_01"],
        },
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const SpecOpsTurkey = specOpsVariant({
    desc: {
        name: "Fireteam",
        backgroundImg: Turkey.desc.backgroundImg,
    },
    assets: {
        audio: [...Turkey.assets.audio, ...BugleAudio],
        atlases: [...Turkey.assets.atlases],
    },
    biome: util.cloneDeep(Turkey.biome) as MapDef["biome"],
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        densitySpawns: [
            {
                stone_01: 110,
                barrel_01: 28,
                bush_01: 55,
                tree_01: 130,
                hedgehog_01: 8,
            },
        ],
        fixedSpawns: [
            {
                shack_01: 8,
                shack_03a: 3,
                shack_03b: 3,
                hut_01: 4,
                hut_02: 2,
                outhouse_01: 4,
                warehouse_01: 2,
                barn_01: 3,
                house_red_01: 3,
                house_red_02: 2,
                greenhouse_01: 1,
                container_01: 4,
                container_02: 3,
                bunker_structure_01: 0,
                bunker_structure_02: 0,
                bunker_structure_03: 0,
                bunker_structure_04: 0,
                bunker_structure_05: 0,
                warehouse_complex_01: 1,
                mansion_structure_01: 0,
                police_01: 1,
                bank_01: 1,
            },
        ],
        spawnReplacements: [
            {
                tree_01: "tree_08",
                stone_03: "stone_03tr",
            },
        ],
        importantSpawns: [
            "warehouse_complex_01",
            "police_01",
            "bank_01",
        ],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

/** Fireteam maps: classic Spec Ops waves (soldiers) on outdoor biomes. `specops_outdoor` is "Main". */
export const FireteamMapPool = [
    "specops_outdoor",
    "specops_woods",
    "specops_desert",
    "specops_snow",
    "specops_halloween",
    "specops_cobalt",
    "specops_potato",
    "specops_beach",
    "specops_savannah",
    "specops_turkey",
] as const;

/** Zombies maps: zombie rules, indoor buy-to-progress layouts. */
export const ZombieMapPool = ["specops_complex"] as const;

/** Every player-facing survival map. */
export const SpecOpsMapPool = [...FireteamMapPool, ...ZombieMapPool] as const;

export type SpecOpsMapKey = (typeof SpecOpsMapPool)[number];

/**
 * Requests that mean "any Fireteam map". `specops` is the server-config default
 * mode map, so it keeps meaning random rather than one biome.
 */
export function isRandomFireteamMap(requested: string): boolean {
    return requested === "random" || requested === "specops";
}

export function isZombieMapName(name: string): boolean {
    return (ZombieMapPool as readonly string[]).includes(name);
}

export function isSpecOpsMapName(name: string): boolean {
    return name === "test_specops"
        || name === "specops"
        || (SpecOpsMapPool as readonly string[]).includes(name);
}

/** True when `requested` is a random Fireteam pick matching a running Fireteam map, or the exact map. */
export function specOpsMapMatches(requested: string, actual: string): boolean {
    if (!isSpecOpsMapName(actual)) return false;
    if (isRandomFireteamMap(requested)) {
        return (FireteamMapPool as readonly string[]).includes(actual);
    }
    if ((SpecOpsMapPool as readonly string[]).includes(requested)) {
        return actual === requested;
    }
    return true;
}

/** Human-readable map label for the home page, team menu and server browser. */
export function specOpsMapDisplayName(mapKey: string): string {
    if (isRandomFireteamMap(mapKey)) return "Random";
    if (mapKey === "specops_outdoor") return "Main";
    if (mapKey === "specops_complex") return "Last Call";
    const suffix = mapKey.replace(/^specops_/, "");
    if (!suffix || suffix === mapKey) return mapKey;
    return suffix.charAt(0).toUpperCase() + suffix.slice(1);
}

/** Random picks a Fireteam biome; a specific pool key plays that map. */
export function pickSpecOpsMapName(requested: string): string {
    if (requested === "test_specops" || requested === SpecOpsBotDebugMapName) return requested;
    if (isRandomFireteamMap(requested)) {
        return FireteamMapPool[util.randomInt(0, FireteamMapPool.length - 1)];
    }
    return requested;
}
