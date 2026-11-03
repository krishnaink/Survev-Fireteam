import $ from "jquery";
import { ensureGamepadWakeup, GamepadHandler } from "../gamepad.ts";

const FOCUS_CLASS = "menu-gamepad-focus";

function visibleMenuItems(root: JQuery<HTMLElement>): JQuery<HTMLElement> {
    return root
        .find(".menu-option:visible, .specops-input:visible, select.specops-select:visible, .specops-lb-tab:visible, .specops-lb-mode:visible")
        .filter((_i, el) => {
            const $el = $(el);
            if ($el.css("pointer-events") === "none" || $el.css("opacity") === "0") {
                return false;
            }
            if ($el.hasClass("btn-disabled")) return false;
            return true;
        });
}

function modalRoot(): JQuery<HTMLElement> | null {
    const modals = $(".modal:visible").filter((_i, el) => {
        return $(el).css("display") !== "none";
    });
    if (modals.length) return modals.last();
    return null;
}

function menuRoot(): JQuery<HTMLElement> {
    const modal = modalRoot();
    if (modal) return modal;
    return $("#start-menu-wrapper");
}

function horizontalGroup(el: JQuery<HTMLElement>): JQuery<HTMLElement> | null {
    const modeSwitch = el.closest(".specops-mode-switch");
    if (modeSwitch.length) return modeSwitch.find(".menu-option:visible");

    const lbTabs = el.closest(".specops-lb-tabs");
    if (lbTabs.length) return lbTabs.find(".specops-lb-tab:visible");

    const lbModes = el.closest(".specops-lb-modes");
    if (lbModes.length) return lbModes.find(".specops-lb-mode:visible");

    return null;
}

function cycleSelect(select: JQuery<HTMLElement>, delta: number) {
    const el = select[0] as HTMLSelectElement;
    if (!el || el.options.length === 0) return;
    let next = el.selectedIndex + delta;
    if (next < 0) next = el.options.length - 1;
    if (next >= el.options.length) next = 0;
    el.selectedIndex = next;
    select.trigger("change");
}

export class MenuGamepadNav {
    private gp = new GamepadHandler();
    private focusIdx = 0;
    private running = false;
    private navCooldown = 0;

    start() {
        if (this.running) return;
        ensureGamepadWakeup();
        this.running = true;
        this.tick();
    }

    stop() {
        this.running = false;
        this.clearFocus();
    }

    private clearFocus() {
        $(`.${FOCUS_CLASS}`).removeClass(FOCUS_CLASS);
    }

    private tick() {
        if (!this.running) return;
        requestAnimationFrame(() => this.tick());

        const gp = this.gp.poll();
        if (!gp.active) {
            this.clearFocus();
            return;
        }

        const root = menuRoot();
        if (root.css("display") === "none") {
            this.clearFocus();
            return;
        }

        const items = visibleMenuItems(root);
        if (!items.length) {
            this.clearFocus();
            return;
        }

        if (this.focusIdx >= items.length) {
            this.focusIdx = 0;
        }

        this.navCooldown = Math.max(0, this.navCooldown - 1);
        const focused = $(items[this.focusIdx]);
        const hGroup = horizontalGroup(focused);

        if (this.navCooldown === 0) {
            const lbSidebar = $("#specops-lb-sidebar:visible");
            if (lbSidebar.length && (gp.menuTabPrevPressed || gp.menuTabNextPressed)) {
                const tabs = lbSidebar.find(".specops-lb-tab");
                const activeIdx = tabs.index(lbSidebar.find(".specops-lb-tab.is-active"));
                const nextIdx = gp.menuTabPrevPressed
                    ? (activeIdx - 1 + tabs.length) % tabs.length
                    : (activeIdx + 1) % tabs.length;
                $(tabs[nextIdx]).trigger("click");
                this.navCooldown = 14;
            } else if (hGroup && hGroup.length > 1) {
                const idx = hGroup.index(focused[0]);
                if (gp.menuLeftPressed && idx > 0) {
                    this.focusIdx = items.index(hGroup.eq(idx - 1)[0]);
                    this.navCooldown = 10;
                } else if (gp.menuRightPressed && idx < hGroup.length - 1) {
                    this.focusIdx = items.index(hGroup.eq(idx + 1)[0]);
                    this.navCooldown = 10;
                }
            } else if (focused.is("select")) {
                if (gp.menuLeftPressed) {
                    cycleSelect(focused, -1);
                    this.navCooldown = 12;
                } else if (gp.menuRightPressed) {
                    cycleSelect(focused, 1);
                    this.navCooldown = 12;
                }
            }

            if (gp.menuUpPressed || gp.menuDownPressed) {
                this.focusIdx = gp.menuUpPressed
                    ? (this.focusIdx - 1 + items.length) % items.length
                    : (this.focusIdx + 1) % items.length;
                this.navCooldown = 10;
            }
        }

        this.clearFocus();
        const current = $(items[this.focusIdx]);
        current.addClass(FOCUS_CLASS);
        current[0]?.scrollIntoView({ block: "nearest", behavior: "smooth" });

        if (gp.confirmPressed) {
            if (current.is("input, select")) {
                current.trigger("focus");
            } else {
                current.trigger("click");
            }
        }
        if (gp.backPressed) {
            const closeBtn = root.find(".close:visible").first();
            if (closeBtn.length) {
                closeBtn.trigger("click");
            } else if ($("#modal-server-browser").is(":visible")) {
                $("#modal-server-browser").find(".close").first().trigger("click");
            } else if (modalRoot()) {
                modalRoot()!.find(".close").first().trigger("click");
            } else if ($("#team-menu").css("display") !== "none") {
                $("#btn-team-leave").trigger("click");
            } else if ($("#team-mobile-link").css("display") === "block") {
                $("#btn-team-mobile-link-leave").trigger("click");
            }
        }
    }
}
