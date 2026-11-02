export const GrayboxLayoutVersion = 1 as const;
export const GrayboxLayoutMaxObjects = 256;

export type GrayboxObjectKind = "obstacle" | "player_spawn" | "zombie_spawn" | "station";

export interface GrayboxLayoutObject {
    id: string;
    kind: GrayboxObjectKind;
    type: string;
    x: number;
    y: number;
    ori: 0 | 1 | 2 | 3;
    layer: number;
}

export interface GrayboxLayout {
    version: typeof GrayboxLayoutVersion;
    name: string;
    mapName: string;
    gridSize: number;
    objects: GrayboxLayoutObject[];
}

const kinds = new Set<GrayboxObjectKind>([
    "obstacle",
    "player_spawn",
    "zombie_spawn",
    "station",
]);

function finiteNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number`);
    }
    return value;
}

export function createGrayboxLayout(mapName = "specops"): GrayboxLayout {
    return {
        version: GrayboxLayoutVersion,
        name: "indoor-layout",
        mapName,
        gridSize: 1,
        objects: [],
    };
}

export function parseGrayboxLayout(value: string | unknown): GrayboxLayout {
    const raw = typeof value === "string" ? JSON.parse(value) : value;
    if (!raw || typeof raw !== "object") throw new Error("Layout must be an object");

    const input = raw as Record<string, unknown>;
    if (input.version !== GrayboxLayoutVersion) {
        throw new Error(`Unsupported layout version: ${String(input.version)}`);
    }
    if (!Array.isArray(input.objects)) throw new Error("Layout objects must be an array");
    if (input.objects.length > GrayboxLayoutMaxObjects) {
        throw new Error(`Layout exceeds ${GrayboxLayoutMaxObjects} objects`);
    }

    const ids = new Set<string>();
    const objects = input.objects.map((item, index): GrayboxLayoutObject => {
        if (!item || typeof item !== "object") throw new Error(`Object ${index} is invalid`);
        const object = item as Record<string, unknown>;
        const id = String(object.id ?? "").trim();
        const kind = object.kind as GrayboxObjectKind;
        const type = String(object.type ?? "").trim();
        const ori = finiteNumber(object.ori, `Object ${index} orientation`);
        const layer = finiteNumber(object.layer, `Object ${index} layer`);

        if (!id || ids.has(id)) throw new Error(`Object ${index} has a missing or duplicate id`);
        if (!kinds.has(kind)) throw new Error(`Object ${index} has an invalid kind`);
        if (!type || type.length > 64) throw new Error(`Object ${index} has an invalid type`);
        if (!Number.isInteger(ori) || ori < 0 || ori > 3) {
            throw new Error(`Object ${index} orientation must be 0, 1, 2, or 3`);
        }
        if (!Number.isInteger(layer) || layer < 0 || layer > 1) {
            throw new Error(`Object ${index} layer must be 0 or 1`);
        }
        ids.add(id);
        return {
            id,
            kind,
            type,
            x: finiteNumber(object.x, `Object ${index} x`),
            y: finiteNumber(object.y, `Object ${index} y`),
            ori: ori as 0 | 1 | 2 | 3,
            layer,
        };
    });

    const gridSize = finiteNumber(input.gridSize, "Grid size");
    if (gridSize < 0.25 || gridSize > 16) throw new Error("Grid size must be between 0.25 and 16");

    return {
        version: GrayboxLayoutVersion,
        name: String(input.name ?? "indoor-layout").slice(0, 64),
        mapName: String(input.mapName ?? "specops").slice(0, 32),
        gridSize,
        objects,
    };
}

export function serializeGrayboxLayout(layout: GrayboxLayout, pretty = false): string {
    return JSON.stringify(parseGrayboxLayout(layout), null, pretty ? 2 : undefined);
}

export function snapGrayboxCoordinate(value: number, gridSize: number): number {
    return Math.round(value / gridSize) * gridSize;
}
