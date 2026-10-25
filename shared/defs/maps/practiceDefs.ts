import { GameConfig } from "../../gameConfig.ts";
import { util } from "../../utils/util.ts";
import type { MapDef } from "../mapDefs.ts";
import type { PartialMapDef } from "./baseDefs.ts";
import {
    SpecOps,
    SpecOpsBeach,
    SpecOpsCobalt,
    SpecOpsDesert,
    SpecOpsHalloween,
    SpecOpsPotato,
    SpecOpsSavannah,
    SpecOpsSnow,
    SpecOpsTurkey,
    SpecOpsWoods,
} from "./specOpsDefs.ts";

/**
 * Practice: one player vs 1–4 configurable bots that respawn forever.
 * Runs on the Spec Ops engine (AI brains) with waves, shop and stations
 * switched off. The player plays by survev rules: 100 HP, no armor pool,
 * survev magazines, reloads and backpack sizes.
 */
const practiceOverlay: PartialMapDef = {
    desc: {
        name: "Practice",
        icon: "img/gui/target.svg",
        buttonCss: "btn-mode-specops",
        buttonText: "Practice",
        backgroundImg: "img/main_splash.png",
    },
    gameMode: {
        maxPlayers: 1,
        killLeaderEnabled: false,
        practiceMode: true,
    },
    gameConfig: {
        // Survev backpack capacities, not the bigger Spec Ops bags.
        bagSizes: GameConfig.bagSizes,
    },
};

function practiceVariant(base: MapDef, overlay: PartialMapDef = {}): MapDef {
    return util.mergeDeep({}, base, practiceOverlay, overlay) as MapDef;
}

/** Small arena built for 1v1: no rivers, scattered rocks, trees and a few containers for cover. */
export const PracticeArena = practiceVariant(SpecOps, {
    /* STRIP_FROM_PROD_CLIENT:START */
    mapGen: {
        map: {
            baseWidth: 224,
            baseHeight: 224,
            shoreInset: 24,
            grassInset: 12,
            rivers: {
                lakes: [],
                weights: [{ weight: 1, widths: [] }],
                spawnCabins: false,
            },
        },
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: [],
        },
        densitySpawns: [
            {
                stone_01: 34,
                tree_01: 28,
                bush_01: 24,
                barrel_01: 6,
            },
        ],
        fixedSpawns: [
            {
                container_01: 2,
                container_02: 2,
                shack_01: 2,
                hut_01: 1,
            },
        ],
        randomSpawns: [],
        spawnReplacements: [{}],
        importantSpawns: [],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
});

export const PracticeSpecOps = practiceVariant(SpecOps);
export const PracticeWoods = practiceVariant(SpecOpsWoods);
export const PracticeDesert = practiceVariant(SpecOpsDesert);
export const PracticeSnow = practiceVariant(SpecOpsSnow);
export const PracticeHalloween = practiceVariant(SpecOpsHalloween);
export const PracticeCobalt = practiceVariant(SpecOpsCobalt);
export const PracticePotato = practiceVariant(SpecOpsPotato);
export const PracticeBeach = practiceVariant(SpecOpsBeach);
export const PracticeSavannah = practiceVariant(SpecOpsSavannah);
export const PracticeTurkey = practiceVariant(SpecOpsTurkey);

/** Practice maps in menu order, with their menu labels. */
export const PracticeMapPool = [
    { key: "practice_arena", label: "1v1 Arena" },
    { key: "practice_specops", label: "Spec Ops: Main" },
    { key: "practice_woods", label: "Spec Ops: Woods" },
    { key: "practice_desert", label: "Spec Ops: Desert" },
    { key: "practice_snow", label: "Spec Ops: Snow" },
    { key: "practice_halloween", label: "Spec Ops: Halloween" },
    { key: "practice_cobalt", label: "Spec Ops: Cobalt" },
    { key: "practice_potato", label: "Spec Ops: Potato" },
    { key: "practice_beach", label: "Spec Ops: Beach" },
    { key: "practice_savannah", label: "Spec Ops: Savannah" },
    { key: "practice_turkey", label: "Spec Ops: Turkey" },
] as const;

export type PracticeMapKey = (typeof PracticeMapPool)[number]["key"];

export const PracticeDefaultMap: PracticeMapKey = "practice_arena";

export function isPracticeMapName(name: string): name is PracticeMapKey {
    return PracticeMapPool.some((m) => m.key === name);
}
