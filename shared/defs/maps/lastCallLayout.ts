import { v2, type Vec2 } from "../../utils/v2.ts";

/**
 * Last Call (Zombie Survival map `specops_complex`): one walled motel +
 * nightclub block, nine zones opened with buy gates, a power switch, a moving
 * mystery box and an upgrade bench. The rules live in SpecOpsManager's zombie
 * systems; this file is only the layout.
 *
 * The tables below are authored in "base" plan units: x to the right, y DOWN,
 * origin at the top-left corner of the block. Everything exported is scaled by
 * LastCallScale into game units (rooms grow; furniture keeps its real size and
 * stays against its wall; doorways and windows keep their width). The building
 * def and the floor art generator both read the exported, scaled data, so walls
 * and art can't drift apart.
 */

export const LastCallMapName = "specops_complex";
export const LastCallBuildingType = "zombie_branching_complex_01";

/** How much bigger the rooms are than the base plan (1 = original 145 × 115 block). */
export const LastCallScale = 1.5;
const S = LastCallScale;

/** Size of the walled block, in game units. */
export const LastCallWidth = 145 * S;
export const LastCallHeight = 115 * S;
/** Wall thickness. */
export const LastCallWallThickness = 1;
/** Extra floor art drawn around the block (street + sidewalk). */
export const LastCallApron = 10;

/** Plan point → building-local game coordinates (centered, y up). */
export function lastCallToLocal(x: number, y: number): Vec2 {
    return v2.create(x - LastCallWidth / 2, LastCallHeight / 2 - y);
}

/** Building-local game coordinates → plan point. */
export function lastCallFromLocal(p: Vec2): Vec2 {
    return v2.create(p.x + LastCallWidth / 2, LastCallHeight / 2 - p.y);
}

export type LastCallZoneId =
    | "lobby"
    | "storage"
    | "courtyard"
    | "diner"
    | "alley"
    | "wing"
    | "club"
    | "office"
    | "garage";

export interface LastCallRect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface LastCallZone {
    id: LastCallZoneId;
    name: string;
    /** Floor rect of the zone (inside face of walls is ~0.5 in from this). */
    rect: LastCallRect;
}

/** Base-plan zones (scaled copies are exported as LastCallZones). */
export const LastCallBaseZones: LastCallZone[] = [
    { id: "lobby", name: "Motel Lobby", rect: { x0: 55, y0: 90, x1: 85, y1: 115 } },
    { id: "storage", name: "Storage", rect: { x0: 85, y0: 90, x1: 100, y1: 115 } },
    { id: "courtyard", name: "Courtyard", rect: { x0: 40, y0: 50, x1: 100, y1: 90 } },
    { id: "diner", name: "Neon Diner", rect: { x0: 10, y0: 90, x1: 55, y1: 115 } },
    { id: "alley", name: "Alley", rect: { x0: 100, y0: 50, x1: 115, y1: 115 } },
    { id: "wing", name: "Motel Wing", rect: { x0: 0, y0: 30, x1: 40, y1: 90 } },
    { id: "club", name: "Club Paradiso", rect: { x0: 40, y0: 0, x1: 110, y1: 50 } },
    { id: "office", name: "Manager's Office", rect: { x0: 110, y0: 0, x1: 145, y1: 25 } },
    { id: "garage", name: "Parking Garage", rect: { x0: 115, y0: 25, x1: 145, y1: 115 } },
];


/** Motel rooms 101–104 inside the wing (walls only, same zone). */
const BaseMotelRooms: LastCallRect[] = [
    { x0: 0, y0: 30, x1: 22.5, y1: 45 },
    { x0: 0, y0: 45, x1: 22.5, y1: 60 },
    { x0: 0, y0: 60, x1: 22.5, y1: 75 },
    { x0: 0, y0: 75, x1: 22.5, y1: 90 },
];

/** A gap in a wall line. `axis: "h"` = horizontal wall at y = `at`, spanning x a0..a1. */
export interface LastCallOpening {
    axis: "h" | "v";
    at: number;
    a0: number;
    a1: number;
}

export type LastCallDoorKind = "shutter" | "open" | "power" | "room";

export interface LastCallDoor {
    id: string;
    kind: LastCallDoorKind;
    /** Base price in Spec Ops cash. Only for shutters. */
    cost: number;
    zones: [LastCallZoneId, LastCallZoneId];
    opening: LastCallOpening;
}

/** Shutter widths: wide enough for two players side by side. */
const SW = 6;
/** Motel room doorway width (fits house_door_01). */
const RW = 4;

function hOpen(y: number, cx: number, w: number): LastCallOpening {
    return { axis: "h", at: y, a0: cx - w / 2, a1: cx + w / 2 };
}
function vOpen(x: number, cy: number, w: number): LastCallOpening {
    return { axis: "v", at: x, a0: cy - w / 2, a1: cy + w / 2 };
}

const BaseDoors: LastCallDoor[] = [
    // Lobby exits
    { id: "lobby_courtyard", kind: "shutter", cost: 750, zones: ["lobby", "courtyard"], opening: hOpen(90, 70, SW) },
    { id: "lobby_diner", kind: "shutter", cost: 1000, zones: ["lobby", "diner"], opening: vOpen(55, 102, SW) },
    { id: "lobby_storage", kind: "shutter", cost: 750, zones: ["lobby", "storage"], opening: vOpen(85, 102, SW) },
    // Storage → Alley is always open: the cheap shortcut that adds a second front.
    { id: "storage_alley", kind: "open", cost: 0, zones: ["storage", "alley"], opening: vOpen(100, 102, SW) },
    // Courtyard hub
    { id: "courtyard_wing", kind: "shutter", cost: 1250, zones: ["courtyard", "wing"], opening: vOpen(40, 69, SW) },
    { id: "courtyard_club", kind: "shutter", cost: 1500, zones: ["courtyard", "club"], opening: hOpen(50, 70, SW) },
    { id: "courtyard_alley", kind: "shutter", cost: 1000, zones: ["courtyard", "alley"], opening: vOpen(100, 69, SW) },
    { id: "wing_diner", kind: "shutter", cost: 1250, zones: ["wing", "diner"], opening: hOpen(90, 31, SW) },
    // Back half
    { id: "club_office", kind: "shutter", cost: 1000, zones: ["club", "office"], opening: vOpen(110, 12, SW) },
    { id: "alley_garage", kind: "shutter", cost: 1250, zones: ["alley", "garage"], opening: vOpen(115, 88, SW) },
    // Freight gate: opens when the power is switched on.
    { id: "office_garage", kind: "power", cost: 0, zones: ["office", "garage"], opening: hOpen(25, 130, SW) },
    // Motel room doorways (open, same zone: no doors to snag zombies on)
    { id: "room_101", kind: "room", cost: 0, zones: ["wing", "wing"], opening: vOpen(22.5, 37.5, RW) },
    { id: "room_102", kind: "room", cost: 0, zones: ["wing", "wing"], opening: vOpen(22.5, 52.5, RW) },
    { id: "room_103", kind: "room", cost: 0, zones: ["wing", "wing"], opening: vOpen(22.5, 67.5, RW) },
    { id: "room_104", kind: "room", cost: 0, zones: ["wing", "wing"], opening: vOpen(22.5, 82.5, RW) },
];

/**
 * Zombie entry points. Each one is a boarded window in an outside wall; enemies
 * climb in at `pos` (just inside the window) once the zone is open.
 */
export interface LastCallEntry {
    zone: LastCallZoneId;
    /** Spawn point, just inside the wall. */
    pos: Vec2;
    /** Window gap drawn on the wall (art only, the wall stays solid). */
    window?: LastCallOpening;
    /** Manholes spawn in the middle of a room instead of at a wall. */
    manhole?: boolean;
}

const WIN = 5;
const BaseEntries: LastCallEntry[] = [
    { zone: "lobby", pos: v2.create(62.5, 112), window: hOpen(115, 62.5, WIN) },
    { zone: "lobby", pos: v2.create(77.5, 112), window: hOpen(115, 77.5, WIN) },
    { zone: "diner", pos: v2.create(19.5, 112), window: hOpen(115, 19.5, WIN) },
    { zone: "diner", pos: v2.create(42.5, 112), window: hOpen(115, 42.5, WIN) },
    { zone: "diner", pos: v2.create(13, 104), window: vOpen(10, 104, WIN) },
    { zone: "wing", pos: v2.create(3, 37.5), window: vOpen(0, 37.5, WIN) },
    { zone: "wing", pos: v2.create(3, 67.5), window: vOpen(0, 67.5, WIN) },
    { zone: "club", pos: v2.create(52.5, 3), window: hOpen(0, 52.5, WIN) },
    { zone: "club", pos: v2.create(97.5, 3), window: hOpen(0, 97.5, WIN) },
    { zone: "club", pos: v2.create(43, 5), window: vOpen(40, 5, WIN) },
    { zone: "office", pos: v2.create(117.5, 3), window: hOpen(0, 117.5, WIN) },
    { zone: "office", pos: v2.create(142, 10.5), window: vOpen(145, 10.5, WIN) },
    { zone: "garage", pos: v2.create(142, 44.5), window: vOpen(145, 44.5, WIN) },
    { zone: "garage", pos: v2.create(142, 77.5), window: vOpen(145, 77.5, WIN) },
    { zone: "garage", pos: v2.create(142, 102.5), window: vOpen(145, 102.5, WIN) },
    { zone: "alley", pos: v2.create(107.5, 112), window: hOpen(115, 107.5, 9) },
    { zone: "courtyard", pos: v2.create(46, 56), manhole: true },
    { zone: "courtyard", pos: v2.create(95, 85), manhole: true },
    { zone: "garage", pos: v2.create(121, 69), manhole: true },
];

/** Where the squad spawns. */
const BasePlayerSpawns: Vec2[] = [
    v2.create(64, 106),
    v2.create(68, 106),
    v2.create(72, 106),
    v2.create(76, 106),
];

export type LastCallStationType = "weapon" | "gear" | "armor" | "support" | "perk";

const BaseStations: Array<{ type: LastCallStationType; pos: Vec2; zone: LastCallZoneId }> = [
    { type: "weapon", pos: v2.create(81, 110), zone: "lobby" },
    { type: "gear", pos: v2.create(92.5, 110.5), zone: "storage" },
    { type: "weapon", pos: v2.create(46, 95), zone: "diner" },
    { type: "armor", pos: v2.create(50, 110), zone: "diner" },
    { type: "perk", pos: v2.create(4, 57), zone: "wing" },
    { type: "perk", pos: v2.create(50, 21), zone: "club" },
    { type: "weapon", pos: v2.create(104, 6), zone: "club" },
    { type: "weapon", pos: v2.create(110, 57), zone: "alley" },
    { type: "support", pos: v2.create(139, 63), zone: "garage" },
];

/**
 * Mystery box spots (zombie_mystery_box is 8.8 × 3.7). The box starts on the
 * first one; every spot, including the first, is a place it can move back to.
 */
const BaseBoxSpots: Array<{ pos: Vec2; zone: LastCallZoneId }> = [
    { pos: v2.create(82, 55), zone: "courtyard" },
    { pos: v2.create(100, 44.5), zone: "club" },
    { pos: v2.create(43, 103.5), zone: "diner" },
    { pos: v2.create(121, 47), zone: "garage" },
];

const BasePowerSwitchPos = v2.create(139, 20.5);
const BaseBenchPos = v2.create(129, 110);

/**
 * Collidable props that aren't walls. `type` is a map object type; plan pos is
 * the object's center. Existing survev furniture keeps the familiar look; the
 * lastcall_* blocks are invisible collision for things drawn in the floor art.
 * (Spec Ops strips loot furniture like crates, desks and lockers from buildings,
 * so cover that must stay uses lastcall_* blocks instead.)
 */
export interface LastCallProp {
    type: string;
    pos: Vec2;
    ori?: number;
}

/** Base-plan props (scaled copies are exported as LastCallProps). */
export const LastCallBaseProps: LastCallProp[] = [
    // Lobby: reception desk + waiting chairs
    { type: "lastcall_reception", pos: v2.create(63, 96) },
    { type: "chair_01", pos: v2.create(58, 108), ori: 1 },
    { type: "chair_01", pos: v2.create(58, 111.5), ori: 1 },
    { type: "lastcall_planter", pos: v2.create(83, 93) },
    // Storage: pallets of stock
    { type: "lastcall_pallet", pos: v2.create(88.5, 94) },
    { type: "lastcall_pallet", pos: v2.create(96.5, 94) },
    { type: "barrel_01", pos: v2.create(97.5, 111.5) },
    // Courtyard: drained pool (low rail, bullets pass), palms in planters, loungers
    { type: "lastcall_pool", pos: v2.create(70, 68.5) },
    { type: "lastcall_planter", pos: v2.create(46, 84) },
    { type: "lastcall_planter", pos: v2.create(94, 55) },
    { type: "lastcall_planter", pos: v2.create(46, 62) },
    { type: "couch_01", pos: v2.create(57, 82), ori: 0 },
    { type: "couch_01", pos: v2.create(83, 82), ori: 0 },
    // Diner: counter, booths, kitchen
    { type: "lastcall_counter_diner", pos: v2.create(19, 99) },
    { type: "table_01", pos: v2.create(19, 108.5) },
    { type: "table_01", pos: v2.create(31, 108.5) },
    { type: "stove_01", pos: v2.create(15, 93.5) },
    { type: "refrigerator_01", pos: v2.create(24, 93) },
    // Motel wing: beds, ice machines
    { type: "bed_sm_01", pos: v2.create(12, 39), ori: 0 },
    { type: "bed_sm_01", pos: v2.create(11, 51.5), ori: 0 },
    { type: "bed_sm_01", pos: v2.create(12, 69), ori: 0 },
    { type: "bed_sm_01", pos: v2.create(12, 84), ori: 0 },
    { type: "lastcall_ice_machine", pos: v2.create(37, 33.5) },
    { type: "lastcall_ice_machine", pos: v2.create(37, 86.5) },
    // Club: bar, DJ booth, VIP couches, tables
    { type: "lastcall_bar_club", pos: v2.create(44.5, 24) },
    { type: "lastcall_dj_booth", pos: v2.create(74, 5) },
    { type: "couch_01", pos: v2.create(102, 32), ori: 0 },
    { type: "couch_01", pos: v2.create(106.5, 39), ori: 1 },
    { type: "table_02", pos: v2.create(58, 42) },
    { type: "table_02", pos: v2.create(90, 42) },
    // Office: the manager's table
    { type: "lastcall_office_table", pos: v2.create(128, 8.5) },
    { type: "chair_01", pos: v2.create(128, 12.5), ori: 2 },
    // Alley: dumpsters, barrel
    { type: "lastcall_dumpster", pos: v2.create(112, 64), ori: 1 },
    { type: "lastcall_dumpster", pos: v2.create(111, 96), ori: 1 },
    { type: "barrel_01", pos: v2.create(103, 74) },
    // Garage: pillars + parked cars (second loop)
    { type: "lastcall_pillar", pos: v2.create(128, 40) },
    { type: "lastcall_pillar", pos: v2.create(128, 60) },
    { type: "lastcall_pillar", pos: v2.create(128, 80) },
    { type: "lastcall_pillar", pos: v2.create(128, 100) },
    { type: "zombie_garage_car", pos: v2.create(139.5, 36) },
    { type: "zombie_garage_car", pos: v2.create(139.5, 90) },
    { type: "zombie_garage_car", pos: v2.create(120.5, 32), ori: 2 },
];

// ---------------------------------------------------------------------------
// Scaling from the base plan into game units
// ---------------------------------------------------------------------------

/**
 * Built-in fixtures that are part of the room (pool, bar, DJ booth, counters,
 * desks): they scale with the room, size included. Everything else is
 * furniture and keeps its real size.
 */
export const LastCallScaledPropTypes = new Set([
    "lastcall_pool",
    "lastcall_bar_club",
    "lastcall_dj_booth",
    "lastcall_counter_diner",
    "lastcall_reception",
    "lastcall_office_table",
]);

/** Anything this close to a wall in the base plan keeps the same gap after scaling. */
const HugDist = 4.5;

function scaleRect(r: LastCallRect): LastCallRect {
    return { x0: r.x0 * S, y0: r.y0 * S, x1: r.x1 * S, y1: r.y1 * S };
}

/** Base-plan point → game-unit point with every coordinate scaled. */
export function lastCallScalePoint(p: Vec2): Vec2 {
    return v2.create(p.x * S, p.y * S);
}

/**
 * Base-plan point → game-unit point for furniture: positions scale with the
 * room, but anything within HugDist of a wall keeps its gap to that wall.
 */
export function lastCallPlace(p: Vec2): Vec2 {
    const contains = (r: LastCallRect) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
    const area = (r: LastCallRect) => (r.x1 - r.x0) * (r.y1 - r.y0);
    const rect = [...BaseMotelRooms, ...LastCallBaseZones.map((z) => z.rect)]
        .filter(contains)
        .sort((a, b) => area(a) - area(b))[0];
    if (!rect) return lastCallScalePoint(p);
    const axis = (v: number, lo: number, hi: number) => {
        if (v - lo <= HugDist) return lo * S + (v - lo);
        if (hi - v <= HugDist) return hi * S - (hi - v);
        return v * S;
    };
    return v2.create(axis(p.x, rect.x0, rect.x1), axis(p.y, rect.y0, rect.y1));
}

function scaleOpening(o: LastCallOpening): LastCallOpening {
    const half = (o.a1 - o.a0) / 2;
    const mid = ((o.a0 + o.a1) / 2) * S;
    return { axis: o.axis, at: o.at * S, a0: mid - half, a1: mid + half };
}

export const LastCallZones: LastCallZone[] = LastCallBaseZones.map((z) => ({ ...z, rect: scaleRect(z.rect) }));
export const LastCallMotelRooms: LastCallRect[] = BaseMotelRooms.map(scaleRect);
export const LastCallDoors: LastCallDoor[] = BaseDoors.map((d) => ({ ...d, opening: scaleOpening(d.opening) }));
export const LastCallEntries: LastCallEntry[] = BaseEntries.map((e) => ({
    ...e,
    pos: e.manhole ? lastCallScalePoint(e.pos) : lastCallPlace(e.pos),
    window: e.window && scaleOpening(e.window),
}));
export const LastCallPlayerSpawns: Vec2[] = BasePlayerSpawns.map(lastCallPlace);
export const LastCallStations = BaseStations.map((s) => ({ ...s, pos: lastCallPlace(s.pos) }));
export const LastCallBoxSpots = BaseBoxSpots.map((b) => ({ ...b, pos: lastCallPlace(b.pos) }));
export const LastCallPowerSwitchPos = lastCallPlace(BasePowerSwitchPos);
export const LastCallBenchPos = lastCallPlace(BaseBenchPos);
export const LastCallProps: LastCallProp[] = LastCallBaseProps.map((p) => ({
    ...p,
    pos: LastCallScaledPropTypes.has(p.type) ? lastCallScalePoint(p.pos) : lastCallPlace(p.pos),
}));

/** Axis-aligned wall segment in plan units, centered on the line. */
export interface LastCallWall {
    axis: "h" | "v";
    at: number;
    a0: number;
    a1: number;
}

function addInterval(map: Map<string, Array<[number, number]>>, key: string, a0: number, a1: number) {
    const list = map.get(key) ?? [];
    list.push([Math.min(a0, a1), Math.max(a0, a1)]);
    map.set(key, list);
}

function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
    const sorted = [...list].sort((a, b) => a[0] - b[0]);
    const out: Array<[number, number]> = [];
    for (const [a0, a1] of sorted) {
        const last = out[out.length - 1];
        if (last && a0 <= last[1] + 1e-6) last[1] = Math.max(last[1], a1);
        else out.push([a0, a1]);
    }
    return out;
}

function subtractIntervals(
    list: Array<[number, number]>,
    holes: Array<[number, number]>,
): Array<[number, number]> {
    let cur = list;
    for (const [h0, h1] of holes) {
        const next: Array<[number, number]> = [];
        for (const [a0, a1] of cur) {
            if (h1 <= a0 || h0 >= a1) {
                next.push([a0, a1]);
                continue;
            }
            if (h0 > a0) next.push([a0, h0]);
            if (h1 < a1) next.push([h1, a1]);
        }
        cur = next;
    }
    return cur.filter(([a0, a1]) => a1 - a0 > 0.05);
}

let wallCache: LastCallWall[] | undefined;

/**
 * Every wall of the block: room edges merged into lines, door openings cut out.
 * Wall ends that meet a corner are pushed out by half a wall so corners close;
 * ends at a doorway stay flush so the doorway keeps its full width.
 */
export function lastCallWalls(): LastCallWall[] {
    if (wallCache) return wallCache;
    const lines = new Map<string, Array<[number, number]>>();
    const rects = [...LastCallZones.map((z) => z.rect), ...LastCallMotelRooms];
    for (const r of rects) {
        addInterval(lines, `h:${r.y0}`, r.x0, r.x1);
        addInterval(lines, `h:${r.y1}`, r.x0, r.x1);
        addInterval(lines, `v:${r.x0}`, r.y0, r.y1);
        addInterval(lines, `v:${r.x1}`, r.y0, r.y1);
    }
    const holes = new Map<string, Array<[number, number]>>();
    for (const d of LastCallDoors) {
        addInterval(holes, `${d.opening.axis}:${d.opening.at}`, d.opening.a0, d.opening.a1);
    }

    const half = LastCallWallThickness / 2;
    const walls: LastCallWall[] = [];
    for (const [key, list] of lines) {
        const [axis, atStr] = key.split(":") as ["h" | "v", string];
        const at = Number(atStr);
        const lineHoles = holes.get(key) ?? [];
        const segs = subtractIntervals(mergeIntervals(list), lineHoles);
        for (const [a0, a1] of segs) {
            const atHole0 = lineHoles.some(([, h1]) => Math.abs(h1 - a0) < 1e-6);
            const atHole1 = lineHoles.some(([h0]) => Math.abs(h0 - a1) < 1e-6);
            walls.push({
                axis,
                at,
                a0: atHole0 ? a0 : a0 - half,
                a1: atHole1 ? a1 : a1 + half,
            });
        }
    }
    walls.sort((a, b) => (a.axis === b.axis ? a.at - b.at || a.a0 - b.a0 : a.axis < b.axis ? -1 : 1));
    wallCache = walls;
    return walls;
}

/** Map object type for a wall of the given length (lengths are rounded to 0.25; name is in hundredths). */
export function lastCallWallType(len: number): string {
    return `lastcall_wall_${Math.round(len * 4) * 25}`;
}

/** All distinct wall lengths, for generating wall defs. */
export function lastCallWallLengths(): number[] {
    const set = new Set<number>();
    for (const w of lastCallWalls()) set.add(Math.round((w.a1 - w.a0) * 4) / 4);
    return [...set].sort((a, b) => a - b);
}

export function lastCallZoneAt(p: Vec2, inset = 0): LastCallZoneId | undefined {
    for (const z of LastCallZones) {
        const r = z.rect;
        if (p.x >= r.x0 + inset && p.x <= r.x1 - inset && p.y >= r.y0 + inset && p.y <= r.y1 - inset) {
            return z.id;
        }
    }
    return undefined;
}

/** Buy gate type for a shutter of the given price (see ZombieBuyGateCosts). */
export function lastCallShutterType(cost: number): string {
    return `zombie_buy_gate_${cost}`;
}
