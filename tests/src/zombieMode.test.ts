import { expect, test } from "vitest";

import { ZombieWaveIntermissionTime } from "../../server/src/game/specOpsManager.ts";
import {
    composeZombieWave,
    zombieEnemyHealth,
    ZombieMysteryBoxClaimDuration,
    ZombieMysteryBoxCooldown,
    ZombieMysteryBoxCost,
    ZombieMysteryBoxRelocateUses,
    ZombieMysteryBoxRollDuration,
    ZombieMysteryBoxWeapons,
    ZombieUpgradeCost,
    zombieWaveCount,
} from "../../server/src/game/zombieMode.ts";
import { MapDefs } from "../../shared/defs/mapDefs.ts";
import { ZombiePerkMachines, ZombiePerkMachineTypes } from "../../shared/defs/maps/zombiePerks.ts";
import { GameObjectDefs, MapObjectDefs } from "../../shared/defs/register.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { collider } from "../../shared/utils/collider.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

test("Zombie Survival uses a dedicated, scaling zombie wave profile", () => {
    expect(zombieWaveCount(1, 1)).toBe(6);
    expect(zombieWaveCount(10, 1)).toBeGreaterThan(zombieWaveCount(1, 1));
    expect(zombieWaveCount(10, 4)).toBeGreaterThan(zombieWaveCount(10, 1));
    expect(zombieWaveCount(100, 8)).toBe(48);
    expect(composeZombieWave(3, 1).every((kind) => kind === "zombie_walker")).toBe(true);
    expect(zombieEnemyHealth(10)).toBeGreaterThan(zombieEnemyHealth(1));
    expect(
        ZombieMysteryBoxWeapons.every(
            (weapon) => GameObjectDefs.typeToDefSafe(weapon)?.type === "gun",
        ),
    ).toBe(true);
});

test("Live survival maps expose Zombie Survival while keeping Spec Ops internals", () => {
    expect(MapDefs.specops.desc.name).toBe("Zombie Survival");
    expect(MapDefs.specops.gameMode.zombieMode).toBe(true);
    expect(MapDefs.specops.gameMode.specOpsMode).toBe(true);
    expect(MapDefs.specops.gameMode.indoorMode).toBe(true);
    expect(MapDefs.specops_outdoor.gameMode.indoorMode).not.toBe(true);
    expect(MapDefs.practice_specops.gameMode.zombieMode).toBe(false);
});

test("Zombie Survival generates an enclosed nine-room arena with working doors", () => {
    const game = createGame(TeamMode.Solo, "specops");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    expect(game.map.width).toBe(128);
    expect(game.map.height).toBe(112);
    const arena = game.map.buildings.find(
        (building) => building.type === "zombie_indoor_arena_01",
    );
    expect(arena).toBeDefined();
    expect(arena?.surfaces).toHaveLength(9);
    const wallTypes = new Set(
        game.map.obstacles
            .filter((obstacle) => obstacle.isWall)
            .map((obstacle) => obstacle.type),
    );
    expect(wallTypes.has("reserve_wall_int_10")).toBe(true);
    expect(wallTypes.has("police_wall_int_10")).toBe(true);
    expect(wallTypes.has("mansion_wall_int_10")).toBe(true);
    expect(wallTypes.has("club_wall_int_10")).toBe(true);
    expect(wallTypes.has("zombie_wall_outer_10")).toBe(true);
    expect(
        game.map.obstacles
            .filter((obstacle) => obstacle.type.startsWith("zombie_wall_shell_"))
            .every((obstacle) => !obstacle.destructible),
    ).toBe(true);
    const doors = game.map.obstacles.filter((obstacle) => obstacle.isDoor);
    expect(doors).toHaveLength(8);
    expect(doors.every((door) => door.isDoor && door.door?.canUse)).toBe(true);
    expect(doors.filter((door) => door.type === "zombie_door_01")).toHaveLength(1);
    expect(doors.filter((door) => door.type.startsWith("house_door_"))).toHaveLength(7);
    expect(game.map.obstacles.filter((obstacle) => obstacle.type.startsWith("specops_station_")))
        .toHaveLength(5);
    const mysteryBox = game.map.obstacles.find(
        (obstacle) => obstacle.type === "zombie_mystery_box",
    )!;
    const mysteryBoxBounds = collider.toAabb(mysteryBox.collider);
    expect(mysteryBoxBounds.max.x - mysteryBoxBounds.min.x).toBeCloseTo(8.8, 1);
    expect(mysteryBoxBounds.max.y - mysteryBoxBounds.min.y).toBeCloseTo(3.7, 1);
    expect(operator.indoors).toBe(true);
    expect(Math.abs(operator.pos.x - game.map.center.x)).toBeLessThan(8);
    expect(Math.abs(operator.pos.y - game.map.center.y)).toBeLessThan(8);
});

test("Last Call generates its furnished motel, club, courtyard and garage routes", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    const complex = game.map.buildings.find(
        (building) => building.type === "zombie_branching_complex_01",
    );
    expect(complex).toBeDefined();
    expect(complex?.surfaces).toHaveLength(9);
    expect(game.map.width).toBe(256);
    expect(game.map.height).toBe(208);

    const props = new Set(game.map.obstacles.map((obstacle) => obstacle.type));
    expect(props.has("bed_sm_01")).toBe(true);
    expect(props.has("lastcall_bar_club")).toBe(true);
    expect(props.has("lastcall_pool")).toBe(true);
    expect(props.has("zombie_power_switch")).toBe(true);
    expect(props.has("zombie_upgrade_bench")).toBe(true);
    expect(props.has("zombie_garage_car")).toBe(true);
    expect(props.has("zombie_mystery_box")).toBe(true);
    expect(game.map.obstacles.filter((obstacle) => obstacle.type.startsWith("specops_station_")))
        .toHaveLength(0);
    for (const machineType of ZombiePerkMachineTypes) {
        expect(game.map.obstacles.filter((obstacle) => obstacle.type === machineType))
            .toHaveLength(1);
    }
    expect(game.map.obstacles.filter((obstacle) => obstacle.type === "zombie_spawn_point"))
        .toHaveLength(19);

    const gates = game.map.obstacles.filter((obstacle) => obstacle.type.startsWith("zombie_buy_gate_"));
    expect(gates).toHaveLength(9);
    expect(gates.every((gate) => gate.isButton && gate.collidable)).toBe(true);
    expect(
        game.map.obstacles
            .filter((object) => object.parentBuilding === complex && object.isWall)
            .every((wall) => !wall.destructible),
    ).toBe(true);
    // One painted floor for the whole block, generated from the same layout as the walls.
    const definition = MapObjectDefs.typeToDef("zombie_branching_complex_01", "building");
    expect(definition.floor.imgs.map((image) => image.sprite)).toEqual(["map-lastcall-floor.img"]);
    expect(MapDefs.specops_complex.assets.atlases).toContain("lastcall");
    expect(Math.abs(operator.pos.x - (game.map.center.x - 10))).toBeLessThan(8);
    expect(operator.pos.y).toBeLessThan(game.map.center.y - 35);
    expect(
        game.specOps!.ensureNavGraph().hasPath(
            operator,
            v2.add(game.map.center, v2.create(-80, 0)),
        ),
    ).toBe(false);
});

test("Last Call perk machines sell their fixed perks for cash", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.grantCash(operator, 10_000);
    const startingCash = operator.specOpsCash;

    for (const machineType of ZombiePerkMachineTypes) {
        const machine = game.map.obstacles.find((obstacle) => obstacle.type === machineType)!;
        v2.set(operator.pos, machine.pos);
        game.grid.updateObject(operator);
        machine.interact(operator);
        game.update(0.5);
    }

    const totalCost = ZombiePerkMachineTypes.reduce(
        (sum, machineType) => sum + ZombiePerkMachines[machineType].cost,
        0,
    );
    expect(operator.specOpsCash).toBe(startingCash - totalCost);
    expect(operator.hasPerk("zombie_juggernog")).toBe(true);
    expect(operator.hasPerk("zombie_speed_cola")).toBe(true);
    expect(operator.hasPerk("self_revive")).toBe(true);
    expect(operator.hasPerk("zombie_stamin_up")).toBe(true);
    expect(operator.hasPerk("zombie_double_tap")).toBe(true);
    expect(operator.maxHealth).toBe(250);
    expect(operator.health).toBe(250);
});

test("Zombie Survival automatically starts the next wave after an eight-second breather", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.startNextWave();
    game.specOps!.drainWaveSpawnQueuePublic();

    const zombies = game.playerBarn.livingPlayers.filter((player) => player.specOpsAi);
    for (const zombie of zombies) {
        zombie.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: operator,
        });
    }
    game.update(0.05);

    expect(game.specOps!.phase).toBe("intermission");
    expect(game.specOps!.phaseDuration).toBe(ZombieWaveIntermissionTime);
    expect(game.specOps!.wave).toBe(1);
    game.step(ZombieWaveIntermissionTime - 0.25);
    expect(game.specOps!.wave).toBe(1);
    game.step(0.3);
    expect(game.specOps!.wave).toBe(2);
    expect(game.specOps!.phase).toBe("combat");
});

test("Last Call lobby gates charge cash and permanently open the selected route", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    const gate = game.map.obstacles.find(
        (obstacle) =>
            obstacle.type === "zombie_buy_gate_750"
            && obstacle.pos.y < game.map.center.y
            && obstacle.pos.x < game.map.center.x,
    )!;
    const courtyard = v2.add(game.map.center, v2.create(-20, -15));

    expect(game.specOps!.ensureNavGraph().hasPath(operator, courtyard)).toBe(false);

    operator.specOpsCash = 1000;
    v2.set(operator.pos, gate.pos);
    game.grid.updateObject(operator);
    gate.interact(operator);

    expect(operator.specOpsCash).toBe(250);
    expect(gate.destroyed).toBe(true);
    expect(game.specOps!.ensureNavGraph().hasPath(operator, courtyard)).toBe(true);
});

test("Last Call spawns zombies at fixed entries in currently reachable zones", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    game.specOps!.startNextWave();
    game.specOps!.drainWaveSpawnQueuePublic();
    game.update(0.05);

    const zombies = game.playerBarn.livingPlayers.filter((player) => player.specOpsAi);
    const entries = game.map.obstacles.filter((obstacle) => obstacle.type === "zombie_spawn_point");
    expect(zombies.length).toBeGreaterThan(0);
    expect(
        zombies.every((zombie) => game.specOps!.ensureNavGraph().hasPath(zombie, operator.pos)),
    ).toBe(true);
    expect(
        zombies.every((zombie) => entries.some((entry) => v2.distance(zombie.pos, entry.pos) <= 6)),
    ).toBe(true);
});

test("Last Call power opens the garage and enables weapon upgrades", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    const powerSwitch = game.map.obstacles.find((obstacle) => obstacle.type === "zombie_power_switch")!;
    const powerGate = game.map.obstacles.find((obstacle) => obstacle.type === "zombie_power_gate")!;
    const bench = game.map.obstacles.find((obstacle) => obstacle.type === "zombie_upgrade_bench")!;

    expect(game.specOps!.zombiePowerOn).toBe(false);
    expect(bench.button?.canUse).toBe(false);
    v2.set(operator.pos, powerSwitch.pos);
    game.grid.updateObject(operator);
    powerSwitch.interact(operator);

    expect(game.specOps!.zombiePowerOn).toBe(true);
    expect(powerGate.destroyed).toBe(true);
    expect(bench.button?.canUse).toBe(true);

    const gun = operator.weapons[GameConfig.WeaponSlot.Primary];
    const beforeClip = operator.weaponManager.getAmmoStats(
        GameObjectDefs.typeToDef(gun.type, "gun"),
        gun.type,
    ).maxClip;
    game.specOps!.grantCash(operator, ZombieUpgradeCost);
    const paidCash = operator.specOpsCash;
    v2.set(operator.pos, bench.pos);
    game.grid.updateObject(operator);
    bench.interact(operator);

    expect(operator.specOpsCash).toBe(paidCash - ZombieUpgradeCost);
    expect(operator.specOpsUpgradedWeapons.has(gun.type)).toBe(true);
    expect(
        operator.weaponManager.getAmmoStats(
            GameObjectDefs.typeToDef(gun.type, "gun"),
            gun.type,
        ).maxClip,
    ).toBeGreaterThan(beforeClip);
});

test("Last Call relocates the Mystery Box after repeated uses", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    const box = game.map.obstacles.find((obstacle) => obstacle.type === "zombie_mystery_box")!;
    const startingPos = v2.copy(box.pos);

    for (let use = 0; use < ZombieMysteryBoxRelocateUses; use++) {
        v2.set(operator.pos, v2.add(box.pos, v2.create(0, -3)));
        game.grid.updateObject(operator);
        game.specOps!.grantCash(operator, ZombieMysteryBoxCost);
        box.interact(operator);
        game.step(
            ZombieMysteryBoxRollDuration
                + ZombieMysteryBoxClaimDuration
                + ZombieMysteryBoxCooldown
                + 0.5,
        );
    }

    expect(v2.distance(box.pos, startingPos)).toBeGreaterThan(4);
    expect(box.button?.canUse).toBe(true);
});

test("Zombie wave one spawns unarmed melee walkers with cash bounties", () => {
    const game = createGame(TeamMode.Solo, "specops");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    expect(game.specOps?.zombieMode).toBe(true);
    game.specOps!.startNextWave();
    game.specOps!.drainWaveSpawnQueuePublic();
    game.update(0.05);

    const zombies = game.playerBarn.livingPlayers.filter((player) => player.specOpsAi);
    expect(zombies).toHaveLength(6);
    expect(zombies.every((zombie) => zombie.name === "Zombie")).toBe(true);
    expect(
        zombies.every((zombie) => !zombie.weapons[GameConfig.WeaponSlot.Primary].type),
    ).toBe(true);
    expect(
        zombies.every((zombie) => zombie.weapons[GameConfig.WeaponSlot.Melee].type === "fists"),
    ).toBe(true);
    expect(zombies.every((zombie) => zombie.specOpsBounty === 100)).toBe(true);
    expect(zombies.every((zombie) => zombie.health === 42)).toBe(true);
    expect(zombies.every((zombie) => zombie.indoors)).toBe(true);

    const start = v2.copy(zombies[0].pos);
    game.step(0.5);
    expect(v2.distance(zombies[0].pos, start)).toBeGreaterThan(0.05);
});

test("Zombies pursue operators through multiple rooms and hinged doors", () => {
    const game = createGame(TeamMode.Solo, "specops");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    v2.set(operator.pos, v2.create(30, 29));
    game.grid.updateObject(operator);
    const zombie = game.specOps!.spawnEnemyPublic("zombie_walker");
    v2.set(zombie.pos, v2.create(98, 83));
    game.grid.updateObject(zombie);
    game.specOps!.getBrainPublic(zombie)?.alertTo(operator.pos);

    const startDistance = v2.distance(zombie.pos, operator.pos);
    game.step(15);

    expect(startDistance).toBeGreaterThan(80);
    expect(v2.distance(zombie.pos, operator.pos)).toBeLessThan(15);
    expect(
        game.map.obstacles.some(
            (obstacle) => obstacle.type.startsWith("house_door_") && obstacle.door?.open,
        ),
    ).toBe(true);
});

test("Indoor zombies remember room portals and yield to the zombie ahead at doors", () => {
    const game = createGame(TeamMode.Solo, "specops");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    v2.set(operator.pos, v2.create(30, 50));
    game.grid.updateObject(operator);
    const leader = game.specOps!.spawnEnemyPublic("zombie_walker");
    const trailer = game.specOps!.spawnEnemyPublic("zombie_walker");
    v2.set(leader.pos, v2.create(30, 76.5));
    v2.set(trailer.pos, v2.create(30, 79));
    game.grid.updateObject(leader);
    game.grid.updateObject(trailer);
    const leaderBrain = game.specOps!.getBrainPublic(leader)!;
    const trailerBrain = game.specOps!.getBrainPublic(trailer)!;
    leaderBrain.alertTo(operator.pos);
    trailerBrain.alertTo(operator.pos);

    game.update(0.1);

    expect(leaderBrain.indoorRouteGoalCell).toBe("0,1");
    expect(trailerBrain.indoorRouteGoalCell).toBe("0,1");
    expect(leaderBrain.indoorRoute.length).toBeGreaterThan(0);
    expect(trailerBrain.indoorRoute.length).toBeGreaterThan(0);
    expect(leaderBrain.indoorRouteLane).not.toBe(trailerBrain.indoorRouteLane);
    expect(leaderBrain.doorYieldTicker).toBe(0);
    expect(trailerBrain.doorYieldTicker).toBeGreaterThan(0);
});

test("Indoor zombies recover from repeated stalls and rebuild their remembered route", () => {
    const game = createGame(TeamMode.Solo, "specops");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);

    v2.set(operator.pos, v2.create(30, 29));
    game.grid.updateObject(operator);
    const zombie = game.specOps!.spawnEnemyPublic("zombie_walker");
    v2.set(zombie.pos, v2.create(98, 83));
    game.grid.updateObject(zombie);
    const brain = game.specOps!.getBrainPublic(zombie)!;
    brain.alertTo(operator.pos);
    brain.stuckTicker = 0.8;
    brain.stuckStrikes = 2;
    brain.lastPos = v2.copy(zombie.pos);
    brain.indoorRoute = [v2.create(1, 1)];
    brain.indoorRouteGoalCell = "stale";
    const start = v2.copy(zombie.pos);

    game.update(0.1);

    expect(brain.stuckStrikes).toBe(1);
    expect(v2.distance(zombie.pos, start)).toBeGreaterThan(0.2);
    expect(brain.indoorRouteGoalCell).toBe("0,0");
    expect(brain.indoorRoute.length).toBeGreaterThan(1);
});

test("Mystery Box charges once, synchronizes its roll, and replaces the held gun", () => {
    const game = createGame(TeamMode.Duo, "specops");
    const buyer = game.playerBarn.addTestPlayer({ name: "Buyer" });
    const teammate = game.playerBarn.addTestPlayer({ name: "Teammate" });
    game.update(0.1);
    const box = game.map.obstacles.find((obstacle) => obstacle.type === "zombie_mystery_box")!;
    const interactionPos = v2.add(box.pos, v2.create(0, -4.5));
    v2.set(buyer.pos, interactionPos);
    v2.set(teammate.pos, interactionPos);
    game.grid.updateObject(buyer);
    game.grid.updateObject(teammate);

    const startingCash = buyer.specOpsCash;
    expect(startingCash).toBeLessThan(ZombieMysteryBoxCost);
    box.interact(buyer);
    expect(buyer.specOpsCash).toBe(startingCash);
    expect(box.button?.canUse).toBe(true);

    game.specOps!.grantCash(buyer, ZombieMysteryBoxCost);
    const paidCash = buyer.specOpsCash;
    box.interact(buyer);
    expect(buyer.specOpsCash).toBe(paidCash - ZombieMysteryBoxCost);
    expect(box.button?.onOff).toBe(true);
    expect(box.button?.canUse).toBe(false);
    let preview = game.lootBarn.loots.find((loot) => loot.mysteryBoxId === box.__id)!;
    expect(preview.mysteryBoxLocked).toBe(true);
    expect(ZombieMysteryBoxWeapons).toContain(preview.type);

    const teammateCash = teammate.specOpsCash;
    box.interact(teammate);
    expect(teammate.specOpsCash).toBe(teammateCash);
    expect(game.lootBarn.loots.filter((loot) => loot.mysteryBoxId === box.__id)).toHaveLength(1);

    game.step(ZombieMysteryBoxRollDuration + 0.2);
    preview = game.lootBarn.loots.find(
        (loot) => loot.mysteryBoxId === box.__id && !loot.destroyed,
    )!;
    expect(preview.mysteryBoxLocked).toBe(false);
    expect(box.button?.canUse).toBe(true);

    buyer.weaponManager.setWeapon(GameConfig.WeaponSlot.Secondary, "glock", 17);
    buyer.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
    box.interact(buyer);
    expect(preview.destroyed).toBe(false);
    expect(box.button?.canUse).toBe(true);

    const replacedSlot = GameConfig.WeaponSlot.Secondary;
    buyer.weaponManager.setCurWeapIndex(replacedSlot);
    box.interact(buyer);
    expect(preview.destroyed).toBe(true);
    expect(buyer.weapons[replacedSlot].type).toBe(preview.type);
    expect(buyer.weapons[replacedSlot].ammo).toBeGreaterThan(0);
    expect(buyer.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m9");

    game.update(0.1);
    expect(box.button?.onOff).toBe(false);
    expect(box.button?.canUse).toBe(false);
    game.step(ZombieMysteryBoxCooldown + 0.1);
    expect(box.button?.canUse).toBe(true);
});

test("Mystery Box fills an empty gun slot when the player takes it while holding fists", () => {
    const game = createGame(TeamMode.Solo, "specops");
    const buyer = game.playerBarn.addTestPlayer({ name: "Buyer" });
    game.update(0.1);
    const box = game.map.obstacles.find((obstacle) => obstacle.type === "zombie_mystery_box")!;
    v2.set(buyer.pos, v2.add(box.pos, v2.create(0, -4.5)));
    game.grid.updateObject(buyer);
    game.specOps!.grantCash(buyer, ZombieMysteryBoxCost);
    box.interact(buyer);
    game.step(ZombieMysteryBoxRollDuration + 0.2);
    const prize = game.lootBarn.loots.find(
        (loot) => loot.mysteryBoxId === box.__id && !loot.destroyed,
    )!;

    expect(buyer.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("");
    buyer.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
    box.interact(buyer);

    expect(prize.destroyed).toBe(true);
    expect(buyer.weapons[GameConfig.WeaponSlot.Secondary].type).toBe(prize.type);
    expect(buyer.curWeapIdx).toBe(GameConfig.WeaponSlot.Secondary);
});
