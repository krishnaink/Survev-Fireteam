import { BulletDefs } from "../../../shared/defs/gameObjects/bulletDefs.ts";
import { type GunDef, GunDefs } from "../../../shared/defs/gameObjects/gunDefs.ts";
import { SpecOpsEnemyClasses } from "../../../shared/defs/maps/specOpsNpcDebug.ts";
import {
    isSpecOpsArmorSatchel,
    parseSpecOpsDifficulty,
    shopApproachBlocked,
    specOpsAllyDamageMult,
    specOpsAllyHealth,
    SpecOpsAllyRoles,
    SpecOpsArmorSatchelCosts,
    SpecOpsArmorSatchelGear,
    SpecOpsBreakFlag,
    SpecOpsBreakTime,
    specOpsBreakVotesNeeded,
    SpecOpsBuybackArmor,
    specOpsBuybackCost,
    specOpsBuybackSlot,
    specOpsCanBuySelfRevive,
    SpecOpsCashCap,
    type SpecOpsDifficulty,
    specOpsDifficultyMods,
    specOpsEarlyStartBonus,
    SpecOpsElitePerkWave,
    specOpsEnemyGear,
    specOpsEnemyHealth,
    specOpsEventBossForWave,
    SpecOpsEventBossRotation,
    specOpsEventMiniBossForWave,
    SpecOpsEventMiniBossRotation,
    SpecOpsFinalWave,
    SpecOpsHelperGroupSize,
    SpecOpsHelperInterval,
    SpecOpsHelpersPerWave,
    SpecOpsHelperStartWave,
    SpecOpsIroncladCrawlSeconds,
    SpecOpsIroncladMirvCount,
    SpecOpsIroncladPerPlayer,
    SpecOpsIroncladWave,
    specOpsIsBreakWave,
    SpecOpsJoinLockFlag,
    SpecOpsKillBounty,
    SpecOpsMaxArmor,
    SpecOpsMaxPerks,
    SpecOpsMaxSupportUnits,
    specOpsPackBreakVotes,
    SpecOpsReviveHealth,
    specOpsScalePrice,
    specOpsSelfReviveAllowed,
    specOpsSelfReviveCost,
    SpecOpsSelfReviveSku,
    SpecOpsSentryClip,
    SpecOpsSentryLifetime,
    SpecOpsShopBySku,
    specOpsShopItemAvailable,
    specOpsShopItemCost,
    SpecOpsShopRange,
    specOpsStartingArmor,
    specOpsStartingCash,
    SpecOpsStartingHealth,
    specOpsStartingWave,
    type SpecOpsStation,
    specOpsStationFromType,
    SpecOpsStationMarkerTypes,
    SpecOpsStationTypes,
    specOpsStationUnlocked,
    specOpsUnequipPerk,
    specOpsWaveBonus,
} from "../../../shared/defs/maps/specOpsShop.ts";
import { GameObjectDefs, MapObjectDefs } from "../../../shared/defs/register.ts";
import type { ObstacleDef } from "../../../shared/defs/types/obstacle.ts";
import { GameConfig, type InventoryItem, TeamMode } from "../../../shared/gameConfig.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import {
    practiceAimErrorDeg,
    practiceArmorGear,
    type PracticeBotSettings,
    practiceDodgePerSecond,
    practiceFlipInterval,
    PracticeGuns,
    practiceKitGear,
    PracticeKitItems,
    PracticeRandomGun,
    practiceReactionSeconds,
    type PracticeSettings,
    practiceSpeedMult,
    practiceStrafeWeight,
} from "../../../shared/practice.ts";
import { type AABB, coldet } from "../../../shared/utils/coldet.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { collisionHelpers } from "../../../shared/utils/collisionHelpers.ts";
import { mapHelpers } from "../../../shared/utils/mapHelpers.ts";
import { math } from "../../../shared/utils/math.ts";
import { util } from "../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import { Config } from "../config.ts";
import type { Game } from "./game.ts";
import type { Team } from "./group.ts";
import type { Building } from "./objects/building.ts";
import type { Obstacle } from "./objects/obstacle.ts";
import type { Player } from "./objects/player.ts";
import type { Structure } from "./objects/structure.ts";
import { PracticeCombat } from "./practiceCombat.ts";
import { PracticeController, type PracticeHost } from "./practiceController.ts";
import { SpecOpsContractRunner } from "./specOpsContracts.ts";
import { inferGroundLayer, MapNavGraph, navGroundLayer, stairAtPos } from "./specOpsNav.ts";

export type SpecOpsKind = "enemy" | "ally" | "sentry";

interface BuildingStationSlot {
    building: Building;
    size: "small" | "medium" | "large";
    /** Max stations inside this building. */
    maxIndoor: number;
    /** Max stations on the exterior (0 for small buildings). */
    maxOutdoor: number;
    /** Total stations allowed for this building (1-3). */
    maxTotal: number;
    /** How many we aim to place here this match. */
    target: number;
    placedIndoor: number;
    placedOutdoor: number;
    types: Set<string>;
    distSqr: number;
}

/**
 * Small buildings: 0–1 indoor only.
 * Medium (houses): 1–2 total, indoor preferred, at most 1 outdoor.
 * Large (warehouse/barn): 1–3 total, indoor preferred, at most 1 outdoor.
 */
function stationPlanForBuilding(type: string):
    | Omit<
        BuildingStationSlot,
        "building" | "target" | "placedIndoor" | "placedOutdoor" | "types" | "distSqr"
    >
    | undefined
{
    if (
        type.includes("outhouse")
        || type.includes("container")
        || type.includes("cache")
        || type.includes("bunker")
    ) {
        return undefined;
    }
    if (
        type.includes("warehouse")
        || type.includes("barn")
        || type.includes("mansion")
        || type.includes("police")
        || type.includes("bank")
        || type.includes("club")
        || type.includes("logging")
        || type.includes("workshop")
        || type.includes("junkyard")
    ) {
        return { size: "large", maxIndoor: 3, maxOutdoor: 1, maxTotal: 3 };
    }
    if (type.includes("house") || type.includes("greenhouse") || type.includes("teahouse")) {
        return { size: "medium", maxIndoor: 2, maxOutdoor: 1, maxTotal: 2 };
    }
    if (type.includes("shack") || type.includes("hut")) {
        return { size: "small", maxIndoor: 1, maxOutdoor: 0, maxTotal: 1 };
    }
    return { size: "small", maxIndoor: 1, maxOutdoor: 0, maxTotal: 1 };
}

type EnemyClass =
    | "militia"
    | "smg"
    | "rifle"
    | "shotgun"
    | "bomber"
    | "scout"
    | "rusher"
    | "elite"
    | "suppressor"
    | "flanker"
    | "assaulter"
    | "recon"
    | "marksman"
    | "grenadier"
    | "medic"
    | "lieutenant"
    | "captain"
    | "sniper"
    | "heavy"
    | "juggernaut"
    | "pistol"
    | "lmg"
    | "dmr"
    | "raider"
    | "cqc"
    | "bugler"
    | "conscript"
    | "machine_gunner"
    | "potato_thrower"
    | "cast_iron"
    | "ironclad"
    | "cobalt_scout"
    | "cobalt_sniper"
    | "cobalt_healer"
    | "cobalt_demo"
    | "cobalt_assault"
    | "cobalt_tank"
    | "woods_king"
    | "potato_king"
    | "desert_outlaw"
    | "halloween_cursed"
    | "turkey_shooter"
    | "snow_sniper"
    | "pirate_captain"
    | "veteran"
    | "shock_trooper"
    | "gunslinger"
    | "marauder"
    | "stormer"
    | "sapper"
    | "pathfinder"
    | "berserker"
    | "enforcer"
    | "looter"
    | "farmer"
    | "straggler"
    | "ghoul"
    | "trickster"
    | "stalker"
    | "military_rifle"
    | "military_lmg"
    | "military_sniper"
    | "military_breacher"
    | "cobalt_grunt"
    | "cobalt_rifle"
    | "cobalt_support"
    | "black_ops"
    | "warlord"
    | "titan"
    | "hunter"
    | "spotter"
    | "incursor"
    | "shieldbearer"
    | "rocketeer"
    | "corsair"
    | "vanguard"
    | "nightblade"
    | "demolisher";

interface EnemyLoadout {
    name: string;
    gun: string;
    /** Optional offhand / secondary gun. */
    gunSecondary?: string;
    outfit: string;
    /** Halloween stalker disguises; one is picked at spawn. */
    outfits?: string[];
    chest: string;
    helmet: string;
    backpack: string;
    perks: string[];
    role?: string;
    range: number;
    holdRange: number;
    speedMult: number;
    turnRate: number;
    aimError: number;
    reaction: number;
    burst: number;
    burstPause: number;
    suicideVest?: boolean;
    throwsNades?: boolean;
    /** Prefer potato throwables over frags. */
    throwsPotato?: boolean;
    /** Late-game sapper: MIRV volleys instead of potatoes. */
    throwsMirv?: boolean;
    /** Smoke doors when operators hide in buildings. */
    throwsSmoke?: boolean;
    /** Call airstrikes with IR strobes (outdoor, high-tier). */
    throwsStrobe?: boolean;
    /** Near-immune to IR strobe / bomb_iron airstrikes. */
    strobeTank?: boolean;
    /** On lethal hit: down, crawl, then detonate MIRVs. */
    mirvCrawl?: boolean;
    /** Snow event: throw snowballs. */
    throwsSnowball?: boolean;
    /** On death, call in a friendly-fire airstrike that only kills enemy AI. */
    castIronWipe?: boolean;
    melee?: string;
}

/** Practice bot movement/aim numbers, derived from the panel sliders. */
interface PracticeBotTuning {
    flipMin: number;
    flipMax: number;
    dodgePerSec: number;
    aimErrorDeg: number;
    reactionSec: number;
    holdFire: boolean;
}

const PracticeBotOutfits = ["outfitCamo", "outfitKhaki", "outfitDarkShirt", "outfitWoodland"];

const Loadouts: Record<EnemyClass, EnemyLoadout> = {
    militia: {
        name: "Militia",
        gun: "m9",
        outfit: "outfitWoodland",
        chest: "",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 16,
        holdRange: 13,
        speedMult: 0.55,
        turnRate: 70,
        aimError: 26,
        reaction: 0.85,
        burst: 0.22,
        burstPause: 1.45,
    },
    smg: {
        name: "Gunner",
        gun: "mp5",
        outfit: "outfitCamo",
        chest: "",
        helmet: "helmet01",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 20,
        holdRange: 15,
        speedMult: 0.68,
        turnRate: 95,
        aimError: 20,
        reaction: 0.62,
        burst: 0.4,
        burstPause: 1.1,
    },
    rifle: {
        name: "Rifleman",
        gun: "ak47",
        outfit: "outfitWoodland",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 30,
        holdRange: 20,
        speedMult: 0.66,
        turnRate: 90,
        aimError: 16,
        reaction: 0.55,
        burst: 0.4,
        burstPause: 0.95,
        throwsSmoke: true,
    },
    shotgun: {
        name: "Breacher",
        gun: "m870",
        outfit: "outfitCamo",
        chest: "chest01",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 11,
        holdRange: 7,
        speedMult: 0.74,
        turnRate: 105,
        aimError: 18,
        reaction: 0.5,
        burst: 0.18,
        burstPause: 1.15,
    },
    bomber: {
        name: "Bomber",
        gun: "mp5",
        outfit: "outfitCamo",
        chest: "chest01",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 12,
        holdRange: 2.5,
        speedMult: 0.92,
        turnRate: 120,
        aimError: 22,
        reaction: 0.35,
        burst: 0.35,
        burstPause: 0.7,
        suicideVest: true,
    },
    scout: {
        name: "Scout",
        gun: "glock_dual",
        outfit: "outfitCamo",
        chest: "",
        helmet: "helmet01",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 14,
        holdRange: 9,
        speedMult: 0.9,
        turnRate: 125,
        aimError: 18,
        reaction: 0.35,
        burst: 0.3,
        burstPause: 0.7,
    },
    rusher: {
        name: "Rusher",
        gun: "mac10",
        outfit: "outfitWoodland",
        chest: "chest01",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 12,
        holdRange: 6,
        speedMult: 0.95,
        turnRate: 130,
        aimError: 20,
        reaction: 0.3,
        burst: 0.45,
        burstPause: 0.65,
    },
    elite: {
        name: "Elite",
        gun: "scar",
        outfit: "outfitDarkShirt",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        range: 34,
        holdRange: 18,
        speedMult: 0.7,
        turnRate: 105,
        aimError: 8,
        reaction: 0.32,
        burst: 0.45,
        burstPause: 0.75,
    },
    suppressor: {
        name: "Suppressor",
        gun: "ump9",
        outfit: "outfitCamo",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 22,
        holdRange: 14,
        speedMult: 0.72,
        turnRate: 100,
        aimError: 12,
        reaction: 0.45,
        burst: 0.35,
        burstPause: 0.9,
        throwsSmoke: true,
    },
    flanker: {
        name: "Flanker",
        gun: "vector",
        outfit: "outfitCamo",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 16,
        holdRange: 8,
        speedMult: 0.88,
        turnRate: 120,
        aimError: 16,
        reaction: 0.38,
        burst: 0.4,
        burstPause: 0.7,
    },
    assaulter: {
        name: "Assaulter",
        gun: "famas",
        outfit: "outfitWoodland",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 26,
        holdRange: 14,
        speedMult: 0.76,
        turnRate: 100,
        aimError: 12,
        reaction: 0.4,
        burst: 0.42,
        burstPause: 0.85,
    },
    sniper: {
        name: "Sniper",
        gun: "mosin",
        outfit: "outfitWoodland",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 64,
        holdRange: 44,
        speedMult: 0.48,
        turnRate: 38,
        aimError: 38,
        reaction: 1.15,
        burst: 0.08,
        burstPause: 2.15,
    },
    recon: {
        name: "Recon",
        gun: "glock_dual",
        outfit: "outfitCamo",
        chest: "chest01",
        helmet: "helmet03_recon",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        role: "recon",
        range: 15,
        holdRange: 8,
        speedMult: 0.84,
        turnRate: 115,
        aimError: 17,
        reaction: 0.4,
        burst: 0.35,
        burstPause: 0.75,
    },
    marksman: {
        name: "Marksman",
        gun: "svd",
        outfit: "outfitWoodland",
        chest: "chest02",
        helmet: "helmet03_marksman",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        role: "marksman",
        range: 44,
        holdRange: 26,
        speedMult: 0.58,
        turnRate: 60,
        aimError: 10,
        reaction: 0.75,
        burst: 0.12,
        burstPause: 1.6,
    },
    grenadier: {
        name: "Grenadier",
        gun: "mp5",
        outfit: "outfitCamo",
        chest: "chest02",
        helmet: "helmet03_grenadier",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        role: "grenadier",
        range: 18,
        holdRange: 12,
        speedMult: 0.64,
        turnRate: 85,
        aimError: 16,
        reaction: 0.55,
        burst: 0.25,
        burstPause: 1.1,
        throwsMirv: true,
        throwsNades: true,
    },
    medic: {
        name: "Medic",
        gun: "mp5",
        outfit: "outfitWoodland",
        chest: "chest02",
        helmet: "helmet04_medic",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        role: "medic",
        range: 18,
        holdRange: 12,
        speedMult: 0.62,
        turnRate: 90,
        aimError: 15,
        reaction: 0.58,
        burst: 0.32,
        burstPause: 1.05,
        throwsNades: true,
    },
    lieutenant: {
        name: "Lieutenant",
        gun: "m4a1",
        outfit: "outfitCamo",
        chest: "chest03",
        helmet: "helmet03_lt",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        role: "lieutenant",
        range: 28,
        holdRange: 15,
        speedMult: 0.6,
        turnRate: 100,
        aimError: 12,
        reaction: 0.42,
        burst: 0.45,
        burstPause: 0.85,
    },
    captain: {
        name: "Captain",
        gun: "scar",
        outfit: "outfitDarkShirt",
        chest: "chest03",
        helmet: "helmet04_captain",
        backpack: "backpack03",
        perks: ["endless_ammo"],
        role: "captain",
        range: 26,
        holdRange: 14,
        speedMult: 0.56,
        turnRate: 90,
        aimError: 11,
        reaction: 0.38,
        burst: 0.5,
        burstPause: 0.8,
    },
    heavy: {
        name: "Heavy",
        gun: "m249",
        outfit: "outfitCamo",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 26,
        holdRange: 15,
        speedMult: 0.48,
        turnRate: 70,
        aimError: 18,
        reaction: 0.65,
        burst: 0.55,
        burstPause: 1.2,
    },
    juggernaut: {
        name: "Juggernaut",
        gun: "m249",
        outfit: "outfitDarkShirt",
        chest: "chest04",
        helmet: "helmet03",
        backpack: "backpack03",
        perks: ["endless_ammo"],
        role: "last_man",
        range: 22,
        holdRange: 12,
        speedMult: 0.4,
        turnRate: 65,
        aimError: 16,
        reaction: 0.7,
        burst: 0.7,
        burstPause: 1.3,
        throwsNades: true,
        throwsStrobe: true,
    },
    pistol: {
        name: "Officer",
        gun: "m1911",
        outfit: "outfitKhaki",
        chest: "",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 18,
        holdRange: 12,
        speedMult: 0.7,
        turnRate: 100,
        aimError: 18,
        reaction: 0.5,
        burst: 0.28,
        burstPause: 0.85,
    },
    lmg: {
        name: "Gunner",
        gun: "dp28",
        outfit: "outfitCamo",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 28,
        holdRange: 16,
        speedMult: 0.5,
        turnRate: 65,
        aimError: 20,
        reaction: 0.7,
        burst: 0.85,
        burstPause: 1.35,
    },
    dmr: {
        name: "Designated Marksman",
        gun: "m39",
        outfit: "outfitWoodland",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 40,
        holdRange: 24,
        speedMult: 0.58,
        turnRate: 70,
        aimError: 11,
        reaction: 0.7,
        burst: 0.14,
        burstPause: 1.35,
    },
    raider: {
        name: "Raider",
        gun: "ot38",
        outfit: "outfitDesertCamo",
        chest: "chest01",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 16,
        holdRange: 9,
        speedMult: 0.82,
        turnRate: 115,
        aimError: 17,
        reaction: 0.4,
        burst: 0.22,
        burstPause: 0.8,
    },
    cqc: {
        name: "CQC",
        gun: "",
        outfit: "outfitDarkShirt",
        chest: "chest01",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        melee: "machete",
        range: 8,
        holdRange: 2.3,
        speedMult: 0.88,
        turnRate: 140,
        aimError: 22,
        reaction: 0.28,
        burst: 0.2,
        burstPause: 0.45,
    },
    bugler: {
        name: "Bugler",
        gun: "mp5",
        outfit: "outfitCamo",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        role: "bugler",
        range: 20,
        holdRange: 14,
        speedMult: 0.7,
        turnRate: 95,
        aimError: 16,
        reaction: 0.5,
        burst: 0.35,
        burstPause: 1.0,
    },
    conscript: {
        name: "Conscript",
        gun: "m9",
        outfit: "outfitKhaki",
        chest: "",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 13,
        holdRange: 8,
        speedMult: 0.78,
        turnRate: 85,
        aimError: 30,
        reaction: 0.95,
        burst: 0.16,
        burstPause: 1.55,
    },
    machine_gunner: {
        name: "Machine Gunner",
        gun: "pkp",
        outfit: "outfitCamo",
        chest: "chest03",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "firepower"],
        range: 32,
        holdRange: 18,
        speedMult: 0.42,
        turnRate: 55,
        aimError: 22,
        reaction: 0.75,
        burst: 1.35,
        burstPause: 1.6,
    },
    potato_thrower: {
        name: "Potato Thrower",
        gun: "m9",
        outfit: "outfitKhaki",
        chest: "",
        helmet: "",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 16,
        holdRange: 10,
        speedMult: 0.72,
        turnRate: 95,
        aimError: 20,
        reaction: 0.55,
        burst: 0.2,
        burstPause: 1.1,
        throwsPotato: true,
    },
    cast_iron: {
        name: "Cast Iron",
        gun: "mp220",
        outfit: "outfitTank",
        chest: "chest04",
        helmet: "helmet03",
        backpack: "backpack02",
        perks: ["endless_ammo", "steelskin"],
        melee: "pan",
        range: 14,
        holdRange: 6,
        speedMult: 0.38,
        turnRate: 60,
        aimError: 18,
        reaction: 0.7,
        burst: 0.35,
        burstPause: 1.4,
        castIronWipe: true,
    },
    /** Slow metal walkers summoned by late-wave IR strobe spam. */
    ironclad: {
        name: "Ironclad",
        gun: "qbb97",
        outfit: "outfitTank",
        chest: "chest03",
        helmet: "helmet02",
        backpack: "backpack02",
        // Flak tanks grenades/airstrikes; no steelskin so bullets still hurt.
        perks: ["endless_ammo", "flak_jacket"],
        melee: "pan",
        range: 22,
        holdRange: 14,
        speedMult: 0.26,
        turnRate: 42,
        aimError: 14,
        reaction: 0.65,
        burst: 0.55,
        burstPause: 1.15,
        strobeTank: true,
        mirvCrawl: true,
    },
    cobalt_scout: {
        name: "Cobalt Scout",
        gun: "vector",
        outfit: "outfitScout",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        role: "scout",
        range: 22,
        holdRange: 10,
        speedMult: 0.92,
        turnRate: 130,
        aimError: 12,
        reaction: 0.28,
        burst: 0.45,
        burstPause: 0.55,
    },
    cobalt_sniper: {
        name: "Cobalt Sniper",
        gun: "awc",
        outfit: "outfitSniper",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        role: "sniper",
        range: 70,
        holdRange: 48,
        speedMult: 0.5,
        turnRate: 40,
        aimError: 8,
        reaction: 0.85,
        burst: 0.1,
        burstPause: 1.8,
        throwsStrobe: true,
    },
    cobalt_healer: {
        name: "Cobalt Healer",
        gun: "mp5",
        outfit: "outfitMedic",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack03",
        perks: ["endless_ammo"],
        role: "healer",
        range: 20,
        holdRange: 12,
        speedMult: 0.7,
        turnRate: 100,
        aimError: 14,
        reaction: 0.4,
        burst: 0.35,
        burstPause: 0.9,
        throwsNades: true,
    },
    cobalt_demo: {
        name: "Cobalt Demo",
        gun: "saiga",
        outfit: "outfitDemo",
        chest: "chest03",
        helmet: "helmet02",
        backpack: "backpack03",
        perks: ["endless_ammo"],
        role: "demo",
        range: 18,
        holdRange: 10,
        speedMult: 0.62,
        turnRate: 90,
        aimError: 14,
        reaction: 0.45,
        burst: 0.4,
        burstPause: 1.0,
        throwsNades: true,
    },
    cobalt_assault: {
        name: "Cobalt Assault",
        gun: "an94",
        outfit: "outfitAssault",
        chest: "chest03",
        helmet: "helmet03",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        role: "assault",
        range: 30,
        holdRange: 14,
        speedMult: 0.72,
        turnRate: 110,
        aimError: 9,
        reaction: 0.32,
        burst: 0.55,
        burstPause: 0.7,
    },
    cobalt_tank: {
        name: "Cobalt Tank",
        gun: "m249",
        outfit: "outfitTank",
        chest: "chest04",
        helmet: "helmet03",
        backpack: "backpack03",
        perks: ["endless_ammo"],
        role: "tank",
        range: 24,
        holdRange: 12,
        speedMult: 0.45,
        turnRate: 70,
        aimError: 14,
        reaction: 0.5,
        burst: 0.9,
        burstPause: 1.1,
        throwsStrobe: true,
    },
    // --- Special-event unique bosses ---
    woods_king: {
        name: "Woods King",
        gun: "bar",
        gunSecondary: "usas",
        outfit: "outfitWoodsCloak",
        chest: "chest03",
        helmet: "helmet03_forest",
        backpack: "backpack03",
        perks: ["endless_ammo"],
        role: "woods_king",
        melee: "woodaxe",
        range: 28,
        holdRange: 12,
        speedMult: 0.52,
        turnRate: 75,
        aimError: 12,
        reaction: 0.4,
        burst: 0.7,
        burstPause: 1.0,
        throwsNades: true,
    },
    potato_king: {
        name: "Potato King",
        gun: "potato_cannon",
        gunSecondary: "potato_smg",
        outfit: "outfitKhaki",
        chest: "chest03",
        helmet: "helmet03_potato",
        backpack: "backpack03",
        perks: ["endless_ammo", "rare_potato"],
        range: 26,
        holdRange: 14,
        speedMult: 0.5,
        turnRate: 70,
        aimError: 10,
        reaction: 0.45,
        burst: 0.35,
        burstPause: 1.15,
        throwsPotato: true,
    },
    desert_outlaw: {
        name: "Desert Outlaw",
        gun: "model94",
        gunSecondary: "colt45_dual",
        outfit: "outfitVerde",
        chest: "chest03",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "high_velocity"],
        range: 36,
        holdRange: 18,
        speedMult: 0.62,
        turnRate: 95,
        aimError: 8,
        reaction: 0.35,
        burst: 0.2,
        burstPause: 0.85,
    },
    halloween_cursed: {
        name: "Cursed Gunman",
        gun: "m9_cursed",
        outfit: "outfitHalloweenTree",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "splinter", "martyrdom"],
        range: 20,
        holdRange: 10,
        speedMult: 0.78,
        turnRate: 120,
        aimError: 14,
        reaction: 0.3,
        burst: 0.55,
        burstPause: 0.55,
        throwsNades: true,
    },
    turkey_shooter: {
        name: "Turkey Shooter",
        gun: "m1100",
        outfit: "outfitTurkey",
        chest: "chest03",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "turkey_shoot"],
        range: 18,
        holdRange: 8,
        speedMult: 0.68,
        turnRate: 100,
        aimError: 16,
        reaction: 0.38,
        burst: 0.45,
        burstPause: 0.9,
    },
    snow_sniper: {
        name: "Snow Sniper",
        gun: "awc_winter",
        outfit: "outfitSnow",
        chest: "chest02",
        helmet: "helmet03",
        backpack: "backpack02",
        perks: ["endless_ammo", "chambered", "takedown"],
        range: 72,
        holdRange: 50,
        speedMult: 0.48,
        turnRate: 38,
        aimError: 6,
        reaction: 0.9,
        burst: 0.1,
        burstPause: 1.9,
        throwsSnowball: true,
    },
    pirate_captain: {
        name: "Pirate Captain",
        gun: "flare_gun",
        gunSecondary: "deagle_dual",
        outfit: "outfitImperial",
        chest: "chest03",
        helmet: "helmet03",
        backpack: "backpack03",
        perks: ["endless_ammo", "broken_arrow", "fabricate"],
        melee: "cutlass",
        range: 22,
        holdRange: 12,
        speedMult: 0.58,
        turnRate: 90,
        aimError: 12,
        reaction: 0.42,
        burst: 0.3,
        burstPause: 1.05,
        throwsNades: true,
    },
    // --- Late-game replacements for the wave-29 fodder ---
    veteran: {
        name: "Veteran",
        gun: "hk416",
        outfit: "outfitParma",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 32,
        holdRange: 18,
        speedMult: 0.7,
        turnRate: 100,
        aimError: 12,
        reaction: 0.42,
        burst: 0.48,
        burstPause: 0.8,
    },
    shock_trooper: {
        name: "Shock Trooper",
        gun: "mp5",
        outfit: "outfitRed",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 20,
        holdRange: 11,
        speedMult: 0.82,
        turnRate: 110,
        aimError: 16,
        reaction: 0.4,
        burst: 0.4,
        burstPause: 0.7,
    },
    gunslinger: {
        name: "Gunslinger",
        gun: "deagle_dual",
        outfit: "outfitVerde",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 22,
        holdRange: 12,
        speedMult: 0.78,
        turnRate: 120,
        aimError: 14,
        reaction: 0.32,
        burst: 0.35,
        burstPause: 0.7,
    },
    marauder: {
        name: "Marauder",
        gun: "model94",
        outfit: "outfitDesertCamo",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 28,
        holdRange: 14,
        speedMult: 0.76,
        turnRate: 105,
        aimError: 12,
        reaction: 0.36,
        burst: 0.18,
        burstPause: 0.75,
    },
    stormer: {
        name: "Stormer",
        gun: "vector",
        outfit: "outfitDarkShirt",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 18,
        holdRange: 9,
        speedMult: 0.86,
        turnRate: 125,
        aimError: 14,
        reaction: 0.3,
        burst: 0.5,
        burstPause: 0.55,
    },
    sapper: {
        name: "Sapper",
        gun: "ump9",
        outfit: "outfitDemo",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        range: 18,
        holdRange: 11,
        speedMult: 0.68,
        turnRate: 95,
        aimError: 16,
        reaction: 0.45,
        burst: 0.28,
        burstPause: 0.95,
        throwsMirv: true,
    },
    pathfinder: {
        name: "Pathfinder",
        gun: "glock_dual",
        outfit: "outfitGhillie",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 16,
        holdRange: 8,
        speedMult: 0.96,
        turnRate: 135,
        aimError: 14,
        reaction: 0.26,
        burst: 0.38,
        burstPause: 0.55,
    },
    berserker: {
        name: "Berserker",
        gun: "mac10",
        outfit: "outfitRed",
        chest: "chest01",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 12,
        holdRange: 5,
        speedMult: 1.05,
        turnRate: 140,
        aimError: 18,
        reaction: 0.22,
        burst: 0.55,
        burstPause: 0.5,
    },
    enforcer: {
        name: "Enforcer",
        gun: "spas12",
        outfit: "outfitCarbonFiber",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 13,
        holdRange: 7,
        speedMult: 0.72,
        turnRate: 110,
        aimError: 14,
        reaction: 0.38,
        burst: 0.22,
        burstPause: 0.95,
    },
    looter: {
        name: "Looter",
        gun: "ot38",
        outfit: "outfitPrisoner",
        chest: "",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 12,
        holdRange: 7,
        speedMult: 0.8,
        turnRate: 90,
        aimError: 28,
        reaction: 0.9,
        burst: 0.18,
        burstPause: 1.4,
    },
    farmer: {
        name: "Farmer",
        gun: "m870",
        outfit: "outfitWheat",
        chest: "",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 10,
        holdRange: 6,
        speedMult: 0.62,
        turnRate: 80,
        aimError: 24,
        reaction: 0.8,
        burst: 0.16,
        burstPause: 1.5,
    },
    straggler: {
        name: "Straggler",
        gun: "m9",
        outfit: "outfitKhaki",
        chest: "",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 11,
        holdRange: 7,
        speedMult: 0.7,
        turnRate: 75,
        aimError: 32,
        reaction: 1.05,
        burst: 0.14,
        burstPause: 1.7,
    },
    ghoul: {
        name: "Ghoul",
        gun: "m9",
        outfit: "outfitPumpkin",
        chest: "",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 12,
        holdRange: 6,
        speedMult: 0.88,
        turnRate: 110,
        aimError: 22,
        reaction: 0.45,
        burst: 0.28,
        burstPause: 0.9,
    },
    trickster: {
        name: "Trickster",
        gun: "glock_dual",
        outfit: "outfitJester",
        chest: "chest01",
        helmet: "",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 14,
        holdRange: 8,
        speedMult: 0.9,
        turnRate: 125,
        aimError: 16,
        reaction: 0.32,
        burst: 0.4,
        burstPause: 0.65,
    },
    stalker: {
        name: "Stalker",
        gun: "ump9",
        outfit: "outfitTreeSpooky",
        outfits: [
            "outfitTreeSpooky",
            "outfitHalloweenTree",
            "outfitStumpAxe",
            "outfitPumpkin",
            "outfitBush",
            "outfitLeafPile",
            "outfitStump",
        ],
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 20,
        holdRange: 12,
        speedMult: 0.78,
        turnRate: 105,
        aimError: 12,
        reaction: 0.4,
        burst: 0.35,
        burstPause: 0.85,
        throwsSmoke: true,
    },
    military_rifle: {
        name: "Ranger",
        gun: "m4a1",
        outfit: "outfitSpetsnaz",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 32,
        holdRange: 18,
        speedMult: 0.7,
        turnRate: 100,
        aimError: 10,
        reaction: 0.38,
        burst: 0.45,
        burstPause: 0.75,
    },
    military_lmg: {
        name: "Gunner NCO",
        gun: "m249",
        outfit: "outfitCamo",
        chest: "chest03",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "firepower"],
        range: 30,
        holdRange: 16,
        speedMult: 0.48,
        turnRate: 60,
        aimError: 16,
        reaction: 0.6,
        burst: 1.1,
        burstPause: 1.3,
    },
    military_sniper: {
        name: "Designated Marksman",
        gun: "mosin",
        outfit: "outfitGhillie",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 58,
        holdRange: 40,
        speedMult: 0.5,
        turnRate: 42,
        aimError: 10,
        reaction: 0.9,
        burst: 0.1,
        burstPause: 1.9,
        throwsStrobe: true,
    },
    military_breacher: {
        name: "Combat Engineer",
        gun: "spas12",
        outfit: "outfitSpetsnaz",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 12,
        holdRange: 6,
        speedMult: 0.76,
        turnRate: 115,
        aimError: 14,
        reaction: 0.36,
        burst: 0.2,
        burstPause: 1.0,
    },
    cobalt_grunt: {
        name: "Cobalt Grunt",
        gun: "vector",
        outfit: "outfitCobaltShell",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 18,
        holdRange: 10,
        speedMult: 0.8,
        turnRate: 115,
        aimError: 12,
        reaction: 0.34,
        burst: 0.42,
        burstPause: 0.7,
    },
    cobalt_rifle: {
        name: "Cobalt Rifle",
        gun: "an94",
        outfit: "outfitParma",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        range: 30,
        holdRange: 16,
        speedMult: 0.72,
        turnRate: 105,
        aimError: 9,
        reaction: 0.34,
        burst: 0.5,
        burstPause: 0.7,
    },
    cobalt_support: {
        name: "Cobalt Support",
        gun: "mp5",
        outfit: "outfitMedic",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        range: 20,
        holdRange: 12,
        speedMult: 0.68,
        turnRate: 100,
        aimError: 12,
        reaction: 0.4,
        burst: 0.38,
        burstPause: 0.85,
        throwsSmoke: true,
        throwsNades: true,
    },
    black_ops: {
        name: "Black Ops",
        gun: "scarssr",
        outfit: "outfitNoir",
        chest: "chest03",
        helmet: "helmet03",
        backpack: "backpack02",
        perks: ["endless_ammo", "firepower"],
        range: 34,
        holdRange: 16,
        speedMult: 0.74,
        turnRate: 110,
        aimError: 7,
        reaction: 0.26,
        burst: 0.5,
        burstPause: 0.6,
    },
    warlord: {
        name: "Warlord",
        gun: "barrett",
        gunSecondary: "deagle_dual",
        outfit: "outfitImperial",
        chest: "chest04",
        helmet: "helmet03",
        backpack: "backpack03",
        perks: ["endless_ammo", "steelskin"],
        range: 62,
        holdRange: 36,
        speedMult: 0.48,
        turnRate: 55,
        aimError: 8,
        reaction: 0.7,
        burst: 0.12,
        burstPause: 1.7,
        throwsStrobe: true,
    },
    titan: {
        name: "Titan",
        gun: "pkp",
        outfit: "outfitTank",
        chest: "chest04",
        helmet: "helmet03",
        backpack: "backpack03",
        perks: ["endless_ammo", "steelskin", "flak_jacket"],
        range: 28,
        holdRange: 12,
        speedMult: 0.4,
        turnRate: 55,
        aimError: 12,
        reaction: 0.5,
        burst: 1.1,
        burstPause: 1.15,
        throwsStrobe: true,
    },
    hunter: {
        name: "Hunter",
        gun: "awc",
        outfit: "outfitGhillie",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "targeting"],
        range: 72,
        holdRange: 50,
        speedMult: 0.52,
        turnRate: 40,
        aimError: 6,
        reaction: 0.8,
        burst: 0.08,
        burstPause: 1.85,
    },
    spotter: {
        name: "Spotter",
        gun: "mk12",
        outfit: "outfitSniper",
        chest: "chest01",
        helmet: "helmet02",
        backpack: "backpack01",
        perks: ["endless_ammo", "targeting"],
        range: 52,
        holdRange: 34,
        speedMult: 0.56,
        turnRate: 55,
        aimError: 9,
        reaction: 0.7,
        burst: 0.14,
        burstPause: 1.35,
    },
    incursor: {
        name: "Incursor",
        gun: "vector",
        outfit: "outfitNoir",
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        range: 16,
        holdRange: 8,
        speedMult: 0.92,
        turnRate: 130,
        aimError: 14,
        reaction: 0.28,
        burst: 0.48,
        burstPause: 0.55,
        throwsSmoke: true,
    },
    shieldbearer: {
        name: "Shieldbearer",
        gun: "mp220",
        outfit: "outfitTank",
        chest: "chest03",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "steelskin"],
        melee: "pan",
        range: 12,
        holdRange: 5,
        speedMult: 0.42,
        turnRate: 65,
        aimError: 18,
        reaction: 0.55,
        burst: 0.22,
        burstPause: 1.25,
    },
    rocketeer: {
        name: "Rocketeer",
        gun: "ump9",
        outfit: "outfitDemo",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        range: 20,
        holdRange: 12,
        speedMult: 0.66,
        turnRate: 90,
        aimError: 15,
        reaction: 0.48,
        burst: 0.3,
        burstPause: 1.0,
        throwsMirv: true,
        throwsNades: true,
    },
    corsair: {
        name: "Corsair",
        gun: "deagle_dual",
        outfit: "outfitImperial",
        chest: "chest02",
        helmet: "helmet01",
        backpack: "backpack01",
        perks: ["endless_ammo"],
        melee: "cutlass",
        range: 18,
        holdRange: 10,
        speedMult: 0.8,
        turnRate: 115,
        aimError: 12,
        reaction: 0.34,
        burst: 0.28,
        burstPause: 0.7,
    },
    vanguard: {
        name: "Vanguard",
        gun: "scar",
        outfit: "outfitAssault",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "firepower"],
        range: 28,
        holdRange: 14,
        speedMult: 0.72,
        turnRate: 100,
        aimError: 10,
        reaction: 0.36,
        burst: 0.5,
        burstPause: 0.7,
        throwsSmoke: true,
    },
    nightblade: {
        name: "Nightblade",
        gun: "mac10",
        outfit: "outfitNoir",
        chest: "chest01",
        helmet: "",
        backpack: "backpack00",
        perks: ["endless_ammo"],
        range: 13,
        holdRange: 6,
        speedMult: 1.02,
        turnRate: 140,
        aimError: 16,
        reaction: 0.24,
        burst: 0.5,
        burstPause: 0.5,
    },
    demolisher: {
        name: "Demolisher",
        gun: "mp5",
        outfit: "outfitDemo",
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        perks: ["endless_ammo", "splinter"],
        range: 17,
        holdRange: 10,
        speedMult: 0.64,
        turnRate: 95,
        aimError: 14,
        reaction: 0.42,
        burst: 0.32,
        burstPause: 0.9,
        throwsNades: true,
        throwsStrobe: true,
    },
};

function gunBaseType(type: string): string {
    return type.replace(/_dual$/, "");
}

const RifleGuns = ["ak47", "hk416", "scar", "m4a1", "famas"] as const;
const SmgGuns = ["mp5", "mac10", "ump9"] as const;
const Shotguns = ["m870", "mp220", "m1100"] as const;
const SniperGuns = ["mosin", "blr", "scout_elite"] as const;
const ConscriptGuns = ["m9", "ot38", "m1911"] as const;
const VeteranGuns = ["hk416", "scar", "m4a1", "groza"] as const;
const StormerGuns = ["vector", "ump9", "mac10"] as const;
const EnforcerGuns = ["spas12", "saiga", "m1100"] as const;
const ShockGuns = ["mp5", "mac10", "ump9"] as const;
const GunslingerGuns = ["deagle_dual", "p30l_dual", "colt45_dual"] as const;
const MarauderGuns = ["model94", "colt45", "bar"] as const;
const BerserkerGuns = ["mac10", "vector"] as const;

type Phase = "prep" | "combat" | "intermission";

const PrepTime = 45;
const IntermissionTime = 35;
const IntermissionCap = 50;
/** Ignore leftover E/F from the fight before shop skip is allowed. */
const ShopSkipLockTime = 2.5;
const AiTeamId = 200;
/** Reserved groupId pool for hired sentries/allies (off the operator squad HUD). */
const SpecOpsSupportGroupIdMin = 202;
const SpecOpsSupportGroupIdMax = 230;
/** Temporary team so the wave-29 executioner can actually shoot the horde. */
const GloryExecutionerTeamId = 202;
const MinSpawnDist = 32;
const MaxSpawnDist = 72;
/** Stuck NPCs teleport this far out so they do not pop up in melee range. */
const MinRelocateDist = 36;
const MaxRelocateDist = 80;
/** Split large waves into compass packs instead of one blob on the player. */
const WavePackSize = 6;
const SurroundWaveSize = 10;
/** Stagger wave spawns so the map does not flood all at once. */
const WaveSpawnFirstBatch = 5;
const WaveSpawnBatchSize = 4;
const WaveSpawnInterval = 3.5;
const WaveHordeSpawnFirstBatch = 10;
const WaveHordeSpawnBatchSize = 8;
const WaveHordeSpawnInterval = 2.75;

interface PendingWaveSpawn {
    kind: EnemyClass;
    indexInSquad: number;
    squadSize: number;
    approachAngle: number;
    host?: Player;
}
/** Dead trees come back as cover after this many completed waves. */
const TreeRegrowEveryWaves = 3;
/** If every enemy stays in search/discovery this long, they all hunt the operator. */
const HuntIfIdleTime = 9;
/** Relocate NPCs that spawn frozen or stay wedged. */
const StuckRelocateTime = 2.8;
const NavCellSize = 5;
/** Kill-farm heat added per operator kill. ~4 rapid kills maxes the rush. */
const KillHeatPerKill = 0.28;
const KillHeatDecay = 0.1;
const KillHeatCap = 1.2;
/** Wave 29: disposable fodder reclaiming glory before the wave-30 boss arrives. */
const WeakHordeClasses: ReadonlySet<EnemyClass> = new Set([
    "militia",
    "conscript",
    "pistol",
    "raider",
    "smg",
    "potato_thrower",
    "scout",
    "rusher",
    "shotgun",
    "looter",
    "farmer",
    "straggler",
    "ghoul",
]);
const GloryHelperKinds: EnemyClass[] = [
    "militia",
    "conscript",
    "looter",
    "farmer",
    "straggler",
    "pistol",
    "ghoul",
];
const GloryWipeDelay = 18;
const GloryTruceDuration = 12;

function navCellKey(pos: Vec2): number {
    const x = (Math.floor(pos.x / NavCellSize) + 1024) & 0xffff;
    const y = (Math.floor(pos.y / NavCellSize) + 1024) & 0xffff;
    return (x << 16) | y;
}

/**
 * Shared spatial memory: failed / looping cells get expensive, crowded cells
 * get expensive, so each bot takes a different progressing route.
 */
class NavField {
    fail = new Map<number, number>();
    crowd = new Map<number, number>();

    decay(dt: number): void {
        const keep = Math.exp(-dt * 0.38);
        for (const [key, value] of this.fail) {
            const next = value * keep;
            if (next < 0.12) this.fail.delete(key);
            else this.fail.set(key, next);
        }
    }

    resetCrowd(): void {
        this.crowd.clear();
    }

    occupy(pos: Vec2, weight = 1): void {
        const key = navCellKey(pos);
        this.crowd.set(key, (this.crowd.get(key) ?? 0) + weight);
    }

    failAt(pos: Vec2): number {
        return this.fail.get(navCellKey(pos)) ?? 0;
    }

    crowdAt(pos: Vec2): number {
        return this.crowd.get(navCellKey(pos)) ?? 0;
    }

    cost(pos: Vec2): number {
        return this.failAt(pos) * 6.5 + this.crowdAt(pos) * 4.2;
    }

    penalize(pos: Vec2, amount: number): void {
        const cx = Math.floor(pos.x / NavCellSize);
        const cy = Math.floor(pos.y / NavCellSize);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const w = dx === 0 && dy === 0 ? 1 : 0.4;
                const key = (((cx + dx + 1024) & 0xffff) << 16) | ((cy + dy + 1024) & 0xffff);
                this.fail.set(key, math.min(14, (this.fail.get(key) ?? 0) + amount * w));
            }
        }
    }

    penalizeToward(from: Vec2, to: Vec2, amount: number): void {
        this.penalize(from, amount);
        this.penalize(v2.lerp(0.5, from, to), amount * 0.75);
        this.penalize(to, amount * 0.9);
    }

    reward(pos: Vec2, amount: number): void {
        const key = navCellKey(pos);
        const value = this.fail.get(key);
        if (!value) return;
        const next = value - amount;
        if (next < 0.12) this.fail.delete(key);
        else this.fail.set(key, next);
    }
}

function routeJitter(id: number, pos: Vec2): number {
    const x = Math.floor(pos.x * 2);
    const y = Math.floor(pos.y * 2);
    const h = (id * 73856093) ^ (x * 19349663) ^ (y * 83492791);
    return ((h & 0xffff) / 0xffff) * 2 - 1;
}

function enemyDamageMult(wave: number, difficulty: SpecOpsDifficulty = "regular"): number {
    const early = math.clamp(0.24 + wave * 0.035, 0.24, 0.92);
    let base: number;
    if (wave <= 29) base = early;
    else {
        const mid = math.min(1.42, 0.92 + (wave - 29) * 0.03);
        if (wave < SpecOpsElitePerkWave) base = mid;
        else base = math.min(2.05, mid + 0.15 + (wave - SpecOpsElitePerkWave) * 0.038);
    }
    return base * specOpsDifficultyMods(difficulty).enemyDmg;
}

function waveAiCap(wave: number, difficulty: SpecOpsDifficulty = "regular"): number {
    let cap: number;
    if (wave <= 15) cap = 20;
    else if (wave <= 29) cap = math.min(38, 20 + Math.floor((wave - 15) * 1.35));
    else cap = math.min(52, 38 + Math.floor((wave - 30) * 0.65));
    const mods = specOpsDifficultyMods(difficulty);
    return math.clamp(Math.round(cap * mods.roster) + mods.aiCap, 6, 72);
}

/** Scale fodder / pack counts by difficulty. Unique 0-count stays 0. */
function scaleRosterCount(count: number, difficulty: SpecOpsDifficulty): number {
    if (count <= 0) return 0;
    return Math.max(1, Math.round(count * specOpsDifficultyMods(difficulty).roster));
}

const LateCombatPerks = [
    "firepower",
    "ap_rounds",
    "chambered",
    "high_velocity",
    "combat_stims",
    "steelskin",
    "flak_jacket",
    "targeting",
    "splinter",
    "windwalk",
] as const;

function lateEnemyPerks(wave: number, kind: EnemyClass): string[] {
    if (wave < SpecOpsElitePerkWave) return [];
    const extra = 1 + Math.min(3, Math.floor((wave - SpecOpsElitePerkWave) / 8));
    const out: string[] = [];
    const start = Math.abs(kind.length + wave) % LateCombatPerks.length;
    for (let i = 0; i < extra; i++) {
        const perk = LateCombatPerks[(start + i) % LateCombatPerks.length];
        if (!out.includes(perk)) out.push(perk);
    }
    return out;
}

/** Practice bot loadout: range and fire rhythm follow the chosen gun's type. */
function practiceBotLoadout(gun: string, settings: PracticeBotSettings, index: number, secondary = ""): EnemyLoadout {
    const def = GameObjectDefs.typeToDef(gun, "gun") as GunDef;
    const bulletRange = BulletDefs[def.bulletType]?.distance ?? 100;
    let range: number;
    let burst: number;
    let burstPause: number;
    if (def.bulletCount > 1) {
        // Shotguns: get close, short taps.
        range = 11;
        burst = 0.2;
        burstPause = 0.55;
    } else if (def.fireMode !== "auto" && def.fireDelay >= 0.5) {
        // Bolt-action snipers: keep distance, one shot at a time.
        range = 48;
        burst = 0.08;
        burstPause = 0.9;
    } else if (def.fireMode !== "auto") {
        // Pistols, DMRs, burst rifles.
        range = 30;
        burst = 0.3;
        burstPause = 0.45;
    } else {
        // SMGs, rifles, LMGs: longer bursts.
        range = 26;
        burst = 0.6;
        burstPause = 0.35;
    }
    range = math.min(range, bulletRange * 0.6);
    return {
        name: `Bot ${index + 1}`,
        gun,
        gunSecondary: secondary || undefined,
        melee: settings.melee,
        outfit: PracticeBotOutfits[index % PracticeBotOutfits.length],
        chest: "",
        helmet: "",
        backpack: "backpack02",
        perks: ["endless_ammo"],
        range,
        holdRange: range * 0.65,
        speedMult: practiceSpeedMult(settings.strafe),
        turnRate: 240,
        aimError: practiceAimErrorDeg(settings.accuracy),
        reaction: practiceReactionSeconds(settings.reaction),
        burst,
        burstPause,
    };
}

function pickGun(kind: EnemyClass, wave: number): string {
    const tier = Math.max(1, wave);
    if (kind === "rifle") {
        const idx = Math.min(RifleGuns.length - 1, Math.floor((tier - 1) / 3));
        return RifleGuns[util.randomInt(0, idx)];
    }
    if (kind === "smg") {
        return SmgGuns[util.randomInt(0, SmgGuns.length - 1)];
    }
    if (kind === "shotgun") {
        return Shotguns[Math.min(Shotguns.length - 1, Math.floor((tier - 1) / 4))];
    }
    if (kind === "sniper") {
        return SniperGuns[util.randomInt(0, SniperGuns.length - 1)];
    }
    if (kind === "conscript") {
        return ConscriptGuns[util.randomInt(0, ConscriptGuns.length - 1)];
    }
    if (kind === "machine_gunner") {
        const guns = ["m249", "dp28", "pkp", "qbb97"] as const;
        const idx = Math.min(guns.length - 1, Math.floor((tier - 11) / 4));
        return guns[Math.max(0, idx)];
    }
    if (kind === "veteran") {
        const idx = Math.min(VeteranGuns.length - 1, Math.floor(Math.max(0, tier - 30) / 4));
        return VeteranGuns[idx];
    }
    if (kind === "shock_trooper") {
        return ShockGuns[Math.min(ShockGuns.length - 1, Math.floor(Math.max(0, tier - 30) / 5))];
    }
    if (kind === "stormer") {
        return StormerGuns[Math.min(StormerGuns.length - 1, Math.floor(Math.max(0, tier - 30) / 6))];
    }
    if (kind === "enforcer") {
        return EnforcerGuns[Math.min(EnforcerGuns.length - 1, Math.floor(Math.max(0, tier - 30) / 5))];
    }
    if (kind === "gunslinger") {
        return GunslingerGuns[
            Math.min(
                GunslingerGuns.length - 1,
                Math.floor(Math.max(0, tier - 30) / 6),
            )
        ];
    }
    if (kind === "marauder") {
        return MarauderGuns[Math.min(MarauderGuns.length - 1, Math.floor(Math.max(0, tier - 30) / 5))];
    }
    if (kind === "berserker") {
        return BerserkerGuns[Math.min(BerserkerGuns.length - 1, Math.floor(Math.max(0, tier - 30) / 8))];
    }
    return Loadouts[kind].gun;
}

function conscriptHorde(wave: number, humans: number): number {
    if (wave < 12) return 0;
    return Math.min(10, 3 + Math.floor((wave - 12) * 0.85) + Math.max(humans, 1));
}

function shockHorde(wave: number, humans: number): number {
    if (wave <= 29) return 0;
    return Math.min(12, 4 + Math.floor((wave - 30) * 0.85) + Math.max(humans, 1));
}

function sniperCount(wave: number): number {
    if (wave < 16) return 0;
    return Math.min(4, 1 + Math.floor((wave - 16) / 3));
}

function potatoThrowerCount(wave: number, humans: number): number {
    if (wave < 3 || wave > 29) return 0;
    if (wave < 25) {
        return Math.min(2, 1 + Math.floor((wave - 3) / 8) + (humans > 1 ? 1 : 0));
    }
    return Math.min(8, 3 + Math.floor((wave - 25) * 0.55) + humans);
}

function sapperCount(wave: number, humans: number): number {
    if (wave <= 29) return 0;
    return Math.min(8, 2 + Math.floor((wave - 30) / 3) + (humans > 1 ? 1 : 0));
}

function stormerCount(wave: number): number {
    if (wave <= 29) return 0;
    return Math.min(6, 2 + Math.floor((wave - 30) / 3));
}

function berserkerCount(wave: number): number {
    if (wave <= 29) return 0;
    return Math.min(6, 2 + Math.floor((wave - 30) / 4));
}

function enforcerCount(wave: number): number {
    if (wave <= 29) return 0;
    return Math.min(5, 1 + Math.floor((wave - 30) / 5));
}

function gunslingerCount(wave: number): number {
    if (wave <= 29) return 0;
    return Math.min(4, 1 + Math.floor((wave - 30) / 6));
}

function marauderCount(wave: number): number {
    if (wave <= 29) return 0;
    return Math.min(4, 1 + Math.floor((wave - 30) / 6));
}

function pathfinderCount(wave: number): number {
    if (wave <= 29) return 0;
    return Math.min(3, 1 + Math.floor((wave - 32) / 6));
}

function veteranCount(wave: number, humans: number): number {
    if (wave <= 29) return 0;
    return Math.max(4, humans + 3 + Math.floor((wave - 29) / 2));
}

function machineGunnerCount(wave: number): number {
    if (wave < 11) return 0;
    return Math.min(5, 1 + Math.floor((wave - 11) / 3));
}

function castIronCount(wave: number): number {
    if (wave < 10) return 0;
    if (wave > 0 && wave % 10 === 0) return Math.min(2, 1 + Math.floor(wave / 30));
    if (wave >= 18) return 1;
    return 1;
}

function pushLateFodder(
    push: (kind: EnemyClass, count: number, limit?: number) => void,
    wave: number,
    humans: number,
    difficulty: SpecOpsDifficulty = "regular",
): void {
    const s = (n: number) => scaleRosterCount(n, difficulty);
    push("veteran", s(Math.min(4, veteranCount(wave, humans))));
    push("shock_trooper", s(shockHorde(wave, humans)));
    push("sapper", s(sapperCount(wave, humans)));
    push("stormer", s(stormerCount(wave)));
    push("berserker", s(berserkerCount(wave)));
    push("enforcer", s(enforcerCount(wave)));
    push("gunslinger", s(gunslingerCount(wave)));
    push("marauder", s(marauderCount(wave)));
    push("pathfinder", s(pathfinderCount(wave)));
}

function pushLateSpecialists(
    push: (kind: EnemyClass, count: number, limit?: number) => void,
    wave: number,
): void {
    if (wave >= 50) push("titan", 1);
    if (wave >= 48) push("warlord", 1);
    if (wave >= 45) push("black_ops", Math.min(2, 1 + Math.floor((wave - 45) / 6)));
    if (wave >= 48) push("hunter", 1);
    if (wave >= 35) push("cobalt_grunt", Math.min(3, 1 + Math.floor((wave - 35) / 4)));
    if (wave >= 38) push("cobalt_rifle", Math.min(2, 1 + Math.floor((wave - 38) / 6)));
    if (wave >= 40) push("cobalt_support", 1);
    if (wave >= 15) push("military_rifle", Math.min(3, 1 + Math.floor((wave - 15) / 8)));
    if (wave >= 16) push("military_sniper", 1);
    if (wave >= 18) push("military_lmg", 1);
    if (wave >= 14) push("military_breacher", 1);
    if (wave >= 12) push("stalker", 1);
    if (wave >= 8) push("trickster", 1);
}

function pushMidSpecialists(
    push: (kind: EnemyClass, count: number, limit?: number) => void,
    wave: number,
    difficulty: SpecOpsDifficulty,
): void {
    const s = (n: number) => scaleRosterCount(n, difficulty);
    if (wave >= 5) push("incursor", s(1));
    if (wave >= 6) push("nightblade", s(1));
    if (wave >= 7) push("spotter", s(1));
    if (wave >= 8) push("demolisher", s(1));
    if (wave >= 9) push("rocketeer", s(1));
    if (wave >= 10) push("vanguard", s(1));
    if (wave >= 11) push("corsair", s(1));
    if (wave >= 12) push("shieldbearer", s(1));
    if (wave >= 22 && wave <= 29) {
        push("stormer", s(1));
        if (wave >= 24) push("berserker", s(1));
        if (wave >= 26) push("gunslinger", s(1));
        if (wave >= 27) push("marauder", s(1));
    }
}

function composeWave(
    wave: number,
    humans: number,
    difficulty: SpecOpsDifficulty = "regular",
): EnemyClass[] {
    const scale = 0.7 + 0.3 * math.max(humans, 1);
    const mods = specOpsDifficultyMods(difficulty);
    const s = (n: number) => scaleRosterCount(n, difficulty);
    const cap = waveAiCap(wave, difficulty);
    const bomberSlots = wave > 0 && wave % 5 === 0 && wave !== 29
        ? s(Math.min(5, 1 + humans + Math.floor(wave / 10)))
        : 0;
    const fill = cap - bomberSlots;
    const roster: EnemyClass[] = [];

    const push = (kind: EnemyClass, count: number, limit = fill) => {
        for (let i = 0; i < count; i++) {
            if (roster.length >= limit) return;
            roster.push(kind);
        }
    };

    // Wave 29: no elites — a desperate glory horde of weak units only.
    if (wave === 29) {
        const hordeCap = math.clamp(
            Math.round(math.min(48, 40 + humans * 4) * mods.roster),
            12,
            64,
        );
        push("conscript", Math.ceil(hordeCap * 0.28), hordeCap);
        push("militia", Math.ceil(hordeCap * 0.14), hordeCap);
        push("looter", Math.ceil(hordeCap * 0.08), hordeCap);
        push("farmer", Math.ceil(hordeCap * 0.06), hordeCap);
        push("straggler", Math.ceil(hordeCap * 0.06), hordeCap);
        push("ghoul", Math.ceil(hordeCap * 0.06), hordeCap);
        push("pistol", Math.ceil(hordeCap * 0.06), hordeCap);
        push("raider", Math.ceil(hordeCap * 0.05), hordeCap);
        push("smg", Math.ceil(hordeCap * 0.08), hordeCap);
        push("potato_thrower", Math.ceil(hordeCap * 0.06), hordeCap);
        push("scout", Math.ceil(hordeCap * 0.04), hordeCap);
        push("rusher", Math.ceil(hordeCap * 0.06), hordeCap);
        push("nightblade", Math.ceil(hordeCap * 0.04), hordeCap);
        push("shotgun", hordeCap, hordeCap);
        return roster.slice(0, hordeCap);
    }

    // Boss every 10 waves; mini-boss every 7. Never mix (10 wins over 7).
    // After wave 30, Cobalt fireteams replace classic juggernaut bosses.
    // Special-event unique bosses rotate onto every boss wave.
    const eventBoss = specOpsEventBossForWave(wave);
    const eventMini = specOpsEventMiniBossForWave(wave);

    if (wave > 30 && wave % 10 === 0) {
        push("cobalt_tank", 1);
        push("cobalt_assault", 1);
        push("cobalt_demo", 1);
        push("cobalt_sniper", 1);
        push("cobalt_scout", 1);
        push("cobalt_healer", 1);
        if (eventBoss) push(eventBoss, 1);
        pushLateSpecialists(push, wave);
        pushLateFodder(push, wave, humans, difficulty);
        pushMidSpecialists(push, wave, difficulty);
        push("cast_iron", castIronCount(wave));
        push("machine_gunner", s(machineGunnerCount(wave)));
        push("heavy", s(Math.min(2, 1 + Math.floor(wave / 40))));
        push("elite", s(Math.min(3, 1 + humans)));
        push("grenadier", s(2));
        push("vanguard", s(2));
        push("shieldbearer", s(1));
    } else if (wave > 0 && wave % 10 === 0) {
        const jugs = Math.min(3, 1 + Math.floor(wave / 20));
        push("juggernaut", jugs);
        if (eventBoss) push(eventBoss, 1);
        push("captain", 1);
        push("bugler", 1);
        push("heavy", s(Math.min(2, Math.floor(wave / 20))));
        push("cast_iron", castIronCount(wave));
        push("machine_gunner", s(machineGunnerCount(wave)));
        pushMidSpecialists(push, wave, difficulty);
        if (wave >= 16) push("sniper", s(sniperCount(wave)));
        if (wave > 29) {
            pushLateFodder(push, wave, humans, difficulty);
        } else {
            push("potato_thrower", s(potatoThrowerCount(wave, humans)));
            if (wave >= 12) push("conscript", s(conscriptHorde(wave, humans)));
            if (wave > 15) push("rifle", s(Math.max(4, humans + Math.floor(wave / 5))));
        }
    } else if (wave > 0 && wave % 7 === 0) {
        push("lieutenant", 1);
        if (eventMini) push(eventMini, 1);
        push("heavy", 1);
        push("bugler", 1);
        push("cast_iron", castIronCount(wave));
        push("machine_gunner", s(machineGunnerCount(wave)));
        pushMidSpecialists(push, wave, difficulty);
        if (wave >= 14) push("marksman", 1);
        if (wave >= 21) push("medic", 1);
        if (wave >= 16) push("sniper", s(sniperCount(wave)));
        if (wave > 29) {
            pushLateSpecialists(push, wave);
            pushLateFodder(push, wave, humans, difficulty);
        } else {
            push("potato_thrower", s(potatoThrowerCount(wave, humans)));
            if (wave >= 12) push("conscript", s(conscriptHorde(wave, humans)));
            push("rifle", s(Math.max(2, humans) + (wave > 15 ? 4 : 0)));
        }
    } else if (wave > 29) {
        pushLateSpecialists(push, wave);
        pushLateFodder(push, wave, humans, difficulty);
        pushMidSpecialists(push, wave, difficulty);
        push("machine_gunner", s(machineGunnerCount(wave)));
        push("cast_iron", castIronCount(wave));
        push("medic", 1);
        push("bugler", 1);
        push("flanker", 1);
        push("cqc", 1);
        push("assaulter", s(Math.min(2, 1 + Math.floor((wave - 29) / 6))));
        push("elite", s(Math.min(2, 1 + Math.floor((wave - 29) / 8))));
        push("grenadier", s(Math.min(2, 1 + Math.floor((wave - 29) / 5))));
        push("lmg", s(Math.min(2, 1 + Math.floor(wave / 14))));
        push("dmr", 1);
        push("marksman", s(Math.min(2, Math.floor(wave / 10))));
        push("sniper", s(Math.min(3, sniperCount(wave))));
        push("heavy", s(Math.max(1, Math.floor(wave / 14))));
        push("vanguard", s(Math.min(2, 1 + Math.floor((wave - 29) / 7))));
        push("shieldbearer", s(1));
        push("rocketeer", s(Math.min(2, 1 + Math.floor((wave - 29) / 8))));
    } else {
        const late = wave > 15 ? 1.1 + (wave - 15) * 0.045 : 1;
        const base = math.min(
            cap,
            Math.round((1.8 + wave * 0.72) * scale * late * mods.roster),
        );

        if (wave <= 1) {
            push("militia", Math.min(base, s(2 + humans)));
        } else if (wave === 2) {
            push("militia", Math.ceil(base * 0.3));
            push("straggler", 1);
            push("looter", 1);
            push("pistol", 1);
            push("smg", Math.ceil(base * 0.5));
        } else if (wave <= 4) {
            push("potato_thrower", s(potatoThrowerCount(wave, humans)));
            push("pistol", 1);
            push("looter", 1);
            push("farmer", 1);
            push("raider", 1);
            push("smg", Math.ceil(base * 0.3));
            push("shotgun", Math.ceil(base * 0.2));
            push("rifle", base);
        } else if (wave <= 6) {
            push("potato_thrower", s(potatoThrowerCount(wave, humans)));
            pushMidSpecialists(push, wave, difficulty);
            push("ghoul", 1);
            push("farmer", 1);
            push("shotgun", Math.ceil(base * 0.15));
            push("smg", Math.ceil(base * 0.2));
            push("scout", 1);
            push("recon", 1);
            push("lmg", 1);
            if (wave >= 6) push("grenadier", 1);
            if (wave >= 6) push("cqc", 1);
            push("rifle", base);
        } else if (wave <= 9) {
            push("potato_thrower", s(potatoThrowerCount(wave, humans)));
            pushMidSpecialists(push, wave, difficulty);
            push("ghoul", 1);
            push("trickster", 1);
            push("recon", 1);
            push("rusher", Math.ceil(base * 0.12));
            push("flanker", 1);
            push("cqc", 1);
            push("lmg", 1);
            push("dmr", wave >= 8 ? 1 : 0);
            push("marksman", wave >= 8 ? 1 : 0);
            push("grenadier", 1);
            if (wave >= 8) push("bugler", 1);
            push("smg", Math.ceil(base * 0.2));
            push("rifle", base);
        } else if (wave <= 12) {
            push("potato_thrower", s(potatoThrowerCount(wave, humans)));
            pushMidSpecialists(push, wave, difficulty);
            push("machine_gunner", s(machineGunnerCount(wave)));
            push("cast_iron", castIronCount(wave));
            push("trickster", 1);
            push("stalker", wave >= 12 ? 1 : 0);
            push("military_breacher", wave >= 10 ? 1 : 0);
            push("medic", 1);
            push("bugler", 1);
            push("recon", 1);
            push("suppressor", 1);
            push("assaulter", 1);
            push("cqc", 1);
            push("lmg", 1);
            push("dmr", 1);
            push("grenadier", 1);
            push("marksman", 1);
            push("elite", 1);
            if (wave >= 12) push("conscript", s(conscriptHorde(wave, humans)));
            push("rifle", base);
        } else {
            push("potato_thrower", s(potatoThrowerCount(wave, humans)));
            pushMidSpecialists(push, wave, difficulty);
            if (wave >= 16) push("sniper", s(sniperCount(wave)));
            if (wave >= 12) push("conscript", s(conscriptHorde(wave, humans)));
            push("machine_gunner", s(machineGunnerCount(wave)));
            push("cast_iron", castIronCount(wave));
            push("stalker", 1);
            push("trickster", 1);
            push("military_breacher", 1);
            if (wave >= 15) push("military_rifle", s(Math.min(2, 1 + Math.floor((wave - 15) / 4))));
            if (wave >= 16) push("military_sniper", 1);
            if (wave >= 18) push("military_lmg", 1);
            push("medic", 1);
            push("bugler", 1);
            push("recon", 1);
            push("scout", 1);
            push("flanker", 1);
            push("cqc", 1);
            push("rusher", Math.ceil(base * 0.08));
            push("suppressor", 1);
            push("assaulter", s(Math.min(2, Math.floor(wave / 12))));
            push("elite", s(Math.min(2, Math.floor(wave / 14))));
            push("grenadier", Math.ceil(base * 0.1));
            push("lmg", s(Math.min(2, Math.floor(wave / 12))));
            push("dmr", 1);
            push("marksman", s(Math.min(2, Math.floor(wave / 8))));
            push("heavy", s(Math.max(1, Math.floor(wave / 12))));
            push("rifle", base);
        }
    }

    if (wave > 15 && roster.length < fill) {
        const leftover = fill - roster.length;
        if (wave > 29) {
            push("shock_trooper", Math.max(2, Math.ceil(leftover * 0.45)));
            push("veteran", leftover);
        } else {
            push("conscript", Math.max(2, Math.ceil(leftover * 0.55)));
            push("rifle", leftover);
        }
    }

    if (bomberSlots > 0) {
        push("bomber", bomberSlots, cap);
    }

    return roster.slice(0, cap);
}

function collectObstaclesOnSegment(game: Game, from: Vec2, to: Vec2): Obstacle[] {
    const objs = game.grid.intersectLineSegment(from, to);
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        obstacles.push(obj as Obstacle);
    }
    return obstacles;
}

function hasLineOfSight(game: Game, from: Player, to: Player): boolean {
    if (!util.sameLayer(from.layer, to.layer)) return false;

    const delta = v2.sub(to.pos, from.pos);
    const dist = v2.length(delta);
    if (dist < 0.5) return true;

    const dir = v2.normalizeSafe(delta);
    const obstacles = collectObstaclesOnSegment(game, from.pos, to.pos);
    const blocked = collisionHelpers.intersectSegmentDist(
        obstacles,
        from.pos,
        dir,
        dist,
        0.25,
        from.layer,
        false,
    );
    return blocked >= dist - to.rad - 0.15;
}

/** True if a reflective (metal) obstacle sits between from and to. */
function pathHitsReflectMetal(game: Game, from: Player, to: Vec2, maxDist: number): boolean {
    const delta = v2.sub(to, from.pos);
    const dist = math.min(v2.length(delta), maxDist);
    if (dist < 0.4) return false;
    const dir = v2.normalizeSafe(delta);
    const end = v2.add(from.pos, v2.mul(dir, dist));
    const obstacles = collectObstaclesOnSegment(game, from.pos, end);

    let bestDist = dist;
    let metal = false;
    for (let i = 0; i < obstacles.length; i++) {
        const o = obstacles[i];
        if (!o.active || o.dead || !o.collidable) continue;
        const def = MapObjectDefs.typeToDefSafe(o.type) as ObstacleDef | undefined;
        if (!def || def.type !== "obstacle") continue;
        const hit = collider.intersectSegment(o.collider, from.pos, end);
        if (!hit) continue;
        const d = v2.length(v2.sub(hit.point, from.pos));
        if (d < bestDist - 0.05) {
            bestDist = d;
            metal = !!def.reflectBullets;
        }
    }
    return metal;
}

/** Soft cover behind trees/bushes on the far side from the threat. */
function findCoverPos(game: Game, self: Player, threat: Player): Vec2 | undefined {
    const objs = game.grid.intersectCollider(collider.createCircle(self.pos, 24));
    let best: Vec2 | undefined;
    let bestScore = Infinity;

    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (o.dead || o.layer !== self.layer) continue;
        if (!o.type.startsWith("tree_") && !o.type.startsWith("bush_")) continue;

        const away = v2.normalizeSafe(v2.sub(o.pos, threat.pos), v2.create(1, 0));
        const coverPos = v2.add(o.pos, v2.mul(away, 2.4));
        const toThreat = v2.distance(coverPos, threat.pos);
        if (toThreat < 10) continue;

        const score = v2.distance(self.pos, coverPos) - toThreat * 0.2;
        if (score < bestScore) {
            bestScore = score;
            best = coverPos;
        }
    }
    return best;
}

/** Closed-door thickness axis: through the doorway, not along the swung leaf. */
function doorPlaneNormal(door: Obstacle): Vec2 {
    const ori = door.door?.closedOri ?? door.ori;
    return v2.rotate(v2.create(1, 0), math.oriToRad(ori));
}

function doorInwardDir(door: Obstacle, building: Building): Vec2 {
    const n = doorPlaneNormal(door);
    const toCenter = v2.sub(building.pos, door.pos);
    return v2.dot(n, toCenter) >= 0 ? n : v2.neg(n);
}

function throughDoorDir(door: Obstacle, from: Vec2, goal: Vec2): Vec2 {
    const n = doorPlaneNormal(door);
    const want = v2.sub(goal, from);
    if (v2.lengthSqr(want) < 0.04) {
        const building = door.parentBuilding;
        if (building) return doorInwardDir(door, building);
        return n;
    }
    return v2.dot(n, want) >= 0 ? n : v2.neg(n);
}

function doorFoyerPoint(door: Obstacle, building: Building, dist: number, game: Game): Vec2 {
    const inward = doorInwardDir(door, building);
    const pos = v2.add(door.pos, v2.mul(inward, dist));
    const zoom = building.zoomRegions.find((r) => r.zoomIn)?.zoomIn;
    if (zoom) {
        const pad = 1.15;
        const spanX = zoom.max.x - zoom.min.x;
        const spanY = zoom.max.y - zoom.min.y;
        if (spanX > pad * 2.2) {
            pos.x = math.clamp(pos.x, zoom.min.x + pad, zoom.max.x - pad);
        }
        if (spanY > pad * 2.2) {
            pos.y = math.clamp(pos.y, zoom.min.y + pad, zoom.max.y - pad);
        }
    }
    game.map.clampToMapBounds(pos, 6);
    return pos;
}

/** Open door blocks the straight path through the frame (wrong swing side). */
function doorBlocksCrossing(door: Obstacle, from: Vec2, goal: Vec2): boolean {
    if (!door.door?.open || !door.collidable) return false;
    const through = throughDoorDir(door, from, goal);
    const a = v2.add(door.pos, v2.mul(v2.neg(through), 2.8));
    const b = v2.add(door.pos, v2.mul(through, 2.8));
    const objs = door.game.grid.intersectLineSegment(a, b);
    for (let i = 0; i < objs.length; i++) {
        if (objs[i] === door) return true;
    }
    return false;
}

/** Match ground floor only — doors may sit on layer 0/2 while bots use either. */
const BOT_DOOR_SCAN_RAD = 3.0;
const BOT_DOOR_REACH_PAD = 0.65;
const BOT_DOOR_USE_COOLDOWN_MS = 450;

const botDoorUseState = new WeakMap<Player, { doorId: number; at: number }>();

function botDoorSameLayer(door: Obstacle, player: Player): boolean {
    return util.toGroundLayer(door.layer) === util.toGroundLayer(player.layer);
}

function botDoorReach(door: Obstacle, player: Player): number {
    return player.rad + math.max(door.interactionRad, 1.0) + BOT_DOOR_REACH_PAD;
}

function botNearDoor(door: Obstacle, player: Player): boolean {
    if (!botDoorSameLayer(door, player)) return false;
    const reach = botDoorReach(door, player);
    if (collider.intersectCircle(door.collider, player.pos, reach)) return true;
    return v2.distance(player.pos, door.pos) <= reach;
}

function botOnDoorThreshold(door: Obstacle, player: Player): boolean {
    if (!botDoorSameLayer(door, player)) return false;
    const reach = player.rad + math.max(door.interactionRad * 0.85, 0.55);
    if (collider.intersectCircle(door.collider, player.pos, reach)) return true;
    return v2.distance(player.pos, door.pos) <= reach;
}

function botDoorOnCooldown(player: Player, door: Obstacle): boolean {
    const last = botDoorUseState.get(player);
    if (!last || last.doorId !== door.__id) return false;
    return player.game.now - last.at < BOT_DOOR_USE_COOLDOWN_MS;
}

function doorOnPathToGoal(door: Obstacle, player: Player, goal: Vec2): boolean {
    const toGoal = v2.sub(goal, player.pos);
    const toDoor = v2.sub(door.pos, player.pos);
    const goalLen = v2.length(toGoal);
    if (goalLen < 0.2) return v2.length(toDoor) <= BOT_DOOR_SCAN_RAD;
    const along = v2.dot(toDoor, v2.normalizeSafe(toGoal));
    return along > -0.6 && along < goalLen + door.interactionRad + 1.2;
}

function markBotDoorUse(player: Player, door: Obstacle): void {
    botDoorUseState.set(player, { doorId: door.__id, at: player.game.now });
}

function scheduleDoorAutoClose(door: Obstacle, player?: Player): void {
    if (!door.door?.open || !door.door.autoClose) return;
    if (player && !botOnDoorThreshold(door, player)) return;
    if (door.delayedDoorTicker > 0.05) return;
    door.delayedInteraction({
        type: "close",
        delay: Math.max(door.door.autoCloseDelay, 0.8),
        player,
    });
}

function tryUseDoor(
    door: Obstacle,
    player: Player,
    goal: Vec2,
    activelyCrossing = false,
): void {
    if (!door.door || door.dead || door.door.locked) return;
    if (!botNearDoor(door, player)) return;

    if (door.door.open && doorBlocksCrossing(door, player.pos, goal)) {
        if (
            activelyCrossing
            && botOnDoorThreshold(door, player)
            && door.door.canUse
            && !door.door.slideToOpen
            && !botDoorOnCooldown(player, door)
        ) {
            door.closeDoor(player);
            if (!door.door.open && door.door.canUse) {
                door.openDoor(player);
            }
            markBotDoorUse(player, door);
        }
        return;
    }

    if (!door.door.open && door.door.canUse) {
        if (botDoorOnCooldown(player, door)) return;
        if (door.door.openOneWay) {
            const side = door.getPlayerSide(player);
            if (door.door.openOneWay !== side) return;
        }
        door.openDoor(player);
        markBotDoorUse(player, door);
        return;
    }

    if (activelyCrossing && botOnDoorThreshold(door, player)) {
        scheduleDoorAutoClose(door, player);
    }
}

function tryOpenNearbyDoors(player: Player, toward?: Vec2, stuckStrikes = 0, goal?: Vec2): void {
    const objs = player.game.grid.intersectCollider(
        collider.createCircle(player.pos, player.rad + BOT_DOOR_SCAN_RAD),
    );
    const crossGoal = goal ?? (toward
        ? v2.add(player.pos, v2.mul(toward, 6))
        : player.pos);
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!o.isDoor || !o.door || o.dead || o.door.locked) continue;
        if (!botDoorSameLayer(o, player)) continue;
        if (!botNearDoor(o, player)) continue;
        const onPath = doorOnPathToGoal(o, player, crossGoal);
        if (toward && stuckStrikes < 2 && !o.door.open && !onPath) {
            const toDoor = v2.sub(o.pos, player.pos);
            if (v2.length(toDoor) > 0.35 && v2.dot(v2.normalizeSafe(toDoor), toward) < -0.3) {
                continue;
            }
        }
        if (o.door.open) {
            if (doorBlocksCrossing(o, player.pos, crossGoal) && botOnDoorThreshold(o, player)) {
                tryUseDoor(o, player, crossGoal, true);
            } else if (onPath && botOnDoorThreshold(o, player)) {
                tryUseDoor(o, player, crossGoal, true);
            }
            continue;
        }
        tryUseDoor(o, player, crossGoal, onPath);
    }
}

function overlappingDoor(player: Player): Obstacle | undefined {
    const objs = player.game.grid.intersectCollider(
        collider.createCircle(player.pos, player.rad + 0.9),
    );
    let best: Obstacle | undefined;
    let bestPen = 0;
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!o.isDoor || !o.door || o.dead) continue;
        if (!botDoorSameLayer(o, player)) continue;
        const hit = collider.intersectCircle(o.collider, player.pos, player.rad + 0.42);
        if (hit && hit.pen > bestPen) {
            bestPen = hit.pen;
            best = o;
        } else if (!best && botOnDoorThreshold(o, player)) {
            best = o;
        }
    }
    return best;
}

function navBlocksWalking(o: Obstacle): boolean {
    if (!o.active || o.dead || !o.collidable) return false;
    if (o.isDoor && o.door?.open) return false;
    return true;
}

/** Solid obstacles for walking, including intact windows and destructible walls. */
function collectNavObstacles(game: Game, from: Vec2, to: Vec2): Obstacle[] {
    const objs = game.grid.intersectLineSegment(from, to);
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!navBlocksWalking(o)) continue;
        obstacles.push(o);
    }
    return obstacles;
}

function probeClearDistFrom(
    game: Game,
    pos: Vec2,
    dir: Vec2,
    probe: number,
    layer: number,
    pad = 0.55,
): number {
    const end = v2.add(pos, v2.mul(dir, probe));
    const objs = game.grid.intersectLineSegment(pos, end);
    let dist = probe;
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!navBlocksWalking(o) || !util.sameLayer(o.layer, layer)) continue;
        const hit = collider.intersectSegment(o.collider, pos, end);
        if (!hit) continue;
        dist = math.min(dist, math.max(v2.length(v2.sub(hit.point, pos)) - pad, 0));
    }
    return dist;
}

function probeClearDist(game: Game, from: Player, dir: Vec2, probe: number): number {
    return probeClearDistFrom(game, from.pos, dir, probe, from.layer, from.rad + 0.2);
}

function firstNavHit(game: Game, from: Player, to: Vec2): Obstacle | undefined {
    const delta = v2.sub(to, from.pos);
    const dist = v2.length(delta);
    if (dist < 0.3) return undefined;
    const dir = v2.normalizeSafe(delta);
    const end = v2.add(from.pos, v2.mul(dir, dist));
    const blockers = collectNavObstacles(game, from.pos, end);
    let best: Obstacle | undefined;
    let bestDist = dist;
    for (let i = 0; i < blockers.length; i++) {
        const o = blockers[i];
        if (!util.sameLayer(o.layer, from.layer)) continue;
        const hit = collider.intersectSegment(o.collider, from.pos, end);
        if (!hit) continue;
        const d = v2.length(v2.sub(hit.point, from.pos));
        if (d < bestDist) {
            bestDist = d;
            best = o;
        }
    }
    return best;
}

function isPathClear(game: Game, from: Player, to: Vec2, pad = 0.5): boolean {
    const delta = v2.sub(to, from.pos);
    const dist = v2.length(delta);
    if (dist < 0.3) return true;
    const dir = v2.normalizeSafe(delta);
    return probeClearDist(game, from, dir, dist) >= dist - pad;
}

function obstacleFootprint(o: Obstacle): NavAabb {
    const box = collider.toAabb(o.collider);
    return { min: box.min, max: box.max };
}

function obstacleSpan(o: Obstacle): number {
    const box = obstacleFootprint(o);
    return Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
}

/** Tangent touch points around a circle, offset slightly outward. */
function circleTangentPoints(from: Vec2, center: Vec2, rad: number): Vec2[] {
    const delta = v2.sub(center, from);
    const dist = v2.length(delta);
    const perp = v2.perp(v2.normalizeSafe(delta, v2.create(1, 0)));
    if (dist <= rad + 0.25) {
        const slide = rad + 0.55;
        return [
            v2.add(center, v2.mul(perp, slide)),
            v2.add(center, v2.mul(v2.neg(perp), slide)),
        ];
    }
    const ratio = math.clamp(rad / dist, 0, 0.98);
    const offset = Math.asin(ratio);
    const base = Math.atan2(delta.y, delta.x);
    const len = Math.sqrt(Math.max(dist * dist - rad * rad, 0.25));
    const out: Vec2[] = [];
    for (const sign of [1, -1]) {
        const ang = base + sign * offset;
        const dir = v2.create(Math.cos(ang), Math.sin(ang));
        const touch = v2.add(from, v2.mul(dir, len));
        const outward = v2.normalizeSafe(v2.sub(touch, center), perp);
        out.push(v2.add(touch, v2.mul(outward, 0.9)));
    }
    return out;
}

function pushObstacleBypass(
    o: Obstacle,
    from: Player,
    goal: Vec2,
    out: Vec2[],
): void {
    if (!navBlocksWalking(o)) return;
    const pad = from.rad + 1.45;
    const box = obstacleFootprint(o);
    const ring = expandNavAabb(box, pad);
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
    const pts: Vec2[] = [
        v2.create(ring.min.x, ring.min.y),
        v2.create(ring.max.x, ring.min.y),
        v2.create(ring.min.x, ring.max.y),
        v2.create(ring.max.x, ring.max.y),
        v2.create((ring.min.x + ring.max.x) * 0.5, ring.min.y),
        v2.create((ring.min.x + ring.max.x) * 0.5, ring.max.y),
        v2.create(ring.min.x, (ring.min.y + ring.max.y) * 0.5),
        v2.create(ring.max.x, (ring.min.y + ring.max.y) * 0.5),
        nextHullWaypoint(from.pos, goal, ring, Math.max(7, span * 0.55 + 4)),
    ];
    if (o.collider.type === collider.Type.Circle) {
        const tangents = circleTangentPoints(from.pos, o.collider.pos, o.collider.rad + pad);
        for (let i = 0; i < tangents.length; i++) pts.push(tangents[i]);
    }
    for (let i = 0; i < pts.length; i++) {
        from.game.map.clampToMapBounds(pts[i], 6);
        if (v2.distance(from.pos, pts[i]) < 1.15) continue;
        if (isPathClear(from.game, from, pts[i], 0.7)) out.push(pts[i]);
    }
}

/**
 * Fan-cast around the desired heading and pick the clearest direction that
 * still advances toward the goal. Breaks wall-push cycles.
 */
function steerAroundWalls(
    game: Game,
    from: Player,
    desired: Vec2,
    sideBias = 1,
    field?: NavField,
    aggression = 0,
): Vec2 {
    const goal = v2.normalizeSafe(desired);
    const aheadGoal = v2.add(from.pos, v2.mul(goal, 22));
    const hit = firstNavHit(game, from, aheadGoal);
    const span = hit ? obstacleSpan(hit) : 0;
    const probe = Math.max(9.5, span * 0.55 + 6) + aggression * 2.4;
    const clear = probeClearDist(game, from, goal, probe);
    if (clear >= probe - 0.35 && (!field || field.cost(v2.add(from.pos, v2.mul(goal, 3))) < 3)) {
        return goal;
    }

    // Pressed against glass / a wall: slide along it instead of nosing forward.
    const againstWall = clear < 1.7;
    const goalWeight = againstWall
        ? 0.55 + aggression * 1.35
        : 3.2 + aggression * 2.8;

    const extraDirs: Vec2[] = [];
    if (hit) {
        const pad = from.rad + 1.4;
        if (hit.collider.type === collider.Type.Circle) {
            const tangents = circleTangentPoints(
                from.pos,
                hit.collider.pos,
                hit.collider.rad + pad,
            );
            for (let i = 0; i < tangents.length; i++) {
                extraDirs.push(v2.normalizeSafe(v2.sub(tangents[i], from.pos)));
            }
        } else {
            const ring = expandNavAabb(obstacleFootprint(hit), pad);
            const around = nextHullWaypoint(from.pos, aheadGoal, ring, Math.max(7, span * 0.5 + 4));
            extraDirs.push(v2.normalizeSafe(v2.sub(around, from.pos)));
        }
    }

    let bestDir = goal;
    let bestScore = -Infinity;
    const angles = [0, 15, -15, 30, -30, 50, -50, 75, -75, 90, -90, 110, -110, 135, -135, 160, -160, 180];
    const consider = (dir: Vec2, anglePenalty: number, hullBonus: number) => {
        const dist = probeClearDist(game, from, dir, probe);
        if (dist < 0.7) return;
        const ahead = v2.add(from.pos, v2.mul(dir, math.min(dist, 4.2)));
        const mem = field ? field.cost(ahead) : 0;
        const score = dist + v2.dot(dir, goal) * goalWeight - anglePenalty - mem * 1.8 + hullBonus;
        if (score > bestScore) {
            bestScore = score;
            bestDir = dir;
        }
    };
    for (let i = 0; i < extraDirs.length; i++) {
        consider(extraDirs[i], 0, span > 4.5 ? 7.5 : 1.8);
    }
    for (let i = 0; i < angles.length; i++) {
        const ang = math.deg2rad(angles[i] * (sideBias >= 0 ? 1 : -1));
        consider(v2.normalizeSafe(v2.rotate(goal, ang)), Math.abs(angles[i]) * 0.008, 0);
    }
    return bestDir;
}

/**
 * Dedicated knife units (CQC) always fight in melee.
 * Gun bots only panic-melee when already in the operator's face — never charge
 * across the map after dumping a magazine (that ends fights early).
 */
function aiIsDedicatedMelee(enemyClass?: EnemyClass): boolean {
    return enemyClass === "cqc";
}

function aiPrimaryDry(player: Player): boolean {
    const primary = player.weapons[GameConfig.WeaponSlot.Primary];
    return !primary.type || primary.ammo <= 0;
}

function aiSecondaryHasRounds(player: Player): boolean {
    const secondary = player.weapons[GameConfig.WeaponSlot.Secondary];
    return !!secondary.type && secondary.ammo > 0;
}

function aiMagazinesEmpty(player: Player): boolean {
    return aiPrimaryDry(player) && !aiSecondaryHasRounds(player);
}

/** Panic knife only inside this center-to-center distance. */
const AiPanicMeleeProximity = 3.25;

function aiEngagesMelee(
    player: Player,
    enemyClass?: EnemyClass,
    dist = Infinity,
): boolean {
    if (aiIsDedicatedMelee(enemyClass)) return true;
    // Gun bots: only melee when both mags are dry AND already point-blank.
    return aiMagazinesEmpty(player) && dist <= AiPanicMeleeProximity;
}

/** Melee swing contact distance (center-to-center) used by AI attack + standoff. */
const AiMeleeAttackRange = 2.8;

/** Minimum center distance from a human operator so LOS and hitboxes stay clean. */
function operatorStandoffDist(self: Player, melee: boolean): number {
    const body = self.rad + GameConfig.player.radius;
    // Must sit inside AiMeleeAttackRange or knife bots orbit forever without swinging.
    return melee
        ? math.min(body + 0.25, AiMeleeAttackRange - 0.2)
        : math.max(4.5, body + 3.15);
}

/** Ring position around an operator — spread by unit id so gunners fan out. */
function operatorEngagePoint(self: Player, operator: Player, melee: boolean): Vec2 {
    const standoff = operatorStandoffDist(self, melee);
    const toSelf = v2.sub(self.pos, operator.pos);
    const dist = v2.length(toSelf);
    const slot = ((self.__id % 7) - 3) * (melee ? 0.28 : 0.38);
    const ang = (dist > 0.35
        ? Math.atan2(toSelf.y, toSelf.x)
        : ((self.__id % 8) / 8) * Math.PI * 2) + slot;
    return v2.add(
        operator.pos,
        v2.create(Math.cos(ang) * standoff, Math.sin(ang) * standoff),
    );
}

function clampDestFromOperators(
    game: Game,
    self: Player,
    dest: Vec2,
    melee: boolean,
): Vec2 {
    const standoff = operatorStandoffDist(self, melee);
    const objs = game.grid.intersectCollider(collider.createCircle(dest, standoff + 0.5));
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Player || obj === self) continue;
        const other = obj as Player;
        if (other.dead || other.specOpsAi) continue;
        if (v2.distance(dest, other.pos) < standoff - 0.15) {
            return operatorEngagePoint(self, other, melee);
        }
    }
    return dest;
}

/** Strong steer off human operators — applied even during door rushes. */
function operatorOverlapSteer(game: Game, self: Player, melee: boolean): Vec2 {
    const standoff = operatorStandoffDist(self, melee);
    const objs = game.grid.intersectCollider(collider.createCircle(self.pos, standoff + 1.2));
    let push = v2.create(0, 0);
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Player || obj === self) continue;
        const other = obj as Player;
        if (other.dead || other.specOpsAi) continue;
        const delta = v2.sub(self.pos, other.pos);
        const dist = math.max(v2.length(delta), 0.1);
        if (dist >= standoff) continue;
        const overlap = math.clamp((standoff - dist) / standoff, 0, 1);
        const toRing = v2.sub(operatorEngagePoint(self, other, melee), self.pos);
        const ringDir = v2.normalizeSafe(toRing, v2.div(delta, dist));
        const closeBoost = dist < standoff * 0.55 ? 2.4 : 1.35;
        push = v2.add(
            push,
            v2.add(
                v2.mul(v2.div(delta, dist), overlap * 2.2 * closeBoost),
                v2.mul(ringDir, overlap * 1.15),
            ),
        );
    }
    return push;
}

function crowdingSteer(game: Game, self: Player, target?: Player): Vec2 {
    const melee = self.curWeapIdx === GameConfig.WeaponSlot.Melee;
    const objs = game.grid.intersectCollider(collider.createCircle(self.pos, 4.8));
    let push = v2.create(0, 0);
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Player || obj === self) continue;
        const other = obj as Player;
        if (other.dead) continue;
        const delta = v2.sub(self.pos, other.pos);
        const dist = math.max(v2.length(delta), 0.18);
        const teammate = other.teamId === self.teamId;
        const humanOperator = !other.specOpsAi;
        if (humanOperator) {
            const standoff = operatorStandoffDist(self, melee);
            if (dist > standoff + 0.35) continue;
            const strength = ((standoff + 0.35 - dist) / (standoff + 0.35)) ** 2;
            const closeBoost = dist < standoff * 0.55 ? 2.2 : 1;
            push = v2.add(push, v2.mul(v2.div(delta, dist), strength * 2.8 * closeBoost));
            continue;
        }
        if (teammate) {
            if (dist > 3.4) continue;
            const strength = ((3.4 - dist) / 3.4) ** 2;
            push = v2.add(push, v2.mul(v2.div(delta, dist), strength * 1.55));
            continue;
        }
        if (other !== target || dist > 3.2) continue;
        const strength = ((3.2 - dist) / 3.2) ** 2;
        push = v2.add(push, v2.mul(v2.div(delta, dist), strength * 2.6));
    }
    return push;
}

function buildingContaining(game: Game, pos: Vec2, groundLayer?: number): Building | undefined {
    const objs = game.grid.intersectCollider(collider.createCircle(pos, 0.35));
    let best: Building | undefined;
    let bestArea = Infinity;
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Building) continue;
        const building = obj as Building;
        const layer = util.toGroundLayer(building.layer);
        if (groundLayer !== undefined && layer !== groundLayer) continue;
        for (let j = 0; j < building.zoomRegions.length; j++) {
            const zoomIn = building.zoomRegions[j].zoomIn;
            if (!zoomIn || !coldet.testPointAabb(pos, zoomIn.min, zoomIn.max)) continue;
            const area = (zoomIn.max.x - zoomIn.min.x) * (zoomIn.max.y - zoomIn.min.y);
            if (area < bestArea) {
                bestArea = area;
                best = building;
            }
        }
    }
    return best;
}

type Stair = Structure["stairs"][number];

function findConnectingStair(game: Game, from: Player, target: Player): Stair | undefined {
    const fromG = navGroundLayer(from.layer);
    const toG = navGroundLayer(target.layer);
    if (fromG === toG && from.layer < 2 && target.layer < 2) return undefined;

    const targetBuilding = buildingContaining(game, target.pos, toG);
    const fromBuilding = buildingContaining(game, from.pos, fromG);
    const targetHull = targetBuilding ? buildingNavHull(targetBuilding) : undefined;

    let best: Stair | undefined;
    let bestScore = Infinity;
    const structures = game.map.structures;
    for (let i = 0; i < structures.length; i++) {
        const stairs = structures[i].stairs;
        for (let j = 0; j < stairs.length; j++) {
            const stair = stairs[j];
            if (stair.lootOnly) continue;

            const dFrom = v2.distance(from.pos, stair.center);
            const dTo = v2.distance(target.pos, stair.center);

            let buildingBonus = 0;
            if (targetHull) {
                const pad = expandNavAabb(targetHull, 10);
                if (coldet.testPointAabb(stair.center, pad.min, pad.max)) {
                    const preferHere = fromBuilding === targetBuilding
                        || dFrom < 30
                        || (from.indoors && dTo < 36);
                    if (preferHere) buildingBonus = -28;
                }
            }

            const score = dFrom + dTo * 0.55 + buildingBonus;
            if (score < bestScore) {
                bestScore = score;
                best = stair;
            }
        }
    }
    return best;
}

function stairAlongHalf(stair: Stair): number {
    const size = v2.sub(stair.collision.max, stair.collision.min);
    const along = Math.abs(stair.downDir.x) > Math.abs(stair.downDir.y) ? size.x : size.y;
    return Math.max(along * 0.5, 2.2);
}

function onStairCollision(pos: Vec2, rad: number, stair: Stair): boolean {
    return coldet.testCircleAabb(pos, rad, stair.collision.min, stair.collision.max);
}

/** Walk to the near landing, then through the far end so the layer swap finishes. */
function stairWaypoint(from: Player, stair: Stair, goingDown: boolean): Vec2 {
    const up = v2.add(stair.upAabb.min, v2.mul(v2.sub(stair.upAabb.max, stair.upAabb.min), 0.5));
    const down = v2.add(stair.downAabb.min, v2.mul(v2.sub(stair.downAabb.max, stair.downAabb.min), 0.5));
    const near = goingDown ? up : down;
    const far = goingDown ? down : up;
    const through = goingDown ? stair.downDir : v2.neg(stair.downDir);
    if (from.layer >= 2 || onStairCollision(from.pos, from.rad + 0.15, stair)) {
        const past = v2.add(far, v2.mul(through, 2.0));
        from.game.map.clampToMapBounds(past, 6);
        return past;
    }
    if (v2.distance(from.pos, stair.center) < stairAlongHalf(stair) + 2.4) return far;
    if (v2.distance(from.pos, near) < 2.2) return far;
    return near;
}

function onStairTransit(player: Player, stair?: Stair): boolean {
    if (player.layer >= 2) return true;
    if (stair && onStairCollision(player.pos, player.rad + 0.12, stair)) return true;
    return !!stairAtPos(player.game, player.pos, player.rad + 0.35);
}

function nearAnyStair(game: Game, pos: Vec2, maxDist = 7): boolean {
    const structures = game.map.structures;
    for (let i = 0; i < structures.length; i++) {
        const stairs = structures[i].stairs;
        for (let j = 0; j < stairs.length; j++) {
            const stair = stairs[j];
            if (stair.lootOnly) continue;
            if (v2.distance(pos, stair.center) <= maxDist) return true;
        }
    }
    return false;
}

type NavAabb = { min: Vec2; max: Vec2 };

function buildingNavHull(building: Building): NavAabb | undefined {
    const boxes: NavAabb[] = [];
    for (let i = 0; i < building.zoomRegions.length; i++) {
        const zoomIn = building.zoomRegions[i].zoomIn;
        if (zoomIn) boxes.push(zoomIn);
    }
    if (!boxes.length) return undefined;
    return coldet.boundingAabb(boxes.map(box => ({
        min: box.min,
        max: box.max,
        type: 1,
    })) as AABB[]);
}

function expandNavAabb(aabb: NavAabb, pad: number): NavAabb {
    return {
        min: v2.create(aabb.min.x - pad, aabb.min.y - pad),
        max: v2.create(aabb.max.x + pad, aabb.max.y + pad),
    };
}

function aabbPerimeterLen(aabb: NavAabb): number {
    return 2 * ((aabb.max.x - aabb.min.x) + (aabb.max.y - aabb.min.y));
}

function projectToAabbRing(pos: Vec2, aabb: NavAabb): Vec2 {
    const inside = pos.x > aabb.min.x && pos.x < aabb.max.x
        && pos.y > aabb.min.y && pos.y < aabb.max.y;
    if (!inside) {
        return v2.create(
            math.clamp(pos.x, aabb.min.x, aabb.max.x),
            math.clamp(pos.y, aabb.min.y, aabb.max.y),
        );
    }
    const dl = pos.x - aabb.min.x;
    const dr = aabb.max.x - pos.x;
    const db = pos.y - aabb.min.y;
    const dt = aabb.max.y - pos.y;
    const nearest = Math.min(dl, dr, db, dt);
    if (nearest === dl) return v2.create(aabb.min.x, pos.y);
    if (nearest === dr) return v2.create(aabb.max.x, pos.y);
    if (nearest === db) return v2.create(pos.x, aabb.min.y);
    return v2.create(pos.x, aabb.max.y);
}

function aabbPerimeterParam(pos: Vec2, aabb: NavAabb): number {
    const p = projectToAabbRing(pos, aabb);
    const w = aabb.max.x - aabb.min.x;
    const h = aabb.max.y - aabb.min.y;
    const eps = 0.45;
    if (Math.abs(p.y - aabb.min.y) <= eps) return math.clamp(p.x - aabb.min.x, 0, w);
    if (Math.abs(p.x - aabb.max.x) <= eps) return w + math.clamp(p.y - aabb.min.y, 0, h);
    if (Math.abs(p.y - aabb.max.y) <= eps) return w + h + math.clamp(aabb.max.x - p.x, 0, w);
    return w + h + w + math.clamp(aabb.max.y - p.y, 0, h);
}

function aabbPerimeterPoint(t: number, aabb: NavAabb): Vec2 {
    const w = aabb.max.x - aabb.min.x;
    const h = aabb.max.y - aabb.min.y;
    const peri = Math.max(aabbPerimeterLen(aabb), 0.001);
    let s = t % peri;
    if (s < 0) s += peri;
    if (s <= w) return v2.create(aabb.min.x + s, aabb.min.y);
    s -= w;
    if (s <= h) return v2.create(aabb.max.x, aabb.min.y + s);
    s -= h;
    if (s <= w) return v2.create(aabb.max.x - s, aabb.max.y);
    s -= w;
    return v2.create(aabb.min.x, aabb.max.y - s);
}

function aabbHullSeparation(from: Vec2, to: Vec2, aabb: NavAabb): number {
    const peri = aabbPerimeterLen(aabb);
    const a = aabbPerimeterParam(from, aabb);
    const b = aabbPerimeterParam(to, aabb);
    const d = Math.abs(a - b);
    return Math.min(d, peri - d);
}

function nextHullWaypoint(from: Vec2, dest: Vec2, aabb: NavAabb, step = 12): Vec2 {
    const peri = aabbPerimeterLen(aabb);
    const a = aabbPerimeterParam(from, aabb);
    const b = aabbPerimeterParam(dest, aabb);
    let delta = b - a;
    while (delta > peri * 0.5) delta -= peri;
    while (delta < -peri * 0.5) delta += peri;
    if (Math.abs(delta) < 1.4) return projectToAabbRing(dest, aabb);
    const dir = delta >= 0 ? 1 : -1;
    const advance = math.clamp(Math.abs(delta), 1.6, step);
    return aabbPerimeterPoint(a + dir * advance, aabb);
}

/** Walk the exterior ring when a straight line into a large building is blocked. */
function routeAroundBuilding(from: Player, dest: Vec2, building: Building): Vec2 {
    if (isPathClear(from.game, from, dest, 0.8)) return dest;
    const hull = buildingNavHull(building);
    if (!hull) return dest;
    const pads = [5.5, 7.5, 9.5, 12, 16];
    let best: Vec2 | undefined;
    let bestScore = Infinity;
    for (let p = 0; p < pads.length; p++) {
        const ring = expandNavAabb(hull, pads[p]);
        const peri = aabbPerimeterLen(ring);
        const a = aabbPerimeterParam(from.pos, ring);
        const b = aabbPerimeterParam(dest, ring);
        let delta = b - a;
        while (delta > peri * 0.5) delta -= peri;
        while (delta < -peri * 0.5) delta += peri;
        // Beside the opening: cut in instead of circling past it.
        if (Math.abs(delta) < 5) {
            const cut = v2.lerp(0.6, from.pos, dest);
            from.game.map.clampToMapBounds(cut, 6);
            if (v2.distance(from.pos, cut) > 1.1) {
                if (isPathClear(from.game, from, cut, 0.65)) return cut;
                if (isPathClear(from.game, from, dest, 0.55)) return dest;
            }
            continue;
        }
        const dir = delta >= 0 ? 1 : -1;
        const arc = Math.min(Math.abs(delta), peri * 0.48);
        const samples = Math.max(5, Math.ceil(arc / 5));
        for (let i = 1; i <= samples; i++) {
            const along = (i / samples) * arc;
            if (along > arc - 0.5 && i > 1) break;
            const next = aabbPerimeterPoint(a + dir * along, ring);
            from.game.map.clampToMapBounds(next, 6);
            if (v2.distance(from.pos, next) < 1.4) continue;
            if (!isPathClear(from.game, from, next, 0.7)) continue;
            const score = along * 0.55 + (arc - along) * 0.2 + pads[p] * 0.12;
            if (score < bestScore) {
                bestScore = score;
                best = next;
            }
        }
    }
    return best ?? dest;
}

function buildingFixtures(building: Building, kind: "door" | "window"): Obstacle[] {
    const out: Obstacle[] = [];
    for (let i = 0; i < building.childObjects.length; i++) {
        const child = building.childObjects[i];
        if (child.__type !== ObjectType.Obstacle) continue;
        const o = child as Obstacle;
        if (kind === "door") {
            if (!o.isDoor || !o.door || o.dead || o.door.locked) continue;
            if (!o.door.open && !o.door.canUse) continue;
        } else if (!o.isWindow && !o.type.includes("window")) {
            continue;
        }
        out.push(o);
    }
    return out;
}

function openingIsExterior(fixture: Obstacle, building: Building, hull: NavAabb): boolean {
    const away = v2.normalizeSafe(v2.sub(fixture.pos, building.pos), v2.create(1, 0));
    const outside = v2.add(fixture.pos, v2.mul(away, 2.8));
    const stillInside = coldet.testPointAabb(outside, hull.min, hull.max);
    if (!stillInside) return true;
    const onHull = projectToAabbRing(fixture.pos, hull);
    return v2.distance(fixture.pos, onHull) < 2.6;
}

/** Outer doors/windows on the hull — skip interior rooms when entering. */
function entryFixtures(building: Building, kind: "door" | "window"): Obstacle[] {
    const all = buildingFixtures(building, kind);
    const hull = buildingNavHull(building);
    if (!hull || all.length <= 1) return all;
    const outer: Obstacle[] = [];
    for (let i = 0; i < all.length; i++) {
        if (openingIsExterior(all[i], building, hull)) outer.push(all[i]);
    }
    return outer.length ? outer : all;
}

/** Intact glass blocks nades; broken / open / low sills do not. */
function windowThrowReady(window: Obstacle): boolean {
    return window.dead || window.height < 1 || !window.destructible;
}

function closestFixture(fixtures: Obstacle[], from: Vec2): Obstacle | undefined {
    let best: Obstacle | undefined;
    let bestDist = Infinity;
    for (let i = 0; i < fixtures.length; i++) {
        const d = v2.distance(from, fixtures[i].pos);
        if (d < bestDist) {
            bestDist = d;
            best = fixtures[i];
        }
    }
    return best;
}

/** Prefer a door/window we can walk to around the hull, not through walls. */
function closestReachableFixture(
    fixtures: Obstacle[],
    from: Player,
    building: Building,
    approachDist: number,
): Obstacle | undefined {
    const hull = buildingNavHull(building);
    const ring = hull ? expandNavAabb(hull, 5.2) : undefined;
    let best: Obstacle | undefined;
    let bestScore = Infinity;
    for (let i = 0; i < fixtures.length; i++) {
        const fixture = fixtures[i];
        const approach = outsideApproach(fixture, building, approachDist, from.game);
        const clear = isPathClear(from.game, from, approach, 0.8);
        const along = ring
            ? aabbHullSeparation(from.pos, approach, ring)
            : v2.distance(from.pos, approach);
        const openDoor = fixture.isDoor && fixture.door?.open ? -10 : 0;
        const score = along + (clear ? 0 : 14) + openDoor;
        if (score < bestScore) {
            bestScore = score;
            best = fixture;
        }
    }
    return best;
}

/** Stand outside a door/window, away from the building center. */
function outsideApproach(
    fixture: Obstacle,
    building: Building,
    dist: number,
    game: Game,
): Vec2 {
    const away = v2.normalizeSafe(v2.sub(fixture.pos, building.pos), v2.create(1, 0));
    const side = v2.perp(away);
    const dirs = [away, side, v2.neg(side)];
    let best = v2.add(fixture.pos, v2.mul(away, dist));
    game.map.clampToMapBounds(best, 6);
    let bestScore = -Infinity;
    for (let i = 0; i < dirs.length; i++) {
        const raw = v2.add(fixture.pos, v2.mul(dirs[i], dist));
        const pos = v2.copy(raw);
        game.map.clampToMapBounds(pos, 6);
        const score = v2.distance(pos, building.pos) - v2.distance(pos, raw) * 5;
        if (score > bestScore) {
            bestScore = score;
            best = pos;
        }
    }
    return best;
}

/** Hold the window from directly outside so aim goes through the opening. */
function windowPeekSpot(window: Obstacle, building: Building, game: Game): Vec2 {
    const away = v2.normalizeSafe(v2.sub(window.pos, building.pos), v2.create(1, 0));
    const pos = v2.add(window.pos, v2.mul(away, 6.2));
    game.map.clampToMapBounds(pos, 6);
    return pos;
}

/** Land a nade just inside the opening, biased toward the hiding player. */
function interiorThrowPoint(fixture: Obstacle, building: Building, target: Player): Vec2 {
    const inward = v2.normalizeSafe(v2.sub(building.pos, fixture.pos), v2.create(1, 0));
    const inside = v2.add(fixture.pos, v2.mul(inward, 3.2));
    const biased = v2.lerp(0.25, inside, target.pos);
    if (v2.distance(fixture.pos, biased) > 12) return inside;
    return biased;
}

function isDoorCandidate(pos: Vec2, building?: Building): boolean {
    if (!building) return false;
    for (let i = 0; i < building.childObjects.length; i++) {
        const child = building.childObjects[i];
        if (child.__type !== ObjectType.Obstacle) continue;
        const door = child as Obstacle;
        if (!door.isDoor) continue;
        if (v2.distance(pos, door.pos) < 4.5) return true;
    }
    return false;
}

interface RouteBrain {
    pathSideSign: number;
    routeNoise: number;
    failedWaypoints: { pos: Vec2; ttl: number }[];
}

/**
 * MW3-style route: doors into/out of buildings, then corners around the hull,
 * then lateral detours. Shared memory + per-bot noise so they don't all
 * pick the same jammed path.
 */
function findRouteWaypoint(
    game: Game,
    from: Player,
    goal: Vec2,
    field: NavField,
    brain: RouteBrain,
): Vec2 | undefined {
    if (isPathClear(game, from, goal, 0.85) && field.cost(v2.lerp(0.4, from.pos, goal)) < 5) {
        return undefined;
    }

    const graphWp = game.specOps?.paths?.firstWaypoint(from, goal);
    const goalLayer = inferGroundLayer(game, goal, from.layer);
    const crossFloor = navGroundLayer(from.layer) !== goalLayer;
    const stairMouth = nearAnyStair(game, goal);
    if (graphWp && !stairMouth && (v2.distance(from.pos, goal) > 14 || crossFloor)) {
        let banned = false;
        for (let a = 0; a < brain.failedWaypoints.length; a++) {
            if (v2.distance(graphWp, brain.failedWaypoints[a].pos) < 2.4) {
                banned = true;
                break;
            }
        }
        const progress = v2.distance(from.pos, goal) - v2.distance(graphWp, goal);
        if (!banned && v2.distance(from.pos, graphWp) > 1.15 && progress > -1.8) {
            return graphWp;
        }
    }

    const candidates: Vec2[] = [];
    const selfBuilding = buildingContaining(game, from.pos, util.toGroundLayer(from.layer));
    const goalBuilding = buildingContaining(
        game,
        goal,
        inferGroundLayer(game, goal, from.layer),
    );
    const blocker = firstNavHit(game, from, goal);

    if (goalBuilding && goalBuilding !== selfBuilding) {
        pushDoorApproaches(goalBuilding, from, goal, candidates);
        pushBuildingCorners(goalBuilding, from, candidates);
    }
    if (selfBuilding && selfBuilding !== goalBuilding) {
        pushDoorApproaches(selfBuilding, from, goal, candidates);
    }
    if (blocker?.parentBuilding) {
        pushDoorApproaches(blocker.parentBuilding, from, goal, candidates);
        pushBuildingCorners(blocker.parentBuilding, from, candidates);
    }

    const delta = v2.sub(goal, from.pos);
    const dist = v2.length(delta);
    const dir = v2.normalizeSafe(delta);
    const clear = probeClearDist(game, from, dir, dist);
    const hitAt = v2.add(from.pos, v2.mul(dir, Math.max(clear - 0.45, 0.5)));
    const end = v2.add(from.pos, v2.mul(dir, dist));
    const blockers = collectNavObstacles(game, from.pos, end);
    for (let i = 0; i < blockers.length; i++) {
        const building = blockers[i].parentBuilding;
        if (!building) continue;
        pushDoorApproaches(building, from, goal, candidates);
        pushBuildingCorners(building, from, candidates);
    }

    const perp = v2.perp(dir);
    const backed = v2.add(hitAt, v2.mul(dir, -2.6));
    const minSide = blocker ? obstacleSpan(blocker) * 0.55 + 3 : 6;
    const radii = [8, 14, 22, 32, 42, 55].filter((r) => r >= minSide);
    if (!radii.length) radii.push(minSide + 4);
    for (let s = -1; s <= 1; s += 2) {
        for (let r = 0; r < radii.length; r++) {
            const candidate = v2.add(backed, v2.mul(perp, s * radii[r]));
            game.map.clampToMapBounds(candidate, 6);
            if (isPathClear(game, from, candidate, 0.7)) candidates.push(candidate);
        }
    }

    if (blocker) pushObstacleBypass(blocker, from, goal, candidates);
    for (let i = 0; i < blockers.length && i < 4; i++) {
        if (blockers[i] === blocker) continue;
        if (blockers[i].parentBuilding) continue;
        pushObstacleBypass(blockers[i], from, goal, candidates);
    }

    if (goalBuilding) pushBuildingHull(goalBuilding, from, goal, candidates);
    if (selfBuilding && selfBuilding !== goalBuilding) {
        pushBuildingHull(selfBuilding, from, goal, candidates);
    }
    if (blocker?.parentBuilding) {
        pushBuildingHull(blocker.parentBuilding, from, goal, candidates);
    }

    let best: Vec2 | undefined;
    let bestScore = Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const dFrom = v2.distance(from.pos, candidate);
        if (dFrom < 1.15) continue;
        if (!isPathClear(game, from, candidate, 0.75)) continue;
        let banned = false;
        for (let a = 0; a < brain.failedWaypoints.length; a++) {
            if (v2.distance(candidate, brain.failedWaypoints[a].pos) < 3.6) {
                banned = true;
                break;
            }
        }
        if (banned) continue;
        const toGoal = v2.sub(goal, candidate);
        const goalDist = v2.length(toGoal);
        const aheadDir = v2.normalizeSafe(toGoal);
        const ahead = probeClearDistFrom(
            game,
            candidate,
            aheadDir,
            Math.min(goalDist, blocker ? Math.max(12, obstacleSpan(blocker) * 0.7 + 8) : 12),
            from.layer,
            0.55,
        );
        const viaDoor = isDoorCandidate(candidate, blocker?.parentBuilding)
            || isDoorCandidate(candidate, goalBuilding)
            || isDoorCandidate(candidate, selfBuilding);
        const farSide = viaDoor && v2.distance(candidate, from.pos) > 2.2;
        const doorBonus = viaDoor ? (blocker?.isWindow ? 22 : farSide ? 26 : 12) : 0;
        const aroundObs = blocker
            && !blocker.parentBuilding
            && obstacleSpan(blocker) > 4.2
            && v2.distance(candidate, blocker.pos) < obstacleSpan(blocker) + 6;
        const bypassBonus = aroundObs ? 9 : 0;
        const sidePref = v2.dot(perp, v2.sub(candidate, from.pos)) * brain.pathSideSign * 0.35;
        const score = dFrom * (viaDoor ? 0.28 : 0.55)
            + goalDist
            - ahead * 0.9
            - doorBonus
            - bypassBonus
            - sidePref
            + field.cost(candidate)
            + routeJitter(from.__id, candidate) * (2.2 + brain.routeNoise * 3.5);
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}

function pushDoorApproaches(building: Building, from: Player, goal: Vec2, out: Vec2[]): void {
    for (let i = 0; i < building.childObjects.length; i++) {
        const child = building.childObjects[i];
        if (child.__type !== ObjectType.Obstacle) continue;
        const door = child as Obstacle;
        if (!door.isDoor || !door.door) continue;
        if (door.door.locked) continue;
        if (!door.door.open && !door.door.canUse) continue;
        const inward = doorInwardDir(door, building);
        const fromInside = v2.dot(inward, v2.sub(from.pos, door.pos)) > 0.2;
        const approach = fromInside ? inward : v2.neg(inward);
        // Stay clear of the door collider on the approach side.
        out.push(v2.add(door.pos, v2.mul(approach, 2.6)));
        out.push(v2.add(door.pos, v2.mul(approach, 3.6)));
        if (!door.door.open) continue;
        const through = throughDoorDir(door, from.pos, goal);
        if (v2.dot(through, inward) > 0) {
            out.push(doorFoyerPoint(door, building, 3.4, from.game));
            out.push(doorFoyerPoint(door, building, 4.8, from.game));
        } else {
            const foyer = v2.add(door.pos, v2.mul(through, 3.4));
            const deep = v2.add(door.pos, v2.mul(through, 4.8));
            from.game.map.clampToMapBounds(foyer, 6);
            from.game.map.clampToMapBounds(deep, 6);
            out.push(foyer);
            out.push(deep);
        }
    }
}

function pushBuildingCorners(building: Building, from: Player, out: Vec2[]): void {
    const region = building.zoomRegions.find((r) => r.zoomIn)?.zoomIn;
    if (!region) return;
    const pad = 3.5;
    const cx = (region.min.x + region.max.x) * 0.5;
    const cy = (region.min.y + region.max.y) * 0.5;
    const pts = [
        v2.create(region.min.x - pad, region.min.y - pad),
        v2.create(region.max.x + pad, region.min.y - pad),
        v2.create(region.min.x - pad, region.max.y + pad),
        v2.create(region.max.x + pad, region.max.y + pad),
        v2.create(cx, region.min.y - pad),
        v2.create(cx, region.max.y + pad),
        v2.create(region.min.x - pad, cy),
        v2.create(region.max.x + pad, cy),
    ];
    for (let i = 0; i < pts.length; i++) {
        from.game.map.clampToMapBounds(pts[i], 6);
        if (isPathClear(from.game, from, pts[i], 0.7)) out.push(pts[i]);
    }
}

function pushBuildingHull(
    building: Building,
    from: Player,
    goal: Vec2,
    out: Vec2[],
): void {
    const hull = buildingNavHull(building);
    if (!hull) {
        pushBuildingCorners(building, from, out);
        return;
    }
    const ring = expandNavAabb(hull, 5.2);
    const w = ring.max.x - ring.min.x;
    const h = ring.max.y - ring.min.y;
    const peri = aabbPerimeterLen(ring);
    const samples = Math.max(8, Math.ceil(peri / 10));
    for (let i = 0; i < samples; i++) {
        const pt = aabbPerimeterPoint((i / samples) * peri, ring);
        from.game.map.clampToMapBounds(pt, 6);
        if (isPathClear(from.game, from, pt, 0.7)) out.push(pt);
    }
    const around = nextHullWaypoint(from.pos, goal, ring, 12);
    from.game.map.clampToMapBounds(around, 6);
    if (isPathClear(from.game, from, around, 0.7)) out.push(around);
    // Keep the old corner samples for small houses.
    if (w < 36 && h < 28) pushBuildingCorners(building, from, out);
}

function inSearchFov(aimDir: Vec2, toTarget: Vec2, fovDot: number): boolean {
    const desired = v2.normalizeSafe(toTarget);
    return v2.dot(aimDir, desired) >= fovDot;
}

class AiBrain {
    player: Player;
    loadout: EnemyLoadout;
    kind: SpecOpsKind;
    enemyClass?: EnemyClass;
    aimDir = v2.create(1, 0);
    target?: Player;
    acquireTicker = 0;
    burstTicker = 0;
    pauseTicker = util.random(0.2, 0.8);
    shooting = false;
    strafeSign = Math.random() < 0.5 ? 1 : -1;
    strafeFlipTicker = util.random(0.6, 1.6);
    stuckTicker = 0;
    lastPos = v2.create(0, 0);
    wanderDir = v2.create(1, 0);
    wanderTicker = 0;
    removeTicker = -1;
    waveScale = 1;
    lifetime = -1;
    age = 0;
    baseRange: number;
    fovDot: number;
    coverPos?: Vec2;
    coverRefreshTicker = 0;
    pathSideSign = Math.random() < 0.5 ? 1 : -1;
    crawlExplodeTicker = -1;
    alerted = false;
    /** Most Wanted: ignore FOV until proximity or damage. */
    roamOnly = false;
    investigatePos?: Vec2;
    detourPos?: Vec2;
    stuckStrikes = 0;
    routeRefreshTicker = 0;
    lookScanTicker = util.random(0.4, 1.2);
    lookScanSign = Math.random() < 0.5 ? 1 : -1;
    searchFovDot = 0.55;
    routeNoise = Math.random();
    holdJitter = util.random(-2.4, 2.8);
    trail: Vec2[] = [];
    trailTicker = 0;
    lastStepDir = v2.create(1, 0);
    failedWaypoints: { pos: Vec2; ttl: number }[] = [];
    idleTicker = 0;
    idleSample = v2.create(0, 0);
    idleCheckTicker = 0;
    relocateCooldown = 0;
    nadeCooldown = util.random(1.6, 3.2);
    nadeCookTicker = 0;
    nadeState: "idle" | "cooking" | "thrown" = "idle";
    patrolAngle = Math.random() * Math.PI * 2;
    returnFireTicker = 0;
    /** Operator this bot spawned to pressure; hunt/relocate stay on them. */
    anchor?: Player;
    bugleCooldown = util.random(1.4, 2.8);
    bugleHoldTicker = 0;
    healCooldown = util.random(0.8, 1.6);
    commandTicker = util.random(0.5, 1.4);
    /** Wave 29→30: this boss wipes the glory horde under a truce with operators. */
    gloryExecutioner = false;
    /** Wave 31+: leftover glory fodder fighting on the operator team. */
    gloryHelper = false;
    assaultRole: "" | "nade" | "smoke" | "entry" | "peek" = "";
    assaultHold = 0;
    assaultDest?: Vec2;
    assaultAimPos?: Vec2;
    assaultThrowKind: "" | "frag" | "smoke" | "mirv" | "potato" | "strobe" = "";
    assaultBreakWindow?: Obstacle;
    clearingHouse = false;
    doorStuckTicker = 0;
    stairTarget?: Stair;
    /** Practice mode: slider-driven movement and aim; undefined for Spec Ops bots. */
    practice?: PracticeBotTuning;
    practiceCombat?: PracticeCombat;
    private practiceTarget?: Player;
    private practiceAimTicker = 0;
    private practiceAimError = 0;
    /** Practice: remaining time of the current juke and its side. */
    dodgeTicker = 0;
    dodgeSign = 1;
    /** Practice: whether the bot could see its target last tick (for reaction time). */
    practiceSawTarget = false;

    constructor(
        player: Player,
        loadout: EnemyLoadout,
        wave: number,
        kind: SpecOpsKind = "enemy",
        lifetime = -1,
        enemyClass?: EnemyClass,
    ) {
        this.player = player;
        this.loadout = loadout;
        this.kind = kind;
        this.enemyClass = enemyClass;
        this.lastPos = v2.copy(player.pos);
        this.aimDir = v2.copy(player.dir);
        this.waveScale = math.clamp(wave / 18, 0, 1);
        this.lifetime = lifetime;
        this.baseRange = loadout.range;
        this.fovDot = -1;
        this.alerted = kind !== "enemy";
        if (kind === "sentry") {
            this.acquireTicker = 0;
            this.loadout.reaction = 0;
        }
        this.idleSample = v2.copy(player.pos);
        if (loadout.throwsPotato) {
            this.nadeCooldown = util.random(0.6, 1.4);
        } else if (loadout.role === "grenadier" || enemyClass === "grenadier") {
            this.nadeCooldown = util.random(0.45, 1.0);
        }
    }

    resolveAnchor(manager: SpecOpsManager): void {
        const a = this.anchor;
        if (a && !a.dead && !a.disconnected) return;
        const humans = manager.livingHumans();
        if (!humans.length) {
            this.anchor = undefined;
            return;
        }
        let best = humans[0];
        let bestD = Infinity;
        for (let i = 0; i < humans.length; i++) {
            const d = v2.lengthSqr(v2.sub(humans[i].pos, this.player.pos));
            if (d < bestD) {
                bestD = d;
                best = humans[i];
            }
        }
        this.anchor = best;
    }

    /**
     * Practice: when the player aims at this bot, sometimes juke sideways for a
     * moment and flip strafe direction. `dodgePerSec` sets how often.
     */
    private applyPracticeDodge(dt: number, move: Vec2, desired: Vec2, target: Player): Vec2 {
        const tuning = this.practice;
        if (!tuning) return move;
        this.dodgeTicker = math.max(this.dodgeTicker - dt, 0);
        if (tuning.dodgePerSec > 0 && this.dodgeTicker <= 0) {
            const toMe = v2.normalizeSafe(v2.sub(this.player.pos, target.pos));
            // About 10° either side of the player's aim line.
            const aimedAt = v2.dot(target.dir, toMe) > 0.985;
            if (aimedAt && Math.random() < tuning.dodgePerSec * dt) {
                this.dodgeSign = Math.random() < 0.5 ? 1 : -1;
                this.dodgeTicker = 0.32;
                this.strafeSign = Math.abs(this.strafeSign) * this.dodgeSign;
            }
        }
        if (this.dodgeTicker <= 0) return move;
        return v2.add(v2.normalizeSafe(move), v2.mul(v2.perp(desired), this.dodgeSign * 2.2));
    }

    alertTo(pos: Vec2): void {
        this.alerted = true;
        this.roamOnly = false;
        this.investigatePos = v2.copy(pos);
        this.acquireTicker = math.min(this.acquireTicker, 0.25);
    }

    /** React to taking damage (e.g. shot in the back). */
    onDamaged(fromPos: Vec2, attacker?: Player): void {
        this.alerted = true;
        this.roamOnly = false;
        this.investigatePos = v2.copy(fromPos);
        this.detourPos = undefined;
        this.acquireTicker = 0;
        this.coverPos = undefined;
        this.returnFireTicker = 2.8;
        // Glory fodder never turn on the executioner — they keep charging operators.
        if (
            attacker
            && !attacker.dead
            && attacker.specOpsKind !== "enemy"
            && !this.player.game.specOps?.npcIgnoreOperators
        ) {
            this.target = attacker;
        }
        const toThreat = v2.normalizeSafe(v2.sub(fromPos, this.player.pos));
        // Snap aim toward the hit so they don't keep staring the wrong way.
        this.aimDir = v2.normalizeSafe(v2.add(this.aimDir, v2.mul(toThreat, 1.8)));
        this.player.dirNew = this.aimDir;
    }

    update(dt: number, manager: SpecOpsManager): void {
        const player = this.player;
        if (player.dead) {
            if (this.removeTicker < 0) this.removeTicker = 10;
            this.removeTicker -= dt;
            if (this.removeTicker <= 0) manager.queueRemove(player);
            return;
        }

        this.age += dt;
        this.relocateCooldown = math.max(this.relocateCooldown - dt, 0);

        if (this.lifetime > 0) {
            const t = math.clamp(this.age / this.lifetime, 0, 1);
            this.loadout = { ...this.loadout, range: math.lerp(t, this.baseRange, 6) };
            if (this.age >= this.lifetime) {
                player.damage({
                    amount: 999,
                    damageType: GameConfig.DamageType.Bleeding,
                    dir: v2.create(1, 0),
                });
                return;
            }
        }

        if (this.kind === "enemy") {
            this.idleCheckTicker += dt;
            if (this.idleCheckTicker >= 0.45) {
                const drifted = v2.distance(player.pos, this.idleSample);
                if (drifted < 0.28) this.idleTicker += this.idleCheckTicker;
                else this.idleTicker = 0;
                this.idleSample = v2.copy(player.pos);
                this.idleCheckTicker = 0;
            }
        }

        player.moveLeft = false;
        player.moveRight = false;
        player.moveUp = false;
        player.moveDown = false;
        player.touchMoveActive = false;
        player.shootHold = false;
        player.shootStart = false;

        // Ironclads / suicide crawlers keep ticking while downed so they can finish their fuse.
        if (player.downed && !this.loadout.suicideVest && !this.loadout.mirvCrawl) {
            if (
                !player.specOpsAi
                && player.hasPerk("self_revive")
                && player.actionType !== GameConfig.Action.Revive
            ) {
                player.revive(player);
            }
            return;
        }

        if (this.canReviveFallen() && !player.downed) {
            if (player.isReviving()) return;
            const fallen = this.fallenTeammate(manager);
            if (fallen) {
                const toFallen = v2.sub(fallen.pos, player.pos);
                const fallenDist = v2.length(toFallen);
                const toward = v2.normalizeSafe(toFallen);
                player.dirNew = toward;
                tryOpenNearbyDoors(player, toward, this.stuckStrikes, fallen.pos);
                if (fallenDist <= GameConfig.player.reviveRange) {
                    const toRevive = player.getPlayerToRevive();
                    if (toRevive) player.revive(toRevive);
                    return;
                }
                player.touchMoveActive = true;
                player.touchMoveDir = steerAroundWalls(player.game, player, toward);
                player.touchMoveLen = 255;
                return;
            }
            if (this.loadout.role === "medic") {
                if (this.tryMedicHeal(dt, manager)) return;
                if (this.holdForWounded(manager)) return;
            }
        }

        if (player.actionType === GameConfig.Action.UseItem) return;

        this.updateCommandAura(dt);

        if (this.kind === "enemy") this.resolveAnchor(manager);

        // Weak units ignore the glory executioner even while he mows them down.
        if (
            this.kind === "enemy"
            && !this.gloryExecutioner
            && this.target
            && (this.target === manager.gloryExecutioner || this.target.specOpsKind === "enemy")
        ) {
            this.target = undefined;
            this.returnFireTicker = 0;
        }

        // Glory executioner: hunt the weak horde, never the operators (truce).
        let targetsList: Player[];
        if (this.gloryExecutioner && (manager.gloryWipeActive || manager.gloryTrucePause)) {
            if (manager.gloryTrucePause) {
                this.target = undefined;
                player.shootHold = false;
                player.shootStart = false;
                player.touchMoveActive = false;
                return;
            }
            const weak = manager.livingWeakEnemies();
            if (!weak.length) {
                this.target = undefined;
                player.shootHold = false;
                player.shootStart = false;
                player.touchMoveActive = false;
                return;
            }
            this.alerted = true;
            this.acquireTicker = 0;
            targetsList = weak;
        } else {
            targetsList = this.kind === "enemy"
                ? manager.hostileTargets()
                : manager.livingEnemies();
        }
        if (!targetsList.length) {
            this.practiceSawTarget = false;
            return;
        }

        let target = this.target;
        if (!target || target.dead || target.disconnected) target = undefined;

        let best: Player | undefined;
        let bestDist = Infinity;
        let downedAnchor: Player | undefined;
        let downedDist = Infinity;
        for (let i = 0; i < targetsList.length; i++) {
            const candidate = targetsList[i];
            const d2 = v2.lengthSqr(v2.sub(candidate.pos, player.pos));
            if (candidate.downed) {
                if (d2 < downedDist) {
                    downedDist = d2;
                    downedAnchor = candidate;
                }
                continue;
            }
            let weight = d2;
            if (this.kind === "enemy") {
                if (candidate.specOpsKind === "sentry") weight += 40;
                if (candidate.specOpsKind === "ally") weight += 18;
                if (
                    this.anchor
                    && candidate !== this.anchor
                    && !candidate.specOpsAi
                    && !this.anchor.dead
                    && !this.anchor.downed
                    && !this.anchor.disconnected
                ) {
                    // Stay on the assigned operator unless another is much closer.
                    weight *= 2.35;
                }
            }
            if (weight < bestDist) {
                bestDist = weight;
                best = candidate;
            }
        }
        const patrolDowned = !best && !!downedAnchor;
        if (best && best !== target) {
            const holdFire = this.returnFireTicker > 0
                && target
                && !target.dead
                && !target.downed;
            if (!holdFire) {
                target = best;
                this.coverPos = undefined;
                this.detourPos = undefined;
            }
        } else if (!best) {
            target = downedAnchor;
        }
        this.target = target;
        if (!target) {
            this.practiceSawTarget = false;
            return;
        }

        this.acquireTicker -= dt;

        const toTarget = v2.sub(target.pos, player.pos);
        const dist = v2.length(toTarget);
        const desired = v2.normalizeSafe(toTarget);
        const canSee = hasLineOfSight(player.game, player, target);
        const isBomber = !!this.loadout.suicideVest;
        const directClear = isPathClear(player.game, player, target.pos, 0.8);
        const navHit = directClear ? undefined : firstNavHit(player.game, player, target.pos);
        const blockedByStructure = !!(navHit && (navHit.isWindow || navHit.isWall));

        if (directClear) {
            this.detourPos = undefined;
        }

        if (this.kind === "enemy" && !this.alerted) {
            // Close contact / hearing always spots; farther needs FOV + LOS.
            // Roam-only contracts (Most Wanted) only wake on proximity / damage.
            const proximity = this.roamOnly ? 14 : 8;
            const spotted = dist < proximity
                || (!this.roamOnly
                    && canSee
                    && dist < this.loadout.range * 1.35
                    && inSearchFov(this.aimDir, toTarget, this.searchFovDot));
            if (spotted) {
                this.alerted = true;
                if (this.roamOnly) this.roamOnly = false;
                this.acquireTicker = this.loadout.reaction * (1.2 - this.waveScale * 0.4)
                    + util.random(0, 0.25);
                manager.alertSquad(player.pos, player, 22);
            }
        } else if (this.kind === "enemy" && canSee && dist < this.loadout.range * 1.5) {
            if (Math.random() < dt * 0.35) manager.alertSquad(target.pos, player, 18);
        }

        if (this.practice && this.practiceCombat) {
            if (canSee && (!this.practiceSawTarget || this.practiceTarget !== target)) {
                this.acquireTicker = math.max(this.acquireTicker, this.practice.reactionSec);
                this.practiceAimTicker = 0;
            }
            this.practiceSawTarget = canSee;
            this.practiceTarget = target;
            this.practiceCombat.update(
                dt,
                target,
                canSee && !target.downed && !this.practice.holdFire && this.acquireTicker <= 0,
            );
            const activeGun = player.weaponManager.activeWeapon;
            if (GunDefs[activeGun] && activeGun !== this.loadout.gun) {
                const activeLoadout = practiceBotLoadout(activeGun, this.practiceCombat.settings, 0);
                this.loadout = {
                    ...this.loadout,
                    gun: activeGun,
                    range: activeLoadout.range,
                    holdRange: activeLoadout.holdRange,
                };
            }
        }

        this.planHouseAssault(dt, target, dist, patrolDowned, isBomber);
        const stairTransit = onStairTransit(player, this.stairTarget);
        if (
            this.stairTarget
            && navGroundLayer(player.layer) === navGroundLayer(target.layer)
            && player.layer < 2
        ) {
            this.stairTarget = undefined;
        }
        const crossingGoal = this.assaultDest ?? this.detourPos ?? target.pos;
        tryOpenNearbyDoors(player, desired, this.stuckStrikes, crossingGoal);
        const doorBlock = overlappingDoor(player);
        if (doorBlock) {
            tryUseDoor(doorBlock, player, crossingGoal, true);
            this.doorStuckTicker += dt;
        } else {
            this.doorStuckTicker = 0;
        }

        const isMirvCrawl = !!this.loadout.mirvCrawl;

        if ((isBomber || isMirvCrawl) && (this.alerted || player.downed) && !target.downed) {
            if (this.crawlExplodeTicker > 0 || player.downed) {
                if (this.crawlExplodeTicker < 0) {
                    this.crawlExplodeTicker = isMirvCrawl
                        ? SpecOpsIroncladCrawlSeconds
                        : 3.4;
                }
                this.crawlExplodeTicker -= dt;
                player.dirNew = desired;
                const crawlMove = steerAroundWalls(player.game, player, desired);
                player.touchMoveActive = true;
                player.touchMoveDir = crawlMove;
                player.touchMoveLen = 255;
                if (this.crawlExplodeTicker <= 0 || (!isMirvCrawl && dist < 1.15)) {
                    player.kill({
                        damageType: GameConfig.DamageType.Bleeding,
                        dir: desired,
                        gameSourceType: isMirvCrawl ? "mirv" : "frag",
                        isExplosion: true,
                    });
                }
                return;
            }
            if (isBomber && dist < 4.2) {
                if (!player.downed) {
                    player.down({
                        amount: 0,
                        damageType: GameConfig.DamageType.Bleeding,
                        dir: desired,
                    });
                    this.crawlExplodeTicker = 3.4;
                }
                return;
            }
        }

        this.returnFireTicker = math.max(this.returnFireTicker - dt, 0);
        player.specOpsReturnFireSpread = 0;
        if (!patrolDowned && !target.downed && this.kind !== "sentry") {
            const toNpc = v2.normalizeSafe(v2.sub(player.pos, target.pos));
            const aimedAtUs = v2.dot(target.dir, toNpc) > 0.78;
            if (
                aimedAtUs
                && (target.shootHold || target.shootStart)
                && dist > this.loadout.range * 0.85
            ) {
                this.returnFireTicker = math.max(this.returnFireTicker, 1.8);
                this.alerted = true;
                this.investigatePos = v2.copy(target.pos);
            }
        }
        const suppressing = this.returnFireTicker > 0
            && dist < 88
            && dist > 1.2
            && !patrolDowned
            && !target.downed
            && !isBomber;
        const suppressError = suppressing
            ? math.clamp(16 + (dist - this.loadout.range) * 2.2, 16, 54)
            : 0;

        this.lookScanTicker -= dt;
        if (this.lookScanTicker <= 0) {
            this.lookScanSign *= -1;
            this.lookScanTicker = util.random(0.6, 1.6);
        }

        let aimTarget: Vec2;
        if (this.assaultAimPos) {
            aimTarget = v2.normalizeSafe(v2.sub(this.assaultAimPos, player.pos));
        } else if (suppressing) {
            const toward = canSee
                ? desired
                : (this.investigatePos
                    ? v2.normalizeSafe(v2.sub(this.investigatePos, player.pos))
                    : desired);
            const errorRad = math.deg2rad(util.random(-suppressError, suppressError));
            aimTarget = v2.rotate(toward, errorRad);
        } else if (!this.alerted || (!canSee && this.investigatePos)) {
            const walkAim = this.wanderTicker > 0
                ? this.wanderDir
                : (this.investigatePos
                    ? v2.normalizeSafe(v2.sub(this.investigatePos, player.pos))
                    : desired);
            aimTarget = v2.rotate(walkAim, this.lookScanSign * math.deg2rad(28));
        } else if (!canSee) {
            const approach = this.investigatePos
                ? v2.normalizeSafe(v2.sub(this.investigatePos, player.pos))
                : desired;
            const errorRad = math.deg2rad(util.random(-suppressError, suppressError));
            aimTarget = v2.rotate(approach, this.lookScanSign * math.deg2rad(18) + errorRad);
        } else {
            const aimSlack = math.lerp(this.waveScale, 1.7, 0.9);
            const maxError = this.practice
                ? this.practice.aimErrorDeg
                : math.max(
                    10,
                    this.loadout.aimError * aimSlack * (1.15 - this.waveScale * 0.55),
                ) + suppressError;
            const errorScale = this.practice ? 1 : math.lerp(this.waveScale, 0.9, 0.4);
            if (this.practice && this.practiceCombat) {
                // Keep a small aim bias for a short interval instead of sampling
                // jitter every tick. The server knows the target's actual velocity.
                this.practiceAimTicker -= dt;
                if (this.practiceAimTicker <= 0) {
                    this.practiceAimError = math.deg2rad(util.random(-maxError, maxError));
                    this.practiceAimTicker = 0.16;
                }
                aimTarget = v2.rotate(
                    v2.normalizeSafe(v2.sub(this.practiceCombat.aimPoint(target), player.pos)),
                    this.practiceAimError,
                );
            } else {
                const errorRad = math.deg2rad(util.random(-maxError, maxError) * errorScale);
                const lead = v2.mul(target.moveVel, 0.04 * (0.08 + this.waveScale * 0.7));
                aimTarget = v2.rotate(v2.normalizeSafe(v2.add(desired, lead)), errorRad);
            }
        }

        const turnRate = math.deg2rad(
            this.loadout.turnRate * (0.45 + this.waveScale * 0.7) * (this.alerted ? 1 : 0.7),
        );
        const currentAng = Math.atan2(this.aimDir.y, this.aimDir.x);
        const wantAng = Math.atan2(aimTarget.y, aimTarget.x);
        let angDelta = wantAng - currentAng;
        while (angDelta > Math.PI) angDelta -= Math.PI * 2;
        while (angDelta < -Math.PI) angDelta += Math.PI * 2;
        // Sentries lock onto targets instantly — no wind-up or slow traverse.
        const angStep = this.kind === "sentry"
            ? angDelta
            : math.clamp(angDelta, -turnRate * dt, turnRate * dt);
        this.aimDir = v2.normalizeSafe(
            v2.create(Math.cos(currentAng + angStep), Math.sin(currentAng + angStep)),
        );

        if (stairTransit && this.assaultAimPos) {
            this.aimDir = v2.normalizeSafe(
                v2.sub(this.assaultAimPos, player.pos),
                this.aimDir,
            );
        }

        player.dirNew = this.aimDir;
        const throwDist = this.assaultAimPos
            ? v2.distance(player.pos, this.assaultAimPos)
            : dist;
        player.toMouseLen = math.min(throwDist, GameConfig.player.throwableMaxMouseDist);

        const push = this.kind === "enemy" ? manager.pushPressure : 0;
        if (push > 0.3) {
            this.acquireTicker = math.min(this.acquireTicker, 0.18 * (1.15 - push));
        }

        if (this.kind !== "sentry") {
            const field = manager.nav;
            const moved = v2.length(v2.sub(player.pos, this.lastPos));
            const stepDir = v2.normalizeSafe(v2.sub(player.pos, this.lastPos), this.lastStepDir);

            for (let i = this.failedWaypoints.length - 1; i >= 0; i--) {
                this.failedWaypoints[i].ttl -= dt;
                if (this.failedWaypoints[i].ttl <= 0) this.failedWaypoints.splice(i, 1);
            }

            this.trailTicker += dt;
            if (this.trailTicker >= 0.22) {
                this.trailTicker = 0;
                this.trail.push(v2.copy(player.pos));
                if (this.trail.length > 10) this.trail.shift();
            }

            let looping = false;
            if (this.trail.length >= 7) {
                let pathLen = 0;
                for (let i = 1; i < this.trail.length; i++) {
                    pathLen += v2.distance(this.trail[i - 1], this.trail[i]);
                }
                const net = v2.distance(this.trail[0], this.trail[this.trail.length - 1]);
                looping = pathLen > 5.5 && net < 1.55;
            }
            const reversing = v2.dot(stepDir, this.lastStepDir) < -0.45 && moved > 0.08;

            this.stuckTicker += dt;
            if (this.stuckTicker > 0.32 && !stairTransit && !this.stairTarget) {
                if (moved < 0.14 || looping || reversing) {
                    this.stuckStrikes++;
                    this.pathSideSign *= -1;
                    this.coverPos = undefined;
                    field.penalize(player.pos, looping ? 3.2 : 2.1);
                    if (this.detourPos) {
                        field.penalizeToward(player.pos, this.detourPos, 2.4);
                        this.failedWaypoints.push({ pos: v2.copy(this.detourPos), ttl: 3.2 });
                        this.detourPos = undefined;
                        this.trail.length = 0;
                    }
                    if (navHit) field.penalize(navHit.pos, 2.6);
                    this.wanderTicker = util.random(0.28, 0.7);
                    this.wanderDir = steerAroundWalls(
                        player.game,
                        player,
                        v2.add(
                            v2.mul(v2.perp(desired), this.pathSideSign),
                            v2.mul(desired, -0.2),
                        ),
                        this.pathSideSign,
                        field,
                    );

                    const detourGoal = this.stairTarget
                        ? (this.assaultDest ?? target.pos)
                        : target.pos;
                    const detour = findRouteWaypoint(
                        player.game,
                        player,
                        detourGoal,
                        field,
                        this,
                    );
                    if (detour) {
                        this.detourPos = detour;
                        field.occupy(detour, 1.6);
                    }

                    if (this.stuckStrikes >= 5) {
                        const escape = steerAroundWalls(
                            player.game,
                            player,
                            v2.mul(desired, -1),
                            this.pathSideSign,
                            field,
                        );
                        const nudge = v2.add(player.pos, v2.mul(escape, 1.05));
                        if (player.game.map.canPlayerSpawn(nudge)) {
                            v2.set(player.pos, nudge);
                            player.game.grid.updateObject(player);
                            player.setDirty();
                        }
                        this.stuckStrikes = 2;
                    }
                } else {
                    this.stuckStrikes = Math.max(0, this.stuckStrikes - 1);
                    if (v2.dot(stepDir, desired) > 0.2) field.reward(player.pos, 0.45);
                }
                this.stuckTicker = 0;
                this.lastStepDir = stepDir;
                this.lastPos = v2.copy(player.pos);
            }
            this.wanderTicker -= dt;
            this.coverRefreshTicker -= dt;
            this.strafeFlipTicker -= dt;
            if (this.strafeFlipTicker <= 0) {
                this.strafeSign *= -1;
                this.strafeFlipTicker = this.practice
                    ? util.random(this.practice.flipMin, this.practice.flipMax)
                    : util.random(0.7, 1.8);
            }

            if (this.detourPos && !this.stairTarget && v2.distance(player.pos, this.detourPos) < 2.2 && !doorBlock) {
                field.reward(this.detourPos, 0.8);
                this.detourPos = undefined;
            }
            this.routeRefreshTicker -= dt;
            if (
                !directClear
                && !stairTransit
                && this.routeRefreshTicker <= 0
            ) {
                const routeGoal = this.stairTarget
                    ? (this.assaultDest ?? target.pos)
                    : (this.assaultDest ?? target.pos);
                const next = findRouteWaypoint(
                    player.game,
                    player,
                    routeGoal,
                    field,
                    this,
                );
                if (next) {
                    this.detourPos = next;
                    field.occupy(next, 1.4);
                }
                this.routeRefreshTicker = (blockedByStructure || navHit?.isDoor ? 0.16 : 0.4)
                    * (1 - push * 0.72);
            }

            let move = v2.create(0, 0);
            const hold = this.pushHoldRange(push);
            const maxRange = this.loadout.range * (1.15 - push * 0.12);
            // Only CQC charges from range. Dry-gun bots panic-melee only when already close.
            const meleeEngage = this.engagesMelee(dist);
            const meleeCloseDist = AiMeleeAttackRange - 0.15;
            const dedicatedMelee = aiIsDedicatedMelee(this.enemyClass);

            if (
                push < 0.42
                && this.coverRefreshTicker <= 0
                && !isBomber
                && this.alerted
                && canSee
                && directClear
                && !patrolDowned
                && this.assaultRole !== "peek"
                && !meleeEngage
            ) {
                this.coverRefreshTicker = util.random(1.2, 2.2);
                this.coverPos = findCoverPos(player.game, player, target);
            }

            let assaultDirect = false;
            if (this.nadeState === "cooking" && this.assaultRole) {
                move = v2.create(0, 0);
            } else if (
                dedicatedMelee
                && this.alerted
                && !patrolDowned
                && !target.downed
                && !isBomber
                && !doorBlock
                && dist > AiMeleeAttackRange - 0.35
            ) {
                // Knife bots: commit to closing — wander/detour/cover must not orbit outside swing range.
                this.detourPos = undefined;
                this.coverPos = undefined;
                this.wanderTicker = 0;
                this.assaultDest = undefined;
                move = v2.add(
                    v2.mul(desired, 1.15),
                    v2.mul(v2.perp(desired), this.strafeSign * 0.12),
                );
            } else if (
                meleeEngage
                && !dedicatedMelee
                && dist > meleeCloseDist
                && dist <= AiPanicMeleeProximity + 0.6
            ) {
                // Dry-gun panic: only close the last meter, never sprint from across the map.
                move = v2.mul(desired, 0.85);
            } else if (this.assaultDest) {
                const dest = clampDestFromOperators(
                    player.game,
                    player,
                    this.assaultDest,
                    meleeEngage,
                );
                const toDest = v2.sub(dest, player.pos);
                const destDist = v2.length(toDest);
                const destPad = doorBlock ? 0.35 : 1.15;
                if (this.assaultRole === "peek" && destDist <= 4.5) {
                    move = v2.create(0, 0);
                    this.detourPos = undefined;
                    assaultDirect = true;
                } else if (destDist > destPad || doorBlock) {
                    const destClear = isPathClear(player.game, player, dest, 0.8);
                    const pushThrough = this.assaultRole === "entry"
                        && destDist < 20
                        && (doorBlock || destClear || player.layer >= 2 || stairTransit);
                    if (pushThrough) {
                        this.detourPos = undefined;
                        move = v2.normalizeSafe(toDest);
                        assaultDirect = stairTransit;
                    } else if (!destClear) {
                        if (this.routeRefreshTicker <= 0) {
                            const next = findRouteWaypoint(
                                player.game,
                                player,
                                dest,
                                field,
                                this,
                            );
                            if (next) {
                                this.detourPos = next;
                                field.occupy(next, 1.4);
                            }
                            this.routeRefreshTicker = 0.28;
                        }
                        if (this.detourPos) {
                            move = v2.normalizeSafe(v2.sub(this.detourPos, player.pos));
                        } else {
                            move = v2.normalizeSafe(toDest);
                        }
                    } else {
                        this.detourPos = undefined;
                        move = v2.normalizeSafe(toDest);
                    }
                } else if (this.assaultHold > 0) {
                    move = v2.mul(v2.perp(desired), this.strafeSign * 0.35);
                } else if (this.clearingHouse) {
                    const engage = this.engageDest(target);
                    const toEngage = v2.normalizeSafe(v2.sub(engage, player.pos));
                    move = v2.add(toEngage, v2.mul(v2.perp(toEngage), this.strafeSign * 0.2));
                }
            } else if (patrolDowned) {
                this.patrolAngle += dt * 0.85;
                const dest = v2.add(
                    target.pos,
                    v2.create(
                        Math.cos(this.patrolAngle) * 11,
                        Math.sin(this.patrolAngle) * 11,
                    ),
                );
                move = v2.normalizeSafe(v2.sub(dest, player.pos));
            } else if (!directClear) {
                if (this.detourPos) {
                    const toDetour = v2.normalizeSafe(v2.sub(this.detourPos, player.pos));
                    move = v2.normalizeSafe(v2.add(toDetour, v2.mul(desired, push * 0.7)));
                } else {
                    move = v2.add(
                        v2.mul(v2.perp(desired), this.pathSideSign * (1 - push * 0.55)),
                        v2.mul(desired, -0.2 + push * 1.05),
                    );
                }
            } else if (this.wanderTicker > 0 && push < 0.35) {
                move = this.wanderDir;
            } else if (this.detourPos) {
                move = v2.normalizeSafe(v2.sub(this.detourPos, player.pos));
            } else if (!this.alerted && push < 0.25) {
                const roam = this.investigatePos
                    ? v2.normalizeSafe(v2.sub(this.investigatePos, player.pos))
                    : desired;
                move = v2.add(roam, v2.mul(v2.perp(roam), this.pathSideSign * 0.45));
            } else if (isBomber) {
                move = v2.add(desired, v2.mul(v2.perp(desired), this.strafeSign * 0.25));
            } else if (
                dist < this.standoffRange(player, hold)
                // Knife bots already in swing range must not backpedal out of it.
                && !(meleeEngage && dist <= AiMeleeAttackRange)
            ) {
                // Never sit under the operator — LOS dies and they stall.
                const stand = this.standoffRange(player, hold);
                const overlap = math.clamp((stand - dist) / stand, 0, 1);
                move = v2.add(
                    v2.mul(v2.neg(desired), 0.9 + overlap * 1.1),
                    v2.mul(v2.perp(desired), this.strafeSign * (0.55 + overlap * 0.35)),
                );
            } else if (meleeEngage) {
                // In swing band: light strafe only (close-in handled above).
                move = v2.mul(v2.perp(desired), this.strafeSign * 0.35);
            } else if (!canSee || dist > maxRange) {
                const hunt = this.investigatePos
                    ? v2.normalizeSafe(v2.sub(this.investigatePos, player.pos))
                    : desired;
                move = v2.add(hunt, v2.mul(v2.perp(hunt), this.pathSideSign * (0.35 - push * 0.22)));
            } else if (dist < hold * 0.85) {
                move = v2.add(
                    v2.neg(desired),
                    v2.mul(v2.perp(desired), this.strafeSign * 0.55),
                );
            } else if (
                push < 0.45
                && this.coverPos
                && v2.distance(player.pos, this.coverPos) > 1.4
                && (dist < hold * 1.35 || !this.shooting)
            ) {
                move = v2.normalizeSafe(v2.sub(this.coverPos, player.pos));
            } else if (dist > hold * (push > 0.5 ? 0.72 : 1.2)) {
                const charge = 0.55 + push * 0.55;
                move = v2.add(
                    v2.mul(desired, charge),
                    v2.mul(v2.perp(desired), this.strafeSign * (1 - push * 0.7)),
                );
            } else {
                move = v2.mul(v2.perp(desired), this.strafeSign);
            }

            if (this.practice) {
                move = this.applyPracticeDodge(dt, move, desired, target);
            }

            const sep = crowdingSteer(player.game, player, target);
            if (v2.length(sep) > 0.05) {
                const sepWeight = assaultDirect ? 1.05 : 1.25 - push * 0.85;
                move = v2.add(move, v2.mul(sep, sepWeight));
            }
            const opSep = operatorOverlapSteer(
                player.game,
                player,
                dedicatedMelee || meleeEngage,
            );
            if (v2.length(opSep) > 0.04 && !dedicatedMelee) {
                // Melee: don't let separation shove bots out of swing range.
                const sepMul = meleeEngage ? 0.55 : 1.65;
                const keepMul = meleeEngage ? 0.75 : 0.42;
                move = v2.length(move) > 0.01
                    ? v2.normalizeSafe(v2.add(v2.mul(v2.normalizeSafe(move), keepMul), v2.mul(opSep, sepMul)))
                    : v2.normalizeSafe(opSep);
            } else if (v2.length(opSep) > 0.04 && dedicatedMelee && dist < AiMeleeAttackRange - 0.4) {
                // Only separate CQC when basically on top of the operator.
                move = v2.normalizeSafe(v2.add(move, v2.mul(opSep, 0.25)));
            }

            if (v2.length(move) > 0.01) {
                player.touchMoveActive = true;
                player.touchMoveDir = assaultDirect
                    ? v2.normalizeSafe(move)
                    : steerAroundWalls(
                        player.game,
                        player,
                        move,
                        this.pathSideSign,
                        field,
                        push,
                    );
                player.touchMoveLen = 255;
            }

            if (doorBlock) {
                const through = throughDoorDir(doorBlock, player.pos, crossingGoal);
                player.touchMoveActive = true;
                player.touchMoveDir = through;
                player.touchMoveLen = 255;
                this.shooting = false;
                if (this.doorStuckTicker > 2.2) {
                    tryUseDoor(doorBlock, player, crossingGoal, true);
                    const step = v2.add(player.pos, v2.mul(through, 0.85));
                    player.game.map.clampToMapBounds(step, 4);
                    v2.set(player.pos, step);
                    player.game.grid.updateObject(player);
                    player.setDirty();
                    this.doorStuckTicker = 0.35;
                }
            }

            if (this.investigatePos && v2.distance(player.pos, this.investigatePos) < 3.5) {
                this.investigatePos = undefined;
            }
        }

        const aimDot = v2.dot(this.aimDir, this.practice ? aimTarget : desired);
        const onTarget = aimDot > (this.practice ? Math.cos(math.deg2rad(2)) : suppressing
            ? 0.28
            : math.lerp(this.waveScale, 0.7, 0.92));
        const inCone = this.fovDot < 0 || aimDot >= this.fovDot;
        const inRange = dist <= this.loadout.range * 1.15 && dist > 0.4;
        const metalBlocked = pathHitsReflectMetal(
            player.game,
            player,
            target.pos,
            this.loadout.range * 1.2,
        )
            || pathHitsReflectMetal(
                player.game,
                player,
                v2.add(player.pos, v2.mul(this.aimDir, this.loadout.range)),
                this.loadout.range,
            );
        const hasGun = !!player.weapons[GameConfig.WeaponSlot.Primary].type;
        if (this.assaultThrowKind) this.shooting = false;
        const windowShot = this.assaultBreakWindow
            && !this.assaultBreakWindow.dead
            && this.nadeState === "idle"
            && !this.assaultThrowKind
            && v2.distance(player.pos, this.assaultBreakWindow.pos) < 16
            && v2.dot(
                    this.aimDir,
                    v2.normalizeSafe(v2.sub(this.assaultBreakWindow.pos, player.pos)),
                ) > 0.72;
        const ready = this.alerted
            && !this.practice?.holdFire
            && (!this.practice || canSee)
            && hasGun
            && !patrolDowned
            && !target.downed
            && this.nadeState === "idle"
            && !this.assaultThrowKind
            && this.acquireTicker <= 0
            && !isBomber
            && !doorBlock
            && (
                (canSee && onTarget && inRange && inCone && !metalBlocked)
                || (suppressing && onTarget)
                || windowShot
            );

        if (this.practiceCombat) {
            // Fire as soon as the engine permits. The old Spec Ops burst pauses
            // added an extra delay on top of the gun's own firing/switch timers.
            this.practiceCombat.fire(Boolean(ready));
            return;
        }

        // Sentry: continuous mag dump with no burst pause while ammo remains.
        if (this.kind === "sentry") {
            const gunReady = this.gunHasRounds(player);
            const reloading = player.actionType === GameConfig.Action.Reload
                || player.actionType === GameConfig.Action.ReloadAlt;
            this.shooting = Boolean(ready && gunReady && !reloading);
            if (ready && !gunReady) {
                player.weaponManager.tryReload();
            }
        } else if (this.shooting) {
            this.burstTicker -= dt;
            if (this.burstTicker <= 0 || !ready) {
                this.shooting = false;
                this.pauseTicker = this.loadout.burstPause
                        * (1.4 - this.waveScale * 0.4)
                    + util.random(0, 0.35);
            }
        } else {
            this.pauseTicker -= dt;
            if (ready && this.pauseTicker <= 0) {
                this.shooting = true;
                this.burstTicker = this.loadout.burst
                        * (0.7 + this.waveScale * 0.4)
                    + util.random(0, 0.15);
            }
        }

        if (player.weaponManager.activeWeapon) {
            const weapDef = GameObjectDefs.typeToDefSafe(player.weaponManager.activeWeapon);
            if (this.shooting && weapDef?.type === "gun") {
                player.shootHold = true;
                if (weapDef.fireMode === "single") player.shootStart = true;
                if (suppressing) {
                    player.specOpsReturnFireSpread = 7 + suppressError * 0.4;
                }
            }
        }

        const gunReady = this.gunHasRounds(player);
        const meleeType = player.weapons[GameConfig.WeaponSlot.Melee].type;
        const canMelee = !!meleeType;
        const wantMelee = this.engagesMelee(dist) && canMelee;

        // Empty primary magazine → secondary if it still has rounds (all difficulties).
        if (
            !this.primaryHasRounds(player)
            && this.secondaryHasRounds(player)
            && !wantMelee
        ) {
            if (player.curWeapIdx !== GameConfig.WeaponSlot.Secondary) {
                player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Secondary);
            }
        } else if (
            this.primaryHasRounds(player)
            && player.curWeapIdx === GameConfig.WeaponSlot.Secondary
        ) {
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
        }

        // Knife only when already point-blank (or dedicated CQC). Stay on gun farther out so they reload.
        if (
            wantMelee
            && this.alerted
            && !patrolDowned
            && !target.downed
            && !isBomber
            && dist < AiMeleeAttackRange
        ) {
            if (player.curWeapIdx !== GameConfig.WeaponSlot.Melee) {
                player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
            }
            player.shootHold = true;
            player.shootStart = true;
        } else if (
            player.curWeapIdx === GameConfig.WeaponSlot.Melee
            && gunReady
            && (player.weapons[GameConfig.WeaponSlot.Primary].type
                || player.weapons[GameConfig.WeaponSlot.Secondary].type)
        ) {
            if (!this.primaryHasRounds(player) && this.secondaryHasRounds(player)) {
                player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Secondary);
            } else if (player.weapons[GameConfig.WeaponSlot.Primary].type) {
                player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
            }
        } else if (
            !wantMelee
            && !gunReady
            && player.curWeapIdx !== GameConfig.WeaponSlot.Melee
            && player.curWeapIdx !== GameConfig.WeaponSlot.Throwable
            && this.alerted
            && this.kind !== "sentry"
        ) {
            // Mag empty out of knife range: keep the gun out and reload instead of charging.
            // Sentries handle dry reload in their continuous-fire block above.
            player.weaponManager.tryReload();
        }

        this.nadeCooldown = math.max(this.nadeCooldown - dt, 0);
        if (
            this.loadout.throwsStrobe
            && canSee
            && !target.indoors
            && !player.indoors
            && dist >= 12
            && dist <= 32
            && player.invManager.get("strobe") > 0
            && this.nadeCooldown <= 0
            && this.nadeState === "idle"
            && !this.assaultThrowKind
            && this.alerted
            && !patrolDowned
            && !target.downed
            && !doorBlock
        ) {
            this.assaultAimPos = v2.copy(target.pos);
            this.assaultThrowKind = "strobe";
        }
        if (this.assaultThrowKind && this.nadeState === "idle") {
            const type = this.assaultThrowKind;
            if (player.invManager.get(type) > 0) {
                player.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, type, 0);
            }
        }
        const nadeType = player.weapons[GameConfig.WeaponSlot.Throwable].type;
        const nadeAmmo = nadeType && player.invManager.isValid(nadeType)
            ? player.invManager.get(nadeType)
            : 0;
        const potatoMode = !!this.loadout.throwsPotato || nadeType === "potato";
        const snowMode = !!this.loadout.throwsSnowball || nadeType === "snowball";
        const mirvMode = !!this.loadout.throwsMirv || nadeType === "mirv";
        const strobeMode = !!this.loadout.throwsStrobe || nadeType === "strobe";
        const grenadier = this.isGrenadier();
        const assaultNade = !!this.assaultThrowKind && nadeAmmo > 0
            && throwDist >= 2
            && throwDist <= (this.assaultThrowKind === "strobe" ? 34 : 28);
        const canNade = (assaultNade || ((!!this.loadout.throwsNades || potatoMode || snowMode || mirvMode
            || strobeMode)
            && canSee
            && dist >= (grenadier ? 5 : potatoMode || snowMode ? 5 : strobeMode ? 10 : 7)
            && dist <= (grenadier ? 22 : potatoMode || snowMode ? 22 : strobeMode ? 32 : mirvMode ? 20 : 18)))
            && this.kind !== "sentry"
            && !patrolDowned
            && !target.downed
            && !doorBlock
            && this.alerted
            && nadeAmmo > 0
            && this.nadeCooldown <= 0
            && this.nadeState === "idle"
            && (grenadier ? this.pauseTicker > 0.05 : !this.shooting);

        if (this.nadeState === "cooking") {
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Throwable);
            player.shootHold = true;
            player.shootStart = false;
            if (this.assaultAimPos) {
                player.toMouseLen = math.min(
                    v2.distance(player.pos, this.assaultAimPos),
                    GameConfig.player.throwableMaxMouseDist,
                );
            }
            this.nadeCookTicker += dt;
            if (this.nadeCookTicker >= (potatoMode || snowMode ? 0.28 : strobeMode ? 0.35 : 0.45)) {
                player.shootHold = false;
                this.nadeState = "thrown";
                this.nadeCooldown = potatoMode || snowMode
                    ? util.random(2.2, 3.6)
                    : mirvMode
                    ? util.random(4.2, 6.5)
                    : strobeMode
                    ? util.random(14, 20)
                    : util.random(7.5, 10);
                this.shooting = false;
            }
        } else if (this.nadeState === "thrown") {
            if (player.weapons[GameConfig.WeaponSlot.Primary].type) {
                player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
            }
            if (this.assaultThrowKind) {
                this.assaultRole = "entry";
                this.assaultHold = 0.55;
                this.assaultThrowKind = "";
            }
            this.nadeState = "idle";
        } else if (canNade) {
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Throwable);
            player.shootStart = true;
            player.shootHold = true;
            player.toMouseLen = this.assaultAimPos
                ? math.min(throwDist, GameConfig.player.throwableMaxMouseDist)
                : GameConfig.player.throwableMaxMouseDist;
            this.nadeState = "cooking";
            this.nadeCookTicker = 0;
            this.shooting = false;
        }

        this.updateBugle(dt, player);
    }

    private isGrenadier(): boolean {
        return this.loadout.role === "grenadier" || this.enemyClass === "grenadier";
    }

    private smokeAssaultEligible(): boolean {
        const cls = this.enemyClass;
        return cls === "suppressor"
            || cls === "stalker"
            || cls === "cobalt_support"
            || cls === "rifle"
            || cls === "militia";
    }

    private pickAssaultRole(canPeek = false): "nade" | "smoke" | "entry" | "peek" {
        const cls = this.enemyClass;
        if (
            this.loadout.throwsNades
            || this.loadout.throwsMirv
            || this.loadout.throwsPotato
            || this.loadout.role === "grenadier"
            || cls === "grenadier"
            || cls === "sapper"
            || cls === "cobalt_demo"
        ) {
            return "nade";
        }
        if (
            cls === "shotgun"
            || cls === "cqc"
            || cls === "rusher"
            || cls === "berserker"
            || cls === "military_breacher"
        ) {
            return "entry";
        }
        if (canPeek && this.isWindowPeeker()) return "peek";
        if (
            this.smokeAssaultEligible()
            && (this.loadout.throwsSmoke || this.player.invManager.get("smoke") > 0)
        ) {
            return "smoke";
        }
        return "entry";
    }

    private isWindowPeeker(): boolean {
        const cls = this.enemyClass;
        return cls === "sniper"
            || cls === "marksman"
            || cls === "dmr"
            || cls === "suppressor"
            || cls === "scout"
            || cls === "recon"
            || cls === "hunter"
            || cls === "military_sniper"
            || cls === "cobalt_sniper"
            || cls === "stalker"
            || cls === "pathfinder";
    }

    private explosiveNadeType(): "frag" | "mirv" | "potato" | "" {
        if (this.loadout.throwsMirv && this.player.invManager.get("mirv") > 0) return "mirv";
        if (this.player.invManager.get("frag") > 0) return "frag";
        if (this.player.invManager.get("mirv") > 0) return "mirv";
        if (this.player.invManager.get("potato") > 0) return "potato";
        return "";
    }

    private planStairRoute(target: Player): boolean {
        const player = this.player;
        const fromG = navGroundLayer(player.layer);
        const toG = navGroundLayer(target.layer);
        if (fromG === toG && player.layer < 2) return false;

        const stair = findConnectingStair(player.game, player, target);
        if (!stair) return false;

        const goingDown = toG === 1;
        this.stairTarget = stair;
        this.assaultRole = "entry";
        this.assaultHold = 0;
        this.alerted = true;
        this.investigatePos = v2.copy(target.pos);
        const dest = stairWaypoint(player, stair, goingDown);
        const through = goingDown ? stair.downDir : v2.neg(stair.downDir);
        this.assaultAimPos = v2.add(player.pos, v2.mul(through, 5));
        const stairBuilding = buildingContaining(player.game, stair.center, 0)
            ?? buildingContaining(player.game, target.pos, toG);
        const nearStair = v2.distance(player.pos, stair.center) < 20;

        if (
            stairBuilding
            && !player.indoors
            && player.layer < 2
            && !onStairCollision(player.pos, player.rad, stair)
            && !nearStair
            && v2.distance(player.pos, stair.center) > 16
        ) {
            const doors = entryFixtures(stairBuilding, "door");
            const door = closestFixture(doors, stair.center)
                ?? closestFixture(doors, player.pos);
            if (door && v2.distance(player.pos, door.pos) > 6) {
                const doorApproach = outsideApproach(door, stairBuilding, 4.2, player.game);
                this.assaultDest = this.routedDest(player, doorApproach, stairBuilding);
                return true;
            }
        }

        if (
            stairBuilding
            && !player.indoors
            && player.layer < 2
            && !onStairCollision(player.pos, player.rad, stair)
            && !nearStair
        ) {
            this.assaultDest = this.routedDest(player, dest, stairBuilding);
        } else {
            this.assaultDest = dest;
        }
        return true;
    }

    /** Keep the real destination when the baked graph can reach it. */
    private routedDest(from: Player, dest: Vec2, building: Building): Vec2 {
        const graph = from.game.specOps?.paths;
        if (isPathClear(from.game, from, dest, 0.8)) return dest;
        if (graph?.hasPath(from, dest)) return dest;
        if (stairAtPos(from.game, dest, 1.6) && v2.distance(from.pos, dest) < 44) return dest;
        return routeAroundBuilding(from, dest, building);
    }

    private planHouseAssault(
        dt: number,
        target: Player,
        _dist: number,
        patrolDowned: boolean,
        isBomber: boolean,
    ): void {
        this.assaultDest = undefined;
        this.assaultAimPos = undefined;
        this.assaultThrowKind = "";
        this.assaultBreakWindow = undefined;
        this.clearingHouse = false;

        const player = this.player;
        if (
            this.kind !== "enemy"
            || patrolDowned
            || isBomber
            || target.downed
            || this.gloryExecutioner
        ) {
            this.assaultRole = "";
            this.assaultHold = 0;
            return;
        }

        if (this.planStairRoute(target)) return;

        const goal = buildingContaining(player.game, target.pos, util.toGroundLayer(target.layer));
        if (!goal || !target.indoors) {
            this.assaultRole = "";
            this.assaultHold = 0;
            return;
        }

        this.alerted = true;
        this.investigatePos = v2.copy(target.pos);
        const selfBuilding = buildingContaining(
            player.game,
            player.pos,
            util.toGroundLayer(player.layer),
        );
        this.clearingHouse = selfBuilding === goal;

        const doors = entryFixtures(goal, "door");
        const windows = entryFixtures(goal, "window");

        if (this.clearingHouse) {
            this.assaultRole = "entry";
            this.assaultHold = 0;
            this.assaultDest = this.engageDest(target);
            return;
        }

        if (!this.assaultRole) this.assaultRole = this.pickAssaultRole(windows.length > 0);
        this.assaultHold = math.max(this.assaultHold - dt, 0);

        if (this.assaultRole === "nade") {
            const nadeType = this.explosiveNadeType();
            const win = closestReachableFixture(windows, player, goal, 3.8)
                ?? closestFixture(windows, player.pos);
            if (win && nadeType) {
                const outside = this.routedDest(
                    player,
                    outsideApproach(win, goal, 3.8, player.game),
                    goal,
                );
                const toSpot = v2.distance(player.pos, outside);
                const open = windowThrowReady(win);
                this.assaultDest = outside;
                this.assaultAimPos = open
                    ? interiorThrowPoint(win, goal, target)
                    : v2.copy(win.pos);
                if (toSpot > 2.5) {
                    if (!open) this.assaultBreakWindow = win;
                    return;
                }
                if (!open) {
                    this.assaultBreakWindow = win;
                    return;
                }
                this.assaultThrowKind = nadeType;
                return;
            }
            const door = closestReachableFixture(doors, player, goal, 4.4)
                ?? closestFixture(doors, player.pos);
            if (door && nadeType) {
                const outside = this.routedDest(
                    player,
                    outsideApproach(door, goal, 4.4, player.game),
                    goal,
                );
                this.assaultDest = outside;
                this.assaultAimPos = interiorThrowPoint(door, goal, target);
                if (v2.distance(player.pos, outside) <= 2.4) {
                    this.assaultThrowKind = nadeType;
                }
                return;
            }
            this.assaultRole = "entry";
        }

        if (this.assaultRole === "smoke") {
            const door = closestReachableFixture(doors, player, goal, 4.8)
                ?? closestFixture(doors, player.pos);
            const smokeAmmo = player.invManager.get("smoke");
            if (door && smokeAmmo > 0) {
                const outside = this.routedDest(
                    player,
                    outsideApproach(door, goal, 4.8, player.game),
                    goal,
                );
                this.assaultDest = outside;
                this.assaultAimPos = v2.copy(door.pos);
                if (v2.distance(player.pos, outside) <= 2.6) {
                    this.assaultThrowKind = "smoke";
                }
                return;
            }
            this.assaultRole = "entry";
        }

        if (this.assaultRole === "peek") {
            const nearby = windows.filter((w) => v2.distance(player.pos, w.pos) < 16);
            const win = closestFixture(nearby, player.pos)
                ?? closestReachableFixture(windows, player, goal, 4.4)
                ?? closestFixture(windows, player.pos);
            if (win) {
                const peek = windowPeekSpot(win, goal, player.game);
                this.assaultDest = peek;
                const inward = v2.normalizeSafe(v2.sub(goal.pos, win.pos), v2.create(1, 0));
                const through = v2.add(win.pos, v2.mul(inward, 3.2));
                const canSeePeek = hasLineOfSight(player.game, player, target);
                this.assaultAimPos = canSeePeek ? v2.copy(target.pos) : through;
                if (v2.distance(player.pos, peek) <= 2.5) {
                    this.assaultHold = math.max(this.assaultHold, 2.2);
                }
                return;
            }
            const coverDoor = closestReachableFixture(doors, player, goal, 4.2)
                ?? closestFixture(doors, player.pos);
            if (coverDoor) {
                const cover = outsideApproach(coverDoor, goal, 4.4, player.game);
                this.assaultDest = cover;
                this.assaultAimPos = interiorThrowPoint(coverDoor, goal, target);
                if (v2.distance(player.pos, cover) <= 2.3) {
                    this.assaultHold = math.max(this.assaultHold, 1.8);
                }
                return;
            }
            this.assaultRole = "entry";
        }

        const door = closestReachableFixture(doors, player, goal, 3.0)
            ?? closestFixture(doors, player.pos);
        if (!door) {
            const win = closestReachableFixture(windows, player, goal, 2.4)
                ?? closestFixture(windows, player.pos);
            if (win) {
                this.assaultDest = this.routedDest(
                    player,
                    outsideApproach(win, goal, 2.4, player.game),
                    goal,
                );
                this.assaultBreakWindow = windowThrowReady(win) ? undefined : win;
                this.assaultAimPos = v2.copy(win.pos);
            } else {
                this.assaultDest = this.engageDest(target);
            }
            return;
        }

        const stackBase = outsideApproach(door, goal, 3.0, player.game);
        const away = v2.normalizeSafe(v2.sub(stackBase, door.pos), v2.create(1, 0));
        const side = v2.perp(away);
        const slot = (player.__id % 5) - 2;
        const stack = v2.add(stackBase, v2.mul(side, slot * 0.85));
        player.game.map.clampToMapBounds(stack, 6);
        const foyer = doorFoyerPoint(door, goal, 3.8, player.game);
        if (botNearDoor(door, player)) {
            tryUseDoor(
                door,
                player,
                target.pos,
                overlappingDoor(player) === door || botOnDoorThreshold(door, player),
            );
        }
        const onDoor = overlappingDoor(player) === door
            || botOnDoorThreshold(door, player);

        if (door.door?.open) {
            if (!player.indoors || v2.distance(player.pos, foyer) > 1.35) {
                this.assaultDest = this.routedDest(player, foyer, goal);
                return;
            }
            this.assaultDest = this.engageDest(target);
            return;
        }

        const toDoor = v2.distance(player.pos, stack);
        if (!onDoor && !door.door?.open && toDoor <= 1.8) {
            const approach = outsideApproach(door, goal, 1.35, player.game);
            this.assaultDest = this.routedDest(player, approach, goal);
            return;
        }
        if (!onDoor && !player.indoors && toDoor > 1.8) {
            this.assaultDest = this.routedDest(player, stack, goal);
            if (toDoor < 2.6 && this.assaultHold <= 0) this.assaultHold = util.random(0.35, 0.75);
            return;
        }
        if (!onDoor && this.assaultHold > 0) {
            this.assaultDest = this.routedDest(player, stack, goal);
            return;
        }
        // Door open or we're on the threshold: dest is PAST the door into the foyer.
        if (!player.indoors || v2.distance(player.pos, foyer) > 1.35) {
            this.assaultDest = foyer;
            return;
        }
        this.assaultDest = this.engageDest(target);
    }

    private engagesMelee(dist = Infinity): boolean {
        if (this.practiceCombat) return this.practiceCombat.meleeEngaged;
        return aiEngagesMelee(this.player, this.enemyClass, dist);
    }

    private secondaryHasRounds(player: Player): boolean {
        return aiSecondaryHasRounds(player);
    }

    private primaryHasRounds(player: Player): boolean {
        return !aiPrimaryDry(player);
    }

    private engageDest(target: Player): Vec2 {
        if (!target.specOpsAi) {
            // Hold range uses dedicated-melee standoff only — dry guns must not pull into knife range.
            return operatorEngagePoint(
                this.player,
                target,
                aiIsDedicatedMelee(this.enemyClass),
            );
        }
        return v2.copy(target.pos);
    }

    private canReviveFallen(): boolean {
        const role = this.loadout.role;
        return role === "medic" || role === "lieutenant" || role === "healer";
    }

    private pushHoldRange(push: number): number {
        const hold = this.loadout.holdRange + this.holdJitter;
        if (this.practiceCombat?.meleeEngaged) {
            return Math.min(hold, this.practiceCombat.meleeReach + (this.target?.rad ?? 1) - 0.4);
        }
        if (this.clearingHouse) return math.min(hold, 3.4);
        if (aiIsDedicatedMelee(this.enemyClass)) {
            // Knife units must not inherit the gun minHold floor (4.5) or they
            // backpedal out of AiMeleeAttackRange and never swing.
            return math.min(hold, AiMeleeAttackRange - 0.2);
        }
        const rangeBias = math.clamp(this.loadout.holdRange / 50, 0, 1);
        const minHold = math.max(4.5, this.loadout.holdRange * (0.35 + 0.3 * rangeBias));
        return math.lerp(push, hold, minHold);
    }

    private gunHasRounds(player: Player): boolean {
        if (this.primaryHasRounds(player)) return true;
        return this.secondaryHasRounds(player);
    }

    private standoffRange(player: Player, hold: number): number {
        if (this.practiceCombat?.meleeEngaged) return Math.max(0.5, hold - 0.2);
        if (this.loadout.suicideVest) return 0.8;
        if (this.clearingHouse) return math.min(hold, 3.4);
        if (aiIsDedicatedMelee(this.enemyClass)) {
            return operatorStandoffDist(player, true);
        }
        return math.max(
            operatorStandoffDist(player, false),
            math.min(math.max(4.5, hold * 0.35), hold * 0.9),
        );
    }

    private fallenTeammate(manager: SpecOpsManager): Player | undefined {
        const mates = this.kind === "enemy"
            ? manager.livingEnemies()
            : [...manager.livingAllies(), ...manager.livingHumans()];
        let best: Player | undefined;
        let bestDist = Infinity;
        for (let i = 0; i < mates.length; i++) {
            const mate = mates[i];
            if (
                mate === this.player
                || !mate.downed
                || mate.specOpsSuicideVest
                || mate.specOpsMirvCrawl
            ) {
                continue;
            }
            if (mate.actionType === GameConfig.Action.Revive) continue;
            const dist = v2.lengthSqr(v2.sub(mate.pos, this.player.pos));
            if (dist < bestDist) {
                bestDist = dist;
                best = mate;
            }
        }
        return best;
    }

    prioritizeFallenTeammate(manager: SpecOpsManager): void {
        const fallen = this.fallenTeammate(manager);
        if (fallen) {
            this.target = fallen;
            this.alerted = true;
        }
    }

    private updateBugle(dt: number, player: Player): void {
        this.bugleCooldown = math.max(this.bugleCooldown - dt, 0);
        if (this.loadout.role !== "bugler" || player.downed) return;
        if (this.nadeState !== "idle") return;

        const bugleSlot = player.weapons.findIndex((weap) => weap.type === "bugle");
        if (bugleSlot < 0) return;

        if (this.bugleHoldTicker > 0) {
            this.bugleHoldTicker -= dt;
            if (player.curWeapIdx !== bugleSlot) {
                player.weaponManager.setCurWeapIndex(bugleSlot);
            }
            player.shootStart = true;
            player.shootHold = true;
            this.shooting = false;
            if (this.bugleHoldTicker <= 0 || player.weapons[bugleSlot].ammo <= 0) {
                this.bugleHoldTicker = 0;
                if (player.weapons[GameConfig.WeaponSlot.Primary].type) {
                    player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
                }
            }
            return;
        }

        if (this.bugleCooldown > 0 || player.weapons[bugleSlot].ammo <= 0) return;
        if (!this.alerted) return;

        player.weaponManager.setCurWeapIndex(bugleSlot);
        player.shootStart = true;
        player.shootHold = true;
        this.shooting = false;
        this.bugleHoldTicker = 0.7;
        this.bugleCooldown = 8.2;
    }

    private squadMates(manager: SpecOpsManager): Player[] {
        return this.kind === "enemy"
            ? manager.livingEnemies()
            : [...manager.livingAllies(), ...manager.livingHumans()];
    }

    private tryMedicHeal(dt: number, manager: SpecOpsManager): boolean {
        const player = this.player;
        this.healCooldown = math.max(this.healCooldown - dt, 0);
        if (this.healCooldown > 0) return false;
        if (player.actionType !== GameConfig.Action.None) return false;

        const range = GameConfig.player.medicHealRange;
        const rangeSqr = range * range;
        const mates = this.squadMates(manager);
        let wounded = false;
        let nearby = false;
        for (let i = 0; i < mates.length; i++) {
            const mate = mates[i];
            if (mate.dead || mate.downed) continue;
            const distSqr = v2.lengthSqr(v2.sub(mate.pos, player.pos));
            if (distSqr > rangeSqr) continue;
            nearby = true;
            if (mate.health < 40 || mate === player && mate.health < 55) {
                wounded = true;
                break;
            }
        }
        if (!nearby) return false;

        if (wounded) {
            if (player.invManager.get("bandage") > 0) {
                player.useHealingItem("bandage");
            } else if (player.invManager.get("healthkit") > 0) {
                player.useHealingItem("healthkit");
            } else if (player.invManager.get("soda") > 0) {
                player.useBoostItem("soda");
            } else {
                return false;
            }
        } else if (player.invManager.get("soda") > 0 && this.alerted) {
            player.useBoostItem("soda");
        } else if (player.invManager.get("painkiller") > 0 && this.alerted) {
            player.useBoostItem("painkiller");
        } else {
            return false;
        }

        this.healCooldown = 5.5;
        // useHealingItem / useBoostItem start Action.UseItem; TS keeps the prior None narrow.
        return (player.actionType as number) === GameConfig.Action.UseItem;
    }

    private holdForWounded(manager: SpecOpsManager): boolean {
        const player = this.player;
        const range = GameConfig.player.medicHealRange;
        const mates = this.squadMates(manager);
        let closest: Player | undefined;
        let closestDist = Infinity;
        for (let i = 0; i < mates.length; i++) {
            const mate = mates[i];
            if (mate === player || mate.dead || mate.downed) continue;
            if (mate.health >= 40) continue;
            const dist = v2.distance(player.pos, mate.pos);
            if (dist < closestDist) {
                closestDist = dist;
                closest = mate;
            }
        }
        if (!closest) return false;
        if (closestDist <= range) return true;
        const toward = v2.normalizeSafe(v2.sub(closest.pos, player.pos));
        player.dirNew = toward;
        player.touchMoveActive = true;
        player.touchMoveDir = steerAroundWalls(player.game, player, toward);
        player.touchMoveLen = 255;
        return true;
    }

    private updateCommandAura(dt: number): void {
        this.commandTicker = math.max(this.commandTicker - dt, 0);
        const role = this.loadout.role;
        if (role !== "captain" && role !== "leader") return;
        if (this.commandTicker > 0 || this.player.downed) return;

        const nearby = this.player.game.modeManager.getNearbyAlivePlayersContext(
            this.player,
            22,
        );
        let buffed = 0;
        for (let i = 0; i < nearby.length; i++) {
            const mate = nearby[i];
            if (mate === this.player || mate.downed) continue;
            mate.giveHaste(GameConfig.HasteType.Inspire, 2.8);
            buffed++;
        }
        if (buffed > 0) this.commandTicker = 5.5;
    }
}

/** Seconds with no connected humans before a started Spec Ops match is destroyed.
 * Keep >= client/server rejoin token TTL (90s) so crash-rejoin has a real window. */
export const SpecOpsAbandonedTimeout = 90;
/** Seconds without movement/shoot/interact before a connected operator is treated as idle. */
export const SpecOpsIdleTimeout = 300;

export class SpecOpsManager implements PracticeHost {
    static readonly AiTeamId = AiTeamId;

    readonly game: Game;
    readonly aiTeam: Team;

    wave = 0;
    phase: Phase = "prep";
    phaseTimer = PrepTime;
    phaseDuration = PrepTime;
    hudDirty = true;
    joinLocked = false;
    /** True while the long break after every 5th wave is running. */
    onBreak = false;
    /** Player ids that voted to end the current break early. */
    readonly breakVotes = new Set<number>();
    /** Early-start cash is paid on at most this many seconds during a break. */
    breakBonusSeconds = 0;
    private lastBreakVoteCode = -1;
    abandonedTicker = 0;
    difficulty: SpecOpsDifficulty = "regular";
    endless = false;
    contractsEnabled = true;
    /** Debug: enemies do not acquire or retaliate against human operators. */
    npcIgnoreOperators = false;
    operatorSpawn?: Vec2;
    /** 0-1: how hard remaining AI should rush after the operator farms kills. */
    pushPressure = 0;

    private brains = new Map<Player, AiBrain>();
    private toRemove: Player[] = [];
    private lastHudEnemies = -1;
    private lastHudWave = -1;
    private lastHudSecond = -1;
    private spawnedThisWave = false;
    private stationsPlaced = false;
    private huntClock = 0;
    private airstrikeCooldown = 0;
    private buyCooldown = new Map<number, number>();
    private carePackageCooldown = 0;
    /** Ironclads summoned by human IR strobe spam this wave. */
    private ironcladsThisWave = 0;
    private pendingVestExplosions: { pos: Vec2; layer: number; timer: number }[] = [];
    private pendingMirvBursts: {
        pos: Vec2;
        layer: number;
        timer: number;
        remaining: number;
    }[] = [];
    private pendingCastIronWipes: {
        pos: Vec2;
        layer: number;
        timer: number;
        rad: number;
    }[] = [];
    readonly nav = new NavField();
    paths?: MapNavGraph;
    private killHeat = 0;
    private combatElapsed = 0;
    private waveSpawned = 0;
    private botArenaStarterSpawned = false;
    private botArenaStarterDelay = 0;
    private botArenaManualSpawned = false;
    private debugSpawnQueue: Array<() => void> = [];
    private supportGroupIds = new Set<number>();
    shopSkipLock = 0;
    /** Wave 29→30 cinematic: event boss wipes the glory horde under truce. */
    gloryExecutioner?: Player;
    gloryWipeActive = false;
    gloryTrucePause = false;
    gloryHelperTicker = 0;
    gloryHelpersThisWave = 0;
    private waveSpawnQueue: PendingWaveSpawn[] = [];
    private waveSpawnComplete = false;
    private waveSpawnPulseTimer = 0;
    private waveSpawnPulseIndex = 0;
    readonly contracts = new SpecOpsContractRunner(this);
    private lastContractHudCode = -1;

    /** Practice mode controller; undefined in normal Spec Ops. */
    readonly practice?: PracticeController;

    constructor(game: Game) {
        this.game = game;
        this.difficulty = parseSpecOpsDifficulty(game.config.difficulty);
        this.endless = !!game.config.endless;
        this.contractsEnabled = game.config.contractsEnabled !== false;
        this.aiTeam = game.playerBarn.addTeam(AiTeamId);
        game.gas.disableForSpecOps();
        if (game.map.practiceMode) {
            this.practice = new PracticeController(this);
            this.contractsEnabled = false;
        }
    }

    ensureNavGraph(): MapNavGraph {
        if (!this.paths) this.paths = MapNavGraph.build(this.game);
        return this.paths;
    }

    /** Delayed suicide-vest boom so operators can clear after shooting a bomber. */
    scheduleVestExplosion(pos: Vec2, layer: number, delay: number): void {
        this.pendingVestExplosions.push({
            pos: v2.copy(pos),
            layer,
            timer: math.max(delay, 0.05),
        });
    }

    /**
     * Cast Iron death: call in a strike that wipes nearby enemy AI only.
     * Operators / hired support are never damaged.
     */
    scheduleCastIronWipe(pos: Vec2, layer: number): void {
        for (let i = 0; i < this.pendingCastIronWipes.length; i++) {
            const pending = this.pendingCastIronWipes[i];
            if (
                util.sameLayer(pending.layer, layer)
                && v2.distance(pending.pos, pos) < 30
                && pending.timer > 0
            ) {
                return;
            }
        }
        this.game.playerBarn.addMapPing("ping_airstrike", pos);
        this.pendingCastIronWipes.push({
            pos: v2.copy(pos),
            layer,
            timer: 1.35,
            rad: 30,
        });
    }

    private hasCastIronWipeNear(pos: Vec2, layer: number, radius: number): boolean {
        const r2 = radius * radius;
        for (let i = 0; i < this.pendingCastIronWipes.length; i++) {
            const pending = this.pendingCastIronWipes[i];
            if (!util.sameLayer(pending.layer, layer)) continue;
            if (pending.timer <= 0) continue;
            if (v2.lengthSqr(v2.sub(pending.pos, pos)) <= r2) return true;
        }
        return false;
    }

    private runCastIronWipe(wipe: {
        pos: Vec2;
        layer: number;
        rad: number;
    }): void {
        const enemies = this.livingEnemies();
        const r2 = wipe.rad * wipe.rad;
        let hasEnemyInRadius = false;
        for (let i = 0; i < enemies.length; i++) {
            const enemy = enemies[i];
            if (!util.sameLayer(enemy.layer, wipe.layer)) continue;
            if (v2.lengthSqr(v2.sub(enemy.pos, wipe.pos)) > r2) continue;
            hasEnemyInRadius = true;
            break;
        }

        // Real airstrike for the fight — shield operators so only the AI squad dies.
        const humans = this.livingHumans();
        for (let i = 0; i < humans.length; i++) {
            humans[i].specOpsImmunityTicker = math.max(
                humans[i].specOpsImmunityTicker,
                5.5,
            );
        }
        if (hasEnemyInRadius) {
            this.game.planeBarn.addAirstrikeZone(wipe.pos, wipe.rad * 0.85, 4, 0.85, 0.4);
        }

        for (let i = 0; i < enemies.length; i++) {
            const enemy = enemies[i];
            if (!util.sameLayer(enemy.layer, wipe.layer)) continue;
            if (v2.lengthSqr(v2.sub(enemy.pos, wipe.pos)) > r2) continue;
            enemy.damage({
                amount: 9999,
                damageType: GameConfig.DamageType.Airstrike,
                dir: v2.normalizeSafe(v2.sub(enemy.pos, wipe.pos), v2.create(1, 0)),
                gameSourceType: "bomb_iron",
            });
        }
    }

    /** Nearby enemies investigate / engage when one spots a threat. */
    alertSquad(pos: Vec2, source: Player, radius: number): void {
        const r2 = radius * radius;
        for (const brain of this.brains.values()) {
            if (brain.player === source) continue;
            if (brain.player.dead || brain.kind !== "enemy") continue;
            if (v2.lengthSqr(v2.sub(brain.player.pos, pos)) > r2) continue;
            brain.alertTo(pos);
        }
    }

    /** Enemy medic/lieutenant should react when a squadmate is knocked. */
    onEnemyDowned(victim: Player): void {
        if (victim.specOpsKind !== "enemy") return;
        this.alertSquad(victim.pos, victim, 24);
        for (const brain of this.brains.values()) {
            if (brain.kind !== "enemy" || brain.player.dead || brain.player.downed) continue;
            const role = brain.loadout.role;
            if (role !== "medic" && role !== "lieutenant" && role !== "healer") continue;
            brain.prioritizeFallenTeammate(this);
        }
    }

    /** Operator is farming the wave: remaining AI heat up and start pushing. */
    onEnemyKilled(killer: Player, victim: Player): void {
        if (victim.specOpsKind !== "enemy") return;

        this.contracts.onEnemyKilled(killer, victim);

        const brain = this.brains.get(victim);
        if (brain?.loadout.castIronWipe || brain?.enemyClass === "cast_iron") {
            this.scheduleCastIronWipe(victim.pos, victim.layer);
        }

        if (killer.specOpsAi) return;
        if (this.npcIgnoreOperators) {
            this.killHeat = math.min(KillHeatCap, this.killHeat + KillHeatPerKill);
            this.refreshPushPressure(0);
            return;
        }
        this.killHeat = math.min(KillHeatCap, this.killHeat + KillHeatPerKill);
        this.refreshPushPressure(0);
        if (this.pushPressure < 0.35) return;

        this.alertSquad(killer.pos, victim, 28 + this.pushPressure * 50);
        if (this.pushPressure < 0.58) return;
        for (const brain of this.brains.values()) {
            if (brain.kind !== "enemy" || brain.player.dead) continue;
            brain.alertTo(killer.pos);
        }
    }

    private refreshPushPressure(dt: number): void {
        this.killHeat = math.max(0, this.killHeat - dt * KillHeatDecay);
        if (this.phase === "combat") this.combatElapsed += dt;

        let pacePush = 0;
        if (this.phase === "combat" && this.waveSpawned > 2 && this.combatElapsed > 4) {
            const dead = math.max(0, this.waveSpawned - this.enemiesAlive);
            const pace = dead / this.combatElapsed;
            pacePush = math.clamp((pace - 0.04) / 0.1, 0, 1);
        }
        this.pushPressure = math.clamp(
            (this.killHeat * 0.82 + pacePush * 0.55) * specOpsDifficultyMods(this.difficulty).pressure,
            0,
            1,
        );
    }

    private resetPushPressure(): void {
        this.killHeat = 0;
        this.combatElapsed = 0;
        this.pushPressure = 0;
    }

    /** Called when an AI takes damage so they react even if shot from behind. */
    onAiDamaged(ai: Player, attacker?: Player, hitDir?: Vec2): void {
        const brain = this.brains.get(ai);
        if (!brain || ai.dead) return;
        const fromPos = attacker && !attacker.dead
            ? attacker.pos
            : hitDir
            ? v2.sub(ai.pos, v2.mul(v2.normalizeSafe(hitDir), 4))
            : ai.pos;
        brain.onDamaged(fromPos, attacker);
        this.alertSquad(fromPos, ai, 20);
    }

    livingHumans(): Player[] {
        const living = this.game.playerBarn.livingPlayers;
        const out: Player[] = [];
        for (let i = 0; i < living.length; i++) {
            const player = living[i];
            if (!player.specOpsAi && !player.disconnected) {
                out.push(player);
            }
        }
        return out;
    }

    livingEnemies(): Player[] {
        const living = this.game.playerBarn.livingPlayers;
        const out: Player[] = [];
        for (let i = 0; i < living.length; i++) {
            if (living[i].specOpsKind === "enemy") out.push(living[i]);
        }
        return out;
    }

    /** Weak glory-horde fodder (excludes the wave-30 executioner). */
    livingWeakEnemies(): Player[] {
        const living = this.livingEnemies();
        const out: Player[] = [];
        for (let i = 0; i < living.length; i++) {
            const player = living[i];
            if (player === this.gloryExecutioner) continue;
            const brain = this.brains.get(player);
            if (brain?.gloryExecutioner) continue;
            if (brain?.enemyClass && WeakHordeClasses.has(brain.enemyClass)) {
                out.push(player);
                continue;
            }
            // Anything that isn't the executioner during the wipe still counts as fodder.
            if (this.gloryWipeActive) out.push(player);
        }
        return out;
    }

    hasLivingReviver(teamId: number, except?: Player): boolean {
        const living = this.game.playerBarn.livingPlayers;
        for (let i = 0; i < living.length; i++) {
            const player = living[i];
            if (player === except || player.downed || player.dead) continue;
            if (player.teamId !== teamId) continue;
            if (
                player.role === "medic"
                || player.role === "lieutenant"
                || player.role === "healer"
            ) {
                return true;
            }
        }
        return false;
    }

    livingAllies(kind?: "ally" | "sentry"): Player[] {
        const living = this.game.playerBarn.livingPlayers;
        const out: Player[] = [];
        for (let i = 0; i < living.length; i++) {
            const player = living[i];
            if (kind) {
                if (player.specOpsKind === kind) out.push(player);
            } else if (player.specOpsKind === "ally" || player.specOpsKind === "sentry") {
                out.push(player);
            }
        }
        return out;
    }

    livingHiredAllies(): Player[] {
        const living = this.livingAllies("ally");
        const out: Player[] = [];
        for (let i = 0; i < living.length; i++) {
            if (!this.brains.get(living[i])?.gloryHelper) out.push(living[i]);
        }
        return out;
    }

    /** Hired allies + sentries. Free glory helpers are excluded. */
    hiredSupportCount(): number {
        return this.livingHiredAllies().length + this.livingAllies("sentry").length;
    }

    hostileTargets(): Player[] {
        const living = this.game.playerBarn.livingPlayers;
        const out: Player[] = [];
        for (let i = 0; i < living.length; i++) {
            const player = living[i];
            if (player.disconnected) continue;
            if (!player.specOpsAi) {
                if (!this.npcIgnoreOperators) out.push(player);
                continue;
            }
            if (player.specOpsKind === "ally" || player.specOpsKind === "sentry") {
                out.push(player);
            }
        }
        return out;
    }

    setNpcIgnoreOperators(ignore: boolean): void {
        if (this.npcIgnoreOperators === ignore) return;
        this.npcIgnoreOperators = ignore;
        if (!ignore) return;
        for (const brain of this.brains.values()) {
            if (brain.kind !== "enemy") continue;
            const target = brain.target;
            if (target && !target.specOpsAi) {
                brain.target = undefined;
            }
            brain.returnFireTicker = 0;
        }
    }

    get enemiesAlive(): number {
        return this.livingEnemies().length;
    }

    get humanCount(): number {
        return this.livingHumans().length;
    }

    /** Connected operators, including dead ones waiting for buyback. */
    get operatorCount(): number {
        const players = this.game.playerBarn.players;
        let n = 0;
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (!player.specOpsAi && !player.disconnected) n++;
        }
        return n;
    }

    get allowJoin(): boolean {
        if (this.game.over) return false;
        // Fill matches stay open at every wave; only L / No Fill closes them.
        if (this.joinLocked) return false;
        if (this.game.started && this.operatorCount <= 0) return false;
        if (
            this.game.started
            && !this.game.map.specOpsBotArena
            && this.allConnectedHumansIdle()
        ) {
            return false;
        }

        return this.operatorCount + this.game.pendingJoinTokens() < this.game.maxTeamSize;
    }

    /** Open seats for the server browser (ignores AFK-idle matchmaking closure). */
    get browsable(): boolean {
        if (this.game.over) return false;
        // Practice matches are private.
        if (this.practice) return false;
        if (this.joinLocked) return false;
        if (this.game.started && this.operatorCount <= 0) return false;
        return this.operatorCount + this.game.pendingJoinTokens() < this.game.maxTeamSize;
    }

    /**
     * Reclaim seats for disconnected (or reload-racing) operators. Ignores
     * joinLocked / no-fill so crash-rejoin still works; random matchmaking
     * stays on `allowJoin`.
     */
    get allowReconnectTokens(): boolean {
        if (!this.game.started || this.game.over) return false;
        return this.reclaimableHumanCount() > 0;
    }

    disconnectedHumanCount(): number {
        const players = this.game.playerBarn.players;
        let n = 0;
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (p.specOpsAi) continue;
            if (p.disconnected) n++;
        }
        return n;
    }

    /**
     * Seats that may accept a reconnect token: disconnected, or still marked
     * connected while the old websocket is closing (page reload race).
     */
    reclaimableHumanCount(): number {
        const players = this.game.playerBarn.players;
        let n = 0;
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (p.specOpsAi) continue;
            if (p.disconnected || p.client.socket.closed()) n++;
        }
        return n;
    }

    /** True when an incoming reclaimPlayerId targets a living human operator. */
    hasReclaimableSeat(reclaimPlayerId?: number): boolean {
        if (!reclaimPlayerId) return false;
        const players = this.game.playerBarn.players;
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (p.specOpsAi) continue;
            if (p.__id === reclaimPlayerId) return true;
        }
        return false;
    }

    allConnectedHumansIdle(): boolean {
        if (this.operatorCount <= 0) return false;
        // Stepping away is the point of a break; don't close the match for it.
        if (this.onBreak) return false;

        const now = this.game.now;
        if (!now) return false;
        const idleMs = SpecOpsIdleTimeout * 1000;
        const players = this.game.playerBarn.players;
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (player.specOpsAi || player.disconnected) continue;
            if (now - player.lastActivityTime < idleMs) return false;
        }
        return true;
    }

    private tickAbandonedLobby(dt: number): void {
        if (this.game.map.specOpsBotArena) return;
        const connected = this.operatorCount;
        if (connected > 0) {
            if (!this.allConnectedHumansIdle()) {
                this.abandonedTicker = 0;
                return;
            }
            this.endAbandonedMatch();
            return;
        }
        this.abandonedTicker += dt;
        if (this.abandonedTicker >= SpecOpsAbandonedTimeout) {
            this.endAbandonedMatch();
        }
    }

    private endAbandonedMatch(): void {
        if (this.game.over) return;
        this.game.over = true;
        this.game.stopTicker = 1;
        this.game.updateData();
    }

    get hudWaveId(): number {
        return this.wave
            | (this.joinLocked ? SpecOpsJoinLockFlag : 0)
            | (this.onBreak ? SpecOpsBreakFlag : 0);
    }

    /** HUD counter: hostiles left, or the packed skip vote count during a break. */
    get hudCounter(): number {
        if (!this.onBreak) return this.enemiesAlive;
        return specOpsPackBreakVotes(this.breakVotesReady(), this.breakVotesNeeded());
    }

    /** Votes from operators who are still alive and connected. */
    breakVotesReady(): number {
        const humans = this.livingHumans();
        let n = 0;
        for (let i = 0; i < humans.length; i++) {
            if (this.breakVotes.has(humans[i].__id)) n++;
        }
        return n;
    }

    breakVotesNeeded(): number {
        return specOpsBreakVotesNeeded(this.livingHumans().length);
    }

    /**
     * Ends the break once a majority has voted. Also runs every tick, so the
     * break ends if a non-voter leaves or dies and the voters become a majority.
     */
    private checkBreakVotes(): boolean {
        if (!this.onBreak) return false;
        const ready = this.breakVotesReady();
        const needed = this.breakVotesNeeded();
        const code = specOpsPackBreakVotes(ready, needed);
        if (code !== this.lastBreakVoteCode) {
            this.lastBreakVoteCode = code;
            this.hudDirty = true;
        }
        if (ready <= 0 || ready < needed) return false;

        const seconds = math.min(this.phaseTimer, this.breakBonusSeconds);
        const bonus = specOpsEarlyStartBonus(seconds);
        if (bonus > 0) {
            const humans = this.livingHumans();
            for (let i = 0; i < humans.length; i++) {
                this.grantCash(humans[i], bonus);
            }
        }
        this.startWave();
        return true;
    }

    /** Press L to stop matchmaking from filling empty squad seats. */
    tryLockJoin(player: Player): boolean {
        if (player.specOpsAi || player.dead || player.disconnected) return false;
        return this.lockJoin();
    }

    /** Lock empty seats so randoms cannot join. Used by No Fill lobbies and the L key. */
    lockJoin(): boolean {
        if (this.joinLocked) return false;
        this.joinLocked = true;
        this.hudDirty = true;
        this.game.updateData();
        return true;
    }

    onMatchStarted(): void {
        // Practice has no waves, shop or stations.
        if (this.practice) return;
        this.phase = "prep";
        // Veteran opens on wave 5 — prep sits at wave-1 so startWave() advances to 5.
        this.wave = Math.max(0, specOpsStartingWave(this.difficulty) - 1);
        const prep = PrepTime * specOpsDifficultyMods(this.difficulty).intermission;
        this.phaseTimer = prep;
        this.phaseDuration = prep;
        this.shopSkipLock = ShopSkipLockTime;
        this.hudDirty = true;
        this.game.gas.setSpecOpsCountdown(this.phaseTimer, this.phaseDuration);
        this.placeStations();
    }

    onHumanJoined(player: Player): void {
        if (player.specOpsAi) return;

        if (this.practice) {
            if (!this.operatorSpawn) this.operatorSpawn = v2.copy(player.pos);
            this.practice.onHumanJoined(player);
            this.hudDirty = true;
            return;
        }

        if (!this.operatorSpawn) {
            this.operatorSpawn = v2.copy(player.pos);
        } else {
            const nearby = this.pickSpawnNear(this.operatorSpawn, 4, 10);
            v2.set(player.pos, nearby);
            player.game.grid.updateObject(player);
            player.setDirty();
        }

        this.grantCash(player, specOpsStartingCash(this.difficulty), true, false);

        // MW3-style vitals: high HP + armor pool (gear DR is disabled in Spec Ops).
        player.health = SpecOpsStartingHealth;
        player.specOpsArmor = specOpsStartingArmor(this.difficulty);
        player.specOpsContractHud = this.phase === "combat" ? this.contracts.hudCode : 0;
        player.specOpsContractDirty = true;
        if (!player.chest) player.chest = "chest01";
        if (!player.helmet) player.helmet = "helmet01";
        player.invManager.give("bandage", 10);
        player.invManager.give("soda", 4);
        player.setDirty();

        const primary = player.weapons[GameConfig.WeaponSlot.Primary];
        if (!primary.type) {
            const ammoStats = player.weaponManager.getAmmoStats(
                GameObjectDefs.typeToDef("m9", "gun"),
                "m9",
            );
            player.weaponManager.setWeapon(
                GameConfig.WeaponSlot.Primary,
                "m9",
                ammoStats.maxClip,
            );
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
            player.invManager.give("9mm", 90);
        }
        this.placeStations();
        this.hudDirty = true;

        if (
            Config.debug.allowNpcSpawn
            && this.game.map.specOpsBotArena
            && !this.botArenaStarterSpawned
            && !this.botArenaManualSpawned
        ) {
            this.botArenaStarterDelay = 2;
        }
    }

    queueRemove(player: Player): void {
        if (!this.toRemove.includes(player)) {
            this.toRemove.push(player);
        }
    }

    flush(): void {
        this.hudDirty = false;
    }

    update(dt: number): void {
        this.ensureNavGraph();

        if (this.debugSpawnQueue.length) {
            const batch = math.min(this.debugSpawnQueue.length, util.random(3, 5));
            for (let i = 0; i < batch; i++) {
                const spawn = this.debugSpawnQueue.shift();
                if (!spawn) break;
                try {
                    spawn();
                } catch (err) {
                    this.game.logger.error("Debug spawn failed", err);
                }
            }
        }

        if (this.botArenaStarterDelay > 0) {
            this.botArenaStarterDelay = math.max(this.botArenaStarterDelay - dt, 0);
            if (this.botArenaStarterDelay <= 0 && !this.botArenaStarterSpawned) {
                this.botArenaStarterSpawned = true;
                for (let i = 0; i < 5; i++) {
                    try {
                        this.spawnEnemyPublic("militia");
                    } catch (err) {
                        this.game.logger.error("Bot arena starter spawn failed", err);
                    }
                }
            }
        }

        this.airstrikeCooldown = math.max(this.airstrikeCooldown - dt, 0);
        this.carePackageCooldown = math.max(this.carePackageCooldown - dt, 0);
        for (const [id, remaining] of this.buyCooldown) {
            const next = remaining - dt;
            if (next <= 0) this.buyCooldown.delete(id);
            else this.buyCooldown.set(id, next);
        }

        for (let i = this.pendingVestExplosions.length - 1; i >= 0; i--) {
            const fuse = this.pendingVestExplosions[i];
            fuse.timer -= dt;
            if (fuse.timer > 0) continue;
            this.game.explosionBarn.addExplosion(
                "explosion_martyr_nade",
                fuse.pos,
                fuse.layer,
                {
                    damageType: GameConfig.DamageType.Player,
                    gameSourceType: "frag",
                    weaponSourceType: "frag",
                },
            );
            this.pendingVestExplosions.splice(i, 1);
        }

        for (let i = this.pendingMirvBursts.length - 1; i >= 0; i--) {
            const burst = this.pendingMirvBursts[i];
            burst.timer -= dt;
            if (burst.timer > 0) continue;
            const offset = v2.mul(v2.randomUnit(), util.random(0.4, 1.8));
            this.game.explosionBarn.addExplosion(
                "explosion_mirv",
                v2.add(burst.pos, offset),
                burst.layer,
                {
                    damageType: GameConfig.DamageType.Player,
                    gameSourceType: "mirv",
                    weaponSourceType: "mirv",
                },
            );
            burst.remaining -= 1;
            if (burst.remaining <= 0) {
                this.pendingMirvBursts.splice(i, 1);
            } else {
                burst.timer = 0.28;
            }
        }

        for (let i = this.pendingCastIronWipes.length - 1; i >= 0; i--) {
            const wipe = this.pendingCastIronWipes[i];
            wipe.timer -= dt;
            if (wipe.timer > 0) continue;
            this.runCastIronWipe(wipe);
            this.pendingCastIronWipes.splice(i, 1);
        }

        if (this.game.over) return;
        if (!this.game.started) return;

        this.tickAbandonedLobby(dt);
        if (this.game.over) return;

        if (!this.operatorSpawn) {
            const humans = this.livingHumans();
            if (humans.length) {
                this.operatorSpawn = v2.copy(humans[0].pos);
            }
        }

        this.refreshPushPressure(dt);

        const enemies = this.enemiesAlive;
        if (this.wave !== this.lastHudWave || enemies !== this.lastHudEnemies) {
            this.lastHudWave = this.wave;
            this.lastHudEnemies = enemies;
            this.hudDirty = true;
            this.game.playerBarn.killLeaderDirty = true;
        }

        const shopping = this.phase === "prep" || this.phase === "intermission";
        if (this.practice) {
            this.practice.update(dt);
        } else if (!this.game.map.specOpsBotArena) {
            if (shopping) {
                this.shopSkipLock = math.max(this.shopSkipLock - dt, 0);
                this.phaseTimer = math.max(this.phaseTimer - dt, 0);
                const second = Math.ceil(this.phaseTimer);
                if (second !== this.lastHudSecond) {
                    this.lastHudSecond = second;
                    this.game.gas.setSpecOpsCountdown(
                        this.phaseTimer,
                        math.max(this.phaseDuration, 0.001),
                    );
                }

                if (this.phaseTimer <= 0) {
                    this.startWave();
                } else {
                    this.checkBreakVotes();
                }
            } else if (this.phase === "combat") {
                if (this.contractsEnabled) {
                    this.contracts.update(dt);
                    this.syncContractHud();
                }
                this.tickGloryHorde();
                this.tickGloryHelpers(dt);
                if (this.gloryWipeActive) {
                    // Keep the executioner invulnerable during the wipe / truce.
                    if (this.gloryExecutioner && !this.gloryExecutioner.dead) {
                        this.gloryExecutioner.specOpsImmunityTicker = math.max(
                            this.gloryExecutioner.specOpsImmunityTicker,
                            1,
                        );
                    }
                    if (this.livingWeakEnemies().length <= 0) {
                        this.beginGloryTrucePause();
                    }
                } else if (this.spawnedThisWave && this.waveSpawnComplete && enemies <= 0) {
                    this.beginIntermission();
                }
            }

            if (this.phase === "combat" && this.spawnedThisWave) {
                this.tickWaveSpawns(dt);
            }
        } else if (shopping) {
            this.phaseTimer = PrepTime;
            this.phaseDuration = PrepTime;
            this.game.gas.setSpecOpsCountdown(this.phaseTimer, this.phaseDuration);
        }

        this.nav.decay(dt);
        this.nav.resetCrowd();
        for (const brain of this.brains.values()) {
            if (!brain.player.dead) this.nav.occupy(brain.player.pos);
        }
        for (const brain of this.brains.values()) {
            brain.update(dt, this);
        }
        if (this.phase === "combat" && this.spawnedThisWave) {
            this.tickDiscoveryHunt(dt);
            this.relocateStuckEnemies();
        }

        for (let i = 0; i < this.toRemove.length; i++) {
            const player = this.toRemove[i];
            if (player.specOpsKind === "ally" || player.specOpsKind === "sentry") {
                this.releaseSupportGroupId(player.groupId);
            }
            this.brains.delete(player);
            if (!player.destroyed) {
                this.game.playerBarn.removePlayer(player);
            }
        }
        this.toRemove.length = 0;
    }

    isShopping(): boolean {
        return this.phase === "prep" || this.phase === "intermission";
    }

    /** Press E during prep/intermission to start the next wave. */
    tryStartWaveEarly(player: Player): boolean {
        if (this.game.map.specOpsBotArena || this.practice) return false;
        if (player.specOpsAi || player.dead || player.downed || player.disconnected) {
            return false;
        }
        if (this.phase !== "prep" && this.phase !== "intermission") return false;
        if (this.shopSkipLock > 0) return false;

        // Long break: E is a skip vote; the wave starts once a majority is ready.
        if (this.onBreak) {
            if (this.breakVotes.has(player.__id)) return false;
            this.breakVotes.add(player.__id);
            this.hudDirty = true;
            this.checkBreakVotes();
            return true;
        }

        const bonus = specOpsEarlyStartBonus(this.phaseTimer);
        const humans = this.livingHumans();
        if (bonus > 0) {
            for (let i = 0; i < humans.length; i++) {
                this.grantCash(humans[i], bonus);
            }
        }
        this.startWave();
        return true;
    }

    /** Test helper: skip the shop timer without bonus cash. */
    startNextWave(): void {
        if (this.phase !== "prep" && this.phase !== "intermission") return;
        this.startWave();
    }

    /** Test helper: spawn the full wave roster immediately (no stagger). */
    drainWaveSpawnQueuePublic(): void {
        this.waveSpawnPulseTimer = 0;
        while (this.waveSpawnQueue.length > 0) {
            this.spawnWaveBatch(999);
        }
        this.waveSpawnComplete = true;
    }

    /**
     * Debug cheat: jump directly to wave `targetWave` (1–30).
     * Kills all living enemies, resets wave state, and launches the new wave.
     * Safe to call at any phase (prep, intermission, or mid-combat).
     */
    jumpToWave(targetWave: number): void {
        const clamped = Math.max(1, Math.min(30, Math.floor(targetWave)));

        // Kill all living AI enemies so the new wave can start clean.
        for (const [player] of this.brains) {
            if (!player.dead && player.specOpsAi && player.specOpsKind === "enemy") {
                this.toRemove.push(player);
            }
        }

        // Set wave to clamped - 1 so startWave() increments to the right value.
        this.wave = clamped - 1;
        this.phase = "intermission"; // startWave() needs any non-combat phase

        // Cancel any pending glory wipe state.
        this.gloryWipeActive = false;

        this.startWave();
        this.game.logger.info(`[cheat] Jumped to wave ${this.wave}`);
    }

    private enqueueWaveSpawn(
        kind: EnemyClass,
        indexInSquad: number,
        squadSize: number,
        approachAngle: number,
        host?: Player,
    ): void {
        this.waveSpawnQueue.push({
            kind,
            indexInSquad,
            squadSize,
            approachAngle,
            host,
        });
    }

    private tickWaveSpawns(dt: number): void {
        if (this.waveSpawnComplete || this.waveSpawnQueue.length === 0) {
            if (this.waveSpawnQueue.length === 0) this.waveSpawnComplete = true;
            return;
        }

        this.waveSpawnPulseTimer -= dt;
        if (this.waveSpawnPulseTimer > 0) return;

        const horde = this.wave === 29;
        const batch = horde
            ? (this.waveSpawnPulseIndex === 0
                ? WaveHordeSpawnFirstBatch
                : WaveHordeSpawnBatchSize)
            : (this.waveSpawnPulseIndex === 0
                ? WaveSpawnFirstBatch
                : WaveSpawnBatchSize);
        this.spawnWaveBatch(batch);
        this.waveSpawnPulseIndex++;

        if (this.waveSpawnQueue.length === 0) {
            this.waveSpawnComplete = true;
            return;
        }

        this.waveSpawnPulseTimer = horde ? WaveHordeSpawnInterval : WaveSpawnInterval;
    }

    private spawnWaveBatch(batchSize: number): void {
        let spawned = 0;
        while (spawned < batchSize && this.waveSpawnQueue.length > 0) {
            const job = this.waveSpawnQueue.shift()!;
            this.spawnEnemy(
                job.kind,
                job.indexInSquad,
                job.squadSize,
                job.approachAngle,
                job.host,
            );
            spawned++;
        }
    }

    private startWave(): void {
        // Missions no longer auto-win at wave 30 — continuous waves chain forever,
        // wait-for-next uses shop intermission forever.
        this.onBreak = false;
        this.breakVotes.clear();
        this.lastBreakVoteCode = -1;
        this.wave++;
        this.phase = "combat";
        this.phaseTimer = 0;
        this.spawnedThisWave = false;
        this.ironcladsThisWave = 0;
        this.waveSpawnQueue.length = 0;
        this.waveSpawnComplete = false;
        this.waveSpawnPulseTimer = 0;
        this.waveSpawnPulseIndex = 0;
        this.hudDirty = true;
        this.contracts.resetWave();
        this.lastContractHudCode = -1;
        this.syncContractHud();
        this.game.gas.clearSpecOpsCountdown();
        this.game.logger.info(`Spec Ops wave ${this.wave}`);
        this.buffLivingSupport();

        const humans = this.livingHumans();
        let roster = composeWave(this.wave, humans.length, this.difficulty);

        // Wave 30: the glory executioner is already on the field — bring his men,
        // don't spawn a duplicate event boss.
        const keepExecutioner = this.wave === SpecOpsFinalWave
            && this.gloryExecutioner
            && !this.gloryExecutioner.dead;
        if (keepExecutioner) {
            const eventBoss = specOpsEventBossForWave(SpecOpsFinalWave);
            if (eventBoss) {
                roster = roster.filter((kind) => kind !== eventBoss);
            }
            this.gloryWipeActive = false;
            this.gloryTrucePause = false;
            const exec = this.gloryExecutioner!;
            exec.teamId = AiTeamId;
            exec.specOpsImmunityTicker = 0;
            exec.specOpsDamageMult = math.max(exec.specOpsDamageMult, 1.2);
            const brain = this.brains.get(exec);
            if (brain) {
                brain.gloryExecutioner = false;
                brain.alerted = true;
                if (humans[0]) brain.alertTo(humans[0].pos);
            }
        } else if (this.wave !== 29) {
            this.gloryExecutioner = undefined;
            this.gloryWipeActive = false;
            this.gloryTrucePause = false;
        }

        // Split the roster evenly across living operators so a duo/squad
        // does not get one shared pile that then hunts a single player.
        const hostCount = Math.max(humans.length, 1);
        const buckets: EnemyClass[][] = [];
        for (let i = 0; i < hostCount; i++) buckets.push([]);
        for (let i = 0; i < roster.length; i++) {
            buckets[i % hostCount].push(roster[i]);
        }

        const clustered = this.humansClustered(humans, 36);
        const sharedAngle = util.random(0, Math.PI * 2);
        const gloryPacks = this.wave === 29 ? 4 : 0;

        for (let h = 0; h < hostCount; h++) {
            const host = humans[h];
            const members = buckets[h];
            if (gloryPacks > 0) {
                const packSize = Math.max(1, Math.ceil(members.length / gloryPacks));
                for (let j = 0; j < members.length; j++) {
                    const pack = Math.floor(j / packSize);
                    const packAngle = sharedAngle + pack * ((Math.PI * 2) / gloryPacks);
                    this.enqueueWaveSpawn(members[j], j % packSize, packSize, packAngle, host);
                }
                continue;
            }

            const packCount = members.length <= WavePackSize
                ? 1
                : Math.max(2, Math.ceil(members.length / WavePackSize));
            const packSize = Math.max(1, Math.ceil(members.length / packCount));
            const surround = members.length >= SurroundWaveSize || packCount >= 3;
            const hostAngle = !humans.length || clustered
                ? sharedAngle + (h * ((Math.PI * 2) / Math.max(hostCount, 1)) * 0.15)
                : util.random(0, Math.PI * 2);

            for (let j = 0; j < members.length; j++) {
                const pack = Math.min(packCount - 1, Math.floor(j / packSize));
                const packAngle = surround
                    ? hostAngle + pack * ((Math.PI * 2) / packCount)
                    : hostAngle + pack * 0.85;
                this.enqueueWaveSpawn(members[j], j % packSize, packSize, packAngle, host);
            }
        }
        this.spawnedThisWave = true;
        this.waveSpawned = roster.length + (keepExecutioner ? 1 : 0);
        this.tickWaveSpawns(999);
        this.huntClock = 0;
        this.gloryHelpersThisWave = 0;
        this.gloryHelperTicker = this.wave >= SpecOpsHelperStartWave
            ? SpecOpsHelperInterval
            : 0;
        this.resetPushPressure();
    }

    /**
     * Mid wave-29: the wave-30 event boss arrives and culls the glory horde.
     * Weak units never target him — they keep charging the operators until he
     * finishes them. Operators are under truce with the boss until wave 30.
     */
    private tickGloryHorde(): void {
        if (this.wave !== 29 || !this.spawnedThisWave) return;
        if (this.gloryExecutioner && !this.gloryExecutioner.dead) return;

        const weakLeft = this.livingWeakEnemies().length;
        const shouldArrive = this.combatElapsed >= GloryWipeDelay
            || weakLeft <= Math.ceil(this.waveSpawned * 0.5)
            || weakLeft <= 0;
        if (!shouldArrive) return;
        this.spawnGloryExecutioner();
    }

    private tickGloryHelpers(dt: number): void {
        if (this.wave < SpecOpsHelperStartWave || !this.spawnedThisWave) return;
        if (this.gloryHelpersThisWave >= SpecOpsHelpersPerWave) return;
        this.gloryHelperTicker += dt;
        if (this.gloryHelperTicker < SpecOpsHelperInterval) return;
        this.gloryHelperTicker = 0;
        this.spawnGloryHelperGroup();
    }

    private spawnGloryHelperGroup(): Player[] {
        const remaining = SpecOpsHelpersPerWave - this.gloryHelpersThisWave;
        const count = Math.min(SpecOpsHelperGroupSize, remaining);
        if (count <= 0) return [];
        const humans = this.livingHumans();
        if (!humans.length) return [];
        const spawned: Player[] = [];
        for (let i = 0; i < count; i++) {
            const owner = humans[i % humans.length];
            const kind = GloryHelperKinds[(this.gloryHelpersThisWave + i) % GloryHelperKinds.length];
            const helper = this.spawnGloryHelper(owner, kind);
            if (helper) spawned.push(helper);
        }
        return spawned;
    }

    private spawnGloryHelper(owner: Player, kind: EnemyClass): Player | undefined {
        const template = Loadouts[kind];
        const pos = this.pickSpawnNear(owner.pos, 8, 16);
        const ally = this.game.playerBarn.addTestPlayer({
            pos,
            name: template.name,
            specOpsAi: true,
        });
        this.bindToOwner(ally, owner, "ally");
        this.equipAi(ally, template, "ally", kind);
        ally.health = specOpsEnemyHealth(1, kind, this.difficulty);
        const brain = new AiBrain(ally, template, 1, "ally", -1, kind);
        brain.gloryHelper = true;
        this.brains.set(ally, brain);
        this.gloryHelpersThisWave++;
        return ally;
    }

    private spawnGloryExecutioner(): void {
        if (this.gloryExecutioner && !this.gloryExecutioner.dead) return;
        const bossKind = specOpsEventBossForWave(30);
        if (!bossKind) return;
        const humans = this.livingHumans();
        const weak = this.livingWeakEnemies();
        const host = humans[0];
        // Step in from behind a pack so he cuts through them toward the operators.
        let angle = util.random(0, Math.PI * 2);
        if (host && weak.length) {
            const pack = weak[Math.floor(weak.length / 2)];
            const toOp = v2.sub(host.pos, pack.pos);
            angle = Math.atan2(toOp.y, toOp.x) + Math.PI;
        }
        const exec = this.spawnEnemy(bossKind, 0, 1, angle, host);
        if (!exec) return;
        const brain = this.brains.get(exec);
        if (!brain) return;

        brain.gloryExecutioner = true;
        brain.alerted = true;
        brain.acquireTicker = 0;
        this.gloryExecutioner = exec;
        this.gloryWipeActive = true;
        this.gloryTrucePause = false;
        // Off the AI team so bullets actually drop the horde (same-team is immune).
        exec.teamId = GloryExecutionerTeamId;
        exec.specOpsImmunityTicker = 60;
        exec.specOpsDamageMult = math.max(exec.specOpsDamageMult, 2.8);
        this.waveSpawned += 1;
        this.hudDirty = true;
        this.game.playerBarn.killLeaderDirty = true;
        this.game.playerBarn.addMapPing("ping_airstrike", exec.pos);
        this.game.logger.info("Spec Ops glory executioner arrives");
    }

    private beginGloryTrucePause(): void {
        if (this.gloryTrucePause) return;
        this.gloryWipeActive = false;
        this.gloryTrucePause = true;
        this.phase = "intermission";
        this.resetPushPressure();
        this.phaseDuration = GloryTruceDuration;
        this.phaseTimer = GloryTruceDuration;
        // Lock skip so the cinematic truce plays out.
        this.shopSkipLock = GloryTruceDuration;
        this.lastHudSecond = -1;
        this.hudDirty = true;
        this.game.gas.setSpecOpsCountdown(this.phaseTimer, this.phaseDuration);

        if (this.gloryExecutioner && !this.gloryExecutioner.dead) {
            this.gloryExecutioner.specOpsImmunityTicker = GloryTruceDuration + 2;
            const brain = this.brains.get(this.gloryExecutioner);
            if (brain) {
                brain.target = undefined;
                brain.alerted = false;
            }
            this.game.playerBarn.addMapPing("ping_unlock", this.gloryExecutioner.pos);
        }

        // Guarantee no stragglers ruin the beat.
        const leftovers = this.livingWeakEnemies();
        for (let i = 0; i < leftovers.length; i++) {
            leftovers[i].damage({
                amount: 9999,
                damageType: GameConfig.DamageType.Airstrike,
                dir: v2.create(1, 0),
            });
        }

        const bonus = specOpsWaveBonus(this.wave, this.difficulty);
        const humans = this.livingHumans();
        for (let i = 0; i < humans.length; i++) {
            this.grantCash(humans[i], bonus);
        }
    }

    private beginIntermission(): void {
        // No wave-30 victory — either chain immediately (continuous) or open shop.
        // Contracts persist across shop into later waves (duration / cooldown).
        this.lastContractHudCode = -1;
        this.syncContractHud();
        this.resetPushPressure();
        if (this.wave > 0 && this.wave % TreeRegrowEveryWaves === 0) {
            this.regrowDestroyedTrees();
        }
        const bonus = specOpsWaveBonus(this.wave, this.difficulty);
        const humans = this.livingHumans();
        for (let i = 0; i < humans.length; i++) {
            this.grantCash(humans[i], bonus);
        }

        // Continuous waves: chain the next wave immediately (no shop countdown).
        // Opening prep and the wave-29 glory truce still use their timers.
        if (this.endless) {
            this.startWave();
            return;
        }

        this.phase = "intermission";
        const shopScale = specOpsDifficultyMods(this.difficulty).intermission;

        const shopTime = math.min(
            IntermissionCap,
            (IntermissionTime + Math.floor(this.wave / 5)) * shopScale,
        );

        // Every 5th wave: a long break (2:00 on Regular). Early-start cash is
        // capped at a normal shop's worth so skipping the break isn't a payday.
        this.onBreak = specOpsIsBreakWave(this.wave);
        this.breakVotes.clear();
        this.lastBreakVoteCode = -1;
        this.breakBonusSeconds = shopTime;
        this.phaseDuration = this.onBreak ? SpecOpsBreakTime * shopScale : shopTime;
        this.phaseTimer = this.phaseDuration;

        this.shopSkipLock = ShopSkipLockTime;
        this.lastHudSecond = -1;
        this.hudDirty = true;
        this.game.gas.setSpecOpsCountdown(this.phaseTimer, this.phaseDuration);
    }

    private regrowDestroyedTrees(): void {
        const obstacles = this.game.map.obstacles;
        for (let i = 0; i < obstacles.length; i++) {
            const o = obstacles[i];
            if (!o.isTree || !o.dead || !o.active) continue;
            o.regrow();
        }
    }

    private centroid(players: Player[]): Vec2 {
        const pos = v2.create(0, 0);
        for (let i = 0; i < players.length; i++) {
            pos.x += players[i].pos.x;
            pos.y += players[i].pos.y;
        }
        pos.x /= players.length;
        pos.y /= players.length;
        return pos;
    }

    private humansClustered(humans: Player[], radius: number): boolean {
        if (humans.length <= 1) return true;
        const center = this.centroid(humans);
        for (let i = 0; i < humans.length; i++) {
            if (v2.distance(humans[i].pos, center) > radius) return false;
        }
        return true;
    }

    private spawnTooClose(pos: Vec2, _host: Player | undefined, humans: Player[], minDist = MinSpawnDist): boolean {
        for (let i = 0; i < humans.length; i++) {
            if (v2.distance(humans[i].pos, pos) < minDist) return true;
        }
        return false;
    }

    private inwardAngle(origin: Vec2): number {
        const toCenter = v2.sub(this.game.map.center, origin);
        if (v2.lengthSqr(toCenter) < 1) return util.random(0, Math.PI * 2);
        return Math.atan2(toCenter.y, toCenter.x);
    }

    private enemySpawnOk(
        pos: Vec2,
        origin: Vec2,
        minRad: number,
        host: Player | undefined,
        humans: Player[],
    ): boolean {
        this.game.map.clampToMapBounds(pos, 10);
        if (!this.game.map.canPlayerSpawn(pos)) return false;
        if (v2.distance(pos, origin) < minRad) return false;
        if (this.spawnTooClose(pos, host, humans, minRad)) return false;
        for (const brain of this.brains.values()) {
            if (brain.kind !== "enemy" || brain.player.dead) continue;
            if (v2.distance(pos, brain.player.pos) < 4) return false;
        }
        return true;
    }

    private pickSpawnNear(origin: Vec2, minRad: number, maxRad: number): Vec2 {
        const map = this.game.map;
        for (let i = 0; i < 24; i++) {
            const pos = v2.add(origin, util.randomPointInCircle(maxRad));
            const dist = v2.distance(pos, origin);
            map.clampToMapBounds(pos, 8);
            if (dist >= minRad && map.canPlayerSpawn(pos)) {
                return pos;
            }
        }
        return map.getRandomSpawnPos(() => {
            return v2.add(origin, util.randomPointInCircle(maxRad));
        });
    }

    /**
     * Resolve an outdoor strike / airdrop point. Rejects building interiors.
     * Falls back near the buyer if no target was provided.
     */
    private resolveOutdoorSupportPos(targetPos: Vec2 | undefined, buyer: Player): Vec2 | undefined {
        const map = this.game.map;
        const tryPos = (raw: Vec2): Vec2 | undefined => {
            const pos = v2.copy(raw);
            map.clampToMapBounds(pos, 8);
            if (map.isOnWater(pos, 0)) return undefined;
            if (buildingContaining(this.game, pos, 0)) return undefined;
            // Prefer spawn-legal ground for care packages; airstrikes just need open air.
            return pos;
        };

        if (targetPos) {
            const hit = tryPos(targetPos);
            if (hit) return hit;
            // Nudge around the click if the exact point is inside a building/water.
            for (let i = 0; i < 12; i++) {
                const nudged = tryPos(v2.add(targetPos, util.randomPointInCircle(8)));
                if (nudged) return nudged;
            }
            return undefined;
        }

        const dir = v2.normalizeSafe(buyer.dir, v2.create(1, 0));
        const ahead = tryPos(v2.add(buyer.pos, v2.mul(dir, 18)));
        if (ahead) return ahead;
        return tryPos(this.pickSpawnNear(buyer.pos, 6, 14));
    }

    /** Scale living hired units each wave so they keep pace with hostiles. */
    private buffLivingSupport(): void {
        const wave = this.wave || 1;
        const dmg = specOpsAllyDamageMult(wave);
        for (const ally of this.livingHiredAllies()) {
            ally.specOpsDamageMult = Math.max(ally.specOpsDamageMult, dmg);
            const targetHp = specOpsAllyHealth(wave, "ally");
            if (ally.health < targetHp) {
                ally.health = Math.min(
                    ally.maxHealth,
                    Math.max(ally.health, Math.round(ally.health + (targetHp - ally.health) * 0.55)),
                );
            }
            // Top up toward the new wave HP floor so battered drones recover.
            const floor = Math.round(targetHp * 0.7);
            if (ally.health < floor) ally.health = Math.min(ally.maxHealth, floor);
        }
        for (const sentry of this.livingAllies("sentry")) {
            sentry.specOpsDamageMult = Math.max(sentry.specOpsDamageMult, dmg * 0.9);
            const targetHp = specOpsAllyHealth(wave, "sentry");
            const floor = Math.round(targetHp * 0.7);
            if (sentry.health < floor) sentry.health = Math.min(sentry.maxHealth, floor);
            else if (sentry.health < targetHp) {
                sentry.health = Math.min(
                    sentry.maxHealth,
                    Math.max(
                        sentry.health,
                        Math.round(sentry.health + (targetHp - sentry.health) * 0.45),
                    ),
                );
            }
        }
    }

    private pickEnemySpawn(
        origin: Vec2,
        approachAngle: number,
        minRad: number,
        maxRad: number,
        host: Player | undefined,
        humans: Player[],
        indexInSquad = 0,
        squadSize = 1,
    ): Vec2 {
        const map = this.game.map;
        const tryPos = (angle: number, radius: number): Vec2 | undefined => {
            const pos = v2.add(
                origin,
                v2.create(Math.cos(angle) * radius, Math.sin(angle) * radius),
            );
            if (this.enemySpawnOk(pos, origin, minRad, host, humans)) return pos;
            return undefined;
        };

        const t = squadSize <= 1 ? 0.5 : indexInSquad / (squadSize - 1);
        const fan = squadSize <= 1 ? 0 : (t - 0.5) * 0.9;
        const stagger = minRad + t * (maxRad - minRad);

        for (let i = 0; i < 10; i++) {
            const angle = approachAngle + fan + util.random(-0.12, 0.12);
            const radius = util.random(stagger * 0.85, Math.min(maxRad, stagger * 1.2));
            const hit = tryPos(angle, radius);
            if (hit) return hit;
        }

        for (let i = 0; i < 28; i++) {
            const angle = approachAngle + util.random(-1.1, 1.1);
            const radius = util.random(minRad, maxRad);
            const hit = tryPos(angle, radius);
            if (hit) return hit;
        }

        const inward = this.inwardAngle(origin);
        for (let i = 0; i < 16; i++) {
            const angle = inward + util.random(-0.7, 0.7);
            const radius = util.random(minRad, maxRad);
            const hit = tryPos(angle, radius);
            if (hit) return hit;
        }

        for (let i = 0; i < 24; i++) {
            const angle = (i / 24) * Math.PI * 2;
            const hit = tryPos(angle, minRad + 4);
            if (hit) return hit;
        }

        const fallback = v2.add(
            origin,
            v2.create(Math.cos(inward) * minRad, Math.sin(inward) * minRad),
        );
        map.clampToMapBounds(fallback, 10);
        if (this.enemySpawnOk(fallback, origin, minRad, host, humans)) {
            return fallback;
        }
        // Last resort: walk toward the map center until we are clear of operators.
        const dir = v2.normalizeSafe(v2.sub(map.center, origin), v2.create(1, 0));
        for (let step = minRad; step < Math.max(map.width, map.height); step += 6) {
            const pos = v2.add(origin, v2.mul(dir, step));
            map.clampToMapBounds(pos, 10);
            if (map.canPlayerSpawn(pos) && !this.spawnTooClose(pos, host, humans, minRad)) {
                return pos;
            }
        }
        return fallback;
    }

    private spawnEnemy(
        kind: EnemyClass,
        indexInSquad: number,
        squadSize: number,
        approachAngle: number,
        host?: Player,
    ): Player | undefined {
        const humans = this.livingHumans();
        const origin = host?.pos
            ?? (humans.length
                ? this.centroid(humans)
                : (this.operatorSpawn ?? this.game.map.center));

        const farSniper = kind === "sniper";
        let minRad = farSniper ? 48 : MinSpawnDist;
        let maxRad = farSniper ? 80 : MaxSpawnDist;

        // When operators split up, keep this fireteam on the host's side of the
        // fight — never by shrinking below MinSpawnDist.
        if (host && humans.length > 1) {
            let nearestOther = Infinity;
            for (let i = 0; i < humans.length; i++) {
                if (humans[i] === host) continue;
                nearestOther = Math.min(nearestOther, v2.distance(humans[i].pos, host.pos));
            }
            if (Number.isFinite(nearestOther) && nearestOther > minRad + 8) {
                maxRad = Math.min(maxRad, Math.max(minRad + 8, nearestOther * 0.45));
            }
        }
        if (maxRad < minRad + 6) maxRad = minRad + 6;

        const pos = this.pickEnemySpawn(
            origin,
            approachAngle,
            minRad,
            maxRad,
            host,
            humans,
            indexInSquad,
            squadSize,
        );

        const template = Loadouts[kind];
        const gun = pickGun(kind, this.wave);
        let player: Player;
        try {
            player = this.game.playerBarn.addTestPlayer({
                pos,
                name: template.name,
                team: this.aiTeam,
                specOpsAi: true,
            });
        } catch (err) {
            this.game.logger.error(`Spec Ops failed to spawn ${kind}`, err);
            return undefined;
        }

        this.equipAi(player, { ...template, gun }, "enemy", kind);
        const brain = new AiBrain(player, { ...template, gun }, this.wave, "enemy", -1, kind);
        brain.anchor = host;
        this.brains.set(player, brain);
        return player;
    }

    grantCash(player: Player, amount: number, dirty = true, earned = true): void {
        if (amount === 0 || player.specOpsAi) return;
        // Lifetime "cash earned" for the hold-Tab scoreboard (refunds/starting cash opt out).
        if (earned && amount > 0) player.specOpsCashEarned += amount;
        const next = math.clamp(player.specOpsCash + amount, 0, SpecOpsCashCap);
        if (next === player.specOpsCash) return;
        player.specOpsCash = next;
        if (dirty) player.specOpsCashDirty = true;
    }

    /** Apply weapon-cash contract multiplier to kill bounties. */
    modifyKillBounty(killer: Player, bounty: number): number {
        return this.contracts.modifyKillBounty(killer, bounty);
    }

    getBrainPublic(player: Player): AiBrain | undefined {
        return this.brains.get(player);
    }

    pickSpawnNearPublic(origin: Vec2, minRad: number, maxRad: number): Vec2 {
        return this.pickSpawnNear(origin, minRad, maxRad);
    }

    resolveOutdoorSupportPosPublic(origin: Vec2): Vec2 | undefined {
        const humans = this.livingHumans();
        const buyer = humans[0];
        if (!buyer) return this.pickSpawnNear(origin, 8, 24);
        return this.resolveOutdoorSupportPos(origin, buyer)
            ?? this.pickSpawnNear(origin, 8, 24);
    }

    private syncContractHud(): void {
        const code = this.phase === "combat" ? this.contracts.hudCode : 0;
        if (code === this.lastContractHudCode) return;
        this.lastContractHudCode = code;
        const humans = this.livingHumans();
        for (let i = 0; i < humans.length; i++) {
            humans[i].specOpsContractHud = code;
            humans[i].specOpsContractDirty = true;
        }
    }

    /**
     * Late-wave counter to IR strobe spam: summon slow Ironclads that tank bombs.
     * Cap is SpecOpsIroncladPerPlayer × living operators for the current wave.
     */
    onHumanStrobeThrown(player: Player, at: Vec2): void {
        if (player.specOpsAi) return;
        if (this.wave < SpecOpsIroncladWave) return;
        const humans = Math.max(1, this.livingHumans().length);
        const cap = SpecOpsIroncladPerPlayer * humans;
        if (this.ironcladsThisWave >= cap) return;
        this.ironcladsThisWave++;
        try {
            const spawnAt = this.pickSpawnNear(at, 10, 22);
            const host = this.livingHumans()[0] ?? player;
            const template = Loadouts.ironclad;
            const unit = this.game.playerBarn.addTestPlayer({
                pos: spawnAt,
                name: template.name,
                team: this.aiTeam,
                specOpsAi: true,
            });
            this.equipAi(unit, template, "enemy", "ironclad");
            const brain = new AiBrain(unit, template, this.wave, "enemy", -1, "ironclad");
            brain.anchor = host;
            brain.alerted = true;
            brain.investigatePos = v2.copy(at);
            this.brains.set(unit, brain);
        } catch (err) {
            this.ironcladsThisWave = math.max(this.ironcladsThisWave - 1, 0);
            this.game.logger.error("Spec Ops failed to spawn Ironclad", err);
        }
    }

    scheduleMirvBurst(pos: Vec2, layer: number): void {
        this.pendingMirvBursts.push({
            pos: v2.copy(pos),
            layer,
            timer: 0.15,
            remaining: SpecOpsIroncladMirvCount,
        });
    }

    tryBuy(player: Player, sku: string, targetPos?: Vec2): boolean {
        if (player.specOpsAi || player.dead || player.downed) return false;
        if ((this.buyCooldown.get(player.__id) ?? 0) > 0) return false;

        const unequipPerk = specOpsUnequipPerk(sku);
        if (unequipPerk) {
            return this.tryUnequipPerk(player, unequipPerk);
        }

        const buybackSlot = specOpsBuybackSlot(sku);
        if (buybackSlot !== undefined) {
            return this.tryBuyback(player, buybackSlot);
        }

        if (sku === SpecOpsSelfReviveSku) {
            return this.tryBuySelfRevive(player);
        }

        const item = SpecOpsShopBySku[sku];
        const satchelCost = isSpecOpsArmorSatchel(sku)
            ? specOpsScalePrice(SpecOpsArmorSatchelCosts[sku], this.difficulty)
            : undefined;
        if (!item && satchelCost === undefined) return false;
        // Flare guns are find-only — not sold, and ammo resupply never tops them up.
        if (sku === "flare_gun" || sku === "flare_gun_dual" || sku === "flare") return false;

        const station = this.stationNear(player);
        if (!station) return false;
        // Ammo refill and armor satchels are available at every unlocked station.
        if (sku === "specops_ammo" || isSpecOpsArmorSatchel(sku)) {
            if (!specOpsStationUnlocked(station, this.wave)) return false;
        } else {
            if (!item || station !== item.station) return false;
            if (!specOpsStationUnlocked(station, this.wave)) return false;
            if (!specOpsShopItemAvailable(sku, this.game.config.mapName)) return false;
        }
        const cost = satchelCost ?? specOpsShopItemCost(
            item!,
            this.game.teamMode,
            player.perks.length,
            this.difficulty,
        );
        if (player.specOpsCash < cost) return false;

        let buyAmount = item?.amount ?? 1;
        if (item?.fillToMax && player.invManager.isValid(sku)) {
            const invSku = sku as InventoryItem;
            const space = player.invManager.getMaxCapacity(invSku)
                - player.invManager.get(invSku);
            if (space <= 0) return false;
            buyAmount = space;
        }

        if (!this.fulfillPurchase(player, sku, buyAmount, targetPos)) return false;

        this.grantCash(player, -cost);
        this.buyCooldown.set(player.__id, 0.45);
        this.game.playerBarn.addEmote("emote_loot", player.__id, sku);
        return true;
    }

    tryUnequipPerk(player: Player, perk: string): boolean {
        if (player.specOpsAi || player.dead || player.downed) return false;
        if (!player.hasPerk(perk)) return false;
        const station = this.stationNear(player);
        if (station !== "perk") return false;
        if (!specOpsStationUnlocked(station, this.wave)) return false;
        const item = SpecOpsShopBySku[perk];
        if (!item || item.station !== "perk") return false;

        const refund = specOpsShopItemCost(
            item,
            this.game.teamMode,
            Math.max(0, player.perks.length - 1),
            this.difficulty,
        );
        player.removePerk(perk);
        player.setDirty();
        this.grantCash(player, refund, true, false);
        this.buyCooldown.set(player.__id, 0.45);
        this.game.playerBarn.addEmote("emote_loot", player.__id, perk);
        return true;
    }

    /** Dead operators, or downed operators who disconnected mid-fight. */
    private isBuybackTarget(target: Player): boolean {
        if (target.specOpsAi) return false;
        if (target.dead) return true;
        return target.downed && target.disconnected;
    }

    tryBuyback(buyer: Player, slot: number): boolean {
        if (buyer.specOpsAi || buyer.dead || buyer.downed) return false;
        const group = buyer.group;
        if (!group) return false;
        const target = group.players[slot];
        if (!target || target === buyer || !this.isBuybackTarget(target)) {
            return false;
        }
        const cost = specOpsBuybackCost(this.wave, this.difficulty);
        if (buyer.specOpsCash < cost) return false;
        if (!this.buybackOperator(buyer, target)) return false;
        this.grantCash(buyer, -cost);
        this.buyCooldown.set(buyer.__id, 0.45);
        this.game.playerBarn.addEmote("emote_loot", buyer.__id, "healthkit");
        return true;
    }

    /** Keep the first SpecOpsMaxPerks perks; extras from this life are lost. */
    private prunePerksAfterBuyback(player: Player): void {
        while (player.perks.length > SpecOpsMaxPerks) {
            player.removePerk(player.perks[player.perks.length - 1].type);
        }
        player.setDirty();
    }

    tryBuySelfRevive(player: Player): boolean {
        if (player.specOpsAi || player.dead || player.downed) return false;
        if (!specOpsSelfReviveAllowed(this.difficulty)) return false;
        if (!specOpsCanBuySelfRevive(player)) return false;

        const station = this.stationNear(player);
        if (!station || !specOpsStationUnlocked(station, this.wave)) return false;

        const cost = specOpsSelfReviveCost(this.wave, this.difficulty);
        if (player.specOpsCash < cost) return false;
        if (!this.fulfillPurchase(player, SpecOpsSelfReviveSku, 1)) return false;

        this.grantCash(player, -cost);
        this.buyCooldown.set(player.__id, 0.45);
        this.game.playerBarn.addEmote("emote_loot", player.__id, SpecOpsSelfReviveSku);
        return true;
    }

    buybackOperator(buyer: Player, target: Player): boolean {
        if (!this.isBuybackTarget(target)) return false;

        target.dead = false;
        target.downed = false;
        target.downedBy = undefined;
        target.killedBy = undefined;
        target.health = SpecOpsReviveHealth;
        target.specOpsArmor = SpecOpsBuybackArmor;
        target.boost = 0;
        target.cancelAction();
        this.prunePerksAfterBuyback(target);
        target.grantSpecOpsReviveImmunity();

        const spawn = this.pickSpawnNear(buyer.pos, 2, 6);
        v2.set(target.pos, spawn);
        target.layer = buyer.layer;
        this.game.grid.updateObject(target);

        if (!this.game.playerBarn.livingPlayers.includes(target)) {
            this.game.playerBarn.livingPlayers.push(target);
        }
        util.removeFrom(this.game.playerBarn.killedPlayers, target);
        if (target.team && !target.team.livingPlayers.includes(target)) {
            target.team.livingPlayers.push(target);
        }
        target.group?.checkPlayers();

        // Disconnected operators have no live socket; reconnect picks them up alive.
        if (!target.disconnected) {
            target.client.spectating = undefined;
            target.client.startedSpectating = true;
        }
        this.game.playerBarn.aliveCountDirty = true;
        target.setDirty();
        target.setGroupStatuses();
        this.hudDirty = true;
        return true;
    }

    private stationNear(player: Player): SpecOpsStation | undefined {
        const objs = this.game.grid.intersectCollider(
            collider.createCircle(player.pos, SpecOpsShopRange),
        );
        let best: SpecOpsStation | undefined;
        let bestDist = SpecOpsShopRange * SpecOpsShopRange;
        for (let i = 0; i < objs.length; i++) {
            const obj = objs[i];
            if (obj.__type !== ObjectType.Obstacle) continue;
            if (!util.sameLayer(obj.layer, player.layer)) continue;
            const station = specOpsStationFromType(obj.type);
            if (!station) continue;
            const dist = v2.lengthSqr(v2.sub(obj.pos, player.pos));
            if (dist > bestDist) continue;
            const blockers = this.game.grid.intersectLineSegment(player.pos, obj.pos);
            const blocked = shopApproachBlocked(
                player.pos,
                obj.pos,
                obj.__id,
                blockers.filter(
                    (o) =>
                        o.__type === ObjectType.Obstacle
                        && util.sameLayer(o.layer, player.layer),
                ) as Obstacle[],
            );
            if (blocked) continue;
            bestDist = dist;
            best = station;
        }
        return best;
    }

    private placeStations(): void {
        if (this.practice) return;
        if (this.stationsPlaced || !this.operatorSpawn) return;
        this.stationsPlaced = true;

        const origin = this.operatorSpawn;
        const slots = this.collectBuildingStationSlots(origin);
        this.assignStationTargets(slots);
        const maxPerk = this.maxPerkStations();

        // One of each type first, then fill remaining building targets.
        const required = [
            SpecOpsStationTypes.weapon,
            SpecOpsStationTypes.gear,
            SpecOpsStationTypes.armor,
            SpecOpsStationTypes.support,
            SpecOpsStationTypes.perk,
        ];
        const extras = [
            SpecOpsStationTypes.weapon,
            SpecOpsStationTypes.gear,
            SpecOpsStationTypes.armor,
            SpecOpsStationTypes.support,
            SpecOpsStationTypes.perk,
            SpecOpsStationTypes.weapon,
            SpecOpsStationTypes.perk,
            SpecOpsStationTypes.gear,
            SpecOpsStationTypes.armor,
            SpecOpsStationTypes.support,
            SpecOpsStationTypes.perk,
            SpecOpsStationTypes.weapon,
        ];
        const targetTotal = slots.reduce((n, s) => n + s.target, 0);
        const queue = [...required];
        for (let i = 0; i < extras.length && queue.length < Math.max(targetTotal, required.length + 4); i++) {
            queue.push(extras[i]);
        }

        for (let i = 0; i < queue.length; i++) {
            const type = queue[i];
            if (
                type === SpecOpsStationTypes.perk
                && this.countStationsOfType(SpecOpsStationTypes.perk) >= maxPerk
            ) {
                continue;
            }
            const placed = this.tryPlaceStationAtBuilding(slots, type, true)
                || this.tryPlaceStationAtBuilding(slots, type, false);
            if (!placed && required.includes(type)) {
                // Required types must exist — last resort beside a large/medium building.
                this.forcePlaceStationNearEligible(slots, type, origin);
            }
        }

        this.placeCellarStations(slots);

        this.game.map.serializeMapMsg();
    }

    /** Solo/duo: 2 perk shops. Squad: 3. */
    private maxPerkStations(): number {
        return this.game.teamMode === TeamMode.Squad ? 3 : 2;
    }

    private countStationsOfType(type: string): number {
        let n = 0;
        const obstacles = this.game.map.obstacles;
        for (let i = 0; i < obstacles.length; i++) {
            if (obstacles[i].type === type) n++;
        }
        return n;
    }

    /** Place at most one extra station in each cellar tied to a building that already has shops. */
    private placeCellarStations(slots: BuildingStationSlot[]): void {
        const maxPerk = this.maxPerkStations();
        const fillerTypes = [
            SpecOpsStationTypes.perk,
            SpecOpsStationTypes.gear,
            SpecOpsStationTypes.support,
            SpecOpsStationTypes.armor,
            SpecOpsStationTypes.weapon,
            SpecOpsStationTypes.perk,
        ];
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (slot.placedIndoor + slot.placedOutdoor === 0) continue;
            const cellars = this.cellarBuildingsFor(slot.building);
            for (let c = 0; c < cellars.length; c++) {
                const cellar = cellars[c];
                // Prefer a missing type, but allow a second perk if under the map cap.
                let placed = false;
                for (let t = 0; t < fillerTypes.length; t++) {
                    const type = fillerTypes[t];
                    if (type !== SpecOpsStationTypes.perk && slot.types.has(type)) continue;
                    if (
                        type === SpecOpsStationTypes.perk
                        && this.countStationsOfType(SpecOpsStationTypes.perk) >= maxPerk
                    ) {
                        continue;
                    }
                    const picked = this.pickPosInBuilding(cellar, type);
                    if (!picked) continue;
                    this.spawnStation(type, picked.pos, picked.facing, cellar.layer);
                    slot.types.add(type);
                    placed = true;
                    break;
                }
                if (!placed) {
                    for (let t = 0; t < fillerTypes.length; t++) {
                        const type = fillerTypes[t];
                        if (
                            type === SpecOpsStationTypes.perk
                            && this.countStationsOfType(SpecOpsStationTypes.perk) >= maxPerk
                        ) {
                            continue;
                        }
                        const picked = this.pickPosInBuilding(cellar, type);
                        if (!picked) continue;
                        this.spawnStation(type, picked.pos, picked.facing, cellar.layer);
                        slot.types.add(type);
                        break;
                    }
                }
            }
        }
    }

    private assignStationTargets(slots: BuildingStationSlot[]): void {
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const near = i < 6; // nearest buildings get shops first
            if (slot.size === "small") {
                // 0–1 indoors only; nearest shacks/huts more likely to get one.
                slot.target = near ? 1 : (Math.random() < 0.35 ? 1 : 0);
            } else if (slot.size === "medium") {
                // 1–3 total.
                slot.target = near ? 3 : 2;
            } else {
                // Large: 3–4 total.
                slot.target = near ? 4 : 3;
            }
            slot.target = math.clamp(slot.target, 0, slot.maxTotal);
        }
    }

    /**
     * Place a station on an eligible building.
     * preferIndoor: try rooms first; otherwise allow outdoor seats on medium/large.
     */
    private tryPlaceStationAtBuilding(
        slots: BuildingStationSlot[],
        type: string,
        preferIndoor: boolean,
    ): boolean {
        const candidates = slots
            .filter((s) => {
                if (s.placedIndoor + s.placedOutdoor >= s.target) return false;
                if (s.types.has(type)) return false;
                if (preferIndoor) return s.placedIndoor < s.maxIndoor;
                return s.placedOutdoor < s.maxOutdoor
                    && s.placedIndoor + s.placedOutdoor < s.maxTotal;
            })
            .sort((a, b) => {
                // Fill nearer emptier buildings first.
                const aLeft = a.target - (a.placedIndoor + a.placedOutdoor);
                const bLeft = b.target - (b.placedIndoor + b.placedOutdoor);
                if (bLeft !== aLeft) return bLeft - aLeft;
                return a.distSqr - b.distSqr;
            });

        for (let i = 0; i < candidates.length; i++) {
            const slot = candidates[i];
            if (preferIndoor) {
                const picked = this.pickIndoorStationSpot(slot, type);
                if (!picked) continue;
                this.spawnStation(type, picked.pos, picked.facing, picked.layer);
                slot.placedIndoor += 1;
                slot.types.add(type);
                return true;
            }

            const outdoor = this.pickOutdoorSeatForBuilding(slot.building, type);
            if (!outdoor) continue;
            this.spawnStation(type, outdoor.pos, outdoor.facing);
            slot.placedOutdoor += 1;
            slot.types.add(type);
            return true;
        }
        return false;
    }

    private forcePlaceStationNearEligible(
        slots: BuildingStationSlot[],
        type: string,
        origin: Vec2,
    ): void {
        if (
            type === SpecOpsStationTypes.perk
            && this.countStationsOfType(SpecOpsStationTypes.perk) >= this.maxPerkStations()
        ) {
            return;
        }
        // Prefer medium/large that still have outdoor room, then any clear outdoor patch.
        const eligible = slots
            .filter((s) => s.size !== "small" && s.placedOutdoor < s.maxOutdoor)
            .sort((a, b) => a.distSqr - b.distSqr);

        for (let i = 0; i < eligible.length; i++) {
            const slot = eligible[i];
            if (slot.types.has(type)) continue;
            const outdoor = this.pickOutdoorSeatForBuilding(slot.building, type);
            if (!outdoor) continue;
            this.spawnStation(type, outdoor.pos, outdoor.facing);
            slot.placedOutdoor += 1;
            slot.types.add(type);
            return;
        }

        // Absolute fallback: open ground near operators (not stuck to a shack).
        const offset = v2.create(
            util.random(-30, 30),
            util.random(-30, 30),
        );
        const pos = v2.add(origin, offset);
        this.game.map.clampToMapBounds(pos, 10);
        if (this.isStationSpotClear(pos, undefined, type) && this.game.map.canPlayerSpawn(pos)) {
            this.spawnStation(
                type,
                pos,
                v2.normalizeSafe(v2.sub(origin, pos), v2.create(1, 0)),
            );
        }
    }

    private spawnStation(type: string, pos: Vec2, facing?: Vec2, layer = 0): void {
        const ori = facing ? this.facingToOri(facing) : 0;
        this.game.map.genObstacle(type, pos, layer, ori, 1);
        const station = specOpsStationFromType(type);
        const markerType = station
            ? SpecOpsStationMarkerTypes[station]
            : "specops_station_marker";
        const marker = this.game.mapIndicatorBarn.allocIndicator(markerType, true);
        marker?.updatePosition(pos);
        this.game.playerBarn.addMapPing("ping_coming", pos);
    }

    private collectBuildingStationSlots(origin: Vec2): BuildingStationSlot[] {
        const slots: BuildingStationSlot[] = [];
        const buildings = this.game.map.buildings;
        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            if (building.layer !== 0 || building.parentBuilding) continue;
            if (!building.zoomRegions.some((r) => r.zoomIn)) continue;

            const plan = stationPlanForBuilding(building.type);
            if (!plan) continue;

            slots.push({
                building,
                ...plan,
                target: 0,
                placedIndoor: 0,
                placedOutdoor: 0,
                types: new Set(),
                distSqr: v2.lengthSqr(v2.sub(building.pos, origin)),
            });
        }
        slots.sort((a, b) => a.distSqr - b.distSqr);
        return slots;
    }

    private facingToOri(facing: Vec2): number {
        // Lockers / fridges / crates face along local +Y into the room.
        const ang = Math.atan2(facing.y, facing.x) - Math.PI * 0.5;
        return ((Math.round(ang / (Math.PI * 0.5)) % 4) + 4) % 4;
    }

    private regionContains(region: { min: Vec2; max: Vec2 }, pos: Vec2, inset: number): boolean {
        return pos.x >= region.min.x + inset
            && pos.x <= region.max.x - inset
            && pos.y >= region.min.y + inset
            && pos.y <= region.max.y - inset;
    }

    /** Layer-1 cellar/basement floors tied to a ground-floor building. */
    private cellarBuildingsFor(ground: Building): Building[] {
        const cellars: Building[] = [];
        const seen = new Set<number>();

        const collect = (structure: Structure) => {
            const buildings = this.game.map.buildings;
            for (let i = 0; i < buildings.length; i++) {
                const floor = buildings[i];
                if (floor.parentStructure !== structure || floor.layer !== 1) continue;
                if (!floor.zoomRegions.some((r) => r.zoomIn)) continue;
                if (seen.has(floor.__id)) continue;
                seen.add(floor.__id);
                cellars.push(floor);
            }
        };

        if (ground.parentStructure) collect(ground.parentStructure);
        for (let i = 0; i < ground.childObjects.length; i++) {
            const child = ground.childObjects[i];
            if (child.__type === ObjectType.Structure) collect(child as Structure);
        }
        return cellars;
    }

    private pickIndoorStationSpot(
        slot: BuildingStationSlot,
        type: string,
    ): { pos: Vec2; facing: Vec2; layer: number } | undefined {
        const picked = this.pickPosInBuilding(slot.building, type);
        if (!picked) return undefined;
        return { ...picked, layer: slot.building.layer };
    }

    private isWalkableSpot(pos: Vec2, layer = 0): boolean {
        if (this.game.map.isOnWater(pos, 0)) return false;
        const check = collider.createCircle(pos, 1);
        const nearby = this.game.grid.intersectCollider(check);
        for (let i = 0; i < nearby.length; i++) {
            const obj = nearby[i];
            if (!util.sameLayer(obj.layer, layer) || obj.__type !== ObjectType.Obstacle) continue;
            const o = obj as Obstacle;
            if (!o.collidable || o.dead || o.isWindow) continue;
            if (o.isDoor && o.door?.open) continue;
            if (coldet.test(check, o.collider)) return false;
        }
        return true;
    }

    /**
     * Place stations like furniture: against interior walls / in corners,
     * never in doorways, walls, or other objects.
     */
    private pickPosInBuilding(
        building: Building,
        type: string,
    ): { pos: Vec2; facing: Vec2 } | undefined {
        const regions = building.zoomRegions.filter((r) => r.zoomIn).map((r) => r.zoomIn!);
        if (!regions.length) return undefined;

        const candidates: { pos: Vec2; facing: Vec2 }[] = [];

        for (let i = 0; i < building.childObjects.length; i++) {
            const child = building.childObjects[i];
            if (child.__type !== ObjectType.Obstacle) continue;
            const wall = child as Obstacle;
            if (!wall.isWall || wall.dead) continue;
            let nearDoor = false;
            for (let j = 0; j < building.childObjects.length; j++) {
                const other = building.childObjects[j];
                if (other.__type !== ObjectType.Obstacle) continue;
                const o = other as Obstacle;
                if ((o.isDoor || o.isWindow) && v2.distance(o.pos, wall.pos) < 4.8) {
                    nearDoor = true;
                    break;
                }
            }
            if (nearDoor) continue;

            const inward = v2.normalizeSafe(v2.sub(building.pos, wall.pos), v2.create(1, 0));
            for (const dist of [1.55, 1.85, 2.15, 2.5, 2.9, 3.3]) {
                const pos = v2.add(wall.pos, v2.mul(inward, dist));
                if (!regions.some((r) => this.regionContains(r, pos, 0.8))) continue;
                candidates.push({ pos, facing: inward });
            }
        }

        for (let r = 0; r < regions.length; r++) {
            const region = regions[r];
            const inset = 2.6;
            const minX = region.min.x + inset;
            const maxX = region.max.x - inset;
            const minY = region.min.y + inset;
            const maxY = region.max.y - inset;
            if (maxX <= minX || maxY <= minY) continue;

            const cx = (minX + maxX) * 0.5;
            const cy = (minY + maxY) * 0.5;
            const edgePoints: { pos: Vec2; facing: Vec2 }[] = [
                { pos: v2.create(minX, minY), facing: v2.create(1, 1) },
                { pos: v2.create(maxX, minY), facing: v2.create(-1, 1) },
                { pos: v2.create(minX, maxY), facing: v2.create(1, -1) },
                { pos: v2.create(maxX, maxY), facing: v2.create(-1, -1) },
                { pos: v2.create(cx, minY), facing: v2.create(0, 1) },
                { pos: v2.create(cx, maxY), facing: v2.create(0, -1) },
                { pos: v2.create(minX, cy), facing: v2.create(1, 0) },
                { pos: v2.create(maxX, cy), facing: v2.create(-1, 0) },
                { pos: v2.create(minX + (maxX - minX) * 0.28, minY), facing: v2.create(0, 1) },
                { pos: v2.create(minX + (maxX - minX) * 0.72, minY), facing: v2.create(0, 1) },
                { pos: v2.create(minX + (maxX - minX) * 0.28, maxY), facing: v2.create(0, -1) },
                { pos: v2.create(minX + (maxX - minX) * 0.72, maxY), facing: v2.create(0, -1) },
                { pos: v2.create(minX, minY + (maxY - minY) * 0.28), facing: v2.create(1, 0) },
                { pos: v2.create(minX, minY + (maxY - minY) * 0.72), facing: v2.create(1, 0) },
                { pos: v2.create(maxX, minY + (maxY - minY) * 0.28), facing: v2.create(-1, 0) },
                { pos: v2.create(maxX, minY + (maxY - minY) * 0.72), facing: v2.create(-1, 0) },
            ];
            for (let i = 0; i < edgePoints.length; i++) {
                candidates.push({
                    pos: edgePoints[i].pos,
                    facing: v2.normalizeSafe(edgePoints[i].facing),
                });
            }
        }

        let best: { pos: Vec2; facing: Vec2 } | undefined;
        let bestScore = -Infinity;
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            if (!this.isStationSpotClear(c.pos, building, type, c.facing)) continue;
            const score = this.scoreStationSpot(c.pos, building);
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
        return best;
    }

    /** Higher = more "belongs here" (wall furniture, clear of traffic). */
    private scoreStationSpot(pos: Vec2, building: Building): number {
        let score = 0;
        let minDoor = Infinity;
        let minWindow = Infinity;
        let minWall = Infinity;

        for (let i = 0; i < building.childObjects.length; i++) {
            const child = building.childObjects[i];
            if (child.__type !== ObjectType.Obstacle) continue;
            const o = child as Obstacle;
            const d = v2.distance(o.pos, pos);
            if (o.isDoor) minDoor = Math.min(minDoor, d);
            else if (o.isWindow) minWindow = Math.min(minWindow, d);
            else if (o.isWall) minWall = Math.min(minWall, d);
        }

        score += Math.min(minDoor, 14) * 3.2;
        score += Math.min(minWindow, 10) * 1.4;
        if (minWall < 3.4) score += 18;
        else if (minWall < 4.8) score += 8;
        else score -= 8;

        const region = building.zoomRegions.find((r) => r.zoomIn)?.zoomIn;
        if (region) {
            const cx = (region.min.x + region.max.x) * 0.5;
            const cy = (region.min.y + region.max.y) * 0.5;
            const toEdge = Math.min(
                Math.abs(pos.x - region.min.x),
                Math.abs(pos.x - region.max.x),
                Math.abs(pos.y - region.min.y),
                Math.abs(pos.y - region.max.y),
            );
            const toCenter = v2.distance(pos, v2.create(cx, cy));
            score += toCenter * 0.55;
            if (toEdge < 3.5) score += 6;
        }

        for (let i = 0; i < this.game.map.obstacles.length; i++) {
            const o = this.game.map.obstacles[i];
            if (!o.type.startsWith("specops_station_")) continue;
            const d = v2.distance(o.pos, pos);
            if (d < 10) score -= (10 - d) * 2.5;
        }

        return score;
    }

    private isStationSpotClear(
        pos: Vec2,
        building?: Building,
        type?: string,
        facing?: Vec2,
    ): boolean {
        const layer = building?.layer ?? 0;
        const ori = facing ? this.facingToOri(facing) : 0;
        if (type) {
            const bounds = collider.transform(
                mapHelpers.getBoundingCollider(type),
                pos,
                math.oriToRad(ori),
                1,
            );
            const nearby = this.game.grid.intersectCollider(bounds);
            for (let i = 0; i < nearby.length; i++) {
                const obj = nearby[i];
                if (!util.sameLayer(obj.layer, layer) || obj.__type !== ObjectType.Obstacle) continue;
                const o = obj as Obstacle;
                if (o.dead || !o.collidable) continue;
                if (coldet.test(bounds, o.collider)) return false;
            }
        }

        if (facing && !this.isWalkableSpot(v2.add(pos, v2.mul(v2.normalizeSafe(facing), 2.2)), layer)) {
            return false;
        }

        if (building) {
            for (let i = 0; i < building.childObjects.length; i++) {
                const child = building.childObjects[i];
                if (child.__type !== ObjectType.Obstacle) continue;
                const o = child as Obstacle;
                if (!o.isDoor && !o.isWindow) continue;
                if (v2.distance(o.pos, pos) < 6.4) return false;
            }
        }
        if (this.tooCloseToDoor(pos, layer)) return false;

        for (let i = 0; i < this.game.map.obstacles.length; i++) {
            const o = this.game.map.obstacles[i];
            if (!o.type.startsWith("specops_station_")) continue;
            if (v2.distance(o.pos, pos) < 7.5) return false;
        }
        return true;
    }

    private tooCloseToDoor(pos: Vec2, layer: number, minDist = 6.4): boolean {
        const nearby = this.game.grid.intersectCollider(collider.createCircle(pos, minDist));
        for (let i = 0; i < nearby.length; i++) {
            const obj = nearby[i];
            if (obj.__type !== ObjectType.Obstacle) continue;
            if (!util.sameLayer(obj.layer, layer)) continue;
            const o = obj as Obstacle;
            if ((o.isDoor || o.isWindow) && v2.distance(o.pos, pos) < minDist) return true;
        }
        return false;
    }

    /**
     * One exterior wall seat for a specific building (medium/large only).
     */
    private pickOutdoorSeatForBuilding(
        building: Building,
        type: string,
    ): { pos: Vec2; facing: Vec2 } | undefined {
        const map = this.game.map;
        const region = building.zoomRegions.find((r) => r.zoomIn)?.zoomIn;
        if (!region) return undefined;

        const cx = (region.min.x + region.max.x) * 0.5;
        const cy = (region.min.y + region.max.y) * 0.5;
        const axes: { origin: Vec2; facing: Vec2 }[] = [
            { origin: v2.create(cx, region.min.y), facing: v2.create(0, -1) },
            { origin: v2.create(cx, region.max.y), facing: v2.create(0, 1) },
            { origin: v2.create(region.min.x, cy), facing: v2.create(-1, 0) },
            { origin: v2.create(region.max.x, cy), facing: v2.create(1, 0) },
            {
                origin: v2.create(region.min.x + (region.max.x - region.min.x) * 0.3, region.min.y),
                facing: v2.create(0, -1),
            },
            {
                origin: v2.create(region.min.x + (region.max.x - region.min.x) * 0.7, region.max.y),
                facing: v2.create(0, 1),
            },
        ];

        for (let i = 0; i < axes.length; i++) {
            const axis = axes[i];
            for (const pad of [3.1, 3.6, 4.2, 4.9]) {
                const pos = v2.add(axis.origin, v2.mul(axis.facing, pad));
                map.clampToMapBounds(pos, 8);
                if (map.isOnWater(pos, 0)) continue;
                if (!this.isStationSpotClear(pos, building, type, axis.facing)) continue;

                const check = collider.createCircle(pos, 2.4);
                const nearby = this.game.grid.intersectCollider(check);
                let blocked = false;
                for (let j = 0; j < nearby.length; j++) {
                    const obj = nearby[j];
                    if (obj.__type !== ObjectType.Building || obj.layer !== 0) continue;
                    if (obj === building) continue;
                    blocked = true;
                    break;
                }
                if (blocked) continue;
                return { pos, facing: axis.facing };
            }
        }
        return undefined;
    }

    private fulfillPurchase(
        player: Player,
        sku: string,
        amount: number,
        targetPos?: Vec2,
    ): boolean {
        if (sku === "specops_ammo") {
            this.refillAmmo(player);
            return true;
        }
        if (sku === SpecOpsSelfReviveSku) {
            if (!specOpsSelfReviveAllowed(this.difficulty)) return false;
            if (!specOpsCanBuySelfRevive(player)) return false;
            player.addPerk("self_revive", false);
            player.setDirty();
            return true;
        }
        if (sku === "specops_airstrike") {
            if (this.airstrikeCooldown > 0) return false;
            const pos = this.resolveOutdoorSupportPos(targetPos, player);
            if (!pos) return false;
            if (this.hasCastIronWipeNear(pos, player.layer, 30)) return false;
            this.game.planeBarn.addAirstrikeZone(pos, 28, 3, 1.5, 0.55);
            this.airstrikeCooldown = 18;
            return true;
        }
        if (sku === "specops_carepackage") {
            if (this.carePackageCooldown > 0) return false;
            const pos = this.resolveOutdoorSupportPos(targetPos, player);
            if (!pos) return false;
            this.game.planeBarn.addAirdrop(pos);
            this.carePackageCooldown = 20;
            return true;
        }
        if (sku === "specops_sentry") {
            return this.spawnSentry(player);
        }
        if ((SpecOpsAllyRoles as readonly string[]).includes(sku)) {
            return this.spawnAlly(player, sku);
        }

        const satchel = isSpecOpsArmorSatchel(sku) ? SpecOpsArmorSatchelGear[sku] : undefined;
        if (satchel) {
            const currentLevel = math.max(
                math.max(
                    player.getGearLevel(player.chest),
                    player.getGearLevel(player.helmet),
                ),
                player.getGearLevel(player.backpack),
            );
            if (satchel.level < currentLevel) return false;
            if (player.chest && player.chest !== satchel.chest) player.dropArmor(player.chest);
            if (player.helmet && player.helmet !== satchel.helmet) player.dropArmor(player.helmet);
            if (
                player.backpack
                && player.backpack !== satchel.backpack
                && player.getGearLevel(satchel.backpack) >= player.getGearLevel(player.backpack)
            ) {
                player.dropBackPackCopy(player.backpack);
            }
            player.chest = satchel.chest;
            player.helmet = satchel.helmet;
            if (player.getGearLevel(satchel.backpack) >= player.getGearLevel(player.backpack)) {
                player.backpack = satchel.backpack;
            }
            player.setDirty();
            return true;
        }

        const def = GameObjectDefs.typeToDefSafe(sku);
        if (!def) return false;

        if (def.type === "gun") {
            const gunDef = def as GunDef;
            if (gunDef.ammo === "flare" || gunDef.ignoreEndlessAmmo) return false;
            player.weaponManager.replaceGun(GameConfig.WeaponSlot.Primary, sku);
            const ammoStats = player.weaponManager.getAmmoStats(gunDef, sku);
            player.weapons[GameConfig.WeaponSlot.Primary].ammo = ammoStats.maxClip;
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
            if (player.invManager.isValid(gunDef.ammo)) {
                player.invManager.give(gunDef.ammo as InventoryItem, ammoStats.maxClip * 5);
            }
            player.weapsDirty = true;
            player.inventoryDirty = true;
            return true;
        }

        if (def.type === "melee") {
            player.weaponManager.setWeapon(GameConfig.WeaponSlot.Melee, sku, 0);
            player.weapsDirty = true;
            return true;
        }

        if (def.type === "chest" || def.type === "helmet" || def.type === "backpack") {
            const current = player[def.type];
            if (player.getGearLevel(sku) < player.getGearLevel(current)) return false;
            if (def.type === "backpack") {
                if (current && current !== sku) player.dropBackPackCopy(current);
            } else if (current && current !== sku) {
                player.dropArmor(current);
            }
            player[def.type] = sku;
            player.setDirty();
            return true;
        }

        if (def.type === "perk") {
            if (sku === "self_revive") return false;
            if (player.hasPerk(sku)) return false;
            player.addPerk(sku, false);
            player.setDirty();
            return true;
        }

        if (player.invManager.isValid(sku)) {
            player.invManager.giveAndDrop(sku, amount);
            if (def.type === "scope") {
                player.scope = sku;
                player.inventoryDirty = true;
            }
            return true;
        }

        return false;
    }

    private refillAmmo(player: Player): void {
        for (let i = 0; i < GameConfig.WeaponSlot.Count; i++) {
            const type = player.weapons[i].type;
            if (!type) continue;
            const def = GameObjectDefs.typeToDefSafe(type);
            if (def?.type !== "gun") continue;
            // Flare guns are find-only: no shop refill and no endless reserve.
            if (def.ammo === "flare" || def.ignoreEndlessAmmo) continue;
            const ammoStats = player.weaponManager.getAmmoStats(def, type);
            player.weapons[i].ammo = ammoStats.maxClip;
            if (player.invManager.isValid(def.ammo)) {
                const ammo = def.ammo as InventoryItem;
                const cap = player.invManager.getMaxCapacity(ammo);
                const have = player.invManager.get(ammo);
                player.invManager.give(ammo, math.max(cap - have, ammoStats.maxClip * 4));
            }
        }
        player.weapsDirty = true;
        player.inventoryDirty = true;
    }

    private spawnSentry(owner: Player): boolean {
        if (this.hiredSupportCount() >= SpecOpsMaxSupportUnits) return false;
        const pos = this.pickSpawnNear(owner.pos, 6, 12);
        const loadout: EnemyLoadout = {
            ...Loadouts.heavy,
            name: "Sentry",
            gun: "m249",
            speedMult: 0,
            turnRate: 360,
            range: 32,
            holdRange: 32,
            aimError: 1,
            reaction: 0,
            burst: 999,
            burstPause: 0,
        };
        let sentry: Player;
        try {
            sentry = this.game.playerBarn.addTestPlayer({
                pos,
                name: "Sentry",
                specOpsAi: true,
            });
        } catch (err) {
            this.game.logger.error("Spec Ops failed to spawn sentry", err);
            return false;
        }
        this.bindToOwner(sentry, owner, "sentry");
        this.equipAi(sentry, loadout, "sentry");
        // 300-round belt; reserve for many full reloads.
        const gunDef = GameObjectDefs.typeToDef(loadout.gun, "gun") as GunDef;
        sentry.weapons[GameConfig.WeaponSlot.Primary].ammo = SpecOpsSentryClip;
        if (sentry.invManager.isValid(gunDef.ammo)) {
            sentry.invManager.give(
                gunDef.ammo as InventoryItem,
                SpecOpsSentryClip * 8,
            );
        }
        sentry.weapsDirty = true;
        sentry.inventoryDirty = true;
        sentry.health = specOpsAllyHealth(this.wave || 1, "sentry");
        sentry.specOpsDamageMult = specOpsAllyDamageMult(this.wave || 1) * 0.9;
        const brain = new AiBrain(sentry, loadout, this.wave, "sentry", SpecOpsSentryLifetime);
        brain.acquireTicker = 0;
        brain.alerted = true;
        this.brains.set(sentry, brain);
        return true;
    }

    private spawnAlly(owner: Player, role: string): boolean {
        if (this.hiredSupportCount() >= SpecOpsMaxSupportUnits) return false;
        const kind = this.roleToClass(role);
        const template = Loadouts[kind];
        if (!template) {
            this.game.logger.error(`Spec Ops missing loadout for support role ${role}`);
            return false;
        }
        const pos = this.pickSpawnNear(owner.pos, 6, 12);
        let ally: Player;
        try {
            ally = this.game.playerBarn.addTestPlayer({
                pos,
                name: template.name,
                specOpsAi: true,
            });
        } catch (err) {
            this.game.logger.error(`Spec Ops failed to spawn support ${role}`, err);
            return false;
        }
        this.bindToOwner(ally, owner, "ally");
        try {
            this.equipAi(ally, template, "ally", kind);
            ally.health = specOpsAllyHealth(this.wave || 1, "ally");
            ally.specOpsDamageMult = specOpsAllyDamageMult(this.wave || 1);
            this.brains.set(ally, new AiBrain(ally, template, this.wave, "ally", -1, kind));
        } catch (err) {
            this.game.logger.error(`Spec Ops failed to equip support ${role}`, err);
            this.releaseSupportGroupId(ally.groupId);
            ally.kill({
                damageType: GameConfig.DamageType.Bleeding,
                dir: v2.create(1, 0),
            });
            return false;
        }
        return true;
    }

    private allocSupportGroupId(): number {
        for (let id = SpecOpsSupportGroupIdMin; id <= SpecOpsSupportGroupIdMax; id++) {
            if (!this.supportGroupIds.has(id)) {
                this.supportGroupIds.add(id);
                return id;
            }
        }
        return SpecOpsSupportGroupIdMin;
    }

    private releaseSupportGroupId(groupId: number): void {
        if (groupId >= SpecOpsSupportGroupIdMin && groupId <= SpecOpsSupportGroupIdMax) {
            this.supportGroupIds.delete(groupId);
        }
    }

    private bindToOwner(unit: Player, owner: Player, kind: "ally" | "sentry"): void {
        unit.specOpsKind = kind;
        unit.teamId = owner.teamId;
        unit.groupId = this.allocSupportGroupId();
        unit.setDirty();
        unit.weapsDirty = true;
        unit.inventoryDirty = true;
    }

    private roleToClass(role: string): EnemyClass {
        if (role === "last_man") return "juggernaut";
        if (role in Loadouts) return role as EnemyClass;
        return "rifle";
    }

    spawnEnemyPublic(kind: EnemyClass): Player {
        const host = this.livingHumans()[0];
        const player = this.spawnEnemy(kind, 0, 1, util.random(0, Math.PI * 2), host);
        if (!player) {
            throw new Error(`Spec Ops failed to spawn ${kind}`);
        }
        return player;
    }

    spawnAllyPublic(role: string, owner?: Player): Player | undefined {
        const buyer = owner ?? this.livingHumans()[0];
        if (!buyer) return undefined;
        if (!this.spawnAlly(buyer, role)) return undefined;
        const allies = this.livingHiredAllies();
        return allies[allies.length - 1];
    }

    spawnSentryPublic(owner?: Player): Player | undefined {
        const buyer = owner ?? this.livingHumans()[0];
        if (!buyer) return undefined;
        if (!this.spawnSentry(buyer)) return undefined;
        const sentries = this.livingAllies("sentry");
        return sentries[sentries.length - 1];
    }

    spawnDebugNpcs(
        owner: Player,
        kind: string,
        type: string,
        count: number,
        oneOfEach: boolean,
    ): void {
        this.botArenaManualSpawned = true;

        const enqueue = (spawn: () => void) => {
            this.debugSpawnQueue.push(spawn);
        };

        if (oneOfEach || kind === "one_of_each") {
            for (const enemyKind of SpecOpsEnemyClasses) {
                enqueue(() => {
                    this.spawnEnemyPublic(enemyKind);
                });
            }
            for (const role of SpecOpsAllyRoles) {
                enqueue(() => {
                    this.spawnAllyPublic(role, owner);
                });
            }
            enqueue(() => {
                this.spawnSentryPublic(owner);
            });
            enqueue(() => {
                this.spawnGloryExecutionerPublic();
            });
            enqueue(() => {
                this.spawnGloryHelpersPublic();
            });
            return;
        }

        const amount = math.clamp(Math.floor(count), 1, 32);
        for (let i = 0; i < amount; i++) {
            enqueue(() => {
                switch (kind) {
                    case "enemy":
                        this.spawnEnemyPublic(type as EnemyClass);
                        break;
                    case "ally":
                        this.spawnAllyPublic(type, owner);
                        break;
                    case "sentry":
                        this.spawnSentryPublic(owner);
                        break;
                    case "glory_executioner":
                        this.spawnGloryExecutionerPublic();
                        break;
                    case "glory_helpers":
                        this.spawnGloryHelpersPublic();
                        break;
                }
            });
        }
    }

    /* ── Practice mode ───────────────────────────────────────────────────── */

    /** Spawn one practice bot near the player with the panel's settings. */
    spawnPracticeBot(settings: PracticeBotSettings, index: number): Player | undefined {
        const human = this.livingHumans()[0];
        const origin = human?.pos ?? this.operatorSpawn ?? this.game.map.center;
        const pos = this.pickSpawnNear(origin, 14, 30);
        const gun = settings.gun === PracticeRandomGun
            ? PracticeGuns[util.randomInt(0, PracticeGuns.length - 1)]
            : settings.gun;
        const secondary = settings.secondary === PracticeRandomGun
            ? PracticeGuns[util.randomInt(0, PracticeGuns.length - 1)]
            : settings.secondary;
        const loadout = practiceBotLoadout(gun, settings, index, secondary);

        let player: Player;
        try {
            player = this.game.playerBarn.addTestPlayer({
                pos,
                name: loadout.name,
                team: this.aiTeam,
                specOpsAi: true,
            });
        } catch (err) {
            this.game.logger.error("Practice bot spawn failed", err);
            return undefined;
        }

        this.equipAi(player, loadout, "enemy");
        // equipAi applies Spec Ops wave gear and health; use the panel's values instead.
        const gear = practiceArmorGear(settings.armor);
        player.helmet = gear.helmet;
        player.chest = gear.chest;
        player.specOpsArmor = 0;
        player.health = settings.health;
        player.specOpsDamageMult = 1;
        player.specOpsBounty = 0;
        player.setDirty();

        const brain = new AiBrain(player, loadout, 18, "enemy");
        brain.waveScale = 1;
        brain.alerted = true;
        brain.anchor = human;
        const [flipMin, flipMax] = practiceFlipInterval(settings.turn);
        brain.practice = {
            flipMin,
            flipMax,
            dodgePerSec: practiceDodgePerSecond(settings.dodge),
            aimErrorDeg: practiceAimErrorDeg(settings.accuracy),
            reactionSec: practiceReactionSeconds(settings.reaction),
            holdFire: !settings.shootsBack,
        };
        brain.practiceCombat = new PracticeCombat(player, settings);
        // strafeSign doubles as the strafe weight: 0 = no strafing, 2 = mostly sideways.
        brain.strafeSign = (Math.random() < 0.5 ? -1 : 1) * practiceStrafeWeight(settings.strafe);
        brain.strafeFlipTicker = util.random(flipMin, flipMax);
        this.brains.set(player, brain);
        return player;
    }

    /** Remove a practice bot without counting a kill (used when the setup changes). */
    removePracticeBot(bot: Player): void {
        this.queueRemove(bot);
    }

    /** Bring a dead practice player back near the start point. */
    respawnPracticeHuman(player: Player): void {
        if (!player.dead) return;
        player.dead = false;
        player.downed = false;
        player.downedBy = undefined;
        player.killedBy = undefined;
        player.boost = 0;
        player.cancelAction();

        const origin = this.operatorSpawn ?? this.game.map.center;
        v2.set(player.pos, this.pickSpawnNear(origin, 0, 12));
        player.layer = 0;
        this.game.grid.updateObject(player);

        const barn = this.game.playerBarn;
        if (!barn.livingPlayers.includes(player)) barn.livingPlayers.push(player);
        util.removeFrom(barn.killedPlayers, player);
        if (player.team && !player.team.livingPlayers.includes(player)) {
            player.team.livingPlayers.push(player);
        }
        player.group?.checkPlayers();
        if (!player.disconnected) {
            player.client.spectating = undefined;
            player.client.startedSpectating = true;
        }
        barn.aliveCountDirty = true;
        player.grantSpecOpsReviveImmunity();
        player.setDirty();
        player.setGroupStatuses();
        this.hudDirty = true;
    }

    /**
     * Give the practice player exactly their spawn kit, survev style: 100 HP,
     * no armor pool, the kit's guns, melee, gear, scope, items and ammo.
     */
    equipPracticeHuman(player: Player, settings: PracticeSettings): void {
        const kit = settings.kit;
        player.clearInventoryForPractice();
        if (player.hasPerk("endless_ammo")) player.removePerk("endless_ammo");

        // Gear first: the backpack sets how much of everything fits.
        const gear = practiceKitGear(kit);
        player.helmet = gear.helmet;
        player.chest = gear.chest;
        player.backpack = gear.backpack;

        if (kit.scope !== "1xscope") {
            player.invManager.set(kit.scope as InventoryItem, 1);
            player.scope = kit.scope;
        }

        const giveGun = (slot: number, type: string) => {
            const def = GameObjectDefs.typeToDef(type, "gun") as GunDef;
            const ammo = player.weaponManager.getAmmoStats(def, type);
            player.weaponManager.setWeapon(slot, type, ammo.maxClip);
            const ammoType = def.ammo as InventoryItem;
            if (kit.fillAmmo && player.invManager.isValid(ammoType)) {
                player.invManager.set(ammoType, player.invManager.getMaxCapacity(ammoType));
            }
        };
        giveGun(GameConfig.WeaponSlot.Primary, settings.primary);
        if (settings.secondary) giveGun(GameConfig.WeaponSlot.Secondary, settings.secondary);
        player.weaponManager.setWeapon(GameConfig.WeaponSlot.Melee, kit.melee, 0);

        for (const item of PracticeKitItems) {
            const count = kit.counts[item];
            if (count > 0) player.invManager.give(item, count);
        }
        player.weaponManager.showNextThrowable();
        player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);

        player.health = player.maxHealth;
        player.specOpsArmor = 0;
        player.boost = 0;
        player.setDirty();
    }

    /** Practice pickups stay on the ground; inventory changes only on pickup. */
    givePracticeItem(player: Player, item: string, count: number, clear: boolean): void {
        if (!this.practice || player.specOpsAi || player.dead) return;
        if (clear) player.clearInventoryForPractice();
        const def = GameObjectDefs.typeToDefSafe(item);
        if (!def || !("lootImg" in def)) return;
        const stackable = ["ammo", "heal", "boost", "throwable"].includes(def.type);
        const amount = stackable && Number.isFinite(count) ? math.clamp(Math.round(count), 1, 999) : 1;
        let pos = v2.copy(player.pos);
        for (let i = 0; i < 16; i++) {
            const dir = v2.rotate(player.dir, i * Math.PI / 8);
            const candidate = v2.add(player.pos, v2.mul(dir, 4));
            this.game.map.clampToMapBounds(candidate, 2);
            if (v2.distance(candidate, player.pos) > 2.5 && isPathClear(this.game, player, candidate, 0.1)) {
                pos = candidate;
                break;
            }
        }
        this.game.lootBarn.addLoot(item, pos, player.layer, amount, { pushSpeed: 0, preloadGun: true });
    }

    /** Test helper: practice bots currently alive. */
    practiceBotsPublic(): Player[] {
        const out: Player[] = [];
        for (const brain of this.brains.values()) {
            if (brain.practice && !brain.player.dead && !brain.player.destroyed) {
                out.push(brain.player);
            }
        }
        return out;
    }

    /** Test helper: the practice tuning a bot was given. */
    practiceTuningPublic(player: Player): PracticeBotTuning | undefined {
        return this.brains.get(player)?.practice;
    }

    /** Test helper: teleport a stuck NPC as the in-game relocator would. */
    forceRelocateEnemyPublic(player: Player): Vec2 {
        const brain = this.brains.get(player);
        if (!brain) return v2.copy(player.pos);
        brain.age = 5;
        brain.stuckStrikes = 8;
        brain.relocateCooldown = 0;
        brain.idleTicker = StuckRelocateTime;
        this.relocateStuckEnemies();
        return v2.copy(player.pos);
    }

    /** Test helper: trigger the wave-29 glory executioner immediately. */
    spawnGloryExecutionerPublic(): Player | undefined {
        this.spawnGloryExecutioner();
        return this.gloryExecutioner;
    }

    /** Test helper: spawn one allied glory-helper group (wave 31+ cadence). */
    spawnGloryHelpersPublic(): Player[] {
        return this.spawnGloryHelperGroup();
    }

    isGloryHelper(player: Player): boolean {
        return !!this.brains.get(player)?.gloryHelper;
    }

    waveRosterPublic(wave: number, humans = 1): string[] {
        return composeWave(wave, humans, this.difficulty);
    }

    aiLoadout(player: Player) {
        return this.brains.get(player)?.loadout;
    }

    aiAlerted(player: Player): boolean {
        return !!this.brains.get(player)?.alerted;
    }

    aiAnchor(player: Player): Player | undefined {
        return this.brains.get(player)?.anchor;
    }

    aiTarget(player: Player): Player | undefined {
        return this.brains.get(player)?.target;
    }

    aiAssaultRole(player: Player): string {
        return this.brains.get(player)?.assaultRole ?? "";
    }

    aiAssaultDest(player: Player): Vec2 | undefined {
        const dest = this.brains.get(player)?.assaultDest;
        return dest ? v2.copy(dest) : undefined;
    }

    aiClearingHouse(player: Player): boolean {
        return !!this.brains.get(player)?.clearingHouse;
    }

    clearAiNadeCooldown(player: Player): void {
        const brain = this.brains.get(player);
        if (!brain) return;
        brain.nadeCooldown = 0;
        brain.acquireTicker = 0;
        brain.alerted = true;
        brain.shooting = false;
        brain.pauseTicker = 0;
        brain.nadeState = "idle";
        brain.nadeCookTicker = 0;
    }

    private equipAi(
        player: Player,
        loadout: EnemyLoadout,
        kind: SpecOpsKind = "enemy",
        classId?: EnemyClass,
    ): void {
        player.specOpsKind = kind;
        player.specOpsBounty = classId ? (SpecOpsKillBounty[classId] ?? 100) : 0;
        player.specOpsSuicideVest = !!loadout.suicideVest;
        player.specOpsStrobeTank = !!loadout.strobeTank;
        player.specOpsMirvCrawl = !!loadout.mirvCrawl;

        if (loadout.gun) {
            const gunDef = GameObjectDefs.typeToDef(loadout.gun, "gun") as GunDef;
            const ammoStats = player.weaponManager.getAmmoStats(gunDef, loadout.gun);
            player.weaponManager.setWeapon(
                GameConfig.WeaponSlot.Primary,
                loadout.gun,
                ammoStats.maxClip,
            );
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);

            if (player.invManager.isValid(gunDef.ammo)) {
                player.invManager.give(gunDef.ammo as InventoryItem, ammoStats.maxClip * 2);
            }
        }

        if (loadout.gunSecondary) {
            const secDef = GameObjectDefs.typeToDef(loadout.gunSecondary, "gun") as GunDef;
            const ammoStats = player.weaponManager.getAmmoStats(secDef, loadout.gunSecondary);
            player.weaponManager.setWeapon(
                GameConfig.WeaponSlot.Secondary,
                loadout.gunSecondary,
                ammoStats.maxClip,
            );
            if (player.invManager.isValid(secDef.ammo)) {
                player.invManager.give(secDef.ammo as InventoryItem, ammoStats.maxClip * 2);
            }
        }

        if (loadout.melee) {
            player.weaponManager.setWeapon(GameConfig.WeaponSlot.Melee, loadout.melee, 0);
            if (!loadout.gun) {
                player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
            }
        }

        player.backpack = loadout.backpack;
        const outfit = loadout.outfits?.length
            ? loadout.outfits[Math.floor(util.random(0, loadout.outfits.length))]
            : loadout.outfit;
        player.setOutfit(outfit);
        player.loadout.outfit = outfit;
        player.specOpsSpeedMult = loadout.speedMult;
        player.specOpsDamageMult = kind === "enemy"
            ? enemyDamageMult(this.wave || 1, this.difficulty)
            : 1;
        if (classId === "ironclad") {
            // Mid DPS — ironclads pressure with volume, not burst damage.
            player.specOpsDamageMult *= 0.85;
        }

        for (let i = 0; i < loadout.perks.length; i++) {
            if (!player.hasPerk(loadout.perks[i])) {
                player.addPerk(loadout.perks[i], false);
            }
        }
        if (kind === "enemy" && classId) {
            const extra = lateEnemyPerks(this.wave || 1, classId);
            for (let i = 0; i < extra.length; i++) {
                if (!player.hasPerk(extra[i])) {
                    player.addPerk(extra[i], false);
                }
            }
        }

        if (loadout.role) {
            player.promoteToRole(loadout.role);
        }

        // Practice allows two copies of a gun; ordinary Spec Ops keeps its loadout rules.
        if (!this.practice) this.stripDuplicateGuns(player);

        if (kind === "enemy") {
            const isEventBoss = (SpecOpsEventBossRotation as readonly string[]).includes(
                classId ?? "",
            );
            const isMiniBoss = (SpecOpsEventMiniBossRotation as readonly string[]).includes(
                classId ?? "",
            );
            const keepFullArmor = classId === "cast_iron"
                || classId === "ironclad"
                || classId === "machine_gunner"
                || classId === "hunter"
                || classId === "shieldbearer"
                || !!classId?.startsWith("cobalt_")
                || isEventBoss
                || isMiniBoss
                || classId === "juggernaut"
                || classId === "titan"
                || classId === "warlord"
                || classId === "black_ops"
                || classId === "captain"
                || classId === "lieutenant"
                || !!loadout.role;
            if (!keepFullArmor) {
                const gear = specOpsEnemyGear(this.wave || 1, loadout.chest, loadout.helmet);
                player.chest = gear.chest;
                player.helmet = gear.helmet;
            } else {
                // Role soft-apply can install weaker cobalt kit gear (tank → chest01) or
                // skip armor entirely (woods_king). Prefer the stronger of role kit vs loadout.
                const loadChestLv = player.getGearLevel(loadout.chest);
                const loadHelmLv = player.getGearLevel(loadout.helmet);
                if (loadout.chest && loadChestLv >= player.getGearLevel(player.chest)) {
                    player.chest = loadout.chest;
                }
                if (
                    loadout.helmet
                    && (loadHelmLv >= player.getGearLevel(player.helmet)
                        || loadout.helmet.includes("_"))
                ) {
                    player.helmet = loadout.helmet;
                }
            }
            player.specOpsArmor = 0;
            player.health = specOpsEnemyHealth(this.wave || 1, classId ?? "rifle", this.difficulty);
            // Cobalt / event bosses hit harder in the late-game fights.
            if (classId?.startsWith("cobalt_") || isEventBoss) {
                player.specOpsDamageMult = math.max(player.specOpsDamageMult, 1.15);
            }
        } else {
            // Bought allies keep role/loadout armor; they are not wave-1 militia.
            if (!loadout.role) {
                player.chest = loadout.chest;
                player.helmet = loadout.helmet;
            }
            player.specOpsArmor = 0;
        }

        if (loadout.throwsPotato) {
            const potatoes = (this.wave || 1) >= 25 ? 16 : 8;
            player.invManager.set("potato", potatoes);
            player.weaponManager.setWeapon(
                GameConfig.WeaponSlot.Throwable,
                "potato",
                0,
            );
        } else if (loadout.throwsSnowball) {
            player.invManager.set("snowball", 20);
            player.weaponManager.setWeapon(
                GameConfig.WeaponSlot.Throwable,
                "snowball",
                0,
            );
        } else if (loadout.throwsMirv) {
            player.invManager.set("mirv", 5);
            player.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "mirv", 0);
        } else if (
            loadout.throwsNades
            && !player.weapons[GameConfig.WeaponSlot.Throwable].type
        ) {
            const frags = loadout.role === "grenadier" || classId === "grenadier" ? 6 : 4;
            player.invManager.set("frag", frags);
            player.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "frag", 0);
        } else if (loadout.throwsSmoke) {
            player.invManager.set("smoke", 2);
            if (!player.weapons[GameConfig.WeaponSlot.Throwable].type) {
                player.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "smoke", 0);
            }
        } else if (
            loadout.throwsStrobe
            && !player.weapons[GameConfig.WeaponSlot.Throwable].type
        ) {
            player.invManager.set("strobe", 2);
            player.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "strobe", 0);
        }
        if (loadout.throwsStrobe) {
            player.invManager.set("strobe", math.max(player.invManager.get("strobe"), 2));
        }

        if (
            !player.weapons[GameConfig.WeaponSlot.Primary].type
            && player.weapons[GameConfig.WeaponSlot.Secondary].type
        ) {
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Secondary);
        } else if (
            player.weapons[GameConfig.WeaponSlot.Primary].type
            && !player.weapons[GameConfig.WeaponSlot.Secondary].type
            && player.curWeapIdx === GameConfig.WeaponSlot.Secondary
        ) {
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
        }

        player.setDirty();
        player.weapsDirty = true;
        player.inventoryDirty = true;
    }

    private stripDuplicateGuns(player: Player): void {
        const primary = player.weapons[GameConfig.WeaponSlot.Primary].type;
        const secondary = player.weapons[GameConfig.WeaponSlot.Secondary].type;
        if (!primary || !secondary) return;
        if (gunBaseType(primary) !== gunBaseType(secondary)) return;
        player.weaponManager.setWeapon(GameConfig.WeaponSlot.Secondary, "", 0);
    }

    private tickDiscoveryHunt(dt: number): void {
        if (this.npcIgnoreOperators) return;
        const enemies: AiBrain[] = [];
        for (const brain of this.brains.values()) {
            if (brain.kind !== "enemy" || brain.player.dead) continue;
            enemies.push(brain);
        }
        if (!enemies.length) {
            this.huntClock = 0;
            return;
        }
        const anyAttacking = enemies.some((b) => b.alerted);
        if (anyAttacking) {
            this.huntClock = 0;
            return;
        }
        this.huntClock += dt;
        const huntAfter = HuntIfIdleTime * (1 - this.pushPressure * 0.75);
        if (this.huntClock < huntAfter) return;
        this.huntClock = 0;
        const humans = this.livingHumans();
        if (!humans.length) return;
        for (let i = 0; i < enemies.length; i++) {
            const brain = enemies[i];
            brain.resolveAnchor(this);
            const host = brain.anchor ?? humans[0];
            brain.alertTo(host.pos);
        }
    }

    private relocateStuckEnemies(): void {
        const humans = this.livingHumans();
        if (!humans.length) return;
        const stuck: AiBrain[] = [];
        for (const brain of this.brains.values()) {
            if (brain.kind !== "enemy" || brain.player.dead) continue;
            if (brain.age < 1.6 || brain.relocateCooldown > 0) continue;
            if (brain.player.isReviving()) continue;
            if (brain.player.actionType === GameConfig.Action.UseItem) continue;
            if (brain.player.downed && !brain.loadout.suicideVest && !brain.loadout.mirvCrawl) {
                continue;
            }
            // Walking the exterior of a building toward a door is not stuck.
            if (brain.assaultRole && (brain.assaultDest || brain.clearingHouse)) continue;
            // Holding a firing position or watching a downed operator is not stuck.
            if (brain.alerted && brain.target && !brain.target.dead) {
                if (brain.target.downed) continue;
                const holdDist = v2.distance(brain.player.pos, brain.target.pos);
                if (holdDist < brain.loadout.range * 1.6) continue;
            }
            const wedged = brain.stuckStrikes >= 4;
            const spawnedFrozen = brain.age < 5 && brain.idleTicker >= 1.4;
            const frozen = spawnedFrozen || brain.idleTicker >= StuckRelocateTime;
            if (!wedged && !frozen) continue;
            stuck.push(brain);
        }
        if (!stuck.length) return;

        const spread = Math.max(stuck.length, 3);
        for (let i = 0; i < stuck.length; i++) {
            const brain = stuck[i];
            brain.resolveAnchor(this);
            const origin = brain.anchor?.pos ?? this.centroid(humans);
            const angle = (i / spread) * Math.PI * 2 + util.random(-0.2, 0.2);
            const pos = this.pickEnemySpawn(
                origin,
                angle,
                MinRelocateDist,
                MaxRelocateDist,
                brain.anchor,
                humans,
                i,
                stuck.length,
            );
            v2.set(brain.player.pos, pos);
            brain.player.game.grid.updateObject(brain.player);
            brain.player.setDirty();
            brain.detourPos = undefined;
            brain.coverPos = undefined;
            brain.stuckStrikes = 0;
            brain.idleTicker = 0;
            brain.idleSample = v2.copy(pos);
            brain.lastPos = v2.copy(pos);
            brain.trail.length = 0;
            brain.failedWaypoints.length = 0;
            brain.relocateCooldown = 6;
            brain.pathSideSign *= -1;
            this.nav.penalize(pos, 1.2);
        }
    }
}
