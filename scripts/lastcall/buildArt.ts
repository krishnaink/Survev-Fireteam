/**
 * Generates the Last Call (Zombie Survival `specops_complex`) art from
 * shared/defs/maps/lastCallLayout.ts: the painted floor of the whole block plus
 * the shutter, gate, pillar, car and dumpster sprites.
 *
 *   bun scripts/lastcall/buildArt.ts
 *
 * Writes SVGs into client/public/img/map/. The floor's viewBox is in game units
 * so walls, doorways and props land exactly on their collision boxes. Room
 * decor (floors, rugs, the pool, bar, DJ booth...) is drawn in base-plan units
 * inside a scale(LastCallScale) group, the same way the layout scales it.
 * Re-run after moving anything in the layout.
 */
import fs from "node:fs";
import path from "node:path";
import {
    LastCallApron,
    LastCallBaseProps,
    LastCallBaseZones,
    LastCallBoxSpots,
    LastCallDoors,
    LastCallEntries,
    LastCallHeight,
    LastCallMotelRooms,
    LastCallPowerSwitchPos,
    type LastCallProp,
    LastCallProps,
    type LastCallRect,
    LastCallScale,
    lastCallWalls,
    LastCallWallThickness,
    LastCallWidth,
    type LastCallZoneId,
    LastCallZones,
} from "../../shared/defs/maps/lastCallLayout.ts";

const outDir = path.join(import.meta.dirname, "../../client/public/img/map");
const S = LastCallScale;
const PX = 16 / S; // px per unit on the floor (floor img scale = LastCallScale)
const SPX = 32; // px per unit on prop sprites (obstacle img scale 0.5)

const C = {
    night: "#100e17",
    street: "#17151f",
    sidewalk: "#24212e",
    seam: "#2e2a3a",
    wall: "#efe3cf",
    wallShade: "#06050a",
    pink: "#ff3d8b",
    cyan: "#2de2e6",
    yellow: "#ffd319",
    purple: "#8b5cf6",
    red: "#ff4d6d",
    wood: "#5a3a22",
    woodLight: "#7a5232",
};

/** Base-plan rect of a zone (for decor drawn inside the scale group). */
const bzone = (id: LastCallZoneId) => LastCallBaseZones.find((z) => z.id === id)!.rect;
const baseMotelRooms = LastCallMotelRooms.map((r) => ({ x0: r.x0 / S, y0: r.y0 / S, x1: r.x1 / S, y1: r.y1 / S }));
const r2 = (n: number) => Math.round(n * 1000) / 1000;

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ""): string {
    return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${fill}" ${extra}/>`;
}
function rr(r: LastCallRect, fill: string, extra = ""): string {
    return rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, fill, extra);
}
function text(x: number, y: number, s: string, size: number, fill: string, extra = ""): string {
    return `<text x="${r2(x)}" y="${r2(y)}" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${size}" fill="${fill}" ${extra}>${s}</text>`;
}
/** Props in game units (furniture keeps its size). */
function propsOf(type: string): LastCallProp[] {
    return LastCallProps.filter((p) => p.type === type);
}
/** Built-in fixtures in base-plan units, for drawing inside the scale group. */
function basePropsOf(type: string): LastCallProp[] {
    return LastCallBaseProps.filter((p) => p.type === type);
}

/** Checkerboard clipped to a rect. */
function checker(r: LastCallRect, a: string, b: string, tile: number, id: string): string {
    return `<pattern id="${id}" x="${r.x0}" y="${r.y0}" width="${tile * 2}" height="${tile * 2}" patternUnits="userSpaceOnUse">`
        + rect(0, 0, tile * 2, tile * 2, a)
        + rect(0, 0, tile, tile, b)
        + rect(tile, tile, tile, tile, b)
        + `</pattern>${rr(r, `url(#${id})`)}`;
}

function grid(r: LastCallRect, step: number, color: string, width: number): string {
    let s = "";
    for (let x = r.x0 + step; x < r.x1 - 0.01; x += step) {
        s += `<line x1="${r2(x)}" y1="${r.y0}" x2="${r2(x)}" y2="${r.y1}" stroke="${color}" stroke-width="${width}"/>`;
    }
    for (let y = r.y0 + step; y < r.y1 - 0.01; y += step) {
        s += `<line x1="${r.x0}" y1="${r2(y)}" x2="${r.x1}" y2="${r2(y)}" stroke="${color}" stroke-width="${width}"/>`;
    }
    return s;
}

function palm(cx: number, cy: number): string {
    let s = `<circle cx="${cx}" cy="${cy}" r="1.6" fill="#4a2f1c" stroke="#2a1a10" stroke-width="0.25"/>`;
    for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.3;
        const x = cx + Math.cos(a) * 2.9;
        const y = cy + Math.sin(a) * 2.9;
        s += `<path d="M${cx} ${cy} Q${r2(cx + Math.cos(a + 0.35) * 1.8)} ${r2(cy + Math.sin(a + 0.35) * 1.8)} ${r2(x)} ${r2(y)}" stroke="#2f9e63" stroke-width="0.9" fill="none" stroke-linecap="round"/>`;
    }
    return s + `<circle cx="${cx}" cy="${cy}" r="0.55" fill="#1d6b43"/>`;
}

function floorSvg(): string {
    const A = LastCallApron;
    const W = LastCallWidth;
    const H = LastCallHeight;
    const parts: string[] = [];
    const defs: string[] = [];

    // --- street + sidewalk around the block -------------------------------------
    parts.push(rect(-A, -A, W + 2 * A, H + 2 * A, C.street));
    parts.push(rect(-3.5, -3.5, W + 7, H + 7, C.sidewalk));
    for (let x = -3; x < W + 3; x += 4) parts.push(rect(x, -3.5, 0.15, H + 7, C.seam));
    // dashed center line of the street
    const dash = `stroke="${C.yellow}" stroke-width="0.35" stroke-dasharray="3 3" opacity="0.55" fill="none"`;
    parts.push(`<rect x="${-A / 2 - 1.75}" y="${-A / 2 - 1.75}" width="${W + A + 3.5}" height="${H + A + 3.5}" ${dash}/>`);

    const under = parts.splice(0);
    const room: string[] = [];

    // --- zones (base-plan units, drawn inside scale(S)) --------------------------------------------------------------------
    // Lobby: teal checker + entry rug
    room.push(checker(bzone("lobby"), "#173a43", "#1f4a55", 2, "pLobby"));
    room.push(rect(59, 100, 22, 9, "#3b1426", `opacity="0.85"`));
    room.push(rect(59.6, 100.6, 20.8, 7.8, "none", `stroke="${C.pink}" stroke-width="0.25" opacity="0.7"`));
    // reception desk (lastcall_reception)
    for (const p of basePropsOf("lastcall_reception")) {
        room.push(rect(p.pos.x - 4, p.pos.y - 1.25, 8, 2.5, C.wood, `stroke="${C.wall}" stroke-width="0.25"`));
        room.push(rect(p.pos.x - 3.6, p.pos.y - 0.85, 2.2, 1.4, "#cfe9f2", `opacity="0.8"`));
        room.push(`<circle cx="${p.pos.x + 2.5}" cy="${p.pos.y}" r="0.45" fill="${C.yellow}"/>`);
    }
    room.push(text(57, 93.5, "LAST CALL MOTEL", 1.6, C.cyan, `opacity="0.75"`));

    // Storage: concrete + pallets of boxes
    room.push(rr(bzone("storage"), "#2a2d33"));
    room.push(grid(bzone("storage"), 5, "#31353c", 0.12));
    for (const p of propsOf("lastcall_pallet")) {
        parts.push(rect(p.pos.x - 2.25, p.pos.y - 2.25, 4.5, 4.5, "#6b4a26", `stroke="#3a2812" stroke-width="0.3"`));
        parts.push(rect(p.pos.x - 2, p.pos.y - 2, 2, 2, "#8a6236"));
        parts.push(rect(p.pos.x + 0.1, p.pos.y + 0.1, 1.9, 1.9, "#7d5830"));
        parts.push(`<line x1="${p.pos.x - 2.25}" y1="${p.pos.y}" x2="${p.pos.x + 2.25}" y2="${p.pos.y}" stroke="#3a2812" stroke-width="0.2"/>`);
    }

    // Courtyard: pavers, drained pool, palms
    room.push(rr(bzone("courtyard"), "#26232f"));
    room.push(grid(bzone("courtyard"), 4, "#302c3b", 0.15));
    for (const p of basePropsOf("lastcall_pool")) {
        const x = p.pos.x - 14;
        const y = p.pos.y - 7.5;
        room.push(`<rect x="${x}" y="${y}" width="28" height="15" rx="4" fill="#e9a8c8"/>`);
        defs.push(`<pattern id="pPool" x="${x}" y="${y}" width="2" height="2" patternUnits="userSpaceOnUse">${rect(0, 0, 2, 2, "#0f4f61")}${rect(0, 0, 2, 0.12, "#17687d")}${rect(0, 0, 0.12, 2, "#17687d")}</pattern>`);
        room.push(`<rect x="${x + 0.9}" y="${y + 0.9}" width="26.2" height="13.2" rx="3.2" fill="url(#pPool)"/>`);
        room.push(`<rect x="${x + 16}" y="${y + 0.9}" width="11.1" height="13.2" rx="3" fill="#0a3442" opacity="0.6"/>`);
        room.push(text(x + 3, y + 8.6, "SHALLOW", 1.4, "#9fe7f5", `opacity="0.55"`));
        room.push(text(x + 18.5, y + 8.6, "DEEP", 1.4, "#9fe7f5", `opacity="0.55"`));
        // ladder
        room.push(rect(x + 25, y + 5.5, 0.3, 4, "#c9d2d9"));
        room.push(rect(x + 26.4, y + 5.5, 0.3, 4, "#c9d2d9"));
    }
    for (const p of propsOf("lastcall_planter")) {
        const z = LastCallZones.find((zz) => {
            const r = zz.rect;
            return p.pos.x > r.x0 && p.pos.x < r.x1 && p.pos.y > r.y0 && p.pos.y < r.y1;
        });
        if (z?.id === "courtyard") parts.push(palm(p.pos.x, p.pos.y));
        else {
            parts.push(`<circle cx="${p.pos.x}" cy="${p.pos.y}" r="1.5" fill="#4a2f1c"/>`);
            parts.push(`<circle cx="${p.pos.x}" cy="${p.pos.y}" r="1.15" fill="#2f9e63"/>`);
        }
    }
    room.push(text(41.5, 89, "COURTYARD", 1.6, C.wall, `opacity="0.25"`));

    // Diner: red checker, kitchen tiles, counter, booths
    room.push(checker(bzone("diner"), "#24121a", "#3d1a26", 2, "pDiner"));
    room.push(rect(10.5, 90.5, 15.5, 7.5, "#34383f"));
    room.push(grid({ x0: 10.5, y0: 90.5, x1: 26, y1: 98 }, 1.5, "#3d424a", 0.1));
    for (const p of basePropsOf("lastcall_counter_diner")) {
        room.push(rect(p.pos.x - 7, p.pos.y - 1, 14, 2, "#c23a5e", `stroke="#e7e7ee" stroke-width="0.3"`));
        for (let i = 0; i < 5; i++) {
            room.push(`<circle cx="${p.pos.x - 5.5 + i * 2.75}" cy="${p.pos.y + 2.2}" r="0.7" fill="#e7e7ee" stroke="#c23a5e" stroke-width="0.2"/>`);
        }
    }
    for (const p of propsOf("table_01")) {
        parts.push(rect(p.pos.x - 3.4, p.pos.y - 4, 6.8, 1.4, "#8a1f3a", `rx="0.5"`));
        parts.push(rect(p.pos.x - 3.4, p.pos.y + 2.2, 6.8, 1.4, "#8a1f3a", `rx="0.5"`));
    }
    room.push(text(35, 113.6, "NEON DINER", 1.8, C.pink, `opacity="0.7"`));

    // Alley: asphalt, puddles, edge stripes
    room.push(rr(bzone("alley"), "#18171d"));
    room.push(`<ellipse cx="106" cy="88" rx="2.6" ry="1.4" fill="#22304a" opacity="0.8"/>`);
    room.push(`<ellipse cx="103.5" cy="55" rx="1.8" ry="1" fill="#22304a" opacity="0.8"/>`);
    room.push(`<path d="M101 70 L104 73 L103 76 L106 80" stroke="#0e0d12" stroke-width="0.25" fill="none"/>`);
    room.push(rect(100.6, 50.5, 0.35, 64, C.yellow, `opacity="0.35"`));
    room.push(rect(114.05, 50.5, 0.35, 64, C.yellow, `opacity="0.35"`));
    room.push(text(101.2, 108, "ALLEY", 1.5, C.wall, `opacity="0.3"`));

    // Motel wing: hall carpet, room carpets, ice machines, room numbers
    defs.push(`<pattern id="pCarpet" x="0" y="0" width="3" height="3" patternUnits="userSpaceOnUse">${rect(0, 0, 3, 3, "#33224a")}<path d="M1.5 0 L3 1.5 L1.5 3 L0 1.5 Z" fill="#3d2a57"/></pattern>`);
    room.push(rr(bzone("wing"), "url(#pCarpet)"));
    baseMotelRooms.forEach((r, i) => {
        room.push(rr(r, "#2a1f35"));
        room.push(rect(r.x0 + 1.5, r.y0 + 1.5, r.x1 - r.x0 - 3, r.y1 - r.y0 - 3, "none", `stroke="#3a2b4a" stroke-width="0.3"`));
        room.push(text(r.x1 - 5, r.y1 - 1.5, `10${i + 1}`, 1.3, "#bfb3d6", `opacity="0.7"`));
        // bathroom tiles in the corner
        room.push(rect(r.x0 + 0.5, r.y1 - 5, 4.5, 4.5, "#3a3f47"));
    });
    for (const p of propsOf("lastcall_ice_machine")) {
        parts.push(rect(p.pos.x - 1.5, p.pos.y - 1.25, 3, 2.5, "#cfe9f2", `stroke="#7fb3c4" stroke-width="0.25"`));
        parts.push(text(p.pos.x - 1.1, p.pos.y + 0.45, "ICE", 0.9, "#2a6f86"));
    }
    room.push(text(24, 46, "MOTEL WING", 1.5, C.wall, `opacity="0.3"`));

    // Club Paradiso
    room.push(rr(bzone("club"), "#1a0f24"));
    defs.push(`<pattern id="pDance" x="58" y="12" width="8" height="8" patternUnits="userSpaceOnUse">`
        + rect(0, 0, 4, 4, "#7a1f5e") + rect(4, 0, 4, 4, "#1f5a6e") + rect(0, 4, 4, 4, "#3a2a78") + rect(4, 4, 4, 4, "#7a1f5e")
        + rect(0, 0, 8, 8, "none", `stroke="#0c0812" stroke-width="0.3"`) + `</pattern>`);
    room.push(rect(58, 12, 32, 24, "url(#pDance)"));
    room.push(rect(58, 12, 32, 24, "none", `stroke="${C.pink}" stroke-width="0.4"`));
    for (const p of basePropsOf("lastcall_dj_booth")) {
        room.push(rect(p.pos.x - 8, p.pos.y - 2, 16, 4, "#241a33", `stroke="${C.pink}" stroke-width="0.35"`));
        room.push(`<circle cx="${p.pos.x - 4}" cy="${p.pos.y}" r="1.3" fill="#0c0812" stroke="${C.cyan}" stroke-width="0.25"/>`);
        room.push(`<circle cx="${p.pos.x + 4}" cy="${p.pos.y}" r="1.3" fill="#0c0812" stroke="${C.cyan}" stroke-width="0.25"/>`);
        room.push(rect(p.pos.x - 1.5, p.pos.y - 0.8, 3, 1.6, "#3a2a50"));
    }
    for (const p of basePropsOf("lastcall_bar_club")) {
        room.push(rect(40.5, p.pos.y - 15, 2.4, 30, "#2a1a30"));
        for (let y = p.pos.y - 14; y < p.pos.y + 14; y += 1.6) {
            const col = [C.cyan, C.pink, C.yellow, "#9be36b"][Math.floor(y) % 4];
            room.push(`<circle cx="41.7" cy="${r2(y)}" r="0.35" fill="${col}" opacity="0.8"/>`);
        }
        room.push(rect(p.pos.x - 1.5, p.pos.y - 15, 3, 30, C.wood, `stroke="${C.woodLight}" stroke-width="0.3"`));
    }
    room.push(rect(96, 29, 13.5, 20.5, "#3b1530", `opacity="0.9"`));
    room.push(rect(96, 29, 13.5, 20.5, "none", `stroke="${C.pink}" stroke-width="0.3" stroke-dasharray="1 0.6"`));
    room.push(text(97, 28, "VIP", 1.4, C.pink));
    room.push(text(61, 40.5, "CLUB PARADISO", 2.6, C.pink, `opacity="0.85"`));

    // Manager's office: wood planks, rug, desk, safe
    defs.push(`<pattern id="pWood" x="0" y="0" width="1.2" height="6" patternUnits="userSpaceOnUse">${rect(0, 0, 1.2, 6, "#3a2618")}${rect(1.1, 0, 0.1, 6, "#2a1b10")}${rect(0, 2.9, 1.2, 0.1, "#2a1b10")}</pattern>`);
    room.push(rr(bzone("office"), "url(#pWood)"));
    room.push(rect(117, 4, 22, 14, "#4a1d2c"));
    room.push(rect(117.6, 4.6, 20.8, 12.8, "none", `stroke="#c9a25a" stroke-width="0.25"`));
    for (const p of basePropsOf("lastcall_office_table")) {
        room.push(rect(p.pos.x - 6, p.pos.y - 1.75, 12, 3.5, "#6b3a1f", `stroke="#c9a25a" stroke-width="0.25"`));
        room.push(rect(p.pos.x - 4.5, p.pos.y - 1.1, 2.6, 2, "#efe3cf", `opacity="0.85"`));
        room.push(`<circle cx="${p.pos.x + 3.5}" cy="${p.pos.y}" r="0.7" fill="#1b1b22"/>`);
    }
    room.push(rect(140.5, 1, 4, 3.5, "#3a3d45", `stroke="#6e727c" stroke-width="0.25"`));
    // freight ramp under the gate
    room.push(rect(127, 20, 6, 5, "#2a2a31"));
    for (let y = 20.5; y < 25; y += 1) room.push(rect(127.3, y, 5.4, 0.2, "#3c3c45"));
    room.push(text(111.5, 24, "OFFICE", 1.3, C.wall, `opacity="0.35"`));
    // glow under the power switch so it reads from across the room
    parts.push(`<circle cx="${LastCallPowerSwitchPos.x}" cy="${LastCallPowerSwitchPos.y}" r="2.6" fill="${C.yellow}" opacity="0.14"/>`);
    parts.push(text(LastCallPowerSwitchPos.x - 2.3, LastCallPowerSwitchPos.y - 1.6, "POWER", 0.9, C.yellow, `opacity="0.8"`));

    // Garage: concrete, parking stalls, arrows, oil
    room.push(rr(bzone("garage"), "#1c1c22"));
    room.push(grid(bzone("garage"), 10, "#23232a", 0.15));
    for (let y = 30; y <= 110; y += 9) room.push(rect(135.5, y, 9, 0.3, C.yellow, `opacity="0.55"`));
    for (let y = 26; y < 112; y += 18) {
        room.push(`<path d="M122 ${y + 4} l1.5 -2.5 l1.5 2.5 m-1.5 -2.5 v6" stroke="#e7e7ee" stroke-width="0.35" fill="none" opacity="0.35"/>`);
    }
    for (const [x, y] of [[133, 50], [120, 92], [137, 72]]) {
        room.push(`<ellipse cx="${x}" cy="${y}" rx="1.8" ry="1.1" fill="#0b0b0f" opacity="0.7"/>`);
    }
    room.push(text(116, 113.5, "P2  PARKING", 1.4, C.wall, `opacity="0.3"`));

    // --- mystery box spots, manholes, spawn chevrons ------------------------------
    for (const b of LastCallBoxSpots) {
        // zombie_mystery_box is 8.8 × 3.7
        parts.push(`<rect x="${b.pos.x - 4.9}" y="${b.pos.y - 2.35}" width="9.8" height="4.7" rx="0.6" fill="#8b5cf6" fill-opacity="0.12" stroke="${C.purple}" stroke-width="0.25" stroke-dasharray="0.8 0.5"/>`);
    }
    for (const e of LastCallEntries) {
        if (e.manhole) {
            parts.push(`<circle cx="${e.pos.x}" cy="${e.pos.y}" r="2.1" fill="${C.red}" opacity="0.15"/>`);
            parts.push(`<circle cx="${e.pos.x}" cy="${e.pos.y}" r="1.5" fill="#2b2b33" stroke="#5a5a66" stroke-width="0.3"/>`);
            for (let i = -1; i <= 1; i++) parts.push(rect(e.pos.x - 1, e.pos.y + i * 0.5 - 0.08, 2, 0.16, "#45454f"));
        }
    }

    // --- thresholds under every doorway (visible once a shutter is bought) -------
    for (const d of LastCallDoors) {
        const o = d.opening;
        const t = LastCallWallThickness;
        const r: LastCallRect = o.axis === "h"
            ? { x0: o.a0, y0: o.at - t / 2, x1: o.a1, y1: o.at + t / 2 }
            : { x0: o.at - t / 2, y0: o.a0, x1: o.at + t / 2, y1: o.a1 };
        parts.push(rr(r, "#3a3a44"));
        if (d.kind === "shutter" || d.kind === "power") {
            // hazard paint on both sides of a shutter
            const col = d.kind === "power" ? C.pink : C.yellow;
            const sides: LastCallRect[] = o.axis === "h"
                ? [{ x0: o.a0, y0: o.at - 1.6, x1: o.a1, y1: o.at - 1.0 }, { x0: o.a0, y0: o.at + 1.0, x1: o.a1, y1: o.at + 1.6 }]
                : [{ x0: o.at - 1.6, y0: o.a0, x1: o.at - 1.0, y1: o.a1 }, { x0: o.at + 1.0, y0: o.a0, x1: o.at + 1.6, y1: o.a1 }];
            for (const s of sides) parts.push(rr(s, col, `opacity="0.55"`));
            if (d.cost) {
                const mid = (o.a0 + o.a1) / 2;
                const [tx, ty] = o.axis === "h" ? [mid - 1.6, o.at - 2.3] : [o.at + 2.1, mid + 0.5];
                parts.push(text(tx, ty, `$${d.cost}`, 1.25, C.yellow, `opacity="0.9"`));
            }
        }
    }

    // --- walls ---------------------------------------------------------------------
    const walls = lastCallWalls();
    const half = LastCallWallThickness / 2;
    const wallRects = walls.map((w): LastCallRect =>
        w.axis === "h"
            ? { x0: w.a0, y0: w.at - half, x1: w.a1, y1: w.at + half }
            : { x0: w.at - half, y0: w.a0, x1: w.at + half, y1: w.a1 }
    );
    for (const r of wallRects) parts.push(rect(r.x0 + 0.35, r.y0 + 0.35, r.x1 - r.x0, r.y1 - r.y0, C.wallShade, `opacity="0.55"`));
    for (const r of wallRects) parts.push(rr(r, C.wall));
    for (const r of wallRects) {
        parts.push(rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, "none", `stroke="#b8a98f" stroke-width="0.12"`));
    }

    // --- boarded windows (where enemies climb in) ------------------------------------
    for (const e of LastCallEntries) {
        if (!e.window) continue;
        const o = e.window;
        const len = o.a1 - o.a0;
        const glass: LastCallRect = o.axis === "h"
            ? { x0: o.a0, y0: o.at - 0.3, x1: o.a1, y1: o.at + 0.3 }
            : { x0: o.at - 0.3, y0: o.a0, x1: o.at + 0.3, y1: o.a1 };
        parts.push(rr(glass, C.cyan, `opacity="0.85"`));
        const planks = Math.max(2, Math.round(len / 2));
        for (let i = 0; i < planks; i++) {
            const t = (i + 0.5) / planks;
            const c = o.a0 + len * t;
            const tilt = i % 2 ? 0.35 : -0.35;
            const [x1, y1, x2, y2] = o.axis === "h"
                ? [c - 0.6, o.at - 0.7 + tilt, c + 0.6, o.at + 0.7 - tilt]
                : [o.at - 0.7 + tilt, c - 0.6, o.at + 0.7 - tilt, c + 0.6];
            parts.push(`<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="#8a5a2b" stroke-width="0.55" stroke-linecap="round"/>`);
        }
        // red danger chevron on the floor inside
        parts.push(`<circle cx="${e.pos.x}" cy="${e.pos.y}" r="1.3" fill="${C.red}" opacity="0.18"/>`);
    }

    const w = Math.round((W + 2 * A) * PX);
    const h = Math.round((H + 2 * A) * PX);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${-A} ${-A} ${W + 2 * A} ${H + 2 * A}">`
        + `<defs>${defs.join("")}</defs>${under.join("")}`
        + `<g transform="scale(${S})">${room.join("")}</g>${parts.join("")}</svg>\n`;
}

/** A prop sprite drawn in units, w×h units at 32 px/unit. */
function sprite(wu: number, hu: number, body: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${wu * SPX}" height="${hu * SPX}" viewBox="0 0 ${wu} ${hu}">${body}</svg>\n`;
}

function hazard(wu: number, hu: number, a: string, b: string, id: string): string {
    return `<defs><pattern id="${id}" width="1.2" height="1.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">${rect(0, 0, 0.6, 1.2, a)}${rect(0.6, 0, 0.6, 1.2, b)}</pattern></defs>`
        + rect(0, 0, wu, hu, `url(#${id})`)
        + rect(0.06, 0.06, wu - 0.12, hu - 0.12, "none", `stroke="#111" stroke-width="0.12"`);
}

const sprites: Record<string, string> = {
    "map-lastcall-floor.svg": floorSvg(),
    // rolling shutter, 6 × 1.2
    "map-lastcall-shutter.svg": sprite(
        6,
        1.2,
        hazard(6, 1.2, C.yellow, "#1a1a1f", "h")
            + rect(2.35, 0.14, 1.3, 0.92, "#1a1a1f", `rx="0.15"`)
            // padlock: shackle + body
            + `<path d="M2.8 0.62 v-0.18 a0.2 0.2 0 0 1 0.4 0 v0.18" stroke="${C.yellow}" stroke-width="0.1" fill="none"/>`
            + rect(2.7, 0.6, 0.6, 0.38, C.yellow, `rx="0.06"`)
            + `<circle cx="3" cy="0.77" r="0.06" fill="#1a1a1f"/>`,
    ),
    // freight gate, 6 × 1.2
    "map-lastcall-gate.svg": sprite(
        6,
        1.2,
        hazard(6, 1.2, C.pink, "#1a1a1f", "g")
            + rect(2.4, 0.18, 1.2, 0.84, "#1a1a1f", `rx="0.15"`)
            + `<path d="M3.1 0.28 L2.75 0.62 H3.05 L2.9 0.95 L3.3 0.55 H3 Z" fill="${C.yellow}"/>`,
    ),
    // garage pillar, 2.5 × 2.5
    "map-lastcall-pillar.svg": sprite(
        2.5,
        2.5,
        rect(0, 0, 2.5, 2.5, "#6e6e7c") + rect(0.15, 0.15, 2.2, 2.2, "#8a8a98")
            + `<defs><pattern id="ph" width="0.5" height="0.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">${rect(0, 0, 0.25, 0.5, C.yellow)}${rect(0.25, 0, 0.25, 0.5, "#1a1a1f")}</pattern></defs>`
            + rect(0, 0, 2.5, 0.35, "url(#ph)") + rect(0, 2.15, 2.5, 0.35, "url(#ph)"),
    ),
    // parked car (top-down), 5 × 8.5
    "map-lastcall-car.svg": sprite(
        5,
        8.5,
        `<rect x="0.2" y="0.2" width="4.6" height="8.1" rx="1.3" fill="#1d8a8f" stroke="#0b3c3f" stroke-width="0.2"/>`
            + `<rect x="0.75" y="2.1" width="3.5" height="1.7" rx="0.4" fill="#0c1a24"/>`
            + `<rect x="0.75" y="5.6" width="3.5" height="1.3" rx="0.4" fill="#0c1a24"/>`
            + `<rect x="0.9" y="3.9" width="3.2" height="1.6" fill="#24a3a8"/>`
            + `<rect x="0.6" y="0.35" width="1" height="0.35" fill="#fff6c2"/><rect x="3.4" y="0.35" width="1" height="0.35" fill="#fff6c2"/>`
            + `<rect x="0.6" y="7.8" width="1" height="0.3" fill="${C.red}"/><rect x="3.4" y="7.8" width="1" height="0.3" fill="${C.red}"/>`
            + `<line x1="2.5" y1="0.4" x2="2.5" y2="2" stroke="${C.pink}" stroke-width="0.25"/>`,
    ),
    // dumpster, 5.5 × 3
    "map-lastcall-dumpster.svg": sprite(
        5.5,
        3,
        `<rect x="0.1" y="0.1" width="5.3" height="2.8" rx="0.25" fill="#2f5d3a" stroke="#1b3522" stroke-width="0.2"/>`
            + `<rect x="0.4" y="0.4" width="2.3" height="2.2" fill="#3a7048"/><rect x="2.8" y="0.4" width="2.3" height="2.2" fill="#356842"/>`
            + `<line x1="0.6" y1="1.5" x2="4.9" y2="1.5" stroke="#1b3522" stroke-width="0.12"/>`,
    ),
};

for (const [name, svg] of Object.entries(sprites)) {
    fs.writeFileSync(path.join(outDir, name), svg);
    console.log(`wrote ${name} (${(svg.length / 1024).toFixed(1)} KB)`);
}
