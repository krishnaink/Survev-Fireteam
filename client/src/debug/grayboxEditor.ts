import type { TabPageApi } from "tweakpane";

import {
    GrayboxLayoutMaxObjects,
    type GrayboxLayoutObject,
    serializeGrayboxLayout,
    snapGrayboxCoordinate,
} from "../../../shared/debug/grayboxLayout.ts";
import { MapObjectDefs } from "../../../shared/defs/register.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { math } from "../../../shared/utils/math.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Game } from "../game.ts";
import { type InputHandler, Key, MouseButton } from "../input.ts";
import { debugLines } from "./debugLines.ts";
import { GrayboxEditorModel } from "./grayboxEditorModel.ts";

const palette: Record<string, string> = {
    "Wall · Wood": "obstacle:reserve_wall_int_10",
    "Wall · Police": "obstacle:police_wall_int_10",
    "Wall · Mansion": "obstacle:mansion_wall_int_10",
    "Wall · Club": "obstacle:club_wall_int_10",
    "Door · Wood": "obstacle:house_door_01",
    "Door · Metal": "obstacle:house_door_02",
    "Door · Heavy wood": "obstacle:house_door_03",
    "Door · Zombie": "obstacle:zombie_door_01",
    "Furniture · Table": "obstacle:table_01",
    "Furniture · Couch": "obstacle:couch_01",
    "Furniture · Barrel": "obstacle:barrel_01",
    "Furniture · Crate": "obstacle:crate_01",
    "Station · Mystery Box": "obstacle:zombie_mystery_box",
    "Marker · Player spawn": "player_spawn:player_spawn",
    "Marker · Zombie spawn": "zombie_spawn:zombie_spawn",
    "Marker · Perk station": "station:perk_station",
};

export class GrayboxEditor {
    readonly model: GrayboxEditorModel;
    readonly params = {
        active: false,
        tool: "Place" as "Place" | "Select",
        palette: palette["Wall · Wood"],
        gridSize: 1,
        layer: 0,
        orientation: 0,
        status: "0 objects",
    };

    private statusBinding: ReturnType<TabPageApi["addBinding"]>;

    constructor(
        private readonly game: Game,
        page: TabPageApi,
        private readonly sync: (json: string) => void,
    ) {
        this.model = new GrayboxEditorModel(game.m_map?.mapName || "specops");

        page.addBinding(this.params, "active", { label: "Live editing" });
        page.addBinding(this.params, "tool", {
            label: "Tool",
            options: { Place: "Place", Select: "Select" },
        });
        page.addBinding(this.params, "palette", { label: "Object", options: palette });
        page.addBinding(this.params, "gridSize", {
            label: "Grid",
            min: 0.25,
            max: 4,
            step: 0.25,
        }).on("change", () => {
            this.model.layout.gridSize = this.params.gridSize;
        });
        page.addBinding(this.params, "layer", {
            label: "Layer",
            options: { Ground: 0, Basement: 1 },
        });
        page.addBinding(this.params, "orientation", {
            label: "Rotation",
            min: 0,
            max: 3,
            step: 1,
        });

        const history = page.addFolder({ title: "History and selection", expanded: true });
        history.addButton({ title: "Undo (Ctrl+Z)" }).on("click", () => {
            if (this.model.undo()) this.changed("Undo");
        });
        history.addButton({ title: "Redo (Ctrl+Y)" }).on("click", () => {
            if (this.model.redo()) this.changed("Redo");
        });
        history.addButton({ title: "Delete selected (Backspace)" }).on("click", () => {
            if (this.model.remove(this.model.selectedId)) this.changed("Deleted selection");
        });
        history.addButton({ title: "Clear layout" }).on("click", () => {
            this.model.clear();
            this.changed("Cleared layout");
        });

        const files = page.addFolder({ title: "JSON layout", expanded: true });
        files.addButton({ title: "Export JSON" }).on("click", () => this.exportJson());
        files.addButton({ title: "Import JSON" }).on("click", () => this.importJson());
        this.statusBinding = page.addBinding(this.params, "status", {
            label: "Status",
            readonly: true,
        });
        page.addBlade({
            view: "text",
            label: "Controls",
            parse: (value: string) => value,
            value: "Left click: place/select · arrows: move · R: rotate",
        });
    }

    get capturesGameplay(): boolean {
        return this.params.active;
    }

    update(input: InputHandler): void {
        if (!this.params.active) return;
        this.drawOverlay(input);
        if (this.pointerOverEditor(input.mousePos)) return;
        if (document.activeElement?.matches("input, select, textarea")) return;

        const control = input.keyDown(Key.Control);
        if (control && input.keyPressed(Key.Z)) {
            if (this.model.undo()) this.changed("Undo");
            return;
        }
        if (control && input.keyPressed(Key.Y)) {
            if (this.model.redo()) this.changed("Redo");
            return;
        }

        if (input.keyPressed(Key.R)) {
            if (this.params.tool === "Select" && this.model.selectedId) {
                const selected = this.selected();
                if (selected) {
                    this.model.update(selected.id, { ori: ((selected.ori + 1) % 4) as 0 | 1 | 2 | 3 });
                    this.changed("Rotated selection");
                }
            } else {
                this.params.orientation = (this.params.orientation + 1) % 4;
            }
        }

        if (input.keyPressed(Key.Backspace) || input.keyPressed(Key.Delete)) {
            if (this.model.remove(this.model.selectedId)) this.changed("Deleted selection");
        }

        if (this.params.tool === "Select") this.moveSelection(input);
        if (!input.mousePressed(MouseButton.Left)) return;

        const point = this.snappedWorld(input.mousePos);
        if (this.params.tool === "Place") {
            if (this.model.layout.objects.length >= GrayboxLayoutMaxObjects) {
                this.setStatus(`Layout limit is ${GrayboxLayoutMaxObjects} objects`);
                return;
            }
            const [kind, type] = this.params.palette.split(":") as [GrayboxLayoutObject["kind"], string];
            this.model.add({
                kind,
                type,
                x: point.x,
                y: point.y,
                ori: this.params.orientation as 0 | 1 | 2 | 3,
                layer: this.params.layer,
            });
            this.changed(`Placed ${type}`);
        } else {
            this.selectNearest(point);
        }
    }

    private moveSelection(input: InputHandler): void {
        const selected = this.selected();
        if (!selected) return;
        let dx = 0;
        let dy = 0;
        if (input.keyPressed(Key.Left)) dx--;
        if (input.keyPressed(Key.Right)) dx++;
        if (input.keyPressed(Key.Down)) dy--;
        if (input.keyPressed(Key.Up)) dy++;
        if (!dx && !dy) return;
        this.model.update(selected.id, {
            x: selected.x + dx * this.params.gridSize,
            y: selected.y + dy * this.params.gridSize,
        });
        this.changed("Moved selection");
    }

    private selectNearest(point: Vec2): void {
        let nearest: GrayboxLayoutObject | undefined;
        let distance = 4;
        for (const object of this.model.layout.objects) {
            const next = v2.distance(point, v2.create(object.x, object.y));
            if (next < distance) {
                distance = next;
                nearest = object;
            }
        }
        this.model.selectedId = nearest?.id ?? "";
        this.setStatus(nearest ? `Selected ${nearest.type}` : "Nothing selected");
    }

    private drawOverlay(input: InputHandler): void {
        const cursor = this.snappedWorld(input.mousePos);
        const grid = this.params.gridSize;
        for (let offset = -5; offset <= 5; offset++) {
            debugLines.addLine(
                v2.create(cursor.x + offset * grid, cursor.y - 5 * grid),
                v2.create(cursor.x + offset * grid, cursor.y + 5 * grid),
                0x3f6f78,
            );
            debugLines.addLine(
                v2.create(cursor.x - 5 * grid, cursor.y + offset * grid),
                v2.create(cursor.x + 5 * grid, cursor.y + offset * grid),
                0x3f6f78,
            );
        }

        for (const object of this.model.layout.objects) {
            const pos = v2.create(object.x, object.y);
            const selected = object.id === this.model.selectedId;
            if (object.kind === "obstacle") {
                const def = MapObjectDefs.typeToDefSafe(object.type);
                if (def?.type === "obstacle") {
                    debugLines.addCollider(
                        collider.transform(def.collision, pos, math.oriToRad(object.ori), 1),
                        selected ? 0x00ffff : 0x39ff88,
                        selected ? 0.18 : 0.05,
                    );
                }
            } else {
                const color = object.kind === "player_spawn"
                    ? 0x4aa3ff
                    : object.kind === "zombie_spawn"
                    ? 0xff4545
                    : 0xffdf45;
                debugLines.addCircle(pos, selected ? 1.5 : 1, color, selected ? 0.25 : 0.1);
            }
        }
        debugLines.addCircle(cursor, 0.25, 0xffffff, 0.35);
    }

    private snappedWorld(screen: Vec2): Vec2 {
        const point = this.game.m_camera.m_screenToPoint(screen);
        return v2.create(
            snapGrayboxCoordinate(point.x, this.params.gridSize),
            snapGrayboxCoordinate(point.y, this.params.gridSize),
        );
    }

    private pointerOverEditor(screen: Vec2): boolean {
        return !!document.elementFromPoint(screen.x, screen.y)?.closest("#ui-editor-top-right");
    }

    private selected(): GrayboxLayoutObject | undefined {
        return this.model.layout.objects.find((entry) => entry.id === this.model.selectedId);
    }

    private changed(message: string): void {
        this.model.layout.gridSize = this.params.gridSize;
        this.sync(serializeGrayboxLayout(this.model.layout));
        this.setStatus(`${message} · ${this.model.layout.objects.length} objects`);
    }

    private setStatus(status: string): void {
        this.params.status = status;
        this.statusBinding.refresh();
    }

    private exportJson(): void {
        const json = serializeGrayboxLayout(this.model.layout, true);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${this.model.layout.name || "indoor-layout"}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        this.setStatus(`Exported ${this.model.layout.objects.length} objects`);
    }

    private importJson(): void {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                this.model.importJson(await file.text());
                this.params.gridSize = this.model.layout.gridSize;
                this.changed(`Imported ${file.name}`);
            } catch (error) {
                this.setStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        input.click();
    }
}
