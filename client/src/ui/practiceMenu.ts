import { GameObjectDefs } from "../../../shared/defs/register.ts";
import {
    defaultPracticeBot,
    emptyPracticeStats,
    PracticeGuns,
    practiceGunName,
    PracticeKitItems,
    PracticeKitMaxCount,
    PracticeMaxGearLevel,
    PracticeMaxPackLevel,
    PracticeMelees,
    PracticeScopes,
    PracticeMaxArmor,
    PracticeMaxBotHealth,
    PracticeMaxBots,
    PracticeMaxReaction,
    PracticeMinBotHealth,
    PracticePlayerRespawnDelay,
    PracticeRandomGun,
    PracticeMaxRespawnDelay,
    type PracticeRespawnMode,
    PracticeRespawnModeLabels,
    PracticeRespawnModes,
    type PracticeBotSettings,
    type PracticeSettings,
    PracticeSliderMax,
    type PracticeStats,
    practiceWiggleToAdvanced,
    sanitizePracticeSettings,
} from "../../../shared/practice.ts";

const StorageKey = "practiceSettings";
const LayoutKey = "practiceMenuLayout";

interface PanelLayout {
    left: number;
    top: number;
    width: number;
    height: number;
}

const Css = `
#practice-menu {
  position: absolute; top: 24px; left: 24px;
  width: min(560px, calc(100vw - 32px)); height: min(720px, calc(100vh - 48px));
  min-width: 340px; min-height: 220px; max-width: calc(100vw - 8px); max-height: calc(100vh - 8px);
  overflow: auto; resize: both; box-sizing: border-box;
  background: rgba(16, 20, 24, 0.94); border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
  color: #e8ecef; font-family: "Barlow Condensed", "Roboto Condensed", sans-serif; font-size: 16px;
  padding: 14px 16px 16px; z-index: 1000; pointer-events: auto; display: none;
  box-shadow: 0 12px 40px rgba(0,0,0,0.55);
}
#practice-menu.is-open { display: block; }
#practice-menu h2 { margin: 0 0 2px; font-size: 24px; letter-spacing: 0.5px; }
#practice-menu .pm-drag {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: -14px -16px 6px; padding: 10px 16px 6px; cursor: move; user-select: none;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  position: sticky; top: -14px; z-index: 1; background: rgba(16, 20, 24, 0.98);
}
#practice-menu .pm-drag-hint { color: #6f7b82; font-size: 13px; }
#practice-menu .pm-sub { margin: 0 0 12px; color: #9aa6ad; font-size: 14px; }
#practice-menu .pm-respawn { color: #ffcf5a; font-size: 18px; margin: 0 0 10px; }
#practice-menu h3 { margin: 14px 0 8px; font-size: 15px; text-transform: uppercase; letter-spacing: 1px; color: #9aa6ad; }
#practice-menu .pm-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
#practice-menu .pm-row label { flex: 0 0 132px; color: #c9d1d6; }
#practice-menu .pm-row input[type=range] { flex: 1; accent-color: #6fbf73; }
#practice-menu .pm-row .pm-val { flex: 0 0 52px; text-align: right; font-variant-numeric: tabular-nums; }
#practice-menu select { flex: 1; background: #232a30; color: #e8ecef; border: 1px solid #3a444c; border-radius: 6px; padding: 4px 6px; font: inherit; }
#practice-menu .pm-count { display: flex; gap: 6px; }
#practice-menu .pm-count button, #practice-menu .pm-actions button {
  background: #2b343b; color: #e8ecef; border: 1px solid #3f4a52; border-radius: 6px;
  padding: 6px 14px; font: inherit; cursor: pointer;
}
#practice-menu .pm-count button.is-active { background: #3f7d44; border-color: #6fbf73; }
#practice-menu .pm-bot { border: 1px solid #333d44; border-radius: 8px; padding: 8px 10px; margin: 8px 0; background: rgba(255,255,255,0.03); }
#practice-menu .pm-bot-title { font-size: 17px; margin-bottom: 4px; }
#practice-menu details { margin: 4px 0 2px; }
#practice-menu summary { cursor: pointer; color: #9aa6ad; }
#practice-menu .pm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
#practice-menu .pm-actions .pm-apply { background: #3f7d44; border-color: #6fbf73; }
#practice-menu .pm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 12px; margin: 6px 0; }
#practice-menu .pm-grid label { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: #c9d1d6; }
#practice-menu input[type=number] { width: 64px; background: #232a30; color: #e8ecef; border: 1px solid #3a444c; border-radius: 6px; padding: 3px 6px; font: inherit; }
#practice-menu .pm-give { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#practice-menu .pm-give select { flex: 1 1 200px; }
#practice-menu .pm-give button { background: #2b343b; color: #e8ecef; border: 1px solid #3f4a52; border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer; }
#practice-menu .pm-note { color: #9aa6ad; font-size: 13px; margin: 2px 0 0; }
#practice-stats {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  background: rgba(0,0,0,0.45); border-radius: 6px; padding: 4px 12px; color: #fff;
  font-family: "Barlow Condensed", "Roboto Condensed", sans-serif; font-size: 16px;
  white-space: nowrap; pointer-events: none; z-index: 20; display: none;
  text-shadow: 0 1px 2px #000;
}
#practice-stats.is-visible { display: block; }
#practice-stats .pm-hint { color: #9aa6ad; margin-left: 10px; }
body.ui-practice-mode #ui-specops-hud,
body.ui-practice-mode #ui-specops-phase,
body.ui-practice-mode #ui-specops-contract,
body.ui-practice-mode #ui-specops-shop,
body.ui-practice-mode #ui-specops-cash,
body.ui-practice-mode #ui-specops-buyback,
body.ui-practice-mode #ui-specops-support,
body.ui-practice-mode #ui-specops-wait {
  display: none !important;
}
`;

/** Item categories offered by "Give item", in menu order. */
const GiveCategories: Array<[string, string]> = [
    ["gun", "Guns"],
    ["melee", "Melee"],
    ["throwable", "Throwables"],
    ["heal", "Healing"],
    ["boost", "Boosts"],
    ["ammo", "Ammo"],
    ["scope", "Scopes"],
    ["helmet", "Helmets"],
    ["chest", "Vests"],
    ["backpack", "Backpacks"],
];

function itemLabel(type: string): string {
    const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
    return def?.name ? `${def.name} (${type})` : type;
}

/** Every item you can give yourself, grouped by category. */
function giveItemGroups(): Array<{ label: string; items: string[] }> {
    const all = GameObjectDefs.getAllTypes().filter((type) => {
        const def = GameObjectDefs.typeToDefSafe(type);
        return !!def && "lootImg" in def;
    });
    return GiveCategories.map(([cat, label]) => ({
        label,
        items: all.filter((type) => GameObjectDefs.typeToDefSafe(type)?.type === cat),
    })).filter((g) => g.items.length > 0);
}

const KitItemLabels: Record<string, string> = {
    bandage: "Bandages",
    healthkit: "Med kits",
    soda: "Sodas",
    painkiller: "Pills",
    frag: "Frags",
    smoke: "Smokes",
    mirv: "MIRVs",
};

function loadSettings(): PracticeSettings {
    try {
        const raw = localStorage.getItem(StorageKey);
        if (raw) return sanitizePracticeSettings(JSON.parse(raw));
    } catch {
        // Private mode or corrupt data: fall back to defaults.
    }
    return sanitizePracticeSettings(undefined);
}

function saveSettings(settings: PracticeSettings) {
    try {
        localStorage.setItem(StorageKey, JSON.stringify(settings));
    } catch {
        // Storage unavailable; settings just won't be remembered.
    }
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Practice mode panel (Tab key). Opens on its own when the match starts and when
 * you die, so you can change your loadout before respawning.
 */
export class PracticeMenu {
    open = false;
    settings: PracticeSettings = loadSettings();
    private stats: PracticeStats = emptyPracticeStats();
    private root!: HTMLDivElement;
    private statsElem!: HTMLDivElement;
    private started = false;
    private dead = false;
    private respawnAt = 0;
    private respawnTimer = 0;

    private giveItem = "";
    private giveCount = 1;
    private resizeObserver?: ResizeObserver;
    private layoutSaveTimer = 0;

    constructor(
        private readonly send: (settings: PracticeSettings) => void,
        private readonly sendGive: (item: string, count: number, clear: boolean, respawnBots?: boolean) => void,
    ) {}

    init() {
        if (!document.getElementById("practice-menu-style")) {
            const style = el("style", { id: "practice-menu-style" });
            style.textContent = Css;
            document.head.appendChild(style);
        }
        document.getElementById("practice-menu")?.remove();
        document.getElementById("practice-stats")?.remove();

        this.root = el("div", { id: "practice-menu" });
        // Keep clicks and scrolling in the panel from reaching the game's input.
        this.root.addEventListener("mousedown", (e) => e.stopPropagation());
        this.root.addEventListener("wheel", (e) => e.stopPropagation());
        // Typing a number or picking from a list must not move or switch weapons.
        const stopKeys = (e: KeyboardEvent) => {
            // Tab always reaches the game so it can close the panel.
            if (e.keyCode === 9) return;
            const target = e.target as HTMLElement;
            if (target.tagName === "SELECT" || (target as HTMLInputElement).type === "number") {
                e.stopPropagation();
            }
        };
        this.root.addEventListener("keydown", stopKeys);
        this.root.addEventListener("keyup", stopKeys);
        // Buttons shouldn't keep focus, or game keys would go to them.
        this.root.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === "BUTTON") target.blur();
        });
        document.body.appendChild(this.root);
        this.restoreLayout();
        // Remember the size after the player resizes the panel (corner handle).
        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(() => {
                if (this.open) this.saveLayoutSoon();
            });
            this.resizeObserver.observe(this.root);
        }
        window.addEventListener("resize", this.onWindowResize);

        this.statsElem = el("div", { id: "practice-stats" });
        document.body.appendChild(this.statsElem);
        document.body.classList.add("ui-practice-mode");

        this.started = false;
        this.dead = false;
        this.stats = emptyPracticeStats();
        this.renderStats();
        this.statsElem.classList.add("is-visible");
        this.show();
    }

    destroy() {
        this.resizeObserver?.disconnect();
        window.removeEventListener("resize", this.onWindowResize);
        this.root?.remove();
        this.statsElem?.remove();
        window.clearInterval(this.respawnTimer);
        document.body.classList.remove("ui-practice-mode");
        this.open = false;
    }

    toggle() {
        if (this.open) this.hide();
        else this.show();
    }

    /* ── Drag / resize ─────────────────────────────────────────────────── */

    private startDrag(e: MouseEvent) {
        if (e.button !== 0) return;
        e.preventDefault();
        const rect = this.root.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        const move = (ev: MouseEvent) => {
            this.placeAt(ev.clientX - offsetX, ev.clientY - offsetY);
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            this.saveLayoutSoon();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    }

    /** Move the panel, keeping at least its header on screen. */
    private placeAt(left: number, top: number) {
        const w = this.root.offsetWidth || 400;
        const maxLeft = Math.max(0, window.innerWidth - Math.min(w, 120));
        const maxTop = Math.max(0, window.innerHeight - 48);
        this.root.style.left = `${Math.round(Math.min(Math.max(left, Math.min(0, 120 - w)), maxLeft))}px`;
        this.root.style.top = `${Math.round(Math.min(Math.max(top, 0), maxTop))}px`;
    }

    private readonly onWindowResize = () => {
        if (!this.open) return;
        const rect = this.root.getBoundingClientRect();
        this.placeAt(rect.left, rect.top);
    };

    private restoreLayout() {
        let layout: PanelLayout | undefined;
        try {
            const raw = localStorage.getItem(LayoutKey);
            if (raw) layout = JSON.parse(raw) as PanelLayout;
        } catch {
            // No saved layout.
        }
        if (layout && [layout.left, layout.top, layout.width, layout.height].every(Number.isFinite)) {
            this.root.style.width = `${Math.max(340, Math.min(layout.width, window.innerWidth - 8))}px`;
            this.root.style.height = `${Math.max(220, Math.min(layout.height, window.innerHeight - 8))}px`;
            this.placeAt(layout.left, layout.top);
        } else {
            // First time: centre it.
            const w = Math.min(560, window.innerWidth - 32);
            const h = Math.min(720, window.innerHeight - 48);
            this.placeAt((window.innerWidth - w) / 2, (window.innerHeight - h) / 2);
        }
    }

    private saveLayoutSoon() {
        window.clearTimeout(this.layoutSaveTimer);
        this.layoutSaveTimer = window.setTimeout(() => {
            const rect = this.root.getBoundingClientRect();
            if (rect.width <= 0) return;
            const layout: PanelLayout = {
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            };
            try {
                localStorage.setItem(LayoutKey, JSON.stringify(layout));
            } catch {
                // Not remembered; harmless.
            }
        }, 250);
    }

    show() {
        this.open = true;
        this.render();
        this.root.classList.add("is-open");
    }

    hide() {
        if (!this.started) return; // first setup must be applied
        this.open = false;
        this.root.classList.remove("is-open");
    }

    /** Called every frame with whether the local player is dead. */
    setDead(dead: boolean) {
        if (dead === this.dead) return;
        this.dead = dead;
        window.clearInterval(this.respawnTimer);
        if (dead) {
            this.respawnAt = performance.now() + PracticePlayerRespawnDelay * 1000;
            this.respawnTimer = window.setInterval(() => this.updateRespawnText(), 200);
            this.show();
        } else if (this.open && this.started) {
            this.hide();
        }
    }

    setStats(stats: PracticeStats) {
        this.stats = stats;
        this.renderStats();
    }

    /** True if a key press should toggle the panel (not while typing in a field). */
    static focusInField(): boolean {
        const active = document.activeElement;
        return !!active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)
            && !(active instanceof HTMLInputElement && active.type === "range");
    }

    private apply() {
        this.settings = sanitizePracticeSettings(this.settings);
        saveSettings(this.settings);
        this.send(this.settings);
        this.started = true;
        if (!this.dead) this.hide();
        else this.render();
    }

    private updateRespawnText() {
        const node = this.root.querySelector(".pm-respawn");
        if (!node) return;
        const left = Math.max(0, Math.ceil((this.respawnAt - performance.now()) / 1000));
        node.textContent = left > 0
            ? `Respawning in ${left}… change your kit below.`
            : "Respawning…";
    }

    private renderStats() {
        if (!this.statsElem) return;
        const st = this.stats;
        const acc = st.shotsFired > 0 ? Math.round((st.shotsHit / st.shotsFired) * 100) : 0;
        const ttk = (ms: number) => (ms > 0 ? `${(ms / 1000).toFixed(2)}s` : "—");
        this.statsElem.innerHTML = "";
        this.statsElem.append(
            `Bots ${st.botsAlive}/${st.botsTotal} · K ${st.kills} / D ${st.deaths} · Acc ${acc}%`
                + ` · Dmg ${st.damageDealt} dealt / ${st.damageTaken} taken`
                + ` · TTK ${ttk(st.ttkAvgMs)} (best ${ttk(st.ttkBestMs)})`,
            el("span", { class: "pm-hint" }, "Tab: practice menu"),
        );
    }

    private render() {
        const root = this.root;
        root.innerHTML = "";
        const header = el("div", { class: "pm-drag", title: "Drag to move · resize from the bottom-right corner" });
        header.append(el("h2", {}, "Practice"), el("span", { class: "pm-drag-hint" }, "drag to move"));
        header.addEventListener("mousedown", (e) => this.startDrag(e));
        root.append(header);
        root.append(el("p", { class: "pm-sub" }, this.started
            ? "Change bots or your kit. Bots restart only when their settings change."
            : "Set up your bots and loadout, then start."));
        if (this.dead) {
            root.append(el("p", { class: "pm-respawn" }));
            this.updateRespawnText();
        }

        root.append(el("h3", {}, "PRESETS"));
        root.append(this.gunRow("Primary", this.settings.primary, false, false, (v) => {
            this.settings.primary = v;
        }));
        root.append(this.gunRow("Secondary", this.settings.secondary, false, true, (v) => {
            this.settings.secondary = v;
        }));
        this.renderKit(root);
        this.renderGive(root);

        root.append(el("h3", {}, "Bots"));
        const countRow = el("div", { class: "pm-row" });
        countRow.append(el("label", {}, "How many"));
        const count = el("div", { class: "pm-count" });
        for (let n = 1; n <= PracticeMaxBots; n++) {
            const btn = el("button", { type: "button" }, String(n));
            if (n === this.settings.bots.length) btn.classList.add("is-active");
            btn.addEventListener("click", () => this.setBotCount(n));
            count.append(btn);
        }
        countRow.append(count);
        root.append(countRow);
        this.renderRespawn(root);

        this.settings.bots.forEach((bot, i) => root.append(this.botCard(bot, i)));

        const actions = el("div", { class: "pm-actions" });
        if (this.started && !this.dead) {
            const close = el("button", { type: "button" }, "Close");
            close.addEventListener("click", () => this.hide());
            actions.append(close);
        }
        const apply = el(
            "button",
            { type: "button", class: "pm-apply" },
            this.started ? (this.dead ? "Save kit" : "Apply") : "Start",
        );
        apply.addEventListener("click", () => this.apply());
        actions.append(apply);
        root.append(actions);
    }

    private renderKit(root: HTMLElement) {
        const kit = this.settings.kit;

        const meleeRow = el("div", { class: "pm-row" });
        meleeRow.append(el("label", {}, "Melee"));
        const melee = el("select");
        for (const type of PracticeMelees) melee.append(el("option", { value: type }, itemLabel(type)));
        melee.value = kit.melee;
        melee.addEventListener("change", () => {
            kit.melee = melee.value;
        });
        meleeRow.append(melee);
        root.append(meleeRow);

        const level = (v: number) => (v === 0 ? "None" : `Lv ${v}`);
        root.append(this.slider("Helmet", kit.helmet, 0, PracticeMaxGearLevel, level, (v) => {
            kit.helmet = v;
        }));
        root.append(this.slider("Vest", kit.vest, 0, PracticeMaxGearLevel, level, (v) => {
            kit.vest = v;
        }));
        root.append(this.slider("Backpack", kit.backpack, 0, PracticeMaxPackLevel, (v) => `Lv ${v}`, (v) => {
            kit.backpack = v;
        }));

        const scopeRow = el("div", { class: "pm-row" });
        scopeRow.append(el("label", {}, "Scope"));
        const scope = el("select");
        for (const type of PracticeScopes) scope.append(el("option", { value: type }, type.replace("scope", "")));
        scope.value = kit.scope;
        scope.addEventListener("change", () => {
            kit.scope = scope.value;
        });
        scopeRow.append(scope);
        root.append(scopeRow);

        const grid = el("div", { class: "pm-grid" });
        for (const item of PracticeKitItems) {
            const label = el("label", {}, KitItemLabels[item] ?? item);
            const input = el("input", {
                type: "number",
                min: "0",
                max: String(PracticeKitMaxCount),
                step: "1",
            });
            input.value = String(kit.counts[item]);
            input.addEventListener("change", () => {
                const n = Math.max(0, Math.min(PracticeKitMaxCount, Math.round(Number(input.value) || 0)));
                kit.counts[item] = n;
                input.value = String(n);
            });
            label.append(input);
            grid.append(label);
        }
        root.append(grid);

        const ammoRow = el("div", { class: "pm-row" });
        ammoRow.append(el("label", {}, "Full ammo"));
        const ammo = el("input", { type: "checkbox" });
        ammo.checked = kit.fillAmmo;
        ammo.addEventListener("change", () => {
            kit.fillAmmo = ammo.checked;
        });
        ammoRow.append(ammo);
        root.append(ammoRow);
    }

    private renderRespawn(root: HTMLElement) {
        const modeRow = el("div", { class: "pm-row" });
        modeRow.append(el("label", {}, "Bots respawn"));
        const mode = el("select");
        for (const m of PracticeRespawnModes) {
            mode.append(el("option", { value: m }, PracticeRespawnModeLabels[m]));
        }
        mode.value = this.settings.respawnMode;
        modeRow.append(mode);
        root.append(modeRow);

        const delay = this.slider(
            "Respawn delay",
            this.settings.respawnDelay,
            0,
            PracticeMaxRespawnDelay,
            (v) => `${(v / 10).toFixed(1)}s`,
            (v) => {
                this.settings.respawnDelay = v;
            },
        );
        root.append(delay);

        const syncDelay = () => {
            // No delay to set when bots only come back on the button.
            delay.style.opacity = this.settings.respawnMode === "off" ? "0.4" : "1";
        };
        mode.addEventListener("change", () => {
            this.settings.respawnMode = mode.value as PracticeRespawnMode;
            syncDelay();
        });
        syncDelay();

        const nowRow = el("div", { class: "pm-row" });
        nowRow.append(el("label", {}, ""));
        const now = el("button", { type: "button" }, "Respawn bots now");
        now.style.cssText = "background:#2b343b;color:#e8ecef;border:1px solid #3f4a52;border-radius:6px;"
            + "padding:6px 12px;font:inherit;cursor:pointer;";
        now.addEventListener("click", () => this.sendGive("", 1, false, true));
        nowRow.append(now);
        root.append(nowRow);
        root.append(el("p", { class: "pm-note" }, "Respawn mode and delay apply with Apply; bots already alive stay."));
    }

    private renderGive(root: HTMLElement) {
        root.append(el("h3", {}, "SPAWN ITEM"));
        const row = el("div", { class: "pm-give" });
        const select = el("select");
        for (const group of giveItemGroups()) {
            const optgroup = el("optgroup", { label: group.label });
            for (const type of group.items) optgroup.append(el("option", { value: type }, itemLabel(type)));
            select.append(optgroup);
        }
        if (this.giveItem) select.value = this.giveItem;
        this.giveItem = select.value;
        select.addEventListener("change", () => {
            this.giveItem = select.value;
        });

        const count = el("input", { type: "number", min: "1", max: "999", step: "1", title: "How many" });
        count.value = String(this.giveCount);
        count.addEventListener("change", () => {
            this.giveCount = Math.max(1, Math.min(999, Math.round(Number(count.value) || 1)));
            count.value = String(this.giveCount);
        });

        const give = el("button", { type: "button" }, "Give");
        give.addEventListener("click", () => this.sendGive(this.giveItem, this.giveCount, false));
        const clear = el("button", { type: "button" }, "Clear inventory");
        clear.addEventListener("click", () => this.sendGive("", 1, true));

        row.append(select, count, give, clear);
        root.append(row);
    }

    private setBotCount(n: number) {
        const bots = this.settings.bots.slice(0, n);
        while (bots.length < n) {
            const last = bots[bots.length - 1];
            bots.push(last ? { ...last } : defaultPracticeBot());
        }
        this.settings.bots = bots;
        this.render();
    }

    private gunRow(
        label: string,
        value: string,
        allowRandom: boolean,
        allowNone: boolean,
        onChange: (v: string) => void,
    ): HTMLDivElement {
        const row = el("div", { class: "pm-row" });
        row.append(el("label", {}, label));
        const select = el("select");
        if (allowNone) select.append(el("option", { value: "" }, "None"));
        if (allowRandom) select.append(el("option", { value: PracticeRandomGun }, "Random"));
        for (const gun of PracticeGuns) {
            select.append(el("option", { value: gun }, practiceGunName(gun)));
        }
        select.value = value;
        select.addEventListener("change", () => onChange(select.value));
        row.append(select);
        return row;
    }

    private slider(
        label: string,
        value: number,
        min: number,
        max: number,
        format: (v: number) => string,
        onChange: (v: number) => void,
    ): HTMLDivElement {
        const row = el("div", { class: "pm-row" });
        row.append(el("label", {}, label));
        const input = el("input", {
            type: "range",
            min: String(min),
            max: String(max),
            step: "1",
        });
        input.value = String(value);
        const val = el("span", { class: "pm-val" }, format(value));
        input.addEventListener("input", () => {
            const v = Number(input.value);
            val.textContent = format(v);
            onChange(v);
        });
        row.append(input, val);
        return row;
    }

    private botCard(bot: PracticeBotSettings, index: number): HTMLDivElement {
        const card = el("div", { class: "pm-bot" });
        card.append(el("div", { class: "pm-bot-title" }, `Bot ${index + 1}`));
        card.append(this.gunRow("Gun", bot.gun, true, false, (v) => {
            bot.gun = v;
        }));

        const plain = (v: number) => String(v);
        const advanced = el("details");
        const strafe = this.slider("Strafe speed", bot.strafe, 0, PracticeSliderMax, plain, (v) => {
            bot.strafe = v;
        });
        const turn = this.slider("Direction change", bot.turn, 0, PracticeSliderMax, plain, (v) => {
            bot.turn = v;
        });
        const dodge = this.slider("Aim dodging", bot.dodge, 0, PracticeSliderMax, plain, (v) => {
            bot.dodge = v;
        });

        card.append(this.slider("Wiggle", bot.wiggle, 0, PracticeSliderMax, plain, (v) => {
            bot.wiggle = v;
            Object.assign(bot, practiceWiggleToAdvanced(v));
            // Move the advanced sliders to match.
            const sync = (row: HTMLDivElement, value: number) => {
                const input = row.querySelector("input")!;
                input.value = String(value);
                row.querySelector(".pm-val")!.textContent = String(value);
            };
            sync(strafe, bot.strafe);
            sync(turn, bot.turn);
            sync(dodge, bot.dodge);
        }));

        advanced.append(el("summary", {}, "Advanced movement"), strafe, turn, dodge);
        card.append(advanced);

        card.append(this.slider("Accuracy", bot.accuracy, 0, 100, (v) => `${v}%`, (v) => {
            bot.accuracy = v;
        }));
        card.append(
            this.slider("Reaction time", bot.reaction, 0, PracticeMaxReaction, (v) => `${(v / 10).toFixed(1)}s`, (v) => {
                bot.reaction = v;
            }),
        );
        card.append(
            this.slider("Health", bot.health, PracticeMinBotHealth, PracticeMaxBotHealth, plain, (v) => {
                bot.health = v;
            }),
        );
        card.append(
            this.slider("Armor level", bot.armor, 0, PracticeMaxArmor, (v) => (v === 0 ? "None" : `Lv ${v}`), (v) => {
                bot.armor = v;
            }),
        );

        const fireRow = el("div", { class: "pm-row" });
        fireRow.append(el("label", {}, "Shoots back"));
        const fire = el("input", { type: "checkbox" });
        fire.checked = bot.shootsBack;
        fire.addEventListener("change", () => {
            bot.shootsBack = fire.checked;
        });
        fireRow.append(fire);
        card.append(fireRow);
        return card;
    }
}
