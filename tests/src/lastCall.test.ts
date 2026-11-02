import { describe, expect, test } from "vitest";
import en from "../../client/src/en.json";
import type { Game } from "../../server/src/game/game.ts";
import { lastCallOpenZones, lastCallWalkable } from "../../server/src/game/lastCallNav.ts";
import type { Obstacle } from "../../server/src/game/objects/obstacle.ts";
import {
    LastCallBoxSpots,
    LastCallBuildingType,
    LastCallDoors,
    LastCallEntries,
    lastCallFromLocal,
    LastCallPlayerSpawns,
    LastCallProps,
    LastCallStations,
    lastCallToLocal,
    lastCallWalls,
    lastCallZoneAt,
    type LastCallZoneId,
    LastCallZones,
} from "../../shared/defs/maps/lastCallLayout.ts";
import { MapObjectDefs } from "../../shared/defs/register.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { ObjectType } from "../../shared/net/objectSerializeFns.ts";
import { collider } from "../../shared/utils/collider.ts";
import { v2, type Vec2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

const translations = en as Record<string, string>;

function startLastCall() {
    const game = createGame(TeamMode.Solo, "specops_complex");
    const operator = game.playerBarn.addTestPlayer({ name: "Operator" });
    game.update(0.1);
    const block = game.map.buildings.find((b) => b.type === LastCallBuildingType)!;
    const world = (p: Vec2) => v2.add(block.pos, lastCallToLocal(p.x, p.y));
    const plan = (p: Vec2) => lastCallFromLocal(v2.sub(p, block.pos));
    return { game, operator, world, plan };
}

function doorCenter(id: string): Vec2 {
    const o = LastCallDoors.find((d) => d.id === id)!.opening;
    const mid = (o.a0 + o.a1) / 2;
    return o.axis === "h" ? v2.create(mid, o.at) : v2.create(o.at, mid);
}

/** Buy a shutter the way a player does: stand in it and use it. */
function buy(game: Game, world: (p: Vec2) => Vec2, id: string): Obstacle {
    const center = world(doorCenter(id));
    const gate = game.map.obstacles.find(
        (o) => o.type.startsWith("zombie_buy_gate_") && v2.distance(o.pos, center) < 0.5,
    )!;
    const operator = game.playerBarn.livingPlayers.find((p) => !p.specOpsAi)!;
    const back = v2.copy(operator.pos);
    v2.set(operator.pos, center);
    game.grid.updateObject(operator);
    operator.specOpsCash = 99999;
    gate.interact(operator);
    v2.set(operator.pos, back);
    game.grid.updateObject(operator);
    return gate;
}

function inZone(zone: LastCallZoneId, p: Vec2, inset: number): boolean {
    const r = LastCallZones.find((z) => z.id === zone)!.rect;
    return p.x >= r.x0 + inset && p.x <= r.x1 - inset && p.y >= r.y0 + inset && p.y <= r.y1 - inset;
}

describe("Last Call layout", () => {
    test("every doorway sits on the wall between its two zones", () => {
        for (const d of LastCallDoors) {
            if (d.kind === "room") continue;
            const o = d.opening;
            const mid = (o.a0 + o.a1) / 2;
            const [a, b] = o.axis === "h"
                ? [v2.create(mid, o.at - 1), v2.create(mid, o.at + 1)]
                : [v2.create(o.at - 1, mid), v2.create(o.at + 1, mid)];
            expect([lastCallZoneAt(a), lastCallZoneAt(b)].sort(), d.id).toEqual([...d.zones].sort());
        }
    });

    test("no wall runs through a doorway", () => {
        for (const d of LastCallDoors) {
            const o = d.opening;
            for (const w of lastCallWalls()) {
                if (w.axis !== o.axis || w.at !== o.at) continue;
                expect(Math.min(w.a1, o.a1) - Math.max(w.a0, o.a0), d.id).toBeLessThanOrEqual(0.01);
            }
        }
    });

    test("spawns, stations, box spots and props stay inside their rooms", () => {
        for (const s of LastCallStations) expect(inZone(s.zone, s.pos, 2), `station ${s.type}`).toBe(true);
        for (const b of LastCallBoxSpots) expect(inZone(b.zone, b.pos, 2), "box spot").toBe(true);
        for (const e of LastCallEntries) expect(inZone(e.zone, e.pos, 1.5), "entry").toBe(true);
        for (const p of LastCallPlayerSpawns) expect(lastCallZoneAt(p, 1.5)).toBe("lobby");
        for (const p of LastCallProps) {
            expect(MapObjectDefs.typeExists(p.type), p.type).toBe(true);
            expect(lastCallZoneAt(p.pos), p.type).toBeDefined();
        }
    });

    test("every shutter price has a prompt", () => {
        for (const d of LastCallDoors.filter((door) => door.kind === "shutter")) {
            expect(translations[`game-zombie_buy_gate_${d.cost}`]).toContain(String(d.cost));
        }
    });

    test("the generated block has solid walls where the art draws them", () => {
        const { game, world } = startLastCall();
        for (const w of lastCallWalls()) {
            const mid = (w.a0 + w.a1) / 2;
            const p = world(w.axis === "h" ? v2.create(mid, w.at) : v2.create(w.at, mid));
            const hits = game.grid.intersectCollider(collider.createCircle(p, 0.1));
            const solid = hits.some((o) => o.__type === ObjectType.Obstacle && o.type.startsWith("lastcall_wall_"));
            expect(solid, `wall ${w.axis}${w.at}`).toBe(true);
        }
        // nothing collidable overlaps a zombie entry point
        for (const e of LastCallEntries) {
            const circle = collider.createCircle(world(e.pos), 1);
            const blocked = game.grid.intersectCollider(circle).some((o) =>
                o.__type === ObjectType.Obstacle && o.collidable && !o.dead
                && collider.intersectCircle(o.collider, circle.pos, circle.rad)
            );
            expect(blocked, `entry ${e.pos.x},${e.pos.y}`).toBe(false);
        }
    });
});

describe("Last Call rooms", () => {
    test("only rooms behind bought shutters count as open", () => {
        const { game, world } = startLastCall();
        expect([...lastCallOpenZones(game)]).toEqual(["lobby"]);
        buy(game, world, "lobby_storage");
        // storage opens the free doorway into the alley as well
        expect([...lastCallOpenZones(game)].sort()).toEqual(["alley", "lobby", "storage"]);
    });

    test("zombies never appear in rooms the squad hasn't opened", () => {
        const { game, operator, plan } = startLastCall();
        for (let wave = 0; wave < 3; wave++) {
            game.specOps!.startNextWave();
            game.specOps!.drainWaveSpawnQueuePublic();
            for (let i = 0; i < 30; i++) {
                operator.health = operator.maxHealth;
                game.update(0.1);
            }
            for (const z of game.specOps!.livingEnemies()) {
                expect(lastCallZoneAt(plan(z.pos))).toBe("lobby");
            }
            for (const z of game.specOps!.livingEnemies()) {
                z.kill({ damageType: 1, dir: v2.create(1, 0) } as never);
            }
        }
    });

    test("AI can path from the lobby to every room once everything is open", () => {
        const { game, operator, world } = startLastCall();
        for (const d of LastCallDoors.filter((door) => door.kind === "shutter")) buy(game, world, d.id);
        const powerSwitch = game.map.obstacles.find((o) => o.type === "zombie_power_switch")!;
        v2.set(operator.pos, powerSwitch.pos);
        game.grid.updateObject(operator);
        powerSwitch.interact(operator);
        expect(game.specOps!.zombiePowerOn).toBe(true);

        const graph = game.specOps!.ensureNavGraph();
        const from = world(LastCallPlayerSpawns[0]);
        for (const z of LastCallZones) {
            const r = z.rect;
            // probe a few points in the room, skip any that land on a prop
            const goal = [0.5, 0.3, 0.7]
                .map((t) => world(v2.create(r.x0 + (r.x1 - r.x0) * t, r.y0 + (r.y1 - r.y0) * t)))
                .find((p) => lastCallWalkable(game, p, p, 1.1))!;
            const path = graph.path(game, from, goal, 0, 0);
            expect(path, z.id).not.toBeNull();
            // every leg of the path fits a zombie (no cutting through walls or corners)
            const legs = [from, ...path!];
            for (let i = 1; i < legs.length - 1; i++) {
                expect(lastCallWalkable(game, legs[i - 1], legs[i], 0.9), `${z.id} leg ${i}`).toBe(true);
            }
        }
    });
});
