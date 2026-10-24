import { HudTeammateSlots, TeamMode } from "../../gameConfig.ts";
import type { Collider } from "../../utils/coldet.ts";
import { collider } from "../../utils/collider.ts";
import { v2, type Vec2 } from "../../utils/v2.ts";
import { GunDefs } from "../gameObjects/gunDefs.ts";

export type SpecOpsStation = "weapon" | "gear" | "armor" | "support" | "perk";

export const SpecOpsStationTypes: Record<SpecOpsStation, string> = {
    weapon: "specops_station_weapon",
    gear: "specops_station_gear",
    armor: "specops_station_armor",
    support: "specops_station_support",
    perk: "specops_station_perk",
};

export interface SpecOpsShopItem {
    sku: string;
    cost: number;
    station: SpecOpsStation;
    amount?: number;
    /** Buy tops inventory up to backpack max for this SKU. */
    fillToMax?: boolean;
    label?: string;
}

export const SpecOpsStartingCash = 800;
export const SpecOpsCashCap = 60000;
/** MW3-style survival vitals (armor is a pool, not gear DR). */
export const SpecOpsMaxHealth = 200;
export const SpecOpsStartingHealth = 200;
/** Late-wave AI can exceed operator health; clamp to the elite HP cap. */
export const SpecOpsEnemyMaxHealth = 280;
/** Hired allies / sentries scale toward this ceiling. */
export const SpecOpsAllyMaxHealth = 240;
export const SpecOpsMaxArmor = 250;
export const SpecOpsStartingArmor = 100;

/** Host / config Spec Ops difficulty. Regular is the live baseline. */
export const SpecOpsDifficulties = ["recruit", "regular", "hardened", "veteran"] as const;
export type SpecOpsDifficulty = (typeof SpecOpsDifficulties)[number];
export const SpecOpsDefaultDifficulty: SpecOpsDifficulty = "regular";
/** Last wave before a standard mission used to end. Kept for wave-30 glory events only — missions no longer auto-win. */
export const SpecOpsFinalWave = 30;

/**
 * Modest multipliers vs Regular. Regular is 1.0 everywhere so live feel is unchanged.
 *
 * - roster / aiCap: wave size (Veteran also raises the late-game AI cap)
 * - enemyHp / enemyDmg: NPC toughness and outgoing damage
 * - cash: starting cash + wave bonuses
 * - prices: shop / buyback / self-revive costs (harder = more expensive)
 * - pressure: kill-heat rush / hunt idle
 * - playerArmor: starting armor pool (Veteran operators start thinner)
 * - intermission: prep / shop timer (Hardened+ tighter; Recruit more breathing room)
 */
export const SpecOpsDifficultyMods: Record<SpecOpsDifficulty, {
    roster: number;
    aiCap: number;
    enemyHp: number;
    enemyDmg: number;
    cash: number;
    prices: number;
    pressure: number;
    playerArmor: number;
    intermission: number;
}> = {
    recruit: {
        roster: 0.68,
        aiCap: -2,
        enemyHp: 0.82,
        enemyDmg: 0.82,
        cash: 1.35,
        prices: 0.82,
        pressure: 0.65,
        playerArmor: 1.15,
        intermission: 1.2,
    },
    regular: {
        roster: 1,
        aiCap: 0,
        enemyHp: 1,
        enemyDmg: 1,
        cash: 1,
        prices: 1,
        pressure: 1,
        playerArmor: 1,
        intermission: 1,
    },
    hardened: {
        roster: 1.28,
        aiCap: 6,
        enemyHp: 1.14,
        enemyDmg: 1.1,
        cash: 0.9,
        prices: 1.18,
        pressure: 1.18,
        playerArmor: 0.95,
        intermission: 0.88,
    },
    veteran: {
        roster: 1.48,
        aiCap: 14,
        enemyHp: 1.22,
        enemyDmg: 1.18,
        cash: 0.82,
        prices: 1.35,
        pressure: 1.35,
        playerArmor: 0.7,
        intermission: 0.8,
    },
};

export function parseSpecOpsDifficulty(value: unknown): SpecOpsDifficulty {
    const key = String(value ?? "").toLowerCase();
    if ((SpecOpsDifficulties as readonly string[]).includes(key)) {
        return key as SpecOpsDifficulty;
    }
    return SpecOpsDefaultDifficulty;
}

export function specOpsDifficultyMods(difficulty: SpecOpsDifficulty = "regular") {
    return SpecOpsDifficultyMods[difficulty] ?? SpecOpsDifficultyMods.regular;
}

export function specOpsStartingCash(difficulty: SpecOpsDifficulty = "regular"): number {
    return Math.round(SpecOpsStartingCash * specOpsDifficultyMods(difficulty).cash);
}

export function specOpsStartingArmor(difficulty: SpecOpsDifficulty = "regular"): number {
    return Math.round(SpecOpsStartingArmor * specOpsDifficultyMods(difficulty).playerArmor);
}

/** Shop / buyback / revive price multiplier for the selected difficulty. */
export function specOpsPriceMult(difficulty: SpecOpsDifficulty = "regular"): number {
    return specOpsDifficultyMods(difficulty).prices;
}

/** Scale a base cash price by difficulty (minimum $1). */
export function specOpsScalePrice(
    cost: number,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    return Math.max(1, Math.round(cost * specOpsPriceMult(difficulty)));
}

/** Slower adrenaline drain than BR (GameConfig.player.boostDecay = 0.375). */
export const SpecOpsBoostDecay = 0.28;
/** Extra decay reduction when Lifeline is equipped in Spec Ops. */
export const SpecOpsLifelineDecayMult = 0.55;

/** Knife-tier melees too weak for wave combat — not sold at gear stations. */
export const SpecOpsShopExcludedMelee = [
    "karambit",
    "bayonet",
    "huntsman",
    "bowie",
    "hook",
] as const;

export interface SpecOpsWeaponMod {
    reloadMult?: number;
    maxClip?: number;
    maxReload?: number;
    extendedClip?: number;
    extendedReload?: number;
}

/** Baseline reload speedup for human operators (stacks with per-weapon mult). */
export const SpecOpsReloadMult = 0.9;

/**
 * Per-weapon Spec Ops tuning: faster reloads and slightly larger mags on
 * underperforming late-wave staples.
 */
export const SpecOpsWeaponMods: Record<string, SpecOpsWeaponMod> = {
    m249: { reloadMult: 0.8, maxClip: 120, maxReload: 120, extendedClip: 180, extendedReload: 180 },
    pkp: { reloadMult: 0.82, maxClip: 220, maxReload: 220, extendedClip: 280, extendedReload: 280 },
    dp28: { reloadMult: 0.85, maxClip: 70, maxReload: 70, extendedClip: 90, extendedReload: 90 },
    qbb97: { reloadMult: 0.85 },
    bar: { reloadMult: 0.85 },
    barrett: { reloadMult: 0.82, maxClip: 12, maxReload: 12, extendedClip: 14, extendedReload: 14 },
    sv98: { reloadMult: 0.85, maxClip: 12, maxReload: 12, extendedClip: 16, extendedReload: 16 },
    awc: { reloadMult: 0.85 },
    scarssr: { reloadMult: 0.85, maxClip: 12, maxReload: 12 },
    mosin: { reloadMult: 0.85 },
    scout_elite: { reloadMult: 0.85, maxClip: 6, maxReload: 6, extendedClip: 12, extendedReload: 12 },
    garand: { maxClip: 10, maxReload: 10, extendedClip: 10, extendedReload: 10 },
    svd: { maxClip: 12, maxReload: 12, extendedClip: 22, extendedReload: 22 },
    m39: { maxClip: 24, maxReload: 24, extendedClip: 34, extendedReload: 34 },
    mk12: { maxClip: 24, maxReload: 24, extendedClip: 34, extendedReload: 34 },
    saiga: { reloadMult: 0.88, maxClip: 5, maxReload: 5, extendedClip: 8, extendedReload: 8 },
    // Magazines (in-gun), not reserve bags — keep tubes/mags tight.
    m870: { reloadMult: 0.88, maxClip: 5, maxReload: 1, extendedClip: 8, extendedReload: 1 },
    mp220: { reloadMult: 0.85, maxClip: 2, maxReload: 2, extendedClip: 2, extendedReload: 2 },
    spas12: { reloadMult: 0.88, maxClip: 8, maxReload: 8, extendedClip: 10, extendedReload: 10 },
    spas16: { reloadMult: 0.88, maxClip: 6, maxReload: 6, extendedClip: 8, extendedReload: 8 },
    m1014: { reloadMult: 0.88, maxClip: 7, maxReload: 7, extendedClip: 9, extendedReload: 9 },
    m1100: { reloadMult: 0.88, maxClip: 4, maxReload: 4, extendedClip: 6, extendedReload: 6 },
    usas: { reloadMult: 0.85, maxClip: 8, maxReload: 8, extendedClip: 10, extendedReload: 10 },
    vss: { maxClip: 24, maxReload: 24, extendedClip: 34, extendedReload: 34 },
};

export function specOpsWeaponAmmoStats(
    gunType: string,
    base: { maxClip: number; maxReload: number; maxReloadAlt?: number },
    extended = false,
): typeof base {
    const mod = SpecOpsWeaponMods[gunType];
    if (!mod) return base;
    return {
        maxClip: extended
            ? (mod.extendedClip ?? mod.maxClip ?? base.maxClip)
            : (mod.maxClip ?? base.maxClip),
        maxReload: extended
            ? (mod.extendedReload ?? mod.extendedClip ?? mod.maxReload ?? base.maxReload)
            : (mod.maxReload ?? mod.maxClip ?? base.maxReload),
        maxReloadAlt: base.maxReloadAlt,
    };
}

export function specOpsWeaponReloadTime(gunType: string, reloadTime: number): number {
    const mod = SpecOpsWeaponMods[gunType];
    return reloadTime * SpecOpsReloadMult * (mod?.reloadMult ?? 1);
}

/** Health restored by the one-time Spec Ops self-revive. */
export const SpecOpsReviveHealth = 80;
/** Seconds of damage immunity after a Spec Ops human stands back up. */
export const SpecOpsReviveImmunity = 5;
/** Armor restored when a dead teammate is bought back. */
export const SpecOpsBuybackArmor = 50;
/** Base cash cost to buy a dead teammate back in. Scales with wave. */
export const SpecOpsBuybackBaseCost = 1500;
export const SpecOpsBuybackWaveCost = 250;
export const SpecOpsBuybackPrefix = "specops_buyback_";



/** Packed into the Spec Ops HUD wave id so clients can show lobby lock state. */
export const SpecOpsJoinLockFlag = 0x8000;

export function specOpsBuybackSku(slot: number): string {
    return `${SpecOpsBuybackPrefix}${slot}`;
}

export function specOpsBuybackSlot(sku: string): number | undefined {
    if (!sku.startsWith(SpecOpsBuybackPrefix)) return undefined;
    const slot = Number(sku.slice(SpecOpsBuybackPrefix.length));
    if (!Number.isInteger(slot) || slot < 0 || slot >= HudTeammateSlots) return undefined;
    return slot;
}

export function specOpsBuybackCost(
    wave: number,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    return specOpsScalePrice(
        SpecOpsBuybackBaseCost + Math.max(0, wave) * SpecOpsBuybackWaveCost,
        difficulty,
    );
}

export const SpecOpsSelfReviveSku = "specops_self_revive";
/** Base cash cost for a one-time self-revive. Scales with wave. */
export const SpecOpsSelfReviveBaseCost = 1000;
export const SpecOpsSelfReviveWaveCost = 200;

export function specOpsSelfReviveCost(
    wave: number,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    return specOpsScalePrice(
        SpecOpsSelfReviveBaseCost + Math.max(0, wave) * SpecOpsSelfReviveWaveCost,
        difficulty,
    );
}

export function specOpsSelfReviveAllowed(difficulty: SpecOpsDifficulty): boolean {
    return difficulty !== "veteran";
}

type PerkCheckPlayer = {
    hasPerk?(type: string): boolean;
    m_hasPerk?(type: string): boolean;
};

function playerHasPerk(player: PerkCheckPlayer, type: string): boolean {
    if (player.hasPerk) return player.hasPerk(type);
    if (player.m_hasPerk) return player.m_hasPerk(type);
    return false;
}

/** Block shop self-revive while Revivify (self_revive perk) is still unused. */
export function specOpsCanBuySelfRevive(player: PerkCheckPlayer): boolean {
    return !playerHasPerk(player, "self_revive");
}

/** Cash bonus when the killer has High-Value Targets and the victim has perks. */
export const SpecOpsTargetingBountyMult = 1.5;

export function specOpsKillBountyAmount(
    baseBounty: number,
    killerHasTargeting: boolean,
    victimPerkCount: number,
): number {
    if (killerHasTargeting && victimPerkCount > 0) {
        return Math.round(baseBounty * SpecOpsTargetingBountyMult);
    }
    return baseBounty;
}

/** Map-gated shop SKUs (e.g. rare_potato only on the potato biome). */
export function specOpsShopItemAvailable(sku: string, mapName: string): boolean {
    if (sku === "rare_potato") return mapName === "specops_potato";
    return true;
}

/**
 * After this wave, human IR strobe throws can summon Ironclad counters.
 * Max summons per wave = SpecOpsIroncladPerPlayer × living operators.
 */
export const SpecOpsIroncladWave = 20;
export const SpecOpsIroncladPerPlayer = 4;
/** Seconds an Ironclad crawls after being downed before MIRV detonation. */
export const SpecOpsIroncladCrawlSeconds = 10;
/** MIRV blasts when an Ironclad finishes its death crawl. */
export const SpecOpsIroncladMirvCount = 3;
/** Spec Ops operators take this fraction of airstrike / strobe bomb damage. */
export const SpecOpsAirstrikeDamageMult = 0.55;
/** Extra airstrike multiplier when the operator also has Flak Jacket. */
export const SpecOpsFlakAirstrikeDamageMult = 0.45;

/** Must be small enough that only one station UI opens at a time. */
export const SpecOpsShopRange = 4.25;

/** Early-wave NPCs are squishy; they are not operators (200 HP + armor pool). */
const EnemyHealthBase: Record<string, number> = {
    militia: 36,
    smg: 38,
    rifle: 40,
    shotgun: 38,
    bomber: 42,
    scout: 34,
    rusher: 36,
    elite: 58,
    suppressor: 42,
    flanker: 38,
    assaulter: 46,
    recon: 40,
    marksman: 42,
    grenadier: 44,
    medic: 48,
    lieutenant: 72,
    captain: 95,
    sniper: 44,
    heavy: 80,
    juggernaut: 145,
    pistol: 34,
    lmg: 68,
    dmr: 42,
    raider: 36,
    cqc: 40,
    bugler: 50,
    conscript: 26,
    machine_gunner: 88,
    potato_thrower: 34,
    cast_iron: 155,
    ironclad: 220,
    cobalt_scout: 120,
    cobalt_sniper: 110,
    cobalt_healer: 130,
    cobalt_demo: 140,
    cobalt_assault: 145,
    cobalt_tank: 180,
    woods_king: 175,
    potato_king: 165,
    desert_outlaw: 155,
    halloween_cursed: 140,
    turkey_shooter: 150,
    snow_sniper: 145,
    pirate_captain: 160,
    veteran: 48,
    shock_trooper: 40,
    gunslinger: 42,
    marauder: 44,
    stormer: 46,
    sapper: 48,
    pathfinder: 38,
    berserker: 42,
    enforcer: 52,
    looter: 28,
    farmer: 32,
    straggler: 24,
    ghoul: 30,
    trickster: 36,
    stalker: 40,
    military_rifle: 52,
    military_lmg: 70,
    military_sniper: 46,
    military_breacher: 50,
    cobalt_grunt: 58,
    cobalt_rifle: 64,
    cobalt_support: 60,
    black_ops: 88,
    warlord: 110,
    titan: 160,
    hunter: 72,
    spotter: 44,
    incursor: 42,
    shieldbearer: 95,
    rocketeer: 52,
    corsair: 58,
    vanguard: 64,
    nightblade: 40,
    demolisher: 56,
};

/** Special-event bosses that rotate onto Spec Ops boss waves. */
export const SpecOpsEventBossRotation = [
    "woods_king",
    "potato_king",
    "desert_outlaw",
    "halloween_cursed",
    "turkey_shooter",
    "snow_sniper",
    "pirate_captain",
] as const;

export type SpecOpsEventBoss = (typeof SpecOpsEventBossRotation)[number];

export function specOpsEventBossForWave(wave: number): SpecOpsEventBoss | undefined {
    if (wave < 10 || wave % 10 !== 0) return undefined;
    return SpecOpsEventBossRotation[
        Math.floor(wave / 10 - 1) % SpecOpsEventBossRotation.length
    ];
}

/** Lighter event elites on mini-boss waves (every 7, not also a 10). */
export const SpecOpsEventMiniBossRotation = [
    "turkey_shooter",
    "pirate_captain",
    "halloween_cursed",
] as const;

export function specOpsEventMiniBossForWave(
    wave: number,
): (typeof SpecOpsEventMiniBossRotation)[number] | undefined {
    if (wave < 14 || wave % 7 !== 0 || wave % 10 === 0) return undefined;
    return SpecOpsEventMiniBossRotation[
        Math.floor(wave / 7) % SpecOpsEventMiniBossRotation.length
    ];
}

export const SpecOpsHelperStartWave = 31;
export const SpecOpsHelperGroupSize = 4;
export const SpecOpsHelpersPerWave = 12;
export const SpecOpsHelperInterval = 60;
export const SpecOpsElitePerkWave = 51;

export function specOpsEnemyHealth(
    wave: number,
    kind: string,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    const base = EnemyHealthBase[kind] ?? 38;
    const scale = 1 + Math.max(0, wave - 1) * 0.062;
    const isEventBoss = (SpecOpsEventBossRotation as readonly string[]).includes(kind);
    const late = wave >= SpecOpsElitePerkWave;
    const cap = kind.startsWith("cobalt_") || kind === "cast_iron" || isEventBoss || kind === "titan"
        ? (late ? 280 : 220)
        : (late ? 260 : 200);
    let hp = Math.round(Math.min(cap, Math.max(24, base * scale)));
    if (kind === "conscript" || kind === "straggler") hp = Math.min(hp, 42);
    if (late) hp = Math.round(Math.min(cap, hp * (1.18 + (wave - SpecOpsElitePerkWave) * 0.02)));
    const mods = specOpsDifficultyMods(difficulty);
    if (mods.enemyHp !== 1) {
        hp = Math.round(Math.max(18, hp * mods.enemyHp));
        if (kind === "conscript" || kind === "straggler") hp = Math.min(hp, 42);
    }
    return hp;
}

/** Hired support HP scales with the wave so late-game drones stay useful. */
export function specOpsAllyHealth(wave: number, kind: "ally" | "sentry" = "ally"): number {
    const base = kind === "sentry" ? 70 : 100;
    const scale = 1 + Math.max(0, wave - 1) * 0.048;
    const cap = kind === "sentry" ? 200 : SpecOpsAllyMaxHealth;
    return Math.round(Math.min(cap, Math.max(base, base * scale)));
}

/** Hired support outgoing damage vs wave (1.0 early → ~2.0 late). */
export function specOpsAllyDamageMult(wave: number): number {
    return Math.min(2.15, Math.max(1, 1 + Math.max(0, wave - 1) * 0.038));
}

/** First combat wave for each difficulty (Veteran skips the tutorial waves). */
export function specOpsStartingWave(difficulty: SpecOpsDifficulty = "regular"): number {
    return difficulty === "veteran" ? 5 : 1;
}

/** Chest/helmet only come online after the first few waves. */
export function specOpsEnemyGear(
    wave: number,
    chest: string,
    helmet: string,
): { chest: string; helmet: string } {
    if (wave <= 4) return { chest: "", helmet: "" };
    if (wave <= 7) {
        return {
            chest: chest ? "chest01" : "",
            helmet: helmet ? "helmet01" : "",
        };
    }
    if (wave <= 11) {
        const lightChest = chest === "chest03" || chest === "chest04" ? "chest02" : chest;
        const lightHelmet = helmet === "helmet03" || helmet === "helmet04" ? "helmet02" : helmet;
        return { chest: lightChest, helmet: lightHelmet };
    }
    return { chest, helmet };
}
export const SpecOpsMaxSentries = 12;
export const SpecOpsMaxAllies = 12;
/** Combined hired support (allies + sentries). Free glory helpers do not count. */
export const SpecOpsMaxSupportUnits = 12;
/** Sentry magazine size and dry-reload duration. */
export const SpecOpsSentryClip = 300;
export const SpecOpsSentryReloadTime = 9;
/** Perks kept after a cash buyback. Operators can hold more during a life. */
export const SpecOpsMaxPerks = 6;
/** First perk (N = 0). Further purchases scale from current perk count. */
export const SpecOpsPerkBaseCost = 2000;
/** Extra cash per already-owned perk after the first: nextPrice = base + step * max(0, N - 1). */
export const SpecOpsPerkStepCost = 1500;

/** Cash cost of the next perk while the operator currently has `perkCount` perks. */
export function specOpsPerkShopCost(
    perkCount: number,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    const n = Math.max(0, perkCount | 0);
    return specOpsScalePrice(
        SpecOpsPerkBaseCost + SpecOpsPerkStepCost * Math.max(0, n - 1),
        difficulty,
    );
}

/** Sell refund for one perk while the operator currently has `perkCount` perks. */
export function specOpsPerkShopRefund(
    perkCount: number,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    return specOpsPerkShopCost(Math.max(0, perkCount - 1), difficulty);
}
export const SpecOpsSentryLifetime = 120;

/**
 * MW3-style progressive unlocks:
 * guns first → equipment → armory + support → perks.
 * Values are the wave that must be cleared (current wave number).
 */
export const SpecOpsStationUnlockWave: Record<SpecOpsStation, number> = {
    weapon: 0,
    gear: 2,
    armor: 4,
    support: 4,
    perk: 6,
};

export function specOpsStationUnlocked(station: SpecOpsStation, wave: number): boolean {
    return wave >= SpecOpsStationUnlockWave[station];
}

export const SpecOpsArmorPlateSku = "armor_plate";
/** One armor-shop purchase grants this many plates. */
export const SpecOpsArmorPlatePackSize = 3;
/** Armor points restored by using one plate. */
export const SpecOpsArmorPlateRestore = 75;
/** Base 4 plates, +2 per backpack level (lv0–4). */
export const SpecOpsArmorPlateBagSizes = [4, 6, 8, 10, 12] as const;

/** Armor satchel tiers: bundled chest + helmet + bag using standard Survev DR. */
export const SpecOpsArmorSatchelSkus = [
    "specops_satchel_01",
    "specops_satchel_02",
    "specops_satchel_03",
    "specops_satchel_04",
] as const;

export type SpecOpsArmorSatchelSku = (typeof SpecOpsArmorSatchelSkus)[number];

export const SpecOpsArmorSatchelGear: Record<SpecOpsArmorSatchelSku, {
    chest: string;
    helmet: string;
    backpack: string;
    level: number;
}> = {
    specops_satchel_01: {
        chest: "chest01",
        helmet: "helmet01",
        backpack: "backpack01",
        level: 1,
    },
    specops_satchel_02: {
        chest: "chest02",
        helmet: "helmet02",
        backpack: "backpack02",
        level: 2,
    },
    specops_satchel_03: {
        chest: "chest03",
        helmet: "helmet03",
        backpack: "backpack03",
        level: 3,
    },
    specops_satchel_04: {
        chest: "chest04",
        helmet: "helmet04",
        backpack: "backpack04",
        level: 4,
    },
};

export const SpecOpsArmorSatchelCosts: Record<SpecOpsArmorSatchelSku, number> = {
    specops_satchel_01: 5000,
    specops_satchel_02: 10000,
    specops_satchel_03: 15000,
    specops_satchel_04: 22500,
};

export function isSpecOpsArmorSatchel(sku: string): sku is SpecOpsArmorSatchelSku {
    return (SpecOpsArmorSatchelSkus as readonly string[]).includes(sku);
}

export function specOpsArmorSatchelItems(): SpecOpsShopItem[] {
    return SpecOpsArmorSatchelSkus.map((sku) => ({
        sku,
        cost: SpecOpsArmorSatchelCosts[sku],
        station: "armor" as SpecOpsStation,
        label: `Armor Satchel Lv${SpecOpsArmorSatchelGear[sku].level}`,
    }));
}

export const SpecOpsAllyRoles = [
    "recon",
    "medic",
    "marksman",
    "grenadier",
    "bugler",
    "lieutenant",
    "captain",
    "last_man",
    "assaulter",
    "suppressor",
    "flanker",
    "cqc",
] as const;

/** Buyable Spec Ops perks (existing game perks). */
export const SpecOpsBuyablePerks = [
    "steelskin",
    "flak_jacket",
    "firepower",
    "endless_ammo",
    "ap_rounds",
    "splinter",
    "small_arms",
    "takedown",
    "gotw",
    "windwalk",
    "combat_stims",
    "field_medic",
    "chambered",
    "high_velocity",
    "bonus_assault",
    "amped_explosives",
    "explosive",
    "fabricate",
    "broken_arrow",
    "lifeline",
    "aoe_heal",
    "tree_climbing",
    "scavenger",
    "scavenger_adv",
    "targeting",
    "martyrdom",
    "inspiration",
    "final_bugle",
    "rare_potato",
    "leadership",
    "bonus_9mm",
    "bonus_45",
    "pirate",
    "hunted",
    "turkey_shoot",
] as const;

/** Explicit weapon prices. Any GunDefs entry missing here still gets a fallback. */
const SpecOpsWeaponShopCosts: Record<string, number> = {
    mp5: 800,
    ump9: 1000,
    mac10: 1100,
    vector: 3000,
    vector45: 3100,
    scorpion: 3600,
    vss: 3500,
    m870: 1200,
    mp220: 1600,
    spas12: 2800,
    ak47: 1700,
    hk416: 2000,
    famas: 2200,
    groza: 2600,
    mosin: 2000,
    scar: 2600,
    m4a1: 2800,
    m1a1: 3000,
    saiga: 3000,
    mk12: 3300,
    m249: 4000,
    qbb97: 4200,
    dp28: 4300,
    pkp: 4500,
    an94: 4400,
    sv98: 4500,
    sv98_winter: 5000,
    deagle: 2200,
    p30l: 2600,
    scout_elite: 5500,
    garand: 6000,
    model94: 5200,
    blr: 5800,
    bar: 6200,
    grozas: 6500,
    scarssr: 7500,
    usas: 8000,
    awc: 9000,
    awc_winter: 9500,
    ash12: 8500,
    sw500: 7000,
    barrett: 9000,
    potato_smg: 9000,
    potato_lmg: 11000,
    potato_cannon: 12500,
    m9: 400,
    m9_dual: 900,
    m93r: 700,
    m93r_dual: 1400,
    glock: 600,
    glock_dual: 1200,
    ot38: 650,
    ot38_dual: 1300,
    ots38: 900,
    ots38_dual: 1800,
    colt45: 800,
    colt45_dual: 1600,
    m1911: 850,
    m1911_dual: 1700,
    deagle_dual: 4800,
    p30l_dual: 5200,
    l86: 3600,
    imbel: 2200,
    mkg45: 2900,
    m39: 3000,
    svd: 3800,
    svd_winter: 4200,
    m1100: 1400,
    spas16: 3600,
    m1014: 3900,
    // Listed for catalog completeness; tryBuy still blocks flare sales.
    flare_gun: 5000,
    flare_gun_dual: 9000,
};

function specOpsDefaultWeaponCost(sku: string): number {
    const def = GunDefs[sku as keyof typeof GunDefs] as
        | { ammo?: string; fireMode?: string; maxClip?: number }
        | undefined;
    if (!def) return 2500;
    if (sku.includes("dual")) return 2000;
    if (def.ammo === "flare" || def.ammo === "potato_ammo" || def.ammo === "bugle_ammo") {
        return 8000;
    }
    if ((def.maxClip ?? 0) >= 75) return 4500;
    if (def.fireMode === "auto") return 2800;
    if (def.fireMode === "burst") return 2200;
    return 2500;
}

const SpecOpsWeaponShopItems: SpecOpsShopItem[] = Object.keys(GunDefs)
    .filter((sku) => {
        const def = GunDefs[sku as keyof typeof GunDefs] as { noDrop?: boolean } | undefined;
        // Undroppable guns (bugle, m9_cursed) stay find/role-only — not sold.
        return !def?.noDrop;
    })
    .sort((a, b) => a.localeCompare(b))
    .map((sku) => ({
        sku,
        cost: SpecOpsWeaponShopCosts[sku] ?? specOpsDefaultWeaponCost(sku),
        station: "weapon" as const,
    }));

export const SpecOpsShopCatalog: SpecOpsShopItem[] = [
    ...SpecOpsWeaponShopItems,

    {
        sku: SpecOpsArmorPlateSku,
        cost: 800,
        station: "armor",
        amount: SpecOpsArmorPlatePackSize,
        label: "Armor plates (x3)",
    },

    { sku: "specops_ammo", cost: 300, station: "gear", label: "Ammo resupply" },
    { sku: SpecOpsSelfReviveSku, cost: SpecOpsSelfReviveBaseCost, station: "gear", label: "Self Revive" },
    { sku: "bandage", cost: 400, station: "gear", fillToMax: true, label: "Bandages (fill)" },
    { sku: "soda", cost: 450, station: "gear", fillToMax: true, label: "Sodas (fill)" },
    { sku: "healthkit", cost: 800, station: "gear", fillToMax: true, label: "Medkits (fill)" },
    { sku: "painkiller", cost: 600, station: "gear", fillToMax: true, label: "Painkillers (fill)" },
    { sku: "4xscope", cost: 700, station: "gear" },
    { sku: "8xscope", cost: 1400, station: "gear" },
    { sku: "15xscope", cost: 2200, station: "gear" },
    { sku: "frag", cost: 500, station: "gear", amount: 6, label: "Frags (x6)" },
    { sku: "strobe", cost: 900, station: "gear", amount: 2, label: "Strobes (x2)" },
    { sku: "mirv", cost: 800, station: "gear", amount: 3, label: "MIRVs (x3)" },
    { sku: "potato", cost: 600, station: "gear", amount: 8, label: "Potato (x8)" },
    { sku: "smoke", cost: 450, station: "gear", amount: 6, label: "Smokes (x6)" },
    { sku: "snowball", cost: 300, station: "gear", amount: 12, label: "Snowballs (x12)" },
    { sku: "tomato", cost: 350, station: "gear", amount: 8, label: "Tomatoes (x8)" },
    { sku: "coconut", cost: 500, station: "gear", amount: 4, label: "Coconuts (x4)" },
    { sku: "2xscope", cost: 350, station: "gear" },
    { sku: "machete", cost: 600, station: "gear" },
    { sku: "katana", cost: 1800, station: "gear" },
    { sku: "pan", cost: 900, station: "gear" },
    { sku: "woodaxe", cost: 800, station: "gear" },
    { sku: "fireaxe", cost: 1100, station: "gear" },
    { sku: "naginata", cost: 2000, station: "gear" },
    { sku: "stonehammer", cost: 1600, station: "gear" },
    { sku: "iceaxe", cost: 1500, station: "gear" },
    { sku: "cutlass", cost: 1700, station: "gear" },
    { sku: "spade", cost: 900, station: "gear" },
    { sku: "crowbar", cost: 800, station: "gear" },
    { sku: "saw", cost: 1400, station: "gear" },
    { sku: "knuckles", cost: 700, station: "gear" },

    { sku: "specops_carepackage", cost: 2200, station: "support", label: "Care package" },
    { sku: "specops_airstrike", cost: 3000, station: "support", label: "Airstrike" },
    { sku: "specops_sentry", cost: 2600, station: "support", label: "Sentry gun" },
    { sku: "recon", cost: 1700, station: "support", label: "Recon" },
    { sku: "medic", cost: 2200, station: "support", label: "Medic" },
    { sku: "grenadier", cost: 2500, station: "support", label: "Grenadier" },
    { sku: "marksman", cost: 2700, station: "support", label: "Marksman" },
    { sku: "bugler", cost: 3000, station: "support", label: "Bugler" },
    { sku: "lieutenant", cost: 3500, station: "support", label: "Lieutenant" },
    { sku: "captain", cost: 4500, station: "support", label: "Captain" },
    { sku: "last_man", cost: 6000, station: "support", label: "Juggernaut" },
    { sku: "assaulter", cost: 2800, station: "support", label: "Assaulter" },
    { sku: "suppressor", cost: 2700, station: "support", label: "Suppressor" },
    { sku: "flanker", cost: 2600, station: "support", label: "Flanker" },
    { sku: "cqc", cost: 2400, station: "support", label: "CQC" },

    ...SpecOpsBuyablePerks.map((sku) => ({
        sku,
        cost: SpecOpsPerkBaseCost,
        station: "perk" as const,
    })),
];

export const SpecOpsShopBySku: Record<string, SpecOpsShopItem> = Object.fromEntries(
    SpecOpsShopCatalog.map((item) => [item.sku, item]),
);

export const SpecOpsUnequipPrefix = "specops_unequip_";

export function specOpsUnequipSku(perk: string): string {
    return `${SpecOpsUnequipPrefix}${perk}`;
}

export function specOpsUnequipPerk(sku: string): string | undefined {
    if (!sku.startsWith(SpecOpsUnequipPrefix)) return undefined;
    const perk = sku.slice(SpecOpsUnequipPrefix.length);
    const item = SpecOpsShopBySku[perk];
    if (!item || item.station !== "perk") return undefined;
    return perk;
}

/** Smaller teams pay less for hired support / sentry / strikes. */
export function specOpsSupportCostMult(teamMode: TeamMode): number {
    if (teamMode <= TeamMode.Solo) return 0.6;
    if (teamMode === TeamMode.Duo) return 0.75;
    return 1;
}

export function specOpsShopItemCost(
    item: SpecOpsShopItem,
    teamMode: TeamMode,
    perkCount = 0,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    if (item.station === "perk") {
        return specOpsPerkShopCost(perkCount, difficulty);
    }
    let cost = item.cost;
    if (item.station === "support") {
        cost = Math.max(1, Math.round(item.cost * specOpsSupportCostMult(teamMode)));
    }
    return specOpsScalePrice(cost, difficulty);
}

/** Station catalog minus universal items, sorted by category / ammo then cost. */
export function specOpsShopStationItems(
    station: SpecOpsStation,
    teamMode: TeamMode,
    mapName = "",
    perkCount = 0,
    _wave = 0,
    difficulty: SpecOpsDifficulty = "regular",
): SpecOpsShopItem[] {
    const stationItems = SpecOpsShopCatalog.filter(
        (item) =>
            item.station === station
            && item.sku !== "specops_ammo"
            && item.sku !== SpecOpsSelfReviveSku
            && specOpsShopItemAvailable(item.sku, mapName),
    )
        .map((item) => ({
            ...item,
            cost: specOpsShopItemCost(item, teamMode, perkCount, difficulty),
        }));

    // Armor satchels are sold at every unlocked station.
    const satchels = specOpsArmorSatchelItems().map((item) => ({
        ...item,
        station,
        cost: specOpsScalePrice(item.cost, difficulty),
    }));

    return [...stationItems, ...satchels].sort((a, b) => {
        const ka = specOpsShopSortKey(a);
        const kb = specOpsShopSortKey(b);
        if (ka.group !== kb.group) return ka.group - kb.group;
        if (ka.ammo !== kb.ammo) return ka.ammo - kb.ammo;
        if (ka.cat !== kb.cat) return ka.cat - kb.cat;
        return a.cost - b.cost || a.sku.localeCompare(b.sku);
    });
}

const SpecOpsAmmoSortOrder = [
    "9mm",
    "9mm_cursed",
    "45acp",
    "12gauge",
    "556mm",
    "762mm",
    "50AE",
    "308sub",
    "flare",
    "potato_ammo",
    "bugle_ammo",
] as const;

function specOpsShopSortKey(item: SpecOpsShopItem): { group: number; ammo: number; cat: number } {
    // Station-level groups keep armor/gear/support/perk sections coherent.
    const stationGroup: Record<SpecOpsStation, number> = {
        weapon: 0,
        armor: 1,
        gear: 2,
        support: 3,
        perk: 4,
    };
    const group = stationGroup[item.station] ?? 9;

    if (item.station === "weapon") {
        const def = GunDefs[item.sku as keyof typeof GunDefs] as
            | { ammo?: string; fireMode?: string; maxClip?: number; bulletCount?: number }
            | undefined;
        if (def) {
            const ammoIdx = SpecOpsAmmoSortOrder.indexOf(
                (def.ammo ?? "") as (typeof SpecOpsAmmoSortOrder)[number],
            );
            const ammo = ammoIdx >= 0 ? ammoIdx : SpecOpsAmmoSortOrder.length;
            return { group, ammo, cat: specOpsGunCategory(item.sku, def) };
        }
        return { group, ammo: 90, cat: 90 };
    }

    if (item.station === "armor") {
        if (item.sku === SpecOpsArmorPlateSku) return { group, ammo: 0, cat: 0 };
        if (item.sku.startsWith("specops_satchel")) return { group, ammo: 1, cat: 1 };
        return { group, ammo: 2, cat: 2 };
    }

    if (item.station === "gear") {
        if (item.sku === "bandage" || item.sku === "healthkit" || item.sku === "soda" || item.sku === "painkiller") {
            return { group, ammo: 0, cat: 0 };
        }
        if (item.sku.endsWith("scope")) return { group, ammo: 1, cat: 1 };
        if (
            item.sku === "frag"
            || item.sku === "mirv"
            || item.sku === "smoke"
            || item.sku === "strobe"
            || item.sku === "potato"
            || item.sku === "snowball"
            || item.sku === "tomato"
        ) {
            return { group, ammo: 2, cat: 2 };
        }
        // Melee / misc gear
        return { group, ammo: 3, cat: 3 };
    }

    return { group, ammo: 0, cat: 0 };
}

function specOpsGunCategory(
    sku: string,
    def: { fireMode?: string; maxClip?: number; bulletCount?: number; ammo?: string },
): number {
    if (
        sku.includes("dual") || sku === "m9" || sku === "m93r" || sku === "glock"
        || sku === "ot38" || sku === "ots38" || sku === "colt45" || sku === "m1911"
        || sku === "deagle" || sku === "p30l" || sku === "sw500"
    ) {
        return 0; // pistols
    }
    if (def.ammo === "12gauge" || (def.bulletCount && def.bulletCount > 1)) {
        return 2; // shotguns
    }
    if (
        sku === "mp5" || sku === "ump9" || sku === "mac10" || sku === "vector"
        || sku === "vector45" || sku === "scorpion" || sku === "cz"
    ) {
        return 1; // SMGs
    }
    if (
        sku === "m249" || sku === "qbb97" || sku === "dp28" || sku === "pkp"
        || sku === "potato_lmg" || (def.maxClip && def.maxClip >= 60)
    ) {
        return 4; // LMGs
    }
    if (
        sku === "mosin" || sku === "sv98" || sku === "awc" || sku === "barrett"
        || sku === "scout_elite" || sku === "blr" || sku === "model94"
        || sku === "garand" || sku === "vss" || sku === "mk12" || sku === "l86"
        || sku === "m39" || sku === "svd" || sku === "scarssr"
    ) {
        return 5; // DMR / sniper
    }
    return 3; // assault / rifle
}

export const SpecOpsKillBounty: Record<string, number> = {
    militia: 75,
    smg: 110,
    rifle: 140,
    shotgun: 150,
    bomber: 200,
    scout: 160,
    rusher: 175,
    elite: 280,
    suppressor: 220,
    flanker: 190,
    assaulter: 210,
    recon: 200,
    marksman: 240,
    grenadier: 260,
    medic: 300,
    sniper: 320,
    heavy: 350,
    lieutenant: 500,
    captain: 700,
    juggernaut: 1200,
    pistol: 90,
    lmg: 240,
    dmr: 230,
    raider: 130,
    cqc: 180,
    bugler: 280,
    conscript: 40,
    machine_gunner: 320,
    potato_thrower: 160,
    cast_iron: 900,
    ironclad: 1400,
    cobalt_scout: 1500,
    cobalt_sniper: 1600,
    cobalt_healer: 1700,
    cobalt_demo: 1800,
    cobalt_assault: 1900,
    cobalt_tank: 2200,
    woods_king: 2500,
    potato_king: 2400,
    desert_outlaw: 2300,
    halloween_cursed: 2100,
    turkey_shooter: 2200,
    snow_sniper: 2350,
    pirate_captain: 2450,
    veteran: 180,
    shock_trooper: 90,
    gunslinger: 160,
    marauder: 170,
    stormer: 200,
    sapper: 220,
    pathfinder: 210,
    berserker: 190,
    enforcer: 210,
    looter: 55,
    farmer: 70,
    straggler: 45,
    ghoul: 80,
    trickster: 140,
    stalker: 200,
    military_rifle: 230,
    military_lmg: 280,
    military_sniper: 300,
    military_breacher: 240,
    cobalt_grunt: 260,
    cobalt_rifle: 290,
    cobalt_support: 270,
    black_ops: 420,
    warlord: 600,
    titan: 750,
    hunter: 480,
    spotter: 250,
    incursor: 210,
    shieldbearer: 380,
    rocketeer: 270,
    corsair: 300,
    vanguard: 290,
    nightblade: 220,
    demolisher: 280,
};

export function specOpsStationFromType(type: string): SpecOpsStation | undefined {
    for (const station of Object.keys(SpecOpsStationTypes) as SpecOpsStation[]) {
        if (SpecOpsStationTypes[station] === type) return station;
    }
    return undefined;
}

/** Obstacle-like objects that can sit between a buyer and a station. */
export interface ShopBlocker {
    __id: number;
    dead: boolean;
    collidable: boolean;
    collider: Collider;
    active?: boolean;
    isDoor?: boolean;
    door?: { open?: boolean };
}

/**
 * True if a collidable wall/object sits between the player and the station.
 * Standing on/against the station itself is always allowed.
 */
export function shopApproachBlocked(
    from: Vec2,
    stationPos: Vec2,
    stationId: number,
    obstacles: ShopBlocker[],
): boolean {
    if (v2.distance(from, stationPos) < 0.9) return false;
    for (let i = 0; i < obstacles.length; i++) {
        const o = obstacles[i];
        if (o.__id === stationId) continue;
        if (o.active === false || o.dead || !o.collidable) continue;
        if (o.isDoor && o.door?.open) continue;
        if (collider.intersectSegment(o.collider, from, stationPos)) return true;
    }
    return false;
}

export const SpecOpsStationMarkerTypes: Record<SpecOpsStation, string> = {
    weapon: "specops_marker_weapon",
    gear: "specops_marker_gear",
    armor: "specops_marker_armor",
    support: "specops_marker_support",
    perk: "specops_marker_perk",
};

export function specOpsWaveBonus(
    wave: number,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    return Math.round((300 + wave * 55) * specOpsDifficultyMods(difficulty).cash);
}

/** Cash per leftover countdown second when an operator starts the wave early. */
export const SpecOpsEarlyStartCashPerSecond = 15;

export function specOpsEarlyStartBonus(secondsLeft: number): number {
    return Math.floor(Math.max(secondsLeft, 0)) * SpecOpsEarlyStartCashPerSecond;
}

/** Spec Ops inventory holds — sized for long waves; level 4 (backpack04) caps at 999. */
export const SpecOpsBagSizes: Record<string, number[]> = {
    "9mm": [300, 500, 700, 900, 999],
    "762mm": [250, 450, 650, 850, 999],
    "556mm": [250, 450, 650, 850, 999],
    "12gauge": [40, 70, 110, 160, 999],
    "50AE": [80, 140, 200, 280, 999],
    "308sub": [40, 70, 110, 160, 999],
    flare: [4, 6, 8, 10, 16],
    "45acp": [250, 450, 650, 850, 999],
    frag: [8, 14, 20, 28, 40],
    smoke: [8, 14, 20, 28, 40],
    strobe: [4, 6, 8, 12, 16],
    mirv: [4, 8, 12, 16, 24],
    snowball: [20, 40, 60, 80, 120],
    potato: [20, 40, 60, 80, 120],
    tomato: [20, 40, 60, 80, 120],
    coconut: [6, 10, 14, 18, 24],
    bandage: [15, 30, 50, 80, 999],
    healthkit: [3, 5, 8, 12, 20],
    soda: [6, 12, 20, 30, 50],
    painkiller: [3, 5, 8, 12, 20],
    armor_plate: [...SpecOpsArmorPlateBagSizes],
    "1xscope": [1, 1, 1, 1, 1],
    "2xscope": [1, 1, 1, 1, 1],
    "4xscope": [1, 1, 1, 1, 1],
    "8xscope": [1, 1, 1, 1, 1],
    "15xscope": [1, 1, 1, 1, 1],
};
