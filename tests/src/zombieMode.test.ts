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
    expect(game.map.buildings.some((building) => building.type === "zombie_indoor_arena_01"))
        .toBe(true);
    const doors = game.map.obstacles.filter((obstacle) => obstacle.type === "zombie_door_01");
    expect(doors).toHaveLength(8);
    expect(doors.every((door) => door.isDoor && door.door?.canUse)).toBe(true);
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
