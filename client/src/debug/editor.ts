import $ from "jquery";
import { type FolderApi, Pane, type TabPageApi } from "tweakpane";

import { RoleDefs } from "../../../shared/defs/gameObjects/roleDefs.ts";
import {
    SpecOpsAllyRoles,
    SpecOpsEnemyClasses,
    SpecOpsNpcSpawnKinds,
} from "../../../shared/defs/maps/specOpsNpcDebug.ts";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { EditMsg } from "../../../shared/net/editMsg.ts";
import { math } from "../../../shared/utils/math.ts";
import { util } from "../../../shared/utils/util.ts";
import {
    type ConfigKey,
    type ConfigManager,
    type ConfigType,
    debugHUDConfig,
    debugRenderConfig,
    type debugToolsConfig,
} from "../config.ts";
import { type InputHandler, Key } from "../input.ts";

const availableLoot = GameObjectDefs.getAllTypes()
    .filter((type) => !!("lootImg" in GameObjectDefs.typeToDef(type)));

const invalidRoleTypes = ["kill_leader"];

const availableRoles = Object.entries(RoleDefs)
    .filter(([type]) => !invalidRoleTypes.includes(type))
    .reduce(
        (obj, [type]) => {
            obj[type] = type;
            return obj;
        },
        {} as Record<string, string>,
    );

availableRoles["None"] = "";

function camelCaseToText(str: string) {
    return str
        .replace(/([A-Z])/g, " $1")
        .split(" ")
        .map((s) => {
            return `${s.charAt(0).toUpperCase()}${s.substring(1)}`;
        })
        .join(" ");
}

export class Editor {
    toolParams: typeof debugToolsConfig;
    renderParams: typeof debugRenderConfig;
    debugHUDParams: typeof debugHUDConfig;

    config: ConfigManager;
    pane: Pane;

    zoomBind: ReturnType<Pane["addBinding"]>;

    enabled = false;

    loadNewMap = false;
    spawnLoot = false;
    promoteToRole = false;
    toggleLayer = false;

    printLootStats = false;

    sendMsg = false;
    spawnNpc = false;
    spawnNpcOneOfEach = false;

    specOpsNpcSpawn = false;
    botArenaMode = false;
    /** Server allowEditMsg / NPC spawn debug. Editor stays closed when false. */
    debugAllowed = false;

    // Cheat one-shot flags
    sendCheatGive = true;
    sendCheatHealth = true;
    sendCheatWave = true;

    constructor(config: ConfigManager) {
        this.config = config;
        this.config.addModifiedListener(this.onConfigModified.bind(this));

        this.toolParams = this.config.get("debugTools")!;
        this.toolParams.role = "";
        if (!this.toolParams.spawnNpcKind) {
            this.toolParams.spawnNpcKind = "enemy";
        }

        this.renderParams = this.config.get("debugRenderer")!;
        this.debugHUDParams = this.config.get("debugHUD")!;

        const container = document.getElementById(
            "ui-editor-top-right",
        ) as HTMLDivElement;

        this.pane = new Pane({
            container,
            expanded: true,
            title: "Editor",
        });

        const pane = this.pane;

        const tabs = pane.addTab({
            pages: [
                {
                    title: "Tools",
                },
                {
                    title: "Render",
                },
                {
                    title: "HUD",
                },
                {
                    title: "Players",
                },
                {
                    title: "Cheats",
                },
            ],
        });
        const [tools, render, HUD, players, cheats] = tabs.pages;

        //
        // Tools
        //

        const addSlider = (
            key: keyof Editor["toolParams"],
            enabledKey: keyof Editor["toolParams"],
            expanded = true,
            min = 1,
            max = 255,
            step = 1,
        ) => {
            const folder = tools.addFolder({
                title: key,
                expanded,
            });
            folder.on("change", () => {
                this.sendMsg = true;
                this.config.set("debugTools", this.toolParams);
            });

            folder.addBinding(this.toolParams, enabledKey, {
                label: "Enabled",
            });

            return folder.addBinding(this.toolParams, key, {
                label: `${key.charAt(0).toUpperCase()}${key.substring(1)}`,
                min,
                max,
                step,
            });
        };
        this.zoomBind = addSlider("zoom", "zoomEnabled");
        addSlider("speed", "speedEnabled");

        addSlider("gameSpeed", "gameSpeedEnabled", false, 0.01, 10, 0.01);

        // Loot
        {
            const folder = tools.addFolder({
                title: "Loot",
            });

            const loot = folder.addBinding(this.toolParams, "loot", {
                label: "Type",
            });
            const input = loot.element.querySelector("input") as HTMLInputElement;

            // don't want to trigger keybinds (like L to fullscreen) while typing
            input.addEventListener("keyup", (e) => e.stopPropagation());
            input.addEventListener("keydown", (e) => {
                e.stopPropagation();

                if (e.key == "Enter" && availableLoot.includes(input.value)) {
                    this.spawnLoot = true;
                    this.sendMsg = true;
                    this.config.set("debugTools", this.toolParams);
                }
            });
            const button = folder.addButton({
                title: "Spawn",
            });
            button.on("click", () => {
                if (availableLoot.includes(input.value)) {
                    this.spawnLoot = true;
                    this.sendMsg = true;
                    this.config.set("debugTools", this.toolParams);
                }
            });

            const dataList = document.createElement("datalist");
            dataList.id = "editor-loot-list";
            input.setAttribute("list", dataList.id);

            input.parentElement?.appendChild(dataList);
            for (const loot of availableLoot) {
                const opt = document.createElement("option");
                opt.value = loot;
                dataList.appendChild(opt);
            }
        }

        // Map
        {
            const folder = tools.addFolder({
                title: "Map",
                expanded: true,
            });
            const input = folder.addBinding(this.toolParams, "mapSeed", {
                label: "Seed",
                step: 1,
                format: (n) => {
                    return math.clamp(Math.floor(n), 1, 2 ** 32 - 1);
                },
            });

            const generate = folder.addButton({
                title: "Generate",
            });

            generate.on("click", () => {
                this.loadNewMap = true;
                this.sendMsg = true;
            });

            const random = folder.addButton({
                title: "Random",
            });
            random.on("click", () => {
                this.toolParams.mapSeed = util.randomInt(1, 2 ** 32 - 1);
                this.loadNewMap = true;
                this.sendMsg = true;
                input.refresh();
            });
        }

        // Roles
        {
            const folder = tools.addFolder({
                title: "Role",
                expanded: false,
            });
            folder.addBinding(this.toolParams, "role", {
                options: availableRoles,
                label: "Role",
            });

            const button = folder.addButton({
                title: "Promote",
            });
            button.on("click", () => {
                this.sendMsg = true;
                this.promoteToRole = true;
            });
        }

        {
            const folder = tools.addFolder({
                title: "Toggles",
            });

            folder.addBinding(this.toolParams, "noClip", {
                label: "No Clip",
            });
            folder.addBinding(this.toolParams, "teleportToPings", {
                label: "Teleport To Pings",
            });
            folder.addBinding(this.toolParams, "godMode", {
                label: "God Mode",
            });
            folder.addBinding(this.toolParams, "moveObjs", {
                label: "Move Objects",
            });
            folder.addBinding(this.toolParams, "preventGameStart", {
                label: "Prevent Game Start",
            });
            folder.on("change", () => {
                this.sendMsg = true;
                this.config.set("debugTools", this.toolParams);
            });

            const toggleLayer = folder.addButton({
                title: "Switch Layers",
            });

            toggleLayer.on("click", () => {
                this.toggleLayer = true;
                this.sendMsg = true;
            });
        }
        //
        // Renderer
        //

        const addObject = (
            // we pass both the default config object
            // and the one we actually write to / loaded from local storage
            // because if we always pass the one from LS to it may have keys that have been deleted
            // and i dont want it to spam a bunch of deleted keys specially during development where
            // i end up renaming keys a lot before deciding their final name :)
            defaultObj: Record<string, unknown>,
            outObj: Record<string, unknown>,
            parentObj: Record<string, unknown>,
            folder: FolderApi | TabPageApi,
            configKey: ConfigKey,
        ) => {
            for (const key in defaultObj) {
                const entry = defaultObj[key];

                if (typeof entry === "object") {
                    const folder2 = folder.addFolder({
                        title: camelCaseToText(key),
                        expanded: true,
                    });
                    addObject(
                        entry as Record<string, unknown>,
                        outObj[key] as Record<string, unknown>,
                        parentObj,
                        folder2,
                        configKey,
                    );
                } else if (typeof entry === "boolean") {
                    const label = camelCaseToText(key);

                    const bind = folder.addBinding(outObj, key, {
                        label,
                    });
                    bind.on("change", () => {
                        this.config.set(configKey, parentObj as ConfigType[ConfigKey]);
                    });
                }
            }
        };
        addObject(
            debugRenderConfig,
            this.renderParams,
            this.renderParams,
            render,
            "debugRenderer",
        );

        //
        // HUD
        //

        addObject(
            debugHUDConfig,
            this.debugHUDParams,
            this.debugHUDParams,
            HUD,
            "debugHUD",
        );

        {
            const folder = players.addFolder({
                title: "Spec Ops NPCs",
                expanded: true,
            });
            folder.addBinding(this.toolParams, "spawnNpcKind", {
                label: "Kind",
                options: Object.fromEntries(
                    SpecOpsNpcSpawnKinds.map((kind) => [kind, kind]),
                ),
            });
            folder.addBinding(this.toolParams, "spawnNpcType", {
                label: "Type",
                options: Object.fromEntries([
                    ...SpecOpsEnemyClasses.map((kind) => [kind, kind]),
                    ...SpecOpsAllyRoles.map((role) => [role, role]),
                ]),
            });
            folder.addBinding(this.toolParams, "spawnNpcCount", {
                label: "Count",
                min: 1,
                max: 32,
                step: 1,
            });
            folder.addBinding(this.toolParams, "npcIgnoreOperators", {
                label: "NPCs ignore you",
            });
            const spawnBtn = folder.addButton({ title: "Spawn" });
            spawnBtn.on("click", () => {
                this.spawnNpc = true;
                this.sendMsg = true;
            });
            const spawnAllBtn = folder.addButton({ title: "Spawn one of each" });
            spawnAllBtn.on("click", () => {
                this.spawnNpcOneOfEach = true;
                this.sendMsg = true;
            });
            folder.on("change", () => {
                this.config.set("debugTools", this.toolParams);
                this.sendMsg = true;
            });
        }
        players.element.style.display = "none";
        this.playersTab = players;

        //
        // Quick Add
        //
        {
            // // Give item
            // const giveFolder = cheats.addFolder({ title: "Give Item", expanded: true });

            // const giveItemBind = giveFolder.addBinding(this.toolParams, "cheatGiveItem", {
            //     label: "Item type",
            // });
            // const giveInput = giveItemBind.element.querySelector("input") as HTMLInputElement;
            // giveInput.addEventListener("keyup", (e) => e.stopPropagation());
            // giveInput.addEventListener("keydown", (e) => {
            //     e.stopPropagation();
            //     if (e.key === "Enter") {
            //         this.sendCheatGive = true;
            //         this.sendMsg = true;
            //         this.config.set("debugTools", this.toolParams);
            //     }
            // });

            // // Autocomplete datalist for all loot items
            // const giveDL = document.createElement("datalist");
            // giveDL.id = "editor-cheat-give-list";
            // giveInput.setAttribute("list", giveDL.id);
            // giveInput.parentElement?.appendChild(giveDL);
            // for (const lt of availableLoot) {
            //     const opt = document.createElement("option");
            //     opt.value = lt;
            //     giveDL.appendChild(opt);
            // }

            // giveFolder.addBinding(this.toolParams, "cheatGiveCount", {
            //     label: "Count",
            //     min: 1,
            //     max: 999,
            //     step: 1,
            // });

            // const giveBtn = giveFolder.addButton({ title: "Give" });
            // giveBtn.on("click", () => {
            //     this.sendCheatGive = true;
            //     this.sendMsg = true;
            //     this.config.set("debugTools", this.toolParams);
            // });

            // Quick-give buttons for common consumables
            const quickFolder = cheats.addFolder({ title: "Quick Fill", expanded: true });
            const addQuick = (label: string, item: string, count: number) => {
                const btn = quickFolder.addButton({ title: label });
                btn.on("click", () => {
                    this.toolParams.cheatGiveItem = item;
                    this.toolParams.cheatGiveCount = count;
                    this.sendCheatGive = true;
                    this.sendMsg = true;
                    this.config.set("debugTools", this.toolParams);
                });
            };
            addQuick("Max frags", "frag", 9);
            addQuick("Max strobes", "strobe", 5);
            addQuick("Max mirv", "mirv", 9);
            addQuick("Fill bandages", "bandage", 10);
            addQuick("Fill medkits", "healthkit", 3);
            addQuick("Fill soda", "soda", 10);
            addQuick("Fill painkillers", "painkiller", 4);
            addQuick("Fill 9mm", "9mm", 999);
            addQuick("Fill 5.56mm", "556mm", 999);
            addQuick("Fill 7.62mm", "762mm", 999);
            addQuick("Fill 12ga", "12gauge", 90);

            // Health
            const hpFolder = cheats.addFolder({ title: "Health", expanded: true });
            hpFolder.addBinding(this.toolParams, "cheatSetHealth", {
                label: "HP",
                min: 1,
                max: 200,
                step: 1,
            });
            const hpBtn = hpFolder.addButton({ title: "Set HP" });
            hpBtn.on("click", () => {
                this.sendCheatHealth = true;
                this.sendMsg = true;
                this.config.set("debugTools", this.toolParams);
            });
            const fullHpBtn = hpFolder.addButton({ title: "Full HP" });
            fullHpBtn.on("click", () => {
                this.toolParams.cheatSetHealth = 200;
                this.sendCheatHealth = true;
                this.sendMsg = true;
            });

            // Wave jump
            const waveFolder = cheats.addFolder({ title: "Wave Jump (Spec Ops)", expanded: true });
            waveFolder.addBinding(this.toolParams, "cheatSetWave", {
                label: "Wave",
                min: 1,
                max: 99,
                step: 1,
            });
            const waveBtn = waveFolder.addButton({ title: "Jump to Wave" });
            waveBtn.on("click", () => {
                this.sendCheatWave = true;
                this.sendMsg = true;
                this.config.set("debugTools", this.toolParams);
            });

            // Prevent cheat panel clicks from firing game inputs
            cheats.element.querySelectorAll<HTMLElement>("input, button").forEach((el) => {
                el.addEventListener("click", () => el.blur());
                el.addEventListener("keyup", (e) => e.stopPropagation());
                el.addEventListener("keydown", (e) => e.stopPropagation());
            });
        }
        this.cheatsTab = cheats;

        // we dont want to focus buttons because they can mess with keybinds
        // like if you click on "toggle layer" and dont click on anything else
        // the button will remain focused and will activate if you press enter or space
        pane.element
            .querySelectorAll<HTMLElement>(`input[type="checkbox"], button`)
            .forEach((elm) => {
                elm.addEventListener("click", () => {
                    elm.blur();
                });
            });
        // dont let those events reach the game input handler
        // firing a gun while clicking on an editor button is annoying
        for (const event of ["wheel", "mousedown"]) {
            pane.element.addEventListener(event, (e) => {
                e.stopPropagation();
            });
        }

        this.setEnabled(false);
    }

    /** HUD bits hidden only while the editor is open (top-right clutter in BR). */
    private setEditorHudHidden(hidden: boolean) {
        $("#ui-leaderboard-wrapper,#ui-kill-leader-container").css(
            "display",
            hidden ? "none" : "",
        );
    }

    playersTab!: TabPageApi;
    cheatsTab!: TabPageApi;

    setDebugAllowed(enabled: boolean) {
        this.debugAllowed = enabled;
        if (!enabled) {
            this.setEnabled(false);
        }
    }

    setSpecOpsNpcSpawn(enabled: boolean) {
        this.specOpsNpcSpawn = enabled;
        this.refreshUi();
    }

    setBotArenaMode(enabled: boolean) {
        this.botArenaMode = enabled;
        this.refreshUi();
    }

    onConfigModified(_key?: string) {
        this.refreshUi();
    }

    setEnabled(e: boolean) {
        if (e && !this.debugAllowed) {
            e = false;
        }
        this.enabled = e;
        if (e) {
            this.pane.expanded = true;
        }
        this.refreshUi();
        if (e) this.sendMsg = true;

        this.toolParams.enabled = e;
    }

    refreshUi() {
        const e = this.enabled && this.debugAllowed;

        document.body.classList.toggle("ui-editor-active", e);
        $("#ui-editor").css("display", e ? "block" : "none");
        this.setEditorHudHidden(e);
        const header = $(".ui-editor-header");
        if (this.botArenaMode && this.specOpsNpcSpawn) {
            header.text(
                "BOT ARENA — Players tab: spawn NPCs (~ toggles editor)",
            );
        } else {
            header.text("EDIT MODE");
        }
        if (this.playersTab) {
            this.playersTab.element.style.display = e && !this.specOpsNpcSpawn
                ? "none"
                : "";
        }
    }

    m_update(input: InputHandler) {
        let zoom = this.toolParams.zoom;
        if (input.keyPressed(Key.Plus)) {
            zoom -= 8;
        }
        if (input.keyPressed(Key.Minus)) {
            zoom += 8;
        }

        zoom = math.clamp(zoom, 1, 255);
        if (zoom !== this.toolParams.zoom) {
            this.toolParams.zoom = zoom;
            this.sendMsg = true;
            this.zoomBind.refresh();
        }

        this.config.config.debugRenderer = this.renderParams;

        this.setEditorHudHidden(this.enabled);
    }

    getMsg() {
        const msg = new EditMsg();
        msg.zoomEnabled = this.toolParams.zoomEnabled;
        msg.zoom = this.toolParams.zoom;

        msg.speedEnabled = this.toolParams.speedEnabled;
        msg.speed = this.toolParams.speed;

        msg.gameSpeedEnabled = this.toolParams.gameSpeedEnabled;
        msg.gameSpeed = this.toolParams.gameSpeed;

        msg.loadNewMap = this.loadNewMap;
        msg.newMapSeed = this.toolParams.mapSeed;

        if (availableLoot.includes(this.toolParams.loot)) {
            msg.spawnLootType = this.spawnLoot ? this.toolParams.loot : "";
        }
        msg.promoteToRole = this.promoteToRole;
        msg.promoteToRoleType = this.toolParams.role;

        msg.toggleLayer = this.toggleLayer;

        msg.noClip = this.toolParams.noClip;
        msg.teleportToPings = this.toolParams.teleportToPings;
        msg.godMode = this.toolParams.godMode;
        msg.moveObjs = this.toolParams.moveObjs;
        msg.preventGameStart = this.toolParams.preventGameStart;

        msg.npcIgnoreOperators = !!this.toolParams.npcIgnoreOperators;

        if (this.specOpsNpcSpawn) {
            if (this.spawnNpcOneOfEach) {
                msg.spawnNpcOneOfEach = true;
                msg.spawnNpcKind = "enemy";
            } else if (this.spawnNpc) {
                msg.spawnNpcKind = this.toolParams.spawnNpcKind || "enemy";
                msg.spawnNpcType = this.toolParams.spawnNpcType || "militia";
                msg.spawnNpcCount = this.toolParams.spawnNpcCount;
            }
        }

        // Cheat panel
        if (this.sendCheatGive && this.toolParams.cheatGiveItem) {
            msg.giveItem = this.toolParams.cheatGiveItem;
            msg.giveItemCount = Math.max(1, Math.min(999, this.toolParams.cheatGiveCount || 1));
        }
        if (this.sendCheatHealth) {
            msg.setHealth = Math.max(1, Math.min(200, this.toolParams.cheatSetHealth || 100));
        }
        if (this.sendCheatWave) {
            msg.setWave = Math.max(1, Math.min(90, this.toolParams.cheatSetWave || 1));
        }

        return msg;
    }

    hasPendingSpawn() {
        return this.spawnNpc || this.spawnNpcOneOfEach;
    }

    postSerialization() {
        this.spawnLoot = false;
        this.promoteToRole = false;
        this.loadNewMap = false;

        this.printLootStats = false;

        this.toggleLayer = false;
        this.spawnNpc = false;
        this.spawnNpcOneOfEach = false;

        // Cheat one-shot resets
        this.sendCheatGive = false;
        this.sendCheatHealth = false;
        this.sendCheatWave = false;

        this.sendMsg = false;
    }
}
