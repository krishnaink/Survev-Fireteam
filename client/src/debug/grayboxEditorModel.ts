import {
    createGrayboxLayout,
    type GrayboxLayout,
    type GrayboxLayoutObject,
    parseGrayboxLayout,
    serializeGrayboxLayout,
} from "../../../shared/debug/grayboxLayout.ts";

export class GrayboxEditorModel {
    layout: GrayboxLayout;
    selectedId = "";
    private undoStack: string[] = [];
    private redoStack: string[] = [];
    private nextId = 1;

    constructor(mapName = "specops") {
        this.layout = createGrayboxLayout(mapName);
    }

    private snapshot() {
        this.undoStack.push(serializeGrayboxLayout(this.layout));
        if (this.undoStack.length > 100) this.undoStack.shift();
        this.redoStack.length = 0;
    }

    add(object: Omit<GrayboxLayoutObject, "id">): GrayboxLayoutObject {
        this.snapshot();
        const result = { ...object, id: `layout-${this.nextId++}` };
        this.layout.objects.push(result);
        this.selectedId = result.id;
        return result;
    }

    update(id: string, changes: Partial<Omit<GrayboxLayoutObject, "id">>): boolean {
        const object = this.layout.objects.find((entry) => entry.id === id);
        if (!object) return false;
        this.snapshot();
        Object.assign(object, changes);
        return true;
    }

    remove(id: string): boolean {
        const index = this.layout.objects.findIndex((entry) => entry.id === id);
        if (index < 0) return false;
        this.snapshot();
        this.layout.objects.splice(index, 1);
        if (this.selectedId === id) this.selectedId = "";
        return true;
    }

    clear(): void {
        if (!this.layout.objects.length) return;
        this.snapshot();
        this.layout.objects = [];
        this.selectedId = "";
    }

    importJson(json: string): void {
        const next = parseGrayboxLayout(json);
        this.snapshot();
        this.layout = next;
        this.selectedId = "";
        this.nextId = next.objects.reduce((max, entry) => {
            const id = Number(entry.id.replace(/^layout-/, ""));
            return Number.isFinite(id) ? Math.max(max, id + 1) : max;
        }, 1);
    }

    undo(): boolean {
        const json = this.undoStack.pop();
        if (!json) return false;
        this.redoStack.push(serializeGrayboxLayout(this.layout));
        this.layout = parseGrayboxLayout(json);
        this.selectedId = "";
        return true;
    }

    redo(): boolean {
        const json = this.redoStack.pop();
        if (!json) return false;
        this.undoStack.push(serializeGrayboxLayout(this.layout));
        this.layout = parseGrayboxLayout(json);
        this.selectedId = "";
        return true;
    }
}
