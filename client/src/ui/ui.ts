import $ from "jquery";
import * as PIXI from "pixi.js-legacy";

import { PingDefs } from "../../../shared/defs/gameObjects/pingDefs.ts";
import type { RoleDef } from "../../../shared/defs/gameObjects/roleDefs.ts";
import type { MapDef } from "../../../shared/defs/mapDefs.ts";
import { formatSpecOpsContractHud } from "../../../shared/defs/maps/specOpsContracts.ts";
import {
    parseSpecOpsDifficulty,
    shopApproachBlocked,
    SpecOpsAllyRoles,
    SpecOpsBreakFlag,
    specOpsBuybackCost,
    specOpsBuybackSku,
    specOpsCanBuySelfRevive,
    specOpsEventBossForWave,
    SpecOpsJoinLockFlag,
    SpecOpsMaxHealth,
    SpecOpsMaxSupportUnits,
    specOpsPerkShopRefund,
    specOpsScalePrice,
    specOpsSelfReviveAllowed,
    specOpsSelfReviveCost,
    SpecOpsSelfReviveSku,
    SpecOpsShopBySku,
    SpecOpsShopCatalog,
    SpecOpsShopRange,
    specOpsShopStationItems,
    type SpecOpsStation,
    specOpsStationFromType,
    specOpsStationUnlocked,
    SpecOpsStationUnlockWave,
    specOpsUnpackBreakVotes,
    specOpsUnequipSku,
} from "../../../shared/defs/maps/specOpsShop.ts";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { Action, GameConfig, GasMode, HudTeammateSlots, TeamMode } from "../../../shared/gameConfig.ts";
import type { PlayerStatsMsg } from "../../../shared/net/playerStatsMsg.ts";
import { SpectateAction } from "../../../shared/net/spectateMsg.ts";
import type { MapIndicator, PlayerStatus } from "../../../shared/net/updateMsg.ts";
import { coldet } from "../../../shared/utils/coldet.ts";
import { math } from "../../../shared/utils/math.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { AudioManager } from "../audioManager.ts";
import type { Camera } from "../camera.ts";
import { device } from "../device.ts";
import { errorLogManager } from "../errorLogs.ts";
import type { Game } from "../game.ts";
import { type Gas, GasRenderer, GasSafeZoneRenderer } from "../gas.ts";
import { helpers } from "../helpers.ts";
import type { InputBinds, InputBindUi } from "./../inputBinds.ts";
import type { SoundHandle } from "../lib/createJS.ts";
import type { Map } from "../map.ts";
import { MapIndicatorBarn } from "../objects/mapIndicator.ts";
import { type MapSprite, MapSpriteBarn } from "../objects/mapSprite.ts";
import type { ParticleBarn } from "../objects/particles.ts";
import type { PlaneBarn } from "../objects/plane.ts";
import type { Player, PlayerBarn } from "../objects/player.ts";
import { SDK } from "../sdk/sdk.ts";
import type { Localization } from "./localization.ts";
import { PieTimer } from "./pieTimer.ts";
import type { Touch } from "./touch.ts";
import type { UiManager2 } from "./ui2.ts";

function humanizeTime(time: number) {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor(time / 60) % 60;
    const seconds = Math.floor(time) % 60;
    let timeText = "";
    if (hours > 0) {
        timeText += `${hours}h `;
    }
    if (hours > 0 || minutes > 0) {
        timeText += `${minutes}m `;
    }
    return (timeText += `${seconds}s`);
}

function Interpolate(start: number, end: number, steps: number, count: number) {
    const f = start + ((end - start) / steps) * count;
    return Math.floor(f);
}

const TeammateHudColors = [
    "yellow",
    "purple",
    "cyan",
    "orange",
    "blue",
    "red",
    "green",
    "white",
] as const;

/** Clone extra teammate bars / map indicators so maxSquadSize up to 8 has HUD slots. */
function ensureTeammateHudSlots(slotCount: number) {
    const teamRoot = document.getElementById("ui-team");
    if (teamRoot) {
        const members = teamRoot.querySelectorAll(".ui-team-member");
        const template = members[0];
        if (template) {
            for (let i = members.length; i < slotCount; i++) {
                const clone = template.cloneNode(true) as HTMLElement;
                clone.setAttribute("data-id", String(i));
                const color = clone.querySelector(".ui-team-member-color");
                if (color) {
                    color.className = `ui-team-member-color ui-background-${
                        TeammateHudColors[i % TeammateHudColors.length]
                    }`;
                }
                teamRoot.appendChild(clone);
            }
        }
    }

    const indicators = document.getElementById("ui-team-indicators");
    if (!indicators) return;
    const mains = indicators.querySelectorAll(".ui-indicator-main");
    const mainTemplate = mains[0];
    if (mainTemplate) {
        for (let i = mains.length; i < slotCount; i++) {
            const clone = mainTemplate.cloneNode(true) as HTMLElement;
            clone.setAttribute("data-id", String(i));
            const pos = clone.querySelector(".ui-team-indicator-pos");
            if (pos) {
                pos.className = `ui-team-indicator-pos ui-background-${
                    TeammateHudColors[i % TeammateHudColors.length]
                }`;
            }
            indicators.appendChild(clone);
        }
    }

    const pings = indicators.querySelectorAll(".ui-indicator-ping");
    const pingTemplate = pings[0];
    const borderTemplate = indicators.querySelector(".ui-indicator-ping-border");
    if (!pingTemplate) return;
    for (let i = pings.length; i < slotCount; i++) {
        const ping = pingTemplate.cloneNode(true) as HTMLElement;
        ping.setAttribute("data-id", String(i));
        indicators.appendChild(ping);
        if (borderTemplate) {
            const border = borderTemplate.cloneNode(true) as HTMLElement;
            border.setAttribute("data-id", String(i));
            indicators.appendChild(border);
        }
    }
}

class Color {
    constructor(
        public r: number,
        public g: number,
        public b: number,
    ) {}

    getColors() {
        return {
            r: this.r,
            g: this.g,
            b: this.b,
        };
    }
}

interface ContainerWithMask extends PIXI.Container {
    mask: PIXI.Graphics;
}

type PrevStatus = Pick<PlayerStatus, "downed" | "dead" | "disconnected" | "role">;
export class UiManager {
    m_pieTimer = new PieTimer();
    gameElem = $("#ui-game");
    statsMain = $("#ui-stats");
    statsElem = $("#ui-stats-bg");
    statsContentsContainer = $("#ui-stats-contents");
    statsContents = $("#ui-stats-contents-inner");
    statsHeader = $("#ui-stats-header");
    statsInfoBox = $("#ui-stats-info-box");
    statsOptions = $("#ui-stats-options");
    statsAds = $(".ui-stats-ad-container");
    statsLogo = $("#ui-stats-logo");
    escMenuElem = $("#ui-game-menu");
    escMenuDisplayed = false;
    roleMenuElemWrapper = $("#ui-role-menu-wrapper");
    roleMenuElem = $("#ui-role-menu");
    roleMenuFooterEnterElem = $("#ui-role-footer-enter");
    roleMenuFooterHtml = "";
    roleMenuActive = false;
    roleMenuDisplayed = false;
    roleMenuTicker = 0;
    roleDisplayed = "";
    roleSelected = "";
    roleMenuConfirm = $("#ui-role-footer-enter");
    specOpsBuySku = "";
    /** Pending map target for airstrike / care package. */
    specOpsBuyPos: { x: number; y: number } | null = null;
    specOpsMapTargetSku = "";
    specOpsShopOpen = false;
    specOpsHudElem = $("#ui-specops-hud");
    specOpsWaveElem = $("#ui-specops-wave");
    specOpsHostilesElem = $("#ui-specops-hostiles");
    specOpsPhaseElem = $("#ui-specops-phase");
    specOpsContractElem = $("#ui-specops-contract");
    specOpsShopElem = $("#ui-specops-shop");
    specOpsShopTitle = $("#ui-specops-shop-title");
    specOpsShopItems = $("#ui-specops-shop-items");
    specOpsCashElem = $("#ui-specops-cash");
    specOpsBuybackElem = $("#ui-specops-buyback");
    specOpsSupportElem = $("#ui-specops-support");
    specOpsWaitElem = $("#ui-specops-wait");
    specOpsWaitCostElem = $("#ui-specops-wait-cost");
    lastSpecOpsStation: SpecOpsStation | undefined;
    lastSpecOpsDeadKey = "";
    lastSpecOpsPerkKey = "";
    lastSpecOpsSupportHtml = "";
    lastSpecOpsWaiting = false;
    lastSpecOpsJoinLocked = false;
    /** Long break every 5th wave: skip votes in / votes needed. */
    specOpsOnBreak = false;
    specOpsBreakReady = 0;
    specOpsBreakNeeded = 0;
    private lastSpecOpsShopTapMs = 0;
    onSpecOpsShopWheel = (e: WheelEvent) => {
        if (!this.specOpsShopOpen) return;
        const shop = this.specOpsShopElem[0];
        if (!shop || !shop.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopPropagation();
        const items = this.specOpsShopItems[0];
        if (items) items.scrollTop += e.deltaY;
    };

    private specOpsDifficulty() {
        return parseSpecOpsDifficulty(this.game.m_config.get("teamDifficulty"));
    }

    roleMenuInst: SoundHandle | null = null;
    topLeft = $("#ui-top-left");
    waitingForPlayers = true;
    waitingText = $("#ui-waiting-text");
    spectating = false;
    prevSpectatorCount = 0;
    spectatorCount = 0;
    spectatorCounterDisplayed = false;
    spectatorCounterContainer = $("#ui-spec-counter");
    spectatorCounter = $("#ui-spec-counter-number");
    spectateMode = $(".ui-spectate-mode");
    spectatedPlayerText = $("#ui-spectate-text");
    spectatedPlayerName = "";
    spectatedPlayerId = 0;
    spectateModeStats = $("#ui-spectate-stats");
    spectateModeStatsData = $("#ui-spectate-stats-data");
    spectateOptionsWrapper = $("#ui-spectate-options-wrapper");
    rightCenter = $("#ui-right-center");
    leaderboardAlive = $("#ui-leaderboard-alive");
    playersAlive = $(".js-ui-players-alive");
    playersAliveCounter = 0;
    leaderboardAliveFaction = $("#ui-leaderboard-alive-faction");
    playersAliveRed = $(".js-ui-players-alive-red");
    playersAliveBlue = $(".js-ui-players-alive-blue");
    playersAliveRedCounter = 0;
    playersAliveBlueCounter = 0;
    playerKills = $(".js-ui-player-kills");
    announcement = $("#ui-announcement");
    killLeaderName = $("#ui-kill-leader-name");
    killLeaderCount = $("#ui-kill-leader-count");
    mapContainer = $("#ui-map-container");
    mapContainerBottom = 52;
    mapInfo = $("#ui-map-info");
    mapInfoBottom = 218;
    gasState = {} as {
        mode: number;
        time: number;
    };

    gasIcon = $("#ui-gas-icon");
    gasTimer = $("#ui-gas-timer");
    mapMinimizeButton = $("#ui-map-minimize");
    menuDisplayButton = $("#ui-menu-display");
    bottomCenterRight = $("#ui-bottom-center-right");

    actionSeq = -1;
    displayMapDirty = false;
    displayMapClear = false;

    // In-game menu
    gameTabs = $(".ui-game-tab");
    gameTabBtns = $(".btn-game-tab-select");
    gameKeybindBtns = $(".btn-keybind-desc");
    currentGameTab = "settings";

    onTouchScreen!: (e: any) => void;

    bigmap = $("#big-map");
    bigmapCollision = $("#big-map-collision");
    bigmapClose = $("#big-map-close");
    moveStyleButton = $("#btn-game-move-style");
    aimLineButton = $("#btn-game-aim-line");
    aimStyleButton = $("#btn-game-aim-style");

    fullScreenButton = $("#btn-game-fullscreen");
    resumeButton = $("#btn-game-resume");

    specStatsButton = $("#btn-spectate-view-stats");
    specQuitButton = $("#btn-spectate-quit");
    specAction = SpectateAction.None;
    specNextButton = $("#btn-spectate-next-player");
    specPrevButton = $("#btn-spectate-prev-player");

    // Touch specific buttons
    interactionElems = $("#ui-interaction-press, #ui-interaction");
    interactionTouched = false;

    reloadElems = $("#ui-current-clip, #ui-remaining-ammo, #ui-reload-button-container");

    reloadTouched = false;
    lockLobbyTouched = false;

    // Faction flair display
    flairElems = $(".ui-health-flair");
    flairId = 0;

    // Health bar values
    healthRed = new Color(255, 0, 0);
    healthDarkpink = new Color(255, 45, 45);
    healthLightpink = new Color(255, 112, 112);
    healthWhite = new Color(255, 255, 255);
    healthGrey = new Color(179, 179, 179);

    // Store minimap hidden
    minimapDisplayed = true;

    // Store UI visibility mode
    visibilityMode = 0;
    hudVisible = true;

    gasRenderer!: GasRenderer;
    gasSafeZoneRenderer = new GasSafeZoneRenderer();
    sentAdStatus = false;
    frame = 0;
    weapsDirty = false;
    weapSwitches = $("#ui-weapon-id-1, #ui-weapon-id-2");
    weapNoSwitches = $("#ui-weapon-id-3, #ui-weapon-id-4");
    weapDraggedId = 0;
    swapWeapSlots = false;
    weapDraggedDiv: JQuery<HTMLElement> | null = null;
    weapDragging = false;
    weapDropped = false;

    mapSpriteBarn = new MapSpriteBarn();
    mapIndicatorBarn!: MapIndicatorBarn;
    playerMapSprites: MapSprite[] = [];
    playerPingSprites = {} as Record<number, MapSprite[]>;
    container = new PIXI.Container() as ContainerWithMask;

    resetWeapSlotStyling!: () => void;
    display: {
        gas: PIXI.DisplayObject;
        gasSafeZone: PIXI.Container;
        airstrikeZones: PIXI.Container;
        mapSprites: PIXI.Container;
        teammates: PIXI.Container;
        player: PIXI.Container;
        border: PIXI.Graphics;
    };

    mapSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
    bigmapDisplayed = false;
    screenScaleFactor = 1;
    minimapPos!: Vec2;

    dead = false;
    lastSpecOpsWave = -1;
    lastSpecOpsContractCode = -1;

    // Audio
    muteButton = $("#ui-mute-ingame");
    muteButtonImage!: JQuery<HTMLImageElement>;
    muteOffImg = "audio-off.img";
    muteOnImg = "audio-on.img";

    displayingStats = false;
    teamMemberHealthBarWidth!: number;

    teamMemberHeight = 48;
    groupPlayerCount = 0;
    teamSelectors: Array<{
        teamNameHtml: string;
        groupId: JQuery<HTMLElement>;
        groupIdDisplayed: boolean;
        teamName: JQuery<HTMLElement>;
        teamIcon: JQuery<HTMLElement>;
        teamStatus: JQuery<HTMLElement>;
        teamHealthInner: JQuery<HTMLElement>;
        teamArmorInner: JQuery<HTMLElement>;
        teamBoostInner: JQuery<HTMLElement>;
        teamArmorBar: JQuery<HTMLElement>;
        teamBoostBar: JQuery<HTMLElement>;
        teamColor: JQuery<HTMLElement>;
        teamBuyback: JQuery<HTMLElement>;
        playerId: number;
        prevHealth: number;
        prevArmor: number;
        prevBoost: number;
        prevStatus: PrevStatus;
        indicators: Record<
            string,
            {
                elem: JQuery<HTMLElement>;
                displayed: boolean;
                displayAll?: boolean;
            }
        >;
    }> = [];

    displayOldMapSprites = false;

    constructor(
        public game: Game,
        public audioManager: AudioManager,
        public particleBarn: ParticleBarn,
        public planeBarn: PlaneBarn,
        public localization: Localization,
        public canvasMode: boolean,
        public touch: Touch,
        public inputBinds: InputBinds,
        public inputBindUi: InputBindUi,
    ) {
        this.roleMenuConfirm.on("click", (e) => {
            e.stopPropagation();
            this.roleSelected = this.roleDisplayed;
            this.setRoleMenuActive(false);
        });

        $("#ui-map-wrapper").css("display", "block");
        $("#ui-team").css("display", "block");

        $(".ui-map-expand").on("mousedown", (e) => {
            e.stopPropagation();
        });
        $(".ui-map-expand").on("click", (_e) => {
            if (device.touch) {
                if (!this.bigmapDisplayed) {
                    this.displayMapLarge();
                }
            } else if (device.uiLayout == device.UiLayout.Lg) {
                this.displayMapLarge(this.bigmapDisplayed);
            }
        });
        $("#ui-map-minimize").on("mousedown", (e) => {
            e.stopPropagation();
        });
        $("#ui-map-minimize").on("click", (e) => {
            e.stopPropagation();
            this.toggleMiniMap();
        });
        $("#ui-menu-display").on("click", (e) => {
            e.stopPropagation();
            this.toggleEscMenu();
        });

        this.moveStyleButton.on("touchstart", () => {
            touch.toggleMoveStyle();
        });
        this.aimStyleButton.on("touchstart", () => {
            touch.toggleAimStyle();
        });
        this.aimLineButton.on("touchstart", () => {
            touch.toggleAimLine();
        });
        this.onTouchScreen = (e: Event) => {
            if ((e.target as HTMLElement)?.id == "cvs") {
                this.toggleEscMenu(true);
            }
        };
        $(document).on("touchstart", this.onTouchScreen);
        this.bigmapClose = $("#big-map-close");
        this.bigmapClose.on("touchend", (e) => {
            e.stopPropagation();
            this.displayMapLarge(true);
        });
        this.bigmapClose.on("mousedown", (e) => {
            e.stopPropagation();
        });
        this.bigmapClose.on("click", (e) => {
            e.stopPropagation();
            this.displayMapLarge(true);
        });

        this.gameTabBtns.on("click", (e) => {
            this.setCurrentGameTab($(e.target).data("tab"));
        });
        this.setCurrentGameTab(this.currentGameTab);

        this.fullScreenButton.on("mousedown", (e) => {
            e.stopPropagation();
        });
        this.fullScreenButton.on("click", () => {
            helpers.toggleFullScreen();
            this.toggleEscMenu();
        });

        // Display full screen
        $("#btn-game-fullscreen").css("display", SDK.isAnySDK ? "none" : "block");

        this.resumeButton.on("mousedown", (e) => {
            e.stopPropagation();
        });
        this.resumeButton.on("click", () => {
            this.toggleEscMenu();
        });
        if (device.touch) {
            this.resumeButton.css("display", "none");
        }
        $("#btn-spectate-quit").on("click", () => {
            this.quitGame();
        });
        $("#btn-game-quit").on("mousedown", (e) => {
            e.stopPropagation();
        });
        $("#btn-game-quit").on("click", () => {
            this.game.m_updatePass = true;
            this.game.m_updatePassDelay = 1;
            this.quitGame();
        });
        this.specStatsButton.on("click", () => {
            this.toggleLocalStats();
        });

        this.specNextButton.on("click", () => {
            this.specAction = SpectateAction.Next;
        });
        this.specPrevButton.on("click", () => {
            this.specAction = SpectateAction.Prev;
        });

        // Touch specific buttons
        this.interactionElems.css("pointer-events", "auto");
        this.interactionElems.on("touchstart", (e) => {
            e.stopPropagation();
            this.interactionTouched = true;
        });

        this.reloadElems.css("pointer-events", "auto");
        this.reloadElems.on("touchstart", (e) => {
            e.stopPropagation();
            this.reloadTouched = true;
        });

        if (device.touch) {
            this.specOpsPhaseElem.on("touchstart", (e) => {
                if (!this.game.m_map?.specOpsMode) return;
                e.preventDefault();
                e.stopPropagation();
                this.lockLobbyTouched = true;
            });
        }

        this.gasRenderer = new GasRenderer(canvasMode, 0x000000);

        this.resetWeapSlotStyling = () => {
            if (this.weapDraggedDiv) {
                this.weapSwitches.css({
                    left: "",
                    top: "",
                });
                $("#ui-game").css({
                    "pointer-events": "",
                });
            }
            this.weapDraggedDiv = null;
            this.weapDragging = false;
            this.weapDropped = false;
            if (this.weapSwitches.hasClass("ui-weapon-dragged")) {
                this.weapSwitches.removeClass("ui-weapon-dragged");
            }
            if (!this.weapNoSwitches.hasClass("ui-outline-hover")) {
                this.weapNoSwitches.addClass("ui-outline-hover");
            }
        };
        if (!device.touch) {
            this.weapSwitches.on("mousedown", (e) => {
                const elem = e.currentTarget;
                if (e.button == 0) {
                    this.weapDraggedDiv = $(elem);
                    this.weapDraggedId = $(elem).data("slot");
                }
            });
            $("#ui-game").on("mousemove", (e) => {
                if (this.weapDraggedDiv && !this.weapDropped) {
                    if (this.weapDragging) {
                        this.weapDraggedDiv.css({
                            left: e.pageX - 80,
                            top: e.pageY - 30,
                        });
                        this.weapDraggedDiv.addClass("ui-weapon-dragged");
                    } else {
                        $("#ui-game").css({
                            "pointer-events": "initial",
                        });
                        this.weapNoSwitches.removeClass("ui-outline-hover");
                        this.weapDragging = true;
                    }
                }
            });
            $("#ui-game, #ui-weapon-id-1, #ui-weapon-id-2").on("mouseup", (e) => {
                if (e.button == 0 && this.weapDraggedDiv != null) {
                    this.weapSwitches.each(() => {
                        const id = $(e.currentTarget).data("slot");
                        if ($(e.currentTarget).is(":hover") && this.weapDraggedId != id) {
                            this.swapWeapSlots = true;
                            this.weapDropped = true;
                        }
                    });
                    if (!this.swapWeapSlots) {
                        this.resetWeapSlotStyling();
                    }
                }
            });
        }
        this.mapIndicatorBarn = new MapIndicatorBarn(this.mapSpriteBarn);

        this.container.mask = new PIXI.Graphics();

        this.display = {
            gas: this.gasRenderer.display!,
            gasSafeZone: this.gasSafeZoneRenderer.display,
            airstrikeZones: planeBarn.airstrikeZoneContainer,
            mapSprites: this.mapSpriteBarn.container,
            teammates: new PIXI.Container(),
            player: new PIXI.Container(),
            border: new PIXI.Graphics(),
        };

        this.mapSprite.anchor = new PIXI.Point(0.5, 0.5) as PIXI.ObservablePoint;
        this.container.addChild(this.mapSprite);
        this.container.addChild(this.display.gas);
        this.container.addChild(this.display.gasSafeZone);
        this.container.addChild(this.display.airstrikeZones);
        this.container.addChild(this.display.mapSprites);
        this.container.addChild(this.display.teammates);
        this.container.addChild(this.display.player);
        this.container.addChild(this.display.border);

        const minimapMargin = this.getMinimapMargin();
        const minimapSize = this.getMinimapSize();
        this.minimapPos = v2.create(
            minimapMargin + minimapSize / 2,
            game.m_camera.m_screenHeight - minimapSize / 2 - minimapMargin,
        );

        // Audio
        this.muteButtonImage = this.muteButton.find("img");
        const muteAudio = this.audioManager.mute;
        this.muteButtonImage.attr("src", muteAudio ? this.muteOffImg : this.muteOnImg);
        this.muteButton.on("mousedown", (e) => {
            e.stopPropagation();
        });

        this.muteButton.on("click", (_e) => {
            let muteAudio = this.audioManager.muteToggle();
            this.muteButtonImage.attr(
                "src",
                muteAudio ? this.muteOffImg : this.muteOnImg,
            );
            // @ts-expect-error why assing it to null?
            muteAudio = null;
        });
        this.teamMemberHealthBarWidth = parseInt(
            $(".ui-team-member-health").find(".ui-bar-inner").css("width"),
        );

        ensureTeammateHudSlots(HudTeammateSlots);

        for (let i = 0; i < HudTeammateSlots; i++) {
            const parent = this.topLeft;
            const slotIdx = i;
            this.teamSelectors.push({
                teamNameHtml: "",
                groupId: $(parent).find(`[data-id=${slotIdx}]`),
                groupIdDisplayed: false,
                teamName: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-name"),
                teamIcon: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-icon"),
                teamStatus: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-status"),
                teamHealthInner: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-health .ui-health-actual"),
                teamArmorInner: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-armor .ui-armor-actual"),
                teamBoostInner: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-boost .ui-boost-actual"),
                teamArmorBar: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-armor"),
                teamBoostBar: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-boost"),
                teamColor: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-member-color"),
                teamBuyback: $(parent)
                    .find(`[data-id=${slotIdx}]`)
                    .find(".ui-team-buyback"),
                playerId: 0,
                prevHealth: 0,
                prevArmor: 0,
                prevBoost: 0,
                prevStatus: {
                    disconnected: false,
                    dead: false,
                    downed: false,
                    role: "",
                },
                indicators: {
                    main: {
                        elem: $("#ui-team-indicators").find(
                            `.ui-indicator-main[data-id=${slotIdx}]`,
                        ),
                        displayed: false,
                    },
                },
            });
        }
        this.topLeft.on("click", ".ui-team-buyback", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const sku = $(ev.currentTarget).attr("data-sku");
            if (sku) this.specOpsBuySku = sku;
        });
        // Fullscreen map is PIXI on #cvs — #ui-map-container is only the corner chrome.
        // Capture page-level pointers while targeting so desktop + touch can mark a drop.
        $(document).on("mousedown.specops-target", (e) => {
            this.handleSpecOpsMapTargetPointer(e);
        });
        $(document).on("touchend.specops-target", (e) => {
            this.handleSpecOpsMapTargetPointer(e);
        });
        document.addEventListener("wheel", this.onSpecOpsShopWheel, {
            capture: true,
            passive: false,
        });
        this.init();
    }

    private handleSpecOpsMapTargetPointer(
        e: JQuery.TriggeredEvent,
    ) {
        if (!this.specOpsMapTargetSku || !this.bigmapDisplayed) return;
        const target = e.target as HTMLElement | null;
        if (
            target?.closest?.(
                "#big-map-close, #ui-menu-display, .ui-settings-button, .ui-game-menu, #ui-esc-menu",
            )
        ) {
            return;
        }

        let screenPos: { x: number; y: number } | null = null;
        if (e.type === "touchend") {
            const touch = (e.originalEvent as TouchEvent | undefined)?.changedTouches?.[0];
            if (!touch) return;
            screenPos = { x: touch.pageX, y: touch.pageY };
        } else if (typeof e.pageX === "number" && typeof e.pageY === "number") {
            screenPos = { x: e.pageX, y: e.pageY };
        }
        if (!screenPos) return;

        const worldPos = this.getWorldPosFromMapPos(
            v2.create(screenPos.x, screenPos.y),
            this.game.m_map,
            this.game.m_camera,
        );
        if (!worldPos) return;

        e.preventDefault();
        e.stopPropagation();
        this.specOpsBuySku = this.specOpsMapTargetSku;
        this.specOpsBuyPos = { x: worldPos.x, y: worldPos.y };
        this.cancelSpecOpsMapTarget();
    }

    beginSpecOpsMapTarget(sku: string) {
        this.specOpsMapTargetSku = sku;
        this.specOpsBuyPos = null;
        // Shop sits above the map (z-index 30+) and would steal clicks / block the view.
        this.specOpsShopOpen = false;
        this.specOpsShopElem.css("display", "none");
        $("body").addClass("ui-specops-map-targeting");
        if (!this.bigmapDisplayed) {
            this.displayMapLarge();
        }
        const hint = sku === "specops_airstrike"
            ? (this.localization.translate("game-specops-target-airstrike")
                || "Click the map to call an airstrike (outdoors only)")
            : (this.localization.translate("game-specops-target-carepackage")
                || "Click the map to drop a care package (outdoors only)");
        this.displayAnnouncement(hint);
    }

    cancelSpecOpsMapTarget() {
        if (!this.specOpsMapTargetSku && !$("body").hasClass("ui-specops-map-targeting")) {
            return;
        }
        this.specOpsMapTargetSku = "";
        $("body").removeClass("ui-specops-map-targeting");
        if (this.bigmapDisplayed) {
            this.displayMapLarge(true);
        }
    }

    m_free() {
        this.gasRenderer.free();

        this.clearUI();

        this.roleMenuConfirm.off("click");
        $(".ui-role-option").off("click");
        $(".ui-map-expand").off("mousedown");
        $(".ui-map-expand").off("click");
        $("#ui-map-minimize").off("mousedown");
        $("#ui-map-minimize").off("click");
        $("#ui-menu-display").off("click");
        this.moveStyleButton.off("touchstart");
        this.aimStyleButton.off("touchstart");
        this.aimLineButton.off("touchstart");
        $(document).off("touchstart", this.onTouchScreen);
        this.bigmapClose.off("touchend");
        this.bigmapClose.off("mousedown");
        this.bigmapClose.off("click");
        $(document).off("mousedown.specops-target");
        $(document).off("touchend.specops-target");
        this.gameTabBtns.off("click");
        this.fullScreenButton.off("mousedown");
        this.fullScreenButton.off("click");
        this.resumeButton.off("mousedown");
        this.resumeButton.off("click");
        $("#btn-spectate-quit").off("click");
        $("#btn-game-quit").off("mousedown");
        $("#btn-game-quit").off("click");
        this.specStatsButton.off("click");
        this.specNextButton.off("click");
        this.specPrevButton.off("click");
        this.interactionElems.off("touchstart");
        this.reloadElems.off("touchstart");
        this.weapSwitches.off("mousedown");
        $("#ui-game").off("mousemove");
        $("#ui-game").off("mouseup");
        $("#ui-weapon-id-1").off("mouseup");
        $("#ui-weapon-id-2").off("mouseup");
        this.muteButton.off("mousedown");
        this.muteButton.off("click");

        // Reset team member health bar widths
        $(".ui-team-member-health")
            .find(".ui-bar-inner")
            .css("width", this.teamMemberHealthBarWidth);

        $("#ui-center").off("mouseenter mouseleave");
        this.inputBinds.menuHovered = false;
        document.removeEventListener("wheel", this.onSpecOpsShopWheel, true);

        if (!this.hudVisible) {
            this.cycleHud();
        }

        this.m_pieTimer.destroy();
        this.clearStatsElems();
        this.setRoleMenuActive(false);
        this.init();
    }

    init() {
        $(".js-ui-map-hidden").css("display", "block");
        $("#ui-map-counter-default").css("display", "inline-block");
        $("#ui-map-counter-faction").css("display", "none");
        this.flairElems.css("display", "none");
        this.clearStatsElems();
        this.setSpectating(false);
        this.updateSpectatorCountDisplay(true);
        this.resetWeapSlotStyling();
        this.dead = false;
        this.lastSpecOpsWave = -1;
        this.lastSpecOpsContractCode = -1;
        this.specOpsBuySku = "";
        this.specOpsBuyPos = null;
        this.specOpsMapTargetSku = "";
        this.specOpsShopOpen = false;
        this.lastSpecOpsStation = undefined;
        this.specOpsHudElem.css("display", "none");
        this.specOpsPhaseElem.css("display", "none").text("");
        this.specOpsContractElem.css("display", "none").text("");
        this.specOpsShopElem.css("display", "none");
        this.specOpsCashElem.text("$0");
        this.specOpsBuybackElem.css("display", "none");
        this.specOpsSupportElem.css("display", "none").empty();
        this.specOpsWaitElem.css("display", "none");
        this.lastSpecOpsDeadKey = "";
        this.lastSpecOpsPerkKey = "";
        this.lastSpecOpsSupportHtml = "";
        this.lastSpecOpsWaiting = false;
        this.lastSpecOpsJoinLocked = false;
        this.specOpsOnBreak = false;
        this.specOpsBreakReady = 0;
        this.specOpsBreakNeeded = 0;
        $("body").removeClass("ui-specops-mode");

        // Reset team selector colors
        for (let i = 0; i < this.teamSelectors.length; i++) {
            this.teamSelectors[i].teamColor.removeAttr("style");
        }
    }

    onMapLoad(map: Map, camera: Camera) {
        this.resize(map, camera);
        const specOps = !!map.getMapDef().gameMode.specOpsMode;
        const displayLeader = (map.getMapDef().gameMode.killLeaderEnabled && !specOps)
            || false;

        $("#ui-kill-leader-container").css("display", displayLeader ? "block" : "none");
        this.specOpsHudElem.css("display", specOps ? "flex" : "none");
        $("body").toggleClass("ui-specops-mode", specOps);
        if (specOps) {
            this.setWaitingForPlayers(false);
        }

        if (!device.mobile) {
            $("#ui-killfeed-wrapper").css("top", specOps ? "92px" : displayLeader ? "60px" : "12px");
        }
    }

    m_update(
        dt: number,
        player: Player,
        map: Map,
        gas: Gas,
        playerBarn: PlayerBarn,
        camera: Camera,
        teamMode: TeamMode,
        factionMode: boolean,
    ) {
        const localPlayer = player;

        if (this.weapsDirty) {
            this.resetWeapSlotStyling();
        }

        this.weapsDirty = false;
        this.mapIndicatorBarn.updateIndicatorPulses(dt);

        if (map.specOpsMode) {
            this.updateSpecOpsHud(player, map, playerBarn);
            this.updateSpecOpsWaitUi();
        }

        // Gas timer display
        const timeLeft = math.max(Math.floor(gas.duration * (1 - gas.circleT)), 0);
        const gasState = {
            mode: gas.mode,
            time: timeLeft,
        };
        if (this.gasState.mode != gasState.mode || this.gasState.time != gasState.time) {
            this.gasState = gasState;
            const gasMoving = this.gasState.mode == GasMode.Moving;
            this.mapInfo.removeClass("icon-pulse");
            this.gasIcon.removeClass("gas-icon");
            this.gasIcon.removeClass("danger-icon");

            if (gasMoving) {
                this.mapInfo.addClass("icon-pulse");
            }
            this.gasIcon.addClass(gasMoving ? "danger-icon" : "gas-icon");

            const minutes = Math.floor(this.gasState.time / 60);
            const seconds = this.gasState.time % 60;
            const strSeconds = `0${seconds}`.slice(-2);
            this.gasTimer.html(`${minutes}:${strSeconds}`);
        }

        // Spectator count display
        this.spectatorCount = player.m_localData.m_spectatorCount;
        this.updateSpectatorCountDisplay(false);

        if (player.__id === this.game.m_localId && !player.m_netData.m_dead) {
            this.dead = false;
        } else if (player.m_netData.m_dead && !this.dead) {
            this.dead = true;
            this.m_pieTimer.stop();
        }

        if (localPlayer.downed || this.dead) {
            this.resetWeapSlotStyling();
        }

        // Action pie timer
        if (
            this.actionSeq != player.m_action.seq
            && ((this.actionSeq = player.m_action.seq),
                this.m_pieTimer.stop(),
                player.m_action.type != Action.None && !this.displayingStats)
        ) {
            let desc = "";
            let actionTxt1 = "";
            let actionTxt2 = "";
            switch (player.m_action.type) {
                case Action.Reload:
                case Action.ReloadAlt:
                    if (GameObjectDefs.typeExists(player.m_action.item)) {
                        actionTxt1 = this.localization.translate("game-reloading");
                    }
                    break;
                case Action.UseItem:
                    if (GameObjectDefs.typeExists(player.m_action.item)) {
                        actionTxt1 = this.localization.translate("game-using");
                        actionTxt2 = this.localization.translate(
                            `game-${player.m_action.item}`,
                        );
                    }
                    break;
                case Action.Revive: {
                    const targetName = playerBarn.getPlayerInfo(
                        player.m_action.targetId,
                    ).name;
                    actionTxt1 = this.localization.translate("game-reviving");
                    actionTxt2 = localPlayer.downed ? "" : targetName;
                    break;
                }
            }

            if (actionTxt1 != "" || actionTxt2 != "") {
                // Change subject/verb/object order
                if (this.localization.translate("word-order") == "svo") {
                    desc += actionTxt1 || "";
                    desc += actionTxt2 ? ` ${actionTxt2}` : "";
                } else if (this.localization.translate("word-order") == "sov") {
                    desc += actionTxt2 ? `${actionTxt2} ` : "";
                    desc += actionTxt1 ? ` ${actionTxt1}` : "";
                }
                this.m_pieTimer.start(
                    desc,
                    player.m_action.time,
                    player.m_action.duration,
                );
            }
        }

        if (!this.bigmapDisplayed) {
            this.mapSprite.x = this.minimapPos.x
                + this.mapSprite.width / 2
                - (player.m_visualPos.x / map.width) * this.mapSprite.width;
            this.mapSprite.y = this.minimapPos.y
                - this.mapSprite.height / 2
                + (player.m_visualPos.y / map.height) * this.mapSprite.height;
        }

        const camExtents = v2.create(
            (camera.m_screenWidth * 0.5) / camera.m_z(),
            (camera.m_screenHeight * 0.5) / camera.m_z(),
        );
        const camAabb = {
            min: v2.sub(camera.m_pos, camExtents),
            max: v2.add(camera.m_pos, camExtents),
        };

        // Update team UI elements
        const groupId = playerBarn.getPlayerInfo(player.__id).groupId;
        const groupInfo = playerBarn.getGroupInfo(groupId);

        if (!groupInfo) {
            const err = {
                playerId: player.__id,
                groupId,
                spectating: this.spectating,
                playing: this.game.m_playingTicker,
                groupInfo: playerBarn.groupInfo,
            };
            errorLogManager.logError("badTeamInfo_1", err);
        }

        const layoutSm = device.uiLayout == device.UiLayout.Sm;
        const groupPlayerCount = Math.min(
            groupInfo?.playerIds.length ?? 0,
            this.teamSelectors.length,
        );

        for (let i = 0; i < groupPlayerCount; i++) {
            const teamElems = this.teamSelectors[i];
            if (!teamElems) continue;
            const playerId = groupInfo.playerIds[i];
            const playerInfo = playerBarn.getPlayerInfo(playerId);
            const isLocalPlayer = playerId == localPlayer.__id;
            const playerStatus = playerBarn.getPlayerStatus(playerId);
            if (playerStatus && teamMode > TeamMode.Solo) {
                if (!teamElems.groupIdDisplayed) {
                    teamElems.groupId.css("display", "block");
                    teamElems.groupIdDisplayed = true;
                }

                // Team UI
                this.updateTeam(
                    i,
                    helpers.htmlEscape(playerInfo.name),
                    playerStatus.health!,
                    playerStatus.armor ?? 0,
                    playerStatus.boost ?? 0,
                    {
                        disconnected: playerStatus.disconnected,
                        dead: playerStatus.dead,
                        downed: playerStatus.downed,
                        role: playerStatus.role,
                    },
                    playerInfo.playerId,
                    this.game.m_map.specOpsMode,
                );

                // Team indicators
                for (const key in teamElems.indicators) {
                    if (teamElems.indicators.hasOwnProperty(key)) {
                        const indicator = teamElems.indicators[key];
                        const elem = indicator.elem;
                        let hideIndicator = true;

                        if ((!isLocalPlayer || indicator.displayAll) && !factionMode) {
                            const playerPos = playerStatus.pos;
                            const dir = v2.normalizeSafe(
                                v2.sub(playerPos, camera.m_pos),
                                v2.create(1, 0),
                            );
                            const edge = coldet.intersectRayAabb(
                                camera.m_pos,
                                dir,
                                camAabb.min,
                                camAabb.max,
                            )!;
                            // fixme: find actual cause for the indicator rotation facing backwards
                            const rot = Math.atan2(dir.y, -dir.x) - Math.PI * 0.5;
                            const screenEdge = camera.m_pointToScreen(edge);
                            const onscreen = coldet.testCircleAabb(
                                playerPos,
                                GameConfig.player.radius,
                                camAabb.min,
                                camAabb.max,
                            );
                            if (!playerStatus.dead && !onscreen) {
                                let off = 32;
                                let transform = `translate(-50%, -50%) rotate(${rot}rad)`;
                                if (layoutSm) {
                                    off = 16;
                                    transform += " scale(0.5)";
                                }
                                hideIndicator = false;
                                const heightAdjust = 0;
                                elem.css({
                                    left: math.clamp(
                                        screenEdge.x,
                                        off,
                                        camera.m_screenWidth - off,
                                    ),
                                    top: math.clamp(
                                        screenEdge.y,
                                        off,
                                        camera.m_screenHeight - off - heightAdjust,
                                    ),
                                    transform,
                                });
                                if (!indicator.displayed) {
                                    elem.css("display", "block");
                                    indicator.displayed = true;
                                }
                            }
                        }
                        if (hideIndicator && indicator.displayed) {
                            elem.css("display", "none");
                            indicator.displayed = false;
                        }
                    }
                }
            }
        }
        // Hide unused elements
        for (let i = groupPlayerCount; i < this.teamSelectors.length; i++) {
            const teamElems = this.teamSelectors[i];
            if (!teamElems) continue;
            for (const key in teamElems.indicators) {
                if (teamElems.indicators.hasOwnProperty(key)) {
                    const indicator = teamElems.indicators[key];
                    if (indicator.displayed) {
                        indicator.elem.css("display", "none");
                        indicator.displayed = false;
                    }
                }
            }
            if (teamElems.groupIdDisplayed) {
                teamElems.groupId.css("display", "none");
                teamElems.groupIdDisplayed = false;
            }
        }

        // Faction specific rendering
        if (map.factionMode) {
            const localPlayerInfo = playerBarn.getPlayerInfo(localPlayer.__id);
            if (this.flairId != localPlayerInfo.teamId) {
                this.flairId = localPlayerInfo.teamId;
                // Assume red or blue for now
                const flairColor = this.flairId == GameConfig.FactionTeam.Red ? "red" : "blue";
                this.flairElems.css({
                    display: "block",
                    "background-image": `url(../img/gui/player-patch-${flairColor}.svg)`,
                });
            }
        }

        // Set the spectate options height if player count changed
        if (
            teamMode > TeamMode.Solo
            && this.groupPlayerCount != groupPlayerCount
            && device.uiLayout == device.UiLayout.Lg
        ) {
            this.groupPlayerCount = groupPlayerCount;
            this.spectateOptionsWrapper.css({
                top: this.groupPlayerCount * this.teamMemberHeight + 12,
            });
        } else if (teamMode == TeamMode.Solo) {
            this.spectateOptionsWrapper.css({
                top: 12,
            });
        }
        this.updatePlayerMapSprites(player, playerBarn, map);
        this.mapSpriteBarn.update(dt, this, map);
        this.m_pieTimer.update(dt, camera);

        // Update role selection menu
        if (this.roleMenuActive) {
            this.roleMenuTicker -= dt;

            const seconds = Math.ceil(this.roleMenuTicker);
            const html = `${this.localization.translate("game-enter-game")} (${seconds})`;
            if (html != this.roleMenuFooterHtml) {
                this.roleMenuFooterEnterElem.html(html);
                this.roleMenuFooterHtml = html;
            }
            if (
                !this.roleMenuInst
                && this.audioManager.isSoundLoaded("ambient_lab_01", "ambient")
            ) {
                this.roleMenuInst = this.audioManager.playSound("ambient_lab_01", {
                    channel: "ambient",
                });
            }
            if (this.roleMenuTicker <= 0) {
                this.roleSelected = this.roleDisplayed;
                this.setRoleMenuActive(false);
            }
        }
    }

    updatePlayerMapSprites(activePlayer: Player, playerBarn: PlayerBarn, map: Map) {
        const activePlayerInfo = playerBarn.getPlayerInfo(activePlayer.__id);

        let spriteIdx = 0;
        const addSprite = (
            pos: Vec2,
            scale: number,
            alpha: number,
            visible: boolean,
            zOrder: number,
            texture: string,
            tint: number,
        ) => {
            if (spriteIdx >= this.playerMapSprites.length) {
                const m = this.mapSpriteBarn.addSprite();
                this.playerMapSprites.push(m);
            }
            const mapSprite = this.playerMapSprites[spriteIdx++];
            mapSprite.pos = v2.copy(pos);
            mapSprite.scale = scale;
            mapSprite.alpha = alpha;
            mapSprite.visible = visible;
            mapSprite.zOrder = zOrder;
            mapSprite.sprite.texture = PIXI.Texture.from(texture);
            mapSprite.sprite.tint = tint;
        };
        const keys = Object.keys(playerBarn.playerStatus);
        for (let i = 0; i < keys.length; i++) {
            const playerStatus = playerBarn.playerStatus[keys[i] as unknown as number];
            const playerId = playerStatus.playerId!;
            const playerInfo = playerBarn.getPlayerInfo(playerId);
            const sameGroup = playerInfo.groupId == activePlayerInfo.groupId;
            let zOrder = 65535 + playerId * 2;
            if (playerId == activePlayerInfo.playerId) {
                zOrder += 65535 * 2;
            }
            const roleDef = GameObjectDefs.typeToDefSafe(playerStatus.role) as RoleDef | undefined;
            const customMapIcon = roleDef?.mapIcon;
            if (customMapIcon) {
                zOrder += 65535;
            }

            // Add the inner dot sprite
            let texture = "player-map-inner.img";
            if (customMapIcon && roleDef.mapIcon?.alive) {
                texture = roleDef.mapIcon.alive;
            }
            if (playerStatus.dead) {
                texture = "skull-outlined.img";
                if (roleDef?.mapIcon?.dead) {
                    texture = roleDef.mapIcon!.dead;
                }
            } else if (playerStatus.downed) {
                texture = sameGroup ? "player-map-inner.img" : "player-map-downed.img";
            }
            let tint = sameGroup
                ? playerBarn.getGroupColor(playerId)
                : playerBarn.getTeamColor(playerInfo.teamId);
            if (map.specOpsMode && playerInfo.teamId !== activePlayerInfo.teamId) {
                tint = 0xff3a3a;
            }
            if (map.factionMode && customMapIcon) {
                tint = playerBarn.getTeamColor(playerInfo.teamId);
            }
            const dotScale = device.uiLayout == device.UiLayout.Sm ? 0.15 : 0.2;
            let scale = dotScale;

            scale = sameGroup
                ? playerStatus.dead
                    ? dotScale * 1.5
                    : customMapIcon
                    ? dotScale * 1.25
                    : dotScale * 1
                : playerStatus.dead || playerStatus.downed || customMapIcon
                ? dotScale * 1.25
                : dotScale * 0.75;
            if (
                map.specOpsMode
                && playerInfo.teamId !== activePlayerInfo.teamId
                && !playerStatus.dead
            ) {
                scale = dotScale * 1.15;
            }

            addSprite(
                playerStatus.pos,
                scale,
                playerStatus.minimapAlpha!,
                playerStatus.minimapVisible!,
                zOrder,
                texture,
                tint,
            );

            // Add an outer sprite if this player is in our group
            if (sameGroup) {
                const scale = device.uiLayout == device.UiLayout.Sm ? 0.25 : 0.3;
                const visible = playerStatus.minimapVisible! && !customMapIcon;

                addSprite(
                    playerStatus.pos,
                    scale,
                    playerStatus.minimapAlpha!,
                    visible,
                    zOrder - 1,
                    "player-map-outer.img",
                    0xffffff,
                );
            }
        }

        // Hide any sprites that weren't used
        for (let i = this.playerMapSprites.length - 1; i >= spriteIdx; i--) {
            this.playerMapSprites[i].visible = false;
        }
    }

    getMinimapMargin() {
        if (device.uiLayout == device.UiLayout.Sm) {
            return 4;
        }
        return 16;
    }

    getMinimapSize() {
        if (device.uiLayout == device.UiLayout.Sm) {
            return 192;
        }
        return 256;
    }

    getMinimapBorderWidth() {
        if (device.uiLayout == device.UiLayout.Sm) {
            return 1;
        }
        return 4;
    }

    createPing(
        pingType: string,
        pos: Vec2,
        playerId: number,
        activePlayerId: number,
        playerBarn: PlayerBarn,
    ) {
        const pingDef = PingDefs[pingType];
        if (pingDef) {
            const createPingSprite = (scale: number, tint: number) => {
                const s = this.mapSpriteBarn.addSprite();
                s.pos = v2.copy(pos);
                s.scale = scale;
                s.lifetime = pingDef.mapLife!;
                s.pulse = false;
                s.zOrder = 100;
                s.sprite.texture = PIXI.Texture.from(pingDef.mapTexture!);
                s.sprite.tint = tint;
                return s;
            };
            const createPulseSprite = (tint: number) => {
                const s = this.mapSpriteBarn.addSprite();
                s.pos = v2.copy(pos);
                s.scale = 0;
                s.lifetime = pingDef.pingLife!;
                s.pulse = true;
                s.zOrder = 99;
                s.sprite.texture = PIXI.Texture.from("ping-map-pulse.img");
                s.sprite.tint = tint;
                return s;
            };
            if (pingDef.mapEvent) {
                // Map-event pings free themselves after they are finished;
                // there's no limit to the number that an occur simultaneously.
                const scale = (device.uiLayout == device.UiLayout.Sm ? 0.15 : 0.2) * 1.5;
                createPingSprite(scale, pingDef.tint!).release();

                createPulseSprite(pingDef.tint!).release();
            } else {
                //
                // Player pings
                //

                // Figure out which tint to use by determining if this player
                // is in our group; if they are use their group color.
                // Otherwise, use their team color.
                // Faction leaders get a special color.
                let tint = 0xffffff;
                const activePlayerInfo = playerBarn.getPlayerInfo(activePlayerId);
                const playerInfo = playerBarn.getPlayerInfo(playerId);
                const playerStatus = playerBarn.getPlayerStatus(playerId);
                if (activePlayerInfo && playerInfo && playerStatus) {
                    if (playerStatus.role == "leader") {
                        // Use a special color if they are a faction leader
                        tint = 0x00ff00;
                    } else if (activePlayerInfo.groupId == playerInfo.groupId) {
                        // Use group color
                        tint = playerBarn.getGroupColor(playerId);
                    } else {
                        // Use the team color
                        tint = playerBarn.getTeamColor(playerInfo.teamId);
                    }
                }

                // Store ping sprites per-player so we can cancel the most recent
                if (!this.playerPingSprites[playerId]) {
                    this.playerPingSprites[playerId] = [];
                }

                // Free the most recently created ping sprites
                const pingSprites = this.playerPingSprites[playerId];
                for (let i = 0; i < pingSprites.length; i++) {
                    pingSprites[i].free();
                }

                // Create new ping sprites for this player
                const scale = device.uiLayout == device.UiLayout.Sm ? 0.15 : 0.2;
                const pingSprite = createPingSprite(scale, tint);
                const pulseSprite = createPulseSprite(tint);
                pingSprites.push(pingSprite);
                pingSprites.push(pulseSprite);
            }
        }
    }

    /* not used? */
    updateMapSprite(
        mapSprite: any,
        sprite: PIXI.Sprite,
        spriteVisible: boolean,
        dt: number,
    ) {
        if (mapSprite.displayed) {
            if (mapSprite.life != undefined) {
                mapSprite.life -= dt;
                mapSprite.displayed = mapSprite.life > 0;
                // Quickfades
                if (mapSprite.maxLife - mapSprite.life < 0.1) {
                    sprite.alpha = (mapSprite.maxLife - mapSprite.life) / 0.1;
                } else if (mapSprite.life < 0.5) {
                    sprite.alpha = math.max(mapSprite.life / 0.5, 0);
                } else {
                    sprite.alpha = 1;
                }
            }
            if (mapSprite.pulse && mapSprite.displayed) {
                mapSprite.scale = mapSprite.scale + dt / 2.5;
                sprite.scale.set(mapSprite.scale, mapSprite.scale);
            }
            sprite.visible = spriteVisible && sprite.alpha > 0;
        }
    }

    updateMapIndicators(data: MapIndicator[]) {
        this.mapIndicatorBarn.updateIndicatorData(data);
    }

    getMapPosFromWorldPos(worldPos: Vec2, map: Map) {
        const xPos = this.mapSprite.x
            - this.mapSprite.width / 2
            + (worldPos.x / map.width) * this.mapSprite.width;
        const yPos = this.mapSprite.y
            + this.mapSprite.height / 2
            - (worldPos.y / map.height) * this.mapSprite.height;
        return v2.create(xPos, yPos);
    }

    getWorldPosFromMapPos(screenPos: Vec2, map: Map, camera: Camera): Vec2 {
        let insideMap = false;
        if (this.bigmapDisplayed) {
            const xBuffer = (camera.m_screenWidth - this.mapSprite.width) / 2;
            let yBuffer = (camera.m_screenHeight - this.mapSprite.height) / 2;
            if (device.uiLayout == device.UiLayout.Sm && !device.isLandscape) {
                yBuffer = 0;
            }
            insideMap = screenPos.x > xBuffer
                && screenPos.x < camera.m_screenWidth - xBuffer
                && screenPos.y > yBuffer
                && screenPos.y < camera.m_screenHeight - yBuffer;
        } else if (this.minimapDisplayed) {
            const thisMinimapSize = this.getMinimapSize();
            const thisMinimapMargin = this.getMinimapMargin();
            const minimapSize = thisMinimapSize * this.screenScaleFactor;
            const halfSize = (minimapSize + thisMinimapMargin) * 0.5;
            insideMap = screenPos.x > this.minimapPos.x - halfSize
                && screenPos.x < this.minimapPos.x + halfSize
                && screenPos.y > this.minimapPos.y - halfSize
                && screenPos.y < this.minimapPos.y + halfSize;
        }
        if (insideMap) {
            const mapOrigin = v2.create(
                this.mapSprite.x - this.mapSprite.width / 2,
                this.mapSprite.y + this.mapSprite.height / 2,
            );
            const xWorldPos = ((screenPos.x - mapOrigin.x) / this.mapSprite.width) * map.width;
            const yWorldPos = ((mapOrigin.y - screenPos.y) / this.mapSprite.height) * map.height;
            return v2.create(xWorldPos, yWorldPos);
        }
        // @ts-expect-error why? just why?
        return false;
    }

    hideAll() {
        this.gameElem.css("display", "none");
    }

    showAll() {
        this.gameElem.css("display", "block");
    }

    setLocalKills(kills: number) {
        this.playerKills.html(kills);
    }

    removeAds() {
        SDK.removeAllAds();
    }

    refreshMainPageAds() {
        const ads = ["728x90"];

        if (SDK.isCrazyGames) {
            for (let i = 0; i < ads.length; i++) {
                SDK.requestAd(ads[i]);
            }
        }

        SDK.enterMenuAdState();
    }

    clearUI() {
        this.m_pieTimer.stop();
        // @ts-expect-error not used anywhere, should be removed, I think.
        this.curAction = {
            type: Action.None,
        };
        this.displayMapLarge(true);
        this.displayMiniMap();
        this.clearStatsElems();
        this.clearTeamUI();
        this.toggleEscMenu(true);
        this.toggleLocalStats(true);
        this.visibilityMode = 0;
        this.spectatorCount = 0;
        this.setLocalKills(0);
    }

    beginSpectating() {
        this.specAction = SpectateAction.Begin;
    }

    hideStats() {
        this.displayingStats = false;
        this.statsMain.css("display", "none");
        this.statsElem.stop().css({
            display: "none",
            opacity: 0,
        });
        this.statsContents.stop().hide();
        SDK.enterGameplayAdState();
        this.updateSpecOpsWaitUi();
    }

    onLocalPlayerRevived(teamMode?: TeamMode) {
        this.hideStats();
        this.setSpectating(false, teamMode);
        this.toggleEscMenu(true);
        this.displayMapLarge(true);
        this.dead = false;
    }

    teamModeToString(teamMode: TeamMode) {
        const l10nMap = {
            unknown: "game-rank",
            [TeamMode.Solo]: "game-solo-rank",
            [TeamMode.Duo]: "game-duo-rank",
            [TeamMode.Squad]: "game-squad-rank",
        };
        const val = l10nMap[teamMode] || l10nMap.unknown;
        return this.localization.translate(val);
    }

    getTitleVictoryText(spectatingAnotherTeam: boolean, gameMode: MapDef["gameMode"]) {
        if (spectatingAnotherTeam) {
            return `${this.spectatedPlayerName} ${
                this.localization.translate(
                    "game-won-the-game",
                )
            }`;
        }
        let chickenTxt = "game-chicken";
        if (gameMode.turkeyMode) {
            chickenTxt = "game-turkey";
        }
        return this.localization.translate(chickenTxt);
    }

    getTitleDefeatText(teamMode: TeamMode, spectatingAnotherTeam: boolean, specOpsMode?: boolean) {
        if (spectatingAnotherTeam) {
            return `${this.spectatedPlayerName} ${
                this.localization.translate(
                    "game-player-died",
                )
            }.`;
        }
        if (specOpsMode) {
            return this.localization.translate("game-specops-failed");
        }
        if (teamMode > TeamMode.Solo) {
            return this.localization.translate("game-team-eliminated");
        }
        return `${
            this.localization.translate(
                "game-You",
            )
        } ${this.localization.translate("game-you-died")}.`;
    }

    getOverviewElems(
        teamMode: TeamMode,
        teamRank: number,
        teamKills: number,
        factionMode: boolean,
        specOpsMode?: boolean,
    ) {
        if (specOpsMode) {
            const waveTxt = this.localization.translate("game-specops-wave");
            const killsTxt = this.localization.translate("game-kills");
            return `<div class="ui-stats-header-right"><span class="ui-stats-header-stat">${waveTxt} </span><span class="ui-stats-header-value">${teamRank}</span></div><div class="ui-stats-header-left"><span class="ui-stats-header-stat">${killsTxt} </span><span class="ui-stats-header-value">${teamKills}</span></div>`;
        }
        if (factionMode) {
            const redTeamTxt = this.localization.translate("game-red-team");
            const blueTeamTxt = this.localization.translate("game-blue-team");
            return `<div class="ui-stats-header-right ui-stats-header-red-team"><span class="ui-stats-header-stat">${redTeamTxt} </span><span class="ui-stats-header-value">${this.playersAliveRedCounter}</span></div><div class="ui-stats-header-left ui-stats-header-blue-team"><span class="ui-stats-header-stat">${blueTeamTxt} </span><span class="ui-stats-header-value">${this.playersAliveBlueCounter}</span></div>`;
        }
        if (teamMode == TeamMode.Solo) {
            return `<div><span class="ui-stats-header-stat">${
                this.teamModeToString(
                    teamMode,
                )
            } </span><span class="ui-stats-header-value">#${teamRank}</span></div>`;
        }
        return `<div class="ui-stats-header-right"><span class="ui-stats-header-stat">${
            this.teamModeToString(
                teamMode,
            )
        } </span><span class="ui-stats-header-value">#${teamRank}</span></div><div class="ui-stats-header-left"><span class="ui-stats-header-stat">${
            this.localization.translate(
                "game-team-kills",
            )
        } </span><span class="ui-stats-header-value">${teamKills}</span></div>`;
    }

    quitGame() {
        this.game.m_gameOver = true;
        this.refreshMainPageAds();
        this.game.onQuit();
    }

    showStats(
        playerStats: Array<PlayerStatsMsg["playerStats"]>,
        teamId: number,
        teamRank: number,
        winningTeamId: number,
        gameOver: boolean,
        localTeamId: number,
        teamMode: TeamMode,
        spectating: boolean,
        playerBarn: PlayerBarn,
        _audioManager: AudioManager,
        map: Map,
        ui2: UiManager2,
    ) {
        // If we're spectating a team that's not our own, and the game isn't over yet,
        // don't display the stats screen again.
        if (!spectating || teamId == localTeamId || gameOver) {
            this.toggleEscMenu(true);
            this.displayingStats = true;
            this.m_pieTimer.stop();
            this.displayMapLarge(true);
            this.clearStatsElems();
            this.setSpectating(false, teamMode);

            this.removeAds();
            this.statsMain.css("display", "block");
            this.statsLogo.css("display", "block");

            this.statsContentsContainer.css({
                top: "",
            });
            this.statsInfoBox.css({
                height: "",
            });

            const victory = localTeamId == winningTeamId;
            const statsDelay = victory ? 1750 : 2500;

            this.setBannerAd(statsDelay, ui2);

            const isLocalTeamWinner = localTeamId == winningTeamId || (spectating && winningTeamId == teamId);
            const spectatingAnotherTeam = spectating && localTeamId != teamId;
            const S = isLocalTeamWinner
                ? this.getTitleVictoryText(
                    spectatingAnotherTeam,
                    map.getMapDef().gameMode,
                )
                : this.getTitleDefeatText(
                    teamMode,
                    spectatingAnotherTeam,
                    map.getMapDef().gameMode.specOpsMode,
                );
            let teamKills = 0;
            for (let i = 0; i < playerStats.length; i++) {
                teamKills += playerStats[i].kills;
            }
            const z = this.getOverviewElems(
                teamMode,
                teamRank,
                teamKills,
                map.getMapDef().gameMode.factionMode!,
                map.getMapDef().gameMode.specOpsMode,
            );
            const I = $("<div/>")
                .append(
                    $("<div/>", {
                        class: "ui-stats-header-title",
                        html: S,
                    }),
                )
                .append(
                    $("<div/>", {
                        class: "ui-stats-header-overview",
                        html: z,
                    }),
                );
            this.statsHeader.html(I as unknown as HTMLElement);
            const T = (e: string, t: string | number) =>
                $("<div/>", {
                    class: "ui-stats-info",
                })
                    .append(
                        $("<div/>", {
                            html: e,
                        }),
                    )
                    .append(
                        $("<div/>", {
                            html: t,
                        }),
                    );
            const M = device.uiLayout != device.UiLayout.Sm || device.tablet ? 250 : 125;
            let P = 0;
            P -= ((playerStats.length - 1) * M) / 2;
            P -= (playerStats.length - 1) * 10;
            for (let C = 0; C < playerStats.length; C++) {
                const stats = playerStats[C];
                const playerInfo = playerBarn.getPlayerInfo(stats.playerId);
                const D = humanizeTime(stats.timeAlive);
                let E = "ui-stats-info-player";
                E += stats.dead ? " ui-stats-info-status" : "";
                const B = ((e) =>
                    $("<div/>", {
                        class: e,
                    }))(E);
                B.css("left", P);
                B.append(
                    $("<div/>", {
                        class: "ui-stats-info-player-name",
                        html: helpers.htmlEscape(playerInfo.name),
                    }),
                );
                B.append(T(this.localization.translate("game-kills"), `${stats.kills}`))
                    .append(
                        T(
                            this.localization.translate("game-damage-dealt"),
                            stats.damageDealt,
                        ),
                    )
                    .append(
                        T(
                            this.localization.translate("game-damage-taken"),
                            stats.damageTaken,
                        ),
                    )
                    .append(T(this.localization.translate("game-survived"), D));
                if (map.getMapDef().gameMode.factionMode && gameOver) {
                    switch (C) {
                        case 1:
                            B.append(
                                $("<div/>", {
                                    class: "ui-stats-info-player-badge ui-stats-info-player-red-leader",
                                }),
                            );
                            break;
                        case 2:
                            B.append(
                                $("<div/>", {
                                    class: "ui-stats-info-player-badge ui-stats-info-player-blue-leader",
                                }),
                            );
                            break;
                        case 3: {
                            const R = playerInfo.teamId == GameConfig.FactionTeam.Red
                                ? "ui-stats-info-player-red-ribbon"
                                : "ui-stats-info-player-blue-ribbon";
                            B.append(
                                $("<div/>", {
                                    class: `ui-stats-info-player-badge ${R}`,
                                }),
                            );
                        }
                    }
                }
                this.statsInfoBox.append(B);
                P += 10;
            }
            const restartButton = $("<a/>", {
                class: "ui-stats-restart btn-green btn-darken menu-option",
                html: this.localization.translate("game-play-new-game"),
            });
            restartButton.on("click", () => {
                SDK.requestFullscreenAd(() => {
                    this.quitGame();
                });
            });
            this.statsOptions.append(restartButton);
            const alive = this.playersAliveCounter + this.playersAliveRedCounter + this.playersAliveBlueCounter;
            if (gameOver || alive === 0) {
                restartButton.css({
                    width: device.uiLayout != device.UiLayout.Sm || device.tablet
                        ? 225
                        : 130,
                });
            } else {
                restartButton.css({
                    left: device.uiLayout != device.UiLayout.Sm || device.tablet
                        ? -72
                        : -46,
                });
                const q = $("<a/>", {
                    class: "btn-green btn-darken menu-option ui-stats-spectate",
                    html: this.localization.translate("game-spectate"),
                });
                q.on("click", this.beginSpectating.bind(this));
                this.statsOptions.append(q);
            }

            let elemIdx = 0;
            const elemFadeTime = 500;
            const elemDelay = 250 / math.max(1, playerStats.length);
            const baseDelay = 750 / math.max(1, playerStats.length);
            this.statsInfoBox.children().each((idx, elem) => {
                const e = $(elem);
                e.css("opacity", 0);
                e.delay(statsDelay + baseDelay + (elemIdx + idx) * elemDelay).animate(
                    {
                        opacity: 1,
                    },
                    elemFadeTime,
                    () => {
                        e.children().each((idx, elem) => {
                            $(elem)
                                .delay(idx * elemDelay)
                                .animate(
                                    {
                                        opacity: 1,
                                    },
                                    elemFadeTime,
                                );
                        });
                    },
                );
                e.children().each((_idx, elem) => {
                    $(elem).css("opacity", 0);
                    elemIdx++;
                });
                elemIdx++;
            });

            this.statsOptions.children().each((idx, elem) => {
                const e = $(elem);
                e.hide();
                const delay = statsDelay + baseDelay + (elemIdx + idx) * elemDelay + 500;
                e.delay(delay).fadeIn(elemFadeTime);
                elemIdx++;
            });

            this.statsElem.stop();
            this.statsElem.css("display", "block");
            this.statsElem.delay(statsDelay).animate(
                {
                    opacity: 1,
                },
                1000,
            );

            this.statsContents.stop();
            this.statsContents.css("display", "block");
            this.statsContents.delay(statsDelay).animate(
                {
                    opacity: 1,
                },
                1000,
            );
        }
    }

    clearStatsElems() {
        this.statsHeader.empty();
        this.statsInfoBox.empty();
        this.statsOptions.empty();
        this.statsAds.css("display", "none");
        this.statsContents.stop();
        this.statsContents.css({
            display: "none",
            opacity: 0,
        });
        this.statsElem.stop();
        this.statsElem.css({
            display: "none",
            opacity: 0,
        });
        this.statsMain.css("display", "none");
    }

    showTeamAd(playerStats: PlayerStatsMsg["playerStats"], _ui2Manager: unknown) {
        this.toggleEscMenu(true);
        this.displayMapLarge(true);
        this.clearStatsElems();
        this.statsMain.css("display", "block");
        this.statsLogo.css("display", "none");
        this.m_pieTimer.stop();
        this.displayingStats = true;

        const specOps = this.game.m_map.specOpsMode;
        const buybackCost = specOpsBuybackCost(
            Math.max(this.lastSpecOpsWave, 0),
            this.specOpsDifficulty(),
        );
        const title = specOps
            ? this.localization.translate("game-specops-wait-title")
            : `${this.localization.translate("game-You")} ${this.localization.translate("game-you-died")}.`;
        const overview = specOps
            ? `<div class="ui-specops-wait-overview">${this.localization.translate("game-specops-wait-desc")} ${
                this.localization.translate("game-specops-wait-cost")
            } $${buybackCost}.</div>`
            : `<div><span class="ui-stats-header-stat">${
                this.localization.translate("game-kills")
            } </span><span class="ui-stats-header-value">${playerStats.kills}</span></div>`;

        this.statsHeader.empty().append(
            $("<div/>")
                .append(
                    $("<div/>", {
                        class: "ui-stats-header-title",
                        html: title,
                    }),
                )
                .append(
                    $("<div/>", {
                        class: specOps ? "" : "ui-stats-header-overview",
                        html: overview,
                    }),
                ),
        );
        this.statsContentsContainer.css({
            top: "10%",
        });
        this.statsInfoBox.css({
            height: 0,
        });
        const primary = $("<a/>", {
            class: "ui-stats-restart btn-green btn-darken menu-option",
            html: this.localization.translate(
                specOps ? "game-specops-wait-spectate" : "game-play-new-game",
            ),
        });
        if (specOps) {
            primary.on("click", this.beginSpectating.bind(this));
        } else {
            primary.on("click", () => {
                SDK.requestFullscreenAd(() => {
                    this.quitGame();
                });
            });
        }
        this.statsOptions.append(primary);
        primary.css({
            left: device.uiLayout != device.UiLayout.Sm || device.tablet ? -72 : -46,
        });
        const secondary = $("<a/>", {
            class: "btn-green btn-darken menu-option ui-stats-spectate",
            html: this.localization.translate(
                specOps ? "game-specops-give-up" : "game-spectate",
            ),
        });
        if (specOps) {
            secondary.on("click", () => {
                SDK.requestFullscreenAd(() => {
                    this.quitGame();
                });
            });
        } else {
            secondary.on("click", this.beginSpectating.bind(this));
        }
        this.statsOptions.append(secondary);
        if (specOps) {
            const support = $("<div/>", { class: "ui-specops-wait-support-stats" });
            support.append(
                $("<a/>", {
                    class: "menu-option btn-darken ui-specops-wait-link",
                    href: "https://discord.gg/w2MDPCpYqC",
                    target: "_blank",
                    rel: "noopener",
                    html: this.localization.translate("game-specops-wait-discord"),
                }),
            );
            support.append(
                $("<a/>", {
                    class: "menu-option btn-darken ui-specops-wait-link",
                    href: "https://ko-fi.com/zeropointbruh",
                    target: "_blank",
                    rel: "noopener",
                    html: this.localization.translate("game-specops-wait-kofi"),
                }),
            );
            this.statsOptions.append(support);
        }
        let elemIdx = 0;
        const buttonDelay = specOps ? 400 : 4100;
        const fadeDelay = specOps ? 200 : 2500;

        this.statsOptions.children().each((idx, elem) => {
            const e = $(elem);
            e.hide();
            const delay = buttonDelay + (elemIdx + idx) * 300 + 300;
            e.delay(delay).fadeIn(750);
            elemIdx++;
        });

        this.statsElem.stop();
        this.statsElem.css("display", "block");
        this.statsElem.delay(fadeDelay).animate(
            {
                opacity: 1,
            },
            specOps ? 400 : 1000,
        );
        this.statsContents.stop();
        this.statsContents.css("display", "block");
        this.statsContents.delay(fadeDelay).animate(
            {
                opacity: 1,
            },
            specOps ? 400 : 1000,
        );
    }

    setBannerAd(time: number, ui2: UiManager2) {
        let delay = Math.max(time - 150, 0);
        setTimeout(() => {
            const showMobileBanner = device.mobile && !device.tablet;
            $("#ui-stats-ad-container-desktop").css(
                "display",
                showMobileBanner ? "none" : "inline-block",
            );
            $("#ui-stats-ad-container-mobile").css(
                "display",
                showMobileBanner ? "inline-block" : "none",
            );
            SDK.enterDeathAdState();

            ui2.hideKillMessage();
        }, delay);
    }

    setSpectateTarget(
        targetId: number,
        localId: number,
        teamMode: TeamMode,
        playerBarn: PlayerBarn,
    ) {
        if (targetId != this.spectatedPlayerId) {
            this.setSpectating(true, teamMode);
            const name = playerBarn.getPlayerName(targetId, localId, false);
            this.spectatedPlayerId = targetId;
            this.spectatedPlayerName = helpers.htmlEscape(name);
            this.spectatedPlayerText
                .find("#spectate-player")
                .html(this.spectatedPlayerName);
            this.actionSeq = -1;
            this.m_pieTimer.stop();
        }
    }

    setSpectating(spectating: boolean, teamMode?: TeamMode) {
        if (this.spectating != spectating) {
            this.spectating = spectating;
            if (this.spectating) {
                this.spectateMode.css("display", "block");
                $(".ui-zoom").removeClass("ui-zoom-hover");
                const hideSpec = teamMode == TeamMode.Solo;
                this.specPrevButton.css("display", hideSpec ? "none" : "block");
                this.specNextButton.css("display", hideSpec ? "none" : "block");
                this.hideStats();
            } else {
                this.spectateMode.css("display", "none");
                $(".ui-zoom").addClass("ui-zoom-hover");
            }
        }
        this.updateSpecOpsWaitUi();
    }

    updateSpecOpsPhase() {
        const gas = this.game.m_gas;
        if (!gas) return;
        const timeLeft = math.max(Math.floor(gas.duration * (1 - gas.circleT)), 0);
        const shopping = gas.mode === GasMode.Waiting && timeLeft > 0;
        if (shopping) {
            const minutes = Math.floor(timeLeft / 60);
            const seconds = `0${timeLeft % 60}`.slice(-2);
            let phase = this.lastSpecOpsWave <= 0
                ? this.localization.translate("game-specops-prepare")
                : this.localization.translate("game-specops-next-wave");
            if (this.specOpsOnBreak) {
                phase = this.localization.translate("game-specops-break");
            }
            const lockHint = this.lastSpecOpsJoinLocked
                ? this.localization.translate("game-specops-lobby-locked")
                : this.localization.translate(
                    device.touch
                        ? "game-specops-lock-lobby-touch"
                        : "game-specops-lock-lobby",
                );
            const voteHint = this.specOpsOnBreak
                ? ` · ${this.localization.translate("game-specops-break-vote")} `
                    + `${this.specOpsBreakReady}/${this.specOpsBreakNeeded}`
                : "";
            this.specOpsPhaseElem
                .text(`${phase} ${minutes}:${seconds}${voteHint} · ${lockHint}`)
                .toggleClass("ui-specops-phase-touch", device.touch && !this.lastSpecOpsJoinLocked)
                .css("display", "block");
            return;
        }
        const combat = this.localization.translate("game-specops-combat");
        const lockHint = this.lastSpecOpsJoinLocked
            ? ` · ${this.localization.translate("game-specops-lobby-locked")}`
            : "";
        this.specOpsPhaseElem
            .text(`${combat}${lockHint}`)
            .toggleClass("ui-specops-phase-touch", false)
            .css("display", "block");
    }

    updateSpecOpsContractHud(player: Player) {
        const code = player.m_localData.m_specOpsContractHud ?? 0;
        const text = formatSpecOpsContractHud(code);
        if (text) {
            this.specOpsContractElem.text(text).css("display", "block");
            if (code !== this.lastSpecOpsContractCode && this.lastSpecOpsContractCode <= 0) {
                this.displayAnnouncement(text);
            }
        } else {
            this.specOpsContractElem.css("display", "none").text("");
        }
        this.lastSpecOpsContractCode = code;
    }

    updateSpecOpsWaitUi() {
        const waiting = this.game.m_map.specOpsMode
            && this.spectating
            && !this.game.m_gameOver;
        if (!waiting) {
            if (this.lastSpecOpsWaiting) {
                this.specOpsWaitElem.css("display", "none");
                this.specQuitButton.html(this.localization.translate("game-leave-game"));
                this.lastSpecOpsWaiting = false;
            }
            return;
        }
        const cost = specOpsBuybackCost(
            Math.max(this.lastSpecOpsWave, 0),
            this.specOpsDifficulty(),
        );
        this.specOpsWaitCostElem.text(
            `${this.localization.translate("game-specops-wait-cost")} $${cost}`,
        );
        if (!this.lastSpecOpsWaiting) {
            this.specOpsWaitElem.css("display", "block");
            this.specQuitButton.html(this.localization.translate("game-specops-give-up"));
            this.lastSpecOpsWaiting = true;
        }
    }

    setLocalStats(stats: PlayerStatsMsg["playerStats"]) {
        const displayStats = {
            kills: this.localization.translate("game-kills"),
            damageDealt: this.localization.translate("game-damage-dealt"),
            damageTaken: this.localization.translate("game-damage-taken"),
            timeAlive: this.localization.translate("game-survived"),
        };

        this.spectateModeStatsData.empty();
        for (const k in displayStats) {
            if (displayStats.hasOwnProperty(k)) {
                const text = displayStats[k as keyof typeof displayStats];
                const stat = k == "timeAlive"
                    ? humanizeTime(stats[k])
                    : stats[k as keyof typeof displayStats];
                const html =
                    `<tr><td class="ui-spectate-stats-category">${text}</td><td class="ui-spectate-stats-value">${stat}</td></tr>`;
                this.spectateModeStatsData.append(html);
            }
        }
    }

    toggleLocalStats(hide = false) {
        const display = this.spectateModeStats.css("display") == "none" && !hide;
        this.spectateModeStats.css("display", display ? "inline-block" : "none");
        this.specStatsButton.html(
            display
                ? this.localization.translate("game-hide-match-stats")
                : this.localization.translate("game-view-match-stats"),
        );
    }

    updatePlayersAlive(alive: number) {
        this.playersAlive.html(alive);
        this.playersAliveCounter = alive;

        this.leaderboardAlive.css("display", "block");
        this.leaderboardAliveFaction.css("display", "none");
    }

    updatePlayersAliveRed(alive: number) {
        this.playersAliveRed.html(alive);
        this.playersAliveRedCounter = alive;

        this.leaderboardAlive.css("display", "none");
        this.leaderboardAliveFaction.css("display", "block");

        $("#ui-map-counter-default").css("display", "none");
        $("#ui-map-counter-faction").css("display", "inline-block");
    }

    updatePlayersAliveBlue(alive: number) {
        this.playersAliveBlue.html(alive);
        this.playersAliveBlueCounter = alive;

        this.leaderboardAlive.css("display", "none");
        this.leaderboardAliveFaction.css("display", "block");

        $("#ui-map-counter-default").css("display", "none");
        $("#ui-map-counter-faction").css("display", "inline-block");
    }

    updateSpecOpsHud(player: Player, map: Map, playerBarn: PlayerBarn) {
        const cash = player.m_localData.m_specOpsCash ?? 0;
        this.specOpsCashElem.text(`$${cash}`);
        this.updateSpecOpsPhase();
        this.updateSpecOpsContractHud(player);
        this.updateSpecOpsSupportHud(player, playerBarn);

        const buybackCost = specOpsBuybackCost(
            Math.max(this.lastSpecOpsWave, 0),
            this.specOpsDifficulty(),
        );
        const deadTeammates: Array<{ slot: number; name: string; sku: string }> = [];
        if (!this.spectating) {
            for (let i = 0; i < this.teamSelectors.length; i++) {
                const slot = this.teamSelectors[i];
                if (!slot.groupIdDisplayed || slot.playerId === player.__id) continue;
                if (
                    !slot.prevStatus.dead
                    && !(slot.prevStatus.downed && slot.prevStatus.disconnected)
                ) {
                    continue;
                }
                deadTeammates.push({
                    slot: i,
                    name: slot.teamNameHtml || `Teammate ${i + 1}`,
                    sku: specOpsBuybackSku(i),
                });
            }
        }

        if (this.spectating) {
            this.specOpsShopOpen = false;
            this.specOpsShopElem.css("display", "none");
            this.specOpsBuybackElem.css("display", "none").empty();
            this.specOpsSupportElem.css("display", "none");
            this.lastSpecOpsStation = undefined;
            this.lastSpecOpsDeadKey = "";
            this.lastSpecOpsPerkKey = "";
            return;
        }

        // Keep the support shop closed while the player is marking a drop on the map.
        if (this.specOpsMapTargetSku) {
            this.specOpsShopOpen = false;
            this.specOpsShopElem.css("display", "none");
            this.lastSpecOpsStation = undefined;
            this.lastSpecOpsPerkKey = "";
        }

        const deadKey = deadTeammates.map((d) => d.sku).join(",");

        const obstacles = map.m_obstaclePool.m_getPool();
        let station: SpecOpsStation | undefined;
        let bestDist = SpecOpsShopRange * SpecOpsShopRange;
        for (let i = 0; i < obstacles.length; i++) {
            const obstacle = obstacles[i];
            if (!obstacle.active || obstacle.dead) continue;
            const kind = specOpsStationFromType(obstacle.type);
            if (!kind) continue;
            const dist = v2.lengthSqr(v2.sub(obstacle.pos, player.m_pos));
            if (dist >= bestDist) continue;
            if (
                shopApproachBlocked(
                    player.m_pos,
                    obstacle.pos,
                    obstacle.__id,
                    obstacles,
                )
            ) {
                continue;
            }
            bestDist = dist;
            station = kind;
        }

        if (this.specOpsMapTargetSku) {
            // Targeting UI only — skip shop rebuild until the mark is confirmed/cancelled.
        } else if (!station) {
            this.specOpsShopOpen = false;
            this.specOpsShopElem.css("display", "none");
            this.lastSpecOpsStation = undefined;
            this.lastSpecOpsPerkKey = "";
        } else {
            const wave = Math.max(this.lastSpecOpsWave, 0);
            const unlocked = specOpsStationUnlocked(station, wave);

            const titles: Record<SpecOpsStation, string> = {
                weapon: this.localization.translate("game-specops-buy-weapons"),
                armor: this.localization.translate("game-specops-buy-armor"),
                gear: this.localization.translate("game-specops-buy-gear"),
                support: this.localization.translate("game-specops-buy-support"),
                perk: this.localization.translate("game-specops-buy-perks"),
            };
            this.specOpsShopTitle.text(
                unlocked
                    ? titles[station]
                    : `${titles[station]} — ${this.localization.translate("game-specops-locked")} (W${
                        SpecOpsStationUnlockWave[station]
                    })`,
            );

            const perkKey = player.perks.map((p) => p.type).sort().join(",");
            if (
                station !== this.lastSpecOpsStation
                || deadKey !== this.lastSpecOpsDeadKey
                || perkKey !== this.lastSpecOpsPerkKey
            ) {
                this.lastSpecOpsStation = station;
                this.lastSpecOpsDeadKey = deadKey;
                this.lastSpecOpsPerkKey = perkKey;
                const teamMode = this.game.teamMode;
                const mapName = this.game.m_map.mapName;
                const difficulty = this.specOpsDifficulty();
                const selfReviveCost = specOpsSelfReviveCost(wave, difficulty);
                const showSelfRevive = specOpsSelfReviveAllowed(difficulty)
                    && specOpsCanBuySelfRevive(player);
                const ammoItem = SpecOpsShopCatalog.find((item) => item.sku === "specops_ammo");
                const ammoCost = ammoItem
                    ? specOpsScalePrice(ammoItem.cost, difficulty)
                    : 0;
                const selfReviveItem = showSelfRevive
                    ? SpecOpsShopCatalog.find((item) => item.sku === SpecOpsSelfReviveSku)
                    : undefined;
                const items = specOpsShopStationItems(
                    station,
                    teamMode,
                    mapName,
                    player.perks.length,
                    wave,
                    difficulty,
                );
                const shopRows: Array<{
                    sku: string;
                    cost: number;
                    label: string;
                    owned?: boolean;
                    refund?: number;
                }> = [];
                for (let i = 0; i < deadTeammates.length; i++) {
                    const mate = deadTeammates[i];
                    shopRows.push({
                        sku: mate.sku,
                        cost: buybackCost,
                        label: `${this.localization.translate("game-specops-buyback")} ${mate.name}`,
                    });
                }
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    const baseLabel = item.label
                        || this.localization.translate(`game-hud-${item.sku}`)
                        || this.localization.translate(`game-${item.sku}`)
                        || item.sku;
                    const label = item.label
                        || (item.amount && item.amount > 1
                            ? `${baseLabel} (x${item.amount})`
                            : baseLabel);
                    if (station === "perk" && player.m_hasPerk(item.sku)) {
                        shopRows.push({
                            sku: specOpsUnequipSku(item.sku),
                            cost: 0,
                            label,
                            owned: true,
                            refund: specOpsPerkShopRefund(player.perks.length, difficulty),
                        });
                    } else {
                        shopRows.push({
                            sku: item.sku,
                            cost: item.cost,
                            label,
                        });
                    }
                }
                // Keep server catalog order (ammo/category groups). Owned perks float to top.
                shopRows.sort((a, b) => {
                    if (!!a.owned !== !!b.owned) return a.owned ? -1 : 1;
                    return 0;
                });
                this.specOpsShopItems.html("");
                if (!unlocked) {
                    this.specOpsShopItems.append(
                        $(
                            `<div class="ui-specops-shop-locked">${
                                this.localization.translate("game-specops-station-locked-desc")
                            }</div>`,
                        ),
                    );
                } else {
                    if (ammoItem) {
                        const label = ammoItem.label
                            || this.localization.translate(`game-hud-${ammoItem.sku}`)
                            || ammoItem.sku;
                        this.specOpsShopItems.append(
                            $(
                                `<button type="button" class="ui-specops-shop-row" data-sku="${ammoItem.sku}" data-cost="${ammoCost}"><span class="ui-specops-shop-name">${label}</span><span class="ui-specops-shop-cost">$${ammoCost}</span></button>`,
                            ),
                        );
                    }
                    if (selfReviveItem) {
                        const label = selfReviveItem.label
                            || this.localization.translate("game-self_revive")
                            || selfReviveItem.sku;
                        this.specOpsShopItems.append(
                            $(
                                `<button type="button" class="ui-specops-shop-row" data-sku="${selfReviveItem.sku}" data-cost="${selfReviveCost}"><span class="ui-specops-shop-name">${label}</span><span class="ui-specops-shop-cost">$${selfReviveCost}</span></button>`,
                            ),
                        );
                    }
                    const sellLabel = this.localization.translate("game-specops-sell");
                    for (let i = 0; i < shopRows.length; i++) {
                        const row = shopRows[i];
                        if (row.owned) {
                            this.specOpsShopItems.append(
                                $(
                                    `<button type="button" class="ui-specops-shop-row ui-specops-shop-owned" data-sku="${row.sku}" data-cost="0"><span class="ui-specops-shop-name">${row.label}</span><span class="ui-specops-shop-cost">${sellLabel} $${
                                        row.refund ?? 0
                                    }</span></button>`,
                                ),
                            );
                        } else {
                            this.specOpsShopItems.append(
                                $(
                                    `<button type="button" class="ui-specops-shop-row" data-sku="${row.sku}" data-cost="${row.cost}"><span class="ui-specops-shop-name">${row.label}</span><span class="ui-specops-shop-cost">$${row.cost}</span></button>`,
                                ),
                            );
                        }
                    }
                    this.specOpsShopItems.off("click touchend").on("click touchend", ".ui-specops-shop-row", (ev) => {
                        const row = $(ev.currentTarget);
                        if (row.hasClass("ui-specops-shop-disabled")) return;
                        const sku = row.attr("data-sku");
                        if (!sku) return;
                        // Touch: stop the game stick / touch-area from eating the press.
                        // Debounce so touchend + synthetic click don't double-buy.
                        const now = performance.now();
                        if (now - this.lastSpecOpsShopTapMs < 320) {
                            ev.preventDefault();
                            ev.stopPropagation();
                            return;
                        }
                        this.lastSpecOpsShopTapMs = now;
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (sku === "specops_airstrike" || sku === "specops_carepackage") {
                            this.beginSpecOpsMapTarget(sku);
                            return;
                        }
                        this.specOpsBuySku = sku;
                        this.specOpsBuyPos = null;
                    });
                    // Block stick capture while scrolling / tapping the shop panel.
                    this.specOpsShopElem.off("touchstart.specops-shop").on("touchstart.specops-shop", (ev) => {
                        ev.stopPropagation();
                    });
                    this.specOpsShopItems.off("touchstart.specops-shop").on("touchstart.specops-shop", (ev) => {
                        ev.stopPropagation();
                    });
                }
            }

            this.specOpsShopItems.children(".ui-specops-shop-row").each((_i, el) => {
                const row = $(el);
                const cost = Number(row.data("cost"));
                const sku = String(row.attr("data-sku") ?? "");
                const isUnequip = sku.startsWith("specops_unequip_");
                const selfReviveOwned = sku === SpecOpsSelfReviveSku && player.m_hasPerk("self_revive");
                let supportBlocked = false;
                let inventoryFull = false;
                const catalogItem = SpecOpsShopBySku[sku];
                if (catalogItem?.fillToMax) {
                    const have = player.m_localData.m_inventory[sku] || 0;
                    const mapBags = map.getMapDef().gameConfig.bagSizes as
                        | Record<string, number[]>
                        | undefined;
                    const sizes = mapBags?.[sku] ?? GameConfig.bagSizes[sku as keyof typeof GameConfig.bagSizes];
                    const bagLevel = player.m_getBagLevel();
                    const max = sizes?.[bagLevel] ?? 0;
                    inventoryFull = max > 0 && have >= max;
                }
                if (station === "support") {
                    const local = playerBarn.getPlayerInfo(player.__id);
                    let hired = 0;
                    const keys = Object.keys(playerBarn.playerStatus);
                    for (let i = 0; i < keys.length; i++) {
                        const status = playerBarn.playerStatus[keys[i] as unknown as number];
                        const playerId = status.playerId ?? Number(keys[i]);
                        if (playerId === player.__id || status.dead) continue;
                        const info = playerBarn.getPlayerInfo(playerId);
                        if (!info || info.teamId !== local.teamId) continue;
                        if (info.groupId === local.groupId) continue;
                        // Support drones share teamId but not operator groupId.
                        // Free glory helpers use fodder names — only count shop units.
                        const name = (info.name || "").toLowerCase();
                        const isSentry = name === "sentry";
                        const isAllyRole = name === "juggernaut"
                            || (SpecOpsAllyRoles as readonly string[]).some(
                                (role) => name === role.replace(/_/g, " ") || name === role,
                            );
                        if (isSentry || isAllyRole) hired++;
                    }
                    if (
                        sku === "specops_sentry"
                        || (SpecOpsAllyRoles as readonly string[]).includes(sku)
                    ) {
                        supportBlocked = hired >= SpecOpsMaxSupportUnits;
                    }
                }
                row.toggleClass(
                    "ui-specops-shop-disabled",
                    !unlocked
                        || selfReviveOwned
                        || inventoryFull
                        || (!isUnequip && (cash < cost || supportBlocked)),
                );
            });
            this.specOpsShopOpen = true;
            this.specOpsShopElem.css("display", "block");
        }

        this.lastSpecOpsDeadKey = deadKey;

        for (let i = 0; i < this.teamSelectors.length; i++) {
            const slot = this.teamSelectors[i];
            const btn = slot.teamBuyback;
            if (!btn || !btn.length) continue;
            const mate = deadTeammates.find((d) => d.slot === i);
            const show = !!mate;
            slot.groupId.toggleClass("ui-team-can-buyback", show);
            if (show && mate) {
                const buyLabel = this.localization.translate("game-specops-buyback");
                btn.text(`${buyLabel} $${buybackCost}`);
                btn.attr("data-sku", mate.sku);
                btn.css("display", "block");
                btn.toggleClass("ui-specops-shop-disabled", cash < buybackCost);
            } else {
                btn.css("display", "none");
            }
        }
        this.specOpsBuybackElem.css("display", "none");
    }

    /** Risk of Rain 2-style drone list: hired sentries/allies, not teammate slots. */
    updateSpecOpsSupportHud(player: Player, playerBarn: PlayerBarn) {
        const local = playerBarn.getPlayerInfo(player.__id);
        const rows: string[] = [];
        const seen = new Set<number>();
        const keys = Object.keys(playerBarn.playerStatus);
        for (let i = 0; i < keys.length; i++) {
            const status = playerBarn.playerStatus[keys[i] as unknown as number];
            const playerId = status.playerId ?? Number(keys[i]);
            if (seen.has(playerId) || playerId === player.__id) continue;
            const info = playerBarn.getPlayerInfo(playerId);
            if (!info || info.teamId !== local.teamId) continue;
            if (info.groupId === local.groupId) continue;
            seen.add(playerId);
            const hp = status.dead
                ? 0
                : status.downed
                ? Math.min(status.health ?? 30, 30)
                : math.clamp(status.health ?? 100, 0, 100);
            const name = helpers.htmlEscape(info.nameTruncated || info.name || "Support");
            rows.push(
                `<div class="ui-specops-drone${
                    status.dead ? " is-dead" : ""
                }"><span class="ui-specops-drone-name">${name}</span><div class="ui-specops-drone-bar"><div class="ui-specops-drone-hp" style="width:${hp}%"></div></div></div>`,
            );
        }
        const html = rows.join("");
        if (html !== this.lastSpecOpsSupportHtml) {
            this.specOpsSupportElem.html(html);
            this.lastSpecOpsSupportHtml = html;
        }
        this.specOpsSupportElem.css(
            "display",
            rows.length && !this.specOpsShopOpen ? "block" : "none",
        );
    }

    updateKillLeader(
        playerId: number,
        playerName: string,
        kills: number,
        gameMode: MapDef["gameMode"],
    ) {
        if (gameMode.specOpsMode) {
            const joinLocked = (playerId & SpecOpsJoinLockFlag) !== 0;
            const onBreak = (playerId & SpecOpsBreakFlag) !== 0;
            const wave = playerId & ~(SpecOpsJoinLockFlag | SpecOpsBreakFlag);
            this.specOpsWaveElem.text(wave <= 0 ? "—" : String(wave));
            if (onBreak) {
                // During a break the counter carries skip votes, not hostiles.
                const votes = specOpsUnpackBreakVotes(kills);
                this.specOpsBreakReady = votes.ready;
                this.specOpsBreakNeeded = votes.needed;
                this.specOpsHostilesElem.text("0");
                if (!this.specOpsOnBreak) {
                    this.displayAnnouncement(
                        this.localization.translate("game-specops-break-started"),
                    );
                }

            } 
            
            else {
                this.specOpsHostilesElem.text(String(kills));
            }

            this.specOpsOnBreak = onBreak;
            if (joinLocked && !this.lastSpecOpsJoinLocked) {
                this.displayAnnouncement(
                    this.localization.translate("game-specops-lobby-locked"),
                );
            }
            this.lastSpecOpsJoinLocked = joinLocked;
            if (wave > 0 && wave !== this.lastSpecOpsWave) {
                this.lastSpecOpsWave = wave;
                this.lastSpecOpsStation = undefined;
                let msg = `${this.localization.translate("game-specops-wave")} ${wave}`;
                if (wave === 29) {
                    msg += ` — ${this.localization.translate("game-specops-glory-horde")}`;
                }
                if (wave === 31) {
                    msg += ` — ${this.localization.translate("game-specops-veteran-forces")}`;
                }
                if (wave % 10 === 0) {
                    if (wave === 30) {
                        msg += ` — ${this.localization.translate("game-specops-glory-truce")}`;
                    } else if (wave > 30) {
                        msg += ` — ${this.localization.translate("game-specops-cobalt-boss-warn")}`;
                    } else {
                        msg += ` — ${this.localization.translate("game-specops-boss-warn")}`;
                    }
                    const eventBoss = specOpsEventBossForWave(wave);
                    if (eventBoss) {
                        const key = `game-specops-event-${eventBoss}`;
                        const label = this.localization.translate(key) || eventBoss;
                        msg += ` — ${label}`;
                    }
                } else if (wave % 7 === 0) {
                    msg += ` — ${this.localization.translate("game-specops-miniboss-warn")}`;
                }
                if (wave % 5 === 0) {
                    msg += ` — ${this.localization.translate("game-specops-vest-warn")}`;
                }
                if (wave === SpecOpsStationUnlockWave.gear) {
                    msg += ` — ${this.localization.translate("game-specops-unlock-gear")}`;
                }
                if (wave === SpecOpsStationUnlockWave.armor) {
                    msg += ` — ${this.localization.translate("game-specops-unlock-armor")}`;
                }
                if (wave === SpecOpsStationUnlockWave.perk) {
                    msg += ` — ${this.localization.translate("game-specops-unlock-perk")}`;
                }
                this.displayAnnouncement(msg);
            } else if (wave <= 0) {
                this.lastSpecOpsWave = 0;
            }
            return;
        }
        const valid = playerId != 0;
        const waitTxt = gameMode?.sniperMode
            ? this.localization.translate("game-waiting-for-hunted")
            : this.localization.translate("game-waiting-for-new-leader");
        this.killLeaderName.html(valid ? playerName : waitTxt);
        this.killLeaderCount.html(valid ? kills : 0);
    }

    displayMapLarge(clear?: boolean) {
        const wasOpen = this.bigmapDisplayed;
        this.bigmapDisplayed = !clear && !this.bigmapDisplayed;
        if (!this.bigmapDisplayed && wasOpen && this.specOpsMapTargetSku) {
            this.specOpsMapTargetSku = "";
            $("body").removeClass("ui-specops-map-targeting");
        }
        if (this.bigmapDisplayed) {
            this.container.alpha = 1;
        } else {
            this.container.alpha = this.minimapDisplayed ? 1 : 0;
        }
        let mapHidden = device.uiLayout == device.UiLayout.Sm
            ? ".js-ui-mobile-map-hidden"
            : "js-ui-desktop-map-hidden";
        mapHidden += ", .js-ui-map-hidden";
        $(this.visibilityMode == 2 ? ".js-ui-hud-show" : mapHidden).css(
            "display",
            this.bigmapDisplayed ? "none" : "block",
        );
        $(".js-ui-map-show").css("display", this.bigmapDisplayed ? "block" : "none");
        this.updateSpectatorCountDisplay(true);
        if (this.game.m_map.specOpsMode) {
            this.specOpsHudElem.css("display", this.bigmapDisplayed ? "none" : "flex");
        }
        this.redraw(this.game.m_camera);
    }

    updateSpectatorCountDisplay(dirty: boolean) {
        const displayCounter = !this.bigmapDisplayed && this.spectatorCount > 0;
        dirty = dirty
            || (this.spectatorCount > 0 && !this.spectatorCounterDisplayed)
            || (this.spectatorCount == 0 && this.spectatorCounterDisplayed);

        if (this.spectatorCount != this.prevSpectatorCount) {
            this.spectatorCounter.html(this.spectatorCount as unknown as string);
            this.prevSpectatorCount = this.spectatorCount;
        }
        if (dirty) {
            this.spectatorCounterContainer.css(
                "display",
                displayCounter ? "block" : "none",
            );
            this.spectatorCounterDisplayed = displayCounter;
        }
    }

    toggleMiniMap() {
        if (this.minimapDisplayed) {
            this.hideMiniMap();
        } else {
            this.displayMiniMap();
        }
    }

    cycleVisibilityMode() {
        if (!this.bigmapDisplayed) {
            switch (this.visibilityMode) {
                case 0:
                    this.hideMiniMap();
                    this.visibilityMode = 1;
                    break;
                case 1:
                    this.displayMiniMap();
                    this.visibilityMode = 0;
            }
        }
    }

    cycleHud() {
        if (this.gameElem.css("display") == "none") {
            this.gameElem.css("display", "block");
            this.displayMiniMap();
            this.hudVisible = true;
        } else {
            this.gameElem.css("display", "none");
            this.hideMiniMap();
            this.hudVisible = false;
        }
    }

    hideMiniMap() {
        if (!this.bigmapDisplayed) {
            this.minimapDisplayed = false;
            this.container.alpha = 0;
            this.mapInfo.css("bottom", "auto");
            this.spectatorCounterContainer.css({
                bottom: 6,
                left: 98,
            });
        }
    }

    displayMiniMap() {
        if (!this.bigmapDisplayed) {
            const layoutSm = device.uiLayout == device.UiLayout.Sm;
            this.minimapDisplayed = true;
            this.container.alpha = 1;
            this.mapInfo.css("bottom", this.mapInfoBottom);
            this.spectatorCounterContainer.css({
                bottom: layoutSm ? 0 : 218,
                left: layoutSm ? 0 : 6,
            });
        }
    }

    displayAnnouncement(message: string) {
        if (message) {
            this.announcement.html(message);
            this.announcement.fadeIn(400, () => {
                setTimeout(() => {
                    this.announcement.fadeOut(800);
                }, 3000);
            });
        }
    }

    displayGasAnnouncement(type: GasMode, timeLeft: number, specOpsMode = false) {
        // Practice has no waves, so no "next wave" / "press E" banners.
        if (this.game.m_map.getMapDef().gameMode.practiceMode) return;
        let message = "";
        switch (type) {
            case GasMode.Waiting: {
                if (specOpsMode) {
                    if (timeLeft <= 0) {
                        message = this.localization.translate("game-specops-press-e");
                        break;
                    }
                    message = this.localization.translate("game-specops-next-wave");
                    message += ` ${Math.max(Math.floor(timeLeft), 0)} ${this.localization.translate("game-seconds")}`;
                    message += this.specOpsOnBreak
                    ? ` — ${this.localization.translate("game-specops-break-vote")}`
                    : ` — ${this.localization.translate("game-specops-start-early")}`;
                    break;
                }
                message = this.localization.translate("game-red-zone-advances");
                const minutes = Math.floor(timeLeft / 60);
                const seconds = timeLeft - minutes * 60;
                message += minutes > 1
                    ? ` ${minutes} ${this.localization.translate("game-minutes")}`
                    : "";
                message += minutes == 1
                    ? ` ${minutes} ${this.localization.translate("game-minute")}`
                    : "";
                message += seconds > 0
                    ? ` ${Math.floor(seconds)} ${
                        this.localization.translate(
                            "game-seconds",
                        )
                    }`
                    : "";
                break;
            }
            case GasMode.Moving:
                message = this.localization.translate("game-red-zone-advancing");
                break;
        }
        this.displayAnnouncement(message);
    }

    setWaitingForPlayers(waiting: boolean) {
        this.waitingForPlayers = waiting;
        this.waitingText.css("display", waiting ? "block" : "none");
    }

    m_render(playerPos: Vec2, gas: Gas, map: Map, planeBarn: PlaneBarn) {
        // Gas
        const circle = gas.getCircle(1);
        const gasPos = this.getMapPosFromWorldPos(circle.pos, map);
        const gasEdge = this.getMapPosFromWorldPos(
            v2.add(circle.pos, v2.create(circle.rad, 0)),
            map,
        );
        const gasRad = v2.length(v2.sub(gasEdge, gasPos));
        this.gasRenderer.render(gasPos, gasRad, gas.isActive());

        // Gas safe zone
        const circleSafe = gas.circleNew;
        const safePos = this.getMapPosFromWorldPos(circleSafe.pos, map);
        const safeEdge = this.getMapPosFromWorldPos(
            v2.add(circleSafe.pos, v2.create(circleSafe.rad, 0)),
            map,
        );
        const safeRad = v2.length(v2.sub(safeEdge, safePos));
        const playerMapPos = this.getMapPosFromWorldPos(playerPos, map);
        const drawCircle = gas.isActive();
        const drawLine = gas.isActive() && !this.bigmapDisplayed;
        this.gasSafeZoneRenderer.render(
            safePos,
            safeRad,
            playerMapPos,
            drawCircle,
            drawLine,
        );

        planeBarn.renderAirstrikeZones(this, map);
    }

    updateHealthBar(
        _innerWidth: number,
        selectorInner: JQuery<HTMLElement>,
        selectorDepleted: JQuery<HTMLElement> | null,
        status: {
            health: number;
            dead: boolean;
            downed: boolean;
        },
    ) {
        let healthPct = status.health;
        if (healthPct > 100) {
            healthPct = math.clamp((healthPct / SpecOpsMaxHealth) * 100, 0, 100);
        } else {
            healthPct = math.clamp(healthPct, 0, 100);
        }
        const widthPct = status.dead ? 0 : healthPct > 0 ? Math.max(healthPct, 1) : 0;

        selectorInner.css("width", `${widthPct}%`);
        if (widthPct > 0) {
            selectorDepleted?.css("width", `${widthPct}%`);
        }

        const val = healthPct;
        let l = this.healthRed;
        let c = this.healthDarkpink;
        if (val > 25) {
            if (status.downed) {
                selectorInner.css({
                    backgroundColor: "red",
                });
            } else {
                if (math.eqAbs(val, 100, 0.2)) {
                    l = this.healthGrey;
                    c = this.healthGrey;
                } else if (math.eqAbs(val, 75, 0.2) || val >= 75) {
                    l = this.healthWhite;
                    c = this.healthWhite;
                } else {
                    l = this.healthDarkpink;
                    c = this.healthLightpink;
                }
                const m = l.getColors();
                const p = c.getColors();
                const h = Interpolate(m.r, p.r, 45, val);
                const d = Interpolate(m.g, p.g, 45, val);
                const u = Interpolate(m.b, p.b, 45, val);
                selectorInner.css({
                    backgroundColor: `rgba(${h},${d},${u},1)`,
                });
            }
            selectorInner.removeClass("ui-bar-danger");
        } else {
            selectorInner.addClass("ui-bar-danger");
        }
    }

    updateResourceBar(
        selectorInner: JQuery<HTMLElement>,
        percent: number,
        dead: boolean,
    ) {
        const widthPct = dead ? 0 : math.clamp(percent, 0, 100);
        selectorInner.css("width", `${widthPct}%`);
    }

    updateTeam(
        slotIdx: number,
        name: string,
        health: number,
        armor: number,
        boost: number,
        status: PrevStatus,
        playerId: number,
        specOpsMode: boolean,
    ) {
        const groupId = this.teamSelectors[slotIdx].groupId;
        const teamName = this.teamSelectors[slotIdx].teamName;
        const prevHealth = this.teamSelectors[slotIdx].prevHealth;
        const prevArmor = this.teamSelectors[slotIdx].prevArmor;
        const prevBoost = this.teamSelectors[slotIdx].prevBoost;
        const prevStatus = this.teamSelectors[slotIdx].prevStatus;

        const statusChange = status.dead != prevStatus.dead
            || status.disconnected != prevStatus.disconnected
            || status.downed != prevStatus.downed
            || status.role != prevStatus.role;
        if (
            this.teamSelectors[slotIdx].playerId != playerId
            || health != prevHealth
            || armor != prevArmor
            || boost != prevBoost
            || statusChange
        ) {
            const teamStatus = this.teamSelectors[slotIdx].teamStatus;
            const teamHealthInner = this.teamSelectors[slotIdx].teamHealthInner;
            const teamArmorInner = this.teamSelectors[slotIdx].teamArmorInner;
            const teamBoostInner = this.teamSelectors[slotIdx].teamBoostInner;
            const teamArmorBar = this.teamSelectors[slotIdx].teamArmorBar;
            const teamBoostBar = this.teamSelectors[slotIdx].teamBoostBar;
            this.teamSelectors[slotIdx].playerId = playerId;
            this.teamSelectors[slotIdx].teamNameHtml = name;
            teamName.html(name);
            this.updateHealthBar(this.teamMemberHealthBarWidth, teamHealthInner, null, {
                health,
                dead: status.dead,
                downed: status.downed,
            });
            teamArmorBar.css("display", specOpsMode ? "block" : "none");
            if (specOpsMode) {
                this.updateResourceBar(teamArmorInner, armor, status.dead);
            }
            this.updateResourceBar(teamBoostInner, boost, status.dead);
            if (statusChange) {
                teamStatus.attr("class", "ui-team-member-status");
                if (status.disconnected) {
                    teamStatus.addClass("ui-team-member-status-disconnected");
                } else if (status.dead) {
                    teamStatus.addClass("ui-team-member-status-dead");
                } else if (status.downed) {
                    teamStatus
                        .addClass("ui-team-member-status-downed")
                        .addClass("icon-pulse");
                }
                teamName.css("opacity", status.disconnected || status.dead ? 0.3 : 1);
            }
            const canBuyback = status.dead
                || (status.downed && status.disconnected);
            if (!canBuyback) {
                this.teamSelectors[slotIdx].teamBuyback.css("display", "none");
                groupId.removeClass("ui-team-can-buyback");
            }
            groupId.css("display", "block");
            this.teamSelectors[slotIdx].prevStatus = status as this["teamSelectors"][number]["prevStatus"];
            this.teamSelectors[slotIdx].prevHealth = health;
            this.teamSelectors[slotIdx].prevArmor = armor;
            this.teamSelectors[slotIdx].prevBoost = boost;
        }
    }

    clearTeamUI() {
        $(".ui-team-member").css("display", "none");
        $(".ui-team-indicator").css("display", "none");
        $(".ui-team-member-name").removeAttr("style");
        $(".ui-team-member-status").removeAttr("style");
        $(".ui-team-member-status").removeClass(
            "ui-team-member-status-downed ui-team-member-status-dead ui-team-member-status-disconnected icon-pulse",
        );
        for (let i = 0; i < this.teamSelectors.length; i++) {
            const teamElems = this.teamSelectors[i];
            teamElems.groupIdDisplayed = false;
            teamElems.playerId = 0;
            teamElems.teamNameHtml = "";
            teamElems.prevHealth = 0;
            teamElems.prevArmor = 0;
            teamElems.prevBoost = 0;
            teamElems.prevStatus = {
                disconnected: false,
                dead: false,
                downed: false,
                role: "",
            };
            for (const key in teamElems.indicators) {
                if (!teamElems.indicators.hasOwnProperty(key)) continue;
                const indicator = teamElems.indicators[key];
                indicator.displayed = false;
            }
        }
    }

    resize(map: Map, camera: Camera) {
        this.screenScaleFactor = device.uiLayout == device.UiLayout.Sm
            ? 0.5626
            : math.min(
                1,
                math.clamp(camera.m_screenWidth / 1280, 0.75, 1)
                    * math.clamp(camera.m_screenHeight / 1024, 0.75, 1),
            );
        this.m_pieTimer.resize(this.touch, this.screenScaleFactor);

        this.gasRenderer.resize();

        this.mapSprite.texture = map.getMapTexture()!;

        const roleMenuScale = math.min(
            1,
            math.min(camera.m_screenWidth / 1200, camera.m_screenHeight / 900),
        );

        this.roleMenuElem.css(
            "transform",
            `translateX(-50%) translateY(-50%) scale(${roleMenuScale})`,
        );

        this.redraw(camera);
    }

    redraw(camera: Camera) {
        const screenWidth = camera.m_screenWidth;
        const screenHeight = camera.m_screenHeight;

        const thisMinimapMargin = this.getMinimapMargin();

        let thisMinimapMarginXAdjust = 0;
        let thisMinimapMarginYAdjust = 0;

        // Squeeze in thisMinimapMarginXAdjust on iPhoneX+
        if (device.model == "iphonex") {
            if (device.isLandscape) {
                thisMinimapMarginXAdjust += 28;
            } else {
                thisMinimapMarginYAdjust += 32;
            }
        }
        const thisMinimapSize = this.getMinimapSize();
        const thisMinimapBorderWidth = this.getMinimapBorderWidth();
        const layoutSm = device.uiLayout == device.UiLayout.Sm;

        this.display.border.clear();
        this.container.mask?.clear();

        if (this.bigmapDisplayed) {
            const smallestDim = math.min(screenWidth, screenHeight);
            this.mapSprite.width = smallestDim;
            this.mapSprite.height = smallestDim;
            this.mapSprite.x = screenWidth / 2;
            this.mapSprite.y = screenHeight / 2;
            this.mapSprite.alpha = 1;
            this.container.mask.beginFill(0xffffff, 1);
            this.container.mask.drawRect(
                this.mapSprite.x - this.mapSprite.width / 2,
                this.mapSprite.y - this.mapSprite.height / 2,
                this.mapSprite.width,
                this.mapSprite.height,
            );
            this.container.mask.endFill();
            if (device.touch) {
                this.bigmapCollision.css({
                    width: screenHeight,
                    height: screenWidth,
                });
            }
        } else {
            const minimapScale = (this.screenScaleFactor * 1600) / 1.2;
            const minimapSize = thisMinimapSize * this.screenScaleFactor;

            this.mapSprite.width = minimapScale;
            this.mapSprite.height = minimapScale;
            this.mapSprite.alpha = 0.8;

            // Start with a fall back
            let scaleCss: Record<string, number | string> = {
                zoom: this.screenScaleFactor,
            };
            if (document.body) {
                if ("WebkitTransform" in document.body.style) {
                    scaleCss = {
                        "-webkit-transform": `scale(${this.screenScaleFactor})`,
                    };
                } else if ("transform" in document.body.style) {
                    scaleCss = {
                        transform: `scale(${this.screenScaleFactor})`,
                    };
                }
            }
            this.mapContainer.css(scaleCss);
            this.mapContainer.css(
                "bottom",
                this.mapContainerBottom * this.screenScaleFactor,
            );
            const minimapPosY = layoutSm
                ? minimapSize / 2 + thisMinimapMargin
                : screenHeight - minimapSize / 2 - thisMinimapMargin;
            this.minimapPos.x = thisMinimapMargin + minimapSize / 2 + thisMinimapMarginXAdjust;
            this.minimapPos.y = minimapPosY + thisMinimapMarginYAdjust;
            this.display.border.lineStyle(thisMinimapBorderWidth, 0);
            this.display.border.beginFill(0, 0);
            const u = layoutSm
                ? thisMinimapMargin + thisMinimapBorderWidth / 2
                : screenHeight
                    - minimapSize
                    - thisMinimapMargin
                    + thisMinimapBorderWidth / 2;
            this.display.border.drawRect(
                thisMinimapMargin + thisMinimapBorderWidth / 2 + thisMinimapMarginXAdjust,
                u + thisMinimapMarginYAdjust,
                minimapSize - thisMinimapBorderWidth,
                minimapSize - thisMinimapBorderWidth,
            );
            this.display.border.endFill();

            const minimapMaskAnchorY = layoutSm
                ? thisMinimapMargin
                : screenHeight - minimapSize - thisMinimapMargin;
            this.container.mask.beginFill(0xffffff, 1);
            this.container.mask.drawRect(
                thisMinimapMargin + thisMinimapMarginXAdjust,
                minimapMaskAnchorY - 0.5 + thisMinimapMarginYAdjust,
                minimapSize,
                minimapSize,
            );
            this.container.mask.endFill();
        }
    }

    toggleEscMenu(clear = false) {
        if (!this.displayingStats) {
            if (this.escMenuDisplayed || clear) {
                this.escMenuDisplayed = false;
                this.escMenuElem.css("display", "none");
                this.setCurrentGameTab("settings");
                $("#ui-center").off("mouseenter mouseleave");
                this.inputBinds.menuHovered = false;
                if (this.roleMenuActive) {
                    this.displayRoleMenu();
                }
            } else if (this.bigmapDisplayed) {
                this.displayMapLarge(true);
            } else {
                if (this.visibilityMode == 2) {
                    this.cycleVisibilityMode();
                }
                this.escMenuDisplayed = true;
                this.escMenuElem.css("display", "block");
                $("#ui-center")
                    .on("mouseenter", () => {
                        this.inputBinds.menuHovered = true;
                    })
                    .on("mouseleave", () => {
                        this.inputBinds.menuHovered = false;
                    });
                this.inputBinds.menuHovered = false;
                if (this.roleMenuActive) {
                    this.hideRoleMenu();
                }
            }
        }
    }

    setCurrentGameTab(tab: string) {
        this.currentGameTab = tab;
        this.gameTabs.css("display", "none");
        this.gameTabBtns.removeClass("btn-game-menu-selected");
        $(`#ui-game-tab-${this.currentGameTab}`).css("display", "block");
        $(`#btn-game-${this.currentGameTab}`).addClass("btn-game-menu-selected");
        if (this.currentGameTab == "keybinds") {
            this.inputBindUi.refresh();
        } else {
            this.inputBindUi.cancelBind();
        }
    }

    setRoleMenuActive(active: boolean) {
        this.roleMenuActive = active;
        if (this.roleMenuActive) {
            this.roleMenuTicker = GameConfig.player.perkModeRoleSelectDuration;
            this.displayRoleMenu();
        } else {
            if (this.roleMenuInst) {
                this.audioManager.stopSound(this.roleMenuInst);
                this.roleMenuInst = null;
            }
            this.hideRoleMenu();
        }
    }

    displayRoleMenu() {
        this.roleMenuElemWrapper.css("display", "block");
    }

    hideRoleMenu() {
        this.roleMenuElemWrapper.css("display", "none");
    }

    setRoleMenuOptions(role: string, roles: string[]) {
        $("#ui-role-header").html("");

        for (let a = 0; a < roles.length; a++) {
            const role = roles[a];
            const roleDef = GameObjectDefs.typeToDef(role, "role");
            const roleOption = $("<div/>", {
                class: "ui-role-option",
                "data-role": role,
            });
            roleOption.css({
                "background-image": `url('${roleDef.guiImg}')`,
            });
            $("#ui-role-header").append(roleOption);
        }

        $(".ui-role-option").on("click", (e) => {
            e.stopPropagation();
            const el = $(e.currentTarget);
            this.setRoleMenuInfo(el.data("role"));
        });

        let selectedRole = roles[0];
        if (roles.includes(role)) {
            selectedRole = role;
        }
        this.setRoleMenuInfo(selectedRole);
    }

    setRoleMenuInfo(role: string) {
        const roleDef = GameObjectDefs.typeToDef(role, "role");
        $(".ui-role-option").css({
            "background-size": 132,
            opacity: 0.5,
        });
        $("#ui-role-header").find(`[data-role=${role}]`).css({
            "background-size": 164,
            opacity: 1,
        });
        const roleBodyLeft = $("<div/>", {
            class: "ui-role-body-left",
        });
        const roleBodyName = $("<div/>", {
            class: "ui-role-body-name",
        });
        const roleBodyImg = $("<div/>", {
            class: "ui-role-body-image",
        });

        const roleName = this.localization.translate(`game-${role}`);
        roleBodyName.html(roleName);
        roleBodyImg.css({
            "background-image": `url('${roleDef.guiImg}')`,
        });
        const borderColor = roleDef.color
            ? helpers.colorToHexString(roleDef.color)
            : "default";
        this.roleMenuElem.css("border-color", borderColor);

        roleBodyLeft.append(roleBodyName).append(roleBodyImg);

        const roleBodyRight = $("<div/>", {
            class: "ui-role-body-right",
        });
        const rolePerks = roleDef.perks!;
        for (let i = 0; i < rolePerks.length; i++) {
            const perk = rolePerks[i];
            const perkElem = $("<div/>", {
                class: "ui-role-body-perk",
            });
            const perkElemImg = $("<div/>", {
                class: "ui-role-body-perk-image-wrapper",
            }).append(
                $("<div/>", {
                    class: "ui-role-body-perk-image-icon",
                }),
            );
            const perkElemName = $("<div/>", {
                class: "ui-role-body-perk-name",
            });

            const perkImg = helpers.getSvgFromGameType(
                perk instanceof Function ? perk() : perk,
            );
            perkElemImg.find(".ui-role-body-perk-image-icon").css({
                "background-image": `url('${perkImg}')`,
            });

            const perkName = this.localization.translate(`game-${perk}`);
            perkElemName.html(perkName);
            perkElem.append(perkElemImg).append(perkElemName);
            roleBodyRight.append(perkElem);
        }
        $("#ui-role-body").html("").append(roleBodyLeft).append(roleBodyRight);
        this.roleDisplayed = role;
    }
}
