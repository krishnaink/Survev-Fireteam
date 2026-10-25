import { z } from "zod";
import type { MapDefKey } from "../defs/mapDefs.ts";
import type { SpecOpsDifficulty } from "../defs/maps/specOpsShop.ts";
import type { TeamMode } from "../gameConfig.ts";

export const zFindGameBody = z.object({
    region: z.string(),
    zones: z.array(z.string()),
    version: z.number(),
    playerCount: z.number(),
    autoFill: z.boolean(),
    gameModeIdx: z.number(),
    gameId: z.string().optional(),
    turnstileToken: z.string().optional(),
    /** Spec Ops difficulty for this match (solo / quick play). */
    difficulty: z.string().optional(),
    /** Spec Ops continuous waves for this match. */
    endless: z.boolean().optional(),
    /** Prefer reclaiming this seat on mid-match rejoin (page reload). */
    reclaimPlayerId: z.number().int().positive().optional(),
    /** Practice vs bots on this map (practice_* key). Always a new private match. */
    practiceMap: z.string().max(32).optional(),
});

export type FindGameBody = z.infer<typeof zFindGameBody>;

export interface FindGameMatchData {
    zone: string;
    gameId: string;
    urls: string[];
    data: string;
}

export const loadoutSchema = z.object({
    outfit: z.string(),
    melee: z.string(),
    heal: z.string(),
    boost: z.string(),
    player_icon: z.string(),
    crosshair: z.object({
        type: z.string(),
        color: z.number(),
        size: z.string(),
        stroke: z.string(),
    }),
    emotes: z.array(z.string()).length(6),
});

export type FindGameError =
    | "banned"
    | "behind_proxy"
    | "find_game_failed"
    | "full"
    | "invalid_captcha"
    | "invalid_ip"
    | "invalid_protocol"
    | "invalid_region"
    | "join_game_failed"
    | "mode_disabled"
    | "rate_limited";

export type FindGamePrivateError =
    | "find_game_failed"
    | "full"
    | "invalid_protocol"
    | "invalid_region";

export type GameWsDisconnectReason =
    | "behind_proxy"
    | "full"
    | "host_closed"
    | "invalid_packet"
    | "invalid_protocol"
    | "ip_banned"
    | "rate_limited"
    | "server_crashed"
    | "server_restart";

/** Join token + child session endpoint — client completes find_game on the region host. */
export interface FindGameSessionData {
    /** Join token used when opening the match WebSocket. */
    data: string;
    /** Absolute URL to POST { ticket } on the game node (not the master). */
    findUrl: string;
    /** HMAC ticket authorizing find_game on the child. */
    ticket: string;
    region: string;
}

export type FindGameResponse =
    | {
        type: "success";
        res: FindGameMatchData;
    }
    | {
        /** Plutonium-style: master authenticated; client finds the match on the child. */
        type: "session";
        res: FindGameSessionData;
    }
    | {
        type: "error";
        error: FindGameError;
    }
    | {
        type: "banned";
        reason: string;
        permanent: boolean;
        expiresIn: Date | string;
    };

export interface SiteInfoRes {
    country: string;
    gitRevision: string;
    captchaEnabled: boolean;
    modes: Array<{
        mapName: string;
        teamMode: TeamMode;
        enabled: boolean;
    }>;
    clientTheme: MapDefKey;
    pops: Record<
        string,
        {
            playerCount: number;
            l10n?: string;
            name?: string;
            /** Client ping / connect host[:port] (no scheme). */
            address?: string;
            https?: boolean;
        }
    >;
    youtube: {
        name: string;
        link: string;
    };
    twitch: Array<{
        name: string;
        viewers: number;
        url: string;
        img: string;
    }>;
    /** Server has Spec Ops NPC spawn debug enabled (editor Players tab). */
    specOpsNpcSpawn?: boolean;
    /** Editor edit-msg debug enabled. */
    allowEditMsg?: boolean;
    /** How many humans a Squad lobby / Spec Ops group allows (2–8). */
    maxSquadSize?: number;
    /** Spec Ops difficulty default (solo / new lobbies). */
    specOpsDifficulty?: SpecOpsDifficulty;
    /** Spec Ops continuous-waves default (solo / new lobbies). */
    specOpsEndless?: boolean;
    /** Mid-wave Spec Ops contracts enabled. */
    specOpsContractsEnabled?: boolean;
}

export interface PublicGameInfo {
    gameId: string;
    region: string;
    mapName: string;
    teamMode: TeamMode;
    players: number;
    maxPlayers: number;
    timeRunning: number;
    canJoin: boolean;
}

export interface PublicGamesResponse {
    games: PublicGameInfo[];
}

export interface ProxyDef {
    apiUrl?: string;
    google?: boolean;
    discord?: boolean;
    mock?: boolean;
    all?: boolean;
}
