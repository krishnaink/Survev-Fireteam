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

/**
 * Last Call's motel, nightclub and parking-garage survival block at night.
 * Layout: lastCallLayout.ts; art: scripts/lastcall/buildArt.ts.
 */
export const ZombieBranchingComplex = util.mergeDeep(
    {},
    ZombieIndoor,
    {
        desc: {
            name: "Zombie Survival",
            buttonText: "Last Call",
            backgroundImg: "img/main_splash.png",
        },
        assets: {
            atlases: ["gradient", "loadout", "shared", "main", "lastcall"],
        },
        biome: {
            colors: {
                background: 0x0a0910,
                water: 0x0a0910,
                waterRipple: 0x1b1826,
                beach: 0x15131c,
                riverbank: 0x15131c,
                grass: 0x15131c,
                underground: 0x0a0910,
                playerSubmerge: 0x1b1826,
                playerGhillie: 0x15131c,
            },
            // The floor art is already painted at night; don't darken props further.
            valueAdjust: 1,
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
