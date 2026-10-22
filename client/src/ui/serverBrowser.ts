import $ from "jquery";
import { type MapDefKey, MapDefs } from "../../../shared/defs/mapDefs.ts";
import { GameConfig, MapId, TeamMode } from "../../../shared/gameConfig.ts";
import type { PublicGameInfo, PublicGamesResponse } from "../../../shared/types/api.ts";
import { api } from "../api.ts";
import type { Localization } from "./localization.ts";
import { MenuModal } from "./menuModal.ts";

export class ServerBrowser {
    modal = $("#modal-server-browser");
    list = $("#server-browser-list");
    refreshBtn = $("#btn-server-browser-refresh");
    private menuModal: MenuModal;
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private localization: Localization,
        private onJoin: (game: PublicGameInfo) => void,
    ) {
        this.menuModal = new MenuModal(this.modal);
        this.menuModal.skipFade = true;

        this.menuModal.onShow(() => {
            this.refresh();
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.pollTimer = setInterval(() => this.refresh(), 5000);
            $(document).on("keydown.serverBrowser", (e) => {
                if (e.key === "Escape") {
                    this.close();
                }
            });
        });

        this.menuModal.onHide(() => {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            $(document).off("keydown.serverBrowser");
        });

        $("#btn-browse-games").on("click", () => this.open());
        this.refreshBtn.on("click", () => this.refresh());
        this.modal.on("click", ".server-browser-join", (e) => {
            const id = $(e.currentTarget).data("game-id") as string;
            const game = this.games.find((g) => g.gameId === id);
            if (game) {
                this.close();
                this.onJoin(game);
            }
        });
    }

    private games: PublicGameInfo[] = [];

    open() {
        this.menuModal.show();
    }

    close() {
        this.menuModal.hide();
    }

    refresh() {
        fetch(api.resolveUrl("/api/public_games"))
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const data = (await res.json()) as PublicGamesResponse;
                this.games = data.games ?? [];
                this.render();
            })
            .catch(() => {
                this.list.html(
                    `<div class="server-browser-empty">${
                        this.localization.translate("index-server-browser-error")
                    }</div>`,
                );
            });
    }

    private render() {
        if (!this.games.length) {
            this.list.html(
                `<div class="server-browser-empty">${this.localization.translate("index-server-browser-empty")}</div>`,
            );
            return;
        }

        const rows = this.games.map((g) => {
            const mapDef = MapDefs[g.mapName as MapDefKey];
            const mapName = mapDef?.desc.name ?? g.mapName;
            const mode = GameConfig.TeamModeToString[g.teamMode as TeamMode] ?? "?";
            const mins = Math.floor(g.timeRunning / 60);
            const secs = g.timeRunning % 60;
            const time = `${mins}:${secs.toString().padStart(2, "0")}`;
            return `<div class="server-browser-row">
                <div class="server-browser-info">
                    <span class="server-browser-map">${mapName}</span>
                    <span class="server-browser-mode">${mode}</span>
                    <span class="server-browser-players">${g.players}/${g.maxPlayers}</span>
                    <span class="server-browser-time">${time}</span>
                    <span class="server-browser-region">${g.region}</span>
                </div>
                <a class="btn-darken menu-option server-browser-join" data-game-id="${g.gameId}" data-l10n="index-server-browser-join">Join</a>
            </div>`;
        });
        this.list.html(rows.join(""));
    }
}

export function leaderboardUrl(team: "solo" | "duo" | "squad"): string {
    return `/stats?type=waves_survived&team=${team}&t=alltime&mapId=${MapId.SpecOps}`;
}
