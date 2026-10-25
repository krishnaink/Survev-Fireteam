import type { EmoteDef } from "../../../shared/defs/gameObjects/emoteDefs.ts";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { GameConfig } from "../../../shared/gameConfig.ts";
import * as net from "../../../shared/net/net.ts";
import { ObjectType } from "../../../shared/net/objectSerializeFns.ts";
import { SpectateAction } from "../../../shared/net/spectateMsg.ts";
import type { Emote, GroupStatus } from "../../../shared/net/updateMsg.ts";
import type { GameWsDisconnectReason } from "../../../shared/types/api.ts";
import { coldet } from "../../../shared/utils/coldet.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { math } from "../../../shared/utils/math.ts";
import { util } from "../../../shared/utils/util.ts";
import { v2 } from "../../../shared/utils/v2.ts";
import { Config } from "../config.ts";
import { validateUserName } from "../utils/badWords.ts";

import type { Game, JoinTokenData } from "./game.ts";
import type { GameObject } from "./objects/gameObject.ts";
import type { MapIndicator } from "./objects/mapIndicator.ts";
import type { Player } from "./objects/player.ts";
import type { ClientSocket } from "./socket.ts";

/** Cap per-client instant msgs queued while the socket is backpressured. */
const MAX_QUEUED_CLIENT_MSGS = 32;

export class ClientBarn {
    clients: Client[] = [];

    /**
     * All msgs created this tick that will be sent to all players
     * cached in a single stream
     */
    msgsToSend = new net.MsgStream(new ArrayBuffer(4096));

    game: Game;
    constructor(game: Game) {
        this.game = game;
    }

    update(dt: number) {
        for (let i = 0; i < this.clients.length; i++) {
            this.clients[i].update(dt);
        }
    }

    sendMsgs() {
        const clients = this.clients;
        // Send to healthy clients first so a slow peer doesn't delay others.
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < clients.length; i++) {
                const client = clients[i];
                if (client.socket.closed()) continue;
                const backpressured = client.socket.isBackpressured();
                if (pass === 0 ? backpressured : !backpressured) continue;
                try {
                    client.sendMsgs();
                } catch (err) {
                    this.game.logger.error("sendMsgs failed for client, disconnecting:", err);
                    client.disconnect();
                }
            }
        }
    }

    flush() {
        this.msgsToSend.stream.index = 0;
    }

    addClientWithPlayer(socket: ClientSocket<Client>, joinMsg: net.JoinMsg) {
        const joinData = this.game.joinTokens.get(joinMsg.matchPriv);

        if (!joinData || joinData.expiresAt < Date.now()) {
            this.game.logger.warn("Client tried to join without or with expired join token");
            socket.close();
            if (joinData) {
                this.game.joinTokens.delete(joinMsg.matchPriv);
            }
            return;
        }
        this.game.joinTokens.delete(joinMsg.matchPriv);

        if (Config.rateLimitsEnabled) {
            // Cap concurrent sockets per IP/user to the squad size so full
            // Spec Ops lobbies (up to maxSquadSize) can join from the same NAT.
            const perIpCap = Math.max(Config.maxSquadSize, this.game.maxTeamSize);
            const count = this.clients.filter(
                (c) => {
                    return c.ip === socket.ip()
                        || c.findGameIp == joinData.findGameIp
                        || (joinData.userId !== null && c.userId === joinData.userId);
                },
            );
            if (count.length >= perIpCap) {
                socket.close("rate_limited");
                return;
            }
        }

        const reconnected = this.tryReconnectPlayer(socket, joinMsg, joinData);
        if (reconnected) {
            return reconnected;
        }

        const client = new Client(this.game, socket, joinData.userId, joinData.findGameIp);
        this.clients.push(client);

        const player = this.game.playerBarn.addPlayer(client, joinMsg, joinData);
        client.player = player;

        return client;
    }

    tryReconnectPlayer(
        socket: ClientSocket<Client>,
        joinMsg: net.JoinMsg,
        joinData: JoinTokenData,
    ): Client | undefined {
        const joinName = validateUserName(joinMsg.name).validName.toLowerCase();
        // Account id, callsign, or explicit seat id — never reclaim by IP alone
        // (full LAN squads share one NAT).
        if (!joinName && !joinData.userId && !joinData.reclaimPlayerId) {
            return undefined;
        }

        const namesMatchForReclaim = (seatName: string, wantName: string) => {
            const a = validateUserName(seatName).validName.toLowerCase();
            const b = validateUserName(wantName).validName.toLowerCase();
            if (a === b) return true;
            // uniqueInGameNames may rename "bob" → "bob-1". Only treat that as a
            // match when the join name is the base and the seat has "-N" appended.
            // Do NOT strip both sides — "op-0" vs "op-1" must stay distinct.
            if (!b || a.length <= b.length) return false;
            return a.startsWith(b) && /^-\d+$/.test(a.slice(b.length));
        };

        const matchesSeat = (p: Player) => {
            if (p.specOpsAi) return false;
            // Spec Ops keeps dead operators for buyback — allow seat reclaim.
            if (p.dead && !this.game.map.specOpsMode) return false;

            if (
                joinData.reclaimPlayerId
                && p.__id === joinData.reclaimPlayerId
            ) {
                return true;
            }
            if (joinData.userId && p.userId && joinData.userId === p.userId) {
                return true;
            }
            if (!joinName) return false;
            return namesMatchForReclaim(p.name, joinName);
        };

        const candidates = this.game.playerBarn.players.filter(matchesSeat);
        if (!candidates.length) return undefined;

        // Prefer a free seat; Spec Ops still force-reclaims a "busy" seat so a
        // page reload that races the old websocket close cannot spawn a duplicate.
        const free = candidates.find(
            (p) => p.disconnected || p.client.socket.closed(),
        );
        const player = free
            ?? (this.game.map.specOpsMode ? candidates[0] : undefined);
        if (!player) return undefined;

        const oldClient = player.client;
        if (oldClient && oldClient.socket !== socket) {
            // Detach before close so handleSocketClose does not treat the
            // reclaimed operator as a fresh leave.
            (oldClient as { player?: Player }).player = undefined;
            util.removeFrom(this.clients, oldClient);
            if (!oldClient.socket.closed()) {
                try {
                    oldClient.disconnect();
                } catch {
                    // ignore
                }
            }
        } else if (oldClient?.socket.closed()) {
            util.removeFrom(this.clients, oldClient);
        }

        const client = new Client(this.game, socket, joinData.userId, joinData.findGameIp);
        player.client = client;
        client.player = player;
        client.disconnected = false;
        this.clients.push(client);

        // If they were spectating before disconnect, clear so they control themselves
        // (alive) or can wait for buyback (dead Spec Ops).
        client.spectating = undefined;
        client.startedSpectating = true;

        player.setDirty();
        player.setPartDirty();
        player.group?.checkPlayers();
        player.setGroupStatuses();
        this.game.logger.info(`"${player.name}" reconnected`);

        return client;
    }

    deserializeMsg(buff: ArrayBuffer | Uint8Array): {
        type: net.MsgType;
        msg: net.AbstractMsg | undefined;
        error?: GameWsDisconnectReason;
    } {
        const msgStream = new net.MsgStream(buff);
        const stream = msgStream.stream;

        const type = msgStream.deserializeMsgType();

        let msg:
            | net.JoinMsg
            | net.InputMsg
            | net.EmoteMsg
            | net.DropItemMsg
            | net.SpectateMsg
            | net.PerkModeRoleSelectMsg
            | net.EditMsg
            | net.PracticeSettingsMsg
            | net.PracticeGiveMsg
            | undefined = undefined;

        switch (type) {
            case net.MsgType.Join: {
                // read protocol version outside of JoinMsg
                // reason: if theres a protocol change in JoinMsg it will fail to deserialize the entire msg
                // and won't give the proper invalid-protocol error
                // so we read it before deserializing the msg to avoid it throwing and giving the wrong error

                const oldIdx = stream.index;
                const protocol = stream.readUint32();

                if (protocol !== GameConfig.protocolVersion) {
                    return {
                        type: net.MsgType.Join,
                        msg: undefined,
                        error: "invalid_protocol",
                    };
                }
                stream.index = oldIdx;

                msg = new net.JoinMsg();
                msg.deserialize(stream);
                break;
            }
            case net.MsgType.Input: {
                msg = new net.InputMsg();
                msg.deserialize(stream);
                break;
            }
            case net.MsgType.Emote:
                msg = new net.EmoteMsg();
                msg.deserialize(stream);
                break;
            case net.MsgType.DropItem:
                msg = new net.DropItemMsg();
                msg.deserialize(stream);
                break;
            case net.MsgType.Spectate:
                msg = new net.SpectateMsg();
                msg.deserialize(stream);
                break;
            case net.MsgType.PerkModeRoleSelect:
                msg = new net.PerkModeRoleSelectMsg();
                msg.deserialize(stream);
                break;
            case net.MsgType.Edit:
                if (!Config.debug.allowEditMsg) break;
                msg = new net.EditMsg();
                msg.deserialize(stream);
                break;
            case net.MsgType.PracticeSettings:
                msg = new net.PracticeSettingsMsg();
                msg.deserialize(stream);
                break;
            case net.MsgType.PracticeGive:
                msg = new net.PracticeGiveMsg();
                msg.deserialize(stream);
                break;
        }

        return {
            type,
            msg,
        };
    }

    handleMsg(buff: ArrayBuffer | Buffer | Uint8Array | string, socket: ClientSocket<Client>) {
        if (typeof buff === "string") return;
        if (
            !(buff instanceof ArrayBuffer)
            && !Buffer.isBuffer(buff)
            && !(buff instanceof Uint8Array)
        ) {
            return;
        }

        const payload: ArrayBuffer | Uint8Array = buff instanceof ArrayBuffer
            ? buff
            : buff;

        let client = socket.getUserData();

        let msg: net.AbstractMsg | undefined = undefined;
        let type = net.MsgType.None;
        let error: GameWsDisconnectReason | undefined;

        try {
            const deserialized = this.deserializeMsg(payload);
            msg = deserialized.msg;
            type = deserialized.type;
            error = deserialized.error;
        } catch (err) {
            this.game.logger.error(
                "Failed to deserialize msg: ",
                err,
                "msg buffer: ",
                // JSON.stringify doesn't work on buffers, so need to convert to an Uint8Array first
                // and then to a regular array... 😭
                // the slice is to make sure it doesn't overflow the error webhook
                JSON.stringify([
                    ...new Uint8Array(
                        payload instanceof ArrayBuffer
                            ? payload.slice(0, 255)
                            : payload.subarray(0, 255),
                    ),
                ]),
            );
            socket.close("invalid_packet");
            return;
        }

        if (error) {
            this.game.logger.warn("Disconnecting socket because of packet error:", error);
            socket.close(error);
            return;
        }

        if (!msg) return;

        if (type === net.MsgType.Join && !client) {
            client = this.game.clientBarn.addClientWithPlayer(socket, msg as net.JoinMsg);
            return;
        }

        if (!client) {
            this.game.logger.warn("No client found and we didn't receive a JoinMsg, closing socket");
            socket.close("invalid_packet");
            return;
        }

        if (socket.closed()) {
            return;
        }
        client.handleMsg(type, msg);
    }

    handleSocketClose(socket: ClientSocket<Client>) {
        const client = socket.getUserData();
        if (!client) return;
        client.spectating = undefined;
        client.disconnected = true;
        util.removeFrom(this.clients, client);

        if (!client.player) return;
        const player = client.player;
        this.game.logger.info(`"${player.name}" left`);

        // reset direction and movement
        player.dirNew = v2.create(1, 0);
        player.moveLeft = false;
        player.moveRight = false;
        player.moveUp = false;
        player.moveDown = false;
        player.shootHold = false;
        player.touchMoveActive = false;

        player.setPartDirty();
        player.group?.checkPlayers();
        player.setGroupStatuses();
        player.questManager.flushProgress();

        if (player.canDespawn()) {
            player.game.playerBarn.removePlayer(player);
        } else if (this.game.map.specOpsMode) {
            this.game.checkGameOver();
            this.game.updateData();
        }
    }

    broadcastMsg(type: net.MsgType, msg: net.Msg) {
        this.msgsToSend.serializeMsg(type, msg);
    }
}

export class Client {
    game: Game;
    socket: ClientSocket<Client>;

    disconnected = false;

    userId: string | null = null;
    ip: string;
    // see comment on server/src/api/schema.ts
    // about logging find_game IP's
    findGameIp: string;

    lastPlayerId = 0;
    player?: Player = undefined;

    /** true when player starts spectating new player, only stays true for that given tick */
    startedSpectating: boolean = false;

    private _spectating?: Player;

    get spectating(): Player | undefined {
        return this._spectating;
    }

    set spectating(player: Player | undefined) {
        if (player && player === this.player) {
            throw new Error(
                `Player ${player.name} tried spectate themselves (how tf did this happen?)`,
            );
        }
        if (this._spectating === player) return;

        if (this._spectating) {
            this._spectating.spectators.delete(this);
            this._spectating.recalculateSpectatorCount();
        }
        if (player) {
            player.spectators.add(this);
            player.recalculateSpectatorCount();
        }

        this._spectating = player;
        this.startedSpectating = true;
    }

    private _specCooldown = 0;
    private _specAction = SpectateAction.None;
    specAnon = false;

    spectateNewPlayerTicker = 0;

    private _firstUpdate = true;
    /** Joined+Map already delivered (may happen before the first full Update). */
    private _bootstrapSent = false;
    /** Player ids whose PlayerInfo has already been sent to this client. */
    private _sentPlayerInfoIds = new Set<number>();
    visibleObjects = new Set<GameObject>();
    private _visibleObjectsScratch = new Set<GameObject>();
    visibleMapIndicators = new Set<MapIndicator>();

    // zoom used for the area in which the server will send objects to the client
    private _cullingZoom = GameConfig.scopeZoomRadius.desktop["1xscope"];

    portrait = false;
    private _cullingPortrait = false;
    private _cullingPortraitTicker = 0;

    // Spec Ops reconnects can need a large first Update (many nearby NPCs).
    msgStream = new net.MsgStream(new ArrayBuffer(1 << 18));
    msgsToSend: Array<{ type: number; msg: net.Msg }> = [];

    ack = 0;

    /** Consecutive net sync ticks where this client's socket was backpressured. */
    private _consecutiveBackpressure = 0;

    /**
     * Object ids that left visibility or were destroyed while this client was
     * backpressured. Flushed into the next successful Update so the client does
     * not keep stale instances after server id reuse.
     */
    private _pendingDelObjIds: number[] = [];

    constructor(
        game: Game,
        socket: ClientSocket<Client>,
        userId: string | null,
        findGameIp: string,
    ) {
        this.userId = userId;
        this.ip = socket.ip();
        this.findGameIp = findGameIp;
        this.game = game;
        socket.setUserData(this);
        this.socket = socket as ClientSocket<Client>;
    }

    sendMsg(type: net.MsgType, msg: net.AbstractMsg): void {
        this.msgsToSend.push({ type, msg });
    }

    sendInstantMsg(type: net.MsgType, msg: net.AbstractMsg, bytes = 128): void {
        const stream = new net.MsgStream(new ArrayBuffer(bytes));
        stream.serializeMsg(type, msg);
        this.sendData(stream.getBuffer());
    }

    sendData(buffer: Uint8Array<ArrayBuffer>): void {
        this.socket.send(buffer);
    }

    disconnect(reason?: GameWsDisconnectReason) {
        this.socket.close(reason);
    }

    update(dt: number) {
        if (this.spectating) {
            let newPlayerToSpectate: Player | undefined = undefined;

            // switch to a new spectator after 2 seconds if the player we are spectating has died
            if (this.spectating.dead) {
                this.spectateNewPlayerTicker += dt;
                if (this.spectateNewPlayerTicker > 2) {
                    newPlayerToSpectate = this.getNewPlayerToSpectate();
                    this.spectateNewPlayerTicker = 0;
                }
            } else {
                this.spectateNewPlayerTicker = 0;
            }

            // spectate prev/next keybind logic
            this._specCooldown -= dt;
            if (this._specCooldown <= 0 && this._specAction !== SpectateAction.None) {
                const nextOrPrev = this._specAction === SpectateAction.Next ? +1 : -1;
                const spectatablePlayers = this.getSpectablePlayers(true);

                newPlayerToSpectate = util.wrappedArrayIndex(
                    spectatablePlayers,
                    spectatablePlayers.indexOf(this.spectating!) + nextOrPrev,
                );

                // when spectating teammates we can have a lower cooldown
                // since it cant be abused to know players positions
                this._specCooldown = this.shouldSpectateTeam() ? 0.1 : 1;
                this._specAction = SpectateAction.None;
            }

            if (newPlayerToSpectate) {
                this.spectating = newPlayerToSpectate;
            }
        }

        const targetZoom = this.spectating?.zoom ?? this.player?.zoom ?? 1;

        // lerp towards the target zoom
        if (math.eqAbs(this._cullingZoom, targetZoom, 0.1)) {
            this._cullingZoom = targetZoom;
        } else {
            this._cullingZoom = math.lerp(dt * 4, this._cullingZoom, targetZoom);
        }

        if (this.portrait !== this._cullingPortrait) {
            this._cullingPortraitTicker -= dt;
            if (this._cullingPortraitTicker <= 0) {
                this._cullingPortrait = this.portrait;
            }
        }
    }

    /**
     * Joined + Map must arrive before any Update so the client can init and load
     * terrain. Keep them in their own packet — Spec Ops first Updates are huge.
     */
    private sendJoinBootstrap(): void {
        if (this._bootstrapSent) return;
        const bootstrap = new net.MsgStream(new ArrayBuffer(1 << 17));
        const joinedMsg = new net.JoinedMsg();
        joinedMsg.teamMode = this.game.teamMode;
        joinedMsg.playerId = this.player?.__id ?? 0;
        joinedMsg.started = this.game.started;
        if (this.player) {
            joinedMsg.emotes = this.player.loadout.emotes;
        }
        bootstrap.serializeMsg(net.MsgType.Joined, joinedMsg);

        const mapStream = this.game.map.mapStream.stream;
        bootstrap.stream.writeBytes(mapStream, 0, mapStream.byteIndex);
        this.sendData(bootstrap.getBuffer());
        this._bootstrapSent = true;
    }

    /**
     * Spec Ops can have hundreds of AI players. Dumping all PlayerInfos on the
     * first Update overflows the 8-bit array and bloated packets stall reconnect.
     * Send humans up front; attach AI infos the first time they enter visibility.
     */
    private collectPlayerInfos(
        playerBarn: { players: Player[]; newPlayers: Player[] },
        fullObjects: Array<{ __id: number; __type: ObjectType }>,
    ): Player[] {
        const out: Player[] = [];
        const pushInfo = (p: Player) => {
            if (this._sentPlayerInfoIds.has(p.__id)) return;
            this._sentPlayerInfoIds.add(p.__id);
            out.push(p);
        };

        if (this._firstUpdate) {
            const players = playerBarn.players;
            for (let i = 0; i < players.length; i++) {
                const p = players[i];
                if (this.game.map.specOpsMode && p.specOpsAi) continue;
                pushInfo(p);
            }
        } else {
            const news = playerBarn.newPlayers;
            for (let i = 0; i < news.length; i++) {
                pushInfo(news[i]);
            }
        }

        for (let i = 0; i < fullObjects.length; i++) {
            const obj = fullObjects[i];
            if (obj.__type !== ObjectType.Player) continue;
            pushInfo(obj as Player);
        }

        return out;
    }

    sendMsgs(): void {
        const player = this.spectating ?? this.player;
        if (!player) return;

        if (this.socket.isBackpressured()) {
            this._consecutiveBackpressure++;
            if (this.msgsToSend.length > MAX_QUEUED_CLIENT_MSGS) {
                this.msgsToSend.splice(0, this.msgsToSend.length - MAX_QUEUED_CLIENT_MSGS);
            }
            // Capture deletes before objectRegister.flush() zeros __id. Without
            // this, the next Update can full-sync a reused id onto a stale client
            // object (loot/gun types into Obstacle.m_updateData, etc.).
            const deleted = this.game.objectRegister.deletedObjs;
            if (deleted.length > 0) {
                const deletedSet = new Set(deleted);
                for (const obj of this.visibleObjects) {
                    if (!deletedSet.has(obj)) continue;
                    if (obj.__id > 0) {
                        this._pendingDelObjIds.push(obj.__id);
                    }
                    this.visibleObjects.delete(obj);
                }
            }
            // Still deliver Joined+Map so reconnect clients are not stuck on an
            // empty HUD while the Update waits for a clear send window.
            if (!this._bootstrapSent) {
                this.sendJoinBootstrap();
            }
            return;
        }

        const msgStream = this.msgStream;
        const game = this.game;
        const playerBarn = game.playerBarn;
        msgStream.stream.index = 0;

        const thinSync = this._consecutiveBackpressure > 0;
        const minimalSync = this._consecutiveBackpressure >= 2;

        if (!this._bootstrapSent) {
            this.sendJoinBootstrap();
        }

        if (playerBarn.aliveCountDirty || this._firstUpdate) {
            const aliveMsg = new net.AliveCountsMsg();
            this.game.modeManager.updateAliveCounts(aliveMsg.teamAliveCounts);
            msgStream.serializeMsg(net.MsgType.AliveCounts, aliveMsg);
        }

        const updateMsg = new net.UpdateMsg();
        updateMsg.ack = this.ack;

        if (game.gas.dirty || this._firstUpdate) {
            updateMsg.gasDirty = true;
            updateMsg.gasData = game.gas;
        }

        if (game.gas.timeDirty || this._firstUpdate) {
            updateMsg.gasTDirty = true;
            updateMsg.gasT = game.gas.gasT;
        }

        const radius = this._cullingZoom + 4;
        let width = this._cullingZoom + 4;
        // client zoom tries to keep a 16/9 aspect ratio, mirror it here
        let height = width / (16 / 9);
        if (this._cullingPortrait) {
            let tmp = width;
            width = height;
            height = tmp;
        }
        const rect = collider.createAabbExtents(player.pos, v2.create(width, height));

        const newVisibleObjects = game.grid.intersectAABBSetInto(rect, this._visibleObjectsScratch);
        // client crashes if active player is not visible
        // so make sure its always added to visible objects
        newVisibleObjects.add(player);

        if (this._pendingDelObjIds.length > 0) {
            for (let i = 0; i < this._pendingDelObjIds.length; i++) {
                updateMsg.delObjIds.push(this._pendingDelObjIds[i]);
            }
            this._pendingDelObjIds.length = 0;
        }

        for (const obj of this.visibleObjects) {
            if (!newVisibleObjects.has(obj)) {
                // Skip zeroed ids from objects destroyed while we were backpressured
                // but somehow still referenced (pending list should cover the normal case).
                if (obj.__id > 0) {
                    updateMsg.delObjIds.push(obj.__id);
                }
            }
        }

        for (const obj of newVisibleObjects) {
            const needsFull = !this.visibleObjects.has(obj)
                || game.objectRegister.dirtyFull[obj.__id];
            if (needsFull) {
                // Slow clients: skip re-sending full state for already-visible objects.
                if (thinSync && this.visibleObjects.has(obj)) {
                    if (game.objectRegister.dirtyPart[obj.__id]) {
                        updateMsg.partObjects.push(obj);
                    }
                } else {
                    updateMsg.fullObjects.push(obj);
                }
            } else if (game.objectRegister.dirtyPart[obj.__id]) {
                updateMsg.partObjects.push(obj);
            }
        }

        // Swap buffers to avoid allocating a new Set every net sync tick.
        this._visibleObjectsScratch = this.visibleObjects;
        this.visibleObjects = newVisibleObjects;

        updateMsg.activePlayerId = player.__id;
        if (this.startedSpectating) {
            updateMsg.activePlayerIdDirty = true;

            // build the active player data object manually
            // To avoid setting the spectating player fields to dirty
            updateMsg.activePlayerData = {
                healthDirty: true,
                health: player.health,
                boostDirty: true,
                boost: player.boost,
                zoomDirty: true,
                zoom: player.zoom,
                actionDirty: true,
                action: player.action,
                inventoryDirty: true,
                inventory: player.inventory,
                scope: player.scope,
                weapsDirty: true,
                curWeapIdx: player.curWeapIdx,
                weapons: player.weapons,
                spectatorCountDirty: true,
                spectatorCount: player.spectatorCount,
                specOpsCashDirty: true,
                specOpsCash: player.specOpsCash,
                specOpsArmorDirty: true,
                specOpsArmor: player.specOpsArmor,
                specOpsContractDirty: true,
                specOpsContractHud: player.specOpsContractHud,
            };
            this.startedSpectating = false;
        } else {
            updateMsg.activePlayerIdDirty = player.__id !== this.lastPlayerId;
            updateMsg.activePlayerData = player;
        }
        this.lastPlayerId = player.__id;

        updateMsg.playerInfos = this.collectPlayerInfos(playerBarn, updateMsg.fullObjects);

        updateMsg.deletedPlayerIds = playerBarn.deletedPlayers;

        if (!minimalSync && playerBarn.playerStatusTicker > playerBarn.playerStatusRate) {
            let statuses = player.getPlayerStatus();
            updateMsg.playerStatus = statuses;
            updateMsg.playerStatusDirty = true;
        }

        if (!minimalSync && player.groupStatusDirty) {
            const teamPlayers = player.group!.players;

            let statuses: GroupStatus[] = [];
            for (const p of teamPlayers) {
                // Wire format is 0-100; Spec Ops operators use 200 HP so send percent.
                const maxHp = Math.max(p.maxHealth, 1);
                statuses.push({
                    health: math.clamp((p.health / maxHp) * 100, 0, 100),
                    disconnected: p.disconnected,
                });
            }
            updateMsg.groupStatus = statuses;
            updateMsg.groupStatusDirty = true;
        }

        const shouldSendEmote = (emote: Emote) => {
            const emotePlayer = game.objectRegister.getById(emote.playerId) as
                | Player
                | undefined;

            const emoteDef = GameObjectDefs.typeToDef(emote.type);

            if (emotePlayer) {
                if (!emote.isPing && !this.visibleObjects.has(emotePlayer)) {
                    return false;
                }

                // regular emotes: always send if visible
                if (!emote.isPing && !(emoteDef as EmoteDef).teamOnly) {
                    return true;
                }

                // part of the same group
                if (emotePlayer?.groupId === player.groupId) {
                    return true;
                }

                // part of the same team
                if (emotePlayer?.teamId === player.teamId && !emote.isPing) {
                    return true;
                }

                // faction team leader
                if (
                    (emotePlayer.role === "leader"
                        || emotePlayer.role === "captain"
                        || emotePlayer.role === "last_man")
                    && emotePlayer.teamId === player.teamId
                ) {
                    return true;
                }
            }

            // always send map events pings
            if (emote.isPing && emoteDef.type === "ping" && emoteDef.mapEvent) {
                return true;
            }

            return false;
        };

        if (!minimalSync) {
            for (let i = 0; i < playerBarn.emotes.length; i++) {
                const emote = playerBarn.emotes[i];
                if (shouldSendEmote(emote)) {
                    updateMsg.emotes.push(emote);
                }
            }
        }

        const extendedRadius = minimalSync ? radius : 1.1 * radius;
        const radiusSquared = extendedRadius * extendedRadius;

        const bullets = game.bulletBarn.newBullets;
        for (let i = 0; i < bullets.length; i++) {
            const bullet = bullets[i];
            if (
                v2.lengthSqr(v2.sub(bullet.pos, player.pos)) < radiusSquared
                || v2.lengthSqr(v2.sub(bullet.clientEndPos, player.pos)) < radiusSquared
                || coldet.intersectSegmentCircle(
                    bullet.pos,
                    bullet.clientEndPos,
                    player.pos,
                    extendedRadius,
                )
            ) {
                updateMsg.bullets.push(bullet);
            }
        }

        for (let i = 0; i < game.explosionBarn.newExplosions.length; i++) {
            const explosion = game.explosionBarn.newExplosions[i];
            const rad = explosion.rad + extendedRadius;
            if (v2.lengthSqr(v2.sub(explosion.pos, player.pos)) < rad * rad) {
                updateMsg.explosions.push(explosion);
            }
        }

        if (!minimalSync) {
            const planes = this.game.planeBarn.planes;
            for (let i = 0; i < planes.length; i++) {
                const plane = planes[i];
                if (
                    coldet.testCircleAabb(plane.pos, plane.rad, rect.min, rect.max)
                    && coldet.testPointAabb(
                        plane.pos,
                        this.game.planeBarn.planeBounds.min,
                        this.game.planeBarn.planeBounds.max,
                    )
                ) {
                    updateMsg.planes.push(plane);
                }
            }
        }

        const newAirstrikeZones = this.game.planeBarn.newAirstrikeZones;
        for (let i = 0; i < newAirstrikeZones.length; i++) {
            const zone = newAirstrikeZones[i];
            if (v2.lengthSqr(v2.sub(zone.pos, player.pos)) < radiusSquared) {
                updateMsg.airstrikeZones.push(zone);
            }
        }

        const indicatorRadiusSq = (extendedRadius * 2) * (extendedRadius * 2);
        const indicators = this.game.mapIndicatorBarn.mapIndicators;
        for (let i = 0; i < indicators.length; i++) {
            const indicator = indicators[i];
            const inRange = v2.lengthSqr(v2.sub(indicator.pos, player.pos)) < indicatorRadiusSq;
            if (!inRange && !indicator.equipped) {
                this.visibleMapIndicators.delete(indicator);
                continue;
            }
            if (indicator.dirty || !this.visibleMapIndicators.has(indicator)) {
                updateMsg.mapIndicators.push(indicator);
                this.visibleMapIndicators.add(indicator);
            }
            if (indicator.dead) {
                this.visibleMapIndicators.delete(indicator);
            }
        }

        if (this.game.map.specOpsMode && this.game.specOps) {
            if (this.game.specOps.hudDirty || this._firstUpdate) {
                updateMsg.killLeaderDirty = true;
                updateMsg.killLeaderId = this.game.specOps.hudWaveId;
                updateMsg.killLeaderKills = this.game.specOps.hudCounter;
            }
        } else if (playerBarn.killLeaderDirty || this._firstUpdate) {
            updateMsg.killLeaderDirty = true;
            updateMsg.killLeaderId = playerBarn.killLeader?.__id ?? 0;
            updateMsg.killLeaderKills = playerBarn.killLeader?.kills ?? 0;
        }

        msgStream.serializeMsg(net.MsgType.Update, updateMsg);

        for (let i = 0; i < this.msgsToSend.length; i++) {
            const msg = this.msgsToSend[i];
            msgStream.serializeMsg(msg.type, msg.msg);
        }

        this.msgsToSend.length = 0;

        const globalMsgStream = this.game.clientBarn.msgsToSend.stream;
        msgStream.stream.writeBytes(globalMsgStream, 0, globalMsgStream.byteIndex);

        this.sendData(msgStream.getBuffer());

        if (this.socket.isBackpressured()) {
            this._consecutiveBackpressure++;
        } else {
            this._consecutiveBackpressure = 0;
        }

        this._firstUpdate = false;
    }

    handleMsg(type: net.MsgType, msg: net.Msg) {
        const player = this.player;
        switch (type) {
            case net.MsgType.Input: {
                const imsg = msg as net.InputMsg;
                if (this.portrait != imsg.portrait) {
                    this._cullingPortraitTicker = 0.5;
                }
                this.portrait = imsg.portrait;

                this.ack = imsg.seq;

                if (!player) break;
                player.handleInput(imsg);
                break;
            }
            case net.MsgType.Emote: {
                if (!player) break;

                player.emoteFromMsg(msg as net.EmoteMsg);
                break;
            }
            case net.MsgType.DropItem: {
                if (!player) break;

                player.dropItem(msg as net.DropItemMsg);
                break;
            }
            case net.MsgType.Spectate: {
                this.handleSpectateMsg(msg as net.SpectateMsg);
                break;
            }
            case net.MsgType.PerkModeRoleSelect: {
                if (!player) break;
                const roleMsg = msg as net.PerkModeRoleSelectMsg;
                player.roleSelect(
                    roleMsg.role,
                    roleMsg.hasPos ? roleMsg.pos : undefined,
                );
                break;
            }
            case net.MsgType.Edit: {
                if (!player) break;
                player.processEditMsg(msg as net.EditMsg);
                break;
            }
            case net.MsgType.PracticeGive: {
                if (!player || !this.game.specOps?.practice) break;
                const give = msg as net.PracticeGiveMsg;
                if (give.respawnBots) this.game.specOps.practice.respawnBotsNow();
                this.game.specOps.givePracticeItem(player, give.item, give.count, give.clearInventory);
                break;
            }
            case net.MsgType.PracticeSettings: {
                if (!player) break;
                this.game.specOps?.practice?.applySettings(
                    player,
                    (msg as net.PracticeSettingsMsg).settings,
                );
                break;
            }
        }
    }

    shouldSpectateTeam() {
        if (!this.player) return false;

        const team = this.player.team || this.player.group;
        if (!team) return false;

        return !team.allDeadOrDisconnected;
    }

    getSpectablePlayers(includeCurrent = false): Player[] {
        // we want to include the player we are currently spectating
        // even if they are dead, we only switch to a new player after 2 seconds
        // and not including it in the list will mess up the index for prev/next keybinds
        const shouldSpectate = (p: Player) => {
            if (includeCurrent && p === this.spectating) return true;
            return !p.dead;
        };

        if (this.shouldSpectateTeam()) {
            const team = this.player!.team ?? this.player!.group!;

            const groupId = this.player!.groupId;
            // put our group first, then sort others by their own group
            // so on faction mode we start spectating our own group first
            return team.players.filter(shouldSpectate).toSorted((a, b) => {
                if (a.groupId === b.groupId) {
                    return a.matchDataId - b.matchDataId;
                }

                if (a.groupId === groupId) return -Infinity;
                if (b.groupId === groupId) return Infinity;

                return a.groupId - b.groupId;
            });
        } else if (!this.game.isTeamMode) {
            return this.game.playerBarn.players.filter(shouldSpectate).toSorted((a, b) => {
                if (a.groupId === b.groupId) {
                    return a.matchDataId - b.matchDataId;
                }
                return a.groupId - b.groupId;
            });
        } else {
            return this.game.playerBarn.players.filter(shouldSpectate);
        }
    }

    getNewPlayerToSpectate(): Player {
        const spectateTeam = this.shouldSpectateTeam();
        let killer: Player | undefined = undefined;
        if (this.player && !spectateTeam) {
            killer = this.player.getAliveKiller();
        }
        if (killer) return killer;
        return this.getSpectablePlayers()[0];
    }

    handleSpectateMsg(spectateMsg: net.SpectateMsg): void {
        if (this.player && !this.player.dead) return;

        switch (spectateMsg.action) {
            case SpectateAction.Begin:
                if (this.spectating) break;
                this.spectating = this.getNewPlayerToSpectate();
                break;
            case SpectateAction.Next:
            case SpectateAction.Prev:
                this._specAction = spectateMsg.action;
                break;
        }
    }
}
