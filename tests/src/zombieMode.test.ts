import { expect, test } from "vitest";

import { composeZombieWave, zombieEnemyHealth, zombieWaveCount } from "../../server/src/game/zombieMode.ts";
import { MapDefs } from "../../shared/defs/mapDefs.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

test("Zombie Survival uses a dedicated, scaling zombie wave profile", () => {
    expect(zombieWaveCount(1, 1)).toBe(6);
    expect(zombieWaveCount(10, 1)).toBeGreaterThan(zombieWaveCount(1, 1));
    expect(zombieWaveCount(10, 4)).toBeGreaterThan(zombieWaveCount(10, 1));
    expect(zombieWaveCount(100, 8)).toBe(48);
    expect(composeZombieWave(3, 1).every((kind) => kind === "zombie_walker")).toBe(true);
    expect(zombieEnemyHealth(10)).toBeGreaterThan(zombieEnemyHealth(1));
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
    expect(operator.indoors).toBe(true);
    expect(Math.abs(operator.pos.x - game.map.center.x)).toBeLessThan(8);
    expect(Math.abs(operator.pos.y - game.map.center.y)).toBeLessThan(8);
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
