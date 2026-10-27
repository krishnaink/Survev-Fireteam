import $ from "jquery";
import { MapId } from "../../../shared/gameConfig.ts";
import { LEADERBOARD_DEFAULT_COUNT, type LeaderboardResponse } from "../../../shared/types/stats.ts";
import { leaderboardName, leaderboardStat } from "../../../shared/utils/leaderboard.ts";
import { api } from "../api.ts";
import { helpers } from "../helpers.ts";
import type { Localization } from "./localization.ts";
import { leaderboardUrl } from "./serverBrowser.ts";

type TeamKey = "solo" | "duo" | "squad";

const POLL_MS = 90_000;
/** Menu board: top N with scroll; full /stats page requests all rows. */
const TOP_COUNT = LEADERBOARD_DEFAULT_COUNT;

export class MenuLeaderboard {
    private team: TeamKey = "solo";
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private fetchAbort: AbortController | null = null;
    private fetchGen = 0;

    constructor(private localization: Localization) {
        const sidebar = $("#specops-lb-sidebar");
        sidebar.on("click", ".specops-lb-tab", (e) => {
            e.preventDefault();
            const team = $(e.currentTarget).data("team") as TeamKey;
            if (team) {
                this.setTeam(team);
            }
            return false;
        });
        sidebar.on("click", ".specops-lb-view-all", (e) => {
            e.preventDefault();
            window.open(leaderboardUrl(this.team), "_blank");
            return false;
        });
    }

    start() {
        this.setTeam("solo");
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
    }

    stop() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.fetchAbort?.abort();
        this.fetchAbort = null;
    }

    setTeam(team: TeamKey) {
        this.team = team;
        $(".specops-lb-tab").removeClass("is-active");
        $(`.specops-lb-tab[data-team="${team}"]`).addClass("is-active");
        $(".specops-lb-view-all").attr("href", leaderboardUrl(team));
        const nameCol = $(".specops-lb-score-head span").eq(1);
        if (team === "solo") {
            nameCol.attr("data-l10n", "stats-player");
            nameCol.text(this.localization.translate("stats-player") || "Player");
        } else {
            nameCol.attr("data-l10n", "index-leaderboard-col-fireteam");
            nameCol.text(
                this.localization.translate("index-leaderboard-col-fireteam") || "Fireteam",
            );
        }
        void this.refresh();
    }

    private renderEntries(rows: LeaderboardResponse[]) {
        const list = $("#specops-lb-entries");
        const status = $("#specops-lb-status");
        list.empty();

        if (!rows.length) {
            status.text(this.localization.translate("index-leaderboard-empty"));
            return;
        }

        status.text("");

        const showTeams = this.team !== "solo";
        // Keep the API ranking (rounds, difficulty, then elapsed time).
        const sorted = rows;
        for (let i = 0; i < Math.min(sorted.length, TOP_COUNT); i++) {
            const row = sorted[i];
            const rank = i + 1;
            const waves = row.val > 0 ? String(row.val) : "—";
            const time = row.time ? helpers.formatTime(row.time) : "—";
            const members = row.members?.filter(Boolean) ?? [];
            const isTeam = showTeams && members.length > 0;
            const item = $("<li/>", {
                class: `specops-lb-entry${isTeam ? " is-team" : ""}`,
            });
            item.append($("<span/>", { class: "specops-lb-rank", text: String(rank) }));
            const toggle = $("<button/>", {
                type: "button",
                class: "specops-lb-run-toggle",
                "aria-expanded": "false",
                "aria-controls": `menu-lb-run-${i}`,
            });
            // Put rank inside the button so the entire row is one keyboard target.
            toggle.append(item.children().detach());
            const playerCell = $("<span/>", { class: "specops-lb-player" });
            playerCell.append($("<span/>", {
                class: "specops-lb-team-name",
                text: leaderboardName(row),
                title: leaderboardName(row),
            }));
            playerCell.append($("<span/>", {
                class: "specops-lb-team-meta",
                text: `${
                    isTeam
                        ? `${members.length} ${
                            this.localization.translate(members.length === 1 ? "lb-operator-singular" : "lb-operators")
                        }`
                        : this.localization.translate("lb-individual")
                } · ${helpers.formatDifficulty(row.difficulty)} · ${time}`,
            }));
            toggle.append(playerCell);
            toggle.append($("<span/>", { class: "specops-lb-rounds", text: waves }));
            const details = $("<div/>", { class: "specops-lb-run-details", id: `menu-lb-run-${i}`, hidden: true });
            const metrics = $("<div/>", { class: "specops-lb-metrics" });
            for (const stat of ["kills", "downs", "revives"] as const) {
                metrics.append(
                    $("<span/>").append(
                        $("<strong/>", { text: leaderboardStat(row[stat]) }),
                        $("<span/>", {
                            text: this.localization.translate(`lb-${stat}`),
                            title: this.localization.translate(`lb-${stat}-help`),
                        }),
                    ),
                );
            }
            details.append(
                $("<p/>", {
                    class: "specops-lb-detail-label",
                    text: this.localization.translate(isTeam ? "lb-team-totals" : "lb-run-stats"),
                }),
            );
            details.append(metrics);
            if (isTeam) details.append($("<p/>", { class: "specops-lb-roster", text: members.join(" · ") }));
            details.append(
                $("<p/>", { class: "specops-lb-unknown", text: this.localization.translate("lb-missing-stats") }),
            );
            toggle.on("click", () => {
                const open = toggle.attr("aria-expanded") !== "true";
                toggle.attr("aria-expanded", String(open));
                details.prop("hidden", !open);
                item.toggleClass("is-expanded", open);
            });
            item.append(toggle, details);
            list.append(item);
        }
    }

    async refresh() {
        this.fetchAbort?.abort();
        const controller = new AbortController();
        this.fetchAbort = controller;
        const gen = ++this.fetchGen;

        $("#specops-lb-status").text(
            this.localization.translate("index-leaderboard-loading"),
        );
        $("#specops-lb-entries").empty();

        const body = {
            type: "waves_survived" as const,
            interval: "alltime" as const,
            teamMode: this.team,
            mapId: String(MapId.SpecOps),
            maxCount: TOP_COUNT,
        };

        try {
            const res = await fetch(api.resolveUrl("/api/leaderboard"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const data = (await res.json()) as LeaderboardResponse[];
            if (controller.signal.aborted || gen !== this.fetchGen) return;
            this.renderEntries(data);
        } catch (err) {
            if (controller.signal.aborted || gen !== this.fetchGen) return;
            $("#specops-lb-status").text(
                this.localization.translate("index-leaderboard-unavailable"),
            );
        }
    }
}
