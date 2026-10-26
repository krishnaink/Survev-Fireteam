import { BaseDefs } from "./defs/gameObjects/gunDefs.ts";
import { MeleeDefs } from "./defs/gameObjects/meleeDefs.ts";
import { math } from "./utils/math.ts";

/**
 * Practice mode settings, shared by the client panel, the network message and
 * the server. Every value is clamped by `sanitizePracticeSettings` before use.
 */

export const PracticeMaxBots = 4;
/** Wiggle, strafe, direction-change and dodge sliders run 0–10. */
export const PracticeSliderMax = 10;
export const PracticeMinBotHealth = 25;
/** Spec Ops caps enemy health at 280 (SpecOpsEnemyMaxHealth). */
export const PracticeMaxBotHealth = 280;
export const PracticeMaxArmor = 3;
/** Reaction time is stored in tenths of a second (0–2.0 s). */
export const PracticeMaxReaction = 20;
/** Default seconds before dead bots come back. */
export const PracticeBotRespawnDelay = 1.5;
/** Respawn delay is stored in tenths of a second (0–10 s). */
export const PracticeMaxRespawnDelay = 100;

/**
 * How bots come back after dying:
 * - each: every bot respawns on its own after the delay
 * - wave: once all bots are down, they all respawn together after the delay
 * - off:  dead bots stay down until you press "Respawn bots"
 */
export const PracticeRespawnModes = ["each", "wave", "off"] as const;
export type PracticeRespawnMode = (typeof PracticeRespawnModes)[number];

export const PracticeRespawnModeLabels: Record<PracticeRespawnMode, string> = {
    each: "Each bot on its own",
    wave: "All at once, when all are down",
    off: "Off (respawn by hand)",
};
/** Seconds before the player respawns after dying. */
export const PracticePlayerRespawnDelay = 3;
/** At most this many practice matches run at once on one game server. */
export const PracticeMaxMatches = 4;
/** Bot gun value meaning "pick a random gun each time it spawns". */
export const PracticeRandomGun = "random";

/** Guns left out of the pickers: event-only and joke weapons. */
const PracticeGunExclude = new Set([
    "m9_cursed",
    "flare_gun",
    "bugle",
    "potato_cannon",
    "potato_smg",
    "potato_lmg",
]);

/** Every regular gun (no dual pistols, skins or event weapons), in the game's own order. */
export const PracticeGuns: string[] = Object.keys(BaseDefs).filter((type) => {
    const def = BaseDefs[type];
    return def.type === "gun" && !def.isDual && !PracticeGunExclude.has(type);
});

export function isPracticeGun(type: string): boolean {
    return PracticeGuns.includes(type);
}

export function practiceGunName(type: string): string {
    if (type === PracticeRandomGun) return "Random";
    return BaseDefs[type]?.name ?? type;
}

export interface PracticeBotSettings {
    /** Gun type, or "random". */
    gun: string;
    /** Second gun, "random", or "" for none. */
    secondary: string;
    melee: string;
    /** Use normal weapon swaps to shorten slow-gun recovery. */
    quickSwitch: boolean;
    /** Switch to melee when a visible target is within striking distance. */
    autoMelee: boolean;
    /** Main wiggle slider (0–10); sets the three below when moved. */
    wiggle: number;
    /** How hard it strafes side to side (0–10). */
    strafe: number;
    /** How often it changes strafe direction (0 = never, 10 = constantly). */
    turn: number;
    /** How much it jukes when you aim at it (0–10). */
    dodge: number;
    /** Aim accuracy, 0–100 %. */
    accuracy: number;
    /** Reaction time in tenths of a second (0–20). */
    reaction: number;
    /** False turns the bot into a moving target that never fires. */
    shootsBack: boolean;
    /** Health, 25–280. */
    health: number;
    /** Armor level 0–3 (helmet + vest). */
    armor: number;
}

/* ── Your spawn kit ──────────────────────────────────────────────────────── */

/** Every melee weapon (including skins). */
export const PracticeMelees: string[] = Object.keys(MeleeDefs);

export const PracticeScopes = ["1xscope", "2xscope", "4xscope", "8xscope", "15xscope"] as const;

/** Consumables and throwables the kit can hold, in panel order. */
export const PracticeKitItems = [
    "bandage",
    "healthkit",
    "soda",
    "painkiller",
    "frag",
    "smoke",
    "mirv",
] as const;
export type PracticeKitItem = (typeof PracticeKitItems)[number];

/** Highest count the panel allows per kit item; the backpack still caps it in game. */
export const PracticeKitMaxCount = 99;
/** Helmet / vest levels 0–4, backpack levels 0–3 (survev gear). */
export const PracticeMaxGearLevel = 4;
export const PracticeMaxPackLevel = 3;

export interface PracticeKit {
    melee: string;
    /** 0 = none, 1–4. */
    helmet: number;
    /** 0 = none, 1–4. */
    vest: number;
    /** 0 = default pack, 1–3. */
    backpack: number;
    scope: string;
    /** Fill reserve ammo for your guns up to what the backpack holds. */
    fillAmmo: boolean;
    counts: Record<PracticeKitItem, number>;
}

export function defaultPracticeKit(): PracticeKit {
    return {
        melee: "fists",
        helmet: 0,
        vest: 0,
        backpack: 0,
        scope: "1xscope",
        fillAmmo: true,
        counts: {
            bandage: 0,
            healthkit: 0,
            soda: 0,
            painkiller: 0,
            frag: 0,
            smoke: 0,
            mirv: 0,
        },
    };
}

export function practiceKitGear(kit: PracticeKit): { helmet: string; chest: string; backpack: string } {
    return {
        helmet: kit.helmet > 0 ? `helmet0${kit.helmet}` : "",
        chest: kit.vest > 0 ? `chest0${kit.vest}` : "",
        backpack: `backpack0${kit.backpack}`,
    };
}

export interface PracticeSettings {
    /** Your primary gun. */
    primary: string;
    /** Your second gun, or "" for none. */
    secondary: string;
    /** Everything else you spawn with. */
    kit: PracticeKit;
    bots: PracticeBotSettings[];
    /** How dead bots come back. */
    respawnMode: PracticeRespawnMode;
    /** Delay before bots respawn, in tenths of a second. */
    respawnDelay: number;
}

/** The advanced movement values the main wiggle slider sets. */
export function practiceWiggleToAdvanced(wiggle: number): Pick<PracticeBotSettings, "strafe" | "turn" | "dodge"> {
    const w = math.clamp(Math.round(wiggle), 0, PracticeSliderMax);
    return { strafe: w, turn: w, dodge: Math.round(w * 0.6) };
}

export function defaultPracticeBot(): PracticeBotSettings {
    return {
        gun: "mp5",
        secondary: "",
        melee: "fists",
        quickSwitch: true,
        autoMelee: true,
        wiggle: 5,
        ...practiceWiggleToAdvanced(5),
        accuracy: 50,
        reaction: 5,
        shootsBack: true,
        // Same as a fresh survev player: 100 HP, no armor.
        health: 100,
        armor: 0,
    };
}

export function defaultPracticeSettings(): PracticeSettings {
    return {
        primary: "hk416",
        secondary: "",
        kit: defaultPracticeKit(),
        bots: [defaultPracticeBot()],
        respawnMode: "each",
        respawnDelay: Math.round(PracticeBotRespawnDelay * 10),
    };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
    return math.clamp(n, min, max);
}

function sanitizeBot(raw: Partial<PracticeBotSettings> | undefined): PracticeBotSettings {
    const def = defaultPracticeBot();
    const gun = typeof raw?.gun === "string" && (raw.gun === PracticeRandomGun || isPracticeGun(raw.gun))
        ? raw.gun
        : def.gun;
    return {
        gun,
        secondary: typeof raw?.secondary === "string"
                && (raw.secondary === PracticeRandomGun || isPracticeGun(raw.secondary))
            ? raw.secondary
            : "",
        melee: typeof raw?.melee === "string" && PracticeMelees.includes(raw.melee) ? raw.melee : def.melee,
        quickSwitch: typeof raw?.quickSwitch === "boolean" ? raw.quickSwitch : def.quickSwitch,
        autoMelee: typeof raw?.autoMelee === "boolean" ? raw.autoMelee : def.autoMelee,
        wiggle: clampInt(raw?.wiggle, 0, PracticeSliderMax, def.wiggle),
        strafe: clampInt(raw?.strafe, 0, PracticeSliderMax, def.strafe),
        turn: clampInt(raw?.turn, 0, PracticeSliderMax, def.turn),
        dodge: clampInt(raw?.dodge, 0, PracticeSliderMax, def.dodge),
        accuracy: clampInt(raw?.accuracy, 0, 100, def.accuracy),
        reaction: clampInt(raw?.reaction, 0, PracticeMaxReaction, def.reaction),
        shootsBack: typeof raw?.shootsBack === "boolean" ? raw.shootsBack : def.shootsBack,
        health: clampInt(raw?.health, PracticeMinBotHealth, PracticeMaxBotHealth, def.health),
        armor: clampInt(raw?.armor, 0, PracticeMaxArmor, def.armor),
    };
}

function sanitizeKit(raw: Partial<PracticeKit> | undefined): PracticeKit {
    const def = defaultPracticeKit();
    const counts = { ...def.counts };
    for (const item of PracticeKitItems) {
        counts[item] = clampInt(raw?.counts?.[item], 0, PracticeKitMaxCount, 0);
    }
    return {
        melee: typeof raw?.melee === "string" && PracticeMelees.includes(raw.melee) ? raw.melee : def.melee,
        helmet: clampInt(raw?.helmet, 0, PracticeMaxGearLevel, def.helmet),
        vest: clampInt(raw?.vest, 0, PracticeMaxGearLevel, def.vest),
        backpack: clampInt(raw?.backpack, 0, PracticeMaxPackLevel, def.backpack),
        scope: typeof raw?.scope === "string" && (PracticeScopes as readonly string[]).includes(raw.scope)
            ? raw.scope
            : def.scope,
        fillAmmo: typeof raw?.fillAmmo === "boolean" ? raw.fillAmmo : def.fillAmmo,
        counts,
    };
}

/** Clamp every value into range and replace unknown guns with defaults. */
export function sanitizePracticeSettings(raw: Partial<PracticeSettings> | undefined): PracticeSettings {
    const def = defaultPracticeSettings();
    const primary = typeof raw?.primary === "string" && isPracticeGun(raw.primary)
        ? raw.primary
        : def.primary;
    const secondary = typeof raw?.secondary === "string" && isPracticeGun(raw.secondary)
        ? raw.secondary
        : "";
    const rawBots = Array.isArray(raw?.bots) ? raw.bots.slice(0, PracticeMaxBots) : [];
    const bots = rawBots.length ? rawBots.map((b) => sanitizeBot(b)) : def.bots;
    const respawnMode = (PracticeRespawnModes as readonly string[]).includes(raw?.respawnMode as string)
        ? (raw!.respawnMode as PracticeRespawnMode)
        : def.respawnMode;
    return {
        primary,
        secondary,
        kit: sanitizeKit(raw?.kit),
        bots,
        respawnMode,
        respawnDelay: clampInt(raw?.respawnDelay, 0, PracticeMaxRespawnDelay, def.respawnDelay),
    };
}

/* ── Bot tuning: slider values → AI numbers (server) ─────────────────────── */

/** Weight of the sideways component in the bot's movement (0–2). */
export function practiceStrafeWeight(strafe: number): number {
    return math.clamp(strafe, 0, PracticeSliderMax) / 5;
}

/** Overall move speed multiplier; faster strafers also move faster. */
export function practiceSpeedMult(strafe: number): number {
    return 0.55 + math.clamp(strafe, 0, PracticeSliderMax) * 0.05;
}

/** Seconds between strafe direction flips, as [min, max]. 0 = never flips. */
export function practiceFlipInterval(turn: number): [number, number] {
    const t = math.clamp(turn, 0, PracticeSliderMax);
    if (t <= 0) return [1e6, 1e6];
    const max = math.lerp((t - 1) / (PracticeSliderMax - 1), 3.2, 0.35);
    return [max * 0.5, max];
}

/** Chance per second of a juke while you aim at the bot. */
export function practiceDodgePerSecond(dodge: number): number {
    return math.clamp(dodge, 0, PracticeSliderMax) * 0.35;
}

/** Max aim error in degrees: 100 % accuracy = 0°, 0 % = 28°. */
export function practiceAimErrorDeg(accuracy: number): number {
    return (1 - math.clamp(accuracy, 0, 100) / 100) * 28;
}

export function practiceReactionSeconds(reaction: number): number {
    return math.clamp(reaction, 0, PracticeMaxReaction) / 10;
}

/** Helmet + vest for an armor level 0–3. */
export function practiceArmorGear(level: number): { helmet: string; chest: string } {
    const lv = math.clamp(Math.round(level), 0, PracticeMaxArmor);
    if (lv <= 0) return { helmet: "", chest: "" };
    return { helmet: `helmet0${lv}`, chest: `chest0${lv}` };
}

/* ── Stats ───────────────────────────────────────────────────────────────── */

export interface PracticeStats {
    kills: number;
    deaths: number;
    shotsFired: number;
    shotsHit: number;
    damageDealt: number;
    damageTaken: number;
    /** Average time-to-kill in ms (0 = no kills yet). */
    ttkAvgMs: number;
    /** Best time-to-kill in ms (0 = no kills yet). */
    ttkBestMs: number;
    /** Bots alive right now / bots configured. */
    botsAlive: number;
    botsTotal: number;
}

export function emptyPracticeStats(): PracticeStats {
    return {
        kills: 0,
        deaths: 0,
        shotsFired: 0,
        shotsHit: 0,
        damageDealt: 0,
        damageTaken: 0,
        ttkAvgMs: 0,
        ttkBestMs: 0,
        botsAlive: 0,
        botsTotal: 0,
    };
}
