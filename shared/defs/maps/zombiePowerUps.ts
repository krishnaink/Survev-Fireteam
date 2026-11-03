export const ZombiePowerUpTypes = [
    "zombie_powerup_insta_kill",
    "zombie_powerup_double_points",
    "zombie_powerup_max_ammo",
    "zombie_powerup_nuke",
] as const;

export type ZombiePowerUpType = (typeof ZombiePowerUpTypes)[number];

export const ZombieTimedPowerUpDuration = 30;
export const ZombiePowerUpLifetime = 30;
export const ZombiePowerUpWarningTime = 5;
export const ZombiePowerUpMinInterval = 12;
export const ZombiePowerUpMaxActive = 2;
export const ZombieNukeHealthFraction = 0.35;
export const ZombieNukeCash = 400;

/**
 * How dropped power-ups spin on the ground (client only).
 * "coin": turns around its vertical axis like a coin; "flat": spins in place.
 * Period is seconds per full turn; 0 turns the spin off.
 */
export const ZombiePowerUpSpin: { style: "coin" | "flat"; period: number } = {
    style: "coin",
    period: 2.6,
};

export interface ZombiePowerUpTimers {
    instaKill: number;
    doublePoints: number;
}

export function isZombiePowerUpType(type: string): type is ZombiePowerUpType {
    return ZombiePowerUpTypes.includes(type as ZombiePowerUpType);
}

export function zombiePowerUpBudget(wave: number): number {
    return Math.min(5, 2 + Math.floor(Math.max(0, wave - 1) / 5));
}

/**
 * BO2-style expiry warning: blink slowly at first, then accelerate until the
 * pickup disappears. Integrating the frequency keeps the phase continuous.
 */
export function zombiePowerUpFlashVisible(
    age: number,
    lifetime = ZombiePowerUpLifetime,
    warningTime = ZombiePowerUpWarningTime,
): boolean {
    const elapsed = age - (lifetime - warningTime);
    if (elapsed <= 0) return true;
    if (warningTime <= 0) return false;
    const t = Math.min(Math.max(elapsed, 0), warningTime);
    const startHz = 2;
    const endHz = 12;
    const cycles = startHz * t + ((endHz - startHz) * t * t) / (2 * warningTime);
    return cycles % 1 < 0.55;
}

/** CSS animation period for an active HUD icon during its final seconds. */
export function zombiePowerUpHudFlashPeriod(
    remaining: number,
    warningTime = ZombiePowerUpWarningTime,
): number {
    const progress = warningTime <= 0
        ? 1
        : 1 - Math.min(Math.max(remaining / warningTime, 0), 1);
    return 1 / (2 + progress * 10);
}
