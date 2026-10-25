import { parseSpecOpsDifficulty } from "../../../shared/defs/maps/specOpsShop.ts";
import { TeamMode } from "../../../shared/gameConfig.ts";
import type { Loadout } from "../../../shared/utils/loadout.ts";
import { math } from "../../../shared/utils/math.ts";
import { Config, maxPlayersForMap, teamSizeForMode } from "../config.ts";
import { validateSquadName } from "../utils/badWords.ts";
import { ServerLogger } from "../utils/logger.ts";
import { type FindGamePrivateBody, type ServerGameConfig } from "../utils/types.ts";
import { ClientBarn } from "./client.ts";
import { GameModeManager } from "./gameModeManager.ts";
import { Grid } from "./grid.ts";
import { GameMap } from "./map.ts";
import { AirdropBarn } from "./objects/airdrop.ts";
import { BulletBarn } from "./objects/bullet.ts";
import { DeadBodyBarn } from "./objects/deadBody.ts";
import { DecalBarn } from "./objects/decal.ts";
import { ExplosionBarn } from "./objects/explosion.ts";
import { type GameObject, ObjectRegister } from "./objects/gameObject.ts";
import { Gas } from "./objects/gas.ts";
import { LootBarn } from "./objects/loot.ts";
import { MapIndicatorBarn } from "./objects/mapIndicator.ts";
import { PlaneBarn } from "./objects/plane.ts";
import { PlayerBarn } from "./objects/player.ts";
import { ProjectileBarn } from "./objects/projectile.ts";
import { SmokeBarn } from "./objects/smoke.ts";
import { Profiler } from "./profiler.ts";
import { SpecOpsManager } from "./specOpsManager.ts";

export interface JoinTokenData {
    expiresAt: number;
    userId: string | null;
    findGameIp: string;
    loadout?: Loadout;
    quests?: string[];
    /** Prefer reclaiming this network player id (page reload / reconnect). */
    reclaimPlayerId?: number;
    groupData: {
        autoFill: boolean;
        playerCount: number;
        groupHashToJoin: string;
        /** Fireteam name from the lobby (duo/squad). */
        squadName: string;
    };
}

export class Game {
    started = false;
    stopped = false;
    over = false;
    startedTime = 0;
    stopTicker = 0;
    timeRunning = 0;
    // used to stop the game if theres no connected players
    noPlayersTicker = 0;

    id: string;
    teamMode: TeamMode;
    /** Player cap for this mode (Solo 1, Duo 2, Squad = Config.maxSquadSize). */
    maxTeamSize: number;
    mapName: string;
    isTeamMode: boolean;
    config: ServerGameConfig;
    modeManager: GameModeManager;
    specOps?: SpecOpsManager;

    now!: number;
    profiler = new Profiler();
    perfTicker = 0;
    tickTimes: number[] = [];

    tickTimeWarnThreshold = (1000 / Config.gameTps) * 4;
    gameTickWarnings = 0;

    netSyncWarnThreshold = (1000 / Config.netSyncTps) * 4;
    netSyncWarnings = 0;
    netSyncTimes = { serialize: 0, send: 0, flush: 0 };

    joinTokens = new Map<string, JoinTokenData>();

    get aliveCount(): number {
        return this.playerBarn.livingPlayers.length;
    }

    grid: Grid<GameObject>;
    map: GameMap;
    gas: Gas;
    objectRegister: ObjectRegister;

    clientBarn: ClientBarn;
    playerBarn: PlayerBarn;
    lootBarn: LootBarn;
    deadBodyBarn: DeadBodyBarn;
    decalBarn: DecalBarn;
    projectileBarn: ProjectileBarn;
    bulletBarn: BulletBarn;
    smokeBarn: SmokeBarn;
    airdropBarn: AirdropBarn;
    explosionBarn: ExplosionBarn;
    planeBarn: PlaneBarn;
    mapIndicatorBarn: MapIndicatorBarn;

    logger: ServerLogger;

    // for debug
    preventStart = false;
    debugSpeedMulti = 1;

    constructor(id: string, config: ServerGameConfig) {
        const start = Date.now();
        this.id = id;
        this.logger = new ServerLogger(`Game #${this.id.substring(0, 4)}`);
        this.logger.info("Creating");

        this.config = {
            mapName: config.mapName,
            teamMode: config.teamMode,
            squadSize: config.squadSize,
            difficulty: parseSpecOpsDifficulty(config.difficulty ?? Config.difficulty),
            endless: config.endless ?? Config.endless ?? false,
        };

        this.teamMode = config.teamMode;
        this.maxTeamSize = teamSizeForMode(
            this.teamMode,
            config.squadSize ?? Config.maxSquadSize,
        );
        this.mapName = config.mapName;
        this.isTeamMode = this.teamMode !== TeamMode.Solo;

        this.map = new GameMap(this);
        this.grid = new Grid(this.map.width, this.map.height);
        this.objectRegister = new ObjectRegister(this.grid);

        this.clientBarn = new ClientBarn(this);
        this.playerBarn = new PlayerBarn(this);
        this.lootBarn = new LootBarn(this);
        this.deadBodyBarn = new DeadBodyBarn(this);
        this.decalBarn = new DecalBarn(this);
        this.projectileBarn = new ProjectileBarn(this);
        this.bulletBarn = new BulletBarn(this);
        this.smokeBarn = new SmokeBarn(this);
        this.airdropBarn = new AirdropBarn(this);
        this.explosionBarn = new ExplosionBarn(this);
        this.planeBarn = new PlaneBarn(this);
        this.mapIndicatorBarn = new MapIndicatorBarn();

        this.gas = new Gas(this);

        this.modeManager = new GameModeManager(this);

        if (this.map.factionMode) {
            for (let i = 1; i <= this.map.mapDef.gameMode.factions!; i++) {
                this.playerBarn.addTeam(i);
            }
        }

        if (this.map.specOpsMode) {
            this.specOps = new SpecOpsManager(this);
        }

        this.map.init();

        this.logger.info(`Created in ${Date.now() - start} ms`);

        this.updateData();
    }

    update(dt?: number) {
        if (this.stopped) return;
        this.profiler.flush();

        const now = performance.now();
        if (!this.now) this.now = now;
        dt ??= math.clamp((now - this.now) / 1000, 0.001, 1 / 8);

        this.timeRunning += dt;

        dt *= this.debugSpeedMulti;

        this.now = now;

        if (this.over) {
            this.stopTicker -= dt;
            if (this.stopTicker <= 0) {
                this.stop();
                return;
            }
        }

        if (!this.started && !this.preventStart) {
            this.started = this.modeManager.isGameStarted();
            if (this.started) {
                if (!this.map.specOpsMode) {
                    this.gas.advanceGasStage();
                }
                this.specOps?.onMatchStarted();
            } else {
                const connected = this.playerBarn.players.reduce((a, b) => {
                    return a + (b.disconnected ? 0 : 1);
                }, 0);
                if (connected === 0) {
                    this.noPlayersTicker += dt;
                } else {
                    this.noPlayersTicker = 0;
                }
                // after 30 seconds of no connected players on a lobby that was
                // opened for matchmaking (join tokens issued), shut it down
                if (this.noPlayersTicker > 30 && this.joinTokens.size > 0) {
                    this.over = true;
                    this.stop();
                    return;
                }
            }
        }

        if (this.started) this.startedTime += dt;

        //
        // Update modules
        //
        this.profiler.addSample("gas");
        this.gas.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("specOps");
        this.specOps?.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("players");
        this.playerBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("clients");
        this.clientBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("map");
        this.map.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("loot");
        this.lootBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("bullets");
        this.bulletBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("projectiles");
        this.projectileBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("explosions");
        this.explosionBarn.update();
        this.profiler.endSample();

        this.profiler.addSample("smoke");
        this.smokeBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("airdrops");
        this.airdropBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("deadBodies");
        this.deadBodyBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("decals");
        this.decalBarn.update(dt);
        this.profiler.endSample();

        this.profiler.addSample("planes");
        this.planeBarn.update(dt);
        this.profiler.endSample();

        const tickTime = performance.now() - this.now;

        if (tickTime > 1000) {
            let errString = `Tick took over 1 second! ${tickTime.toFixed(2)}ms\n`;
            errString += "Profiler stats:\n";
            errString += this.profiler.getStats();
            this.logger.error(errString);
        } else if (tickTime > this.tickTimeWarnThreshold) {
            this.logger.warn(
                `Tick took over ${this.tickTimeWarnThreshold}ms! ${tickTime.toFixed(2)}ms`,
            );
            this.gameTickWarnings++;

            if (this.gameTickWarnings > 20) {
                let errString = `Server is overloaded! Increasing tickTimeWarnThreshold.\n`;
                errString += "Profiler stats:\n";
                errString += this.profiler.getStats();
                this.logger.warn(errString);

                this.gameTickWarnings = 0;
                this.tickTimeWarnThreshold *= 2;
            }
        }

        if (Config.logging.debugLogs) {
            this.tickTimes.push(tickTime);

            this.perfTicker += dt;
            if (this.perfTicker >= 15) {
                this.perfTicker = 0;
                const mspt = this.tickTimes.reduce((a, b) => a + b) / this.tickTimes.length;

                this.logger.debug(
                    `Avg ms/tick: ${mspt.toFixed(2)} | Load: ${((mspt / (1000 / Config.gameTps)) * 100).toFixed(1)}%`,
                );
                this.tickTimes = [];
            }
        }
    }

    netSync() {
        if (this.stopped) return;

        const start = performance.now();

        let t = performance.now();
        this.objectRegister.serializeObjs();
        this.netSyncTimes.serialize = performance.now() - t;

        t = performance.now();
        this.clientBarn.sendMsgs();
        this.netSyncTimes.send = performance.now() - t;

        //
        // reset stuff
        //
        t = performance.now();
        this.clientBarn.flush();
        this.playerBarn.flush();
        this.lootBarn.flush();
        this.planeBarn.flush();
        this.bulletBarn.flush();
        this.objectRegister.flush();
        this.explosionBarn.flush();
        this.gas.flush();
        this.mapIndicatorBarn.flush();
        this.specOps?.flush();
        this.netSyncTimes.flush = performance.now() - t;

        const syncTime = performance.now() - start;
        if (syncTime > 1000) {
            this.logger.error(
                `Net sync took over 1 second! ${syncTime.toFixed(2)}ms | `
                    + `serialize ${this.netSyncTimes.serialize.toFixed(1)}ms `
                    + `send ${this.netSyncTimes.send.toFixed(1)}ms `
                    + `flush ${this.netSyncTimes.flush.toFixed(1)}ms`,
            );
        } else if (syncTime > this.netSyncWarnThreshold) {
            this.logger.warn(
                `Net sync took over ${this.netSyncWarnThreshold}ms! ${syncTime.toFixed(2)}ms | `
                    + `serialize ${this.netSyncTimes.serialize.toFixed(1)}ms `
                    + `send ${this.netSyncTimes.send.toFixed(1)}ms `
                    + `flush ${this.netSyncTimes.flush.toFixed(1)}ms `
                    + `clients ${this.clientBarn.clients.length}`,
            );
            this.netSyncWarnings++;

            if (this.netSyncWarnings > 20) {
                this.logger.warn(
                    `Server net sync overloaded! Increasing netSyncWarnThreshold.`,
                );

                this.netSyncWarnings = 0;
                this.netSyncWarnThreshold *= 2;
            }
        }
    }

    pendingJoinTokens(): number {
        const now = Date.now();
        let count = 0;
        for (const token of this.joinTokens.values()) {
            if (token.expiresAt > now) count++;
        }
        return count;
    }

    get playerCap(): number {
        return maxPlayersForMap(
            this.map.specOpsMode,
            this.map.mapDef.gameMode.maxPlayers,
            this.maxTeamSize,
            Config.maxPlayersPerGame,
        );
    }

    get canJoin(): boolean {
        if (this.map.specOpsMode) {
            return !this.over && (this.specOps?.allowJoin ?? true);
        }
        return (
            this.aliveCount < this.playerCap
            && !this.over
            && this.startedTime < 60
        );
    }

    /** Listed in the server browser when true. */
    get browsable(): boolean {
        if (this.map.specOpsMode) {
            return !this.over && (this.specOps?.browsable ?? true);
        }
        return this.canJoin;
    }

    checkGameOver() {
        if (this.over) return;

        if (this.map.specOpsMode) {
            // Practice never ends on death; the player respawns. Idle/abandoned
            // matches are still closed by the Spec Ops lobby timers.
            if (this.map.practiceMode) return;
            const humans = this.specOps?.humanCount ?? 0;
            const operators = this.specOps?.operatorCount ?? 0;
            // Connected operators are all dead (buyback needs a living teammate).
            // Disconnected/empty lobbies are torn down by SpecOpsAbandonedTimeout
            // so a brief reconnect window remains.
            if (this.started && humans <= 0 && operators > 0) {
                this.over = true;
                this.stopTicker = 2.5;
                this.updateData();
            }
            return;
        }

        const didGameEnd = this.started && this.modeManager.aliveCount() <= 1;

        if (didGameEnd) {
            this.over = true;

            // send win emoji after 1 second
            this.playerBarn.sendWinEmoteTicker = 1;
            // stop game after 1.8s
            this.stopTicker = 1.8;

            this.modeManager.sendGameOverMsgs();
            this.updateData();
        }
    }

    addJoinTokens(
        tokens: FindGamePrivateBody["playerData"],
        autoFill: boolean,
        squadName = "",
    ): number {
        const now = Date.now();
        for (const [key, token] of this.joinTokens) {
            if (token.expiresAt <= now) this.joinTokens.delete(key);
        }

        // Rejoin: drop stale pending tokens for the same player so a new token can be issued.
        // Never wipe by IP alone — a LAN Spec Ops squad shares one NAT and each seat needs
        // its own pending token. Anonymous same-IP replaces at most one stale token each.
        let replacedPending = false;
        for (const incoming of tokens) {
            let replaced = false;
            if (incoming.userId !== null) {
                for (const [key, existing] of this.joinTokens) {
                    if (existing.expiresAt <= now) continue;
                    if (existing.userId === incoming.userId) {
                        this.joinTokens.delete(key);
                        replaced = true;
                        replacedPending = true;
                        break;
                    }
                }
            }
            if (!replaced) {
                for (const [key, existing] of this.joinTokens) {
                    if (existing.expiresAt <= now) continue;
                    if (existing.userId !== null) continue;
                    if (existing.findGameIp !== incoming.ip) continue;
                    this.joinTokens.delete(key);
                    replacedPending = true;
                    break;
                }
            }
        }

        const reconnectOnly = this.map.specOpsMode
            && this.specOps
            && !this.specOps.allowJoin;

        if (
            !replacedPending
            && reconnectOnly
            && !this.specOps!.allowReconnectTokens
            && !tokens.some((t) => this.specOps!.hasReclaimableSeat(t.reclaimPlayerId))
        ) {
            return 0;
        }

        const cap = this.playerCap;
        const occupied = this.map.specOpsMode
            ? (this.specOps?.operatorCount ?? 0)
            : this.aliveCount;

        let accepted: FindGamePrivateBody["playerData"];
        if (reconnectOnly) {
            // Page reload: mint a token for an explicit seat id even while the old
            // socket still looks live; otherwise only disconnected/closing seats.
            const usedSeatIds = new Set<number>();
            for (const existing of this.joinTokens.values()) {
                if (existing.reclaimPlayerId) usedSeatIds.add(existing.reclaimPlayerId);
            }
            let freeSlots = Math.max(
                0,
                this.specOps!.reclaimableHumanCount() - this.joinTokens.size,
            );
            accepted = [];
            for (const token of tokens) {
                const seatId = token.reclaimPlayerId;
                if (seatId && this.specOps!.hasReclaimableSeat(seatId)) {
                    if (usedSeatIds.has(seatId)) continue;
                    usedSeatIds.add(seatId);
                    accepted.push(token);
                    continue;
                }
                if (freeSlots <= 0) continue;
                freeSlots--;
                accepted.push(token);
            }
        } else {
            const remaining = Math.max(0, cap - occupied - this.joinTokens.size);
            accepted = tokens.slice(0, remaining);
        }
        if (!accepted.length) return 0;

        const groupData = {
            playerCount: accepted.length,
            groupHashToJoin: "",
            autoFill,
            squadName: validateSquadName(squadName),
        };

        for (const token of accepted) {
            this.joinTokens.set(token.token, {
                expiresAt: now + 90_000,
                userId: token.userId,
                groupData,
                findGameIp: token.ip,
                loadout: token.loadout,
                quests: token.quests,
                reclaimPlayerId: token.reclaimPlayerId,
            });
        }

        if (this.map.specOpsMode && !autoFill) {
            this.specOps?.lockJoin();
        }

        return accepted.length;
    }

    stop() {
        if (this.stopped) return;
        this.stopped = true;
        for (const client of this.clientBarn.clients) {
            client.disconnect();
        }
        this.logger.info("Game Ended");
        this._saveGameToDatabase();
        this.updateData();
    }

    // implementation of those is on gameProcess.ts
    // this keeps the base Game class free of nodejs imports and the ability to make network requests
    // to make offline mode and unit tests easier to maintain

    updateData() {}
    protected _saveGameToDatabase() {}
    sendQuestProgress(_userId: string, _progress: Array<{ id: string; delta: number }>) {}

    /**
     * Steps the game X seconds in the future
     * This is done in smaller steps of 0.1 seconds
     * To make sure everything updates properly
     *
     * Used for unit tests, don't call this on actual game code :p
     */
    step(seconds: number) {
        for (let i = 0, steps = seconds * 10; i < steps; i++) {
            this.update(0.1);
        }
    }
}
