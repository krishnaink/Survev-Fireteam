import $ from "jquery";
import { MapId } from "../../../../shared/gameConfig.ts";
import type { LeaderboardRequest, LeaderboardResponse } from "../../../../shared/types/stats.ts";
import { leaderboardName, leaderboardStat } from "../../../../shared/utils/leaderboard.ts";
import { api } from "../../api.ts";
import { device } from "../../device.ts";
import { helpers } from "../../helpers.ts";
import type { App } from "./app.ts";
import leaderboard from "./templates/leaderboard.ejs";
import leaderboardError from "./templates/leaderboardError.ejs";
import loading from "./templates/loading.ejs";
import main from "./templates/main.ejs";

const templates = {
    loading,
    main,
    leaderboard,
    leaderboardError,
};

//
// MainView
//
export class MainView {
    loading = false;
    error = false;
    data = {} as Partial<
        LeaderboardRequest & {
            data: LeaderboardResponse[];
        }
    >;
    el = $(
        templates.main({
            phoneDetected: device.mobile && !device.tablet,
            gameModes: helpers.getGameModes().filter((m) => m.mapId === MapId.SpecOps),
        }),
    );

    constructor(readonly app: App) {
        this.el.find(".leaderboard-opt").change(() => {
            this.onChangedParams();
        });
    }
    load() {
        this.loading = true;
        this.error = false;

        // Supported args so far:
        //   type:     waves_survived (Spec Ops)
        //   interval: daily, weekly, alltime
        //   teamMode: solo, duo, squad
        //   maxCount: omit/100 = top 100 (menu); 0 = all ranked rows (this page)
        // Spec Ops Fireteam only — other maps / BR stats are dated.
        let type = helpers.getParameterByName<LeaderboardRequest["type"]>("type")
            || "waves_survived";
        if (type !== "waves_survived") {
            type = "waves_survived";
        }
        const interval = helpers.getParameterByName<LeaderboardRequest["interval"]>("t") || "alltime";
        const teamMode = helpers.getParameterByName("team") || "solo";
        const mapId = String(MapId.SpecOps);

        const args: LeaderboardRequest = {
            type: type,
            interval: interval,
            teamMode: teamMode as unknown as number,
            mapId: mapId as unknown as number,
            // Full stats page: every stored ranked row (menu sidebar still caps at 100).
            maxCount: 0,
        };

        $.ajax({
            url: api.resolveUrl("/api/leaderboard"),
            type: "POST",
            data: JSON.stringify(args),
            contentType: "application/json; charset=utf-8",
            success: (data) => {
                this.data = {
                    type: type,
                    interval: interval,
                    teamMode: teamMode as unknown as number,
                    mapId: mapId as unknown as number,
                    data: data,
                };
            },
            error: () => {
                this.error = true;
            },
            complete: () => {
                this.loading = false;
                this.render();
            },
        });

        this.render();
    }
    onChangedParams() {
        const type = $("#leaderboard-type").val() || "waves_survived";
        const time = $("#leaderboard-time").val();
        const teamMode = $("#leaderboard-team-mode").val();
        window.history.pushState(
            "",
            "",
            `?type=${type}&team=${teamMode}&t=${time}&mapId=${MapId.SpecOps}`,
        );
        this.load();
    }
    render() {
        // Compute derived values
        const TypeToString = {
            most_kills: "stats-most-kills",
            most_damage_dealt: "stats-most-damage",
            kills: "stats-total-kills",
            wins: "stats-total-wins",
            kpg: "stats-kpg",
            longest_survived: "stats-longest-survived",
            waves_survived: "stats-waves-survived",
        } satisfies Record<LeaderboardRequest["type"], string>;
        let content = "";
        if (this.loading) {
            content = templates.loading({
                type: "leaderboard",
            });
        } else if (this.error || !this.data.data) {
            content = templates.leaderboardError({});
        } else {
            const statName = TypeToString[this.data.type as keyof typeof TypeToString] || "";

            content = templates.leaderboard({
                ...this.data,
                statName: statName,
                leaderboardName,
                leaderboardStat,
                formatTime: helpers.formatTime,
                formatSubmittedAt: helpers.formatSubmittedAt,
                formatDifficulty: helpers.formatDifficulty,
            });

            // Set the select options
            $("#leaderboard-team-mode").val(this.data.teamMode!);
            $("#leaderboard-type").val(this.data.type!);
            $("#leaderboard-time").val(this.data.interval!);
        }

        this.el.find(".content").html(content);
        this.app.localization.localizeIndex();
        this.bindTeamToggles();
    }

    private bindTeamToggles() {
        this.el.find(".lb-team-toggle").off("click.lbTeam").on("click.lbTeam", function(e) {
            e.preventDefault();
            const btn = $(this);
            const row = btn.closest("tr");
            const members = row.next(".lb-run-details");
            const open = btn.attr("aria-expanded") === "true";
            const nextOpen = !open;
            btn.attr("aria-expanded", nextOpen ? "true" : "false");
            row.toggleClass("is-expanded", nextOpen);
            if (nextOpen) {
                members.removeAttr("hidden");
            } else {
                members.attr("hidden", "hidden");
            }
        });
    }
}
