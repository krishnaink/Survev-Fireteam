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
import { FireteamMapPool, ZombieMapPool } from "../../shared/defs/maps/specOpsDefs.ts";
import { ZombiePerkMachines, ZombiePerkMachineTypes } from "../../shared/defs/maps/zombiePerks.ts";
import {
    isZombiePowerUpType,
    ZombieNukeCash,
    zombiePowerUpBudget,
    zombiePowerUpFlashVisible,
    zombiePowerUpHudFlashPeriod,
    ZombiePowerUpLifetime,
    ZombieTimedPowerUpDuration,
} from "../../shared/defs/maps/zombiePowerUps.ts";
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
    expect(zombiePowerUpBudget(1)).toBe(2);
    expect(zombiePowerUpBudget(11)).toBe(4);
    expect(zombiePowerUpBudget(100)).toBe(5);
    expect(zombiePowerUpHudFlashPeriod(1)).toBeLessThan(zombiePowerUpHudFlashPeriod(5));

    const flashes = (start: number, end: number) => {
        let transitions = 0;
        let previous = zombiePowerUpFlashVisible(start);
        for (let age = start + 0.01; age <= end; age += 0.01) {
            const visible = zombiePowerUpFlashVisible(age);
            if (visible !== previous) transitions++;
            previous = visible;
        }
        return transitions;
    };
    expect(flashes(29, 30)).toBeGreaterThan(flashes(25, 26));
});

test("Max Ammo refills every living operator without changing loaded magazines", () => {
    const game = createGame(TeamMode.Duo, "specops_complex");
    const first = game.playerBarn.addTestPlayer({ name: "First" });
    const second = game.playerBarn.addTestPlayer({ name: "Second" });
    game.update(0.1);

    first.weapons[GameConfig.WeaponSlot.Primary].ammo = 3;
    second.weapons[GameConfig.WeaponSlot.Primary].ammo = 5;
    first.invManager.set("9mm", 0);
    second.invManager.set("9mm", 1);
    first.invManager.set("frag", 0);
    second.invManager.set("frag", 1);

    game.specOps!.activateZombiePowerUp("zombie_powerup_max_ammo");

    expect(first.weapons[GameConfig.WeaponSlot.Primary].ammo).toBe(3);
    expect(second.weapons[GameConfig.WeaponSlot.Primary].ammo).toBe(5);
    for (const player of [first, second]) {
        expect(player.invManager.get("9mm")).toBe(player.invManager.getMaxCapacity("9mm"));
        expect(player.invManager.get("frag")).toBe(player.invManager.getMaxCapacity("frag"));
    }
});

test("Insta-Kill one-shots walkers, doubles elite damage, and expires for the team", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.startNextWave();
    game.specOps!.drainWaveSpawnQueuePublic();
    const walker = game.specOps!.livingEnemies()[0];
    const elite = game.specOps!.spawnEnemyPublic("juggernaut")!;

    game.specOps!.activateZombiePowerUp("zombie_powerup_insta_kill");
    game.specOps!.setNpcIgnoreOperators(true);
    expect(game.specOps!.modifyZombieDamage(elite, operator, 11)).toBe(22);
    walker.damage({
        amount: 1,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: operator,
    });
    expect(walker.dead).toBe(true);
    expect(operator.zombiePowerUps.instaKill).toBe(ZombieTimedPowerUpDuration);

    game.step(ZombieTimedPowerUpDuration + 0.1);
    expect(game.specOps!.isZombiePowerUpActive("instaKill")).toBe(false);
    expect(operator.zombiePowerUps.instaKill).toBe(0);
});

test("Double Points affects zombie kills and Nuke team cash only", () => {
    const game = createGame(TeamMode.Duo, "specops_complex");
    const first = game.playerBarn.addTestPlayer({ name: "First" });
    const second = game.playerBarn.addTestPlayer({ name: "Second" });
    game.update(0.1);
    game.specOps!.startNextWave();
    game.specOps!.drainWaveSpawnQueuePublic();
    const [target] = game.specOps!.livingEnemies();

    game.specOps!.activateZombiePowerUp("zombie_powerup_double_points");
    const firstCash = first.specOpsCash;
    target.damage({
        amount: 9999,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(1, 0),
        source: first,
    });
    expect(first.specOpsCash - firstCash).toBe(200);

    const beforeNuke = [first.specOpsCash, second.specOpsCash];
    game.specOps!.activateZombiePowerUp("zombie_powerup_nuke");
    expect(first.specOpsCash - beforeNuke[0]).toBe(ZombieNukeCash * 2);
    expect(second.specOpsCash - beforeNuke[1]).toBe(ZombieNukeCash * 2);
    expect(game.specOps!.livingEnemies()).toHaveLength(0);
});

test("Nuke removes ordinary zombies and takes 35% of an elite's current health", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.startNextWave();
    game.specOps!.drainWaveSpawnQueuePublic();
    const walkers = [...game.specOps!.livingEnemies()];
    const elite = game.specOps!.spawnEnemyPublic("juggernaut")!;
    const eliteHealth = elite.health;

    game.specOps!.activateZombiePowerUp("zombie_powerup_nuke");

    expect(walkers.every((walker) => walker.dead)).toBe(true);
    expect(elite.dead).toBe(false);
    expect(elite.health).toBeCloseTo(eliteHealth * 0.65, 5);
    expect(game.lootBarn.loots.some((loot) => isZombiePowerUpType(loot.type))).toBe(false);
});

test("Zombie power-up loot activates on touch and expires when ignored", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    const pickup = game.specOps!.spawnZombiePowerUp(
        "zombie_powerup_double_points",
        v2.copy(operator.pos),
        operator.layer,
    )!;

    game.update(0.2);
    expect(pickup.destroyed).toBe(true);
    expect(game.specOps!.isZombiePowerUpActive("doublePoints")).toBe(true);

    const ignored = game.specOps!.spawnZombiePowerUp(
        "zombie_powerup_max_ammo",
        v2.add(operator.pos, v2.create(10, 0)),
        operator.layer,
    )!;
    game.step(ZombiePowerUpLifetime + 0.1);
    expect(ignored.destroyed).toBe(true);
});

test("AI zombies pass through power-ups without collecting or removing them", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.startNextWave();
    game.specOps!.drainWaveSpawnQueuePublic();
    const zombie = game.specOps!.livingEnemies()[0];
    const pickup = game.specOps!.spawnZombiePowerUp(
        "zombie_powerup_insta_kill",
        v2.copy(zombie.pos),
        zombie.layer,
    )!;

    zombie.pickupLoot(pickup);
    game.update(0.2);

    expect(zombie.getClosestLoot()).toBeUndefined();
    expect(pickup.destroyed).toBe(false);
    expect(game.specOps!.isZombiePowerUpActive("instaKill")).toBe(false);
});

test("Zombie kills create at most one early-wave drop during the minimum interval", () => {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    game.specOps!.startNextWave();
    game.specOps!.drainWaveSpawnQueuePublic();

    for (const zombie of [...game.specOps!.livingEnemies()]) {
        zombie.damage({
            amount: 9999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            source: operator,
        });
    }

    const drops = game.lootBarn.loots.filter(
        (loot) => !loot.destroyed && isZombiePowerUpType(loot.type),
    );
    expect(drops).toHaveLength(1);
    expect(game.specOps!.zombieDropsRemaining).toBe(1);
});

test("Fireteam maps run classic Spec Ops and Zombies maps run zombie rules", () => {
    for (const key of FireteamMapPool) {
        expect(MapDefs[key].gameMode.specOpsMode).toBe(true);
        expect(MapDefs[key].gameMode.zombieMode).not.toBe(true);
        expect(MapDefs[key].gameMode.indoorMode).not.toBe(true);
    }
    expect(MapDefs.specops.gameMode.zombieMode).not.toBe(true);
    for (const key of ZombieMapPool) {
        expect(MapDefs[key].desc.name).toBe("Zombie Survival");
        expect(MapDefs[key].gameMode.specOpsMode).toBe(true);
        expect(MapDefs[key].gameMode.zombieMode).toBe(true);
        expect(MapDefs[key].gameMode.indoorMode).toBe(true);
    }
    expect(MapDefs.practice_specops.gameMode.zombieMode).toBe(false);
    expect(MapObjectDefs).not.toHaveProperty("zombie_indoor_arena_01");
});

test("Fireteam matches spawn soldiers, not zombies", () => {
    const game = createGame(TeamMode.Solo, "specops_woods");
    game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    expect(game.specOps?.zombieMode).toBe(false);
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
    const game = createGame(TeamMode.Solo, "specops_complex");
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

test("Mystery Box charges once, synchronizes its roll, and replaces the held gun", () => {
    const game = createGame(TeamMode.Duo, "specops_complex");
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
    const game = createGame(TeamMode.Solo, "specops_complex");
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
