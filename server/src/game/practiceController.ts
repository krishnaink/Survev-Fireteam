import { GunDefs } from "../../../shared/defs/gameObjects/gunDefs.ts";
import { GameConfig } from "../../../shared/gameConfig.ts";
import * as net from "../../../shared/net/net.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { math } from "../../../shared/utils/math.ts";
import {
    defaultPracticeSettings,
    emptyPracticeStats,
    PracticeBotRespawnDelay,
    type PracticeBotSettings,
    PracticePlayerRespawnDelay,
    type PracticeSettings,
    type PracticeStats,
} from "../../../shared/practice.ts";
import type { Game } from "./game.ts";
import type { DamageParams } from "./objects/gameObject.ts";
import type { Player } from "./objects/player.ts";

/** What the practice controller needs from the Spec Ops manager. */
export interface PracticeHost {
    readonly game: Game;
    spawnPracticeBot(settings: PracticeBotSettings, index: number): Player | undefined;
    removePracticeBot(bot: Player): void;
    respawnPracticeHuman(player: Player): void;
    equipPracticeHuman(player: Player, settings: PracticeSettings): void;
}

interface BotSlot {
    bot?: Player;
    /** Seconds until this slot spawns a bot; < 0 while a bot is alive. */
    respawnIn: number;
    /** Practice clock (s) when the player first damaged the current bot; 0 = not yet. */
    firstHitAt: number;
}

interface PlayerPracticeStats extends PracticeStats {
    ttkTotalMs: number;
    dirty: boolean;
}

/** How often stats are pushed to the client, in seconds. */
const StatsSendInterval = 0.5;

/**
 * Practice mode: keeps up to 4 configured bots alive, respawns the player with
 * their chosen guns, and tracks stats. Bots don't spawn until the player sends
 * their first setup from the panel.
 */
export class PracticeController {
    settings: PracticeSettings = defaultPracticeSettings();
    /** True once the player has sent a setup (bots only spawn after that). */
    started = false;
    slots: BotSlot[] = [];
    /** Seconds until each dead player respawns. */
    readonly humanRespawn = new Map<Player, number>();
    private readonly stats = new Map<Player, PlayerPracticeStats>();
    private statsTicker = 0;
    /** Seconds of match time, advanced in update(); drives TTK and the spam guard. */
    private clock = 0;
    /** Clock time of the last applied setup, to ignore spam. */
    private lastApplyAt = -Infinity;

    constructor(readonly host: PracticeHost) {}

    get game(): Game {
        return this.host.game;
    }

    /**
     * Apply a setup from the panel. Bots are replaced only when their settings
     * changed, so changing just your kit (e.g. while dead) leaves bots alone.
     * A living player gets the new kit right away; a dead one on respawn.
     */
    applySettings(player: Player, settings: PracticeSettings): boolean {
        if (player.specOpsAi) return false;
        if (this.clock - this.lastApplyAt < 0.4) return false;
        this.lastApplyAt = this.clock;
        const botsChanged = !this.started
            || JSON.stringify(settings.bots) !== JSON.stringify(this.settings.bots);
        const kitOf = (st: PracticeSettings) => JSON.stringify([st.primary, st.secondary, st.kit]);
        const kitChanged = !this.started || kitOf(settings) !== kitOf(this.settings);
        this.settings = settings;
        this.started = true;

        if (botsChanged) {
            for (const slot of this.slots) {
                if (slot.bot && !slot.bot.dead) this.host.removePracticeBot(slot.bot);
            }
            this.slots = settings.bots.map((_, i) => ({
                respawnIn: 0.5 + i * 0.25,
                firstHitAt: 0,
            }));
        }

        // Re-kit a living player only when the kit changed, so items you gave
        // yourself aren't wiped by a bots-only change.
        if (!player.dead && kitChanged) {
            this.host.equipPracticeHuman(player, settings);
        }
        return true;
    }

    onHumanJoined(player: Player): void {
        this.host.equipPracticeHuman(player, this.settings);
        this.statsFor(player).dirty = true;
    }

    /** Called on every damage event, with the damage that actually landed. */
    onDamage(target: Player, params: DamageParams, amount: number): void {
        const source = params.source?.__type === ObjectType.Player
            ? (params.source as Player)
            : undefined;

        if (!target.specOpsAi) {
            // A human taking damage from a bot.
            if (source?.specOpsAi) {
                const st = this.statsFor(target);
                st.damageTaken += amount;
                st.dirty = true;
            }
            return;
        }

        if (!source || source.specOpsAi) return;
        const st = this.statsFor(source);
        st.damageDealt += amount;
        const isBulletHit = params.damageType === GameConfig.DamageType.Player
            && !params.isExplosion
            && !!GunDefs[params.gameSourceType ?? ""];
        if (isBulletHit) st.shotsHit++;
        st.dirty = true;

        const slot = this.slots.find((s) => s.bot === target);
        if (slot && slot.firstHitAt === 0) slot.firstHitAt = math.max(this.clock, 1e-3);
    }

    onShotFired(player: Player): void {
        if (player.specOpsAi) return;
        const st = this.statsFor(player);
        st.shotsFired++;
        st.dirty = true;
    }

    update(dt: number): void {
        this.clock += dt;
        this.updateHumans(dt);
        if (this.started) this.updateBots(dt);

        this.statsTicker -= dt;
        if (this.statsTicker <= 0) {
            this.statsTicker = StatsSendInterval;
            this.sendStats();
        }
    }

    private updateHumans(dt: number): void {
        const players = this.game.playerBarn.players;
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (player.specOpsAi || player.disconnected) continue;
            if (player.dead) {
                const left = this.humanRespawn.get(player);
                if (left === undefined) {
                    this.humanRespawn.set(player, PracticePlayerRespawnDelay);
                    const st = this.statsFor(player);
                    st.deaths++;
                    st.dirty = true;
                    continue;
                }
                const next = left - dt;
                if (next > 0) {
                    this.humanRespawn.set(player, next);
                    continue;
                }
                this.humanRespawn.delete(player);
                this.host.respawnPracticeHuman(player);
                this.host.equipPracticeHuman(player, this.settings);
            } else {
                this.humanRespawn.delete(player);
            }
        }
    }

    private updateBots(dt: number): void {
        for (let i = 0; i < this.slots.length; i++) {
            const slot = this.slots[i];
            if (slot.bot) {
                if (!slot.bot.dead) continue;
                this.onBotDied(slot);
                slot.bot = undefined;
                slot.respawnIn = PracticeBotRespawnDelay;
                slot.firstHitAt = 0;
                continue;
            }
            slot.respawnIn -= dt;
            if (slot.respawnIn > 0) continue;
            const bot = this.host.spawnPracticeBot(this.settings.bots[i], i);
            if (bot) {
                slot.bot = bot;
                slot.respawnIn = -1;
                slot.firstHitAt = 0;
            } else {
                // No room right now (spawn failed); try again shortly.
                slot.respawnIn = 1;
            }
        }
    }

    private onBotDied(slot: BotSlot): void {
        const bot = slot.bot!;
        const killer = bot.killedBy;
        if (!killer || killer.specOpsAi) return;
        const st = this.statsFor(killer);
        st.kills++;
        if (slot.firstHitAt > 0) {
            const ttk = Math.max(this.clock - slot.firstHitAt, 0) * 1000;
            st.ttkTotalMs += ttk;
            st.ttkAvgMs = st.ttkTotalMs / st.kills;
            st.ttkBestMs = st.ttkBestMs > 0 ? Math.min(st.ttkBestMs, ttk) : ttk;
        }
        st.dirty = true;
    }

    statsFor(player: Player): PlayerPracticeStats {
        let st = this.stats.get(player);
        if (!st) {
            st = { ...emptyPracticeStats(), ttkTotalMs: 0, dirty: true };
            this.stats.set(player, st);
        }
        return st;
    }

    private sendStats(): void {
        for (const [player, st] of this.stats) {
            if (!st.dirty || player.disconnected) continue;
            st.dirty = false;
            const msg = new net.PracticeStatsMsg();
            msg.stats = {
                kills: st.kills,
                deaths: st.deaths,
                shotsFired: st.shotsFired,
                shotsHit: st.shotsHit,
                damageDealt: st.damageDealt,
                damageTaken: st.damageTaken,
                ttkAvgMs: st.ttkAvgMs,
                ttkBestMs: st.ttkBestMs,
            };
            player.client.sendMsg(net.MsgType.PracticeStats, msg);
        }
    }
}
