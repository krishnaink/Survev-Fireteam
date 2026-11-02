import { util } from "../../utils/util.ts";
import { v2 } from "../../utils/v2.ts";
import type { MapDef } from "../mapDefs.ts";
import type { PartialMapDef } from "./baseDefs.ts";
import { SpecOps } from "./specOpsDefs.ts";

/**
 * The player-facing Zombie Survival map. Legacy outdoor Spec Ops maps remain
 * registered separately, while normal survival matchmaking starts here.
 */
export const ZombieIndoor = util.mergeDeep(
    {},
    SpecOps,
    {
        desc: {
            name: "Zombie Survival",
            buttonText: "Neon Complex",
            backgroundImg: "img/main_splash.png",
        },
        gameMode: {
            indoorMode: true,
            specOpsMode: true,
            zombieMode: true,
            maxPlayers: 4,
            killLeaderEnabled: true,
        },
        biome: {
            colors: {
                background: 0x070812,
                water: 0x090b18,
                waterRipple: 0x17304c,
                beach: 0x0b0d1a,
                riverbank: 0x101326,
                grass: 0x0d1020,
                underground: 0x080811,
                playerSubmerge: 0x192947,
                playerGhillie: 0x15182d,
            },
            valueAdjust: 0.72,
        },
        mapGen: {
            map: {
                baseWidth: 128,
                baseHeight: 112,
                scale: { small: 1, large: 1 },
                extension: 0,
                shoreInset: 4,
                grassInset: 0,
                rivers: {
                    lakes: [],
                    weights: [{ weight: 1, widths: [] }],
                    spawnCabins: false,
                    masks: [],
                },
            },
            places: [
                {
                    name: "Neon Complex",
                    pos: v2.create(0.5, 0.5),
                    dontSpawnObjects: true,
                },
            ],
            customSpawnRules: {
                locationSpawns: [
                    {
                        type: "zombie_indoor_arena_01",
                        pos: v2.create(0.5, 0.5),
                        rad: 0,
                        retryOnFailure: true,
                    },
                ],
                placeSpawns: [],
            },
            densitySpawns: [{}],
            fixedSpawns: [{}],
            randomSpawns: [],
            spawnReplacements: [{}],
            importantSpawns: ["zombie_indoor_arena_01"],
        },
    } satisfies PartialMapDef,
) as MapDef;

/** Last Call's motel, nightclub and parking-garage survival block. */
export const ZombieBranchingComplex = util.mergeDeep(
    {},
    ZombieIndoor,
    {
        desc: {
            name: "Zombie Survival",
            buttonText: "Last Call",
            backgroundImg: "img/main_splash.png",
        },
        biome: {
            colors: {
                background: 0x2b241f,
                water: 0x1b2020,
                waterRipple: 0x343c39,
                beach: 0x51402d,
                riverbank: 0x3d3227,
                grass: 0x443426,
                underground: 0x171512,
                playerSubmerge: 0x363c38,
                playerGhillie: 0x4b4335,
            },
            valueAdjust: 0.78,
        },
        mapGen: {
            map: {
                baseWidth: 176,
                baseHeight: 136,
            },
            places: [
                {
                    name: "Last Call",
                    pos: v2.create(0.5, 0.5),
                    dontSpawnObjects: true,
                },
            ],
            customSpawnRules: {
                locationSpawns: [
                    {
                        type: "zombie_branching_complex_01",
                        pos: v2.create(0.5, 0.5),
                        rad: 0,
                        retryOnFailure: true,
                    },
                ],
                placeSpawns: [],
            },
            importantSpawns: ["zombie_branching_complex_01"],
        },
    } satisfies PartialMapDef,
) as MapDef;
