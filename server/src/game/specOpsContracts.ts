import {
    packSpecOpsContractHud,
    pickSpecOpsContractKind,
    pickSpecOpsContractWeapon,
    specOpsContractCash,
    SpecOpsContractCooldownWaves,
    SpecOpsContractDurationWaves,
    SpecOpsContractHoldRadius,
    SpecOpsContractHoldSeconds,
    type SpecOpsContractKind,
    SpecOpsContractOfferDelay,
    SpecOpsContractStartWave,
    SpecOpsContractWantedProximity,
    SpecOpsContractWeaponCashMult,
} from "../../../shared/defs/maps/specOpsContracts.ts";
import { GameConfig } from "../../../shared/gameConfig.ts";
import { util } from "../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { MapIndicator } from "./objects/mapIndicator.ts";
import type { Player } from "./objects/player.ts";
import type { SpecOpsManager } from "./specOpsManager.ts";

type ContractState = {
    kind: SpecOpsContractKind;
    label: string;
    pos: Vec2;
    progress: number;
    /** Seconds remaining / roam refresh timer. */
    timer: number;
    holdRad: number;
    /** Wave the contract was offered on. */
    startWave: number;
    target?: Player;
    weapon?: string;
    marker?: MapIndicator;
    complete: boolean;
    failed: boolean;
};

/**
 * Mid-wave optional objectives: hold zones, most-wanted, weapon cash.
 * Contracts last SpecOpsContractDurationWaves waves, then a
 * SpecOpsContractCooldownWaves gap before the next offer.
 */
export class SpecOpsContractRunner {
    private active: ContractState | undefined;
    private offerDelay = SpecOpsContractOfferDelay;
    private offeredThisCombat = false;
    private announceCooldown = 0;
    /** Earliest wave that may receive a new contract offer. */
    private nextOfferAtWave = SpecOpsContractStartWave;

    constructor(readonly manager: SpecOpsManager) {}

    /** Called at the start of each combat wave. */
    resetWave(): void {
        this.offerDelay = SpecOpsContractOfferDelay;
        this.offeredThisCombat = false;
        this.announceCooldown = 0;
        this.expireIfPastDuration();
    }

    clear(): void {
        this.active?.marker?.kill();
        this.active = undefined;
    }

    private wavesLeft(c: ContractState): number {
        const endWave = c.startWave + SpecOpsContractDurationWaves;
        return Math.max(0, endWave - this.manager.wave);
    }

    private expireIfPastDuration(): void {
        const c = this.active;
        if (!c || c.complete || c.failed) return;
        if (this.wavesLeft(c) <= 0) {
            this.finishContract("Contract expired");
        }
    }

    /**
     * End the active contract (complete / fail / expire) and start the
     * inter-contract cooldown measured in waves.
     */
    private finishContract(msg?: string): void {
        const c = this.active;
        if (!c) return;
        const pos = c.pos;
        c.marker?.kill();
        c.complete = true;
        this.active = undefined;
        this.nextOfferAtWave = this.manager.wave + SpecOpsContractCooldownWaves;
        if (msg) {
            this.manager.game.logger.info(`Spec Ops contract: ${msg}`);
            this.manager.game.playerBarn.addMapPing("ping_help", pos);
        }
    }

    get hudLine(): string {
        const c = this.active;
        if (!c || c.complete || c.failed) return "";
        const waves = this.wavesLeft(c);
        const wavesSuffix = waves > 0 ? ` · ${waves}w` : "";
        if (c.kind === "hold_drop") {
            const pct = Math.floor((c.progress / SpecOpsContractHoldSeconds) * 100);
            return `CONTRACT · Hold zone ${pct}%${wavesSuffix}`;
        }
        if (c.kind === "most_wanted") {
            return c.target && !c.target.dead
                ? `CONTRACT · Eliminate Most Wanted (${c.target.name})${wavesSuffix}`
                : `CONTRACT · Most Wanted${wavesSuffix}`;
        }
        if (c.kind === "weapon_cash" && c.weapon) {
            return `CONTRACT · Use ${c.weapon.toUpperCase()} · ${SpecOpsContractWeaponCashMult}× cash${wavesSuffix}`;
        }
        return c.label;
    }

    /** Packed HUD code for active-player net sync. */
    get hudCode(): number {
        const c = this.active;
        if (!c || c.complete || c.failed) return 0;
        const wavesLeft = this.wavesLeft(c);
        if (c.kind === "hold_drop") {
            return packSpecOpsContractHud({
                kind: c.kind,
                progress: Math.floor((c.progress / SpecOpsContractHoldSeconds) * 100),
                wavesLeft,
            });
        }
        if (c.kind === "weapon_cash") {
            return packSpecOpsContractHud({ kind: c.kind, weapon: c.weapon });
        }
        return packSpecOpsContractHud({ kind: c.kind, wavesLeft });
    }

    modifyKillBounty(killer: Player, bounty: number): number {
        const c = this.active;
        if (!c || c.kind !== "weapon_cash" || !c.weapon || c.complete) return bounty;
        const primary = killer.weapons[GameConfig.WeaponSlot.Primary]?.type;
        const secondary = killer.weapons[GameConfig.WeaponSlot.Secondary]?.type;
        const active = killer.weapons[killer.curWeapIdx]?.type;
        if (active === c.weapon || primary === c.weapon || secondary === c.weapon) {
            return Math.round(bounty * SpecOpsContractWeaponCashMult);
        }
        return bounty;
    }

    onEnemyKilled(killer: Player, victim: Player): void {
        const c = this.active;
        if (!c || c.complete) return;
        if (c.kind === "most_wanted" && c.target === victim) {
            this.completeMostWanted(killer);
        }
    }

    update(dt: number): void {
        if (this.manager.phase !== "combat") return;
        this.announceCooldown = Math.max(0, this.announceCooldown - dt);

        if (
            !this.active
            && !this.offeredThisCombat
            && this.manager.wave >= this.nextOfferAtWave
        ) {
            this.offerDelay -= dt;
            if (this.offerDelay <= 0) {
                this.offeredThisCombat = true;
                this.tryStartContract();
            }
        }

        const c = this.active;
        if (!c || c.complete || c.failed) return;

        if (c.kind === "hold_drop") this.tickHoldDrop(dt, c);
        else if (c.kind === "most_wanted") this.tickMostWanted(dt, c);
        // weapon_cash is passive via modifyKillBounty
    }

    private tryStartContract(): void {
        if (this.active) return;
        const humans = this.manager.livingHumans();
        if (!humans.length) return;
        const kind = pickSpecOpsContractKind(this.manager.wave);
        if (kind === "hold_drop") this.startHoldDrop(humans[0]);
        else if (kind === "most_wanted") this.startMostWanted(humans[0]);
        else this.startWeaponCash();
    }

    private announce(msg: string): void {
        this.manager.game.logger.info(`Spec Ops contract: ${msg}`);
        this.ping(this.active?.pos ?? this.manager.operatorSpawn ?? v2.create(0, 0));
    }

    private ping(pos: Vec2): void {
        this.manager.game.playerBarn.addMapPing("ping_help", pos);
    }

    private outdoorAway(origin: Vec2, minRad = 36, maxRad = 78): Vec2 {
        const away = this.manager.pickSpawnNearPublic(origin, minRad, maxRad);
        const outdoor = this.manager.resolveOutdoorSupportPosPublic(away);
        return outdoor ?? away;
    }

    private allocMarker(type: string, pos: Vec2): MapIndicator | undefined {
        const marker = this.manager.game.mapIndicatorBarn.allocIndicator(type, true);
        marker?.updatePosition(pos);
        return marker;
    }

    private startHoldDrop(host: Player): void {
        const pos = this.outdoorAway(host.pos, 28, 55);
        this.active = {
            kind: "hold_drop",
            label: "Hold for care package",
            pos,
            progress: 0,
            timer: SpecOpsContractHoldSeconds,
            holdRad: SpecOpsContractHoldRadius,
            startWave: this.manager.wave,
            marker: this.allocMarker("specops_contract_hold", pos),
            complete: false,
            failed: false,
        };
        this.announce("Hold the marked zone for a care package");
        this.ping(pos);
    }

    private startMostWanted(host: Player): void {
        const pos = this.outdoorAway(host.pos, 48, 95);
        let target: Player;
        try {
            target = this.manager.spawnEnemyPublic("warlord");
        } catch {
            try {
                target = this.manager.spawnEnemyPublic("captain");
            } catch {
                return;
            }
        }
        v2.set(target.pos, pos);
        target.game.grid.updateObject(target);
        target.setDirty();
        target.name = "Most Wanted";
        target.specOpsBounty = Math.max(target.specOpsBounty, 1800);
        target.setDirty();
        const brain = this.manager.getBrainPublic(target);
        if (brain) {
            brain.roamOnly = true;
            brain.alerted = false;
            brain.investigatePos = v2.copy(pos);
        }
        this.active = {
            kind: "most_wanted",
            label: "Eliminate Most Wanted",
            pos,
            progress: 0,
            timer: 0,
            holdRad: SpecOpsContractWantedProximity,
            startWave: this.manager.wave,
            target,
            marker: this.allocMarker("specops_contract_wanted", pos),
            complete: false,
            failed: false,
        };
        this.announce("Most Wanted is roaming — engage at your own risk");
        this.manager.game.playerBarn.addMapPing("ping_woodsking", pos);
    }

    private startWeaponCash(): void {
        const weapon = pickSpecOpsContractWeapon();
        this.active = {
            kind: "weapon_cash",
            label: `Use ${weapon} for ${SpecOpsContractWeaponCashMult}× cash`,
            pos: this.manager.operatorSpawn
                ? v2.copy(this.manager.operatorSpawn)
                : v2.create(0, 0),
            progress: 0,
            timer: 0,
            holdRad: 0,
            startWave: this.manager.wave,
            weapon,
            complete: false,
            failed: false,
        };
        this.announce(
            `Contract: equip ${weapon.toUpperCase()} for ${SpecOpsContractWeaponCashMult}× kill cash (${SpecOpsContractDurationWaves} waves)`,
        );
    }

    private operatorsInRadius(pos: Vec2, rad: number): Player[] {
        const out: Player[] = [];
        const humans = this.manager.livingHumans();
        for (let i = 0; i < humans.length; i++) {
            if (v2.distance(humans[i].pos, pos) <= rad) out.push(humans[i]);
        }
        return out;
    }

    private tickHoldDrop(dt: number, c: ContractState): void {
        const holders = this.operatorsInRadius(c.pos, c.holdRad);
        if (holders.length > 0) {
            c.progress += dt;
            if (this.announceCooldown <= 0 && c.progress > 1) {
                this.ping(c.pos);
                this.announceCooldown = 8;
            }
        } else {
            c.progress = Math.max(0, c.progress - dt * 0.35);
        }
        if (c.progress >= SpecOpsContractHoldSeconds) {
            this.manager.game.planeBarn.addAirdrop(c.pos);
            const cash = specOpsContractCash(this.manager.wave);
            for (const p of holders.length ? holders : this.manager.livingHumans()) {
                this.manager.grantCash(p, Math.round(cash * 0.35));
            }
            this.manager.game.playerBarn.addMapPing("ping_airdrop", c.pos);
            this.finishContract("Care package inbound");
        }
    }

    private tickMostWanted(dt: number, c: ContractState): void {
        if (!c.target || c.target.dead) {
            // Kill handled in onEnemyKilled; if he somehow vanished, end soft.
            if (!c.complete) {
                this.finishContract("Most Wanted escaped");
            }
            return;
        }
        c.pos = v2.copy(c.target.pos);
        c.marker?.updatePosition(c.pos);
        const brain = this.manager.getBrainPublic(c.target);
        if (brain?.roamOnly && !brain.alerted) {
            c.timer -= dt;
            if (c.timer <= 0) {
                c.timer = util.random(4, 9);
                brain.investigatePos = this.outdoorAway(c.target.pos, 18, 40);
            }
            const near = this.operatorsInRadius(c.target.pos, SpecOpsContractWantedProximity);
            if (near.length) {
                brain.alerted = true;
                brain.roamOnly = false;
                brain.target = near[0];
                brain.acquireTicker = 0;
            }
        }
    }

    private completeMostWanted(killer: Player): void {
        const c = this.active;
        if (!c || c.kind !== "most_wanted" || c.complete) return;
        const cash = specOpsContractCash(this.manager.wave);
        this.manager.grantCash(killer, cash);
        for (const p of this.manager.livingHumans()) {
            if (p !== killer) this.manager.grantCash(p, Math.round(cash * 0.25));
        }
        this.finishContract("Most Wanted eliminated");
    }
}
