import $ from "jquery";
import { ThrowableDefs } from "../../shared/defs/gameObjects/throwableDefs.ts";
import { GameConfig, Input } from "../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../shared/utils/v2.ts";
import { helpers } from "./helpers.ts";
import { MouseButton } from "./input.ts";
import type { InputHandler } from "./input.ts";
import type { InputBinds } from "./inputBinds.ts";
import type { Player } from "./objects/player.ts";

const HoldOpenSeconds = 0.18;
const CookHoldPadding = 0.05;

/** Screen-space offsets matching `.ui-throwable-slice[data-idx]` CSS. */
const SliceOffsets: readonly Vec2[] = [
    v2.create(0, -110),
    v2.create(78, -78),
    v2.create(110, 0),
    v2.create(78, 78),
    v2.create(0, 110),
    v2.create(-78, 78),
    v2.create(-110, 0),
    v2.create(-78, -78),
];

/** Client-side middle-mouse throwable radial + quick-throw. */
export class ThrowableRadial {
    private root = $("#ui-throwable-radial");
    private slices = this.root.find(".ui-throwable-slice");
    private centerLabel = $("#ui-throwable-radial-label");
    private centerImg = $("#ui-throwable-radial-center-img");

    private holdTimer = 0;
    private holding = false;
    private radialOpen = false;
    private screenPos = v2.create(0, 0);
    private selectedType = "";
    private available: string[] = [];

    /** After a quick-click, cook/throw the current grenade. */
    private pendingCook = false;
    private cookHold = 0;
    private cookArmDelay = 0;

    constructor(
        private input: InputHandler,
        private inputBinds: InputBinds,
    ) {
        this.root.css("display", "none");
        // Prevent middle-click auto-scroll while playing.
        window.addEventListener(
            "mousedown",
            (e) => {
                if (e.button === MouseButton.Middle) e.preventDefault();
            },
            { capture: true },
        );
        window.addEventListener(
            "auxclick",
            (e) => {
                if (e.button === MouseButton.Middle) e.preventDefault();
            },
            { capture: true },
        );
    }

    get blockingAim(): boolean {
        return this.radialOpen || this.holding;
    }

    m_free(): void {
        this.closeRadial();
        this.holding = false;
        this.pendingCook = false;
        this.cookHold = 0;
        this.cookArmDelay = 0;
        this.holdTimer = 0;
    }

    /**
     * @returns optional useItem string to send this frame, and whether MMB is driving shoot.
     */
    m_update(
        dt: number,
        player: Player | undefined,
        mousePos: Vec2,
        shopOpen: boolean,
    ): { useItem?: string; shootStart: boolean; shootHold: boolean } {
        const out: { useItem?: string; shootStart: boolean; shootHold: boolean } = {
            shootStart: false,
            shootHold: false,
        };

        if (shopOpen || !player || player.m_netData.m_dead || player.m_netData.m_downed) {
            this.m_free();
            return out;
        }

        const mmbDown = this.input.mouseDown(MouseButton.Middle);
        const mmbPressed = this.input.mousePressed(MouseButton.Middle);
        const mmbReleased = this.input.mouseReleased(MouseButton.Middle);

        if (mmbPressed) {
            this.holding = true;
            this.holdTimer = 0;
            this.radialOpen = false;
            this.screenPos = v2.copy(mousePos);
            this.selectedType = "";
            this.available = this.listThrowables(player);
        }

        if (this.holding && mmbDown) {
            this.holdTimer += dt;
            if (!this.radialOpen && this.holdTimer >= HoldOpenSeconds) {
                this.openRadial(player, mousePos);
            }
            if (this.radialOpen) {
                this.updateHover(mousePos);
            }
        }

        if (mmbReleased && this.holding) {
            if (this.radialOpen) {
                if (this.selectedType) {
                    out.useItem = this.selectedType;
                }
            } else if (this.holdTimer < HoldOpenSeconds) {
                // Quick click: equip current throwable and cook/throw.
                const current = player.m_localData.m_weapons[GameConfig.WeaponSlot.Throwable]
                    ?.type;
                const inv = player.m_localData.m_inventory;
                if (current && (inv[current] || 0) > 0) {
                    out.useItem = current;
                    this.pendingCook = true;
                    this.cookArmDelay = 0.05;
                    this.cookHold = GameConfig.player.cookTime + CookHoldPadding;
                } else {
                    const first = this.listThrowables(player)[0];
                    if (first) {
                        out.useItem = first;
                        this.pendingCook = true;
                        this.cookArmDelay = 0.05;
                        this.cookHold = GameConfig.player.cookTime + CookHoldPadding;
                    }
                }
            }
            this.closeRadial();
            this.holding = false;
            this.holdTimer = 0;
        }

        if (this.pendingCook) {
            if (this.cookArmDelay > 0) {
                this.cookArmDelay -= dt;
                // Keep holding so the cook starts as soon as the slot equips.
                out.shootHold = true;
                if (this.cookArmDelay <= 0) {
                    out.shootStart = true;
                }
            } else {
                out.shootHold = true;
                this.cookHold -= dt;
                if (this.cookHold <= 0) {
                    this.pendingCook = false;
                    out.shootHold = false;
                }
            }
        }

        // Don't let bound Fire steal focus while radial is open.
        if (this.radialOpen && this.inputBinds.isBindDown(Input.Fire)) {
            // no-op; caller already gates shoot when blockingAim
        }

        return out;
    }

    private listThrowables(player: Player): string[] {
        const inv = player.m_localData.m_inventory;
        const types = Object.keys(ThrowableDefs)
            .filter((type) => {
                const def = ThrowableDefs[type];
                if (!("handImg" in def) || !def.handImg || !("equip" in def.handImg)) {
                    return false;
                }
                return (inv[type] || 0) > 0;
            })
            .sort((a, b) => ThrowableDefs[a].inventoryOrder - ThrowableDefs[b].inventoryOrder);
        return types;
    }

    private setCenterPreview(type: string, fallbackLabel: string): void {
        if (!type) {
            this.centerLabel.text(fallbackLabel);
            this.centerImg.css("display", "none").css("background-image", "none");
            return;
        }
        const def = ThrowableDefs[type];
        this.centerLabel.text(def?.name || type);
        const svg = helpers.getSvgFromGameType(type);
        if (svg) {
            this.centerImg.css({
                display: "block",
                "background-image": `url(${svg})`,
                transform: helpers.getCssTransformFromGameType(type),
            });
        } else {
            this.centerImg.css("display", "none").css("background-image", "none");
        }
    }

    private openRadial(player: Player, mousePos: Vec2): void {
        this.available = this.listThrowables(player);
        if (!this.available.length) {
            this.setCenterPreview("", "No grenades");
            this.slices.each((_, el) => {
                $(el).css("display", "none");
            });
        } else {
            this.setCenterPreview("", "Grenades");
            const n = Math.min(this.available.length, this.slices.length);
            this.slices.each((i, el) => {
                const $el = $(el);
                if (i >= n) {
                    $el.css("display", "none");
                    return;
                }
                const type = this.available[i];
                const def = ThrowableDefs[type];
                const count = player.m_localData.m_inventory[type] || 0;
                $el.css("display", "flex");
                $el.attr("data-type", type);
                $el.find(".ui-throwable-slice-name").text(def?.name || type);
                $el.find(".ui-throwable-slice-count").text(`×${count}`);
                const img = $el.find(".ui-throwable-slice-img");
                const svg = helpers.getSvgFromGameType(type);
                if (svg) {
                    img.css({
                        "background-image": `url(${svg})`,
                        transform: helpers.getCssTransformFromGameType(type),
                    });
                }
            });
        }
        this.screenPos = v2.copy(mousePos);
        this.root.css({
            display: "block",
            left: mousePos.x,
            top: mousePos.y,
        });
        this.radialOpen = true;
    }

    private updateHover(mousePos: Vec2): void {
        // Screen coords (y+ down) match CSS translate offsets.
        const delta = v2.sub(mousePos, this.screenPos);
        const dist = v2.length(delta);
        const n = Math.min(this.available.length, this.slices.length, SliceOffsets.length);
        if (n <= 0 || dist < 28) {
            this.selectedType = "";
            this.slices.removeClass("is-active");
            this.setCenterPreview("", n ? "Grenades" : "No grenades");
            return;
        }
        // Pick the nearest visible slice — equal pie wedges do not match fixed CSS slots.
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < n; i++) {
            const off = SliceOffsets[i]!;
            const d2 = (delta.x - off.x) ** 2 + (delta.y - off.y) ** 2;
            if (d2 < bestDist) {
                bestDist = d2;
                bestIdx = i;
            }
        }
        this.selectedType = this.available[bestIdx]!;
        this.slices.removeClass("is-active");
        this.slices.eq(bestIdx).addClass("is-active");
        this.setCenterPreview(this.selectedType, "Grenades");
    }

    private closeRadial(): void {
        this.radialOpen = false;
        this.root.css("display", "none");
        this.slices.removeClass("is-active");
        this.selectedType = "";
        this.setCenterPreview("", "Grenades");
    }
}
