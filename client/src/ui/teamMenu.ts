import $ from "jquery";
import { specOpsMapDisplayName, SpecOpsMapPool } from "../../../shared/defs/maps/specOpsDefs.ts";
import { SpecOpsBotDebugMapName } from "../../../shared/defs/maps/specOpsNpcDebug.ts";
import { parseSpecOpsDifficulty } from "../../../shared/defs/maps/specOpsShop.ts";
import { GameConfig, TeamMode } from "../../../shared/gameConfig.ts";
import * as net from "../../../shared/net/net.ts";
import type { FindGameMatchData } from "../../../shared/types/api.ts";
import type {
    RoomData,
    ServerToClientTeamMsg,
    TeamErrorMsg,
    TeamMenuErrorType,
    TeamPlayGameMsg,
    TeamStateMsg,
} from "../../../shared/types/team.ts";
import { clientRoomPayload, normalizeTeamRoomKey } from "../../../shared/types/team.ts";
import { api } from "../api.ts";
import type { AudioManager } from "../audioManager.ts";
import type { ConfigManager } from "../config.ts";
import { device } from "../device.ts";
import { errorLogManager } from "../errorLogs.ts";
import { helpers } from "../helpers.ts";
import {
    clearTeamLobbySession,
    getActiveMatchSession,
    getRejoinSession,
    saveTeamLobbySession,
} from "../matchRejoin.ts";
import type { PingTest } from "../pingTest.ts";
import { SDK } from "../sdk/sdk.ts";
import { resolveServerId, type SiteInfo } from "../siteInfo.ts";
import type { Localization } from "./localization.ts";

/** Ignore hashchange fired by our own replaceState so every state packet does not rejoin. */
export const teamHashJoin = {
    suppressUntil: 0,
};

const teamClientIdStorageKey = "survev_team_client_id";

/** UUID v4; works in non-secure HTTP (LAN IP) where crypto.randomUUID is missing. */
function randomUUID(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    const hex = (bytes: Uint8Array) => {
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };

    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        return hex(crypto.getRandomValues(new Uint8Array(16)));
    }

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
    }
    return hex(bytes);
}

/** Stable per-tab id so lobby seats are keyed by connection, not callname. */
function getTeamClientId(): string {
    try {
        let id = sessionStorage.getItem(teamClientIdStorageKey);
        if (!id) {
            id = randomUUID();
            sessionStorage.setItem(teamClientIdStorageKey, id);
        }
        return id;
    } catch {
        return randomUUID();
    }
}

function errorTypeToString(type: TeamMenuErrorType, localization: Localization) {
    const typeMap = {
        join_full: localization.translate("index-team-is-full"),
        join_not_found: localization.translate("index-failed-joining-team"),
        create_failed: localization.translate("index-failed-creating-team"),
        join_failed: localization.translate("index-failed-joining-team"),
        join_game_failed: localization.translate("index-failed-joining-game"),
        lost_conn: localization.translate("index-lost-connection"),
        find_game_error: localization.translate("index-failed-finding-game"),
        find_game_full: localization.translate("index-failed-finding-game"),
        find_game_invalid_protocol: localization.translate("index-invalid-protocol"),
        find_game_invalid_captcha: localization.translate("index-invalid-captcha"),
        kicked: localization.translate("index-team-kicked"),
        banned: localization.translate("index-ip-banned"),
        behind_proxy: "behind_proxy", // this will get passed to the main app to show a modal
    } as Record<TeamMenuErrorType, string>;
    return typeMap[type as keyof typeof typeMap] || typeMap.lost_conn;
}

export class TeamMenu {
    // Jquery elems
    playBtn = $("#btn-start-team");
    serverWarning = $("#server-warning");
    teamOptions = $(
        "#btn-team-queue-mode-0, #btn-team-queue-mode-1, #btn-team-queue-mode-2, #btn-team-fill-auto, #btn-team-fill-none, #btn-team-wave-wait, #btn-team-wave-continuous",
    );

    serverSelect = $("#team-server-select");
    mapSelect = $("#team-map-select");
    difficultySelect = $("#team-difficulty-select");
    endlessToggle = $("#team-endless-toggle");
    waveWaitBtn = $("#btn-team-wave-wait");
    waveContinuousBtn = $("#btn-team-wave-continuous");
    squadSizeSelect = $("#team-squad-size-select");
    squadSizeField = $("#team-squad-size-field");
    squadNameInput = $("#team-squad-name-input");
    squadNameField = $("#team-squad-name-field");
    squadSizeSelectPopulated = false;
    mapSelectPopulated = false;
    queueMode0 = $("#btn-team-queue-mode-0");
    queueMode1 = $("#btn-team-queue-mode-1");
    queueMode2 = $("#btn-team-queue-mode-2");
    fillAuto = $("#btn-team-fill-auto");
    fillNone = $("#btn-team-fill-none");

    active = false;
    joined = false;
    create = false;
    joiningGame = false;
    ws: WebSocket | null = null;
    keepAliveTimeout = 0;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private userLeft = false;
    private pendingGameComplete = false;
    private pendingMatchRejoin = false;
    private socketGen = 0;
    /** True while applying a server state packet so UI writes cannot echo setRoomProps. */
    private applyingServerState = false;

    gameError: string | undefined = undefined;

    // Ui state
    playerData = {};
    roomData = {} as RoomData;
    players: Array<{
        playerId: number;
        inGame: boolean;
        name: string;
        isLeader: boolean;
    }> = [];

    prevPlayerCount = 0;
    localPlayerId = 0;
    isLeader = true;
    editingName = false;
    displayedInvalidProtocolModal = false;

    hideUrl!: boolean;

    constructor(
        public config: ConfigManager,
        public pingTest: PingTest,
        public siteInfo: SiteInfo,
        public localization: Localization,
        public audioManager: AudioManager,
        public joinGameCb: (data: FindGameMatchData) => void,
        public leaveCb: (err?: string) => void,
    ) {
        // Listen for ui modifications
        this.serverSelect.on("change", () => {
            if (this.applyingServerState) return;
            const e = resolveServerId(this.serverSelect.find(":selected").val() as string);
            if (!e) return;
            this.serverSelect.val(e);
            this.config.set("region", e);
            this.config.set("regionSelected", true);
            this.pingTest.start([e]);
            this.setRoomProperty("region", e);
        });
        this.mapSelect.on("change", () => {
            if (this.applyingServerState) return;
            const mapName = this.mapSelect.find(":selected").val() as string;
            this.setRoomProperty("mapName", mapName);
        });
        this.endlessToggle.on("change", () => {
            if (this.applyingServerState) return;
            const endless = this.endlessToggle.prop("checked") === true;
            this.config.set("teamEndless", endless);
            this.setRoomProperty("endless", endless);
            this.syncWaveModeButtons(endless);
        });
        this.waveWaitBtn.on("click", () => {
            if (this.applyingServerState || !this.isLeader) return;
            this.endlessToggle.prop("checked", false);
            this.config.set("teamEndless", false);
            this.setRoomProperty("endless", false);
            this.syncWaveModeButtons(false);
        });
        this.waveContinuousBtn.on("click", () => {
            if (this.applyingServerState || !this.isLeader) return;
            this.endlessToggle.prop("checked", true);
            this.config.set("teamEndless", true);
            this.setRoomProperty("endless", true);
            this.syncWaveModeButtons(true);
        });
        this.difficultySelect.on("change", () => {
            if (this.applyingServerState) return;
            const difficulty = parseSpecOpsDifficulty(
                this.difficultySelect.find(":selected").val(),
            );
            this.config.set("teamDifficulty", difficulty);
            this.setRoomProperty("difficulty", difficulty);
        });
        this.squadSizeSelect.on("change", () => {
            if (this.applyingServerState) return;
            const squadSize = parseInt(
                this.squadSizeSelect.find(":selected").val() as string,
                10,
            );
            if (Number.isFinite(squadSize)) {
                this.setRoomProperty("squadSize", squadSize);
            }
        });
        this.squadNameInput.on("change", () => {
            this.commitSquadNameFromInput();
        });
        this.squadNameInput.on("input", () => {
            if (this.applyingServerState || !this.isLeader) return;
            // Keep local room state in sync while typing so Play doesn't miss the name.
            const squadName = String(this.squadNameInput.val() ?? "").trim();
            this.roomData.squadName = squadName;
            this.config.set("teamSquadName", squadName);
        });
        this.squadNameInput.on("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.commitSquadNameFromInput();
                this.squadNameInput.blur();
            }
        });
        this.queueMode0.on("click", () => {
            this.setRoomProperty("gameModeIdx", 0);
            this.refreshSquadNameVisibility();
        });
        this.queueMode1.on("click", () => {
            this.setRoomProperty("gameModeIdx", 1);
            this.refreshSquadNameVisibility();
        });
        this.queueMode2.on("click", () => {
            this.setRoomProperty("gameModeIdx", 2);
            this.refreshSquadNameVisibility();
        });
        this.fillAuto.on("click", () => {
            this.setRoomProperty("autoFill", true);
        });
        this.fillNone.on("click", () => {
            this.setRoomProperty("autoFill", false);
        });
        this.playBtn.on("click", () => {
            SDK.requestMidGameAd(() => {
                this.tryStartGame();
            });
        });
        const showCopyToast = (e: JQuery.ClickEvent, anchor: JQuery<HTMLElement>) => {
            const t = $("<div/>", {
                class: "copy-toast",
                html: "Copied!",
            });
            $("#start-menu-wrapper").append(t);
            t.css({
                left: e.pageX - parseInt(t.css("width")) / 2,
                top: anchor.offset()!.top,
            });
            t.animate(
                {
                    top: "-=20",
                    opacity: 1,
                },
                {
                    queue: false,
                    duration: 300,
                    complete: function() {
                        $(this).fadeOut(250, function() {
                            $(this).remove();
                        });
                    },
                },
            );
        };

        const copyInviteLink = (e: JQuery.ClickEvent) => {
            showCopyToast(e, $("#team-copy-url"));
            let codeToCopy = $("#team-url").text();
            if (window !== window.top) {
                codeToCopy = this.roomData.roomUrl.substring(1);
            }
            helpers.copyTextToClipboard(codeToCopy);
        };

        const copyInviteCode = (e: JQuery.ClickEvent) => {
            showCopyToast(e, $("#team-copy-code"));
            const roomCode = this.roomData.roomUrl
                ? this.roomData.roomUrl.substring(1)
                : $("#team-code").text();
            helpers.copyTextToClipboard(roomCode);
        };

        $("#team-copy-url").on("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            copyInviteLink.call(this, e);
        });
        $("#team-desc-text").on("click", (e) => {
            if ($(e.target).closest(".specops-team-invite-actions").length) {
                return;
            }
            copyInviteLink.call(this, e);
        });
        $("#team-copy-code, #team-code-text").on("click", (e) => {
            e.preventDefault();
            copyInviteCode.call(this, e);
        });

        if (window !== window.top) {
            $("#team-desc-text").hide();
        }

        if (!device.mobile) {
            this.hideUrl = false;
            $("#team-hide-url").on("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const el = e.currentTarget;
                this.hideUrl = !this.hideUrl;
                $("#team-desc-text .specops-team-field-value-row").css({
                    opacity: this.hideUrl ? 0 : 1,
                });
                $(el).toggleClass("specops-team-icon-btn--hidden", this.hideUrl);
            });
        }

        setInterval(() => {
            if (this.joined) {
                this.sendMessage("keepAlive", {});
            }
        }, 10 * 1000);
    }

    getPlayerById(playerId: number) {
        return this.players.find((x) => {
            return x.playerId == playerId;
        });
    }

    /** Room code without leading `#` — used for comparisons and join payloads. */
    roomKey(url?: string): string {
        return normalizeTeamRoomKey(url || "");
    }

    isWsLive(): boolean {
        return (
            this.ws?.readyState === WebSocket.OPEN
            || this.ws?.readyState === WebSocket.CONNECTING
        );
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private scheduleReconnect() {
        if (this.userLeft || !this.active || !this.joined || this.joiningGame) return;
        if (!this.roomKey(this.roomData.roomUrl)) return;
        if (this.isWsLive()) return;

        if (this.reconnectAttempts >= 12) {
            this.leave("lost_conn");
            return;
        }

        this.clearReconnectTimer();
        const delay = Math.min(500 * (this.reconnectAttempts + 1), 5000);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.active && this.joined && !this.userLeft && !this.isWsLive()) {
                this.openSocket(false);
            }
        }, delay);
    }

    private detachWebSocket() {
        if (!this.ws) return;
        this.ws.onerror = function() {};
        this.ws.onopen = function() {};
        this.ws.onmessage = function() {};
        this.ws.onclose = function() {};
        this.ws.close();
        this.ws = null;
    }

    private openSocket(sendCreate: boolean) {
        this.userLeft = false;
        this.clearReconnectTimer();
        const gen = ++this.socketGen;

        const start = () => {
            if (gen !== this.socketGen || this.userLeft || !this.active) return;
            if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;

            const url = api.resolveTeamWsUrls()[0]!;
            try {
                this.ws = new WebSocket(url);
                this.ws.onerror = () => {
                    this.ws?.close();
                };
                this.ws.onclose = () => {
                    this.ws = null;
                    if (this.userLeft || !this.active) return;
                    if (this.joiningGame) return;

                    if (this.joined && this.roomKey(this.roomData.roomUrl)) {
                        this.scheduleReconnect();
                        return;
                    }

                    const errMsg: TeamMenuErrorType | undefined = this.joined
                        ? "lost_conn"
                        : sendCreate
                        ? "create_failed"
                        : "join_failed";
                    this.leave(errMsg);
                };
                this.ws.onopen = () => {
                    this.reconnectAttempts = 0;
                    if (sendCreate) {
                        this.sendMessage("create", {
                            roomData: clientRoomPayload(this.roomData),
                            playerData: this.playerData,
                        });
                    } else {
                        this.sendMessage("join", {
                            roomUrl: this.roomData.roomUrl,
                            playerData: this.playerData,
                        });
                        if (this.pendingGameComplete) {
                            this.pendingGameComplete = false;
                            this.sendMessage("gameComplete", {});
                        }
                    }
                };
                this.ws.onmessage = (e) => {
                    if (!this.active) return;
                    try {
                        const msg = JSON.parse(e.data);
                        this.onMessage(msg.type, msg.data);
                    } catch (err) {
                        errorLogManager.logError("team_menu_ws_parse", err);
                    }
                };
            } catch (_e) {
                this.leave(sendCreate ? "create_failed" : "join_failed");
            }
        };

        const prev = this.ws;
        if (prev && prev.readyState !== WebSocket.CLOSED) {
            // Wait for the old socket to close so the server processes disconnect
            // before the new join. Opening immediately races join_full.
            prev.onerror = function() {};
            prev.onopen = function() {};
            prev.onmessage = function() {};
            prev.onclose = () => {
                if (this.ws === prev) this.ws = null;
                start();
            };
            prev.close();
            window.setTimeout(() => {
                if (gen !== this.socketGen) return;
                if (this.ws === prev) {
                    prev.onclose = function() {};
                    this.ws = null;
                    start();
                } else if (!this.ws) {
                    start();
                }
            }, 750);
            return;
        }

        this.ws = null;
        start();
    }

    /** Re-open the team socket if the lobby session is active but the WS died. */
    ensureConnected(): boolean {
        if (!this.active || !this.joined || this.userLeft) return this.isWsLive();
        if (this.isWsLive()) return true;
        if (this.joiningGame && !this.pendingMatchRejoin) return false;

        const key = this.roomKey(this.roomData.roomUrl);
        if (!key) return false;

        this.connect(false, key);
        return false;
    }

    /**
     * Squad/team rejoin: ask the lobby server for a fresh join token while the
     * match is still running. Falls back to solo find_game when the WS is down.
     */
    requestMatchRejoin(): boolean {
        if (!this.active || this.userLeft) return false;
        const key = this.roomKey(this.roomData.roomUrl);
        if (!key) return false;

        this.pendingMatchRejoin = true;
        this.joiningGame = false;

        if (!this.isWsLive()) {
            this.ensureConnected();
            return true;
        }

        if (this.joined) {
            this.pendingMatchRejoin = false;
            const session = getRejoinSession() ?? getActiveMatchSession();
            this.sendMessage("rejoinMatch", {
                playerId: session?.playerId,
                playerName: session?.playerName,
            });
        }
        return true;
    }

    /** Clear stuck joining / pending-rejoin flags so the lobby play button works again. */
    clearMatchJoinState() {
        this.joiningGame = false;
        this.pendingMatchRejoin = false;
        this.gameError = undefined;
        if (this.roomData.findingGame) {
            this.roomData.findingGame = false;
        }
        this.refreshUi();
    }

    connect(create: boolean, roomUrl: string) {
        const nextKey = this.roomKey(roomUrl);
        const curKey = this.roomKey(this.roomData.roomUrl);

        // Live or still-opening socket — do not open another (mobile double-tap
        // / touch+click would trip the lobby rate limit).
        if (this.isWsLive() && this.active) {
            if (create && !nextKey) return;
            if (nextKey && nextKey === curKey) return;
            if (this.joined && curKey && !nextKey) return;
        }

        const reconnectingSameRoom = this.active && this.joined && !!curKey
            && (!nextKey || nextKey === curKey);

        if (!this.active || nextKey !== curKey || create !== this.create || reconnectingSameRoom) {
            const wasJoined = this.active && this.joined && !!curKey;

            this.active = true;
            this.userLeft = false;
            if (!wasJoined) {
                this.joined = false;
            }
            this.create = create;
            this.joiningGame = false;
            this.editingName = false;
            this.gameError = undefined;

            // Load properties from config
            this.playerData = {
                name: this.config.get("playerName"),
                clientId: getTeamClientId(),
            };
            if (!wasJoined) {
                const region = resolveServerId(
                    (this.serverSelect.find(":selected").val() as string | undefined)
                        || this.config.get("region"),
                );
                if (region) {
                    this.config.set("region", region);
                    this.config.set("regionSelected", true);
                }
                this.roomData = {
                    roomUrl: create ? roomUrl : (nextKey ? `#${nextKey}` : ""),
                    region,
                    gameModeIdx: this.config.get("gameModeIdx")!,
                    autoFill: this.config.get("teamAutoFill")!,
                    mapName: this.config.get("teamMapName") || "random",
                    difficulty: parseSpecOpsDifficulty(
                        this.config.get("teamDifficulty")
                            || this.siteInfo.info.specOpsDifficulty
                            || "regular",
                    ),
                    endless: (() => {
                        // Prefer the lobby checkbox (player choice), then saved pref,
                        // then site default. Never force server endless over the UI.
                        if (this.endlessToggle.length) {
                            return this.endlessToggle.prop("checked") === true;
                        }
                        const saved = this.config.get("teamEndless");
                        if (typeof saved === "boolean") return saved;
                        return this.siteInfo.info.specOpsEndless ?? false;
                    })(),
                    squadSize: this.config.get("teamSquadSize")
                        ?? this.siteInfo.info.maxSquadSize
                        ?? 4,
                    squadName: this.config.get("teamSquadName") || "",
                    findingGame: false,
                    lastError: undefined,
                } as RoomData;
            }
            this.displayedInvalidProtocolModal = false;

            this.refreshUi();
            this.openSocket(wasJoined ? false : create);
        }
    }

    leave(errType?: TeamMenuErrorType) {
        if (this.active) {
            clearTeamLobbySession();
            this.userLeft = true;
            this.socketGen++;
            this.pendingGameComplete = false;
            this.reconnectAttempts = 0;
            this.clearReconnectTimer();
            this.detachWebSocket();
            this.active = false;
            this.joined = false;
            this.joiningGame = false;
            this.refreshUi();

            // Save state to config for the menu
            this.config.set("gameModeIdx", this.roomData.gameModeIdx);
            this.config.set("teamAutoFill", this.roomData.autoFill);
            if (this.isLeader) {
                this.config.set("region", this.roomData.region);
                this.config.set("teamMapName", this.roomData.mapName);
                this.config.set("teamDifficulty", parseSpecOpsDifficulty(this.roomData.difficulty));
                this.config.set("teamEndless", !!this.roomData.endless);
                this.config.set("teamSquadSize", this.roomData.squadSize);
                this.config.set("teamSquadName", this.roomData.squadName || "");
            }
            let errTxt = "";
            if (errType) {
                errTxt = errorTypeToString(errType, this.localization);
            }
            this.leaveCb(errTxt);

            SDK.hideInviteButton();
        }
    }

    onGameComplete(errMessage?: string) {
        if (this.active) {
            this.joiningGame = false;
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.sendMessage("gameComplete");
            } else if (this.joined) {
                this.pendingGameComplete = true;
                this.openSocket(false);
            }

            this.gameError = errMessage;
        }
    }

    onMessage<T extends ServerToClientTeamMsg["type"]>(
        type: T,
        data: ServerToClientTeamMsg["data"],
    ) {
        switch (type) {
            case "state": {
                let stateData = data as TeamStateMsg["data"];
                this.joined = true;
                const ourRoomData = this.roomData;
                this.roomData = stateData.room;
                this.players = stateData.players;
                this.localPlayerId = stateData.localPlayerId;
                const localPlayer = this.getPlayerById(this.localPlayerId);
                this.isLeader = !!localPlayer?.isLeader;

                // Keep a pending local edit from being overwritten by a stale
                // broadcast. Do not echo these values back — that ping-pongs
                // state to every client.
                if (this.isLeader) {
                    this.roomData.region = ourRoomData.region;
                    this.roomData.autoFill = ourRoomData.autoFill;
                    this.roomData.mapName = ourRoomData.mapName;
                    this.roomData.difficulty = ourRoomData.difficulty;
                    this.roomData.endless = ourRoomData.endless;
                    this.roomData.squadSize = ourRoomData.squadSize;
                    this.roomData.squadName = ourRoomData.squadName;
                }
                this.applyingServerState = true;
                try {
                    this.refreshUi();
                } finally {
                    this.applyingServerState = false;
                }
                // Since the only way to get the roomID (ig?) is from state, each time receiving state, we can show the invite button
                SDK.showInviteButton(stateData.room.roomUrl.replace("#", ""));
                if (!this.joiningGame) {
                    saveTeamLobbySession(stateData.room.roomUrl);
                }
                if (this.pendingMatchRejoin) {
                    this.pendingMatchRejoin = false;
                    const session = getRejoinSession() ?? getActiveMatchSession();
                    this.sendMessage("rejoinMatch", {
                        playerId: session?.playerId,
                        playerName: session?.playerName,
                    });
                }
                break;
            }
            case "joinGame":
                this.joiningGame = true;
                this.pendingMatchRejoin = false;
                this.joinGameCb(data as FindGameMatchData);
                break;
            case "keepAlive":
                break;
            case "kicked":
                this.leave("kicked");
                break;
            case "error":
                this.leave((data as TeamErrorMsg["data"]).type);
        }
    }

    sendMessage(type: string, data?: unknown) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            const msg = JSON.stringify({
                type,
                data,
            });
            this.ws.send(msg);
        } else if (this.active && this.joined && !this.userLeft && !this.isWsLive()) {
            this.scheduleReconnect();
        }
    }

    setRoomProperty<T extends keyof RoomData>(prop: T, val: RoomData[T]) {
        if (this.applyingServerState) return;
        if (this.isLeader && this.roomData[prop] != val) {
            this.roomData[prop] = val;
            this.sendMessage("setRoomProps", clientRoomPayload(this.roomData));
        }
    }

    ensureSquadSizeSelectOptions() {
        const maxSquad = Math.min(8, Math.max(2, this.siteInfo.info.maxSquadSize ?? 4));
        if (this.squadSizeSelectPopulated && this.squadSizeSelect.children().length === maxSquad - 1) {
            return;
        }
        this.squadSizeSelect.empty();
        for (let n = 2; n <= maxSquad; n++) {
            this.squadSizeSelect.append(
                $("<option/>", { value: String(n), text: String(n) }),
            );
        }
        this.squadSizeSelectPopulated = true;
    }

    isSquadGameMode(): boolean {
        return this.resolveRoomTeamMode() === TeamMode.Squad;
    }

    /** Duo or squad — fireteam name applies to both. */
    isNamedFireteamMode(): boolean {
        const mode = this.resolveRoomTeamMode();
        return mode === TeamMode.Duo || mode === TeamMode.Squad;
    }

    /** Prefer live site_info modes; fall back to Solo/Duo/Squad button index. */
    private resolveRoomTeamMode(): number {
        const mode = this.siteInfo.info.modes?.[this.roomData.gameModeIdx];
        if (
            mode?.teamMode === TeamMode.Solo
            || mode?.teamMode === TeamMode.Duo
            || mode?.teamMode === TeamMode.Squad
        ) {
            return mode.teamMode;
        }
        if (this.roomData.gameModeIdx === 1) return TeamMode.Duo;
        if (this.roomData.gameModeIdx === 2) return TeamMode.Squad;
        return TeamMode.Solo;
    }

    private commitSquadNameFromInput() {
        if (this.applyingServerState || !this.isLeader) return;
        const squadName = String(this.squadNameInput.val() ?? "").trim();
        this.config.set("teamSquadName", squadName);
        this.setRoomProperty("squadName", squadName);
    }

    private refreshSquadNameVisibility() {
        const showSquadName = this.isNamedFireteamMode();
        this.squadNameField.css("display", showSquadName ? "flex" : "none");
        this.squadNameInput.prop("disabled", !this.isLeader || !showSquadName);
        if (showSquadName && this.isLeader) {
            const fromInput = String(this.squadNameInput.val() ?? "").trim();
            if (!fromInput && this.roomData.squadName) {
                this.squadNameInput.val(this.roomData.squadName);
            }
        }
    }

    private syncWaveModeButtons(endless: boolean): void {
        this.setModeButtonState(this.waveWaitBtn, !endless, this.isLeader);
        this.setModeButtonState(this.waveContinuousBtn, endless, this.isLeader);
    }

    private setModeButtonState(
        el: JQuery<HTMLElement>,
        selected: boolean,
        enabled: boolean,
    ): void {
        el.removeClass("btn-darken btn-disabled btn-opaque btn-hollow-selected is-active");
        if (enabled) {
            el.addClass("btn-darken");
        } else {
            el.addClass("btn-disabled");
            if (!selected) {
                el.addClass("btn-opaque");
            }
        }
        if (selected) {
            el.addClass("btn-hollow-selected is-active");
        }
        el.prop("disabled", !enabled);
    }

    resetMapSelectOptions() {
        this.mapSelectPopulated = false;
    }

    ensureMapSelectOptions() {
        if (this.mapSelectPopulated) return;
        const randomLabel = this.localization.translate("index-specops-map-random");
        this.mapSelect.empty();
        this.mapSelect.append(
            $("<option/>", { value: "random", text: randomLabel }),
        );
        for (const key of SpecOpsMapPool) {
            this.mapSelect.append(
                $("<option/>", { value: key, text: specOpsMapDisplayName(key) }),
            );
        }
        if (this.siteInfo.info.allowEditMsg) {
            this.mapSelect.append(
                $("<option/>", {
                    value: "test_specops",
                    text: "Test Spec Ops (debug)",
                }),
            );
        }
        if (this.siteInfo.info.specOpsNpcSpawn) {
            this.mapSelect.append(
                $("<option/>", {
                    value: SpecOpsBotDebugMapName,
                    text: "Bot Arena (debug)",
                }),
            );
        }
        this.mapSelectPopulated = true;
    }

    tryStartGame() {
        if (this.isLeader && !this.roomData.findingGame) {
            // Flush fireteam name before matchmaking so the board can group the run.
            if (this.isNamedFireteamMode()) {
                this.commitSquadNameFromInput();
            }
            const version = GameConfig.protocolVersion;
            let region = resolveServerId(
                this.roomData.region
                    || (this.config.get("region") as string | undefined)
                    || (this.serverSelect.find(":selected").val() as string | undefined),
            );
            const paramRegion = helpers.getParameterByName("region");
            if (paramRegion !== undefined && paramRegion.length > 0) {
                region = resolveServerId(paramRegion);
            }
            let zones = this.pingTest.getZones(region);
            const paramZone = helpers.getParameterByName("zone");
            if (paramZone !== undefined && paramZone.length > 0) {
                zones = [paramZone];
            }
            if (!zones.length) {
                zones = [region];
            }
            const matchArgs: TeamPlayGameMsg["data"] = {
                version,
                region,
                zones,
            };

            helpers.verifyTurnstile(this.roomData.captchaEnabled, (token) => {
                matchArgs.turnstileToken = token;
                this.sendMessage("playGame", matchArgs);
            });
            this.roomData.findingGame = true;
            this.gameError = undefined;
            this.refreshUi();
        }
    }

    refreshUi() {
        const setButtonState = (
            el: JQuery<HTMLElement>,
            selected: boolean,
            enabled: boolean,
        ) => {
            this.setModeButtonState(el, selected, enabled);
        };
        $("#team-menu").css("display", this.active ? "flex" : "none");
        $("#start-menu").css("display", this.active ? "none" : "block");
        $("#specops-lb-sidebar").css("display", this.active ? "none" : "flex");
        $(".specops-hub-center").toggleClass("specops-hub-center--team", this.active);
        $(".specops-menu-stage").toggleClass("specops-menu-stage--team", this.active);
        $("#social-share-block").css("display", this.active ? "none" : "block");

        // Error text
        const errorTxt = this.roomData.lastError
            ? errorTypeToString(this.roomData.lastError!, this.localization)
            : this.gameError;
        this.serverWarning.css("opacity", errorTxt ? 1 : 0);
        this.serverWarning.html(errorTxt || "");

        if (
            this.roomData.lastError == "find_game_invalid_protocol"
            && !this.displayedInvalidProtocolModal
        ) {
            $("#modal-refresh").fadeIn(200);
            this.displayedInvalidProtocolModal = true;
        }

        // Set captcha to enabled if we fail the captcha
        // This can happen if it was disabled when the page loaded which would meant it was sending an empty token
        // And we only fetch the state when the page loads...
        if (this.roomData.lastError === "find_game_invalid_captcha") {
            this.siteInfo.info.captchaEnabled = true;
        }

        // Show/hide team connecting/contents
        if (this.active) {
            $("#team-menu-joining-text").css("display", this.create ? "none" : "block");
            $("#team-menu-creating-text").css("display", this.create ? "block" : "none");
            $("#team-menu-connecting").css("display", this.joined ? "none" : "block");
            $("#team-menu-contents").css("display", this.joined ? "flex" : "none");
            $("#btn-team-leave").css("display", this.joined ? "block" : "none");

            // Prefill lobby options before the socket joins so create uses player choice.
            if (!this.joined) {
                const wasApplying = this.applyingServerState;
                this.applyingServerState = true;
                try {
                    const region = resolveServerId(
                        this.roomData.region || this.config.get("region"),
                    );
                    if (region) {
                        this.serverSelect.val(region);
                        this.roomData.region = region;
                    }
                    const difficulty = parseSpecOpsDifficulty(
                        this.config.get("teamDifficulty")
                            || this.siteInfo.info.specOpsDifficulty
                            || "regular",
                    );
                    this.difficultySelect.val(difficulty);
                    const savedEndless = this.config.get("teamEndless");
                    const endless = typeof savedEndless === "boolean"
                        ? savedEndless
                        : (this.siteInfo.info.specOpsEndless ?? false);
                    this.endlessToggle.prop("checked", endless);
                    this.syncWaveModeButtons(endless);
                } finally {
                    this.applyingServerState = wasApplying;
                }
            }
        }

        if (this.joined) {
            this.ensureMapSelectOptions();
            this.ensureSquadSizeSelectOptions();

            // Servers
            const regionPops = this.siteInfo.info.pops || {};
            const regions = Object.keys(regionPops);
            for (let i = 0; i < regions.length; i++) {
                const region = regions[i];
                const count = regionPops[region].playerCount;
                const players = this.localization.translate("index-players");
                const sel = $("#team-server-opts").children(`option[value="${region}"]`);
                sel.html(`${sel.attr("data-label")} [${count} ${players}]`);
            }

            this.serverSelect.find("option").each((_idx, ele) => {
                ele.selected = ele.value == this.roomData.region;
            });

            const wasApplying = this.applyingServerState;
            this.applyingServerState = true;
            try {
                const mapName = this.roomData.mapName || "random";
                this.mapSelect.val(mapName);
                this.mapSelect.prop("disabled", !this.isLeader);

                const difficulty = parseSpecOpsDifficulty(this.roomData.difficulty);
                this.difficultySelect.val(difficulty);
                this.difficultySelect.prop("disabled", !this.isLeader);
                this.endlessToggle.prop("checked", !!this.roomData.endless);
                this.endlessToggle.prop("disabled", !this.isLeader);
                this.syncWaveModeButtons(!!this.roomData.endless);

                const squadSize = this.roomData.squadSize || this.siteInfo.info.maxSquadSize || 4;
                this.squadSizeSelect.val(String(squadSize));
                const showSquadSize = this.isSquadGameMode();
                this.squadSizeField.css("display", showSquadSize ? "flex" : "none");
                this.squadSizeSelect.prop("disabled", !this.isLeader || !showSquadSize);

                this.refreshSquadNameVisibility();
                if (this.isNamedFireteamMode()) {
                    this.squadNameInput.val(this.roomData.squadName || "");
                }
            } finally {
                this.applyingServerState = wasApplying;
            }

            // Modes btns
            setButtonState(
                this.queueMode0,
                this.roomData.gameModeIdx == 0,
                this.isLeader && this.roomData.enabledGameModeIdxs.includes(0),
            );
            setButtonState(
                this.queueMode1,
                this.roomData.gameModeIdx == 1,
                this.isLeader && this.roomData.enabledGameModeIdxs.includes(1),
            );
            setButtonState(
                this.queueMode2,
                this.roomData.gameModeIdx == 2,
                this.isLeader && this.roomData.enabledGameModeIdxs.includes(2),
            );

            // Fill mode
            setButtonState(this.fillAuto, this.roomData.autoFill, this.isLeader);
            setButtonState(this.fillNone, !this.roomData.autoFill, this.isLeader);
            this.serverSelect.prop("disabled", !this.isLeader);

            // Invite link
            if (this.roomData.roomUrl) {
                const roomCode = this.roomData.roomUrl.substring(1);
                $("#team-code").text(roomCode);

                if (SDK.supportsInviteLink()) {
                    SDK.getInviteLink(roomCode).then((sdkUrl) => {
                        $("#team-url").text(sdkUrl!);
                    });
                } else {
                    const roomUrl = new URL(window.location.href);
                    roomUrl.search = ""; // removes ?t=<timestamp> that is set when the client receives an invalid protocol error
                    roomUrl.hash = this.roomData.roomUrl;

                    const url = new URL(window.location.href);
                    url.search = "";
                    url.hash = this.roomData.roomUrl;

                    $("#team-url").text(url.toString());

                    if (window.history) {
                        const url = new URL(window.location.href);
                        url.search = "";
                        url.hash = this.roomData.roomUrl;
                        const next = `${url.pathname}${url.search}${url.hash}`;
                        const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
                        if (next !== cur) {
                            teamHashJoin.suppressUntil = Date.now() + 1000;
                            window.history.replaceState("", "", next);
                        }
                    }
                }
            }

            // Play button
            this.playBtn.html(
                this.roomData.findingGame || this.joiningGame
                    ? "<div class=\"ui-spinner\"></div>"
                    : this.playBtn.attr("data-label")!,
            );

            const gameModeStyles = this.siteInfo.getGameModeStyles();
            for (let i = 0; i < gameModeStyles.length; i++) {
                this.playBtn.removeClass(gameModeStyles[i].buttonCss);
            }
            const style = gameModeStyles[this.roomData.gameModeIdx];
            if (style) {
                this.playBtn.addClass("btn-custom-mode-no-indent");
                this.playBtn.addClass(style.buttonCss);
                this.playBtn.css({
                    "background-image": `url(${style.icon})`,
                });
            } else {
                this.playBtn.css({
                    "background-image": "",
                });
            }
            let playersInGame = false;
            for (let i = 0; i < this.players.length; i++) {
                playersInGame = playersInGame || this.players[i].inGame;
            }

            const waitReason = $("#msg-wait-reason");

            if (this.isLeader) {
                waitReason.html(
                    `${
                        this.localization.translate(
                            "index-game-in-progress",
                        )
                    }<span> ...</span>`,
                );

                const showWaitMessage = playersInGame && !this.joiningGame;
                waitReason.css("display", showWaitMessage ? "block" : "none");
                this.playBtn.css("display", showWaitMessage ? "none" : "block");
            } else {
                if (this.roomData.findingGame || this.joiningGame) {
                    waitReason.html(
                        `<div class="ui-spinner" style="margin-right:16px"></div>${
                            this.localization.translate(
                                "index-joining-game",
                            )
                        }<span> ...</span>`,
                    );
                } else if (playersInGame) {
                    waitReason.html(
                        `${
                            this.localization.translate(
                                "index-game-in-progress",
                            )
                        }<span> ...</span>`,
                    );
                } else {
                    waitReason.html(
                        `${
                            this.localization.translate(
                                "index-waiting-for-leader",
                            )
                        }<span> ...</span>`,
                    );
                }
                waitReason.css("display", "block");
                this.playBtn.css("display", "none");
            }

            // Player properties
            const teamMembers = $("#team-menu-member-list");
            teamMembers.empty();
            for (let t = 0; t < this.roomData.maxPlayers; t++) {
                let playerStatus = {
                    name: "",
                    playerId: 0,
                    isLeader: false,
                    inGame: false,
                    self: false,
                };
                if (t < this.players.length) {
                    const player = this.players[t];
                    playerStatus = {
                        name: player.name,
                        playerId: player.playerId,
                        isLeader: player.isLeader,
                        inGame: player.inGame,
                        self: player.playerId == this.localPlayerId,
                    };
                }

                const member = $("<div/>", {
                    class: "team-menu-member",
                });

                // Left-side icon (spacer keeps name column aligned)
                if (playerStatus.isLeader) {
                    member.append(
                        $("<div/>", {
                            class: "icon icon-leader",
                            "data-playerid": playerStatus.playerId,
                        }),
                    );
                } else if (this.isLeader && playerStatus.playerId != 0) {
                    member.append(
                        $("<div/>", {
                            class: "icon icon-kick",
                            "data-playerid": playerStatus.playerId,
                        }),
                    );
                } else {
                    const spacerClass = !playerStatus.name && !playerStatus.inGame
                        ? "team-member-slot-spacer team-member-slot-spacer--empty"
                        : "team-member-slot-spacer";
                    member.append($("<div/>", { class: spacerClass }));
                }
                let n: JQuery<HTMLInputElement> | null = null;
                let c = null;
                if (this.editingName && playerStatus.self) {
                    n = $("<input/>", {
                        type: "text",
                        tabindex: 0,
                        class: "name menu-option name-text name-self-input",
                        maxLength: net.Constants.PlayerNameMaxLen,
                    });
                    n.val(playerStatus.name);
                    const m = () => {
                        const name = helpers.sanitizeNameInput(n!.val() as string);
                        playerStatus.name = name;
                        this.config.set("playerName", name);
                        this.sendMessage("changeName", {
                            name,
                        });
                        this.editingName = false;
                        this.refreshUi();
                    };
                    const h = () => {
                        this.editingName = false;
                        this.refreshUi();
                    };
                    n.on("keydown", (e) => {
                        if (e.which === 13) {
                            m();
                            return false;
                        }
                    });
                    n.on("blur", h);
                    member.append(n);
                    c = $("<div/>", {
                        class: "icon icon-submit-name-change",
                    });
                    c.on("click", m);
                    c.on("mousedown", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    });
                } else {
                    // Name
                    let nameClass = "name-text";

                    if (playerStatus.self) {
                        nameClass += " name-self";
                    }
                    if (playerStatus.inGame) {
                        nameClass += " name-in-game";
                    }
                    if (!playerStatus.name) {
                        nameClass += " name-empty";
                    }
                    const displayName = playerStatus.name
                        || this.localization.translate("index-team-open-slot");
                    const nameDiv = $("<div/>", {
                        class: `name menu-option ${nameClass}`,
                        html: helpers.htmlEscape(displayName),
                    });
                    if (playerStatus.self) {
                        nameDiv.on("click", () => {
                            this.editingName = true;
                            this.refreshUi();
                        });
                    }
                    member.append(nameDiv);
                }
                if (c) {
                    member.append(c);
                } else if (playerStatus.name || playerStatus.inGame) {
                    member.append(
                        $("<div/>", {
                            class: `icon ${playerStatus.inGame ? "icon-in-game" : ""}`,
                        }),
                    );
                } else {
                    member.append($("<div/>", { class: "team-member-slot-spacer" }));
                }
                teamMembers.append(member);
                n?.trigger("focus");
            }

            $(".icon-kick", teamMembers).on("click", (e) => {
                const playerId = Number($(e.currentTarget).attr("data-playerid"));
                this.sendMessage("kick", {
                    playerId,
                });
            });

            // Play a sound if player count has increased
            const localPlayer = this.players.find((player) => {
                return player.playerId == this.localPlayerId;
            });
            const playJoinSound = localPlayer && !localPlayer.inGame;
            if (
                !document.hasFocus()
                && this.prevPlayerCount < this.players.length
                && this.players.length > 1
                && playJoinSound
            ) {
                this.audioManager.playSound("notification_join_01", {
                    channel: "ui",
                });
            }
            this.prevPlayerCount = this.players.length;
        }
    }
}
