import {
    LastCallBuildingType,
    type LastCallDoor,
    LastCallDoors,
    lastCallFromLocal,
    LastCallMapName,
    lastCallToLocal,
    lastCallZoneAt,
    type LastCallZoneId,
    LastCallZones,
} from "../../../shared/defs/maps/lastCallLayout.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { coldet } from "../../../shared/utils/coldet.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "./game.ts";
import type { Building } from "./objects/building.ts";
import type { Obstacle } from "./objects/obstacle.ts";

/**
 * Layout-aware helpers for Last Call (`specops_complex`). The whole map is one
 * building split into rooms, so the generic Spec Ops spawn/nav code needs to
 * know which rooms the squad has actually opened and where the doorways are.
 */

/** The Last Call block, or undefined on every other map. */
export function lastCallBlock(game: Game): Building | undefined {
    if (game.config.mapName !== LastCallMapName) return undefined;
    return game.map.buildings.find((b) => b.type === LastCallBuildingType);
}

function toWorld(block: Building, plan: Vec2): Vec2 {
    return v2.add(block.pos, lastCallToLocal(plan.x, plan.y));
}

function toPlan(block: Building, world: Vec2): Vec2 {
    return lastCallFromLocal(v2.sub(world, block.pos));
}

function doorCenter(door: LastCallDoor): Vec2 {
    const o = door.opening;
    const mid = (o.a0 + o.a1) / 2;
    return o.axis === "h" ? v2.create(mid, o.at) : v2.create(o.at, mid);
}

/** True once nothing blocks the doorway (shutter bought, power on, or never blocked). */
function doorPassable(block: Building, door: LastCallDoor): boolean {
    if (door.kind === "open" || door.kind === "room") return true;
    const center = toWorld(block, doorCenter(door));
    for (const child of block.childObjects) {
        if (child.__type !== ObjectType.Obstacle) continue;
        const obs = child as Obstacle;
        if (obs.dead || obs.destroyed) continue;
        if (!obs.type.startsWith("zombie_buy_gate_") && obs.type !== "zombie_power_gate") continue;
        if (v2.distance(obs.pos, center) < 0.75) return false;
    }
    return true;
}

/** Zones connected to a living operator through passable doorways. */
export function lastCallOpenZones(game: Game, block = lastCallBlock(game)): Set<LastCallZoneId> {
    const open = new Set<LastCallZoneId>();
    if (!block) return open;
    const queue: LastCallZoneId[] = [];
    for (const p of game.playerBarn.livingPlayers) {
        if (p.specOpsAi) continue;
        const zone = lastCallZoneAt(toPlan(block, p.pos));
        if (zone && !open.has(zone)) {
            open.add(zone);
            queue.push(zone);
        }
    }
    if (!queue.length) {
        open.add("lobby");
        queue.push("lobby");
    }
    const passable = LastCallDoors.filter((d) => d.zones[0] !== d.zones[1] && doorPassable(block, d));
    while (queue.length) {
        const zone = queue.shift()!;
        for (const d of passable) {
            const other = d.zones[0] === zone ? d.zones[1] : d.zones[1] === zone ? d.zones[0] : undefined;
            if (other && !open.has(other)) {
                open.add(other);
                queue.push(other);
            }
        }
    }
    return open;
}

/** "" off Last Call; otherwise the rooms of both points, for path-cache keys. */
export function lastCallRoomKey(game: Game, a: Vec2, b: Vec2): string {
    const block = lastCallBlock(game);
    if (!block) return "";
    return `|${lastCallZoneAt(toPlan(block, a)) ?? "-"}|${lastCallZoneAt(toPlan(block, b)) ?? "-"}`;
}

/** False when `pos` is outside the block or in a room the squad hasn't opened. */
export function lastCallPosReachable(game: Game, pos: Vec2, open?: Set<LastCallZoneId>): boolean {
    const block = lastCallBlock(game);
    if (!block) return true;
    const zone = lastCallZoneAt(toPlan(block, pos), 0.5);
    return !!zone && (open ?? lastCallOpenZones(game, block)).has(zone);
}

/** Waypoints on a 6-unit grid over every room (the generic sampler is too coarse for doorways). */
export function lastCallNavPoints(game: Game): Vec2[] {
    const block = lastCallBlock(game);
    if (!block) return [];
    const out: Vec2[] = [];
    for (const z of LastCallZones) {
        const r = z.rect;
        for (let x = r.x0 + 2.5; x <= r.x1 - 2.5; x += 6) {
            for (let y = r.y0 + 2.5; y <= r.y1 - 2.5; y += 6) out.push(toWorld(block, v2.create(x, y)));
        }
    }
    return out;
}

/** Linked node pairs 2.5 units either side of every doorway that is currently passable. */
export function lastCallNavPortals(game: Game): Array<[Vec2, Vec2]> {
    const block = lastCallBlock(game);
    if (!block) return [];
    const out: Array<[Vec2, Vec2]> = [];
    for (const d of LastCallDoors) {
        if (!doorPassable(block, d)) continue;
        const c = doorCenter(d);
        const off = 2.5;
        const [a, b] = d.opening.axis === "h"
            ? [v2.create(c.x, c.y - off), v2.create(c.x, c.y + off)]
            : [v2.create(c.x - off, c.y), v2.create(c.x + off, c.y)];
        out.push([toWorld(block, a), toWorld(block, b)]);
    }
    return out;
}

/**
 * A body of radius `rad` fits along the straight line from a to b: the segment
 * misses every collidable obstacle grown by `rad` (boxes grow with square
 * corners, so this errs on the safe side at corners).
 */
export function lastCallWalkable(game: Game, a: Vec2, b: Vec2, rad = 1.05): boolean {
    const bounds = collider.createAabb(
        v2.create(Math.min(a.x, b.x) - rad, Math.min(a.y, b.y) - rad),
        v2.create(Math.max(a.x, b.x) + rad, Math.max(a.y, b.y) + rad),
    );
    for (const obj of game.grid.intersectCollider(bounds)) {
        if (obj.__type !== ObjectType.Obstacle) continue;
        const obs = obj as Obstacle;
        if (obs.dead || obs.destroyed || !obs.collidable || obs.layer !== 0 || obs.isDoor) continue;
        const col = obs.collider;
        const grown = col.type === collider.Type.Circle
            ? collider.createCircle(col.pos, col.rad + rad)
            : collider.createAabb(
                v2.create(col.min.x - rad, col.min.y - rad),
                v2.create(col.max.x + rad, col.max.y + rad),
            );
        if (collider.intersectSegment(grown, a, b)) return false;
        // a segment that starts inside the grown shape doesn't "intersect" it
        if (coldet.test(collider.createCircle(a, rad), col)) return false;
    }
    return true;
}
