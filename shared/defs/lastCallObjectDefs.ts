import type { AABB } from "../utils/coldet.ts";
import { collider } from "../utils/collider.ts";
import { v2, type Vec2 } from "../utils/v2.ts";
import type { BuildingDef, MapObjectDef, ObstacleDef } from "./mapObjectsTyping.ts";
import {
    LastCallBenchPos,
    LastCallBoxSpots,
    LastCallBuildingType,
    LastCallDoors,
    LastCallEntries,
    LastCallPerkMachines,
    LastCallPowerSwitchPos,
    LastCallProps,
    LastCallScale,
    lastCallShutterType,
    lastCallToLocal,
    lastCallWallLengths,
    lastCallWalls,
    LastCallWallThickness,
    lastCallWallType,
    type LastCallZoneId,
    LastCallZones,
} from "./maps/lastCallLayout.ts";

/**
 * Map objects for Last Call (see maps/lastCallLayout.ts).
 * Walls carry no sprite: the whole block is painted in one floor image
 * (map-lastcall-floor.svg) so the art lines up with the collision exactly.
 * Gates, the power gate, box, bench and switch use the zombie_* types the
 * Zombie Survival systems in SpecOpsManager already look for.
 */

const BrickSound = {
    bullet: "wall_brick_bullet",
    punch: "wall_brick_bullet",
    explode: "wall_break_01",
    enter: "none",
};

const MetalSound = {
    bullet: "wall_bullet",
    punch: "metal_punch",
    explode: "barrel_break_01",
    enter: "none",
};

export function lastCallSolidBlock(opts: {
    extents: Vec2;
    height?: number;
    sprite?: string;
    spriteScale?: number;
    metal?: boolean;
    isWall?: boolean;
    zIdx?: number;
}): ObstacleDef {
    return {
        type: "obstacle",
        scale: { createMin: 1, createMax: 1, destroy: 1 },
        collision: collider.createAabbExtents(v2.create(0, 0), opts.extents),
        height: opts.height ?? 10,
        isWall: opts.isWall,
        collidable: true,
        destructible: false,
        health: 9999,
        hitParticle: opts.metal ? "barrelChip" : "brickChip",
        explodeParticle: opts.metal ? "barrelBreak" : "brickChip",
        reflectBullets: !!opts.metal,
        loot: [],
        map: { display: false },
        terrain: { grass: true, beach: true },
        img: opts.sprite
            ? {
                sprite: opts.sprite,
                scale: opts.spriteScale ?? 0.5,
                alpha: 1,
                tint: 0xffffff,
                zIdx: opts.zIdx ?? 10,
            }
            : {},
        sound: opts.metal ? MetalSound : BrickSound,
    };
}

/** Rolling shutter you pay to open (zombie_buy_gate_*); 6 × 1.2, horizontal at ori 0. */
export function lastCallShutterDef(): ObstacleDef {
    return {
        ...lastCallSolidBlock({
            extents: v2.create(3, 0.6),
            sprite: "map-lastcall-shutter.img",
            metal: true,
            zIdx: 12,
        }),
        sound: { ...MetalSound, explode: "door_open_03" },
        button: {
            interactionRad: 2,
            interactionText: "game-use",
            useOnce: false,
            useType: "",
            useDelay: 0,
            useDir: v2.create(0, 0),
            useImg: "map-lastcall-shutter.img",
            sound: { on: "door_open_03", off: "door_open_03" },
        },
    };
}

/** Freight gate that opens with the power (zombie_power_gate). */
export function lastCallPowerGateDef(): ObstacleDef {
    return {
        ...lastCallSolidBlock({
            extents: v2.create(3, 0.6),
            sprite: "map-lastcall-gate.img",
            metal: true,
            zIdx: 12,
        }),
        sound: { ...MetalSound, explode: "door_open_03" },
    };
}

/** Parked car in the garage (zombie_garage_car); 5 × 8.5, nose up at ori 0. */
export function lastCallCarDef(): ObstacleDef {
    return {
        ...lastCallSolidBlock({
            extents: v2.create(2.5, 4.25),
            sprite: "map-lastcall-car.img",
            metal: true,
            height: 1,
        }),
        map: { display: true, color: 0x1d8a8f, scale: 1 },
    };
}

function zoneAabb(id: LastCallZoneId, inset = 0): AABB {
    const z = LastCallZones.find((zone) => zone.id === id)!;
    const a = lastCallToLocal(z.rect.x0 + inset, z.rect.y1 - inset);
    const b = lastCallToLocal(z.rect.x1 - inset, z.rect.y0 + inset);
    return collider.createAabb(a, b);
}

const ZoneSurface: Record<LastCallZoneId, string> = {
    lobby: "tile",
    storage: "warehouse",
    courtyard: "asphalt",
    diner: "tile",
    alley: "asphalt",
    wing: "carpet",
    club: "tile",
    office: "house",
    garage: "warehouse",
};

/** Minimap colors per zone. */
const ZoneMapColor: Record<LastCallZoneId, number> = {
    lobby: 0x1f5560,
    storage: 0x3a3f47,
    courtyard: 0x3a3646,
    diner: 0x6a2236,
    alley: 0x2a2830,
    wing: 0x4a3463,
    club: 0x5c1f52,
    office: 0x5a3a22,
    garage: 0x2f3038,
};

function at(p: Vec2): Vec2 {
    return lastCallToLocal(p.x, p.y);
}

function buildingMapObjects(): BuildingDef["mapObjects"] {
    const objs: BuildingDef["mapObjects"] = [];
    const add = (type: string, pos: Vec2, ori = 0) => objs.push({ type, pos, scale: 1, ori });

    for (const w of lastCallWalls()) {
        const mid = (w.a0 + w.a1) / 2;
        add(
            lastCallWallType(w.a1 - w.a0),
            w.axis === "h" ? lastCallToLocal(mid, w.at) : lastCallToLocal(w.at, mid),
            w.axis === "h" ? 0 : 1,
        );
    }

    for (const d of LastCallDoors) {
        const o = d.opening;
        const mid = (o.a0 + o.a1) / 2;
        const center = o.axis === "h" ? lastCallToLocal(mid, o.at) : lastCallToLocal(o.at, mid);
        const ori = o.axis === "h" ? 0 : 1;
        if (d.kind === "shutter") add(lastCallShutterType(d.cost), center, ori);
        else if (d.kind === "power") add("zombie_power_gate", center, ori);
    }

    for (const p of LastCallProps) add(p.type, at(p.pos), p.ori ?? 0);
    for (const machine of LastCallPerkMachines) add(machine.type, at(machine.pos));
    // Zombies climb in at these (boarded windows are painted on the walls).
    for (const e of LastCallEntries) add("zombie_spawn_point", at(e.pos));

    add("zombie_mystery_box", at(LastCallBoxSpots[0].pos));
    for (const spot of LastCallBoxSpots) add("zombie_mystery_box_spot", at(spot.pos));
    add("zombie_power_switch", at(LastCallPowerSwitchPos));
    add("zombie_upgrade_bench", at(LastCallBenchPos));
    return objs;
}

function complexDef(): BuildingDef {
    const block = collider.createAabb(
        lastCallToLocal(0, LastCallZones.reduce((m, z) => Math.max(m, z.rect.y1), 0)),
        lastCallToLocal(LastCallZones.reduce((m, z) => Math.max(m, z.rect.x1), 0), 0),
    );
    return {
        type: "building",
        ori: 0,
        map: {
            display: true,
            color: 0x1c1826,
            scale: 1,
            shapes: LastCallZones.map((z) => ({
                collider: zoneAabb(z.id, 0.5),
                color: ZoneMapColor[z.id],
            })),
        },
        terrain: { grass: true, beach: false },
        mapObstacleBounds: [block],
        zIdx: 1,
        floor: {
            surfaces: LastCallZones.map((z) => ({
                type: ZoneSurface[z.id],
                collision: [zoneAabb(z.id)],
                data: { isBright: false },
            })),
            imgs: [
                {
                    sprite: "map-lastcall-floor.img",
                    pos: v2.create(0, 0),
                    // drawn at 16 / LastCallScale px per unit to keep the texture size down
                    scale: LastCallScale,
                    alpha: 1,
                    tint: 0xffffff,
                },
            ],
        },
        ceiling: {
            // Every zone (courtyard and alley too) counts as indoors: Zombie
            // Survival only spawns and routes inside zoom regions.
            zoomRegions: LastCallZones.map((z) => ({ zoomIn: zoneAabb(z.id) })),
            vision: { dist: 7, width: 3, linger: 0.2, fadeRate: 11 },
            imgs: [],
        },
        mapObjects: buildingMapObjects(),
    };
}

function lastCallDefs(): Record<string, MapObjectDef> {
    const defs: Record<string, MapObjectDef> = {};

    for (const len of lastCallWallLengths()) {
        defs[lastCallWallType(len)] = lastCallSolidBlock({
            extents: v2.create(len / 2, LastCallWallThickness / 2),
            isWall: true,
        });
    }

    // Invisible collision for furniture painted into the floor art.
    // (Names avoid "desk", "crate" etc.: Spec Ops strips props matching those from buildings.)
    // Counters and desks are waist-high cover; the pool rail stops feet, not bullets.
    // Built-in fixtures scale with the rooms (LastCallScaledPropTypes); sizes below are base-plan sizes.
    const fixture = (w: number, h: number, height: number) =>
        lastCallSolidBlock({ extents: v2.create((w / 2) * LastCallScale, (h / 2) * LastCallScale), height });
    defs.lastcall_reception = fixture(8, 2.5, 0.5);
    defs.lastcall_counter_diner = fixture(14, 2, 0.5);
    defs.lastcall_bar_club = fixture(3, 30, 0.5);
    defs.lastcall_dj_booth = fixture(16, 4, 0.5);
    defs.lastcall_office_table = fixture(12, 3.5, 0.5);
    defs.lastcall_pool = fixture(28, 15, 0.2);
    defs.lastcall_planter = lastCallSolidBlock({ extents: v2.create(1.5, 1.5), height: 1 });
    defs.lastcall_pallet = lastCallSolidBlock({ extents: v2.create(2.25, 2.25) });
    defs.lastcall_ice_machine = lastCallSolidBlock({ extents: v2.create(1.5, 1.25), metal: true, height: 1 });

    defs.lastcall_pillar = lastCallSolidBlock({
        extents: v2.create(1.25, 1.25),
        sprite: "map-lastcall-pillar.img",
        isWall: true,
    });
    defs.lastcall_dumpster = lastCallSolidBlock({
        extents: v2.create(2.75, 1.5),
        sprite: "map-lastcall-dumpster.img",
        metal: true,
        height: 1,
    });

    const perkMachine = (sprite: string, mapColor: number): ObstacleDef => ({
        ...lastCallSolidBlock({
            extents: v2.create(2.15, 1.35),
            height: 1,
            sprite,
            spriteScale: 1,
            metal: true,
            zIdx: 10,
        }),
        map: { display: true, color: mapColor, scale: 1.15 },
        button: {
            interactionRad: 2.5,
            interactionText: "game-use",
            useOnce: false,
            useType: "",
            useDelay: 0,
            useDir: v2.create(0, -1),
            useImg: sprite,
            sound: { on: "perk_pickup_01", off: "perk_pickup_01" },
        },
    });
    defs.zombie_perk_machine_juggernog = perkMachine("map-zombie-perk-juggernog.img", 0xb52b32);
    defs.zombie_perk_machine_speed_cola = perkMachine("map-zombie-perk-speed-cola.img", 0x2c5d91);
    defs.zombie_perk_machine_quick_revive = perkMachine("map-zombie-perk-quick-revive.img", 0x55c8d0);
    defs.zombie_perk_machine_stamin_up = perkMachine("map-zombie-perk-stamin-up.img", 0x72932e);
    defs.zombie_perk_machine_double_tap = perkMachine("map-zombie-perk-double-tap.img", 0xcf6a24);

    defs[LastCallBuildingType] = complexDef();
    return defs;
}

export const LastCallMapObjectDefs = lastCallDefs();
