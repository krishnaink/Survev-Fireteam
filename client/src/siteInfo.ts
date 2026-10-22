import $ from "jquery";
import { type MapDefKey, MapDefs } from "../../shared/defs/mapDefs.ts";
import { GameConfig } from "../../shared/gameConfig.ts";
import type { SiteInfoRes } from "../../shared/types/api.ts";
import { api } from "./api.ts";
import type { ConfigManager } from "./config.ts";
import { device } from "./device.ts";
import { resolveServerId, serverRegistry } from "./serverRegistry.ts";
import type { Localization } from "./ui/localization.ts";

export { defaultServerId, resolveServerId, serverRegistry } from "./serverRegistry.ts";

export class SiteInfo {
    info = {} as SiteInfoRes;
    loaded = false;
    onLoaded?: (info: SiteInfoRes) => void;
    /** Fired on site_info poll refreshes (new/dead game nodes). */
    onServersUpdated?: (info: SiteInfoRes) => void;
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        public config: ConfigManager,
        public localization: Localization,
    ) {
    }

    load() {
        const locale = this.localization.getLocale();

        const mainSelector = $("#server-opts");
        const teamSelector = $("#team-server-opts");

        for (const region in serverRegistry) {
            const data = serverRegistry[region]!;
            const name = (data.name && String(data.name).trim())
                || (data.l10n ? this.localization.translate(data.l10n) : "")
                || region;
            const elm = `<option value='${region}' data-l10n='${
                data.l10n || ""
            }' data-label='${name}'>${name}</option>`;
            mainSelector.append(elm);
            teamSelector.append(elm);
        }

        // Drop legacy defaults like "na" that are not in this host's server list.
        const resolved = resolveServerId(this.config.get("region"));
        if (resolved && resolved !== this.config.get("region")) {
            this.config.set("region", resolved);
        }

        const fetchSiteInfo = () => {
            const siteInfoUrl = api.resolveUrl(`/api/site_info?language=${locale}`);
            return fetch(siteInfoUrl)
                .then(res => res.json())
                .then((data: SiteInfoRes) => {
                    this.info = data || {};
                    const firstLoad = !this.loaded;
                    this.loaded = true;
                    this.updatePageFromInfo();
                    if (firstLoad) {
                        this.onLoaded?.(this.info);
                    } else {
                        // Poll refresh: dropdown already synced; refresh ping targets only.
                        this.onServersUpdated?.(this.info);
                    }
                })
                .catch(() => {
                    // Keep last known list on transient poll failures.
                });
        };

        void fetchSiteInfo();
        if (this.pollTimer) clearInterval(this.pollTimer);
        // Heartbeats are ~5s; poll so new/dead game nodes show without a full reload.
        this.pollTimer = setInterval(() => void fetchSiteInfo(), 12_000);
    }

    getGameModeStyles() {
        const availableModes = [];
        const modes = this.info.modes || [];
        for (let i = 0; i < modes.length; i++) {
            const mode = modes[i];
            const mapDef = (MapDefs[mode.mapName as MapDefKey] || MapDefs.main)
                .desc;
            const buttonText = mapDef.buttonText
                ? mapDef.buttonText
                : GameConfig.TeamModeToString[mode.teamMode];
            availableModes.push({
                icon: mapDef.icon,
                buttonCss: mapDef.buttonCss,
                buttonText,
                enabled: mode.enabled,
            });
        }
        return availableModes;
    }

    /** Merge live pops into serverRegistry + dropdowns (dynamic game nodes). */
    syncServersFromPops() {
        const pops = this.info.pops;
        if (!pops) return;

        const mainSelector = $("#server-opts");
        const teamSelector = $("#team-server-opts");
        const players = this.localization.translate("index-players");
        const liveIds = new Set(Object.keys(pops));

        // Drop servers that stopped heartbeating (removed from site_info pops).
        for (const id of Object.keys(serverRegistry)) {
            if (!liveIds.has(id)) {
                delete serverRegistry[id];
            }
        }
        for (const root of [mainSelector, teamSelector]) {
            root.children("option").each(function() {
                const value = String($(this).val() || "");
                if (value && !liveIds.has(value)) {
                    $(this).remove();
                }
            });
        }

        for (const region of Object.keys(pops)) {
            const data = pops[region]!;
            const label = data.name
                || (data.l10n ? this.localization.translate(data.l10n) : "")
                || region;

            if (data.address) {
                serverRegistry[region] = {
                    https: IS_DEV ? false : !!data.https,
                    // Vite DEV: keep matchmaking on the site proxy, ignore live CDN hosts.
                    address: IS_DEV
                        ? (window.location.host || data.address)
                        : data.address,
                    l10n: data.l10n || "",
                    name: data.name || label,
                };
            } else if (!(region in serverRegistry)) {
                serverRegistry[region] = {
                    https: !!data.https,
                    address: region,
                    l10n: data.l10n || "",
                    name: data.name || label,
                };
            } else if (data.name) {
                serverRegistry[region]!.name = data.name;
            }

            for (const root of [mainSelector, teamSelector]) {
                let sel = root.children(`option[value="${region}"]`);
                if (!sel.length) {
                    root.append(
                        `<option value='${region}' data-l10n='${
                            data.l10n || ""
                        }' data-label='${label}'>${label}</option>`,
                    );
                    sel = root.children(`option[value="${region}"]`);
                }
                sel.data("label", label);
                sel.attr("data-label", label);
                sel.text(`${label} [${data.playerCount} ${players}]`);
            }
        }

        const resolved = resolveServerId(this.config.get("region"));
        if (resolved && resolved !== this.config.get("region")) {
            this.config.set("region", resolved);
        }
        if (resolved) {
            mainSelector.val(resolved);
            teamSelector.val(resolved);
        }
    }

    updatePageFromInfo() {
        if (this.loaded) {
            const getGameModeStyles = this.getGameModeStyles();
            for (let i = 0; i < getGameModeStyles.length; i++) {
                const style = getGameModeStyles[i];
                const selector = `index-play-${style.buttonText}`;
                const btn = $(`#btn-start-mode-${i}`);
                btn.data("l10n", selector);
                btn.html(this.localization.translate(selector));
                if (style.icon || style.buttonCss) {
                    if (i == 0) {
                        btn.addClass("btn-custom-mode-no-indent");
                    } else {
                        btn.addClass("btn-custom-mode-main");
                    }
                    btn.addClass(style.buttonCss);
                    btn.css({
                        "background-image": `url(${style.icon})`,
                    });
                }
                const l = $(`#btn-team-queue-mode-${i}`);
                if (l.length) {
                    const c = `index-${style.buttonText}`;
                    l.data("l10n", c);
                    l.html(this.localization.translate(c));
                    if (style.icon) {
                        l.addClass("btn-custom-mode-select");
                        l.css({
                            "background-image": `url(${style.icon})`,
                        });
                    }
                }

                btn.toggle(style.enabled);
            }
            const supportsTeam = this.info.modes.some((s) => s.enabled && s.teamMode > 1);
            $("#btn-join-team, #btn-create-team").toggle(supportsTeam);

            this.syncServersFromPops();

            let hasTwitchStreamers = false;
            const featuredStreamersElem = $("#featured-streamers");
            const streamerList = $(".streamer-list");
            if (!device.mobile && this.info.twitch) {
                streamerList.empty();
                for (let i = 0; i < this.info.twitch.length; i++) {
                    const streamer = this.info.twitch[i];
                    const template = $("#featured-streamer-template").clone();
                    template
                        .attr("class", "featured-streamer streamer-tooltip")
                        .attr("id", "");
                    const link = template.find("a");
                    const text = this.localization.translate(
                        streamer.viewers == 1 ? "index-viewer" : "index-viewers",
                    );
                    link.html(
                        `${streamer.name} <span>${streamer.viewers} ${text}</span>`,
                    );
                    link.css("background-image", `url(${streamer.img})`);
                    link.attr("href", streamer.url);
                    streamerList.append(template);
                    hasTwitchStreamers = true;
                }
            }
            featuredStreamersElem.css(
                "visibility",
                hasTwitchStreamers ? "visible" : "hidden",
            );

            const featuredYoutuberElem = $("#featured-youtuber");
            const displayYoutuber = this.info.youtube;
            if (displayYoutuber) {
                $(".btn-youtuber")
                    .attr("href", this.info.youtube.link)
                    .html(this.info.youtube.name);
            }
            featuredYoutuberElem.css(
                "display",
                displayYoutuber ? "block" : "none",
            );
        }
    }
}
