import type { ScoreboardEntry } from "../../../shared/net/updateMsg.ts";

export interface ScoreboardNames {
    /** Display name for a player id. */
    nameOf(playerId: number): string;
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

const money = (n: number) => `$${Math.max(0, Math.floor(n)).toLocaleString("en-US")}`;

/**
 * Hold-Tab squad scoreboard (Spec Ops). Translucent, click-through overlay that
 * lists each operator's kills, downs, revives and total cash earned.
 */
export class Scoreboard {
    private readonly root = el("div", "sb-root");
    private readonly title = el("div", "sb-title");
    private readonly body = el("div", "sb-body");
    private visible = false;
    private lastRows: ScoreboardEntry[] | null = null;
    private lastKey = "";

    constructor() {
        const header = el("div", "sb-header");
        header.append(this.title);
        for (const label of ["Kills", "Downs", "Revives", "Cash"]) {
            header.append(el("div", "sb-col", label));
        }
        this.root.append(header, this.body);
        this.root.style.display = "none";
        document.body.appendChild(this.root);
    }

    get isVisible() {
        return this.visible;
    }

    setVisible(v: boolean) {
        if (v === this.visible) return;
        this.visible = v;
        this.root.style.display = v ? "block" : "none";
    }

    /** Re-renders only when the data or header actually changed. */
    update(
        rows: ScoreboardEntry[],
        localId: number,
        names: ScoreboardNames,
        wave: number,
    ) {
        const title = wave >= 0 ? `Survival - Wave ${wave}` : "Survival";
        const key = `${title}|${localId}|${rows.map((r) =>
            `${r.playerId}:${names.nameOf(r.playerId)}:${r.kills}:${r.downs}:${r.revives}:${r.cashEarned}`
        ).join(",")}`;
        if (rows === this.lastRows && key === this.lastKey) return;
        if (key === this.lastKey) {
            this.lastRows = rows;
            return;
        }
        this.lastRows = rows;
        this.lastKey = key;
        this.title.textContent = title;

        const sorted = [...rows].sort((a, b) => b.kills - a.kills || a.playerId - b.playerId);
        this.body.replaceChildren();
        for (const r of sorted) {
            const row = el("div", r.playerId === localId ? "sb-row sb-row-local" : "sb-row");
            row.append(el("div", "sb-name", names.nameOf(r.playerId) || `Player ${r.playerId}`));
            row.append(el("div", "sb-col", String(r.kills)));
            row.append(el("div", "sb-col", String(r.downs)));
            row.append(el("div", "sb-col", String(r.revives)));
            row.append(el("div", "sb-col sb-cash", money(r.cashEarned)));
            this.body.append(row);
        }
    }

    destroy() {
        this.root.remove();
    }
}
