import { GunDefs } from "../defs/gameObjects/gunDefs.ts";
import { GameObjectDefs } from "../defs/register.ts";
import {
    defaultPracticeSettings,
    emptyPracticeStats,
    PracticeKitItems,
    PracticeMaxBots,
    PracticeRandomGun,
    PracticeRespawnModes,
    PracticeScopes,
    type PracticeSettings,
    type PracticeStats,
    sanitizePracticeSettings,
} from "../practice.ts";
import type { AbstractMsg, BitStream } from "./net.ts";

function writeGun(s: BitStream, gun: string) {
    const valid = !!gun && !!GunDefs[gun];
    s.writeBoolean(valid);
    if (valid) s.writeGameType(gun);
}

function readGun(s: BitStream): string {
    if (!s.readBoolean()) return "";
    const type = s.readGameType();
    return GunDefs[type] ? type : "";
}

/** Client → server: the practice setup from the panel. The server sanitizes it again. */
export class PracticeSettingsMsg implements AbstractMsg {
    settings: PracticeSettings = defaultPracticeSettings();

    serialize(s: BitStream) {
        const settings = sanitizePracticeSettings(this.settings);
        writeGun(s, settings.primary);
        writeGun(s, settings.secondary);
        const kit = settings.kit;
        s.writeGameType(kit.melee);
        s.writeBits(kit.helmet, 3);
        s.writeBits(kit.vest, 3);
        s.writeBits(kit.backpack, 2);
        s.writeBits(Math.max(0, (PracticeScopes as readonly string[]).indexOf(kit.scope)), 3);
        s.writeBoolean(kit.fillAmmo);
        for (const item of PracticeKitItems) s.writeBits(kit.counts[item], 7);
        s.writeBits(settings.bots.length, 3);
        for (const bot of settings.bots) {
            const random = bot.gun === PracticeRandomGun;
            s.writeBoolean(random);
            if (!random) writeGun(s, bot.gun);
            const secondaryRandom = bot.secondary === PracticeRandomGun;
            s.writeBoolean(secondaryRandom);
            if (!secondaryRandom) writeGun(s, bot.secondary);
            s.writeGameType(bot.melee);
            s.writeBoolean(bot.quickSwitch);
            s.writeBoolean(bot.autoMelee);
            s.writeBits(bot.wiggle, 4);
            s.writeBits(bot.strafe, 4);
            s.writeBits(bot.turn, 4);
            s.writeBits(bot.dodge, 4);
            s.writeBits(bot.accuracy, 7);
            s.writeBits(bot.reaction, 5);
            s.writeBoolean(bot.shootsBack);
            s.writeBits(bot.health, 9);
            s.writeBits(bot.armor, 2);
        }
        s.writeBits(Math.max(0, PracticeRespawnModes.indexOf(settings.respawnMode)), 2);
        s.writeBits(settings.respawnDelay, 7);
    }

    deserialize(s: BitStream) {
        const primary = readGun(s);
        const secondary = readGun(s);
        const melee = s.readGameType();
        const helmet = s.readBits(3);
        const vest = s.readBits(3);
        const backpack = s.readBits(2);
        const scope = PracticeScopes[s.readBits(3)] ?? PracticeScopes[0];
        const fillAmmo = s.readBoolean();
        const counts = {} as Record<(typeof PracticeKitItems)[number], number>;
        for (const item of PracticeKitItems) counts[item] = s.readBits(7);
        const kit = { melee, helmet, vest, backpack, scope, fillAmmo, counts };
        const count = Math.min(s.readBits(3), PracticeMaxBots);
        const bots = [];
        for (let i = 0; i < count; i++) {
            const random = s.readBoolean();
            const gun = random ? PracticeRandomGun : readGun(s);
            const secondary = s.readBoolean() ? PracticeRandomGun : readGun(s);
            const melee = s.readGameType();
            const quickSwitch = s.readBoolean();
            const autoMelee = s.readBoolean();
            bots.push({
                gun,
                secondary,
                melee,
                quickSwitch,
                autoMelee,
                wiggle: s.readBits(4),
                strafe: s.readBits(4),
                turn: s.readBits(4),
                dodge: s.readBits(4),
                accuracy: s.readBits(7),
                reaction: s.readBits(5),
                shootsBack: s.readBoolean(),
                health: s.readBits(9),
                armor: s.readBits(2),
            });
        }
        const respawnMode = PracticeRespawnModes[s.readBits(2)] ?? PracticeRespawnModes[0];
        const respawnDelay = s.readBits(7);
        this.settings = sanitizePracticeSettings({ primary, secondary, kit, bots, respawnMode, respawnDelay });
    }
}

/** Client → server: spawn a pickup, empty your inventory, or respawn the bots now. */
export class PracticeGiveMsg implements AbstractMsg {
    /** Item/perk pickup to spawn on the ground near the player. */
    item = "";
    count = 1;
    /** Remove everything except fists and the 1x scope first (item may be empty). */
    clearInventory = false;
    /** Bring every dead bot back right now (any respawn mode). */
    respawnBots = false;

    serialize(s: BitStream) {
        s.writeBoolean(this.clearInventory);
        s.writeBoolean(this.respawnBots);
        const valid = !!this.item && GameObjectDefs.typeExists(this.item);
        s.writeGameType(valid ? this.item : "");
        s.writeUint16(Math.max(1, Math.min(999, Math.round(this.count) || 1)));
    }

    deserialize(s: BitStream) {
        this.clearInventory = s.readBoolean();
        this.respawnBots = s.readBoolean();
        this.item = s.readGameType();
        this.count = Math.max(1, Math.min(999, s.readUint16()));
    }
}

/** Server → client: running practice stats for the HUD. */
export class PracticeStatsMsg implements AbstractMsg {
    stats: PracticeStats = emptyPracticeStats();

    serialize(s: BitStream) {
        const st = this.stats;
        s.writeUint16(Math.min(st.kills, 0xffff));
        s.writeUint16(Math.min(st.deaths, 0xffff));
        s.writeUint32(Math.min(st.shotsFired, 0xffffffff));
        s.writeUint32(Math.min(st.shotsHit, 0xffffffff));
        s.writeUint32(Math.min(Math.round(st.damageDealt), 0xffffffff));
        s.writeUint32(Math.min(Math.round(st.damageTaken), 0xffffffff));
        s.writeUint32(Math.min(Math.round(st.ttkAvgMs), 0xffffffff));
        s.writeUint32(Math.min(Math.round(st.ttkBestMs), 0xffffffff));
        s.writeBits(Math.min(st.botsAlive, 7), 3);
        s.writeBits(Math.min(st.botsTotal, 7), 3);
    }

    deserialize(s: BitStream) {
        this.stats = {
            kills: s.readUint16(),
            deaths: s.readUint16(),
            shotsFired: s.readUint32(),
            shotsHit: s.readUint32(),
            damageDealt: s.readUint32(),
            damageTaken: s.readUint32(),
            ttkAvgMs: s.readUint32(),
            ttkBestMs: s.readUint32(),
            botsAlive: s.readBits(3),
            botsTotal: s.readBits(3),
        };
    }
}
