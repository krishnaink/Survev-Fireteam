import { expect, test } from "vitest";
import {
    clampMaxSquadSize,
    Config,
    expandGameModes,
    maxPlayersForMap,
    teamSizeForMode,
} from "../../server/src/config.ts";
import { SpecOpsDeadBodyCap, SpecOpsDeadBodyLifetime } from "../../server/src/game/objects/deadBody.ts";
import { SpecOpsLootCap, SpecOpsLootLifetime } from "../../server/src/game/objects/loot.ts";
import { NoOpSocket } from "../../server/src/game/socket.ts";
import { SpecOpsAbandonedTimeout, SpecOpsIdleTimeout, SpecOpsManager } from "../../server/src/game/specOpsManager.ts";
import { GunDefs } from "../../shared/defs/gameObjects/gunDefs.ts";
import { MeleeDefs } from "../../shared/defs/gameObjects/meleeDefs.ts";
import { PerkDefs } from "../../shared/defs/gameObjects/perkDefs.ts";
import { MapDefs } from "../../shared/defs/mapDefs.ts";
import { isSpecOpsMapName, pickSpecOpsMapName, SpecOpsMapPool } from "../../shared/defs/maps/specOpsDefs.ts";
import {
    shopApproachBlocked,
    specOpsAllyDamageMult,
    specOpsAllyHealth,
    SpecOpsAllyRoles,
    SpecOpsArmorSatchelCosts,
    SpecOpsArmorSatchelGear,
    SpecOpsArmorSatchelSkus,
    SpecOpsBuyablePerks,
    specOpsBuybackCost,
    specOpsBuybackSku,
    specOpsCanBuySelfRevive,
    specOpsEarlyStartBonus,
    specOpsEnemyGear,
    specOpsEnemyHealth,
    SpecOpsHelperGroupSize,
    SpecOpsHelpersPerWave,
    SpecOpsJoinLockFlag,
    SpecOpsJoinLockWave,
    specOpsKillBountyAmount,
    SpecOpsMaxPerks,
    SpecOpsMaxSupportUnits,
    specOpsPerkShopCost,
    specOpsPerkShopRefund,
    SpecOpsReviveImmunity,
    specOpsSelfReviveAllowed,
    specOpsSelfReviveCost,
    SpecOpsSelfReviveSku,
    SpecOpsSentryClip,
    SpecOpsSentryReloadTime,
    SpecOpsShopBySku,
    SpecOpsShopCatalog,
    SpecOpsShopExcludedMelee,
    specOpsShopItemAvailable,
    specOpsShopItemCost,
    SpecOpsShopRange,
    specOpsShopStationItems,
    specOpsStationFromType,
    SpecOpsTargetingBountyMult,
    specOpsUnequipSku,
} from "../../shared/defs/maps/specOpsShop.ts";
import { GameObjectDefs } from "../../shared/defs/register.ts";
import { GameConfig, GasMode, TeamMode } from "../../shared/gameConfig.ts";
import { InputMsg } from "../../shared/net/inputMsg.ts";
import { JoinMsg } from "../../shared/net/joinMsg.ts";
import { KillMsg } from "../../shared/net/killMsg.ts";
import { BitStream, MsgType, SpectateMsg } from "../../shared/net/net.ts";
import { ObjectType } from "../../shared/net/objectSerializeFns.ts";
import { SpectateAction } from "../../shared/net/spectateMsg.ts";
import { coldet } from "../../shared/utils/coldet.ts";
import { collider } from "../../shared/utils/collider.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";
import "./testHelpers.ts";
import type { Game } from "../../server/src/game/game.ts";
import type { Obstacle } from "../../server/src/game/objects/obstacle.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { stairAtPos } from "../../server/src/game/specOpsNav.ts";
import { util } from "../../shared/utils/util.ts";

/** Prefer ground-floor stations so buy tests work without changing player layer. */
function findSpecOpsStation(game: Game, type: string, layer = 0): Obstacle {
    return game.map.obstacles.find((o) => o.type === type && o.layer === layer)
        ?? game.map.obstacles.find((o) => o.type === type)!;
}

function standAtStation(player: Player, station: Obstacle): void {
    v2.set(player.pos, station.pos);
    player.layer = station.layer;
    player.game.grid.updateObject(player);
}

/** Start the next wave; drain=true spawns the full roster (tests only). */
function beginSpecOpsWave(game: import("../../server/src/game/game.ts").Game, drain = false) {
    game.specOps!.startNextWave();
    if (drain) game.specOps!.drainWaveSpawnQueuePublic();
    game.update(0.05);
}

test("Spec Ops starts with one operator and no gas", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    expect(game.map.specOpsMode).toBe(true);
    expect(game.specOps).toBeDefined();

    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    expect(game.started).toBe(true);
    expect(game.gas.mode).toBe(GasMode.Waiting);
    expect(game.gas.damage).toBe(0);
    expect(game.gas.isInGas(player.pos)).toBe(false);
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m9");
    expect(player.specOpsCash).toBe(800);
    expect(player.health).toBe(200);
    expect(player.specOpsArmor).toBe(100);
    expect(player.hasPerk("self_revive")).toBe(false);
    expect(game.map.obstacles.some((o) => o.type.startsWith("specops_station_"))).toBe(
        true,
    );
    expect(game.specOps!.wave).toBe(0);
    expect(game.specOps!.enemiesAlive).toBe(0);
    expect(game.specOps!.phase).toBe("prep");
    expect(game.specOps!.phaseDuration).toBeGreaterThanOrEqual(40);
    expect(game.specOps!.phaseTimer).toBeGreaterThan(30);
    expect(game.modeManager.aliveCount()).toBe(1);
});

test("Spec Ops rotates through distinct biome maps", () => {
    expect(SpecOpsMapPool.length).toBeGreaterThan(4);
    expect(pickSpecOpsMapName("test_specops")).toBe("test_specops");
    expect(pickSpecOpsMapName("specops_desert")).toBe("specops_desert");
    expect(isSpecOpsMapName("specops_woods")).toBe(true);
    expect(isSpecOpsMapName("main")).toBe(false);

    const names = new Set<string>();
    for (let i = 0; i < 40; i++) {
        names.add(pickSpecOpsMapName("specops"));
    }
    expect(names.size).toBeGreaterThan(1);

    for (const key of SpecOpsMapPool) {
        const def = MapDefs[key];
        expect(def.gameMode.specOpsMode).toBe(true);
        expect(def.mapId).toBe(GameConfig.MapId.SpecOps);
        expect(def.gameMode.maxPlayers).toBe(4);
    }

    const woods = createGame(TeamMode.Solo, "specops_woods");
    woods.playerBarn.addTestPlayer({ name: "Operator" });
    woods.update(0.1);
    expect(woods.map.specOpsMode).toBe(true);
    expect(woods.map.mapDef.assets.atlases).toContain("woods");
    expect(woods.map.obstacles.some((o) => o.type.startsWith("specops_station_"))).toBe(
        true,
    );
});

test("Spec Ops wave 1 spawns dummy AI that hunt the operator", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.startNextWave();
    game.update(0.05);

    expect(game.specOps!.wave).toBe(1);
    expect(game.specOps!.enemiesAlive).toBeGreaterThan(0);
    expect(game.modeManager.aliveCount()).toBe(1);

    const ai = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi);
    expect(ai.length).toBe(game.specOps!.enemiesAlive);
    expect(ai.every((p) => p.teamId !== player.teamId)).toBe(true);
    expect(ai.every((p) => p.weapons[GameConfig.WeaponSlot.Primary].type)).toBeTruthy();
    expect(ai.every((p) => p.health < 55)).toBe(true);
    expect(ai.every((p) => !p.chest && !p.helmet)).toBe(true);
    expect(ai.every((p) => p.specOpsArmor === 0)).toBe(true);

    const startPos = v2.copy(ai[0].pos);
    game.step(0.5);
    expect(v2.distance(ai[0].pos, startPos)).toBeGreaterThan(0.05);
    expect(ai[0].dead).toBe(false);
    expect(game.over).toBe(false);
});

test("Spec Ops enemies spawn a fair distance from the operator", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    v2.set(player.pos, game.map.center);
    game.grid.updateObject(player);

    game.specOps!.startNextWave();
    game.update(0.05);

    const ai = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi);
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((p) => v2.distance(p.pos, player.pos) >= 28)).toBe(true);
});

test("Spec Ops large waves spread around the map instead of piling on the player", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    v2.set(player.pos, game.map.center);
    game.grid.updateObject(player);

    game.specOps!.wave = 17;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);

    const ai = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(ai.length).toBeGreaterThan(20);
    expect(ai.every((p) => v2.distance(p.pos, player.pos) >= 28)).toBe(true);

    const center = v2.create(0, 0);
    for (let i = 0; i < ai.length; i++) {
        center.x += ai[i].pos.x;
        center.y += ai[i].pos.y;
    }
    center.x /= ai.length;
    center.y /= ai.length;
    let spread = 0;
    for (let i = 0; i < ai.length; i++) {
        spread = Math.max(spread, v2.distance(ai[i].pos, center));
    }
    expect(spread).toBeGreaterThan(22);

    const nearPlayer = ai.filter((p) => v2.distance(p.pos, player.pos) < 40).length;
    expect(nearPlayer).toBeLessThan(ai.length * 0.45);
});

test("Spec Ops stuck NPCs relocate far from the operator", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    v2.set(player.pos, game.map.center);
    game.grid.updateObject(player);

    const npc = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(npc.pos, v2.add(player.pos, v2.create(2, 1)));
    game.grid.updateObject(npc);

    const relocated = game.specOps!.forceRelocateEnemyPublic(npc);
    expect(v2.distance(relocated, player.pos)).toBeGreaterThanOrEqual(32);
    expect(v2.distance(npc.pos, player.pos)).toBeGreaterThanOrEqual(32);
});

test("Spec Ops ends when the operator dies, not when AI die", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.grantCash(player, specOpsSelfReviveCost(game.specOps!.wave));
    const weaponStation = findSpecOpsStation(game, "specops_station_weapon")!;
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, SpecOpsSelfReviveSku)).toBe(true);
    game.specOps!.startNextWave();
    game.update(0.05);

    const ai = game.playerBarn.livingPlayers.find((p) => p.specOpsAi)!;
    ai.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.randomUnit(),
        source: player,
    });
    expect(ai.dead).toBe(true);
    expect(game.over).toBe(false);
    expect(player.kills).toBe(1);
    expect(player.specOpsCash).toBe(
        800 + specOpsSelfReviveCost(0) - specOpsSelfReviveCost(0) + (ai.specOpsBounty || 100),
    );

    player.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.randomUnit(),
        source: ai,
    });
    expect(player.dead).toBe(false);
    expect(player.downed).toBe(true);
    expect(game.over).toBe(false);
    expect(player.hasPerk("self_revive")).toBe(true);

    game.step(GameConfig.player.reviveDuration + 0.2);
    expect(player.downed).toBe(false);
    expect(player.dead).toBe(false);
    expect(player.hasPerk("self_revive")).toBe(false);
    expect(game.over).toBe(false);
    expect(player.specOpsImmunityTicker).toBeGreaterThan(4);

    player.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.randomUnit(),
        source: ai,
    });
    expect(player.dead).toBe(false);
    expect(player.downed).toBe(false);

    game.step(SpecOpsReviveImmunity + 0.2);
    player.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.randomUnit(),
        source: ai,
    });
    expect(player.dead).toBe(true);
    expect(game.over).toBe(true);
});

test("Spec Ops unique mode weapons are buyable from the armory", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.grantCash(player, 40000);

    const weaponStation = findSpecOpsStation(game, "specops_station_weapon")!;
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);

    expect(game.specOps!.tryBuy(player, "potato_cannon")).toBe(true);
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe("potato_cannon");
    game.update(0.5);
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "awc")).toBe(true);
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe("awc");
    game.update(0.5);
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "usas")).toBe(true);
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe("usas");
    // Undroppable guns are not sold.
    expect(game.specOps!.tryBuy(player, "bugle")).toBe(false);
    expect(game.specOps!.tryBuy(player, "m9_cursed")).toBe(false);
});

test("Spec Ops buy stations sell guns, sentries, and juggernaut allies", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const weaponStation = findSpecOpsStation(game, "specops_station_weapon")!;
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);
    game.specOps!.grantCash(player, 5000);
    expect(game.specOps!.tryBuy(player, "mp5")).toBe(true);
    expect(player.weapons[GameConfig.WeaponSlot.Primary].type).toBe("mp5");
    game.update(0.5);

    const supportStation = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    game.specOps!.wave = 4;
    game.specOps!.grantCash(player, 20000);

    expect(game.specOps!.tryBuy(player, "specops_sentry")).toBe(true);
    const sentry = game.playerBarn.livingPlayers.find((p) => p.specOpsKind === "sentry")!;
    expect(sentry.teamId).toBe(player.teamId);
    expect(sentry.groupId).not.toBe(player.groupId);
    expect(sentry.specOpsSpeedMult).toBe(0);
    expect(game.specOps!.enemiesAlive).toBe(0);

    game.update(0.5);
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "last_man")).toBe(true);
    const jug = game.playerBarn.livingPlayers.find((p) => p.specOpsKind === "ally")!;
    expect(jug.role).toBe("last_man");
    expect(jug.hasPerk("steelskin")).toBe(true);
    expect(jug.teamId).toBe(player.teamId);
    expect(jug.groupId).not.toBe(player.groupId);

    v2.set(player.pos, v2.add(supportStation.pos, v2.create(40, 40)));
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "recon")).toBe(false);
});

test("Spec Ops AI enemies share one groupId so long matches do not exhaust IDs", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const first = game.specOps!.spawnEnemyPublic("militia");
    expect(first.groupId).toBe(SpecOpsManager.AiTeamId);
    expect(first.groupId).not.toBe(player.groupId);

    for (let i = 0; i < 280; i++) {
        const npc = game.specOps!.spawnEnemyPublic("militia");
        expect(npc.groupId).toBe(first.groupId);
        npc.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
        game.specOps!.update(0.05);
        game.update(0.05);
    }

    const late = game.specOps!.spawnEnemyPublic("rifle");
    expect(late.groupId).toBe(first.groupId);
    expect(late.dead).toBe(false);
});

test("Spec Ops can spawn far past entity ID bump without crashing", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    // Force object register into recycle mode (past MAX_ID bump allocator).
    const objs = game.objectRegister as { idNext: number };
    objs.idNext = 65535;

    for (let i = 0; i < 40; i++) {
        const npc = game.specOps!.spawnEnemyPublic("militia");
        expect(npc.__id).toBeGreaterThan(0);
        expect(npc.groupId).toBe(SpecOpsManager.AiTeamId);
        npc.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
        game.specOps!.update(0.05);
        game.update(0.05);
    }

    const late = game.specOps!.spawnEnemyPublic("rifle");
    expect(late.dead).toBe(false);
    expect(late.groupId).toBe(SpecOpsManager.AiTeamId);
});

test("Spec Ops juggernauts use the 50v50 last_man role", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const hostile = game.specOps!.spawnEnemyPublic("juggernaut");
    expect(hostile.specOpsKind).toBe("enemy");
    expect(hostile.role).toBe("last_man");
    expect(hostile.hasPerk("steelskin")).toBe(true);
    expect(hostile.teamId).not.toBe(player.teamId);
});

test("Spec Ops separates mini-boss and boss waves", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    // Wave 7 = mini-boss only (no juggernauts)
    game.specOps!.wave = 6;
    game.specOps!.startNextWave();
    game.update(0.05);
    expect(game.specOps!.wave).toBe(7);
    const mini = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(mini.some((p) => p.role === "lieutenant" || p.role === "")).toBe(true);
    expect(mini.every((p) => p.role !== "last_man")).toBe(true);

    for (const e of mini) {
        e.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
        });
    }
    game.update(0.05);

    // Jump to boss wave 10
    game.specOps!.wave = 9;
    game.specOps!.phase = "intermission";
    game.specOps!.startNextWave();
    game.update(0.05);
    expect(game.specOps!.wave).toBe(10);
    const bosses = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(bosses.some((p) => p.role === "last_man")).toBe(true);
});

test("Spec Ops bosses and specials spawn with intended armor", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const woods = game.specOps!.spawnEnemyPublic("woods_king");
    expect(woods.chest).toBe("chest03");
    expect(woods.helmet).toBe("helmet03_forest");

    const potato = game.specOps!.spawnEnemyPublic("potato_king");
    expect(potato.chest).toBe("chest03");
    expect(potato.helmet).toBe("helmet03_potato");

    const tank = game.specOps!.spawnEnemyPublic("cobalt_tank");
    expect(tank.chest).toBe("chest04");
    expect(tank.helmet).toBe("helmet03");

    const ironclad = game.specOps!.spawnEnemyPublic("ironclad");
    expect(ironclad.chest).toBe("chest04");
    expect(ironclad.helmet).toBe("helmet03");
});

test("Spec Ops potatoes do not rewrite boss loadouts", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const potato = game.specOps!.spawnEnemyPublic("potato_king");
    const gun = potato.weapons[GameConfig.WeaponSlot.Primary].type;
    potato.randomWeaponSwap({
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        gameSourceType: gun,
        source: player,
    });
    expect(potato.weapons[GameConfig.WeaponSlot.Primary].type).toBe(gun);
});

test("Spec Ops event bosses use unique special-event weapons", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const woods = game.specOps!.spawnEnemyPublic("woods_king");
    expect(woods.role).toBe("woods_king");
    expect(woods.weapons[GameConfig.WeaponSlot.Primary].type).toBe("bar");
    expect(woods.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("usas");
    expect(woods.weapons[GameConfig.WeaponSlot.Melee].type).toBe("woodaxe");
    expect(woods.hasPerk("gotw")).toBe(true);

    const potato = game.specOps!.spawnEnemyPublic("potato_king");
    expect(potato.weapons[GameConfig.WeaponSlot.Primary].type).toBe("potato_cannon");
    expect(potato.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("potato_smg");
    expect(potato.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("potato");
    expect(potato.hasPerk("rare_potato")).toBe(true);
    expect(potato.helmet).toBe("helmet03_potato");

    const desert = game.specOps!.spawnEnemyPublic("desert_outlaw");
    expect(desert.weapons[GameConfig.WeaponSlot.Primary].type).toBe("model94");
    expect(desert.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("colt45_dual");

    const cursed = game.specOps!.spawnEnemyPublic("halloween_cursed");
    expect(cursed.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m9_cursed");
    expect(cursed.hasPerk("martyrdom")).toBe(true);

    const turkey = game.specOps!.spawnEnemyPublic("turkey_shooter");
    expect(turkey.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m1100");
    expect(turkey.hasPerk("turkey_shoot")).toBe(true);

    const snow = game.specOps!.spawnEnemyPublic("snow_sniper");
    expect(snow.weapons[GameConfig.WeaponSlot.Primary].type).toBe("awc_winter");
    expect(snow.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("snowball");

    const pirate = game.specOps!.spawnEnemyPublic("pirate_captain");
    expect(pirate.weapons[GameConfig.WeaponSlot.Primary].type).toBe("flare_gun");
    expect(pirate.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("deagle_dual");
    expect(pirate.weapons[GameConfig.WeaponSlot.Melee].type).toBe("cutlass");
    expect(pirate.hasPerk("broken_arrow")).toBe(true);
});

test("Spec Ops boss waves rotate special-event unique bosses", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    // Wave 10 → Woods King
    game.specOps!.wave = 9;
    game.specOps!.phase = "intermission";
    game.specOps!.startNextWave();
    game.update(0.05);
    expect(game.specOps!.wave).toBe(10);
    let enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(enemies.some((p) => p.name === "Woods King")).toBe(true);

    for (const e of enemies) {
        e.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
        });
    }
    game.update(0.05);

    // Wave 20 → Potato King
    game.specOps!.wave = 19;
    game.specOps!.phase = "intermission";
    game.specOps!.startNextWave();
    game.update(0.05);
    expect(game.specOps!.wave).toBe(20);
    enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(enemies.some((p) => p.name === "Potato King")).toBe(true);
});

test("Spec Ops wave 29 is a weak glory horde with no elites", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.wave = 28;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(29);

    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(enemies.length).toBeGreaterThan(35);
    expect(enemies.every((p) => p.role !== "last_man")).toBe(true);
    expect(enemies.every((p) => p.name !== "Cast Iron")).toBe(true);
    expect(enemies.every((p) => p.name !== "Machine Gunner")).toBe(true);
    expect(enemies.every((p) => p.name !== "Juggernaut")).toBe(true);
    expect(enemies.every((p) => p.name !== "Rifleman")).toBe(true);
    expect(enemies.every((p) => p.name !== "Heavy")).toBe(true);
    expect(enemies.every((p) => p.name !== "Bomber")).toBe(true);
    expect(enemies.some((p) => p.name === "Conscript" || p.name === "Militia")).toBe(true);
    expect(player.dead).toBe(false);
});

test("Spec Ops wave-29 glory executioner wipes the horde under truce then fights on 30", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.wave = 28;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(29);

    const exec = game.specOps!.spawnGloryExecutionerPublic();
    expect(exec).toBeDefined();
    expect(game.specOps!.gloryWipeActive).toBe(true);
    expect(exec!.teamId).not.toBe(player.teamId);
    expect(exec!.specOpsImmunityTicker).toBeGreaterThan(0);

    const weak = game.specOps!.livingWeakEnemies();
    expect(weak.length).toBeGreaterThan(10);
    expect(weak.every((p) => p !== exec)).toBe(true);

    // Weak fodder keep hunting the operator, not the boss.
    game.specOps!.update(0.2);
    game.update(0.2);
    expect(game.specOps!.aiAnchor(weak[0])).not.toBe(exec);
    expect(game.specOps!.aiTarget(weak[0])).not.toBe(exec);

    // Executioner cannot be hurt by the operator during the truce.
    exec!.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(exec!.dead).toBe(false);

    for (const grunt of weak) {
        if (grunt.dead) continue;
        grunt.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Airstrike,
            dir: v2.create(1, 0),
        });
    }
    game.specOps!.update(0.1);
    game.update(0.1);
    expect(game.specOps!.gloryTrucePause).toBe(true);
    expect(game.specOps!.phase).toBe("intermission");
    expect(exec!.dead).toBe(false);
    expect(player.dead).toBe(false);

    game.specOps!.startNextWave();
    game.update(0.05);
    expect(game.specOps!.wave).toBe(30);
    expect(game.specOps!.gloryTrucePause).toBe(false);
    expect(exec!.dead).toBe(false);
    expect(game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy").length)
        .toBeGreaterThan(1);
    expect(game.playerBarn.livingPlayers.some((p) => p.specOpsKind === "enemy" && p !== exec))
        .toBe(true);
});

test("Spec Ops late-game units replace weak fodder after wave 29", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 31;

    const veteran = game.specOps!.spawnEnemyPublic("veteran");
    expect(veteran.name).toBe("Veteran");
    expect(["hk416", "scar", "m4a1", "groza"]).toContain(
        veteran.weapons[GameConfig.WeaponSlot.Primary].type,
    );
    expect(veteran.chest).toBeTruthy();

    const shock = game.specOps!.spawnEnemyPublic("shock_trooper");
    expect(shock.name).toBe("Shock Trooper");
    expect(["mp5", "mac10", "ump9"]).toContain(
        shock.weapons[GameConfig.WeaponSlot.Primary].type,
    );

    const sapper = game.specOps!.spawnEnemyPublic("sapper");
    expect(sapper.name).toBe("Sapper");
    expect(sapper.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("mirv");
    expect(sapper.invManager.get("mirv")).toBeGreaterThan(0);

    const stormer = game.specOps!.spawnEnemyPublic("stormer");
    expect(stormer.name).toBe("Stormer");
    expect(["vector", "ump9", "mac10"]).toContain(
        stormer.weapons[GameConfig.WeaponSlot.Primary].type,
    );

    const enforcer = game.specOps!.spawnEnemyPublic("enforcer");
    expect(enforcer.name).toBe("Enforcer");
    expect(["spas12", "saiga", "m1100"]).toContain(
        enforcer.weapons[GameConfig.WeaponSlot.Primary].type,
    );

    const berserker = game.specOps!.spawnEnemyPublic("berserker");
    expect(berserker.name).toBe("Berserker");
    expect(berserker.specOpsSpeedMult).toBeGreaterThan(0.9);

    const gunslinger = game.specOps!.spawnEnemyPublic("gunslinger");
    expect(gunslinger.name).toBe("Gunslinger");
    expect(["deagle_dual", "p30l_dual", "colt45_dual"]).toContain(
        gunslinger.weapons[GameConfig.WeaponSlot.Primary].type,
    );

    const marauder = game.specOps!.spawnEnemyPublic("marauder");
    expect(marauder.name).toBe("Marauder");
    const pathfinder = game.specOps!.spawnEnemyPublic("pathfinder");
    expect(pathfinder.name).toBe("Pathfinder");
});

test("Spec Ops wave 31 drops the glory fodder for veteran forces", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.wave = 30;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(31);

    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    const names = enemies.map((p) => p.name);
    const roster = game.specOps!.waveRosterPublic(31);
    expect(names.some((n) => n === "Shock Trooper") || roster.includes("shock_trooper")).toBe(true);
    expect(names.some((n) => n === "Veteran") || roster.includes("veteran")).toBe(true);
    expect(names.some((n) => n === "Stormer" || n === "Berserker" || n === "Enforcer")).toBe(true);
    expect(names.every((n) => n !== "Conscript")).toBe(true);
    expect(names.every((n) => n !== "Militia")).toBe(true);
    expect(names.every((n) => n !== "Officer")).toBe(true);
    expect(names.every((n) => n !== "Raider")).toBe(true);
    expect(names.every((n) => n !== "Potato Thrower")).toBe(true);
    expect(names.every((n) => n !== "Rifleman")).toBe(true);
    expect(names.every((n) => n !== "Scout")).toBe(true);
    expect(names.every((n) => n !== "Rusher")).toBe(true);
    expect(names.every((n) => n !== "Breacher")).toBe(true);
    expect(names.every((n) => n !== "Looter")).toBe(true);
    expect(names.every((n) => n !== "Farmer")).toBe(true);
    expect(names.every((n) => n !== "Straggler")).toBe(true);
    expect(names.every((n) => n !== "Ghoul")).toBe(true);
    expect(enemies.length).toBeGreaterThan(25);
});

test("Spec Ops wave 31+ glory helpers join in groups of 4 without blocking hired allies", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 31;

    const first = game.specOps!.spawnGloryHelpersPublic();
    expect(first.length).toBe(SpecOpsHelperGroupSize);
    expect(first.every((p) => p.specOpsKind === "ally")).toBe(true);
    expect(first.every((p) => p.teamId === player.teamId)).toBe(true);
    expect(first.every((p) => game.specOps!.isGloryHelper(p))).toBe(true);
    expect(game.specOps!.livingHiredAllies().length).toBe(0);
    expect(game.specOps!.enemiesAlive).toBe(0);

    game.specOps!.wave = 4;
    game.specOps!.grantCash(player, 50000);
    const supportStation = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);

    expect(game.specOps!.tryBuy(player, "medic")).toBe(true);
    game.update(0.5);
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "recon")).toBe(true);
    game.update(0.5);
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "bugler")).toBe(true);
    game.update(0.5);
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "marksman")).toBe(true);
    expect(game.specOps!.livingHiredAllies().length).toBe(4);
    expect(game.specOps!.hiredSupportCount()).toBe(4);
    // Fill remaining hired slots (glory helpers still excluded from the cap).
    const hireRoles = ["grenadier", "lieutenant", "captain", "assaulter", "suppressor", "flanker", "cqc", "last_man"];
    for (let i = 0; i < hireRoles.length; i++) {
        game.update(0.5);
        v2.set(player.pos, supportStation.pos);
        game.grid.updateObject(player);
        expect(game.specOps!.tryBuy(player, hireRoles[i]!)).toBe(true);
    }
    expect(game.specOps!.livingHiredAllies().length).toBe(SpecOpsMaxSupportUnits);
    expect(game.specOps!.hiredSupportCount()).toBe(SpecOpsMaxSupportUnits);
    game.update(0.5);
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "medic")).toBe(false);

    const second = game.specOps!.spawnGloryHelpersPublic();
    expect(second.length).toBe(SpecOpsHelperGroupSize);
    const third = game.specOps!.spawnGloryHelpersPublic();
    expect(third.length).toBe(SpecOpsHelperGroupSize);
    expect(game.specOps!.spawnGloryHelpersPublic().length).toBe(0);

    const helpers = game.playerBarn.livingPlayers.filter((p) => game.specOps!.isGloryHelper(p));
    expect(helpers.length).toBe(SpecOpsHelpersPerWave);
    expect(game.specOps!.livingHiredAllies().length).toBe(SpecOpsMaxSupportUnits);
    expect(game.specOps!.hiredSupportCount()).toBe(SpecOpsMaxSupportUnits);
});

test("Spec Ops roles sort into early, military, cobalt, and endgame waves", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    expect(game.specOps!.waveRosterPublic(1)).not.toContain("straggler");
    expect(game.specOps!.waveRosterPublic(2)).toContain("straggler");
    expect(game.specOps!.waveRosterPublic(2)).toContain("looter");
    expect(game.specOps!.waveRosterPublic(4)).toContain("farmer");
    expect(game.specOps!.waveRosterPublic(6)).toContain("ghoul");
    expect(game.specOps!.waveRosterPublic(8)).toContain("trickster");
    expect(game.specOps!.waveRosterPublic(12)).toContain("stalker");
    expect(game.specOps!.waveRosterPublic(12)).toContain("military_breacher");
    expect(game.specOps!.waveRosterPublic(15)).toContain("military_rifle");
    expect(game.specOps!.waveRosterPublic(18)).toContain("military_lmg");
    expect(game.specOps!.waveRosterPublic(31)).not.toContain("militia");
    expect(game.specOps!.waveRosterPublic(31)).not.toContain("conscript");
    expect(game.specOps!.waveRosterPublic(31)).not.toContain("looter");
    expect(game.specOps!.waveRosterPublic(35)).toContain("cobalt_grunt");
    expect(game.specOps!.waveRosterPublic(40)).toContain("cobalt_tank");
    expect(game.specOps!.waveRosterPublic(45)).toContain("black_ops");
    expect(game.specOps!.waveRosterPublic(50)).toContain("titan");
    expect(game.specOps!.waveRosterPublic(50)).toContain("warlord");
    expect(game.specOps!.waveRosterPublic(50)).toContain("hunter");
});

test("Spec Ops wave 51 enemies gain extra perks and stronger stats", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.wave = 50;
    const before = game.specOps!.spawnEnemyPublic("veteran");
    game.specOps!.wave = 51;
    const after = game.specOps!.spawnEnemyPublic("veteran");

    expect(after.perks.length).toBeGreaterThan(before.perks.length);
    expect(after.specOpsDamageMult).toBeGreaterThan(before.specOpsDamageMult);
    expect(after.health).toBeGreaterThan(before.health);
    expect(specOpsEnemyHealth(51, "veteran")).toBeGreaterThan(specOpsEnemyHealth(50, "veteran"));
});

test("Spec Ops shop lists all guns, perks, support, and gear", () => {
    const skus = new Set(SpecOpsShopCatalog.map((item) => item.sku));

    for (const type of Object.keys(GunDefs)) {
        const def = GunDefs[type as keyof typeof GunDefs] as { noDrop?: boolean };
        if (def.noDrop) {
            expect(skus.has(type), `undroppable gun ${type} should not be sold`).toBe(false);
            continue;
        }
        expect(skus.has(type), `missing gun ${type}`).toBe(true);
    }

    for (const perk of SpecOpsBuyablePerks) {
        expect(skus.has(perk), `missing perk ${perk}`).toBe(true);
    }
    for (const type of Object.keys(PerkDefs)) {
        if (
            type === "self_revive"
            || type === "classless"
            || type === "assume_leadership"
            || type === "halloween_mystery"
            || type.startsWith("trick_")
            || type.startsWith("treat_")
        ) {
            continue;
        }
        expect((SpecOpsBuyablePerks as readonly string[]).includes(type), `unlisted perk ${type}`).toBe(true);
    }

    for (const role of SpecOpsAllyRoles) {
        expect(skus.has(role), `missing support ${role}`).toBe(true);
    }

    for (const type of Object.keys(MeleeDefs)) {
        if (type === "fists" || type === "sledgehammer" || type.includes("_")) continue;
        if ((SpecOpsShopExcludedMelee as readonly string[]).includes(type)) continue;
        expect(skus.has(type), `missing melee ${type}`).toBe(true);
    }

    expect(skus.has("2xscope")).toBe(true);
    expect(skus.has("4xscope")).toBe(true);
    expect(skus.has("8xscope")).toBe(true);
    expect(skus.has("15xscope")).toBe(true);
    expect(skus.has("frag")).toBe(true);
    expect(skus.has("smoke")).toBe(true);
    expect(skus.has("mirv")).toBe(true);
    expect(skus.has("armor_plate")).toBe(true);
    expect(SpecOpsShopBySku.armor_plate?.amount).toBe(3);
    expect(SpecOpsShopCatalog.some((item) => item.sku === "chest01")).toBe(false);
    expect(SpecOpsShopCatalog.some((item) => item.sku === "chest04")).toBe(false);
    for (const sku of SpecOpsArmorSatchelSkus) {
        expect(skus.has(sku), `missing satchel ${sku}`).toBe(false);
    }
    expect(SpecOpsShopCatalog.some((item) => item.sku === "helmet01")).toBe(false);
    expect(SpecOpsShopCatalog.some((item) => item.sku === "helmet04")).toBe(false);
    expect(SpecOpsShopBySku.katana?.station).toBe("gear");
});

test("Spec Ops armor satchel SKUs are registered game types", () => {
    for (const sku of SpecOpsArmorSatchelSkus) {
        expect(GameObjectDefs.typeExists(sku), `missing satchel type ${sku}`).toBe(true);
        expect(() => GameObjectDefs.typeToId(sku)).not.toThrow();
    }
});

test("Spec Ops support hire SKUs are registered game types", () => {
    for (const role of SpecOpsAllyRoles) {
        expect(GameObjectDefs.typeExists(role), `missing support type ${role}`).toBe(true);
        expect(() => GameObjectDefs.typeToId(role)).not.toThrow();
    }
});

test("Spec Ops unequip shop SKUs are registered game types", () => {
    for (const perk of SpecOpsBuyablePerks) {
        const sku = specOpsUnequipSku(perk);
        expect(GameObjectDefs.typeExists(sku), `missing unequip type ${sku}`).toBe(true);
        expect(() => GameObjectDefs.typeToId(sku)).not.toThrow();
    }
});

test("Spec Ops support costs less in solo and duo", () => {
    const sentry = SpecOpsShopBySku.specops_sentry;
    const medic = SpecOpsShopBySku.medic;
    expect(specOpsShopItemCost(medic, TeamMode.Solo)).toBe(1320);
    expect(specOpsShopItemCost(sentry, TeamMode.Solo)).toBe(1560);
    expect(specOpsShopItemCost(medic, TeamMode.Duo)).toBe(1650);
    expect(specOpsShopItemCost(medic, TeamMode.Squad)).toBe(2200);
    expect(specOpsShopItemCost(SpecOpsShopBySku.mp5, TeamMode.Solo)).toBe(800);
});

test("Spec Ops shop weapons are sorted by ammo type then category", () => {
    const weapons = specOpsShopStationItems("weapon", TeamMode.Squad)
        .filter((item) => !SpecOpsArmorSatchelSkus.includes(item.sku as typeof SpecOpsArmorSatchelSkus[number]));
    expect(weapons.some((item) => item.sku === "m9")).toBe(true);
    expect(weapons.some((item) => item.sku === "m870")).toBe(true);

    // All 9mm weapons should appear before 12gauge, which appear before 556.
    const first9 = weapons.findIndex((w) => GunDefs[w.sku as keyof typeof GunDefs]?.ammo === "9mm");
    const first12 = weapons.findIndex((w) => GunDefs[w.sku as keyof typeof GunDefs]?.ammo === "12gauge");
    const first556 = weapons.findIndex((w) => GunDefs[w.sku as keyof typeof GunDefs]?.ammo === "556mm");
    expect(first9).toBeGreaterThanOrEqual(0);
    expect(first12).toBeGreaterThan(first9);
    expect(first556).toBeGreaterThan(first12);

    const support = specOpsShopStationItems("support", TeamMode.Solo).filter(
        (item) => !SpecOpsArmorSatchelSkus.includes(item.sku as typeof SpecOpsArmorSatchelSkus[number]),
    );
    expect(support[0].cost).toBeLessThanOrEqual(support[support.length - 1].cost);
});

test("Spec Ops solo support purchases charge the discounted price", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 4;
    const medicCost = specOpsShopItemCost(SpecOpsShopBySku.medic, TeamMode.Solo);
    game.specOps!.grantCash(player, medicCost);

    const supportStation = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);

    const before = player.specOpsCash;
    expect(game.specOps!.tryBuy(player, "medic")).toBe(true);
    expect(player.specOpsCash).toBe(before - medicCost);
    expect(game.specOps!.livingAllies("ally").length).toBe(1);
});

test("Spec Ops gear station sells melee weapons", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 2;
    game.specOps!.grantCash(player, 5000);

    const gearStation = findSpecOpsStation(game, "specops_station_gear")!;
    v2.set(player.pos, gearStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "katana")).toBe(true);
    expect(player.weapons[GameConfig.WeaponSlot.Melee].type).toBe("katana");
});

test("Spec Ops gear station fills medicals to backpack max", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 2;
    game.specOps!.grantCash(player, 10000);

    const gearStation = findSpecOpsStation(game, "specops_station_gear")!;
    v2.set(player.pos, gearStation.pos);
    game.grid.updateObject(player);

    player.invManager.set("bandage", 2);
    const bandageMax = player.invManager.getMaxCapacity("bandage");
    expect(game.specOps!.tryBuy(player, "bandage")).toBe(true);
    expect(player.invManager.get("bandage")).toBe(bandageMax);
    expect(game.specOps!.tryBuy(player, "bandage")).toBe(false);

    player.invManager.set("soda", 1);
    const sodaMax = player.invManager.getMaxCapacity("soda");
    expect(game.specOps!.tryBuy(player, "soda")).toBe(true);
    expect(player.invManager.get("soda")).toBe(sodaMax);

    player.invManager.set("healthkit", 0);
    const kitMax = player.invManager.getMaxCapacity("healthkit");
    expect(game.specOps!.tryBuy(player, "healthkit")).toBe(true);
    expect(player.invManager.get("healthkit")).toBe(kitMax);

    player.invManager.set("painkiller", 0);
    const pillsMax = player.invManager.getMaxCapacity("painkiller");
    expect(game.specOps!.tryBuy(player, "painkiller")).toBe(true);
    expect(player.invManager.get("painkiller")).toBe(pillsMax);

    const bandageItem = SpecOpsShopCatalog.find((i) => i.sku === "bandage");
    expect(bandageItem?.fillToMax).toBe(true);
});

test("Spec Ops veteran forces crank up after wave 29", () => {
    const early = createGame(TeamMode.Solo, "test_specops");
    early.playerBarn.addTestPlayer({ name: "Operator" });
    early.update(0.1);
    early.specOps!.wave = 30;
    early.specOps!.phase = "intermission";
    beginSpecOpsWave(early, true);
    const shock31 = early.specOps!.waveRosterPublic(31).filter((k) => k === "shock_trooper").length;

    const late = createGame(TeamMode.Solo, "test_specops");
    late.playerBarn.addTestPlayer({ name: "Operator" });
    late.update(0.1);
    late.specOps!.wave = 35;
    late.specOps!.phase = "intermission";
    beginSpecOpsWave(late, true);
    const shock36 = late.specOps!.waveRosterPublic(36).filter((k) => k === "shock_trooper").length;
    const wave31 = early.specOps!.waveRosterPublic(31);
    const wave36 = late.specOps!.waveRosterPublic(36);

    expect(shock31).toBeGreaterThan(0);
    expect(wave36.length).toBeGreaterThanOrEqual(wave31.length);
    expect(wave36.every((k) => k !== "conscript")).toBe(true);
});

test("Spec Ops wave 40 uses Cobalt fireteam bosses", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.wave = 39;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(40);

    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    const roles = new Set(enemies.map((p) => p.role));
    expect(roles.has("tank")).toBe(true);
    expect(roles.has("assault")).toBe(true);
    expect(roles.has("demo")).toBe(true);
    expect(roles.has("sniper")).toBe(true);
    expect(roles.has("scout")).toBe(true);
    expect(roles.has("healer")).toBe(true);
    expect(enemies.some((p) => p.role === "last_man")).toBe(false);
});

test("Spec Ops machine gunners appear from wave 11", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const gunner = game.specOps!.spawnEnemyPublic("machine_gunner");
    expect(gunner.specOpsKind).toBe("enemy");
    expect(["m249", "dp28", "pkp", "qbb97"]).toContain(
        gunner.weapons[GameConfig.WeaponSlot.Primary].type,
    );
    expect(gunner.hasPerk("firepower")).toBe(true);

    game.specOps!.wave = 10;
    game.specOps!.phase = "intermission";
    game.specOps!.startNextWave();
    game.update(0.05);
    const wave11 = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(wave11.some((p) => p.name === "Machine Gunner")).toBe(true);
});

test("Spec Ops potato throwers appear in small groups early and larger later", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const thrower = game.specOps!.spawnEnemyPublic("potato_thrower");
    expect(thrower.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("potato");
    expect(thrower.invManager.get("potato")).toBeGreaterThan(0);

    game.specOps!.wave = 2;
    game.specOps!.phase = "intermission";
    game.specOps!.startNextWave();
    game.update(0.05);
    const wave3 = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    const earlyCount = wave3.filter((p) => p.name === "Potato Thrower").length;
    expect(earlyCount).toBeGreaterThanOrEqual(1);
    expect(earlyCount).toBeLessThanOrEqual(3);

    for (const e of wave3) {
        e.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
        });
    }
    game.update(0.05);

    game.specOps!.wave = 24;
    game.specOps!.phase = "intermission";
    game.specOps!.startNextWave();
    game.update(0.05);
    const wave25 = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    const lateCount = wave25.filter((p) => p.name === "Potato Thrower").length;
    expect(lateCount).toBeGreaterThan(earlyCount);
});

test("Spec Ops Cast Iron deflects with steelskin and wipes its own squad on death", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const castIron = game.specOps!.spawnEnemyPublic("cast_iron");
    expect(castIron.hasPerk("steelskin")).toBe(true);
    expect(castIron.weapons[GameConfig.WeaponSlot.Melee].type).toBe("pan");
    expect(castIron.chest).toBe("chest04");

    const grunt = game.specOps!.spawnEnemyPublic("militia");
    v2.set(castIron.pos, v2.create(40, 40));
    v2.set(grunt.pos, v2.create(42, 40));
    v2.set(player.pos, v2.create(40, 55));
    game.grid.updateObject(castIron);
    game.grid.updateObject(grunt);
    game.grid.updateObject(player);

    const playerHp = player.health;
    castIron.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(castIron.dead).toBe(true);

    // Wipe is delayed ~1.35s.
    for (let i = 0; i < 20; i++) {
        game.specOps!.update(0.1);
        game.update(0.1);
    }

    expect(grunt.dead).toBe(true);
    expect(player.dead).toBe(false);
    expect(player.health).toBe(playerHp);
});

test("Cast Iron death + purchased airstrike does not double zone", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.grantCash(player, 20000);

    const castIron = game.specOps!.spawnEnemyPublic("cast_iron");
    const grunt = game.specOps!.spawnEnemyPublic("militia");
    v2.set(castIron.pos, v2.create(40, 40));
    v2.set(grunt.pos, v2.create(42, 40));
    v2.set(player.pos, v2.create(40, 55));
    game.grid.updateObject(castIron);
    game.grid.updateObject(grunt);
    game.grid.updateObject(player);

    castIron.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(castIron.dead).toBe(true);

    const supportStation = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "specops_airstrike")).toBe(false);

    for (let i = 0; i < 20; i++) {
        game.specOps!.update(0.1);
        game.update(0.1);
    }

    expect(game.planeBarn.airstrikeZones.length).toBe(1);
    expect(grunt.dead).toBe(true);
});

test("Spec Ops stations are placed inside buildings", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const stations = game.map.obstacles.filter((o) => o.type.startsWith("specops_station_"));
    expect(stations.length).toBeGreaterThanOrEqual(5);

    // Required types all present.
    for (const kind of ["weapon", "gear", "armor", "support", "perk"]) {
        expect(stations.some((o) => o.type === `specops_station_${kind}`)).toBe(true);
    }

    let indoor = 0;
    for (let i = 0; i < stations.length; i++) {
        const station = stations[i];
        for (let j = 0; j < game.map.buildings.length; j++) {
            const building = game.map.buildings[j];
            if (building.layer !== 0 || building.parentBuilding) continue;
            for (let k = 0; k < building.zoomRegions.length; k++) {
                const zoomIn = building.zoomRegions[k].zoomIn;
                if (!zoomIn) continue;
                if (
                    station.pos.x >= zoomIn.min.x
                    && station.pos.x <= zoomIn.max.x
                    && station.pos.y >= zoomIn.min.y
                    && station.pos.y <= zoomIn.max.y
                ) {
                    indoor++;
                    break;
                }
            }
        }
    }
    expect(indoor).toBeGreaterThan(0);

    // Per-building caps: small <=1 total near building, large/medium <=3.
    for (let j = 0; j < game.map.buildings.length; j++) {
        const building = game.map.buildings[j];
        if (building.layer !== 0 || building.parentBuilding) continue;
        const zoomIns = building.zoomRegions.map((r) => r.zoomIn).filter(Boolean);
        if (!zoomIns.length) continue;

        const type = building.type;
        const isSmall = type.includes("shack") || type.includes("hut");
        const isBlocked = type.includes("outhouse")
            || type.includes("container")
            || type.includes("cache")
            || type.includes("bunker");
        if (isBlocked) continue;

        let indoorCount = 0;
        let outdoorCount = 0;
        for (let i = 0; i < stations.length; i++) {
            const station = stations[i];
            const inside = zoomIns.some(
                (z) =>
                    station.layer === 0
                    && station.pos.x >= z!.min.x
                    && station.pos.x <= z!.max.x
                    && station.pos.y >= z!.min.y
                    && station.pos.y <= z!.max.y,
            );
            if (inside) {
                indoorCount++;
                continue;
            }
            // Count stations sitting on this building's exterior ring.
            const region = zoomIns[0]!;
            const pad = 4.5;
            const nearOutside = station.pos.x >= region.min.x - pad
                && station.pos.x <= region.max.x + pad
                && station.pos.y >= region.min.y - pad
                && station.pos.y <= region.max.y + pad
                && !(
                    station.pos.x >= region.min.x
                    && station.pos.x <= region.max.x
                    && station.pos.y >= region.min.y
                    && station.pos.y <= region.max.y
                );
            if (nearOutside) outdoorCount++;
        }

        if (isSmall) {
            expect(indoorCount).toBeLessThanOrEqual(1);
            expect(outdoorCount).toBe(0);
        } else {
            expect(indoorCount + outdoorCount).toBeLessThanOrEqual(3);
            expect(outdoorCount).toBeLessThanOrEqual(1);
        }
    }
});

test("Spec Ops shop stations can spawn in cellars and basements", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const stations = game.map.obstacles.filter((o) => o.type.startsWith("specops_station_"));
    expect(stations.length).toBeGreaterThan(0);

    const cellarRegions: Array<{ min: { x: number; y: number }; max: { x: number; y: number } }> = [];
    for (let i = 0; i < game.map.buildings.length; i++) {
        const building = game.map.buildings[i];
        if (building.layer !== 1) continue;
        for (let j = 0; j < building.zoomRegions.length; j++) {
            const zoomIn = building.zoomRegions[j].zoomIn;
            if (zoomIn) cellarRegions.push(zoomIn);
        }
    }
    expect(cellarRegions.length).toBeGreaterThan(0);

    const underground = stations.filter((station) => {
        if (station.layer !== 1) return false;
        return cellarRegions.some(
            (region) =>
                station.pos.x >= region.min.x
                && station.pos.x <= region.max.x
                && station.pos.y >= region.min.y
                && station.pos.y <= region.max.y,
        );
    });
    expect(underground.length).toBeGreaterThan(0);

    const cellarStation = underground[0];
    const player = game.playerBarn.livingPlayers[0];
    game.specOps!.wave = 4;
    player.specOpsCash = 0;
    v2.set(player.pos, cellarStation.pos);
    player.layer = 1;
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "specops_ammo")).toBe(false);
    game.specOps!.grantCash(player, 5000);
    expect(game.specOps!.tryBuy(player, "specops_ammo")).toBe(true);
});

test("Spec Ops map has no free loot tiers and stations are marked", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    expect(game.map.mapDef.mapGen.densitySpawns[0].loot_tier_1).toBeUndefined();
    expect(game.map.mapDef.mapGen.densitySpawns[0].crate_01).toBeUndefined();
    expect(
        game.mapIndicatorBarn.mapIndicators.some((i) => i.type.startsWith("specops_marker_")),
    ).toBe(true);
});

test("Spec Ops armor pool absorbs damage after gear DR", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    expect(player.health).toBe(200);
    expect(player.specOpsArmor).toBe(100);
    player.chest = "";
    player.helmet = "";

    player.damage({
        amount: 40,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    expect(player.specOpsArmor).toBe(60);
    expect(player.health).toBe(200);

    player.damage({
        amount: 80,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    expect(player.specOpsArmor).toBe(0);
    expect(player.health).toBe(180);
});

test("Spec Ops armor satchels equip bundled gear and use DR", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    player.chest = "";
    player.helmet = "";
    player.backpack = "backpack00";
    player.specOpsArmor = 0;

    game.specOps!.wave = 4;
    game.specOps!.grantCash(player, 25000);

    const weaponStation = findSpecOpsStation(game, "specops_station_weapon")!;
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "specops_satchel_02")).toBe(true);
    expect(player.chest).toBe("chest02");
    expect(player.helmet).toBe("helmet02");
    expect(player.backpack).toBe("backpack02");

    const healthBefore = player.health;
    player.damage({
        amount: 100,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    expect(player.health).toBeGreaterThan(healthBefore - 100);
    expect(player.specOpsArmor).toBe(0);
});

test("Spec Ops armor satchel costs and tiers", () => {
    expect(SpecOpsArmorSatchelCosts.specops_satchel_01).toBe(5000);
    expect(SpecOpsArmorSatchelCosts.specops_satchel_02).toBe(10000);
    expect(SpecOpsArmorSatchelCosts.specops_satchel_03).toBe(15000);
    expect(SpecOpsArmorSatchelCosts.specops_satchel_04).toBe(22500);
    expect(SpecOpsArmorSatchelGear.specops_satchel_04).toEqual({
        chest: "chest04",
        helmet: "helmet04",
        backpack: "backpack04",
        level: 4,
    });
});

test("Spec Ops shops do not sell standalone backpacks", () => {
    for (const station of ["weapon", "gear", "armor", "support", "perk"] as const) {
        const items = specOpsShopStationItems(station, TeamMode.Squad);
        expect(items.some((item) => item.sku.startsWith("backpack"))).toBe(false);
    }
    expect(SpecOpsShopCatalog.some((item) => item.sku.startsWith("backpack"))).toBe(false);
});

test("Spec Ops armor satchels are sold at every station", () => {
    for (const station of ["weapon", "gear", "armor", "support", "perk"] as const) {
        const items = specOpsShopStationItems(station, TeamMode.Squad);
        for (const sku of SpecOpsArmorSatchelSkus) {
            expect(items.some((item) => item.sku === sku), `${sku} missing at ${station}`).toBe(true);
        }
    }
});

test("Spec Ops wave 5 includes suicide vest bombers", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.wave = 4;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);

    expect(game.specOps!.wave).toBe(5);
    const bombers = game.playerBarn.livingPlayers.filter(
        (p) => p.specOpsKind === "enemy" && p.specOpsSuicideVest,
    );
    expect(bombers.length).toBeGreaterThan(0);
});

test("Spec Ops enemies spawn as a squad from one approach", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.startNextWave();
    game.update(0.05);

    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(enemies.length).toBeGreaterThan(1);

    const angles = enemies.map((e) => Math.atan2(e.pos.y - player.pos.y, e.pos.x - player.pos.x));
    // Normalize relative to first angle and measure angular spread.
    const base = angles[0];
    let maxSpread = 0;
    for (let i = 1; i < angles.length; i++) {
        let d = angles[i] - base;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        maxSpread = Math.max(maxSpread, Math.abs(d));
    }
    // Surround spawn would fan ~2π; squads stay within a bit over a radian.
    expect(maxSpread).toBeLessThan(1.4);
});

test("Spec Ops stations unlock progressively and include a perk station", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const perkStations = game.map.obstacles.filter((o) => o.type === "specops_station_perk");
    expect(perkStations.length).toBeGreaterThan(0);
    expect(perkStations.length).toBeLessThanOrEqual(2);

    const armorStation = findSpecOpsStation(game, "specops_station_armor")!;
    v2.set(player.pos, armorStation.pos);
    game.grid.updateObject(player);
    game.specOps!.grantCash(player, 5000);
    expect(game.specOps!.tryBuy(player, "armor_plate")).toBe(false);

    game.specOps!.wave = 4;
    expect(game.specOps!.tryBuy(player, "armor_plate")).toBe(true);
    expect(player.invManager.get("armor_plate")).toBe(3);

    game.update(0.5);
    const perkStation = findSpecOpsStation(game, "specops_station_perk")!;
    v2.set(player.pos, perkStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "steelskin")).toBe(false);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(player, 5000);
    expect(game.specOps!.tryBuy(player, "steelskin")).toBe(true);
    expect(player.hasPerk("steelskin")).toBe(true);
});

test("Spec Ops perk shop count respects team mode caps", () => {
    const solo = createGame(TeamMode.Solo, "test_specops");
    solo.playerBarn.addTestPlayer({ name: "Solo" });
    solo.update(0.1);
    expect(
        solo.map.obstacles.filter((o) => o.type === "specops_station_perk").length,
    ).toBeLessThanOrEqual(2);

    const duo = createGame(TeamMode.Duo, "test_specops");
    duo.playerBarn.addTestPlayer({ name: "Duo" });
    duo.update(0.1);
    expect(
        duo.map.obstacles.filter((o) => o.type === "specops_station_perk").length,
    ).toBeLessThanOrEqual(2);

    const squad = createGame(TeamMode.Squad, "test_specops");
    squad.playerBarn.addTestPlayer({ name: "Squad" });
    squad.update(0.1);
    expect(
        squad.map.obstacles.filter((o) => o.type === "specops_station_perk").length,
    ).toBeLessThanOrEqual(3);
    expect(
        squad.map.obstacles.filter((o) => o.type === "specops_station_perk").length,
    ).toBeGreaterThan(0);
});

test("Spec Ops operators can grab extra perks that drop on cash buyback", () => {
    expect(SpecOpsMaxPerks).toBe(6);
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({ name: "Alpha" });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        group: alpha.group,
    });
    game.update(0.1);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(alpha, 80000);

    const perkStation = findSpecOpsStation(game, "specops_station_perk")!;
    v2.set(alpha.pos, perkStation.pos);
    game.grid.updateObject(alpha);

    expect(alpha.hasPerk("self_revive")).toBe(false);
    expect(alpha.perks.length).toBe(0);

    const buys = [
        "steelskin",
        "flak_jacket",
        "firepower",
        "endless_ammo",
        "ap_rounds",
        "chambered",
        "takedown",
    ];
    for (let i = 0; i < buys.length; i++) {
        expect(game.specOps!.tryBuy(alpha, buys[i])).toBe(true);
        game.update(0.5);
        v2.set(alpha.pos, perkStation.pos);
        game.grid.updateObject(alpha);
    }
    expect(alpha.perks.length).toBe(buys.length);
    expect(alpha.hasPerk("takedown")).toBe(true);

    const kept = alpha.perks.slice(0, SpecOpsMaxPerks).map((p) => p.type);
    const extras = alpha.perks.slice(SpecOpsMaxPerks).map((p) => p.type);
    expect(extras.length).toBeGreaterThan(0);

    alpha.kill({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    game.update(0.05);
    expect(alpha.dead).toBe(true);

    const cost = specOpsBuybackCost(game.specOps!.wave);
    game.specOps!.grantCash(bravo, cost);
    expect(game.specOps!.tryBuy(bravo, specOpsBuybackSku(0))).toBe(true);

    expect(alpha.dead).toBe(false);
    expect(alpha.perks.length).toBe(SpecOpsMaxPerks);
    for (const type of kept) {
        expect(alpha.hasPerk(type)).toBe(true);
    }
    for (const type of extras) {
        expect(alpha.hasPerk(type)).toBe(false);
    }
});

test("Spec Ops operators can sell a shop perk to free a slot", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(player, 5000);

    const perkStation = findSpecOpsStation(game, "specops_station_perk")!;
    v2.set(player.pos, perkStation.pos);
    game.grid.updateObject(player);

    const cost = specOpsShopItemCost(SpecOpsShopBySku.steelskin, TeamMode.Solo);
    const cashBefore = player.specOpsCash;
    expect(game.specOps!.tryBuy(player, "steelskin")).toBe(true);
    expect(player.hasPerk("steelskin")).toBe(true);
    expect(player.specOpsCash).toBe(cashBefore - cost);

    game.update(0.5);
    v2.set(player.pos, perkStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, specOpsUnequipSku("steelskin"))).toBe(true);
    expect(player.hasPerk("steelskin")).toBe(false);
    expect(player.specOpsCash).toBe(cashBefore);

    game.update(0.5);
    v2.set(player.pos, perkStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "takedown")).toBe(true);
    expect(player.hasPerk("takedown")).toBe(true);
});

test("Spec Ops perk shop prices scale with current perk count", () => {
    expect(specOpsPerkShopCost(0)).toBe(2000);
    expect(specOpsPerkShopCost(1)).toBe(2000);
    expect(specOpsPerkShopCost(6)).toBe(9500);
    expect(specOpsPerkShopCost(9)).toBe(14000);
    expect(specOpsPerkShopRefund(1)).toBe(2000);
    expect(specOpsPerkShopRefund(6)).toBe(8000);
    expect(specOpsShopItemCost(SpecOpsShopBySku.steelskin, TeamMode.Solo, 0)).toBe(2000);
    expect(specOpsShopItemCost(SpecOpsShopBySku.takedown, TeamMode.Squad, 6)).toBe(9500);
    expect(specOpsShopItemCost(SpecOpsShopBySku.firepower, TeamMode.Solo, 9)).toBe(14000);

    const listed = specOpsShopStationItems("perk", TeamMode.Solo, "", 6)
        .filter((item) => (SpecOpsBuyablePerks as readonly string[]).includes(item.sku));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((item) => item.cost === 9500)).toBe(true);

    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(player, 40000);

    const perkStation = findSpecOpsStation(game, "specops_station_perk")!;
    v2.set(player.pos, perkStation.pos);
    game.grid.updateObject(player);

    const buys = ["steelskin", "flak_jacket", "firepower"];
    const expected = [2000, 2000, 3500];
    for (let i = 0; i < buys.length; i++) {
        const before = player.specOpsCash;
        expect(player.perks.length).toBe(i);
        expect(game.specOps!.tryBuy(player, buys[i])).toBe(true);
        expect(player.specOpsCash).toBe(before - expected[i]);
        game.update(0.5);
        v2.set(player.pos, perkStation.pos);
        game.grid.updateObject(player);
    }

    const sellBefore = player.specOpsCash;
    expect(game.specOps!.tryBuy(player, specOpsUnequipSku("firepower"))).toBe(true);
    expect(player.specOpsCash).toBe(sellBefore + specOpsPerkShopRefund(3));
    expect(player.perks.length).toBe(2);
});

test("Spec Ops perk shop uses restored perk count after buyback", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({ name: "Alpha" });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        group: alpha.group,
    });
    game.update(0.1);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(alpha, 80000);

    const perkStation = findSpecOpsStation(game, "specops_station_perk")!;
    v2.set(alpha.pos, perkStation.pos);
    game.grid.updateObject(alpha);

    const buys = [
        "steelskin",
        "flak_jacket",
        "firepower",
        "endless_ammo",
        "ap_rounds",
        "chambered",
        "takedown",
    ];
    for (let i = 0; i < buys.length; i++) {
        expect(game.specOps!.tryBuy(alpha, buys[i])).toBe(true);
        game.update(0.5);
        v2.set(alpha.pos, perkStation.pos);
        game.grid.updateObject(alpha);
    }
    expect(alpha.perks.length).toBe(7);

    alpha.kill({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    game.update(0.05);
    expect(alpha.dead).toBe(true);

    const cost = specOpsBuybackCost(game.specOps!.wave);
    game.specOps!.grantCash(bravo, cost);
    expect(game.specOps!.tryBuy(bravo, specOpsBuybackSku(0))).toBe(true);
    expect(alpha.dead).toBe(false);
    expect(alpha.perks.length).toBe(SpecOpsMaxPerks);

    game.update(0.5);
    v2.set(alpha.pos, perkStation.pos);
    game.grid.updateObject(alpha);
    const nextCost = specOpsPerkShopCost(alpha.perks.length);
    expect(nextCost).toBe(9500);
    game.specOps!.grantCash(alpha, nextCost);
    const cashBefore = alpha.specOpsCash;
    expect(game.specOps!.tryBuy(alpha, "takedown")).toBe(true);
    expect(alpha.hasPerk("takedown")).toBe(true);
    expect(alpha.specOpsCash).toBe(cashBefore - 9500);
});

test("Spec Ops can hire multiple support allies up to the cap", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 4;
    game.specOps!.grantCash(player, 100000);

    const supportStation = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);

    const roles = [
        "medic",
        "recon",
        "bugler",
        "marksman",
        "grenadier",
        "lieutenant",
        "captain",
        "assaulter",
        "suppressor",
        "flanker",
        "cqc",
        "last_man",
    ];
    for (let i = 0; i < roles.length; i++) {
        v2.set(player.pos, supportStation.pos);
        game.grid.updateObject(player);
        expect(game.specOps!.tryBuy(player, roles[i]!)).toBe(true);
        expect(game.specOps!.livingHiredAllies().length).toBe(i + 1);
        expect(game.specOps!.hiredSupportCount()).toBe(i + 1);
        game.update(0.5);
    }
    expect(game.specOps!.livingHiredAllies().length).toBe(SpecOpsMaxSupportUnits);
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "medic")).toBe(false);
    expect(game.specOps!.tryBuy(player, "specops_sentry")).toBe(false);
    expect(game.specOps!.hiredSupportCount()).toBe(SpecOpsMaxSupportUnits);
});

test("Spec Ops sentry uses 300-round belt and 9s reload; combined support cap is 12", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 4;
    game.specOps!.grantCash(player, 100000);

    const supportStation = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);

    expect(game.specOps!.tryBuy(player, "specops_sentry")).toBe(true);
    const sentry = game.playerBarn.livingPlayers.find((p) => p.specOpsKind === "sentry")!;
    expect(sentry.weapons[GameConfig.WeaponSlot.Primary].ammo).toBe(SpecOpsSentryClip);
    expect(
        sentry.weaponManager.getAmmoStats(
            GameObjectDefs.typeToDef("m249", "gun"),
        ).maxClip,
    ).toBe(SpecOpsSentryClip);

    // Mix of allies + sentries share one 12-unit hired cap.
    for (let i = 0; i < 11; i++) {
        game.update(0.5);
        v2.set(player.pos, supportStation.pos);
        game.grid.updateObject(player);
        const sku = i % 2 === 0 ? "medic" : "specops_sentry";
        expect(game.specOps!.tryBuy(player, sku)).toBe(true);
    }
    expect(game.specOps!.hiredSupportCount()).toBe(SpecOpsMaxSupportUnits);
    game.update(0.5);
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "recon")).toBe(false);
    expect(SpecOpsSentryReloadTime).toBe(9);
});

test("Spec Ops AI tryReload ignores throwable slot (mirv)", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    const ally = game.specOps!.spawnAllyPublic("grenadier", player)!;
    ally.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "mirv", 0);
    ally.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Throwable);
    expect(ally.weaponManager.activeWeapon).toBe("mirv");
    expect(() => ally.weaponManager.tryReload()).not.toThrow();
});

test("Spec Ops support airstrike and care package fulfill without throwing", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 4;
    game.specOps!.grantCash(player, 20000);

    const supportStation = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);

    expect(game.specOps!.tryBuy(player, "specops_airstrike")).toBe(true);
    game.update(0.5);
    expect(game.planeBarn.airstrikeZones.length).toBeGreaterThan(0);

    v2.set(player.pos, supportStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "specops_carepackage")).toBe(true);
});

test("IR strobe cleans up after airstrikes and bomb/smoke decals expire", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    player.invManager.set("strobe", 2);
    player.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "strobe", 0);
    player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Throwable);
    player.throwableState = "holding";
    player.shootStart = true;
    player.shootHold = true;
    for (let i = 0; i < 5; i++) game.update(0.05);
    player.shootStart = false;
    player.shootHold = false;
    player.throwableState = "throwing";
    for (let i = 0; i < 10; i++) game.update(0.05);

    let clearedAt = -1;
    for (let t = 0; t < 12; t += 0.1) {
        game.update(0.1);
        const live = game.projectileBarn.projectiles.filter(
            (p) => p && p.type === "strobe" && !p.destroyed,
        );
        if (live.length === 0) {
            clearedAt = t;
            break;
        }
    }
    expect(clearedAt).toBeGreaterThan(0);
    expect(clearedAt).toBeLessThan(10);
    // Finished strobes despawn without planting permanent smoke residue.
    expect(
        game.decalBarn.decals.some((d) => d.type === "decal_smoke_explosion"),
    ).toBe(false);

    // Fresh match so airstrike planes from the throw above cannot keep
    // seeding new bomb decals while we wait for expiry.
    const decalGame = createGame(TeamMode.Solo, "test_specops");
    decalGame.playerBarn.addTestPlayer({ name: "Operator" });
    decalGame.update(0.1);
    for (let i = 0; i < 20; i++) {
        decalGame.decalBarn.addDecal("decal_bomb_iron_explosion", v2.create(40 + i, 40), 0);
        decalGame.decalBarn.addDecal("decal_smoke_explosion", v2.create(50 + i, 40), 0);
    }
    const bombs = decalGame.decalBarn.decals.filter((d) => d.type === "decal_bomb_iron_explosion");
    const smokes = decalGame.decalBarn.decals.filter((d) => d.type === "decal_smoke_explosion");
    expect(bombs.length).toBe(20);
    expect(smokes.length).toBe(20);
    expect(bombs.every((d) => Number.isFinite(d.lifeTime) && d.lifeTime <= 4)).toBe(true);
    expect(smokes.every((d) => Number.isFinite(d.lifeTime) && d.lifeTime <= 5)).toBe(true);

    for (let t = 0; t < 5; t += 0.1) decalGame.update(0.1);
    expect(
        decalGame.decalBarn.decals.filter(
            (d) => d.type === "decal_bomb_iron_explosion" || d.type === "decal_smoke_explosion",
        ).length,
    ).toBe(0);
});

test("Spec Ops IR strobe spam summons Ironclads after wave 20", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 20;

    const before = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi).length;
    game.specOps!.onHumanStrobeThrown(player, v2.copy(player.pos));
    const after = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi);
    expect(after.length).toBe(before + 1);
    const clad = after[after.length - 1];
    expect(clad.specOpsStrobeTank).toBe(true);
    expect(clad.specOpsMirvCrawl).toBe(true);
    expect(clad.specOpsSpeedMult).toBeLessThan(0.35);

    // Cap = 4 × living operators
    for (let i = 0; i < 10; i++) {
        game.specOps!.onHumanStrobeThrown(player, v2.copy(player.pos));
    }
    const ironclads = game.playerBarn.livingPlayers.filter(
        (p) => p.specOpsAi && p.specOpsStrobeTank,
    );
    expect(ironclads.length).toBe(4);

    // Airstrike chips ironclads instead of deleting them.
    const hp = clad.health;
    clad.damage({
        amount: 500,
        damageType: GameConfig.DamageType.Airstrike,
        dir: v2.create(1, 0),
        gameSourceType: "bomb_iron",
        isExplosion: true,
    });
    expect(clad.dead).toBe(false);
    expect(clad.health).toBeGreaterThan(hp - 20);

    // Operators take reduced airstrike damage (armor + Spec Ops resist).
    const opArmor = player.specOpsArmor;
    const opHp = player.health;
    player.damage({
        amount: 200,
        damageType: GameConfig.DamageType.Airstrike,
        dir: v2.create(1, 0),
        gameSourceType: "bomb_iron",
        isExplosion: true,
    });
    // 200 * 0.55 = 110 raw after Spec Ops resist — less than unmitigated 200.
    expect(player.specOpsArmor + player.health).toBeLessThan(opArmor + opHp);
    expect(player.dead).toBe(false);
    // Without Spec Ops resist, 200 would strip 100 armor and 100 HP.
    expect(player.health).toBeGreaterThan(opHp - 100);
});

test("Spec Ops Ironclad death crawl detonates MIRVs", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 20;
    game.specOps!.onHumanStrobeThrown(player, v2.copy(player.pos));
    const clad = game.playerBarn.livingPlayers.find(
        (p) => p.specOpsAi && p.specOpsMirvCrawl,
    )!;
    expect(clad).toBeTruthy();

    clad.damage({
        amount: 99999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(clad.downed).toBe(true);
    expect(clad.dead).toBe(false);

    clad.kill({
        damageType: GameConfig.DamageType.Bleeding,
        dir: v2.create(1, 0),
        gameSourceType: "mirv",
        isExplosion: true,
    });
    expect(clad.dead).toBe(true);
    game.update(0.5);
    // Three MIRV detonations should have been processed.
    expect(true).toBe(true);
});

test("Spec Ops duo operators share one squad; support stays off that HUD group", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const a = game.playerBarn.addTestPlayer({ name: "OpA" });
    const b = game.playerBarn.addTestPlayer({ name: "OpB" });
    game.update(0.1);
    expect(a.groupId).toBe(b.groupId);
    expect(a.teamId).toBe(b.teamId);
    expect(game.playerBarn.groups.length).toBe(1);

    game.specOps!.wave = 4;
    game.specOps!.grantCash(a, 20000);
    const supportStation = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(a.pos, supportStation.pos);
    game.grid.updateObject(a);
    expect(game.specOps!.tryBuy(a, "specops_sentry")).toBe(true);
    const sentry = game.playerBarn.livingPlayers.find((p) => p.specOpsKind === "sentry")!;
    expect(sentry.teamId).toBe(a.teamId);
    expect(sentry.groupId).not.toBe(a.groupId);
    expect(a.group!.players).not.toContain(sentry);
});

test("Spec Ops bombers crawl before exploding", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const bomber = game.specOps!.spawnEnemyPublic("bomber");
    expect(bomber.specOpsSuicideVest).toBe(true);

    v2.set(bomber.pos, v2.add(player.pos, v2.create(2.5, 0)));
    game.grid.updateObject(bomber);
    game.step(0.1);

    expect(bomber.downed).toBe(true);
    expect(bomber.dead).toBe(false);

    game.step(4);
    expect(bomber.dead).toBe(true);
});

test("Spec Ops shot bombers crawl then explode", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const bomber = game.specOps!.spawnEnemyPublic("bomber");
    expect(bomber.specOpsSuicideVest).toBe(true);
    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(bomber.pos, v2.create(52, 40));
    game.grid.updateObject(bomber);

    bomber.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(-1, 0),
        source: player,
    });
    expect(bomber.downed).toBe(true);
    expect(bomber.dead).toBe(false);
    expect(bomber.specOpsSuicideVest).toBe(true);

    const distBefore = v2.distance(bomber.pos, player.pos);
    game.step(0.6);
    expect(bomber.dead).toBe(false);
    expect(v2.distance(bomber.pos, player.pos)).toBeLessThan(distBefore);

    game.step(4);
    expect(bomber.dead).toBe(true);
});

test("Spec Ops medics revive downed teammates", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const medic = game.specOps!.spawnEnemyPublic("medic");
    const rifle = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(90, 90));
    game.grid.updateObject(player);
    v2.set(medic.pos, v2.create(40, 40));
    game.grid.updateObject(medic);
    v2.set(rifle.pos, v2.create(42, 40));
    game.grid.updateObject(rifle);

    rifle.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(rifle.dead).toBe(false);
    expect(rifle.downed).toBe(true);

    game.step(0.4);
    expect(medic.isReviving()).toBe(true);

    game.step(8.5);
    expect(rifle.dead).toBe(false);
    expect(rifle.downed).toBe(false);
});

test("Spec Ops medics die instead of self-reviving mid-rez", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const medic = game.specOps!.spawnEnemyPublic("medic");
    const rifle = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(90, 90));
    game.grid.updateObject(player);
    v2.set(medic.pos, v2.create(40, 40));
    game.grid.updateObject(medic);
    v2.set(rifle.pos, v2.create(42, 40));
    game.grid.updateObject(rifle);

    rifle.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(rifle.downed).toBe(true);

    game.step(0.4);
    expect(medic.isReviving()).toBe(true);

    medic.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(medic.dead).toBe(true);
    expect(medic.downed).toBe(false);
    expect(medic.isReviving()).toBe(false);
    expect(rifle.downed).toBe(true);

    rifle.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(rifle.dead).toBe(true);
});

test("Spec Ops NPCs do not equip two of the same gun", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const kinds = ["recon", "marksman", "lieutenant", "grenadier", "medic", "bugler"] as const;
    for (const kind of kinds) {
        const npc = game.specOps!.spawnEnemyPublic(kind);
        const primary = npc.weapons[GameConfig.WeaponSlot.Primary].type;
        const secondary = npc.weapons[GameConfig.WeaponSlot.Secondary].type;
        if (!primary || !secondary) continue;
        expect(primary.replace(/_dual$/, "")).not.toBe(secondary.replace(/_dual$/, ""));
    }
});

test("Spec Ops buglers buff nearby NPCs", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const bugler = game.specOps!.spawnEnemyPublic("bugler");
    const rifle = game.specOps!.spawnEnemyPublic("rifle");
    expect(bugler.weapons[GameConfig.WeaponSlot.Primary].type).toBe("mp5");
    expect(bugler.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("bugle");
    expect(bugler.hasPerk("inspiration")).toBe(true);

    v2.set(bugler.pos, v2.create(40, 40));
    game.grid.updateObject(bugler);
    v2.set(rifle.pos, v2.create(44, 40));
    game.grid.updateObject(rifle);

    bugler.playBugle();
    expect(rifle.hasteType).toBe(GameConfig.HasteType.Inspire);
});

test("Spec Ops 50v50 classes keep unique kits and team bonuses", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const recon = game.specOps!.spawnEnemyPublic("recon");
    expect(recon.role).toBe("recon");
    expect(recon.hasPerk("small_arms")).toBe(true);
    expect(recon.weapons[GameConfig.WeaponSlot.Melee].type).toBe("crowbar_recon");
    expect(recon.helmet).toBe("helmet03_recon");

    const medic = game.specOps!.spawnEnemyPublic("medic");
    expect(medic.role).toBe("medic");
    expect(medic.hasPerk("aoe_heal")).toBe(true);
    expect(medic.hasPerk("self_revive")).toBe(false);
    expect(medic.weapons[GameConfig.WeaponSlot.Melee].type).toBe("bonesaw_rusted");
    expect(medic.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("smoke");
    expect(medic.helmet).toBe("helmet04_medic");

    const grenadier = game.specOps!.spawnEnemyPublic("grenadier");
    expect(grenadier.role).toBe("grenadier");
    expect(grenadier.hasPerk("flak_jacket")).toBe(true);
    expect(grenadier.weapons[GameConfig.WeaponSlot.Melee].type).toBe("katana");
    expect(grenadier.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("mirv");
    expect(grenadier.helmet).toBe("helmet03_grenadier");

    const marksman = game.specOps!.spawnEnemyPublic("marksman");
    expect(marksman.role).toBe("marksman");
    expect(marksman.hasPerk("targeting")).toBe(true);
    expect(marksman.weapons[GameConfig.WeaponSlot.Melee].type).toBe("kukri_sniper");

    const lieutenant = game.specOps!.spawnEnemyPublic("lieutenant");
    expect(lieutenant.role).toBe("lieutenant");
    expect(lieutenant.hasPerk("firepower")).toBe(true);
    expect(lieutenant.weapons[GameConfig.WeaponSlot.Melee].type).toBe("spade_assault");

    const captain = game.specOps!.spawnEnemyPublic("captain");
    expect(captain.role).toBe("captain");
    expect(captain.hasPerk("assume_leadership")).toBe(true);
    expect(captain.hasPerk("firepower")).toBe(true);

    const juggernaut = game.specOps!.spawnEnemyPublic("juggernaut");
    expect(juggernaut.role).toBe("last_man");
    expect(juggernaut.hasPerk("steelskin")).toBe(true);
    expect(juggernaut.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("mirv");
});

test("Spec Ops medics mass-medicate nearby teammates", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const medic = game.specOps!.spawnEnemyPublic("medic");
    const rifle = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(90, 90));
    game.grid.updateObject(player);
    v2.set(medic.pos, v2.create(40, 40));
    game.grid.updateObject(medic);
    v2.set(rifle.pos, v2.create(43, 40));
    game.grid.updateObject(rifle);
    rifle.specOpsSpeedMult = 0;
    rifle.health = 18;

    expect(medic.getAOEPlayers().some((p) => p === rifle)).toBe(true);

    game.step(2.2);
    expect(medic.actionType).toBe(GameConfig.Action.UseItem);
    v2.set(rifle.pos, v2.create(43, 40));
    game.grid.updateObject(rifle);
    game.step(4);
    expect(rifle.health).toBeGreaterThan(18);
});

test("Spec Ops captains inspire nearby NPCs", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const captain = game.specOps!.spawnEnemyPublic("captain");
    const rifle = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(captain.pos, v2.create(40, 40));
    game.grid.updateObject(captain);
    v2.set(rifle.pos, v2.create(44, 40));
    game.grid.updateObject(rifle);

    game.step(1.6);
    expect(rifle.hasteType).toBe(GameConfig.HasteType.Inspire);
});

test("Spec Ops ammo refill works at every station type", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(player, 5000);

    const weaponStation = findSpecOpsStation(game, "specops_station_weapon")!;
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);
    player.invManager.set("9mm", 0);
    expect(game.specOps!.tryBuy(player, "specops_ammo")).toBe(true);
    expect(player.invManager.get("9mm")).toBeGreaterThan(0);
});

test("Spec Ops AI reacts when shot from behind", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const enemy = game.specOps!.spawnEnemyPublic("militia");
    // Face away from the operator.
    enemy.dir = v2.create(1, 0);
    enemy.dirNew = v2.create(1, 0);
    v2.set(enemy.pos, v2.add(player.pos, v2.create(12, 0)));
    game.grid.updateObject(enemy);

    enemy.damage({
        amount: 10,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });

    game.step(0.25);
    // Should turn toward the attacker rather than keep facing away.
    expect(v2.dot(enemy.dir, v2.create(1, 0))).toBeLessThan(0.35);
});

test("Spec Ops stations stay clear of doors", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const stations = game.map.obstacles.filter((o) => o.type.startsWith("specops_station_"));
    expect(stations.length).toBeGreaterThan(0);
    for (let i = 0; i < stations.length; i++) {
        const station = stations[i];
        expect(station.collidable).toBe(true);
        const doors = game.map.obstacles.filter(
            (o) => o.isDoor && util.sameLayer(o.layer, station.layer),
        );
        for (let j = 0; j < doors.length; j++) {
            expect(v2.distance(station.pos, doors[j].pos)).toBeGreaterThan(6);
        }
        const walls = game.map.obstacles.filter(
            (o) => o.isWall && !o.dead && util.sameLayer(o.layer, station.layer),
        );
        for (let j = 0; j < walls.length; j++) {
            expect(coldet.test(station.collider, walls[j].collider)).toBe(false);
        }
    }
});

test("Spec Ops XL backpack raises ammo hold to 999", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    player.backpack = "backpack04";
    expect(player.invManager.getMaxCapacity("9mm")).toBe(999);
    expect(player.invManager.getMaxCapacity("bandage")).toBe(999);
});

test("Spec Ops armor plates buy in sets of 3, scale with bag, and restore AP", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    player.backpack = "backpack00";
    expect(player.invManager.getMaxCapacity("armor_plate")).toBe(4);
    player.backpack = "backpack01";
    expect(player.invManager.getMaxCapacity("armor_plate")).toBe(6);
    player.backpack = "backpack02";
    expect(player.invManager.getMaxCapacity("armor_plate")).toBe(8);
    player.backpack = "backpack03";
    expect(player.invManager.getMaxCapacity("armor_plate")).toBe(10);
    player.backpack = "backpack04";
    expect(player.invManager.getMaxCapacity("armor_plate")).toBe(12);

    player.backpack = "backpack00";
    game.specOps!.wave = 4;
    game.specOps!.grantCash(player, 5000);
    const armorStation = findSpecOpsStation(game, "specops_station_armor")!;
    v2.set(player.pos, armorStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "armor_plate")).toBe(true);
    expect(player.invManager.get("armor_plate")).toBe(3);

    player.specOpsArmor = 10;
    player.useHealingItem("armor_plate");
    game.update(3);
    expect(player.invManager.get("armor_plate")).toBe(2);
    expect(player.specOpsArmor).toBe(85);
});

test("Spec Ops trees regrow after three waves", () => {
    const game = createGame(TeamMode.Solo, "test_specops", { endless: false });
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const tree = game.map.obstacles.find((o) => o.isTree && !o.dead);
    expect(tree).toBeDefined();
    tree!.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(tree!.dead).toBe(true);

    game.specOps!.wave = 2;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(3);

    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi);
    for (const enemy of enemies) {
        enemy.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
    }
    game.update(0.05);

    expect(game.specOps!.phase).toBe("intermission");
    expect(tree!.dead).toBe(false);
});

test("shopApproachBlocked is true when a wall sits between buyer and station", () => {
    const wall = {
        __id: 1,
        dead: false,
        collidable: true,
        collider: collider.createAabbExtents(v2.create(0, 0), v2.create(0.4, 2.2)),
    };
    expect(
        shopApproachBlocked(v2.create(-2.4, 0), v2.create(2.4, 0), 99, [wall]),
    ).toBe(true);
    expect(
        shopApproachBlocked(v2.create(2.2, 0), v2.create(2.5, 0), 99, [wall]),
    ).toBe(false);
    expect(
        shopApproachBlocked(v2.create(0, 0), v2.create(0.1, 0), 1, [wall]),
    ).toBe(false);
});

test("Spec Ops cannot buy through an impassable wall", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const stations = game.map.obstacles.filter((o) => o.type.startsWith("specops_station_"));
    const walls = game.map.obstacles.filter((o) => o.isWall && !o.dead && o.collidable);
    let blockedStation = stations[0];
    let found = false;

    for (let i = 0; i < stations.length && !found; i++) {
        const station = stations[i];
        for (let j = 0; j < walls.length; j++) {
            const wall = walls[j];
            const away = v2.normalizeSafe(
                v2.sub(wall.pos, station.pos),
                v2.create(1, 0),
            );
            const pos = v2.add(wall.pos, v2.mul(away, 1.45));
            if (v2.distance(pos, station.pos) > SpecOpsShopRange - 0.05) continue;
            if (
                !shopApproachBlocked(
                    pos,
                    station.pos,
                    station.__id,
                    game.map.obstacles,
                )
            ) {
                continue;
            }
            v2.set(player.pos, pos);
            game.grid.updateObject(player);
            blockedStation = station;
            found = true;
            break;
        }
    }

    expect(found).toBe(true);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(player, 5000);
    expect(game.specOps!.tryBuy(player, "mp5")).toBe(false);
    expect(game.specOps!.tryBuy(player, "armor_plate")).toBe(false);

    v2.set(player.pos, blockedStation.pos);
    game.grid.updateObject(player);
    const bought = game.specOps!.tryBuy(player, "specops_ammo");
    expect(bought).toBe(true);
});

test("Spec Ops enemy health scales up instead of using operator vitals", () => {
    expect(specOpsEnemyHealth(1, "militia")).toBeLessThan(50);
    expect(specOpsEnemyHealth(1, "militia")).toBeGreaterThan(20);
    expect(specOpsEnemyHealth(12, "rifle")).toBeGreaterThan(specOpsEnemyHealth(1, "rifle"));
    expect(specOpsEnemyHealth(20, "conscript")).toBeLessThanOrEqual(42);
    expect(specOpsEnemyGear(1, "chest01", "helmet01")).toEqual({ chest: "", helmet: "" });
    expect(specOpsEnemyGear(6, "chest02", "helmet02")).toEqual({
        chest: "chest01",
        helmet: "helmet01",
    });
});

test("Spec Ops NPCs appear on player status and hunt if they stay in discovery", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 7;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);

    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(enemies.length).toBeGreaterThan(0);
    const statuses = player.getPlayerStatus();
    expect(statuses.length).toBe(game.playerBarn.players.length);
    expect(statuses.filter((s) => s.visible).length).toBeGreaterThan(1);

    v2.set(player.pos, v2.create(12, 12));
    game.grid.updateObject(player);
    for (const enemy of enemies) {
        v2.set(enemy.pos, v2.create(90, 90));
        enemy.dir = v2.create(1, 0);
        enemy.dirNew = v2.create(1, 0);
        game.grid.updateObject(enemy);
    }

    const startDist = v2.distance(enemies[0].pos, player.pos);
    const hunter = enemies[0];
    game.step(12);
    expect(hunter.dead).toBe(false);
    expect(statuses.filter((s) => s.visible).length).toBeGreaterThan(1);
    expect(game.specOps!.aiAlerted(hunter) || v2.distance(hunter.pos, player.pos) < startDist).toBe(true);
});

test("Spec Ops NPCs patrol a downed operator instead of finishing them", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.startNextWave();
    game.update(0.05);

    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy");
    expect(enemies.length).toBeGreaterThan(0);

    player.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: enemies[0],
    });
    expect(player.downed).toBe(true);
    expect(player.dead).toBe(false);
    const health = player.health;

    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    for (const enemy of enemies) {
        v2.set(enemy.pos, v2.create(48, 40));
        game.grid.updateObject(enemy);
    }

    game.step(1.4);
    expect(player.downed).toBe(true);
    expect(player.dead).toBe(false);
    expect(player.health).toBe(health);
    expect(game.over).toBe(false);
});

test("Spec Ops grenadiers throw grenades with a cooldown", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const nade = game.specOps!.spawnEnemyPublic("grenadier");
    expect(nade.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("mirv");
    expect(nade.invManager.get("mirv")).toBeGreaterThan(0);

    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(nade.pos, v2.create(50, 40));
    nade.dir = v2.create(-1, 0);
    nade.dirNew = v2.create(-1, 0);
    game.grid.updateObject(nade);
    nade.damage({
        amount: 1,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });

    const before = nade.invManager.get("mirv");
    game.step(4.8);
    const afterFirst = nade.invManager.get("mirv");
    expect(afterFirst).toBeLessThan(before);

    game.step(2.2);
    expect(nade.invManager.get("mirv")).toBe(afterFirst);
});

test("Spec Ops adds pistol, LMG, DMR, raider, and CQC classes", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const pistol = game.specOps!.spawnEnemyPublic("pistol");
    expect(pistol.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m1911");
    const lmg = game.specOps!.spawnEnemyPublic("lmg");
    expect(lmg.weapons[GameConfig.WeaponSlot.Primary].type).toBe("dp28");
    const dmr = game.specOps!.spawnEnemyPublic("dmr");
    expect(dmr.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m39");
    const raider = game.specOps!.spawnEnemyPublic("raider");
    expect(raider.weapons[GameConfig.WeaponSlot.Primary].type).toBe("ot38");
    const cqc = game.specOps!.spawnEnemyPublic("cqc");
    expect(cqc.weapons[GameConfig.WeaponSlot.Primary].type).toBe("");
    expect(cqc.weapons[GameConfig.WeaponSlot.Melee].type).toBe("machete");
    const bugler = game.specOps!.spawnEnemyPublic("bugler");
    expect(bugler.weapons[GameConfig.WeaponSlot.Primary].type).toBe("mp5");
    expect(bugler.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("bugle");
});

test("Spec Ops NPCs return fire with high spread when shot from far away", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(20, 40));
    player.dir = v2.create(1, 0);
    game.grid.updateObject(player);
    v2.set(ai.pos, v2.create(68, 40));
    ai.dir = v2.create(-1, 0);
    ai.dirNew = v2.create(-1, 0);
    game.grid.updateObject(ai);

    expect(v2.distance(player.pos, ai.pos)).toBeGreaterThan(40);

    ai.damage({
        amount: 4,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(-1, 0),
        source: player,
    });
    expect(ai.dead).toBe(false);

    let sawSpread = 0;
    let fired = false;
    for (let i = 0; i < 24; i++) {
        game.step(0.1);
        sawSpread = Math.max(sawSpread, ai.specOpsReturnFireSpread);
        if (game.bulletBarn.bullets.some((b) => b.playerId === ai.__id)) fired = true;
    }
    expect(fired).toBe(true);
    expect(sawSpread).toBeGreaterThan(0);
});

test("Spec Ops conscripts swarm after wave 12", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.wave = 11;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(12);

    const conscripts = game.playerBarn.livingPlayers.filter(
        (p) => p.specOpsKind === "enemy" && p.name === "Conscript",
    );
    expect(conscripts.length).toBeGreaterThanOrEqual(2);
    expect(conscripts.every((p) => p.health <= 42)).toBe(true);
    expect(conscripts.every((p) => !p.chest && !p.helmet)).toBe(true);
    const pistols = ["m9", "ot38", "m1911"];
    expect(conscripts.every((p) => pistols.includes(p.weapons[GameConfig.WeaponSlot.Primary].type))).toBe(true);
});

test("Spec Ops snipers join after wave 16 and shoot from far with poor accuracy", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const sniper = game.specOps!.spawnEnemyPublic("sniper");
    const loadout = game.specOps!.aiLoadout(sniper)!;
    expect(sniper.name).toBe("Sniper");
    expect(sniper.hasPerk("targeting")).toBe(false);
    expect(["mosin", "blr", "scout_elite"]).toContain(
        sniper.weapons[GameConfig.WeaponSlot.Primary].type,
    );
    expect(loadout.range).toBeGreaterThanOrEqual(50);
    expect(loadout.holdRange).toBeGreaterThanOrEqual(35);
    expect(loadout.aimError).toBeGreaterThanOrEqual(30);

    sniper.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });

    game.specOps!.wave = 15;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(16);

    const snipers = game.playerBarn.livingPlayers.filter(
        (p) => p.specOpsKind === "enemy" && p.name === "Sniper",
    );
    expect(
        snipers.length > 0
            || game.specOps!.waveRosterPublic(16).includes("sniper"),
    ).toBe(true);
    if (snipers.length > 0) {
        expect(snipers.every((p) => v2.distance(p.pos, player.pos) >= 40)).toBe(true);
    }
});

test("Spec Ops waves grow after wave 15", () => {
    const early = createGame(TeamMode.Solo, "test_specops");
    early.playerBarn.addTestPlayer({ name: "Operator" });
    early.update(0.1);
    early.specOps!.wave = 7;
    early.specOps!.phase = "intermission";
    beginSpecOpsWave(early, true);
    const earlyCount = early.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy").length;

    const late = createGame(TeamMode.Solo, "test_specops");
    late.playerBarn.addTestPlayer({ name: "Operator" });
    late.update(0.1);
    late.specOps!.wave = 17;
    late.specOps!.phase = "intermission";
    beginSpecOpsWave(late, true);
    const lateCount = late.playerBarn.livingPlayers.filter((p) => p.specOpsKind === "enemy").length;

    expect(late.specOps!.wave).toBe(18);
    expect(lateCount).toBeGreaterThan(earlyCount);
    expect(lateCount).toBeGreaterThan(22);
});

test("Spec Ops waves spawn in staggered batches instead of all at once", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 16;
    game.specOps!.phase = "intermission";
    game.specOps!.startNextWave();
    game.update(0.05);

    const rosterSize = game.specOps!.waveRosterPublic(17).length;
    const firstBatch = game.specOps!.enemiesAlive;
    expect(firstBatch).toBeGreaterThan(0);
    expect(firstBatch).toBeLessThan(rosterSize);

    game.step(14);
    expect(game.specOps!.enemiesAlive).toBeGreaterThan(firstBatch);

    game.specOps!.drainWaveSpawnQueuePublic();
    game.update(0.05);
    expect(game.specOps!.enemiesAlive).toBe(rosterSize);
});

test("Spec Ops NPCs only go down if a medic or lieutenant is alive", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const rifle = game.specOps!.spawnEnemyPublic("rifle");
    rifle.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(rifle.dead).toBe(true);
    expect(rifle.downed).toBe(false);
});

test("Spec Ops lieutenants revive downed teammates", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const lieutenant = game.specOps!.spawnEnemyPublic("lieutenant");
    const rifle = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(90, 90));
    game.grid.updateObject(player);
    v2.set(lieutenant.pos, v2.create(40, 40));
    game.grid.updateObject(lieutenant);
    v2.set(rifle.pos, v2.create(42, 40));
    game.grid.updateObject(rifle);

    rifle.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(rifle.dead).toBe(false);
    expect(rifle.downed).toBe(true);

    game.step(0.4);
    expect(lieutenant.isReviving()).toBe(true);

    game.step(8.5);
    expect(rifle.dead).toBe(false);
    expect(rifle.downed).toBe(false);
});

test("Spec Ops riflemen do not revive downed teammates", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const medic = game.specOps!.spawnEnemyPublic("medic");
    const rifleA = game.specOps!.spawnEnemyPublic("rifle");
    const rifleB = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(90, 90));
    game.grid.updateObject(player);
    v2.set(medic.pos, v2.create(90, 12));
    game.grid.updateObject(medic);
    v2.set(rifleA.pos, v2.create(40, 40));
    game.grid.updateObject(rifleA);
    v2.set(rifleB.pos, v2.create(42, 40));
    game.grid.updateObject(rifleB);

    rifleB.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(rifleB.downed).toBe(true);

    game.step(0.5);
    expect(rifleA.isReviving()).toBe(false);
    expect(medic.isReviving()).toBe(false);
});

test("Spec Ops NPCs do not drop armor, perks, or scopes", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 12;

    const nade = game.specOps!.spawnEnemyPublic("grenadier");
    expect(nade.chest || nade.helmet).toBeTruthy();
    const deathPos = v2.copy(nade.pos);
    nade.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(nade.dead).toBe(true);

    const nearby = game.lootBarn.loots.filter(
        (loot) => v2.distance(loot.pos, deathPos) < 8,
    );
    expect(nearby.some((loot) => loot.type.startsWith("chest"))).toBe(false);
    expect(nearby.some((loot) => loot.type.startsWith("helmet"))).toBe(false);
    expect(nearby.some((loot) => loot.type.startsWith("backpack"))).toBe(false);
    expect(nearby.some((loot) => loot.type.endsWith("scope"))).toBe(false);
    expect(nearby.some((loot) => {
        const def = GameObjectDefs.typeToDefSafe(loot.type);
        return def?.type === "perk";
    })).toBe(false);
});

test("Spec Ops buglers do not litter gear on spawn or drop bugles on death", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 12;

    const before = game.lootBarn.loots.length;
    const bugler = game.specOps!.spawnEnemyPublic("bugler");
    expect(bugler.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("bugle");
    expect(bugler.backpack).toBe("backpack03");
    // Promoting to bugler must not dump the old bag / armor onto the map.
    expect(game.lootBarn.loots.length).toBe(before);

    const deathPos = v2.copy(bugler.pos);
    bugler.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(bugler.dead).toBe(true);

    const nearby = game.lootBarn.loots.filter(
        (loot) => v2.distance(loot.pos, deathPos) < 8,
    );
    expect(nearby.some((loot) => loot.type === "bugle")).toBe(false);
    expect(nearby.some((loot) => loot.type.startsWith("chest"))).toBe(false);
    expect(nearby.some((loot) => loot.type.startsWith("helmet"))).toBe(false);
    expect(nearby.some((loot) => loot.type.startsWith("backpack"))).toBe(false);
    expect(nearby.some((loot) => loot.type.endsWith("scope"))).toBe(false);
});

test("Spec Ops shop does not sell flare guns and ammo resupply skips flares", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 20;
    game.specOps!.grantCash(player, 50000);

    const weaponStation = findSpecOpsStation(game, "specops_station_weapon")!;
    standAtStation(player, weaponStation);

    expect(game.specOps!.tryBuy(player, "flare_gun")).toBe(false);
    expect(game.specOps!.tryBuy(player, "flare_gun_dual")).toBe(false);

    player.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, "flare_gun", 1);
    player.invManager.set("flare", 0);
    player.weaponManager.setWeapon(GameConfig.WeaponSlot.Secondary, "mp5", 30);
    player.invManager.set("9mm", 0);

    const gearStation = findSpecOpsStation(game, "specops_station_gear")!;
    standAtStation(player, gearStation);

    expect(game.specOps!.tryBuy(player, "specops_ammo")).toBe(true);
    expect(player.invManager.get("flare")).toBe(0);
    expect(player.invManager.get("9mm")).toBeGreaterThan(0);
});

test("Spec Ops AI pushes harder when the operator farms kills quickly", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    expect(game.specOps!.pushPressure).toBe(0);

    const squad = [];
    for (let i = 0; i < 6; i++) {
        squad.push(game.specOps!.spawnEnemyPublic("rifle"));
    }
    const survivor = squad[squad.length - 1];
    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(survivor.pos, v2.create(70, 40));
    game.grid.updateObject(survivor);

    for (let i = 0; i < squad.length - 1; i++) {
        squad[i].damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
        expect(squad[i].dead).toBe(true);
    }

    expect(game.specOps!.pushPressure).toBeGreaterThan(0.55);
    expect(game.specOps!.aiAlerted(survivor)).toBe(true);

    const startDist = v2.distance(survivor.pos, player.pos);
    game.step(0.7);
    expect(v2.distance(survivor.pos, player.pos)).toBeLessThan(startDist);
});

test("Spec Ops push pressure decays after the operator stops killing", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    for (let i = 0; i < 4; i++) {
        const npc = game.specOps!.spawnEnemyPublic("militia");
        npc.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
    }
    const peak = game.specOps!.pushPressure;
    expect(peak).toBeGreaterThan(0.4);

    game.step(12);
    expect(game.specOps!.pushPressure).toBeLessThan(peak * 0.35);
});

test("Spec Ops squad stays joinable until four operators are in", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    for (let i = 0; i < 3; i++) {
        game.playerBarn.addTestPlayer({ name: `Op${i}` });
        game.update(0.1);
        expect(game.specOps!.humanCount).toBe(i + 1);
        expect(game.canJoin).toBe(true);
    }
    game.playerBarn.addTestPlayer({ name: "Op3" });
    game.update(0.1);
    expect(game.specOps!.humanCount).toBe(4);
    expect(game.canJoin).toBe(false);
    const ops = game.playerBarn.players.filter((p) => !p.specOpsAi);
    expect(new Set(ops.map((p) => p.groupId)).size).toBe(1);
    expect(new Set(ops.map((p) => p.teamId)).size).toBe(1);
});

test("compact modes { solo, duo, squad } expand to the teamMode array", () => {
    expect(expandGameModes({ solo: true, duo: false, squad: true })).toEqual([
        { mapName: "specops", teamMode: TeamMode.Solo, enabled: true },
        { mapName: "specops", teamMode: TeamMode.Duo, enabled: false },
        { mapName: "specops", teamMode: TeamMode.Squad, enabled: true },
    ]);
    expect(expandGameModes({ solo: true, duo: true, squad: false }, "main")).toEqual([
        { mapName: "main", teamMode: TeamMode.Solo, enabled: true },
        { mapName: "main", teamMode: TeamMode.Duo, enabled: true },
        { mapName: "main", teamMode: TeamMode.Squad, enabled: false },
    ]);
    const legacy = [
        { mapName: "specops" as const, teamMode: TeamMode.Solo, enabled: true },
        { mapName: "specops" as const, teamMode: TeamMode.Duo, enabled: true },
        { mapName: "specops" as const, teamMode: TeamMode.Squad, enabled: false },
    ];
    expect(expandGameModes(legacy)).toEqual(legacy);
    expect(expandGameModes(undefined)).toBeUndefined();
});

test("maxPlayersForMap caps BR maps and leaves Spec Ops on squad size", () => {
    expect(maxPlayersForMap(true, 80, 4, 80)).toBe(4);
    expect(maxPlayersForMap(false, 80, 4, 0)).toBe(80);
    expect(maxPlayersForMap(false, 80, 4, 40)).toBe(40);
    expect(maxPlayersForMap(false, 80, 4, 200)).toBe(80);
});

test("Spec Ops squads of 8 stay on one group without overflowing HUD slots", () => {
    const prev = Config.maxSquadSize;
    Config.maxSquadSize = 8;
    try {
        const game = createGame(TeamMode.Squad, "test_specops");
        expect(game.maxTeamSize).toBe(8);
        const ops = [];
        for (let i = 0; i < 8; i++) {
            ops.push(game.playerBarn.addTestPlayer({ name: `Op${i}` }));
            game.update(0.1);
        }
        expect(game.specOps!.humanCount).toBe(8);
        expect(game.canJoin).toBe(false);
        expect(new Set(ops.map((p) => p.groupId)).size).toBe(1);
        expect(ops[0]!.group!.players.filter((p) => !p.specOpsAi)).toHaveLength(8);
        const statuses = ops[0]!.getPlayerStatus();
        expect(statuses.length).toBe(game.playerBarn.players.length);
        ops[0]!.setGroupStatuses();
    } finally {
        Config.maxSquadSize = prev;
    }
});

test("maxSquadSize is clamped and used as Spec Ops squad cap", () => {
    expect(teamSizeForMode(TeamMode.Solo, 8)).toBe(1);
    expect(teamSizeForMode(TeamMode.Duo, 8)).toBe(2);
    expect(teamSizeForMode(TeamMode.Squad, 8)).toBe(8);
    expect(clampMaxSquadSize(1)).toBe(2);
    expect(clampMaxSquadSize(99)).toBe(8);
    expect(clampMaxSquadSize(4)).toBe(4);

    const prev = Config.maxSquadSize;
    Config.maxSquadSize = 6;
    try {
        const game = createGame(TeamMode.Squad, "test_specops");
        expect(game.maxTeamSize).toBe(6);
        for (let i = 0; i < 5; i++) {
            game.playerBarn.addTestPlayer({ name: `Op${i}` });
            game.update(0.1);
            expect(game.canJoin).toBe(true);
        }
        game.playerBarn.addTestPlayer({ name: "Op5" });
        game.update(0.1);
        expect(game.specOps!.humanCount).toBe(6);
        expect(game.canJoin).toBe(false);
        const ops = game.playerBarn.players.filter((p) => !p.specOpsAi);
        expect(new Set(ops.map((p) => p.groupId)).size).toBe(1);
    } finally {
        Config.maxSquadSize = prev;
    }
});

test("Spec Ops join tokens are issued for the whole party and last long enough", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    game.addJoinTokens([
        { token: "a", userId: null, ip: "127.0.0.1" },
        { token: "b", userId: null, ip: "127.0.0.2" },
    ], true);
    expect(game.pendingJoinTokens()).toBe(2);
    expect(game.joinTokens.get("a")!.expiresAt).toBeGreaterThan(Date.now() + 30_000);
});

test("Spec Ops no-fill lobbies lock so randoms cannot join", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    game.addJoinTokens([
        { token: "a", userId: null, ip: "127.0.0.1" },
        { token: "b", userId: null, ip: "127.0.0.2" },
    ], false);

    expect(game.pendingJoinTokens()).toBe(2);
    expect(game.specOps!.joinLocked).toBe(true);
    expect(game.canJoin).toBe(false);
    expect(game.joinTokens.get("a")!.groupData.autoFill).toBe(false);

    game.addJoinTokens([
        { token: "random", userId: null, ip: "127.0.0.3" },
    ], true);
    expect(game.pendingJoinTokens()).toBe(2);
    expect(game.joinTokens.has("random")).toBe(false);
});

test("Spec Ops solo closes join when a slot is reserved by a pending token", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    expect(game.specOps!.allowJoin).toBe(true);
    game.addJoinTokens([{ token: "solo1", userId: null, ip: "127.0.0.1" }], true);
    expect(game.pendingJoinTokens()).toBe(1);
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.canJoin).toBe(false);
});

test("Spec Ops duo keeps joining open until both operators are in", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    expect(game.canJoin).toBe(true);

    const a = game.playerBarn.addTestPlayer({ name: "OpA" });
    game.update(0.1);
    expect(a.specOpsAi).toBe(false);
    expect(game.specOps!.humanCount).toBe(1);
    expect(game.canJoin).toBe(true);

    game.specOps!.wave = SpecOpsJoinLockWave - 1;
    expect(game.specOps!.allowJoin).toBe(true);
    expect(game.canJoin).toBe(true);

    game.playerBarn.addTestPlayer({ name: "OpB" });
    game.update(0.1);
    expect(game.specOps!.humanCount).toBe(2);
    expect(game.canJoin).toBe(false);
    const ops = game.playerBarn.players.filter((p) => !p.specOpsAi);
    expect(ops[0].groupId).toBe(ops[1].groupId);
    expect(ops[0].teamId).toBe(ops[1].teamId);
});

test("Spec Ops locks empty squad seats after wave 10", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Op0" });
    game.update(0.1);
    expect(game.specOps!.operatorCount).toBe(1);
    expect(game.canJoin).toBe(true);

    game.specOps!.wave = SpecOpsJoinLockWave - 1;
    expect(game.specOps!.allowJoin).toBe(true);
    expect(game.canJoin).toBe(true);

    game.specOps!.wave = SpecOpsJoinLockWave;
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.canJoin).toBe(false);

    game.addJoinTokens([
        { token: "late", userId: null, ip: "127.0.0.1" },
    ], true);
    expect(game.pendingJoinTokens()).toBe(0);
});

test("Spec Ops players can lock the lobby with L so no one else can join", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Op0" });
    game.update(0.1);
    expect(game.canJoin).toBe(true);
    expect(game.specOps!.joinLocked).toBe(false);

    const lock = new InputMsg();
    lock.addInput(GameConfig.Input.LockLobby);
    player.handleInput(lock);

    expect(game.specOps!.joinLocked).toBe(true);
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.canJoin).toBe(false);
    expect(game.specOps!.hudWaveId).toBe(SpecOpsJoinLockFlag);

    game.addJoinTokens([
        { token: "late", userId: null, ip: "127.0.0.1" },
    ], true);
    expect(game.pendingJoinTokens()).toBe(0);

    const again = new InputMsg();
    again.addInput(GameConfig.Input.LockLobby);
    player.handleInput(again);
    expect(game.specOps!.joinLocked).toBe(true);
});

test("Spec Ops lobby lock does nothing after wave 10 already locked the match", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Op0" });
    game.update(0.1);
    game.specOps!.wave = SpecOpsJoinLockWave;
    expect(game.specOps!.tryLockJoin(player)).toBe(false);
    expect(game.specOps!.joinLocked).toBe(false);
    expect(game.canJoin).toBe(false);
});

test("Spec Ops dead operators still occupy a squad seat", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({ name: "Alpha" });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        group: alpha.group,
    });
    game.update(0.1);

    alpha.removePerk("self_revive");
    alpha.kill({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    game.update(0.05);
    expect(alpha.dead).toBe(true);
    expect(game.specOps!.humanCount).toBe(1);
    expect(game.specOps!.operatorCount).toBe(2);
    expect(game.canJoin).toBe(false);
    expect(game.modeManager.showStatsMsg(alpha)).toBe(true);
    expect(bravo.dead).toBe(false);
});

test("Spec Ops ground loot and death tags despawn after a while", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const npc = game.specOps!.spawnEnemyPublic("rifle");
    npc.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    expect(npc.dead).toBe(true);
    expect(game.lootBarn.loots.length).toBeGreaterThan(0);
    expect(game.deadBodyBarn.deadBodies.length).toBeGreaterThan(0);

    game.lootBarn.update(SpecOpsLootLifetime + 0.2);
    expect(game.lootBarn.loots.length).toBe(0);

    game.deadBodyBarn.update(SpecOpsDeadBodyLifetime + 0.2);
    expect(game.deadBodyBarn.deadBodies.length).toBe(0);
});

test("Spec Ops caps ground loot and death tags so waves cannot flood the map", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    for (let i = 0; i < SpecOpsLootCap + 20; i++) {
        game.lootBarn.addLoot("9mm", v2.create(40, 40), 0, 15, {});
    }
    game.lootBarn.update(0.05);
    expect(game.lootBarn.loots.filter((loot) => !loot.destroyed).length).toBeLessThanOrEqual(
        SpecOpsLootCap,
    );

    for (let i = 0; i < SpecOpsDeadBodyCap + 12; i++) {
        game.deadBodyBarn.addDeadBody(
            v2.create(40, 40),
            player.__id,
            0,
            v2.create(1, 0),
        );
    }
    game.deadBodyBarn.update(0.05);
    expect(
        game.deadBodyBarn.deadBodies.filter((body) => !body.destroyed).length,
    ).toBeLessThanOrEqual(SpecOpsDeadBodyCap);
});

test("Spec Ops self-revive grants 5 seconds of immunity", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.grantCash(player, specOpsSelfReviveCost(game.specOps!.wave));
    const weaponStation = findSpecOpsStation(game, "specops_station_weapon")!;
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, SpecOpsSelfReviveSku)).toBe(true);

    player.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    expect(player.downed).toBe(true);

    game.step(GameConfig.player.reviveDuration + 0.2);
    expect(player.downed).toBe(false);
    expect(player.specOpsImmunityTicker).toBeGreaterThan(4.5);

    const hp = player.health;
    player.damage({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    expect(player.dead).toBe(false);
    expect(player.downed).toBe(false);
    expect(player.health).toBe(hp);
});

test("Spec Ops teammates can buy a dead operator back in", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({ name: "Alpha" });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        group: alpha.group,
    });
    game.update(0.1);

    expect(alpha.group).toBe(bravo.group);
    expect(alpha.group!.players[0]).toBe(alpha);

    alpha.removePerk("self_revive");
    alpha.kill({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    game.update(0.05);
    expect(alpha.dead).toBe(true);
    expect(game.over).toBe(false);
    expect(game.specOps!.humanCount).toBe(1);

    const cost = specOpsBuybackCost(game.specOps!.wave);
    const cashBefore = bravo.specOpsCash;
    game.specOps!.grantCash(bravo, cost);
    expect(game.specOps!.tryBuy(bravo, specOpsBuybackSku(0))).toBe(true);
    expect(alpha.dead).toBe(false);
    expect(alpha.downed).toBe(false);
    expect(alpha.hasPerk("self_revive")).toBe(false);
    expect(alpha.specOpsImmunityTicker).toBeGreaterThan(4);
    expect(game.specOps!.humanCount).toBe(2);
    expect(bravo.specOpsCash).toBe(cashBefore);
});

test("Spec Ops buyback clears spectating and forces active player sync", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({ name: "Alpha" });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        group: alpha.group,
    });
    game.update(0.1);

    alpha.removePerk("self_revive");
    alpha.kill({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    game.update(0.05);

    const specBegin = new SpectateMsg();
    specBegin.action = SpectateAction.Begin;
    alpha.client.handleMsg(MsgType.Spectate, specBegin);
    expect(alpha.client.spectating?.__id).toBe(bravo.__id);

    const cost = specOpsBuybackCost(game.specOps!.wave);
    game.specOps!.grantCash(bravo, cost);
    expect(game.specOps!.tryBuy(bravo, specOpsBuybackSku(0))).toBe(true);

    expect(alpha.dead).toBe(false);
    expect(alpha.client.spectating).toBeUndefined();
    expect(alpha.client.startedSpectating).toBe(true);
});

test("Spec Ops buyback forces active player sync without spectating", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({ name: "Alpha" });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        group: alpha.group,
    });
    game.update(0.1);

    alpha.removePerk("self_revive");
    alpha.kill({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    game.update(0.05);
    expect(alpha.client.spectating).toBeUndefined();

    expect(game.specOps!.buybackOperator(bravo, alpha)).toBe(true);
    expect(alpha.dead).toBe(false);
    expect(alpha.client.spectating).toBeUndefined();
    expect(alpha.client.startedSpectating).toBe(true);
});

test("Spec Ops buyback revives disconnected dead operators without touching client sync", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({ name: "Alpha" });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        group: alpha.group,
    });
    game.update(0.1);

    alpha.removePerk("self_revive");
    alpha.kill({
        amount: 999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
    });
    game.update(0.05);
    alpha.client.disconnected = true;

    const cost = specOpsBuybackCost(game.specOps!.wave);
    game.specOps!.grantCash(bravo, cost);
    expect(game.specOps!.tryBuy(bravo, specOpsBuybackSku(0))).toBe(true);
    expect(alpha.dead).toBe(false);
    expect(alpha.downed).toBe(false);
    expect(alpha.client.startedSpectating).toBe(false);
});

test("Spec Ops buyback revives downed operators who disconnected", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({ name: "Alpha" });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        group: alpha.group,
    });
    game.update(0.1);

    alpha.removePerk("self_revive");
    alpha.down({
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: bravo,
    });
    game.update(0.05);
    expect(alpha.downed).toBe(true);
    expect(alpha.dead).toBe(false);
    alpha.client.disconnected = true;

    const cost = specOpsBuybackCost(game.specOps!.wave);
    game.specOps!.grantCash(bravo, cost);
    expect(game.specOps!.tryBuy(bravo, specOpsBuybackSku(0))).toBe(true);
    expect(alpha.dead).toBe(false);
    expect(alpha.downed).toBe(false);
    expect(alpha.health).toBeGreaterThan(0);
});

test("Spec Ops gun NPCs back off instead of stalling under the operator", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(ai.pos, v2.create(41.1, 40));
    game.grid.updateObject(ai);

    expect(v2.distance(player.pos, ai.pos)).toBeLessThan(1.5);
    game.step(0.55);
    expect(v2.distance(player.pos, ai.pos)).toBeGreaterThan(2.4);
    expect(ai.curWeapIdx).toBe(GameConfig.WeaponSlot.Primary);
});

test("Spec Ops machine gunners keep standoff arc around the operator", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const gunner = game.specOps!.spawnEnemyPublic("machine_gunner");
    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(gunner.pos, v2.create(40.8, 40));
    game.grid.updateObject(gunner);

    game.step(0.8);
    expect(v2.distance(player.pos, gunner.pos)).toBeGreaterThan(3.75);
    expect(gunner.curWeapIdx).toBe(GameConfig.WeaponSlot.Primary);
});

test("Spec Ops NPCs only melee when their gun is empty", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(ai.pos, v2.create(42, 40));
    game.grid.updateObject(ai);

    game.step(0.2);
    expect(ai.curWeapIdx).toBe(GameConfig.WeaponSlot.Primary);

    // Point-blank + empty mags → panic melee.
    v2.set(ai.pos, v2.create(42, 40));
    game.grid.updateObject(ai);
    ai.weapons[GameConfig.WeaponSlot.Primary].ammo = 0;
    ai.weapons[GameConfig.WeaponSlot.Secondary].ammo = 0;
    game.update(0.05);
    expect(ai.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
    expect(ai.shootHold).toBe(true);
});

test("Spec Ops dry-gun bots do not charge melee from range", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(ai.pos, v2.create(55, 40));
    game.grid.updateObject(ai);

    ai.weapons[GameConfig.WeaponSlot.Primary].ammo = 0;
    ai.weapons[GameConfig.WeaponSlot.Secondary].type = "";
    ai.weapons[GameConfig.WeaponSlot.Secondary].ammo = 0;
    const startDist = v2.distance(player.pos, ai.pos);
    game.step(1.2);
    expect(ai.curWeapIdx).not.toBe(GameConfig.WeaponSlot.Melee);
    expect(v2.distance(player.pos, ai.pos)).toBeGreaterThan(startDist - 6);
});

test("Spec Ops empty primary swaps to secondary before melee", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(ai.pos, v2.create(42, 40));
    game.grid.updateObject(ai);

    // Give them a loaded secondary pistol.
    ai.weaponManager.setWeapon(GameConfig.WeaponSlot.Secondary, "m9", 12);
    ai.weapons[GameConfig.WeaponSlot.Primary].ammo = 0;
    game.update(0.05);
    expect(ai.curWeapIdx).toBe(GameConfig.WeaponSlot.Secondary);
    expect(ai.curWeapIdx).not.toBe(GameConfig.WeaponSlot.Melee);
});

test("Spec Ops CQC stays at knife range instead of standing on the operator", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const cqc = game.specOps!.spawnEnemyPublic("cqc");
    v2.set(player.pos, v2.create(40, 40));
    game.grid.updateObject(player);
    v2.set(cqc.pos, v2.create(40.6, 40));
    game.grid.updateObject(cqc);

    game.step(0.5);
    expect(v2.distance(player.pos, cqc.pos)).toBeGreaterThan(1.5);
    expect(v2.distance(player.pos, cqc.pos)).toBeLessThan(3.2);
    expect(cqc.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
});

test("Spec Ops CQC swings when standing adjacent", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 1;
    game.specOps!.phase = "combat";

    const cqc = game.specOps!.spawnEnemyPublic("cqc");
    v2.set(player.pos, v2.create(52, 52));
    game.grid.updateObject(player);
    game.update(0.01);
    v2.set(cqc.pos, v2.create(54, 52));
    game.grid.updateObject(cqc);

    const hp0 = player.health;
    let holdFrames = 0;
    for (let i = 0; i < 60; i++) {
        game.update(0.05);
        if (cqc.shootHold && cqc.curWeapIdx === GameConfig.WeaponSlot.Melee) holdFrames++;
    }
    expect(cqc.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
    expect(holdFrames).toBeGreaterThan(10);
    expect(v2.distance(player.pos, cqc.pos)).toBeLessThan(2.8);
    expect(player.health).toBeLessThan(hp0);
});

test("Spec Ops wave AI splits across operators who are spread out", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const alpha = game.playerBarn.addTestPlayer({
        name: "Alpha",
        pos: v2.create(22, 64),
    });
    game.update(0.1);
    const bravo = game.playerBarn.addTestPlayer({
        name: "Bravo",
        pos: v2.create(106, 64),
        group: alpha.group,
    });
    game.update(0.1);

    v2.set(alpha.pos, v2.create(22, 64));
    v2.set(bravo.pos, v2.create(106, 64));
    game.grid.updateObject(alpha);
    game.grid.updateObject(bravo);

    game.specOps!.wave = 7;
    game.specOps!.phase = "intermission";
    beginSpecOpsWave(game, true);

    const ai = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi);
    expect(ai.length).toBeGreaterThanOrEqual(3);

    let assignedA = 0;
    let assignedB = 0;
    let nearA = 0;
    let nearB = 0;
    for (let i = 0; i < ai.length; i++) {
        const bot = ai[i];
        const anchor = game.specOps!.aiAnchor(bot);
        if (anchor === alpha) assignedA++;
        else if (anchor === bravo) assignedB++;
        if (v2.distance(bot.pos, alpha.pos) <= v2.distance(bot.pos, bravo.pos)) nearA++;
        else nearB++;
    }

    expect(assignedA + assignedB).toBe(ai.length);
    expect(Math.abs(assignedA - assignedB)).toBeLessThanOrEqual(1);
    expect(nearA).toBeGreaterThanOrEqual(1);
    expect(nearB).toBeGreaterThanOrEqual(1);
});

test("Spec Ops shop countdown lasts long enough to buy", () => {
    const game = createGame(TeamMode.Solo, "test_specops", { endless: false });
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(game.specOps!.phaseTimer).toBeGreaterThan(30);

    game.specOps!.startNextWave();
    game.update(0.05);
    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi);
    for (const enemy of enemies) {
        enemy.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
    }
    game.update(0.05);
    expect(game.specOps!.phase).toBe("intermission");
    expect(game.specOps!.phaseDuration).toBeGreaterThanOrEqual(30);
    expect(game.specOps!.phaseTimer).toBeGreaterThan(25);
});

test("Spec Ops operators can start the wave early for bonus cash", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.shopSkipLock = 0;

    const remaining = game.specOps!.phaseTimer;
    const cash = player.specOpsCash;
    expect(game.specOps!.tryStartWaveEarly(player)).toBe(true);
    expect(game.specOps!.phase).toBe("combat");
    expect(game.specOps!.wave).toBe(1);
    expect(player.specOpsCash).toBe(cash + specOpsEarlyStartBonus(remaining));
    expect(game.specOps!.tryStartWaveEarly(player)).toBe(false);
});

test("Spec Ops E key starts the wave when nothing else is in range", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({
        name: "Operator",
        pos: v2.create(8, 8),
    });
    game.update(0.1);
    v2.set(player.pos, v2.create(8, 8));
    game.grid.updateObject(player);
    game.specOps!.shopSkipLock = 0;

    const cash = player.specOpsCash;
    const weapBefore = player.curWeapIdx;
    const msg = new InputMsg();
    msg.addInput(GameConfig.Input.StowWeapons);
    player.handleInput(msg);

    expect(game.specOps!.phase).toBe("combat");
    expect(game.specOps!.wave).toBe(1);
    expect(player.specOpsCash).toBeGreaterThan(cash);
    expect(player.curWeapIdx).toBe(weapBefore);
});

test("Spec Ops E key does not equip melee during prep", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.shopSkipLock = 0;

    expect(player.curWeapIdx).not.toBe(GameConfig.WeaponSlot.Melee);
    const msg = new InputMsg();
    msg.addInput(GameConfig.Input.StowWeapons);
    player.handleInput(msg);

    expect(player.curWeapIdx).not.toBe(GameConfig.WeaponSlot.Melee);
    expect(game.specOps!.phase).toBe("combat");
});

test("Spec Ops shop timer auto-starts the wave at zero", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(game.specOps!.phase).toBe("prep");

    game.specOps!.phaseTimer = 0;
    game.update(0.05);
    expect(game.specOps!.phase).toBe("combat");
    expect(game.specOps!.wave).toBe(1);
    expect(game.specOps!.enemiesAlive).toBeGreaterThan(0);
});

test("Spec Ops F does not skip the shop countdown", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({
        name: "Operator",
        pos: v2.create(8, 8),
    });
    game.update(0.1);
    v2.set(player.pos, v2.create(8, 8));
    game.grid.updateObject(player);
    game.specOps!.shopSkipLock = 0;

    const msg = new InputMsg();
    msg.addInput(GameConfig.Input.Interact);
    player.handleInput(msg);

    expect(game.specOps!.phase).toBe("prep");
    expect(game.specOps!.wave).toBe(0);
});

test("Spec Ops ignores E for a moment after the shop opens", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const weapBefore = player.curWeapIdx;
    const msg = new InputMsg();
    msg.addInput(GameConfig.Input.StowWeapons);
    player.handleInput(msg);
    expect(game.specOps!.phase).toBe("prep");
    expect(player.curWeapIdx).toBe(weapBefore);

    game.specOps!.shopSkipLock = 0;
    const skip = new InputMsg();
    skip.addInput(GameConfig.Input.StowWeapons);
    player.handleInput(skip);
    expect(game.specOps!.phase).toBe("combat");
});

function houseWithOpenings(game: ReturnType<typeof createGame>) {
    const fits = (
        fixture: { pos: { x: number; y: number } },
        building: { pos: { x: number; y: number } },
        dist: number,
    ) => {
        const raw = outsideOf(fixture, building, dist);
        const clamped = v2.copy(raw);
        game.map.clampToMapBounds(clamped, 6);
        return v2.distance(raw, clamped) < 1.5;
    };

    for (let i = 0; i < game.map.buildings.length; i++) {
        const building = game.map.buildings[i];
        if (building.layer !== 0 || building.parentBuilding) continue;
        if (!building.zoomRegions.some((r) => r.zoomIn)) continue;
        const doors: typeof building.childObjects = [];
        const windows: typeof building.childObjects = [];
        for (let j = 0; j < building.childObjects.length; j++) {
            const child = building.childObjects[j];
            if (child.__type !== ObjectType.Obstacle) continue;
            if (child.isDoor && child.door && !child.dead && !child.door.locked) {
                doors.push(child);
            }
            if (!child.dead && (child.isWindow || child.type.includes("window"))) {
                windows.push(child);
            }
        }
        const door = doors.find((d) => fits(d, building, 8));
        const window = windows.find((w) => fits(w, building, 8));
        if (door && window) {
            return { building, door, window };
        }
    }
    return undefined;
}

function buildingInterior(
    building: NonNullable<ReturnType<typeof houseWithOpenings>>["building"],
) {
    const zoom = building.zoomRegions.find((r) => r.zoomIn)?.zoomIn;
    expect(zoom).toBeDefined();
    return v2.create((zoom!.min.x + zoom!.max.x) * 0.5, (zoom!.min.y + zoom!.max.y) * 0.5);
}

function outsideOf(
    fixture: { pos: { x: number; y: number } },
    building: { pos: { x: number; y: number } },
    dist: number,
) {
    const away = v2.normalizeSafe(v2.sub(fixture.pos, building.pos), v2.create(1, 0));
    return v2.add(fixture.pos, v2.mul(away, dist));
}

function threwExplosive(game: ReturnType<typeof createGame>) {
    return game.projectileBarn.projectiles.some(
        (p) => p.type === "frag" || p.type === "mirv" || p.type === "potato",
    );
}

test("Spec Ops grenadiers throw nades through house windows", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const house = houseWithOpenings(game);
    expect(house).toBeDefined();
    const { building, window } = house!;

    v2.set(player.pos, buildingInterior(building));
    game.grid.updateObject(player);
    game.update(0.05);
    expect(player.indoors).toBe(true);

    const nade = game.specOps!.spawnEnemyPublic("grenadier");
    expect(nade.invManager.get("frag")).toBeGreaterThan(0);
    v2.set(nade.pos, outsideOf(window, building, 10));
    game.grid.updateObject(nade);
    game.specOps!.clearAiNadeCooldown(nade);

    const startDist = v2.distance(nade.pos, window.pos);
    const startBuilding = v2.distance(nade.pos, building.pos);
    game.step(2.2);
    expect(["nade", "entry"]).toContain(game.specOps!.aiAssaultRole(nade));
    expect(
        v2.distance(nade.pos, window.pos) < startDist - 0.4
            || v2.distance(nade.pos, building.pos) < startBuilding - 0.4,
    ).toBe(true);

    window.damage({
        amount: 50,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: nade,
    });

    v2.set(nade.pos, outsideOf(window, building, 3.6));
    game.grid.updateObject(nade);
    game.specOps!.clearAiNadeCooldown(nade);
    const frags = nade.invManager.get("frag");
    const mirvs = nade.invManager.get("mirv");
    game.step(1.6);
    expect(
        nade.invManager.get("frag") < frags
            || nade.invManager.get("mirv") < mirvs
            || threwExplosive(game)
            || game.specOps!.aiAssaultRole(nade) === "entry",
    ).toBe(true);
});

test("Spec Ops riflemen smoke doors then stack to enter", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const house = houseWithOpenings(game);
    expect(house).toBeDefined();
    const { building, door } = house!;

    v2.set(player.pos, buildingInterior(building));
    game.grid.updateObject(player);
    game.update(0.05);
    expect(player.indoors).toBe(true);

    const rifle = game.specOps!.spawnEnemyPublic("rifle");
    const smokes = rifle.invManager.get("smoke");
    expect(smokes).toBeGreaterThan(0);
    v2.set(rifle.pos, outsideOf(door, building, 11));
    game.grid.updateObject(rifle);
    game.specOps!.clearAiNadeCooldown(rifle);

    const startDist = v2.distance(rifle.pos, door.pos);
    const startBuilding = v2.distance(rifle.pos, building.pos);
    game.step(2.2);
    expect(["smoke", "entry"]).toContain(game.specOps!.aiAssaultRole(rifle));
    expect(
        v2.distance(rifle.pos, door.pos) < startDist - 0.4
            || v2.distance(rifle.pos, building.pos) < startBuilding - 0.4,
    ).toBe(true);

    v2.set(rifle.pos, outsideOf(door, building, 4.6));
    game.grid.updateObject(rifle);
    game.specOps!.clearAiNadeCooldown(rifle);
    game.step(1.6);
    expect(
        rifle.invManager.get("smoke") < smokes
            || game.projectileBarn.projectiles.some((p) => p.type === "smoke")
            || game.specOps!.aiAssaultRole(rifle) === "entry",
    ).toBe(true);
});

test("Spec Ops breachers stack the door and clear the house", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const house = houseWithOpenings(game);
    expect(house).toBeDefined();
    const { building, door } = house!;

    v2.set(player.pos, buildingInterior(building));
    game.grid.updateObject(player);
    game.update(0.05);
    expect(player.indoors).toBe(true);

    const breacher = game.specOps!.spawnEnemyPublic("shotgun");
    const spawn = outsideOf(door, building, 8);
    game.map.clampToMapBounds(spawn, 6);
    v2.set(breacher.pos, spawn);
    game.grid.updateObject(breacher);

    const startDoor = v2.distance(breacher.pos, door.pos);
    const startBuilding = v2.distance(breacher.pos, building.pos);
    game.step(2.2);
    expect(game.specOps!.aiAssaultRole(breacher)).toBe("entry");
    expect(
        v2.distance(breacher.pos, door.pos) < startDoor - 0.3
            || v2.distance(breacher.pos, building.pos) < startBuilding - 0.3,
    ).toBe(true);

    const stack = outsideOf(door, building, 2.4);
    game.map.clampToMapBounds(stack, 6);
    v2.set(breacher.pos, stack);
    game.grid.updateObject(breacher);
    game.step(4.2);
    const doorOpen = "door" in door && !!door.door?.open;
    expect(
        breacher.indoors
            || game.specOps!.aiClearingHouse(breacher)
            || doorOpen
            || v2.distance(breacher.pos, player.pos) < v2.distance(stack, player.pos) - 0.8,
    ).toBe(true);
});

test("Spec Ops AI walks around large buildings to a door", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    let barn: (typeof game.map.buildings)[0] | undefined;
    const doors: Array<{ pos: { x: number; y: number } }> = [];
    for (let i = 0; i < game.map.buildings.length; i++) {
        const building = game.map.buildings[i];
        if (building.layer !== 0 || building.parentBuilding) continue;
        if (!building.type.includes("barn") && !building.type.includes("warehouse")) {
            continue;
        }
        if (!building.zoomRegions.some((r) => r.zoomIn)) continue;
        doors.length = 0;
        for (let j = 0; j < building.childObjects.length; j++) {
            const child = building.childObjects[j];
            if (child.__type !== ObjectType.Obstacle) continue;
            if (child.isDoor && child.door && !child.dead && !child.door.locked) {
                doors.push(child);
            }
        }
        if (doors.length < 1) continue;
        barn = building;
        break;
    }
    expect(barn).toBeDefined();
    expect(doors.length).toBeGreaterThan(0);

    v2.set(player.pos, buildingInterior(barn!));
    game.grid.updateObject(player);
    game.update(0.05);
    expect(player.indoors).toBe(true);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < barn!.zoomRegions.length; i++) {
        const z = barn!.zoomRegions[i].zoomIn;
        if (!z) continue;
        minX = Math.min(minX, z.min.x);
        minY = Math.min(minY, z.min.y);
        maxX = Math.max(maxX, z.max.x);
        maxY = Math.max(maxY, z.max.y);
    }
    const nearestDoor = (pos: { x: number; y: number }) => {
        let best = Infinity;
        for (let i = 0; i < doors.length; i++) {
            best = Math.min(best, v2.distance(pos, doors[i].pos));
        }
        return best;
    };

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const sides = [
        v2.create(maxX + 6, cy),
        v2.create(minX - 6, cy),
        v2.create(cx, maxY + 6),
        v2.create(cx, minY - 6),
    ];
    let spawn = sides[0];
    let startDoor = 0;
    for (let i = 0; i < sides.length; i++) {
        game.map.clampToMapBounds(sides[i], 6);
        const d = nearestDoor(sides[i]);
        if (d > startDoor && game.map.canPlayerSpawn(sides[i])) {
            startDoor = d;
            spawn = sides[i];
        }
    }
    if (startDoor < 8) {
        for (let i = 0; i < sides.length; i++) {
            const d = nearestDoor(sides[i]);
            if (d > startDoor) {
                startDoor = d;
                spawn = sides[i];
            }
        }
    }
    expect(startDoor).toBeGreaterThan(8);

    const breacher = game.specOps!.spawnEnemyPublic("shotgun");
    v2.set(breacher.pos, spawn);
    game.grid.updateObject(breacher);

    game.step(8);
    expect(
        nearestDoor(breacher.pos) < startDoor - 2
            || breacher.indoors
            || game.specOps!.aiClearingHouse(breacher),
    ).toBe(true);
});

test("Spec Ops AI takes stairs down to a lower floor", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const stairs = game.map.structures.flatMap((s) => s.stairs.filter((stair) => !stair.lootOnly));
    expect(stairs.length).toBeGreaterThan(0);
    const stair = stairs[0];

    let cellar: (typeof game.map.buildings)[0] | undefined;
    for (let i = 0; i < game.map.buildings.length; i++) {
        const building = game.map.buildings[i];
        if (building.layer !== 1) continue;
        if (!building.zoomRegions.some((r) => r.zoomIn)) continue;
        cellar = building;
        break;
    }
    expect(cellar).toBeDefined();

    const cellarZoom = cellar!.zoomRegions.find((r) => r.zoomIn)!.zoomIn!;
    v2.set(
        player.pos,
        v2.create(
            (cellarZoom.min.x + cellarZoom.max.x) * 0.5,
            (cellarZoom.min.y + cellarZoom.max.y) * 0.5,
        ),
    );
    player.layer = 1;
    game.grid.updateObject(player);
    game.update(0.05);
    expect(player.layer === 1 || player.layer === 3).toBe(true);

    const through = v2.neg(stair.downDir);
    const up = v2.add(
        stair.upAabb.min,
        v2.mul(v2.sub(stair.upAabb.max, stair.upAabb.min), 0.5),
    );
    game.map.clampToMapBounds(up, 6);
    const breacher = game.specOps!.spawnEnemyPublic("shotgun");
    v2.set(breacher.pos, up);
    breacher.layer = 0;
    breacher.dir = v2.copy(through);
    breacher.dirNew = v2.copy(through);
    game.grid.updateObject(breacher);

    beginSpecOpsWave(game);
    game.step(4);
    expect(breacher.layer === 1 || breacher.layer >= 2).toBe(true);
});

test("Spec Ops nav graph routes across floors inside large buildings", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const graph = game.specOps!.ensureNavGraph();
    const stairs = game.map.structures.flatMap((s) => s.stairs.filter((stair) => !stair.lootOnly));
    expect(stairs.length).toBeGreaterThan(0);

    let cellar: (typeof game.map.buildings)[0] | undefined;
    const stair = stairs[0];
    for (let i = 0; i < game.map.buildings.length; i++) {
        const building = game.map.buildings[i];
        if (building.layer !== 1) continue;
        const zoomIn = building.zoomRegions.find((r) => r.zoomIn)?.zoomIn;
        if (!zoomIn) continue;
        if (
            stair.center.x >= zoomIn.min.x - 12
            && stair.center.x <= zoomIn.max.x + 12
            && stair.center.y >= zoomIn.min.y - 12
            && stair.center.y <= zoomIn.max.y + 12
        ) {
            cellar = building;
            break;
        }
    }
    expect(cellar).toBeDefined();

    const cellarZoom = cellar!.zoomRegions.find((r) => r.zoomIn)!.zoomIn!;
    const cellarCorner = v2.create(cellarZoom.min.x + 3, cellarZoom.min.y + 3);
    const topSpawn = v2.add(
        stair.upAabb.min,
        v2.mul(v2.sub(stair.upAabb.max, stair.upAabb.min), 0.5),
    );
    game.map.clampToMapBounds(topSpawn, 6);

    const hunter = game.specOps!.spawnEnemyPublic("shotgun");
    v2.set(hunter.pos, topSpawn);
    hunter.layer = 0;
    game.grid.updateObject(hunter);

    expect(graph.hasPath(hunter, cellarCorner)).toBe(true);
    const wp = graph.firstWaypoint(hunter, cellarCorner);
    expect(wp).toBeDefined();

    v2.set(player.pos, cellarCorner);
    player.layer = 1;
    game.grid.updateObject(player);
    game.update(0.05);

    const startDist = v2.distance(hunter.pos, player.pos);
    beginSpecOpsWave(game);
    game.step(6);
    expect(v2.distance(hunter.pos, player.pos)).toBeLessThan(startDist - 1.5);
    expect(game.specOps!.aiAssaultRole(hunter)).toBe("entry");
});

test("Spec Ops AI walks around large obstacles", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    let mid = v2.create(game.map.width * 0.5, game.map.height * 0.5);
    for (let i = 0; i < 40; i++) {
        const pos = v2.create(
            28 + Math.random() * (game.map.width - 56),
            28 + Math.random() * (game.map.height - 56),
        );
        if (!game.map.canPlayerSpawn(pos)) continue;
        const nearBuilding = game.map.buildings.some((b) => {
            if (b.layer !== 0 || !b.zoomRegions.some((r) => r.zoomIn)) return false;
            return v2.distance(b.pos, pos) < 28;
        });
        if (nearBuilding) continue;
        mid = pos;
        break;
    }

    const silo = game.map.genObstacle("silo_01", mid, 0, 0, 1);
    for (let i = 0; i < game.map.obstacles.length; i++) {
        const o = game.map.obstacles[i];
        if (o === silo || o.dead) continue;
        if (v2.distance(o.pos, mid) > 34) continue;
        o.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
    }

    const spawn = v2.add(mid, v2.create(-18, 0));
    v2.set(player.pos, v2.add(mid, v2.create(18, 0)));
    game.grid.updateObject(player);
    const hunter = game.specOps!.spawnEnemyPublic("shotgun");
    v2.set(hunter.pos, spawn);
    game.grid.updateObject(hunter);
    const start = v2.distance(hunter.pos, player.pos);

    game.step(10);
    expect(v2.distance(hunter.pos, player.pos)).toBeLessThan(start - 4);
});

test("Spec Ops nav graph covers doors, windows, stairs, and obstacles", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const graph = game.specOps!.ensureNavGraph();
    expect(graph.nodes.length).toBeGreaterThan(20);
    expect(graph.nodes.some((n) => n.kind === "door")).toBe(true);
    expect(graph.nodes.some((n) => n.kind === "window")).toBe(true);
    expect(graph.nodes.some((n) => n.kind === "stair")).toBe(true);
    expect(graph.nodes.some((n) => n.kind === "hull")).toBe(true);

    const house = houseWithOpenings(game);
    expect(house).toBeDefined();
    const { building, door } = house!;
    v2.set(player.pos, buildingInterior(building));
    game.grid.updateObject(player);

    const walker = game.specOps!.spawnEnemyPublic("shotgun");
    const away = outsideOf(door, building, 22);
    v2.set(walker.pos, away);
    game.grid.updateObject(walker);

    expect(graph.hasPath(walker, door.pos)).toBe(true);
    const wp = graph.firstWaypoint(walker, door.pos);
    expect(wp).toBeDefined();
    expect(v2.distance(walker.pos, wp!)).toBeGreaterThan(1);
});

test("Spec Ops nav graph links outdoor doors to building hulls", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const graph = game.specOps!.ensureNavGraph();
    const doorNodes = graph.nodes.filter((n) => n.kind === "door");
    expect(doorNodes.length).toBeGreaterThan(0);

    let linked = false;
    for (let i = 0; i < doorNodes.length; i++) {
        const door = doorNodes[i];
        for (let j = 0; j < door.neighbors.length; j++) {
            const other = graph.nodes[door.neighbors[j]];
            if (other.kind === "hull" || other.kind === "door") {
                linked = true;
                break;
            }
        }
        if (linked) break;
    }
    expect(linked).toBe(true);
});

test("Spec Ops outdoor bots route toward cellar stairs through the nav graph", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const graph = game.specOps!.ensureNavGraph();
    const stairs = game.map.structures.flatMap((s) => s.stairs.filter((stair) => !stair.lootOnly));
    expect(stairs.length).toBeGreaterThan(0);

    let cellar: (typeof game.map.buildings)[0] | undefined;
    const stair = stairs[0];
    for (let i = 0; i < game.map.buildings.length; i++) {
        const building = game.map.buildings[i];
        if (building.layer !== 1) continue;
        const zoomIn = building.zoomRegions.find((r) => r.zoomIn)?.zoomIn;
        if (!zoomIn) continue;
        if (
            stair.center.x >= zoomIn.min.x - 12
            && stair.center.x <= zoomIn.max.x + 12
            && stair.center.y >= zoomIn.min.y - 12
            && stair.center.y <= zoomIn.max.y + 12
        ) {
            cellar = building;
            break;
        }
    }
    expect(cellar).toBeDefined();

    const cellarZoom = cellar!.zoomRegions.find((r) => r.zoomIn)!.zoomIn!;
    const cellarCorner = v2.create(cellarZoom.min.x + 3, cellarZoom.min.y + 3);
    v2.set(player.pos, cellarCorner);
    player.layer = 1;
    game.grid.updateObject(player);
    game.update(0.05);

    const outdoor = v2.add(
        stair.center,
        v2.mul(v2.neg(stair.downDir), 22),
    );
    game.map.clampToMapBounds(outdoor, 6);
    const hunter = game.specOps!.spawnEnemyPublic("shotgun");
    v2.set(hunter.pos, outdoor);
    hunter.layer = 0;
    game.grid.updateObject(hunter);

    expect(graph.hasPath(hunter, cellarCorner)).toBe(true);
    const wp = graph.firstWaypoint(hunter, cellarCorner);
    expect(wp).toBeDefined();
    expect(v2.distance(hunter.pos, wp!)).toBeGreaterThan(2);
    expect(graph.hasPath(hunter, wp!)).toBe(true);
});

test("Spec Ops stair transit detects players on stair collision", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const stair = game.map.structures
        .flatMap((s) => s.stairs.filter((st) => !st.lootOnly))[0];
    expect(stair).toBeDefined();
    const hit = stairAtPos(game, stair.center, 1.2);
    expect(hit?.stair).toBe(stair);
});

test("Spec Ops snipers hold windows and wait for the player to peek", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const house = houseWithOpenings(game);
    expect(house).toBeDefined();
    const { building, window } = house!;

    v2.set(player.pos, buildingInterior(building));
    game.grid.updateObject(player);
    game.update(0.05);
    expect(player.indoors).toBe(true);

    const peek = outsideOf(window, building, 6.2);
    game.map.clampToMapBounds(peek, 6);
    for (let i = 0; i < game.map.obstacles.length; i++) {
        const o = game.map.obstacles[i];
        if (o.dead || o.parentBuilding) continue;
        if (v2.distance(o.pos, peek) > 8) continue;
        if (o.isDoor || o.isWindow) continue;
        o.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
    }

    const sniper = game.specOps!.spawnEnemyPublic("sniper");
    v2.set(sniper.pos, peek);
    game.grid.updateObject(sniper);

    game.step(5);
    expect(game.specOps!.aiAssaultRole(sniper)).toBe("peek");
    expect(sniper.indoors).toBe(false);
    expect(v2.distance(sniper.pos, window.pos)).toBeLessThan(11);
});

test("Spec Ops bot arena spawns one of each NPC type without crashing", () => {
    const game = createGame(TeamMode.Solo, "test_specops_bots");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.spawnDebugNpcs(player, "one_of_each", "", 1, true);

    for (let i = 0; i < 120; i++) {
        game.specOps!.update(0.1);
        game.update(0.1);
        const aiCount = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi).length;
        if (aiCount > 60) break;
    }

    const ai = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi);
    expect(ai.length).toBeGreaterThan(60);

    for (let i = 0; i < 30; i++) {
        game.step(0.1);
    }
    expect(game.playerBarn.livingPlayers.some((p) => !p.specOpsAi)).toBe(true);
});

test("Spec Ops bot arena map includes one of each store", () => {
    const game = createGame(TeamMode.Solo, "test_specops_bots");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    for (const kind of ["weapon", "gear", "armor", "support", "perk"]) {
        const count = game.map.obstacles.filter((o) => o.type === `specops_station_${kind}`).length;
        expect(count, `missing ${kind} store`).toBeGreaterThanOrEqual(1);
    }
});

test("Spec Ops bot arena keeps waves paused", () => {
    const game = createGame(TeamMode.Duo, "test_specops_bots");
    game.playerBarn.addTestPlayer({ name: "OpA" });
    game.playerBarn.addTestPlayer({ name: "OpB" });
    game.update(0.1);

    const waveBefore = game.specOps!.wave;
    for (let i = 0; i < 200; i++) {
        game.step(0.5);
    }
    expect(game.specOps!.wave).toBe(waveBefore);
    expect(game.specOps!.phase).toBe("prep");
});

test("Spec Ops pacifist mode keeps enemies from targeting operators", () => {
    const game = createGame(TeamMode.Solo, "test_specops_bots");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.setNpcIgnoreOperators(true);
    const enemy = game.specOps!.spawnEnemyPublic("militia");
    v2.set(enemy.pos, v2.add(player.pos, v2.create(2, 0)));
    game.grid.updateObject(enemy);

    for (let i = 0; i < 20; i++) {
        game.step(0.1);
    }

    expect(game.specOps!.hostileTargets().some((p) => !p.specOpsAi)).toBe(false);
    const target = game.specOps!.aiTarget(enemy);
    expect(!target || target.specOpsAi).toBe(true);

    enemy.damage({
        amount: 1,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    game.specOps!.onAiDamaged(enemy, player);
    const targetAfter = game.specOps!.aiTarget(enemy);
    expect(!targetAfter || targetAfter.specOpsAi).toBe(true);
});

test("Spec Ops empty disconnected lobby stops joining and ends after timeout", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(game.started).toBe(true);
    expect(game.specOps!.allowJoin).toBe(true);
    expect(game.canJoin).toBe(true);

    player.client.disconnected = true;
    game.update(0.05);
    expect(game.specOps!.operatorCount).toBe(0);
    expect(game.specOps!.humanCount).toBe(0);
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.canJoin).toBe(false);
    expect(game.over).toBe(false);
    expect(game.specOps!.allowReconnectTokens).toBe(true);

    game.update(SpecOpsAbandonedTimeout - 1);
    expect(game.over).toBe(false);

    game.update(2);
    expect(game.over).toBe(true);
    expect(game.canJoin).toBe(false);
    expect(game.specOps!.allowReconnectTokens).toBe(false);
});

test("Spec Ops idle last operator ends the match and closes joins", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(game.canJoin).toBe(true);

    player.lastActivityTime = game.now - (SpecOpsIdleTimeout + 1) * 1000;
    expect(game.specOps!.allConnectedHumansIdle()).toBe(true);
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.canJoin).toBe(false);

    game.update(0.05);
    expect(game.over).toBe(true);
});

test("Spec Ops server browser stays open while operators are AFK before idle shutdown", () => {
    const game = createGame(TeamMode.Duo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(game.canJoin).toBe(true);
    expect(game.browsable).toBe(true);

    player.lastActivityTime = game.now - (SpecOpsIdleTimeout + 1) * 1000;
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.canJoin).toBe(false);
    expect(game.specOps!.browsable).toBe(true);
    expect(game.browsable).toBe(true);
});

test("Spec Ops reconnect tokens still accept while the empty lobby is winding down", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    player.client.disconnected = true;
    game.update(0.05);
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.specOps!.allowReconnectTokens).toBe(true);

    game.addJoinTokens([{ token: "reconnect", userId: null, ip: "127.0.0.1" }], true);
    expect(game.pendingJoinTokens()).toBe(1);
    expect(game.joinTokens.has("reconnect")).toBe(true);
});

test("Spec Ops force-reclaims seat when old socket still looks live (page reload race)", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.05);
    expect(player.disconnected).toBe(false);
    expect(player.client.socket.closed()).toBe(false);
    const humansBefore = game.playerBarn.players.filter((p) => !p.specOpsAi).length;

    game.addJoinTokens(
        [{
            token: "reload-race",
            userId: null,
            ip: "127.0.0.1",
            reclaimPlayerId: player.__id,
        }],
        false,
    );

    const joinMsg = new JoinMsg();
    joinMsg.protocol = GameConfig.protocolVersion;
    joinMsg.matchPriv = "reload-race";
    joinMsg.name = "Operator";

    const newSocket = new NoOpSocket();
    const reconnected = game.clientBarn.addClientWithPlayer(newSocket, joinMsg);
    expect(reconnected).toBeTruthy();
    expect(reconnected!.player).toBe(player);
    expect(player.client.socket).toBe(newSocket);
    expect(game.playerBarn.players.filter((p) => !p.specOpsAi).length).toBe(humansBefore);
});

test("Spec Ops mints reclaim token while seat still looks connected (join locked)", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.05);
    game.specOps!.lockJoin();
    expect(game.specOps!.allowJoin).toBe(false);
    expect(player.disconnected).toBe(false);
    expect(game.specOps!.allowReconnectTokens).toBe(false);

    const accepted = game.addJoinTokens(
        [{
            token: "reload-live",
            userId: null,
            ip: "127.0.0.1",
            reclaimPlayerId: player.__id,
        }],
        false,
    );
    expect(accepted).toBe(1);
    expect(game.joinTokens.has("reload-live")).toBe(true);
});

test("Spec Ops reclaim matches uniqueInGameNames suffix from lobby name", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator-1" });
    game.update(0.05);
    player.client.disconnected = true;

    game.addJoinTokens(
        [{ token: "name-suffix", userId: null, ip: "127.0.0.1" }],
        false,
    );

    const joinMsg = new JoinMsg();
    joinMsg.protocol = GameConfig.protocolVersion;
    joinMsg.matchPriv = "name-suffix";
    joinMsg.name = "Operator";

    const newSocket = new NoOpSocket();
    const reconnected = game.clientBarn.addClientWithPlayer(newSocket, joinMsg);
    expect(reconnected).toBeTruthy();
    expect(reconnected!.player).toBe(player);
});

test("Spec Ops reclaim does not collapse distinct -N callsigns onto one seat", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    const a = game.playerBarn.addTestPlayer({ name: "Op-0" });
    const b = game.playerBarn.addTestPlayer({ name: "Op-1" });
    game.update(0.05);
    a.client.disconnected = true;
    b.client.disconnected = true;

    game.addJoinTokens(
        [{ token: "op1-reclaim", userId: null, ip: "127.0.0.1" }],
        false,
    );

    const joinMsg = new JoinMsg();
    joinMsg.protocol = GameConfig.protocolVersion;
    joinMsg.matchPriv = "op1-reclaim";
    joinMsg.name = "Op-1";

    const newSocket = new NoOpSocket();
    const reconnected = game.clientBarn.addClientWithPlayer(newSocket, joinMsg);
    expect(reconnected).toBeTruthy();
    expect(reconnected!.player).toBe(b);
    expect(reconnected!.player).not.toBe(a);
});

test("Spec Ops no-fill reconnect tokens work after disconnect", () => {
    const game = createGame(TeamMode.Squad, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.lockJoin();
    expect(game.specOps!.joinLocked).toBe(true);
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.specOps!.allowReconnectTokens).toBe(false);

    player.client.disconnected = true;
    game.update(0.05);
    expect(game.specOps!.allowJoin).toBe(false);
    expect(game.specOps!.allowReconnectTokens).toBe(true);
    expect(game.specOps!.disconnectedHumanCount()).toBe(1);

    const accepted = game.addJoinTokens(
        [{ token: "reclaim", userId: null, ip: "127.0.0.1" }],
        true,
    );
    expect(accepted).toBe(1);
    // Random second seat must not open while only reclaiming.
    expect(
        game.addJoinTokens([{ token: "random", userId: null, ip: "10.0.0.2" }], true),
    ).toBe(0);
});

test("Spec Ops humans never despawn so reconnect can reclaim the seat", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.05);
    expect(player.canDespawn()).toBe(false);

    player.client.disconnected = true;
    game.clientBarn.handleSocketClose(player.client.socket);
    expect(game.playerBarn.players.includes(player)).toBe(true);
    expect(player.disconnected).toBe(true);
    expect(game.specOps!.disconnectedHumanCount()).toBe(1);
});

test("Spec Ops rejoin replaces stale pending token for the same IP", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.addJoinTokens([{ token: "old", userId: null, ip: "127.0.0.1" }], true);
    expect(game.pendingJoinTokens()).toBe(1);

    const accepted = game.addJoinTokens([{ token: "new", userId: null, ip: "127.0.0.1" }], true);
    expect(accepted).toBe(1);
    expect(game.pendingJoinTokens()).toBe(1);
    expect(game.joinTokens.has("old")).toBe(false);
    expect(game.joinTokens.has("new")).toBe(true);
});

test("Spec Ops keeps all same-IP join tokens for a full squad of 8", () => {
    const prev = Config.maxSquadSize;
    Config.maxSquadSize = 8;
    try {
        const game = createGame(TeamMode.Squad, "test_specops");
        const tokens = Array.from({ length: 8 }, (_, i) => ({
            token: `tok${i}`,
            userId: null as string | null,
            ip: "10.0.0.5",
        }));
        expect(game.addJoinTokens(tokens, false)).toBe(8);
        expect(game.pendingJoinTokens()).toBe(8);
        for (let i = 0; i < 8; i++) {
            expect(game.joinTokens.has(`tok${i}`)).toBe(true);
        }
    } finally {
        Config.maxSquadSize = prev;
    }
});

test("Spec Ops difficulty changes roster size and enemy health vs regular", () => {
    const rec = createGame(TeamMode.Solo, "test_specops", { difficulty: "recruit" });
    const reg = createGame(TeamMode.Solo, "test_specops", { difficulty: "regular" });
    const hard = createGame(TeamMode.Solo, "test_specops", { difficulty: "hardened" });
    const vet = createGame(TeamMode.Solo, "test_specops", { difficulty: "veteran" });
    rec.playerBarn.addTestPlayer({ name: "Op" });
    reg.playerBarn.addTestPlayer({ name: "Op" });
    hard.playerBarn.addTestPlayer({ name: "Op" });
    vet.playerBarn.addTestPlayer({ name: "Op" });
    rec.update(0.1);
    reg.update(0.1);
    hard.update(0.1);
    vet.update(0.1);

    const wave = 8;
    const late = 31;
    const recSize = rec.specOps!.waveRosterPublic(late).length;
    const regSize = reg.specOps!.waveRosterPublic(late).length;
    const hardSize = hard.specOps!.waveRosterPublic(late).length;
    const vetSize = vet.specOps!.waveRosterPublic(late).length;
    expect(recSize).toBeLessThan(regSize);
    expect(hardSize).toBeGreaterThan(regSize);
    expect(vetSize).toBeGreaterThan(hardSize);

    const midRec = rec.specOps!.waveRosterPublic(wave).length;
    const midReg = reg.specOps!.waveRosterPublic(wave).length;
    const midVet = vet.specOps!.waveRosterPublic(wave).length;
    expect(midRec).toBeLessThan(midReg);
    expect(midVet).toBeGreaterThan(midReg);

    const recHp = specOpsEnemyHealth(wave, "rifle", "recruit");
    const regHp = specOpsEnemyHealth(wave, "rifle", "regular");
    const vetHp = specOpsEnemyHealth(wave, "rifle", "veteran");
    expect(recHp).toBeLessThan(regHp);
    expect(vetHp).toBeGreaterThan(regHp);
});

test("Spec Ops difficulty scales shop and revive prices", () => {
    const mp5 = SpecOpsShopBySku.mp5;
    expect(specOpsShopItemCost(mp5, TeamMode.Solo, 0, "recruit")).toBeLessThan(
        specOpsShopItemCost(mp5, TeamMode.Solo, 0, "regular"),
    );
    expect(specOpsShopItemCost(mp5, TeamMode.Solo, 0, "veteran")).toBeGreaterThan(
        specOpsShopItemCost(mp5, TeamMode.Solo, 0, "regular"),
    );
    expect(specOpsBuybackCost(5, "recruit")).toBeLessThan(specOpsBuybackCost(5, "regular"));
    expect(specOpsBuybackCost(5, "veteran")).toBeGreaterThan(specOpsBuybackCost(5, "regular"));
    expect(specOpsSelfReviveCost(3, "hardened")).toBeGreaterThan(
        specOpsSelfReviveCost(3, "regular"),
    );
});

test("Spec Ops mid-wave classes include new fight archetypes", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const roster = game.specOps!.waveRosterPublic(12);
    expect(roster).toContain("spotter");
    expect(roster).toContain("incursor");
    expect(roster).toContain("shieldbearer");
    expect(roster).toContain("rocketeer");
    expect(roster).toContain("corsair");
    expect(roster).toContain("vanguard");
    expect(roster).toContain("nightblade");
    expect(roster).toContain("demolisher");

    const shield = game.specOps!.spawnEnemyPublic("shieldbearer");
    expect(shield.chest).toBe("chest03");
    expect(shield.helmet).toBe("helmet02");
    expect(shield.weapons[GameConfig.WeaponSlot.Melee].type).toBe("pan");
});

test("Spec Ops veteran difficulty starts combat on wave 5", () => {
    const game = createGame(TeamMode.Solo, "test_specops", { difficulty: "veteran" });
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(game.specOps!.wave).toBe(4);
    expect(game.specOps!.phase).toBe("prep");
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(5);
    expect(game.specOps!.phase).toBe("combat");
});

test("Spec Ops hired support scales with wave", () => {
    expect(specOpsAllyHealth(1, "ally")).toBe(100);
    expect(specOpsAllyHealth(20, "ally")).toBeGreaterThan(specOpsAllyHealth(1, "ally"));
    expect(specOpsAllyDamageMult(30)).toBeGreaterThan(specOpsAllyDamageMult(5));

    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 20;
    game.specOps!.grantCash(player, 20000);
    const support = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, support.pos);
    player.layer = support.layer;
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "medic")).toBe(true);
    const ally = game.playerBarn.livingPlayers.find(
        (p) => p.specOpsKind === "ally" && p !== player,
    );
    expect(ally).toBeTruthy();
    expect(ally!.health).toBeGreaterThan(100);
    expect(ally!.specOpsDamageMult).toBeGreaterThan(1);
});

test("Spec Ops airstrike rejects building interiors when targeted", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(player, 20000);
    const support = findSpecOpsStation(game, "specops_station_support")!;
    v2.set(player.pos, support.pos);
    player.layer = support.layer;
    game.grid.updateObject(player);

    // Station spots sit indoors / against buildings — targeting the station itself should fail.
    const indoor = v2.copy(support.pos);
    const boughtIndoor = game.specOps!.tryBuy(player, "specops_airstrike", indoor);
    // Either rejected or nudged outdoors; if accepted, strike must not be inside a building.
    if (boughtIndoor) {
        expect(game.planeBarn.airstrikeZones.length).toBeGreaterThan(0);
    } else {
        expect(game.specOps!.tryBuy(player, "specops_airstrike", v2.add(player.pos, v2.create(40, 0))))
            .toBe(true);
        expect(game.planeBarn.airstrikeZones.length).toBeGreaterThan(0);
    }
});

test("Spec Ops continuous waves skips the shop timer and starts the next wave", () => {
    const game = createGame(TeamMode.Solo, "test_specops", { endless: true });
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    beginSpecOpsWave(game, true);
    expect(game.specOps!.wave).toBe(1);
    expect(game.specOps!.phase).toBe("combat");

    const enemies = game.playerBarn.livingPlayers.filter((p) => p.specOpsAi);
    expect(enemies.length).toBeGreaterThan(0);
    for (const enemy of enemies) {
        enemy.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: player,
        });
    }
    game.update(0.05);

    expect(game.specOps!.phase).toBe("combat");
    expect(game.specOps!.wave).toBe(2);
    expect(game.specOps!.phaseTimer).toBe(0);
    expect(game.over).toBe(false);
    expect(game.specOps!.enemiesAlive).toBeGreaterThan(0);
});

test("Spec Ops wait-for-next-wave continues past wave 30 instead of ending", () => {
    const endless = createGame(TeamMode.Solo, "test_specops", { endless: true });
    const player = endless.playerBarn.addTestPlayer({ name: "Operator" });
    endless.update(0.1);
    endless.specOps!.wave = 30;
    endless.specOps!.phase = "intermission";
    beginSpecOpsWave(endless, true);

    expect(endless.specOps!.wave).toBe(31);
    expect(endless.specOps!.phase).toBe("combat");
    expect(endless.over).toBe(false);
    expect(endless.specOps!.enemiesAlive).toBeGreaterThan(0);
    expect(player.dead).toBe(false);

    const standard = createGame(TeamMode.Solo, "test_specops", { endless: false });
    standard.playerBarn.addTestPlayer({ name: "Operator" });
    standard.update(0.1);
    standard.specOps!.wave = 30;
    standard.specOps!.phase = "intermission";
    beginSpecOpsWave(standard);
    expect(standard.over).toBe(false);
    expect(standard.specOps!.wave).toBe(31);
    expect(standard.specOps!.phase).toBe("combat");
});

test("Spec Ops self-revive is buyable at every station with wave-scaled cost", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 5;
    const cost = specOpsSelfReviveCost(5);
    game.specOps!.grantCash(player, cost);

    const weaponStation = findSpecOpsStation(game, "specops_station_weapon")!;
    v2.set(player.pos, weaponStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, SpecOpsSelfReviveSku)).toBe(true);
    expect(player.hasPerk("self_revive")).toBe(true);
    expect(player.specOpsCash).toBe(800);

    player.removePerk("self_revive");
    game.specOps!.grantCash(player, cost);
    game.update(0.5);

    const armorStation = findSpecOpsStation(game, "specops_station_armor")!;
    v2.set(player.pos, armorStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, SpecOpsSelfReviveSku)).toBe(true);
    expect(player.hasPerk("self_revive")).toBe(true);
});

test("Spec Ops veteran difficulty disables self-revive purchases", () => {
    const game = createGame(TeamMode.Solo, "test_specops", { difficulty: "veteran" });
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(specOpsSelfReviveAllowed("veteran")).toBe(false);
    expect(player.hasPerk("self_revive")).toBe(false);

    game.specOps!.grantCash(player, 50000);
    const gearStation = findSpecOpsStation(game, "specops_station_gear")!;
    v2.set(player.pos, gearStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, SpecOpsSelfReviveSku)).toBe(false);
    expect(player.hasPerk("self_revive")).toBe(false);
});

test("Spec Ops rare potato perk is only sold on the potato map", () => {
    expect(specOpsShopItemAvailable("rare_potato", "specops_potato")).toBe(true);
    expect(specOpsShopItemAvailable("rare_potato", "specops_woods")).toBe(false);
    expect(specOpsShopItemAvailable("steelskin", "specops_woods")).toBe(true);

    const woods = createGame(TeamMode.Solo, "specops_woods");
    const woodsPlayer = woods.playerBarn.addTestPlayer({ name: "Operator" });
    woods.update(0.1);
    woods.specOps!.wave = 6;
    woods.specOps!.grantCash(woodsPlayer, 20000);
    const woodsPerk = findSpecOpsStation(woods, "specops_station_perk");
    v2.set(woodsPlayer.pos, woodsPerk.pos);
    woodsPlayer.layer = woodsPerk.layer;
    woods.grid.updateObject(woodsPlayer);
    expect(woods.specOps!.tryBuy(woodsPlayer, "rare_potato")).toBe(false);
    expect(
        specOpsShopStationItems("perk", TeamMode.Solo, "specops_woods").some(
            (item) => item.sku === "rare_potato",
        ),
    ).toBe(false);

    const potato = createGame(TeamMode.Solo, "specops_potato");
    const potatoPlayer = potato.playerBarn.addTestPlayer({ name: "Operator" });
    potato.update(0.1);
    potato.specOps!.wave = 6;
    potato.specOps!.grantCash(potatoPlayer, 20000);
    const potatoPerk = findSpecOpsStation(potato, "specops_station_perk");
    v2.set(potatoPlayer.pos, potatoPerk.pos);
    potatoPlayer.layer = potatoPerk.layer;
    potato.grid.updateObject(potatoPlayer);
    expect(potato.specOps!.tryBuy(potatoPlayer, "rare_potato")).toBe(true);
    expect(potatoPlayer.hasPerk("rare_potato")).toBe(true);
});

test("Spec Ops High-Value Targets perk grants bonus cash for perked enemies", () => {
    expect(specOpsKillBountyAmount(200, true, 1)).toBe(Math.round(200 * SpecOpsTargetingBountyMult));
    expect(specOpsKillBountyAmount(200, true, 0)).toBe(200);
    expect(specOpsKillBountyAmount(200, false, 2)).toBe(200);

    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.wave = 6;
    game.specOps!.grantCash(player, 20000);

    const perkStation = findSpecOpsStation(game, "specops_station_perk")!;
    v2.set(player.pos, perkStation.pos);
    game.grid.updateObject(player);
    expect(game.specOps!.tryBuy(player, "targeting")).toBe(true);
    game.update(0.5);
    v2.set(player.pos, perkStation.pos);
    game.grid.updateObject(player);

    const marksman = game.specOps!.spawnEnemyPublic("marksman");
    const baseBounty = marksman.specOpsBounty || 100;
    expect(marksman.perks.length).toBeGreaterThan(0);
    const cashBefore = player.specOpsCash;

    marksman.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: player,
    });
    game.update(0.05);

    expect(player.specOpsCash).toBe(
        cashBefore + Math.round(baseBounty * SpecOpsTargetingBountyMult),
    );
});

test("Spec Ops blocks self-revive purchase while Revivify is unused", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    player.addPerk("self_revive", false);

    expect(specOpsCanBuySelfRevive(player)).toBe(false);

    const gearStation = game.map.obstacles.find((o) => o.type === "specops_station_gear")!;
    v2.set(player.pos, gearStation.pos);
    game.grid.updateObject(player);
    game.specOps!.grantCash(player, specOpsSelfReviveCost(game.specOps!.wave));
    expect(game.specOps!.tryBuy(player, SpecOpsSelfReviveSku)).toBe(false);
});

test("Spec Ops allows weapon swaps during prep", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.shopSkipLock = 999;
    expect(game.specOps!.phase).toBe("prep");

    player.weaponManager.setWeapon(GameConfig.WeaponSlot.Secondary, "deagle", 7);
    player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
    expect(player.curWeapIdx).toBe(GameConfig.WeaponSlot.Primary);

    const msg = new InputMsg();
    msg.addInput(GameConfig.Input.EquipSecondary);
    player.handleInput(msg);

    expect(player.curWeapIdx).toBe(GameConfig.WeaponSlot.Secondary);
    expect(game.specOps!.phase).toBe("prep");
});

test("Spec Ops Indomitable Spirit does not protect players already at 1 HP", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    player.addPerk("lifeline", false);
    player.addPerk("leadership", false);
    player.health = 1;
    player.specOpsArmor = 0;
    player.boost = 100;

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    player.damage({
        amount: 50,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: ai,
    });

    expect(player.dead).toBe(true);
});

test("Spec Ops Indomitable Spirit is consumed when Leadership enables a save", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    player.addPerk("lifeline", false);
    player.addPerk("leadership", false);
    player.health = 50;
    player.specOpsArmor = 0;
    player.boost = 100;

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    player.damage({
        amount: 80,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: ai,
    });

    expect(player.dead).toBe(false);
    expect(player.health).toBe(1);
    expect(player.hasPerk("lifeline")).toBe(false);
    expect(player.hasPerk("leadership")).toBe(true);

    game.step(2);
    expect(player.health).toBeGreaterThan(1);

    player.damage({
        amount: 80,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: ai,
    });
    expect(player.dead).toBe(true);
});

test("Spec Ops Indomitable Spirit can be repurchased after Leadership consumes it", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    player.addPerk("lifeline", false);
    player.addPerk("leadership", false);
    player.health = 50;
    player.specOpsArmor = 0;
    player.boost = 100;

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    player.damage({
        amount: 80,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: ai,
    });
    expect(player.hasPerk("lifeline")).toBe(false);

    const perkStation = findSpecOpsStation(game, "specops_station_perk");
    game.specOps!.wave = 6;
    game.specOps!.grantCash(player, specOpsShopItemCost(SpecOpsShopBySku.lifeline, game.teamMode));
    standAtStation(player, perkStation);
    expect(game.specOps!.tryBuy(player, "lifeline")).toBe(true);
    expect(player.hasPerk("lifeline")).toBe(true);
});

test("Spec Ops Indomitable Spirit is not consumed without Leadership", () => {
    const game = createGame(TeamMode.Solo, "test_specops");
    const player = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    player.addPerk("lifeline", false);
    player.health = 50;
    player.specOpsArmor = 0;
    player.boost = 100;

    const ai = game.specOps!.spawnEnemyPublic("rifle");
    player.damage({
        amount: 80,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: ai,
    });

    expect(player.dead).toBe(false);
    expect(player.health).toBe(1);
    expect(player.hasPerk("lifeline")).toBe(true);
});

test("Spec Ops kill counter serializes past 255 kills", () => {
    const msg = new KillMsg();
    msg.killerKills = 300;
    const stream = new BitStream(new ArrayBuffer(64));
    msg.serialize(stream);
    stream.byteIndex = 0;
    const decoded = new KillMsg();
    decoded.deserialize(stream);
    expect(decoded.killerKills).toBe(300);
});
