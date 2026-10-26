import { expect, test } from "vitest";
import type { Game } from "../../server/src/game/game.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { practiceInterceptPoint } from "../../server/src/game/practiceCombat.ts";
import { GunDefs } from "../../shared/defs/gameObjects/gunDefs.ts";
import { MapDefs } from "../../shared/defs/mapDefs.ts";
import { isPracticeMapName, PracticeMapPool } from "../../shared/defs/maps/practiceDefs.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { BitStream } from "../../shared/net/net.ts";
import { PracticeGiveMsg, PracticeSettingsMsg, PracticeStatsMsg } from "../../shared/net/practiceMsg.ts";
import {
    defaultPracticeBot,
    defaultPracticeKit,
    defaultPracticeSettings,
    practiceAimErrorDeg,
    PracticeBotRespawnDelay,
    practiceFlipInterval,
    PracticeGuns,
    PracticeMaxBotHealth,
    PracticeMaxBots,
    PracticePlayerRespawnDelay,
    PracticeRandomGun,
    type PracticeSettings,
    practiceWiggleToAdvanced,
    sanitizePracticeSettings,
} from "../../shared/practice.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

function startPractice(settings?: Partial<PracticeSettings>) {
    const game = createGame(TeamMode.Solo, "practice_arena", { endless: false });
    const player = game.playerBarn.addTestPlayer({ name: "Trainee" });
    game.update(0.1);
    const practice = game.specOps!.practice!;
    // Bots hold fire unless a test sets them up, so the player isn't hurt mid-test.
    const applied = practice.applySettings(
        player,
        sanitizePracticeSettings({
            ...defaultPracticeSettings(),
            bots: [{ ...defaultPracticeBot(), shootsBack: false }],
            ...settings,
        }),
    );
    expect(applied).toBe(true);
    // Bots spawn shortly after a setup is applied.
    for (let i = 0; i < 20; i++) game.update(0.1);
    return { game, player, practice };
}

function killPlayer(target: Player, source?: Player) {
    target.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source,
    });
}

function bots(game: Game) {
    return game.specOps!.practiceBotsPublic();
}

/* ── Settings ─────────────────────────────────────────────────────────── */

test("Practice settings are clamped and unknown guns fall back to defaults", () => {
    const clean = sanitizePracticeSettings({
        primary: "not_a_gun",
        secondary: "m9_dual",
        bots: Array.from({ length: 9 }, () => ({
            ...defaultPracticeBot(),
            gun: "nope",
            strafe: 99,
            accuracy: -5,
            health: 9999,
            armor: 7,
        })),
    });
    expect(clean.primary).toBe(defaultPracticeSettings().primary);
    expect(clean.secondary).toBe("");
    expect(clean.bots.length).toBe(PracticeMaxBots);
    expect(clean.bots[0].gun).toBe(defaultPracticeBot().gun);
    expect(clean.bots[0].strafe).toBe(10);
    expect(clean.bots[0].accuracy).toBe(0);
    expect(clean.bots[0].health).toBe(PracticeMaxBotHealth);
    expect(clean.bots[0].armor).toBe(3);
});

test("Practice gun list has no dual pistols or event weapons", () => {
    expect(PracticeGuns.length).toBeGreaterThan(20);
    expect(PracticeGuns).toContain("hk416");
    expect(PracticeGuns.some((g) => g.endsWith("_dual"))).toBe(false);
    expect(PracticeGuns).not.toContain("bugle");
    expect(PracticeGuns).not.toContain("flare_gun");
});

test("Practice wiggle slider sets the advanced movement sliders", () => {
    expect(practiceWiggleToAdvanced(0)).toEqual({ strafe: 0, turn: 0, dodge: 0 });
    expect(practiceWiggleToAdvanced(10)).toEqual({ strafe: 10, turn: 10, dodge: 6 });
    expect(practiceFlipInterval(0)[0]).toBeGreaterThan(1000);
    expect(practiceFlipInterval(10)[1]).toBeLessThan(practiceFlipInterval(1)[1]);
    expect(practiceAimErrorDeg(100)).toBe(0);
    expect(practiceAimErrorDeg(0)).toBeGreaterThan(20);
});

test("Practice settings message round-trips", () => {
    const msg = new PracticeSettingsMsg();
    msg.settings = sanitizePracticeSettings({
        primary: "ak47",
        secondary: "m870",
        kit: {
            ...defaultPracticeKit(),
            melee: "katana",
            helmet: 4,
            vest: 2,
            backpack: 3,
            scope: "8xscope",
            fillAmmo: false,
            counts: { ...defaultPracticeKit().counts, bandage: 12, healthkit: 2, frag: 5, mirv: 1 },
        },
        bots: [
            {
                ...defaultPracticeBot(),
                gun: PracticeRandomGun,
                secondary: PracticeRandomGun,
                melee: "katana",
                quickSwitch: false,
                autoMelee: false,
                accuracy: 87,
                reaction: 13,
                shootsBack: false,
            },
            {
                ...defaultPracticeBot(),
                gun: "mosin",
                secondary: "m870",
                health: 120,
                armor: 3,
                strafe: 9,
                turn: 2,
                dodge: 7,
            },
        ],
        respawnMode: "wave",
        respawnDelay: 42,
    });
    const stream = new BitStream(new ArrayBuffer(256));
    msg.serialize(stream);
    stream.byteIndex = 0;
    const decoded = new PracticeSettingsMsg();
    decoded.deserialize(stream);
    expect(decoded.settings).toEqual(msg.settings);
});

test("Practice stats message round-trips", () => {
    const msg = new PracticeStatsMsg();
    msg.stats = {
        kills: 12,
        deaths: 3,
        shotsFired: 900,
        shotsHit: 410,
        damageDealt: 5230,
        damageTaken: 880,
        ttkAvgMs: 1840,
        ttkBestMs: 610,
        botsAlive: 2,
        botsTotal: 4,
    };
    const stream = new BitStream(new ArrayBuffer(64));
    msg.serialize(stream);
    stream.byteIndex = 0;
    const decoded = new PracticeStatsMsg();
    decoded.deserialize(stream);
    expect(decoded.stats).toEqual(msg.stats);
});

test("Every practice map is registered as a practice-mode Spec Ops map", () => {
    for (const { key } of PracticeMapPool) {
        expect(isPracticeMapName(key)).toBe(true);
        const def = MapDefs[key];
        expect(def.gameMode.practiceMode).toBe(true);
        expect(def.gameMode.specOpsMode).toBe(true);
    }
    expect(isPracticeMapName("specops")).toBe(false);
});

/* ── Match ────────────────────────────────────────────────────────────── */

test("Practice starts with no waves, stations or bots until a setup is applied", () => {
    const game = createGame(TeamMode.Solo, "practice_arena", { endless: false });
    const player = game.playerBarn.addTestPlayer({ name: "Trainee" });
    game.update(0.1);
    for (let i = 0; i < 30; i++) game.update(0.1);

    expect(game.specOps!.practice).toBeDefined();
    expect(game.specOps!.wave).toBe(0);
    expect(bots(game).length).toBe(0);
    expect(game.map.obstacles.some((o) => o.type.startsWith("specops_station_"))).toBe(false);
    expect(game.browsable).toBe(false);
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe(defaultPracticeSettings().primary);
    expect(game.specOps!.tryStartWaveEarly(player)).toBe(false);
});

test("Practice spawns each configured bot with its settings", () => {
    const { game } = startPractice({
        bots: [
            { ...defaultPracticeBot(), gun: "mosin", health: 120, armor: 3, accuracy: 100, shootsBack: false },
            { ...defaultPracticeBot(), gun: "mp5", strafe: 0, turn: 0, dodge: 0 },
        ],
    });
    const live = bots(game);
    expect(live.length).toBe(2);

    const sniper = live.find((b) => b.weapons[GameConfig.WeaponSlot.Primary].type === "mosin")!;
    expect(sniper).toBeDefined();
    expect(sniper.health).toBe(120);
    expect(sniper.helmet).toBe("helmet03");
    expect(sniper.chest).toBe("chest03");
    const sniperTuning = game.specOps!.practiceTuningPublic(sniper)!;
    expect(sniperTuning.holdFire).toBe(true);
    expect(sniperTuning.aimErrorDeg).toBe(0);

    const smg = live.find((b) => b.weapons[GameConfig.WeaponSlot.Primary].type === "mp5")!;
    expect(smg).toBeDefined();
    expect(Math.abs(game.specOps!.getBrainPublic(smg)!.strafeSign)).toBe(0);
});

test("Practice bots that hold fire never shoot", () => {
    const { game, player } = startPractice({
        bots: [{ ...defaultPracticeBot(), shootsBack: false, accuracy: 100 }],
    });
    const bot = bots(game)[0];
    v2.set(bot.pos, v2.add(player.pos, v2.create(8, 0)));
    for (let i = 0; i < 40; i++) {
        game.update(0.05);
        expect(bot.shootHold).toBe(false);
    }
});

test("Practice bot respawns after it dies and the kill is counted", () => {
    const { game, player, practice } = startPractice();
    const bot = bots(game)[0];
    killPlayer(bot, player);
    expect(bot.dead).toBe(true);
    game.update(0.05);
    expect(practice.statsFor(player).kills).toBe(1);
    expect(bots(game).length).toBe(0);

    for (let t = 0; t < PracticeBotRespawnDelay + 0.5; t += 0.1) game.update(0.1);
    expect(bots(game).length).toBe(1);
    expect(bots(game)[0]).not.toBe(bot);
});

test("Practice player respawns with their chosen guns instead of ending the match", () => {
    const { game, player, practice } = startPractice({ primary: "mp5", secondary: "" });
    const bot = bots(game)[0];

    killPlayer(player, bot);
    expect(player.dead).toBe(true);
    game.update(0.05);
    expect(game.over).toBe(false);
    expect(practice.statsFor(player).deaths).toBe(1);

    // Pick a new loadout while dead: bots stay, guns apply on respawn.
    for (let i = 0; i < 6; i++) game.update(0.1);
    const changed = practice.applySettings(
        player,
        sanitizePracticeSettings({ ...practice.settings, primary: "m870", secondary: "deagle" }),
    );
    expect(changed).toBe(true);
    game.update(0.05);
    expect(bots(game)[0]).toBe(bot);

    for (let t = 0; t < PracticePlayerRespawnDelay + 0.5; t += 0.1) game.update(0.1);
    expect(player.dead).toBe(false);
    expect(game.over).toBe(false);
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m870");
    expect(player.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("deagle");
    expect(game.playerBarn.livingPlayers).toContain(player);
});

test("Practice replaces bots when their settings change", () => {
    const { game, player, practice } = startPractice();
    const first = bots(game)[0];
    for (let i = 0; i < 5; i++) game.update(0.1);

    practice.applySettings(
        player,
        sanitizePracticeSettings({
            ...practice.settings,
            bots: [defaultPracticeBot(), defaultPracticeBot(), defaultPracticeBot()],
        }),
    );
    for (let i = 0; i < 20; i++) game.update(0.1);
    const live = bots(game);
    expect(live.length).toBe(3);
    expect(live).not.toContain(first);
});

test("Practice counts shots, hits and damage", () => {
    const { game, player, practice } = startPractice({
        bots: [{ ...defaultPracticeBot(), shootsBack: false }],
    });
    const bot = bots(game)[0];
    practice.onShotFired(player);
    practice.onShotFired(player);
    bot.damage({
        amount: 20,
        damageType: GameConfig.DamageType.Player,
        gameSourceType: "mp5",
        dir: v2.create(1, 0),
        source: player,
    });
    const st = practice.statsFor(player);
    expect(st.shotsFired).toBe(2);
    expect(st.shotsHit).toBe(1);
    expect(st.damageDealt).toBeGreaterThan(0);
});

test("Practice ignores settings spam", () => {
    const { player, practice } = startPractice();
    // startPractice applied once a moment ago; an immediate second apply is dropped.
    const settings = sanitizePracticeSettings(defaultPracticeSettings());
    practice.applySettings(player, settings);
    expect(practice.applySettings(player, settings)).toBe(false);
});

test("Practice give message round-trips", () => {
    const msg = new PracticeGiveMsg();
    msg.item = "helmet03";
    msg.count = 7;
    msg.clearInventory = true;
    msg.respawnBots = true;
    const stream = new BitStream(new ArrayBuffer(32));
    msg.serialize(stream);
    stream.byteIndex = 0;
    const decoded = new PracticeGiveMsg();
    decoded.deserialize(stream);
    expect(decoded.item).toBe("helmet03");
    expect(decoded.count).toBe(7);
    expect(decoded.clearInventory).toBe(true);
    expect(decoded.respawnBots).toBe(true);
});

/* ── Survev rules and the spawn kit ───────────────────────────────────── */

test("Practice player plays by survev rules: 100 HP, no blue armor, survev mags", () => {
    const { player } = startPractice({ primary: "m249" });
    expect(player.maxHealth).toBe(GameConfig.player.health);
    expect(player.health).toBe(GameConfig.player.health);
    expect(player.specOpsArmor).toBe(0);
    expect(player.specOpsHumanRules).toBe(false);
    expect(player.hasPerk("endless_ammo")).toBe(false);
    // Spec Ops gives the M249 a 120-round box; survev is 100.
    const m249 = player.weaponManager.getAmmoStats(GunDefs.m249, "m249");
    expect(m249.maxClip).toBe(GunDefs.m249.maxClip);
    // Survev bag: no backpack holds 90 rounds of 5.56.
    expect(player.invManager.getMaxCapacity("556mm")).toBe(GameConfig.bagSizes["556mm"][0]);
});

test("Spec Ops operators keep Spec Ops rules", () => {
    const game = createGame(TeamMode.Solo, "test_specops", { endless: false });
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(player.specOpsHumanRules).toBe(true);
    expect(player.maxHealth).toBeGreaterThan(GameConfig.player.health);
});

test("Practice spawn kit gives exactly the chosen gear and items", () => {
    const { player } = startPractice({
        primary: "mp5",
        secondary: "m870",
        kit: {
            ...defaultPracticeKit(),
            melee: "katana",
            helmet: 2,
            vest: 3,
            backpack: 1,
            scope: "4xscope",
            counts: { ...defaultPracticeKit().counts, bandage: 7, healthkit: 1, frag: 2 },
        },
    });
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe("mp5");
    expect(player.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("m870");
    expect(player.weapons[GameConfig.WeaponSlot.Melee].type).toBe("katana");
    expect(player.helmet).toBe("helmet02");
    expect(player.chest).toBe("chest03");
    expect(player.backpack).toBe("backpack01");
    expect(player.invManager.get("4xscope")).toBe(1);
    expect(player.invManager.get("bandage")).toBe(7);
    expect(player.invManager.get("healthkit")).toBe(1);
    expect(player.invManager.get("frag")).toBe(2);
    expect(player.invManager.get("smoke")).toBe(0);
    // Full ammo = what a level-1 pack holds.
    expect(player.invManager.get("9mm")).toBe(player.invManager.getMaxCapacity("9mm"));
});

test("Practice kit counts are capped by the backpack like survev", () => {
    const { player } = startPractice({
        kit: { ...defaultPracticeKit(), backpack: 0, counts: { ...defaultPracticeKit().counts, bandage: 99 } },
    });
    expect(player.invManager.get("bandage")).toBe(GameConfig.bagSizes.bandage[0]);
});

test("Practice spawns items on the ground and changes inventory only on pickup", () => {
    const { game, player } = startPractice({ primary: "mp5" });
    const specOps = game.specOps!;

    specOps.givePracticeItem(player, "chest03", 1, false);
    specOps.givePracticeItem(player, "awc", 1, false);
    specOps.givePracticeItem(player, "healthkit", 1, false);
    expect(player.chest).toBe("");
    expect(player.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("");
    expect(player.invManager.get("healthkit")).toBe(0);
    for (const type of ["chest03", "awc", "healthkit"]) {
        const loot = game.lootBarn.loots.find((l) => l.type === type && !l.destroyed)!;
        expect(loot).toBeDefined();
        expect(loot.layer).toBe(player.layer);
        expect(v2.distance(loot.pos, player.pos)).toBeGreaterThan(2.5);
        game.update(0.25); // Respect the normal pickup cooldown between items.
        player.pickupLoot(loot);
    }
    expect(player.chest).toBe("chest03");
    expect(player.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("awc");
    expect(player.invManager.get("healthkit")).toBe(1);

    specOps.givePracticeItem(player, "", 1, true);
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe("");
    expect(player.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("");
    expect(player.weapons[GameConfig.WeaponSlot.Melee].type).toBe("fists");
    expect(player.chest).toBe("");
    expect(player.invManager.get("healthkit")).toBe(0);
    expect(player.invManager.get("1xscope")).toBe(1);
});

test("Practice changing only bots keeps items you gave yourself", () => {
    const { game, player, practice } = startPractice({ primary: "mp5" });
    game.specOps!.givePracticeItem(player, "helmet03", 1, false);
    player.pickupLoot(game.lootBarn.loots.find((l) => l.type === "helmet03" && !l.destroyed)!);
    for (let i = 0; i < 5; i++) game.update(0.1);
    practice.applySettings(
        player,
        sanitizePracticeSettings({ ...practice.settings, bots: [defaultPracticeBot(), defaultPracticeBot()] }),
    );
    expect(player.helmet).toBe("helmet03");
});

/* ── Bot respawn modes ────────────────────────────────────────────────── */

function runFor(game: Game, seconds: number) {
    for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

test("Practice respawn delay is configurable", () => {
    const { game, player } = startPractice({ respawnMode: "each", respawnDelay: 50 });
    killPlayer(bots(game)[0], player);
    runFor(game, 3);
    expect(bots(game).length).toBe(0);
    runFor(game, 2.5);
    expect(bots(game).length).toBe(1);
});

test("Practice respawn off: dead bots stay down until Respawn bots now", () => {
    const { game, player, practice } = startPractice({ respawnMode: "off", respawnDelay: 5 });
    killPlayer(bots(game)[0], player);
    runFor(game, 5);
    expect(bots(game).length).toBe(0);
    expect(game.over).toBe(false);

    practice.respawnBotsNow();
    runFor(game, 1);
    expect(bots(game).length).toBe(1);
});

test("Practice respawn wave: bots come back together once all are down", () => {
    const quiet = { ...defaultPracticeBot(), shootsBack: false };
    const { game, player } = startPractice({ respawnMode: "wave", respawnDelay: 10, bots: [quiet, quiet] });
    expect(bots(game).length).toBe(2);

    killPlayer(bots(game)[0], player);
    runFor(game, 3);
    expect(bots(game).length).toBe(1);

    killPlayer(bots(game)[0], player);
    game.update(0.05);
    expect(bots(game).length).toBe(0);
    runFor(game, 2);
    expect(bots(game).length).toBe(2);
});

test("Practice switching respawn mode keeps living bots", () => {
    const { game, player, practice } = startPractice({ respawnMode: "each" });
    const bot = bots(game)[0];
    runFor(game, 0.5);
    practice.applySettings(player, sanitizePracticeSettings({ ...practice.settings, respawnMode: "off" }));
    game.update(0.05);
    expect(bots(game)[0]).toBe(bot);
});

/* ── Practice combat and pickups ─────────────────────────────────────── */

test("Practice reads old saved bot settings and rejects invalid extra weapons", () => {
    const raw = { ...defaultPracticeBot(), secondary: "invalid", melee: "invalid" };
    const clean = sanitizePracticeSettings({ bots: [raw] });
    expect(clean.bots[0].secondary).toBe("");
    expect(clean.bots[0].melee).toBe("fists");
    const old = sanitizePracticeSettings({ bots: [{ gun: "mosin" } as ReturnType<typeof defaultPracticeBot>] });
    expect(old.bots[0].quickSwitch).toBe(true);
    expect(old.bots[0].autoMelee).toBe(true);
    expect(old.bots[0].secondary).toBe("");
});

test("Practice bots retain both guns, including two copies of the same gun", () => {
    const { game } = startPractice({
        bots: [
            { ...defaultPracticeBot(), gun: "mosin", secondary: "spas12", melee: "katana", shootsBack: false },
            { ...defaultPracticeBot(), gun: "m870", secondary: "m870", shootsBack: false },
        ],
    });
    const [first, second] = bots(game);
    expect(first.weapons[0].type).toBe("mosin");
    expect(first.weapons[1].type).toBe("spas12");
    expect(first.weapons[2].type).toBe("katana");
    expect(second.weapons[0].type).toBe("m870");
    expect(second.weapons[1].type).toBe("m870");
    expect(first.weapons[1].ammo).toBeGreaterThan(0);
});

test("Practice interception leads moving targets according to projectile speed", () => {
    const origin = v2.create(0, 0);
    const target = v2.create(30, 0);
    const velocity = v2.create(0, 10);
    const point = practiceInterceptPoint(origin, target, velocity, 60, 2);
    const time = point.y / velocity.y;
    expect(point.y).toBeGreaterThan(0);
    expect(v2.distance(point, origin)).toBeCloseTo(60 * time + 2, 6);
    const faster = practiceInterceptPoint(origin, target, velocity, 120, 2);
    expect(faster.y).toBeLessThan(point.y);
    expect(practiceInterceptPoint(origin, target, v2.create(0, 0), 60)).toEqual(target);
    expect(practiceInterceptPoint(origin, target, velocity, 0)).toEqual(target);
    // No future interception: fall back to direct aim rather than NaN or backwards lead.
    expect(practiceInterceptPoint(origin, target, v2.create(100, 0), 60)).toEqual(target);
});

function combatScenario(overrides: Partial<ReturnType<typeof defaultPracticeBot>>) {
    const { game, player } = startPractice({
        bots: [{
            ...defaultPracticeBot(),
            gun: "mosin",
            accuracy: 100,
            reaction: 0,
            strafe: 0,
            turn: 0,
            dodge: 0,
            shootsBack: false,
            ...overrides,
        }],
    });
    const bot = bots(game)[0];
    v2.set(bot.pos, v2.create(30, 30));
    v2.set(player.pos, v2.create(60, 30));
    v2.set(bot.moveVel, v2.create(0, 0));
    v2.set(player.moveVel, v2.create(0, 0));
    game.grid.updateObject(bot);
    game.grid.updateObject(player);
    bot.weaponManager.setCurWeapIndex(0);
    bot.weapons[0].cooldown = 0;
    bot.freeSwitchTimer = -1;
    return { game, player, bot, combat: game.specOps!.getBrainPublic(bot)!.practiceCombat! };
}

test("Practice quick switch follows an actual shot and respects native equip delay", () => {
    const { bot, player, combat } = combatScenario({ secondary: "spas12" });
    combat.update(0.01, player, true);
    expect(bot.curWeapIdx).toBe(0);
    bot.weaponManager.fireWeapon(false);
    const remaining = bot.weapons[0].cooldown;
    combat.update(0.01, player, true);
    expect(bot.curWeapIdx).toBe(1);
    expect(bot.weapons[1].cooldown).toBe(GameConfig.player.baseSwitchDelay);
    expect(bot.weapons[1].cooldown).toBeGreaterThan(0);
    expect(bot.weapons[1].cooldown).toBeLessThan(remaining);
});

test("Practice single-sniper holster cycle shortens recovery without erasing switch delay", () => {
    const { bot, player, combat } = combatScenario({});
    bot.weaponManager.fireWeapon(false);
    combat.update(0.01, player, true);
    expect(bot.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
    combat.fire(true);
    expect(bot.shootStart).toBe(false);
    combat.update(0.01, player, true);
    expect(bot.curWeapIdx).toBe(0);
    expect(bot.weapons[0].cooldown).toBe(GunDefs.mosin.switchDelay);
    expect(bot.weapons[0].cooldown).toBeLessThan(GunDefs.mosin.fireDelay);
});

test("Practice quick switching produces earlier real shots than holding the sniper", () => {
    const intervals = (quickSwitch: boolean) => {
        const { bot, player, combat } = combatScenario({ quickSwitch });
        const shots: number[] = [];
        for (let tick = 0; tick < 310; tick++) {
            combat.update(0.01, player, true);
            combat.fire(true);
            const before = bot.weapons[0].ammo;
            bot.weaponManager.update(0.01);
            if (bot.weapons[0].ammo < before) shots.push(tick * 0.01);
        }
        expect(shots.length).toBeGreaterThanOrEqual(2);
        return shots[1] - shots[0];
    };
    const normal = intervals(false);
    const quick = intervals(true);
    expect(normal).toBeGreaterThanOrEqual(GunDefs.mosin.fireDelay - 0.02);
    expect(quick).toBeGreaterThanOrEqual(GunDefs.mosin.switchDelay);
    expect(quick).toBeLessThan(normal - 0.3);
});

test("Practice can disable quick switch and preserves same-deploy shotgun delays", () => {
    const disabled = combatScenario({ secondary: "spas12", quickSwitch: false });
    disabled.bot.weaponManager.fireWeapon(false);
    disabled.combat.update(0.01, disabled.player, true);
    expect(disabled.bot.curWeapIdx).toBe(0);
    const shotguns = combatScenario({ gun: "m870", secondary: "spas12" });
    shotguns.bot.weaponManager.fireWeapon(false);
    shotguns.combat.update(0.01, shotguns.player, true);
    expect(shotguns.bot.curWeapIdx).toBe(1);
    expect(shotguns.bot.weapons[1].cooldown).toBe(GunDefs.spas12.switchDelay);
});

test("Practice auto melee uses the selected weapon and returns to guns out of range", () => {
    const { game, bot, player, combat } = combatScenario({ melee: "katana" });
    v2.set(player.pos, v2.add(bot.pos, v2.create(2, 0)));
    game.grid.updateObject(player);
    combat.update(0.01, player, true);
    expect(combat.meleeEngaged).toBe(true);
    expect(bot.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
    // Equal movement must not introduce an extra lead error during the swing.
    v2.set(bot.moveVel, v2.create(0, 8));
    v2.set(player.moveVel, v2.create(0, 8));
    expect(combat.aimPoint(player)).toEqual(player.pos);
    combat.fire(true);
    expect(bot.shootStart).toBe(true);
    v2.set(player.pos, v2.add(bot.pos, v2.create(30, 0)));
    game.grid.updateObject(player);
    combat.update(0.01, player, true);
    expect(combat.meleeEngaged).toBe(false);
    expect(bot.curWeapIdx).toBe(0);
    const disabled = combatScenario({ autoMelee: false });
    v2.set(disabled.player.pos, v2.add(disabled.bot.pos, v2.create(2, 0)));
    disabled.combat.update(0.01, disabled.player, true);
    expect(disabled.bot.curWeapIdx).toBe(0);
});

test("Practice bots switch to the loaded gun instead of reloading an empty one", () => {
    const { bot, player, combat } = combatScenario({ secondary: "mp5" });
    bot.weapons[0].ammo = 0;
    combat.update(0.01, player, true);
    expect(bot.curWeapIdx).toBe(1);
    expect(bot.weapons[1].ammo).toBeGreaterThan(0);
});

test("Practice preserves a melee swing until its normal delayed damage lands", () => {
    const { game, bot, player, combat } = combatScenario({ melee: "katana" });
    v2.set(bot.dir, v2.create(1, 0));
    v2.set(player.pos, v2.add(bot.pos, v2.create(2, 0)));
    game.grid.updateObject(player);
    combat.update(0.01, player, true);
    bot.weapons[GameConfig.WeaponSlot.Melee].cooldown = -0.01;
    combat.fire(true);
    bot.weaponManager.update(0.01);
    expect(bot.weaponManager.meleeAttacks.length).toBeGreaterThan(0);
    const health = player.health;
    combat.update(0.01, player, false);
    expect(bot.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
    combat.fire(false);
    bot.weaponManager.update(0.5);
    expect(player.health).toBeLessThan(health);
    expect(bot.weaponManager.meleeAttacks).toHaveLength(0);
});

test("Practice perk pickups grant perks only when picked up", () => {
    const { game, player } = startPractice();
    game.specOps!.givePracticeItem(player, "small_arms", 999, false);
    expect(player.hasPerk("small_arms")).toBe(false);
    const loot = game.lootBarn.loots.find((l) => l.type === "small_arms" && !l.destroyed)!;
    expect(loot).toBeDefined();
    expect(loot.count).toBe(1);
    player.pickupLoot(loot);
    expect(player.hasPerk("small_arms")).toBe(true);
});

test("Practice spawning rejects invalid items and never runs outside practice", () => {
    const { game, player } = startPractice();
    const count = game.lootBarn.loots.length;
    game.specOps!.givePracticeItem(player, "not_an_item", 1, false);
    expect(game.lootBarn.loots.length).toBe(count);
    const regular = createGame(TeamMode.Solo, "test_specops");
    const human = regular.playerBarn.addTestPlayer({});
    const before = regular.lootBarn.loots.length;
    regular.specOps!.givePracticeItem(human, "awc", 1, true);
    expect(regular.lootBarn.loots.length).toBe(before);
});
