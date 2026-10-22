import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { parseServerEndpoint } from "../../../config.ts";
import type { FindGamePrivateError, SiteInfoRes } from "../../../shared/types/api.ts";
import { Config } from "../config.ts";
import { TeamMenu } from "../teamMenu.ts";
import { GIT_VERSION } from "../utils/gitRevision.ts";
import { ServerLogger } from "../utils/logger.ts";
import {
    buildInternalSessionFindGameUrl,
    buildSessionFindGameUrl,
    signFindGameTicket,
} from "../utils/sessionTicket.ts";
import type { FindGamePrivateBody, FindGamePrivateRes } from "../utils/types.ts";

/** Runtime server entry (from config seed and/or game-node handshake). */
export type RegionEndpoint = {
    https: boolean;
    address: string;
    publicAddress?: string;
    name?: string;
    l10n?: string;
    url?: string;
};

/** Drop from Server dropdown when no heartbeat within this window. */
export const REGION_HEARTBEAT_STALE_MS = 20_000;

/** Team lobby may briefly call the child session endpoint; keep this tiny. */
export const REGION_SESSION_FETCH_MS = 2_000;

function titleCaseServerId(id: string): string {
    if (!id) return "Server";
    return id
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

class Region {
    data: RegionEndpoint;
    playerCount = 0;

    /** Last successful handshake or update_region heartbeat (child → master). */
    lastUpdateTime = 0;

    /**
     * Listed in master's config at boot. Still only shown while heartbeats arrive
     * (local game process posts update_region every ~5s).
     */
    readonly seededFromConfig: boolean;

    constructor(
        readonly id: string,
        data?: RegionEndpoint,
        opts?: { seededFromConfig?: boolean },
    ) {
        this.data = data ?? { ...Config.regions[id] };
        this.seededFromConfig = opts?.seededFromConfig ?? false;
    }

    get isAlive(): boolean {
        return this.lastUpdateTime > 0
            && Date.now() - this.lastUpdateTime < REGION_HEARTBEAT_STALE_MS;
    }

    applyEndpoint(data: RegionEndpoint) {
        this.data = { ...this.data, ...data };
    }
}

interface RegionData {
    playerCount: number;
    publicGames?: Array<{
        gameId: string;
        mapName: string;
        teamMode: number;
        players: number;
        maxPlayers: number;
        timeRunning: number;
        canJoin: boolean;
    }>;
}

export class ApiServer {
    readonly logger = new ServerLogger("Server");

    teamMenu = new TeamMenu(this);

    regions: Record<string, Region> = {};
    publicGames: import("../../../shared/types/api.ts").PublicGameInfo[] = [];

    modes = [...Config.modes];
    clientTheme = Config.clientTheme;

    captchaEnabled = Config.captchaEnabled;

    constructor() {
        // Seed from local config (this host's own game). Remote nodes register
        // via /private/handshake and stay listed only while they heartbeat.
        for (const region in Config.regions) {
            this.regions[region] = new Region(region, undefined, { seededFromConfig: true });
        }
    }

    init(app: Hono, upgradeWebSocket: UpgradeWebSocket) {
        this.teamMenu.init(app, upgradeWebSocket);
    }

    /**
     * Register or refresh a game node after a successful API-key handshake.
     * Master does not need the node listed in `regions` beforehand.
     */
    registerRegion(
        regionId: string,
        opts: {
            address: string;
            name?: string;
            url?: string;
        },
    ): RegionEndpoint {
        const address = parseServerEndpoint(opts.address).hostPort;
        if (!address) {
            throw new Error("invalid_address");
        }

        let https = false;
        let publicAddress = address;
        let url = opts.url?.trim();

        if (url) {
            const parsed = parseServerEndpoint(url);
            if (parsed.hostPort) {
                publicAddress = parsed.hostPort;
                if (parsed.https !== undefined) https = parsed.https;
            }
        } else {
            // Bare address with no url — assume http unless already known.
            const existing = this.regions[regionId]?.data;
            https = existing?.https ?? false;
            publicAddress = existing?.publicAddress || address;
            url = existing?.url;
        }

        const name = opts.name?.trim() || titleCaseServerId(regionId);
        const endpoint: RegionEndpoint = {
            address,
            publicAddress,
            https,
            name,
            url,
            l10n: `index-${regionId}`,
        };

        const existing = this.regions[regionId];
        if (existing) {
            existing.applyEndpoint(endpoint);
            existing.lastUpdateTime = Date.now();
            this.logger.info(
                `Updated game server "${regionId}" → heartbeat OK, matchmaking ${address}`
                    + (publicAddress !== address ? `, players ${publicAddress}` : ""),
            );
        } else {
            const region = new Region(regionId, endpoint, { seededFromConfig: false });
            region.lastUpdateTime = Date.now();
            this.regions[regionId] = region;
            this.logger.info(
                `Registered game server "${regionId}" (${name}) — listed while heartbeats arrive`
                    + ` (matchmaking ${address}`
                    + (publicAddress !== address ? `, players ${publicAddress}` : "")
                    + ")",
            );
        }

        return this.regions[regionId]!.data;
    }

    /** Remove dynamic nodes that stopped heartbeating; zero stale seeded counts. */
    pruneStaleRegions() {
        const now = Date.now();
        for (const regionId of Object.keys(this.regions)) {
            const region = this.regions[regionId]!;
            if (!region.lastUpdateTime) continue;
            if (now - region.lastUpdateTime <= REGION_HEARTBEAT_STALE_MS) continue;

            region.playerCount = 0;
            this.publicGames = this.publicGames.filter((g) => g.region !== regionId);

            if (!region.seededFromConfig) {
                this.logger.warn(
                    `Region ${regionId} missed heartbeats (>${
                        REGION_HEARTBEAT_STALE_MS / 1000
                    }s) — removed from Server list`,
                );
                delete this.regions[regionId];
            } else {
                this.logger.warn(
                    `Region ${regionId} has not sent a heartbeat in more than ${
                        REGION_HEARTBEAT_STALE_MS / 1000
                    } seconds`,
                );
                // Keep slot for local re-link; hide from pops via isAlive.
                region.lastUpdateTime = 0;
            }
        }
    }

    getSiteInfo(): SiteInfoRes {
        const data: SiteInfoRes = {
            modes: this.modes,
            pops: {},
            youtube: { name: "", link: "" },
            twitch: [],
            country: "US",
            gitRevision: GIT_VERSION,
            captchaEnabled: this.captchaEnabled,
            clientTheme: this.clientTheme,
            specOpsNpcSpawn: Config.debug.allowNpcSpawn && Config.debug.allowEditMsg,
            allowEditMsg: Config.debug.allowEditMsg,
            maxSquadSize: Config.maxSquadSize,
            specOpsDifficulty: Config.difficulty,
            specOpsEndless: Config.endless,
            specOpsContractsEnabled: Config.contractsEnabled,
        };

        // Only heartbeat-alive servers appear in the client Server dropdown.
        for (const region in this.regions) {
            const r = this.regions[region]!;
            if (!r.isAlive) continue;
            data.pops[region] = {
                playerCount: r.playerCount,
                l10n: r.data.l10n,
                name: r.data.name,
                address: r.data.publicAddress || r.data.address,
                https: r.data.https,
            };
        }
        return data;
    }

    updateRegion(regionId: string, regionData: RegionData) {
        const region = this.regions[regionId];
        if (!region) {
            this.logger.warn("updateRegion: Invalid region", regionId);
            return;
        }
        region.playerCount = regionData.playerCount;
        region.lastUpdateTime = Date.now();

        if (regionData.publicGames) {
            const others = this.publicGames.filter((g) => g.region !== regionId);
            this.publicGames = [
                ...others,
                ...regionData.publicGames.map((g) => ({ ...g, region: regionId })),
            ];
        }
    }

    /** Immediately hide a region that failed session find (do not wait for heartbeat TTL). */
    markRegionUnreachable(regionId: string, reason?: string) {
        const region = this.regions[regionId];
        if (!region) return;
        region.playerCount = 0;
        region.lastUpdateTime = 0;
        this.publicGames = this.publicGames.filter((g) => g.region !== regionId);
        this.logger.warn(
            `Region ${regionId} marked unreachable${
                reason ? ` (${reason})` : ""
            } — dropped from Server list until next heartbeat`,
        );
        if (!region.seededFromConfig) {
            delete this.regions[regionId];
        }
    }

    /** Player-facing session find URL for a live region (client or team lobby). */
    getSessionFindUrl(regionId: string): string | undefined {
        const region = this.regions[regionId];
        if (!region?.isAlive) return undefined;
        return buildSessionFindGameUrl(region.data);
    }

    /**
     * Issue a short-lived ticket for find_game on the region host.
     * Master does not contact the child — caller (browser or team lobby) does.
     */
    issueFindGameSession(
        regionId: string,
        body: FindGamePrivateBody,
    ): { findUrl: string; ticket: string } | { error: FindGamePrivateError } {
        const region = this.regions[regionId];
        if (!region?.isAlive) {
            return { error: "invalid_region" };
        }
        const findUrl = buildSessionFindGameUrl(region.data);
        if (!findUrl) {
            return { error: "find_game_failed" };
        }
        const ticket = signFindGameTicket(
            regionId,
            { ...body, region: regionId },
            Config.secrets.SURVEV_API_KEY,
        );
        return { findUrl, ticket };
    }

    /**
     * Team lobby only: complete find_game on the child with a hard timeout.
     * Solo play never uses this — the client talks to the child directly.
     */
    async completeSessionFindGame(
        regionId: string,
        body: FindGamePrivateBody,
    ): Promise<FindGamePrivateRes> {
        const session = this.issueFindGameSession(regionId, body);
        if ("error" in session) {
            return { error: session.error };
        }

        try {
            const region = this.regions[regionId];
            const internalUrl = buildInternalSessionFindGameUrl(region?.data.address)
                ?? session.findUrl;
            const res = await fetch(internalUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ticket: session.ticket }),
                signal: AbortSignal.timeout(REGION_SESSION_FETCH_MS),
            });
            if (!res.ok) {
                this.markRegionUnreachable(regionId, `session HTTP ${res.status}`);
                return { error: "find_game_failed" };
            }
            const data = (await res.json()) as FindGamePrivateRes;
            if ("error" in data) {
                if (data.error === "find_game_failed" || data.error === "invalid_region") {
                    this.markRegionUnreachable(regionId, data.error);
                }
                return data;
            }
            return data;
        } catch (err) {
            const name = err instanceof Error ? err.name : "";
            this.markRegionUnreachable(
                regionId,
                name === "TimeoutError" ? "session timeout" : "session unreachable",
            );
            return { error: "find_game_failed" };
        }
    }
}

export const server = new ApiServer();
