import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { coldet } from "../../../shared/utils/coldet.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { math } from "../../../shared/utils/math.ts";
import { util } from "../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "./game.ts";
import {
    lastCallBlock,
    lastCallNavPoints,
    lastCallNavPortals,
    lastCallRoomKey,
    lastCallWalkable,
} from "./lastCallNav.ts";
import type { Building } from "./objects/building.ts";
import type { Obstacle } from "./objects/obstacle.ts";
import type { Player } from "./objects/player.ts";
import type { Structure } from "./objects/structure.ts";

type NavKind = "open" | "hull" | "door" | "window" | "stair" | "interior";

interface NavNode {
    id: number;
    pos: Vec2;
    layer: number;
    kind: NavKind;
    neighbors: number[];
    costs: number[];
}

type NavAabb = { min: Vec2; max: Vec2 };

const HashCell = 12;
const GridStep = 16;
const LinkRadius = 18;
const StairLinkRadius = 42;
const DoorHullLinkRadius = 28;
const MaxExtraLinks = 8;
const InteriorGridStep = 9;
const PathNearbyRadius = 16;
const PathNearbyStairRadius = 24;

function hashKey(cx: number, cy: number): number {
    return ((cx + 4096) & 0xffff) << 16 | ((cy + 4096) & 0xffff);
}

function toAabb(o: Obstacle): NavAabb {
    const box = collider.toAabb(o.collider);
    return { min: box.min, max: box.max };
}

function expandAabb(aabb: NavAabb, pad: number): NavAabb {
    return {
        min: v2.create(aabb.min.x - pad, aabb.min.y - pad),
        max: v2.create(aabb.max.x + pad, aabb.max.y + pad),
    };
}

function periLen(aabb: NavAabb): number {
    return 2 * ((aabb.max.x - aabb.min.x) + (aabb.max.y - aabb.min.y));
}

function periPoint(t: number, aabb: NavAabb): Vec2 {
    const w = aabb.max.x - aabb.min.x;
    const h = aabb.max.y - aabb.min.y;
    const peri = Math.max(periLen(aabb), 0.001);
    let s = t % peri;
    if (s < 0) s += peri;
    if (s <= w) return v2.create(aabb.min.x + s, aabb.min.y);
    s -= w;
    if (s <= h) return v2.create(aabb.max.x, aabb.min.y + s);
    s -= h;
    if (s <= w) return v2.create(aabb.max.x - s, aabb.max.y);
    s -= w;
    return v2.create(aabb.min.x, aabb.max.y - s);
}

function buildingHull(building: Building): NavAabb | undefined {
    const boxes: NavAabb[] = [];
    for (let i = 0; i < building.zoomRegions.length; i++) {
        const zoomIn = building.zoomRegions[i].zoomIn;
        if (zoomIn) boxes.push(zoomIn);
    }
    if (!boxes.length) return undefined;
    return coldet.boundingAabb(boxes as { min: Vec2; max: Vec2 }[]);
}

function navSolid(o: Obstacle, ignoreDoors: boolean): boolean {
    if (!o.active || o.dead || !o.collidable) return false;
    if (ignoreDoors && o.isDoor) return false;
    return true;
}

function pointClear(game: Game, pos: Vec2, layer: number, rad = 0.55): boolean {
    const circle = collider.createCircle(pos, rad);
    const objs = game.grid.intersectCollider(circle);
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!navSolid(o, true) || !util.sameLayer(o.layer, layer)) continue;
        if (coldet.test(circle, o.collider)) return false;
    }
    return true;
}

/** Closed doors count as passable so baked paths go through openings the AI can open. */
export function isWalkClear(
    game: Game,
    from: Vec2,
    to: Vec2,
    layer: number,
    pad = 0.55,
): boolean {
    const delta = v2.sub(to, from);
    const dist = v2.length(delta);
    if (dist < 0.25) return true;
    const dir = v2.normalizeSafe(delta);
    const end = v2.add(from, v2.mul(dir, dist));
    const objs = game.grid.intersectLineSegment(from, end);
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        const o = obj as Obstacle;
        if (!navSolid(o, true) || !util.sameLayer(o.layer, layer)) continue;
        const hit = collider.intersectSegment(o.collider, from, end);
        if (!hit) continue;
        const d = v2.length(v2.sub(hit.point, from));
        if (d < dist - pad) return false;
    }
    return true;
}

export function inferGroundLayer(game: Game, pos: Vec2, fallback: number): number {
    const objs = game.grid.intersectCollider(collider.createCircle(pos, 0.45));
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Building) continue;
        const building = obj as Building;
        for (let j = 0; j < building.zoomRegions.length; j++) {
            const zoomIn = building.zoomRegions[j].zoomIn;
            if (zoomIn && coldet.testPointAabb(pos, zoomIn.min, zoomIn.max)) {
                return util.toGroundLayer(building.layer);
            }
        }
    }
    return util.toGroundLayer(fallback);
}

/** Ground layer for pathfinding; stair transit layers keep their floor bit. */
export function navGroundLayer(layer: number): number {
    return util.toGroundLayer(layer);
}

type NavStair = Structure["stairs"][number];

export function stairAtPos(
    game: Game,
    pos: Vec2,
    rad = 0.55,
): { stair: NavStair; structure: Structure } | undefined {
    const objs = game.grid.intersectCollider(collider.createCircle(pos, rad));
    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Structure) continue;
        const structure = obj as Structure;
        for (let j = 0; j < structure.stairs.length; j++) {
            const stair = structure.stairs[j];
            if (stair.lootOnly) continue;
            if (coldet.testCircleAabb(pos, rad, stair.collision.min, stair.collision.max)) {
                return { stair, structure };
            }
        }
    }
    return undefined;
}

function doorNormal(door: Obstacle): Vec2 {
    const ori = door.door?.closedOri ?? door.ori;
    return v2.rotate(v2.create(1, 0), math.oriToRad(ori));
}

/** Stable center of the doorway frame. Door object positions are hinges. */
export function doorFrameCenter(door: Obstacle): Vec2 {
    const state = door.door;
    if (!state) return v2.copy(door.pos);
    return v2.add(
        state.closedPos,
        v2.rotate(state.hinge, math.oriToRad(state.closedOri)),
    );
}

function fixtureAway(fixture: Obstacle, building?: Building): Vec2 {
    if (building) {
        return v2.normalizeSafe(v2.sub(fixture.pos, building.pos), v2.create(1, 0));
    }
    return doorNormal(fixture);
}

function aabbCenter(aabb: NavAabb): Vec2 {
    return v2.create(
        (aabb.min.x + aabb.max.x) * 0.5,
        (aabb.min.y + aabb.max.y) * 0.5,
    );
}

class MinHeap {
    data: Array<{ id: number; f: number }> = [];

    push(id: number, f: number): void {
        this.data.push({ id, f });
        this.siftUp(this.data.length - 1);
    }

    pop(): number | undefined {
        if (!this.data.length) return undefined;
        const id = this.data[0].id;
        const last = this.data.pop()!;
        if (this.data.length) {
            this.data[0] = last;
            this.siftDown(0);
        }
        return id;
    }

    private siftUp(i: number): void {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.data[p].f <= this.data[i].f) break;
            const tmp = this.data[p];
            this.data[p] = this.data[i];
            this.data[i] = tmp;
            i = p;
        }
    }

    private siftDown(i: number): void {
        const n = this.data.length;
        while (true) {
            let s = i;
            const l = i * 2 + 1;
            const r = l + 1;
            if (l < n && this.data[l].f < this.data[s].f) s = l;
            if (r < n && this.data[r].f < this.data[s].f) s = r;
            if (s === i) break;
            const tmp = this.data[s];
            this.data[s] = this.data[i];
            this.data[i] = tmp;
            i = s;
        }
    }
}

/**
 * Static walk graph baked once after map gen: obstacle rings, building hulls,
 * both sides of every usable door, window peek spots, stair landings, and a
 * coarse open-field grid. A* on this graph is the planned path to the player.
 */
export class MapNavGraph {
    readonly nodes: NavNode[] = [];
    private cells = new Map<number, number[]>();
    private pathCache = new Map<string, Vec2[] | null>();

    static build(game: Game): MapNavGraph {
        const graph = new MapNavGraph();
        graph.sample(game);
        graph.link(game);
        graph.linkStairLandings(game);
        graph.linkDoorsToHull(game);
        // Last Call packs rooms, counters and a pool into one block: drop links an
        // operator-sized body can't actually walk, so paths keep clear of corners.
        if (lastCallBlock(game)) graph.pruneTightLinks(game, 1.05);
        return graph;
    }

    firstWaypoint(from: Player, goal: Vec2): Vec2 | undefined {
        const fromLayer = navGroundLayer(from.layer);
        const toLayer = inferGroundLayer(from.game, goal, from.layer);
        const path = this.path(from.game, from.pos, goal, fromLayer, toLayer, from.layer);
        if (!path?.length) return undefined;
        for (let i = 0; i < path.length; i++) {
            if (v2.distance(from.pos, path[i]) > 2.15) return path[i];
        }
        return undefined;
    }

    hasPath(from: Player, goal: Vec2): boolean {
        const fromLayer = navGroundLayer(from.layer);
        const toLayer = inferGroundLayer(from.game, goal, from.layer);
        const path = this.path(from.game, from.pos, goal, fromLayer, toLayer, from.layer);
        return !!path;
    }

    path(
        game: Game,
        from: Vec2,
        to: Vec2,
        fromLayer: number,
        toLayer: number,
        rawLayer = fromLayer,
    ): Vec2[] | null {
        // Cache cells are 16 units wide; Last Call rooms are split by walls inside
        // a cell, so the room of each end is part of the key there.
        const cacheKey = this.cacheKey(from, to, fromLayer, toLayer) + lastCallRoomKey(game, from, to);
        const cached = this.pathCache.get(cacheKey);
        if (cached !== undefined) return cached;

        if (
            fromLayer === toLayer
            && v2.distance(from, to) < 2.8
            && isWalkClear(game, from, to, fromLayer)
        ) {
            this.remember(cacheKey, []);
            return [];
        }

        const onStair = rawLayer >= 2 || !!stairAtPos(game, from, 0.65);
        const startRadius = onStair ? PathNearbyStairRadius : PathNearbyRadius;
        const starts = this.nearby(from, fromLayer, startRadius, onStair);
        let ends = this.nearby(to, toLayer, PathNearbyRadius);
        // Last Call rooms sit wall to wall: an end node in the next room over must
        // not count as "arrived", or paths stop behind a wall.
        if (lastCallBlock(game)) {
            const reachable = ends.filter((node) => isWalkClear(game, node.pos, to, toLayer));
            if (reachable.length) ends = reachable;
        }
        if (onStair) this.addStairStarts(game, from, fromLayer, starts);
        if (!starts.length || !ends.length) {
            this.remember(cacheKey, null);
            return null;
        }

        const endSet = new Set<number>();
        for (let i = 0; i < ends.length; i++) endSet.add(ends[i].id);

        const gScore = new Map<number, number>();
        const came = new Map<number, number>();
        const heap = new MinHeap();
        const closed = new Set<number>();

        for (let i = 0; i < starts.length; i++) {
            const node = starts[i];
            const walk = isWalkClear(game, from, node.pos, fromLayer)
                || v2.distance(from, node.pos) < 3.2
                || node.kind === "stair"
                || onStair;
            if (!walk && node.kind !== "stair") continue;
            const g = v2.distance(from, node.pos);
            const layerPenalty = node.layer === toLayer ? 0 : (node.kind === "stair" ? 4 : 10);
            gScore.set(node.id, g);
            heap.push(node.id, g + v2.distance(node.pos, to) + layerPenalty);
        }
        if (!gScore.size) {
            const node = starts[0];
            const g = v2.distance(from, node.pos);
            gScore.set(node.id, g);
            heap.push(node.id, g + v2.distance(node.pos, to));
        }

        let found: number | undefined;
        while (true) {
            const id = heap.pop();
            if (id === undefined) break;
            if (closed.has(id)) continue;
            closed.add(id);
            if (endSet.has(id)) {
                found = id;
                break;
            }
            const node = this.nodes[id];
            const g = gScore.get(id) ?? Infinity;
            for (let i = 0; i < node.neighbors.length; i++) {
                const nid = node.neighbors[i];
                if (closed.has(nid)) continue;
                const ng = g + node.costs[i];
                if (ng >= (gScore.get(nid) ?? Infinity)) continue;
                gScore.set(nid, ng);
                came.set(nid, id);
                const next = this.nodes[nid];
                const layerPenalty = next.layer === toLayer ? 0 : (next.kind === "stair" ? 4 : 10);
                heap.push(
                    nid,
                    ng + v2.distance(next.pos, to) + layerPenalty,
                );
            }
        }

        if (found === undefined) {
            this.remember(cacheKey, null);
            return null;
        }

        const ids: number[] = [];
        let cur: number | undefined = found;
        while (cur !== undefined) {
            ids.push(cur);
            cur = came.get(cur);
        }
        ids.reverse();

        const out: Vec2[] = [];
        for (let i = 0; i < ids.length; i++) {
            const pos = this.nodes[ids[i]].pos;
            if (out.length && v2.distance(out[out.length - 1], pos) < 0.8) continue;
            out.push(pos);
        }
        if (v2.distance(out[out.length - 1] ?? to, to) > 2.4) out.push(v2.copy(to));
        this.remember(cacheKey, out);
        return out;
    }

    private sample(game: Game): void {
        this.sampleGrid(game);
        this.sampleObstacles(game);
        this.sampleBuildings(game);
        this.sampleStairs(game);
        this.sampleLastCall(game);
    }

    /**
     * Last Call is one huge building split into rooms: add a finer grid of
     * waypoints, corner waypoints around props, and a linked pair of nodes
     * through every doorway the squad has opened, so AI can path room to room.
     */
    private sampleLastCall(game: Game): void {
        const block = lastCallBlock(game);
        if (!block) return;
        for (const pos of lastCallNavPoints(game)) {
            if (pointClear(game, pos, 0, 1.1)) this.addNode(pos, 0, "interior");
        }
        for (const child of block.childObjects) {
            if (child.__type !== ObjectType.Obstacle) continue;
            const o = child as Obstacle;
            if (o.dead || o.destroyed || !o.collidable || o.isWall || o.isDoor) continue;
            if (o.type.startsWith("lastcall_wall_")) continue;
            const ring = expandAabb(toAabb(o), 2.2);
            for (const corner of [
                ring.min,
                ring.max,
                v2.create(ring.min.x, ring.max.y),
                v2.create(ring.max.x, ring.min.y),
            ]) {
                if (pointClear(game, corner, 0, 1.1)) this.addNode(v2.copy(corner), 0, "interior");
            }
        }
        for (const [a, b] of lastCallNavPortals(game)) {
            const ia = this.addNode(a, 0, "interior");
            const ib = this.addNode(b, 0, "interior");
            this.linkBoth(ia, ib, v2.distance(a, b));
        }
    }

    private sampleGrid(game: Game): void {
        const inset = Math.max(game.map.shoreInset + 4, 8);
        const x0 = inset;
        const y0 = inset;
        const x1 = game.map.width - inset;
        const y1 = game.map.height - inset;
        for (let x = x0; x <= x1; x += GridStep) {
            for (let y = y0; y <= y1; y += GridStep) {
                const pos = v2.create(x, y);
                if (game.map.isOnWater(pos, 0)) continue;
                if (!pointClear(game, pos, 0, 0.7)) continue;
                this.addNode(pos, 0, "open");
            }
        }
    }

    private sampleObstacles(game: Game): void {
        const obstacles = game.map.obstacles;
        for (let i = 0; i < obstacles.length; i++) {
            const o = obstacles[i];
            if (!o.active || o.dead || !o.collidable) continue;
            if (o.parentBuilding) continue;
            if (o.isDoor || o.isWindow) continue;
            const layer = util.toGroundLayer(o.layer);
            const box = toAabb(o);
            const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
            if (span < 2.15) continue;
            const pad = span > 8 ? 2.1 : 1.55;
            const ring = expandAabb(box, pad);
            const count = span > 7 ? 8 : 4;
            const peri = periLen(ring);
            const ids: number[] = [];
            for (let s = 0; s < count; s++) {
                const pos = periPoint((s / count) * peri, ring);
                game.map.clampToMapBounds(pos, 6);
                if (game.map.isOnWater(pos, layer)) continue;
                if (!pointClear(game, pos, layer, 0.5)) continue;
                ids.push(this.addNode(pos, layer, "hull"));
            }
            this.linkLoop(ids);
        }
    }

    private sampleBuildings(game: Game): void {
        const buildings = game.map.buildings;
        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            const hull = buildingHull(building);
            if (!hull) continue;
            const layer = util.toGroundLayer(building.layer);
            const ring = expandAabb(hull, 5.4);
            const peri = periLen(ring);
            const step = 10;
            const count = Math.max(4, Math.round(peri / step));
            const hullIds: number[] = [];
            for (let s = 0; s < count; s++) {
                const pos = periPoint((s / count) * peri, ring);
                game.map.clampToMapBounds(pos, 6);
                if (!pointClear(game, pos, layer, 0.5)) continue;
                hullIds.push(this.addNode(pos, layer, "hull"));
            }
            this.linkLoop(hullIds);

            const center = v2.create(
                (hull.min.x + hull.max.x) * 0.5,
                (hull.min.y + hull.max.y) * 0.5,
            );
            if (pointClear(game, center, layer, 0.5)) {
                this.addNode(center, layer, "interior");
            }
            this.sampleBuildingInterior(game, hull, layer);

            for (let j = 0; j < building.childObjects.length; j++) {
                const child = building.childObjects[j];
                if (child.__type !== ObjectType.Obstacle) continue;
                const o = child as Obstacle;
                if (o.dead) continue;
                if (o.isDoor && o.door && !o.door.locked && (o.door.open || o.door.canUse)) {
                    this.addDoorPair(game, o, building, layer);
                } else if (o.isWindow || o.type.includes("window")) {
                    this.addWindowPeek(game, o, building, layer);
                }
            }
        }
    }

    private addDoorPair(game: Game, door: Obstacle, building: Building, layer: number): void {
        const n = doorNormal(door);
        const center = game.map.mapDef.gameMode.indoorMode
            ? doorFrameCenter(door)
            : door.pos;
        const inward = v2.dot(n, v2.sub(building.pos, center)) >= 0 ? n : v2.neg(n);
        const outside = v2.add(center, v2.mul(v2.neg(inward), 3.1));
        const inside = v2.add(center, v2.mul(inward, 3.3));
        game.map.clampToMapBounds(outside, 6);
        game.map.clampToMapBounds(inside, 6);
        const a = this.addNode(outside, layer, "door");
        const b = this.addNode(inside, layer, "door");
        this.linkBoth(a, b, v2.distance(outside, inside) + 0.4);
    }

    private addWindowPeek(
        game: Game,
        window: Obstacle,
        building: Building,
        layer: number,
    ): void {
        const away = fixtureAway(window, building);
        const peek = v2.add(window.pos, v2.mul(away, 4.4));
        game.map.clampToMapBounds(peek, 6);
        if (pointClear(game, peek, layer, 0.45)) {
            this.addNode(peek, layer, "window");
        }
    }

    private sampleBuildingInterior(game: Game, hull: NavAabb, layer: number): void {
        const w = hull.max.x - hull.min.x;
        const h = hull.max.y - hull.min.y;
        if (w < 11 && h < 11) return;
        const step = w > 20 || h > 20 || layer === 1 ? InteriorGridStep : 12;
        for (let x = hull.min.x + step * 0.55; x <= hull.max.x - step * 0.35; x += step) {
            for (let y = hull.min.y + step * 0.55; y <= hull.max.y - step * 0.35; y += step) {
                const pos = v2.create(x, y);
                game.map.clampToMapBounds(pos, 6);
                if (!pointClear(game, pos, layer, 0.42)) continue;
                this.addNode(pos, layer, "interior");
            }
        }
    }

    private sampleStairs(game: Game): void {
        const structures = game.map.structures;
        for (let i = 0; i < structures.length; i++) {
            const structure = structures[i];
            const stairs = structure.stairs;
            const upLayer = util.toGroundLayer(structure.layer);
            const downLayer = upLayer ^ 1;
            for (let j = 0; j < stairs.length; j++) {
                const stair = stairs[j];
                if (stair.lootOnly) continue;
                const up = aabbCenter(stair.upAabb);
                const down = aabbCenter(stair.downAabb);
                game.map.clampToMapBounds(up, 6);
                game.map.clampToMapBounds(down, 6);
                const a = this.addNode(up, upLayer, "stair");
                const b = this.addNode(down, downLayer, "stair");
                this.linkBoth(a, b, v2.distance(up, down) + 2.2);

                const upApproach = v2.add(up, v2.mul(v2.neg(stair.downDir), 2.4));
                const downApproach = v2.add(down, v2.mul(stair.downDir, 2.4));
                game.map.clampToMapBounds(upApproach, 6);
                game.map.clampToMapBounds(downApproach, 6);
                if (pointClear(game, upApproach, upLayer, 0.42)) {
                    const uid = this.addNode(upApproach, upLayer, "stair");
                    this.linkBoth(a, uid, v2.distance(up, upApproach) + 0.5);
                }
                if (pointClear(game, downApproach, downLayer, 0.42)) {
                    const did = this.addNode(downApproach, downLayer, "stair");
                    this.linkBoth(b, did, v2.distance(down, downApproach) + 0.5);
                }
            }
        }
    }

    /** Stair landings often sit just outside the default link radius — wire them in explicitly. */
    private linkStairLandings(game: Game): void {
        const stairIds: number[] = [];
        for (let i = 0; i < this.nodes.length; i++) {
            if (this.nodes[i].kind === "stair") stairIds.push(i);
        }
        for (let s = 0; s < stairIds.length; s++) {
            const node = this.nodes[stairIds[s]];
            const extra: Array<{ id: number; dist: number }> = [];
            const reach = Math.ceil(StairLinkRadius / HashCell);
            const cx = Math.floor(node.pos.x / HashCell);
            const cy = Math.floor(node.pos.y / HashCell);
            for (let dx = -reach; dx <= reach; dx++) {
                for (let dy = -reach; dy <= reach; dy++) {
                    const ids = this.cells.get(hashKey(cx + dx, cy + dy));
                    if (!ids) continue;
                    for (let k = 0; k < ids.length; k++) {
                        const oid = ids[k];
                        if (oid === node.id) continue;
                        const other = this.nodes[oid];
                        if (other.layer !== node.layer) continue;
                        const dist = v2.distance(node.pos, other.pos);
                        if (dist < 0.8 || dist > StairLinkRadius) continue;
                        extra.push({ id: oid, dist });
                    }
                }
            }
            extra.sort((a, b) => a.dist - b.dist);
            let linked = 0;
            for (let e = 0; e < extra.length && linked < 16; e++) {
                const other = this.nodes[extra[e].id];
                if (this.alreadyLinked(node.id, other.id)) continue;
                if (!isWalkClear(game, node.pos, other.pos, node.layer, 0.55)) continue;
                this.linkBoth(node.id, other.id, extra[e].dist);
                linked++;
            }
        }
    }

    /** Door approaches on large buildings are often outside the default hull link radius. */
    private linkDoorsToHull(game: Game): void {
        const doorIds: number[] = [];
        const hullIds: number[] = [];
        for (let i = 0; i < this.nodes.length; i++) {
            const kind = this.nodes[i].kind;
            if (kind === "door") doorIds.push(i);
            else if (kind === "hull") hullIds.push(i);
        }
        for (let d = 0; d < doorIds.length; d++) {
            const door = this.nodes[doorIds[d]];
            let best: number | undefined;
            let bestDist = DoorHullLinkRadius;
            for (let h = 0; h < hullIds.length; h++) {
                const hull = this.nodes[hullIds[h]];
                if (hull.layer !== door.layer) continue;
                const dist = v2.distance(door.pos, hull.pos);
                if (dist >= 0.8 && dist < bestDist) {
                    bestDist = dist;
                    best = hullIds[h];
                }
            }
            if (best !== undefined && !this.alreadyLinked(door.id, best)) {
                if (isWalkClear(game, door.pos, this.nodes[best].pos, door.layer, 0.55)) {
                    this.linkBoth(door.id, best, bestDist);
                }
            }
        }
    }

    private addStairStarts(
        game: Game,
        from: Vec2,
        fromLayer: number,
        starts: NavNode[],
    ): void {
        const hit = stairAtPos(game, from, 1.1);
        if (!hit) return;
        const stair = hit.stair;
        const up = aabbCenter(stair.upAabb);
        const down = aabbCenter(stair.downAabb);
        const otherLayer = fromLayer ^ 1;
        const have = new Set(starts.map((n) => n.id));
        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            if (node.kind !== "stair") continue;
            if (node.layer !== fromLayer && node.layer !== otherLayer) continue;
            const nearUp = v2.distance(node.pos, up) < 5.5;
            const nearDown = v2.distance(node.pos, down) < 5.5;
            if (!nearUp && !nearDown) continue;
            if (!have.has(node.id)) {
                starts.push(node);
                have.add(node.id);
            }
        }
        starts.sort((a, b) => v2.distance(from, a.pos) - v2.distance(from, b.pos));
        if (starts.length > 10) starts.length = 10;
    }

    private link(game: Game): void {
        const byCell = new Map<string, number[]>();
        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            const gx = Math.round(node.pos.x / GridStep);
            const gy = Math.round(node.pos.y / GridStep);
            const key = `${gx},${gy},${node.layer}`;
            let bucket = byCell.get(key);
            if (!bucket) {
                bucket = [];
                byCell.set(key, bucket);
            }
            bucket.push(node.id);
        }

        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            const gx = Math.round(node.pos.x / GridStep);
            const gy = Math.round(node.pos.y / GridStep);

            if (node.kind === "open") {
                const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
                for (let d = 0; d < dirs.length; d++) {
                    const key = `${gx + dirs[d][0]},${gy + dirs[d][1]},${node.layer}`;
                    const bucket = byCell.get(key);
                    if (!bucket) continue;
                    for (let b = 0; b < bucket.length; b++) {
                        const other = this.nodes[bucket[b]];
                        if (other.kind !== "open") continue;
                        if (!isWalkClear(game, node.pos, other.pos, node.layer, 0.6)) continue;
                        this.linkBoth(node.id, other.id, v2.distance(node.pos, other.pos));
                    }
                }
            }

            const extra: Array<{ id: number; dist: number }> = [];
            const reach = Math.ceil(LinkRadius / HashCell);
            const cx = Math.floor(node.pos.x / HashCell);
            const cy = Math.floor(node.pos.y / HashCell);
            for (let dx = -reach; dx <= reach; dx++) {
                for (let dy = -reach; dy <= reach; dy++) {
                    const ids = this.cells.get(hashKey(cx + dx, cy + dy));
                    if (!ids) continue;
                    for (let k = 0; k < ids.length; k++) {
                        const oid = ids[k];
                        if (oid === node.id) continue;
                        const other = this.nodes[oid];
                        if (other.layer !== node.layer) continue;
                        const dist = v2.distance(node.pos, other.pos);
                        if (dist < 0.8 || dist > LinkRadius) continue;
                        extra.push({ id: oid, dist });
                    }
                }
            }
            extra.sort((a, b) => a.dist - b.dist);
            let linked = 0;
            for (let e = 0; e < extra.length && linked < MaxExtraLinks; e++) {
                const other = this.nodes[extra[e].id];
                if (this.alreadyLinked(node.id, other.id)) continue;
                const doorHop = node.kind === "door" && other.kind === "door";
                if (!doorHop && !isWalkClear(game, node.pos, other.pos, node.layer, 0.6)) {
                    continue;
                }
                this.linkBoth(node.id, other.id, extra[e].dist);
                linked++;
            }
        }
    }

    private addNode(pos: Vec2, layer: number, kind: NavKind): number {
        const id = this.nodes.length;
        this.nodes.push({
            id,
            pos: v2.copy(pos),
            layer,
            kind,
            neighbors: [],
            costs: [],
        });
        const cx = Math.floor(pos.x / HashCell);
        const cy = Math.floor(pos.y / HashCell);
        const key = hashKey(cx, cy);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(id);
        else this.cells.set(key, [id]);
        return id;
    }

    private linkLoop(ids: number[]): void {
        if (ids.length < 2) return;
        for (let i = 0; i < ids.length; i++) {
            const a = ids[i];
            const b = ids[(i + 1) % ids.length];
            this.linkBoth(a, b, v2.distance(this.nodes[a].pos, this.nodes[b].pos));
        }
    }

    /** Remove links whose straight line can't fit a body of radius `rad` (walls, props). */
    pruneTightLinks(game: Game, rad: number): void {
        for (const node of this.nodes) {
            for (let i = node.neighbors.length - 1; i >= 0; i--) {
                const other = this.nodes[node.neighbors[i]];
                if (other.id < node.id) continue; // each edge once
                if (other.layer !== node.layer || lastCallWalkable(game, node.pos, other.pos, rad)) continue;
                node.neighbors.splice(i, 1);
                node.costs.splice(i, 1);
                const back = other.neighbors.indexOf(node.id);
                if (back >= 0) {
                    other.neighbors.splice(back, 1);
                    other.costs.splice(back, 1);
                }
            }
        }
        this.pathCache.clear();
    }

    private alreadyLinked(a: number, b: number): boolean {
        const n = this.nodes[a].neighbors;
        for (let i = 0; i < n.length; i++) {
            if (n[i] === b) return true;
        }
        return false;
    }

    private linkBoth(a: number, b: number, cost: number): void {
        if (a === b) return;
        if (!this.alreadyLinked(a, b)) {
            this.nodes[a].neighbors.push(b);
            this.nodes[a].costs.push(cost);
        }
        if (!this.alreadyLinked(b, a)) {
            this.nodes[b].neighbors.push(a);
            this.nodes[b].costs.push(cost);
        }
    }

    private nearby(pos: Vec2, layer: number, maxDist: number, includeStairs = false): NavNode[] {
        const reach = Math.ceil(maxDist / HashCell);
        const cx = Math.floor(pos.x / HashCell);
        const cy = Math.floor(pos.y / HashCell);
        const out: NavNode[] = [];
        for (let dx = -reach; dx <= reach; dx++) {
            for (let dy = -reach; dy <= reach; dy++) {
                const ids = this.cells.get(hashKey(cx + dx, cy + dy));
                if (!ids) continue;
                for (let i = 0; i < ids.length; i++) {
                    const node = this.nodes[ids[i]];
                    if (node.layer !== layer && !(includeStairs && node.kind === "stair")) continue;
                    if (v2.distance(pos, node.pos) <= maxDist) out.push(node);
                }
            }
        }
        if (out.length) {
            out.sort((a, b) => v2.distance(pos, a.pos) - v2.distance(pos, b.pos));
            if (out.length > 10) out.length = 10;
            return out;
        }
        let best: NavNode | undefined;
        let bestDist = Infinity;
        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            if (node.layer !== layer && !(includeStairs && node.kind === "stair")) continue;
            const d = v2.distance(pos, node.pos);
            if (d < bestDist) {
                bestDist = d;
                best = node;
            }
        }
        return best ? [best] : [];
    }

    private cacheKey(from: Vec2, to: Vec2, fl: number, tl: number): string {
        return `${from.x >> 4},${from.y >> 4},${to.x >> 4},${to.y >> 4},${fl},${tl}`;
    }

    private remember(key: string, path: Vec2[] | null): void {
        if (this.pathCache.size > 480) this.pathCache.clear();
        this.pathCache.set(key, path);
    }
}
