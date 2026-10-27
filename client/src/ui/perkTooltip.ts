import { GameObjectDefs } from "../../../shared/defs/register.ts";
import type { Localization } from "./localization.ts";

let installed = false;
let popup: HTMLDivElement;
let active: HTMLElement | undefined;
let frame = 0;

function hide() {
    if (active) active.removeAttribute("aria-describedby");
    active = undefined;
    popup.hidden = true;
    cancelAnimationFrame(frame);
}

function position() {
    if (!active?.isConnected || !active.getClientRects().length) return hide();
    const rect = active.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) return hide();
    const gap = 8;
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    popup.style.left = `${Math.max(gap, Math.min(rect.left, innerWidth - width - gap))}px`;
    const above = rect.top - height - gap;
    popup.style.top = `${
        Math.max(gap, Math.min(above >= gap ? above : rect.bottom + gap, innerHeight - height - gap))
    }px`;
    frame = requestAnimationFrame(position);
}

function show(target: HTMLElement) {
    hide();
    active = target;
    const title = document.createElement("strong");
    title.textContent = target.dataset.perkName ?? "";
    const description = document.createElement("div");
    description.textContent = target.dataset.perkDescription ?? "";
    popup.replaceChildren(title, description);
    popup.hidden = false;
    target.setAttribute("aria-describedby", popup.id);
    position();
}

function install() {
    if (installed) return;
    installed = true;
    popup = document.createElement("div");
    popup.id = "ui-perk-description-tooltip";
    popup.role = "tooltip";
    popup.hidden = true;
    document.body.append(popup);
    const targetOf = (target: EventTarget | null) =>
        target instanceof Element
            ? target.closest<HTMLElement>("[data-perk-description]")
            : null;
    document.addEventListener("pointerover", (event) => {
        const target = targetOf(event.target);
        if (target && target !== active && event.pointerType !== "touch") show(target);
    });
    document.addEventListener("pointerout", (event) => {
        if (active?.contains(event.target as Node) && !active.contains(event.relatedTarget as Node | null)) hide();
    });
    document.addEventListener("focusin", (event) => {
        const target = targetOf(event.target);
        if (target) show(target);
    });
    document.addEventListener("focusout", (event) => {
        if (active?.contains(event.target as Node)) hide();
    });
    document.addEventListener("scroll", () => {
        if (active) hide();
    }, true);
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && active) hide();
    });
    window.addEventListener("blur", () => {
        if (active) hide();
    });
}

/** Share translated descriptions across HUD icons and shop buy/sell rows. */
export function setPerkTooltip(element: HTMLElement, localization: Localization, type: string) {
    const def = GameObjectDefs.typeToDefSafe(type);
    if (def?.type !== "perk") {
        delete element.dataset.perkDescription;
        delete element.dataset.perkName;
        element.removeAttribute("aria-label");
        element.removeAttribute("tabindex");
        if (active === element) hide();
        return;
    }
    install();
    // Existing translations contain line-break tags. Render only their plain text.
    const plain = (value: string) => {
        const text = document.createElement("textarea");
        text.innerHTML = value.replace(/<\/?br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
        return text.textContent?.trim() ?? "";
    };
    const name = plain(localization.translate(`game-${type}`)) || def.name;
    const description = plain(localization.translate(`game-${type}-desc`));
    element.dataset.perkName = name;
    element.dataset.perkDescription = description || name;
    element.setAttribute("aria-label", `${name}: ${description || name}`);
    if (element.classList.contains("ui-perk-slot")) element.tabIndex = 0;
    if (active === element) show(element);
}
