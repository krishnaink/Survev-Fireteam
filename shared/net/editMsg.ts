import type { AbstractMsg, BitStream } from "./net.ts";

export class EditMsg implements AbstractMsg {
    zoomEnabled = false;
    zoom = 1;

    speedEnabled = false;
    speed = 0;

    gameSpeedEnabled = false;
    gameSpeed = 1;

    loadNewMap = false;
    newMapSeed = 0;

    spawnLootType = "";
    promoteToRole = false;
    promoteToRoleType = "";

    toggleLayer = false;

    noClip = false;
    teleportToPings = false;
    godMode = false;
    moveObjs = false;
    preventGameStart = false;

    spawnNpcKind = "";
    spawnNpcType = "";
    spawnNpcCount = 1;
    spawnNpcOneOfEach = false;
    /** Debug: Spec Ops enemies ignore human operators as targets. */
    npcIgnoreOperators = false;

    // ── Cheat panel ──────────────────────────────────────────────────────────
    /** Item type string to give directly to the player's inventory / weapon slots. */
    giveItem = "";
    /** How many to give (clamped 1–999 server-side). */
    giveItemCount = 1;
    /** Jump to this Spec Ops wave (0 = no change, 1–30 valid). */
    setWave = 0;
    /** Set player health to this value (0 = no change, >0 valid). */
    setHealth = 0;
    // ─────────────────────────────────────────────────────────────────────────

    serialize(s: BitStream) {
        s.writeBoolean(this.zoomEnabled);
        if (this.zoomEnabled) {
            s.writeUint8(this.zoom);
        }

        s.writeBoolean(this.speedEnabled);
        if (this.speedEnabled) {
            s.writeFloat32(this.speed);
        }

        s.writeBoolean(this.gameSpeedEnabled);
        if (this.gameSpeedEnabled) {
            s.writeFloat32(this.gameSpeed);
        }

        s.writeBoolean(this.loadNewMap);
        if (this.loadNewMap) {
            s.writeUint32(this.newMapSeed);
        }

        s.writeGameType(this.spawnLootType);
        s.writeBoolean(this.promoteToRole);
        if (this.promoteToRole) {
            s.writeGameType(this.promoteToRoleType);
        }
        s.writeBoolean(this.toggleLayer);

        s.writeBoolean(this.noClip);
        s.writeBoolean(this.teleportToPings);
        s.writeBoolean(this.godMode);
        s.writeBoolean(this.moveObjs);
        s.writeBoolean(this.preventGameStart);

        const hasNpcSpawn = !!this.spawnNpcKind || this.spawnNpcOneOfEach;
        s.writeBoolean(hasNpcSpawn);
        if (hasNpcSpawn) {
            s.writeString(this.spawnNpcKind);
            s.writeString(this.spawnNpcType);
            s.writeUint8(Math.max(1, Math.min(32, this.spawnNpcCount)));
            s.writeBoolean(this.spawnNpcOneOfEach);
        }

        s.writeBoolean(this.npcIgnoreOperators);

        // Cheat fields (appended after all legacy fields — always written)
        s.writeGameType(this.giveItem);
        s.writeUint16(Math.max(0, Math.min(999, this.giveItemCount)));
        s.writeUint8(Math.max(0, Math.min(30, this.setWave)));
        s.writeUint16(Math.max(0, Math.min(65535, this.setHealth)));
    }

    deserialize(s: BitStream) {
        this.zoomEnabled = s.readBoolean();
        if (this.zoomEnabled) {
            this.zoom = s.readUint8();
        }

        this.speedEnabled = s.readBoolean();
        if (this.speedEnabled) {
            this.speed = s.readFloat32();
        }

        this.gameSpeedEnabled = s.readBoolean();
        if (this.gameSpeedEnabled) {
            this.gameSpeed = s.readFloat32();
        }

        this.loadNewMap = s.readBoolean();
        if (this.loadNewMap) {
            this.newMapSeed = s.readUint32();
        }

        this.spawnLootType = s.readGameType();
        this.promoteToRole = s.readBoolean();
        if (this.promoteToRole) {
            this.promoteToRoleType = s.readGameType();
        }
        this.toggleLayer = s.readBoolean();

        this.noClip = s.readBoolean();
        this.teleportToPings = s.readBoolean();
        this.godMode = s.readBoolean();
        this.moveObjs = s.readBoolean();
        this.preventGameStart = s.readBoolean();

        const hasNpcSpawn = s.readBoolean();
        if (hasNpcSpawn) {
            this.spawnNpcKind = s.readString();
            this.spawnNpcType = s.readString();
            this.spawnNpcCount = s.readUint8();
            this.spawnNpcOneOfEach = s.readBoolean();
        } else {
            this.spawnNpcKind = "";
            this.spawnNpcType = "";
            this.spawnNpcCount = 1;
            this.spawnNpcOneOfEach = false;
        }

        this.npcIgnoreOperators = s.readBoolean();

        // Cheat fields
        this.giveItem = s.readGameType();
        this.giveItemCount = s.readUint16();
        this.setWave = s.readUint8();
        this.setHealth = s.readUint16();
    }
}
