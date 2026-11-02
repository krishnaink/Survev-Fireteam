import { type SpecOpsDifficulty, specOpsDifficultyMods } from "../../../shared/defs/maps/specOpsShop.ts";

/**
 * Zombie Survival content lives separately from the legacy Spec Ops roster.
 * This first slice intentionally has one readable melee archetype.
 */
export type ZombieClass = "zombie_walker";

export interface ZombieLoadout {
    name: string;
    gun: string;
    outfits: string[];
    outfit: string;
    chest: string;
    helmet: string;
    backpack: string;
    perks: string[];
    melee: string;
    range: number;
    holdRange: number;
    speedMult: number;
    turnRate: number;
    aimError: number;
    reaction: number;
    burst: number;
    burstPause: number;
}

export const ZombieLoadouts: Record<ZombieClass, ZombieLoadout> = {
    zombie_walker: {
        name: "Zombie",
        gun: "",
        // Existing Survev outfits are placeholders until custom art is ready.
        outfits: ["outfitDarkShirt", "outfitKhaki", "outfitWoodland"],
        outfit: "outfitDarkShirt",
        chest: "",
        helmet: "",
        backpack: "backpack00",
        perks: [],
        melee: "fists",
        range: 3,
        holdRange: 2.2,
        speedMult: 0.62,
        turnRate: 150,
        aimError: 0,
        reaction: 0.18,
        burst: 0.2,
        burstPause: 0.42,
    },
};

export const ZombieKillBounty = 100;

export const ZombieMysteryBoxCost = 1000;
export const ZombieMysteryBoxRollDuration = 2.4;
export const ZombieMysteryBoxCycleInterval = 0.16;
export const ZombieMysteryBoxClaimDuration = 10;
export const ZombieMysteryBoxCooldown = 1.25;
export const ZombieMysteryBoxRelocateUses = 3;
export const ZombieUpgradeCost = 5000;
export const ZombieUpgradeDamageMult = 1.35;
export const ZombieUpgradeMagazineMult = 1.5;

export const ZombieBuyGateCosts = {
    zombie_buy_gate_750: 750,
    zombie_buy_gate_1000: 1000,
    zombie_buy_gate_1250: 1250,
    zombie_buy_gate_1500: 1500,
    zombie_buy_gate_2000: 2000,
} as const;

export function zombieBuyGateCost(type: string): number | undefined {
    return ZombieBuyGateCosts[type as keyof typeof ZombieBuyGateCosts];
}

/** Guns with normal ammo and pickup behavior that work cleanly in the box. */
export const ZombieMysteryBoxWeapons = [
    "mp5",
    "mac10",
    "ump9",
    "vector",
    "famas",
    "hk416",
    "m4a1",
    "ak47",
    "scar",
    "an94",
    "m870",
    "m1100",
    "saiga",
    "spas12",
    "m1014",
    "deagle",
    "m39",
    "sv98",
    "awc",
    "dp28",
    "m249",
    "qbb97",
] as const;

export type ZombieMysteryBoxWeapon = typeof ZombieMysteryBoxWeapons[number];

export function isZombieClass(kind: string | undefined): kind is ZombieClass {
    return kind === "zombie_walker";
}

/** Round one starts small, then grows steadily with team size and difficulty. */
export function zombieWaveCount(
    wave: number,
    humans: number,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    const round = Math.max(1, Math.floor(wave));
    const players = Math.max(1, Math.floor(humans));
    const soloCount = 4 + round * 2 + Math.floor(Math.max(0, round - 5) * 0.6);
    const teamScale = 1 + Math.max(0, players - 1) * 0.55;
    const difficultyScale = specOpsDifficultyMods(difficulty).roster;
    return Math.max(4, Math.min(48, Math.round(soloCount * teamScale * difficultyScale)));
}

export function composeZombieWave(
    wave: number,
    humans: number,
    difficulty: SpecOpsDifficulty = "regular",
): ZombieClass[] {
    return Array.from(
        { length: zombieWaveCount(wave, humans, difficulty) },
        () => "zombie_walker" as const,
    );
}

export function zombieEnemyHealth(
    wave: number,
    difficulty: SpecOpsDifficulty = "regular",
): number {
    const round = Math.max(1, Math.floor(wave));
    const base = 42 + Math.max(0, round - 1) * 5;
    return Math.min(
        300,
        Math.max(24, Math.round(base * specOpsDifficultyMods(difficulty).enemyHp)),
    );
}
