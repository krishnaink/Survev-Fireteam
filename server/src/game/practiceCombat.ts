import { BulletDefs } from "../../../shared/defs/gameObjects/bulletDefs.ts";
import { GunDefs } from "../../../shared/defs/gameObjects/gunDefs.ts";
import { MeleeDefs } from "../../../shared/defs/gameObjects/meleeDefs.ts";
import { GameConfig } from "../../../shared/gameConfig.ts";
import type { PracticeBotSettings } from "../../../shared/practice.ts";
import { math } from "../../../shared/utils/math.ts";
import { v2, type Vec2 } from "../../../shared/utils/v2.ts";
import type { Player } from "./objects/player.ts";

/** Solve projectile interception, including the distance from body to muzzle. */
export function practiceInterceptPoint(
    origin: Vec2,
    target: Vec2,
    velocity: Vec2,
    speed: number,
    muzzle = 0,
    maxTime = 2,
): Vec2 {
    if (!(speed > 0) || !Number.isFinite(speed)) return v2.copy(target);
    const delta = v2.sub(target, origin);
    const a = v2.dot(velocity, velocity) - speed * speed;
    const b = 2 * (v2.dot(delta, velocity) - speed * muzzle);
    const c = v2.dot(delta, delta) - muzzle * muzzle;
    const roots: number[] = [];
    if (Math.abs(a) < 1e-6) {
        if (Math.abs(b) > 1e-6) roots.push(-c / b);
    } else {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
            const sqrt = Math.sqrt(disc);
            roots.push((-b - sqrt) / (2 * a), (-b + sqrt) / (2 * a));
        }
    }
    const valid = roots.filter((t) => t >= 0 && Number.isFinite(t));
    const time = c <= 0 ? 0 : valid.length ? Math.min(...valid) : 0;
    return v2.add(target, v2.mul(velocity, math.clamp(time, 0, maxTime)));
}

/** Practice-only combat. All switches, fire, reloads and melee use the normal engine. */
export class PracticeCombat {
    meleeEngaged = false;
    private lastAmmo: number[];
    private returnSlot?: number;
    private returnWait = 0;
    private committedSlot?: number;

    constructor(readonly player: Player, readonly settings: PracticeBotSettings) {
        this.lastAmmo = player.weapons.slice(0, 2).map((w) => w.ammo);
    }

    get meleeReach(): number {
        const def = MeleeDefs[this.player.weapons[GameConfig.WeaponSlot.Melee].type];
        return def ? v2.length(def.attack.offset) + def.attack.rad : 0;
    }

    private loaded(slot: number): boolean {
        const weapon = this.player.weapons[slot];
        return !!GunDefs[weapon.type] && weapon.ammo > 0;
    }

    private switchDelay(slot: number): number {
        const p = this.player;
        const next = GunDefs[p.weapons[slot].type];
        const current = GunDefs[p.weaponManager.activeWeapon];
        if (!next) return Infinity;
        if (current?.deployGroup && current.deployGroup === next.deployGroup) return next.switchDelay;
        return p.freeSwitchTimer < 0 ? GameConfig.player.baseSwitchDelay : next.switchDelay;
    }

    private preferredGun(distance: number): number {
        const loaded = [0, 1].filter((slot) => this.loaded(slot));
        if (!loaded.length) return this.player.curWeapIdx < 2 ? this.player.curWeapIdx : 0;
        const score = (slot: number) => {
            const gun = GunDefs[this.player.weapons[slot].type];
            if (gun.bulletCount > 1) return distance < 12 ? 3 : distance < 20 ? 1 : 0;
            if (gun.fireDelay >= 0.5) return distance > 24 ? 3 : 1;
            return 2;
        };
        return loaded.reduce((best, slot) => score(slot) > score(best) ? slot : best);
    }

    update(dt: number, target: Player, canAttack: boolean): void {
        const p = this.player;
        const active = p.curWeapIdx;
        const fired = active < 2 && p.weapons[active].ammo < this.lastAmmo[active];
        this.lastAmmo = p.weapons.slice(0, 2).map((w) => w.ammo);
        if (fired) this.committedSlot = undefined;
        if (!canAttack) this.committedSlot = undefined;

        const distance = v2.distance(p.pos, target.pos);
        const melee = MeleeDefs[p.weapons[GameConfig.WeaponSlot.Melee].type];
        const windup = melee?.attack.damageTimes[0] ?? 0;
        const futureSelf = v2.add(p.pos, v2.mul(p.moveVel, windup));
        const futureTarget = v2.add(target.pos, v2.mul(target.moveVel, windup));
        const reach = this.meleeReach + target.rad - 0.2;
        this.meleeEngaged = this.settings.autoMelee && canAttack && !!melee
            && distance <= reach + (this.meleeEngaged ? 0.5 : 0)
            && v2.distance(futureSelf, futureTarget) <= reach;
        // Do not cancel a swing before its scheduled damage has landed.
        if (active === GameConfig.WeaponSlot.Melee && p.weaponManager.meleeAttacks.length) return;
        if (this.meleeEngaged) {
            this.returnSlot = undefined;
            this.committedSlot = undefined;
            p.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
            return;
        }

        if (this.returnSlot !== undefined) {
            this.returnWait -= dt;
            if (this.returnWait > 0) return;
            p.weaponManager.setCurWeapIndex(this.returnSlot);
            this.committedSlot = this.returnSlot;
            this.returnSlot = undefined;
            return;
        }
        const gun = GunDefs[p.weaponManager.activeWeapon];
        if (
            fired && canAttack && this.settings.quickSwitch && gun?.fireDelay >= 0.45
            && gun.fireMode !== "burst" && p.actionType === GameConfig.Action.None
        ) {
            const other = active === 0 ? 1 : 0;
            if (this.loaded(other) && this.switchDelay(other) + dt < p.weapons[active].cooldown) {
                p.weaponManager.setCurWeapIndex(other);
                this.committedSlot = other;
                return;
            }
            // One slow gun: holster for a tick, then draw it again. A shotgun
            // whose draw time costs as much as its recovery gains nothing here.
            if (gun.switchDelay + dt * 2 < p.weapons[active].cooldown) {
                p.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
                this.returnSlot = active;
                this.returnWait = dt;
                return;
            }
        }
        if (this.committedSlot === active && this.loaded(active)) return;
        if (p.actionType !== GameConfig.Action.None && active < 2 && this.loaded(active)) return;
        if (active >= 2 || !this.loaded(active) || p.weapons[active].cooldown <= 0) {
            p.weaponManager.setCurWeapIndex(this.preferredGun(distance));
        }
    }

    aimPoint(target: Player): Vec2 {
        const p = this.player;
        if (this.meleeEngaged || p.curWeapIdx === GameConfig.WeaponSlot.Melee) {
            const melee = MeleeDefs[p.weapons[GameConfig.WeaponSlot.Melee].type];
            const windup = Math.max(0, p.weaponManager.meleeAttacks[0] ?? melee?.attack.damageTimes[0] ?? 0);
            return v2.add(target.pos, v2.mul(v2.sub(target.moveVel, p.moveVel), windup));
        }
        const gun = GunDefs[p.weaponManager.activeWeapon];
        const bullet = gun && BulletDefs[gun.bulletType];
        return bullet
            ? practiceInterceptPoint(
                p.pos,
                target.pos,
                target.moveVel,
                bullet.speed,
                gun.barrelLength,
                bullet.distance / bullet.speed,
            )
            : v2.copy(target.pos);
    }

    fire(ready: boolean): void {
        const p = this.player;
        p.shootHold = p.shootStart = false;
        if (this.returnSlot !== undefined || p.actionType !== GameConfig.Action.None) return;
        if (p.curWeapIdx === GameConfig.WeaponSlot.Melee) {
            p.shootHold = p.shootStart = ready && this.meleeEngaged;
        } else if (p.curWeapIdx < 2) {
            if (!this.loaded(p.curWeapIdx)) {
                p.weaponManager.tryReload();
                return;
            }
            p.shootHold = ready;
            p.shootStart = ready && GunDefs[p.weaponManager.activeWeapon]?.fireMode !== "auto";
        }
    }
}
