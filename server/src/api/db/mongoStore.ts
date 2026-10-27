import { randomUUID } from "node:crypto";
import { TeamMode } from "../../../../shared/gameConfig.ts";
import type { LeaderboardRequest, LeaderboardResponse, UserStatsResponse } from "../../../../shared/types/stats.ts";
import { resolveLeaderboardLimit } from "../../../../shared/types/stats.ts";
import { ALL_MAPS } from "../../../../shared/types/stats.ts";
import { leaderboardRunDetails } from "../../../../shared/utils/leaderboard.ts";
import type { Loadout } from "../../../../shared/utils/loadout.ts";
import { loadout as loadoutUtil } from "../../../../shared/utils/loadout.ts";
import { getMongoDb } from "./index.ts";
import type { MatchDataTable, UsersTableInsert, UsersTableSelect } from "./schema.pg.ts";

function col<T extends Document = Document>(name: string) {
    return getMongoDb().collection<T>(name);
}

type Document = Record<string, unknown>;

export const mongoStore = {
    async insertMatchData(rows: MatchDataTable[]) {
        if (!rows.length) return;
        const docs = rows.map((row) => ({
            ...row,
            createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(),
            killedIds: row.killedIds ?? [],
        }));
        try {
            await col("match_data").insertMany(docs as any, { ordered: false });
        } catch (err: any) {
            // Ignore duplicate key (already saved)
            if (err?.code !== 11000) throw err;
        }
    },

    async findUserBySlug(slug: string): Promise<UsersTableSelect | undefined> {
        return (await col<UsersTableSelect>("users").findOne({ slug })) ?? undefined;
    },

    async findUserById(id: string): Promise<UsersTableSelect | undefined> {
        return (await col<UsersTableSelect>("users").findOne({ id })) ?? undefined;
    },

    async findUserByAuthId(authId: string): Promise<UsersTableSelect | undefined> {
        return (await col<UsersTableSelect>("users").findOne({ authId })) ?? undefined;
    },

    async insertUser(user: UsersTableInsert) {
        const doc = {
            ...user,
            banned: user.banned ?? false,
            banReason: user.banReason ?? "",
            bannedBy: user.bannedBy ?? "",
            username: user.username ?? "",
            usernameSet: user.usernameSet ?? false,
            userCreated: user.userCreated ?? new Date(),
            linked: user.linked ?? false,
            linkedGoogle: user.linkedGoogle ?? false,
            linkedDiscord: user.linkedDiscord ?? false,
            loadout: user.loadout ?? loadoutUtil.validate({} as Loadout),
        };
        await col("users").insertOne(doc as any);
    },

    async updateUser(id: string, patch: Partial<UsersTableSelect>) {
        await col("users").updateOne({ id }, { $set: patch });
    },

    async deleteUser(id: string) {
        await col("users").deleteOne({ id });
        await col("session").deleteMany({ userId: id });
        await col("items").deleteMany({ userId: id });
        await col("user_pass").deleteMany({ userId: id });
        await col("user_quest").deleteMany({ userId: id });
    },

    async insertSession(session: { id: string; userId: string; expiresAt: Date }) {
        await col("session").insertOne(session);
    },

    async deleteSession(id: string) {
        await col("session").deleteOne({ id });
    },

    async deleteSessionsForUser(userId: string) {
        await col("session").deleteMany({ userId });
    },

    async deleteExpiredSessions() {
        await col("session").deleteMany({ expiresAt: { $lt: new Date() } });
    },

    async findSession(id: string) {
        return col("session").findOne({ id });
    },

    async insertItem(item: {
        userId: string;
        type: string;
        timeAcquired: number;
        source?: string;
        status?: number;
    }) {
        try {
            await col("items").insertOne({
                source: "unlock_new_account",
                status: 0,
                ...item,
            });
        } catch (err: any) {
            if (err?.code !== 11000) throw err;
        }
    },

    async findItem(userId: string, type: string) {
        return col("items").findOne({ userId, type });
    },

    async insertIpLogs(logs: Record<string, unknown>[]) {
        if (!logs.length) return;
        await col("ip_logs").insertMany(logs as any);
    },

    async findBannedIp(encodedIp: string) {
        return col("banned_ips").findOne({ encodedIp });
    },

    async wipeBannedIps() {
        await col("banned_ips").deleteMany({});
    },

    async leaderboard(params: LeaderboardRequest): Promise<LeaderboardResponse[]> {
        const { type, teamMode, mapId, interval } = params;
        const limit = resolveLeaderboardLimit(params.maxCount);
        const since = interval === "daily"
            ? new Date(Date.now() - 864e5)
            : interval === "weekly"
            ? new Date(Date.now() - 7 * 864e5)
            : null;

        const match: Record<string, unknown> = {
            teamMode,
            mapId,
            userBanned: { $ne: true },
        };
        if (since) match.createdAt = { $gte: since };

        if (type === "waves_survived") {
            match.wavesSurvived = { $gt: 0 };
            const useFireteam = teamMode === TeamMode.Duo || teamMode === TeamMode.Squad;
            const wavesPipeline: object[] = [
                { $match: match },
                {
                    $addFields: {
                        boardName: {
                            $cond: [
                                {
                                    $and: [
                                        useFireteam,
                                        { $ne: [{ $ifNull: ["$squadName", ""] }, ""] },
                                    ],
                                },
                                "$squadName",
                                "$username",
                            ],
                        },
                        difficultyRank: {
                            $switch: {
                                branches: [
                                    {
                                        case: { $eq: [{ $toLower: { $ifNull: ["$difficulty", ""] } }, "veteran"] },
                                        then: 4,
                                    },
                                    {
                                        case: { $eq: [{ $toLower: { $ifNull: ["$difficulty", ""] } }, "hardened"] },
                                        then: 3,
                                    },
                                    {
                                        case: { $eq: [{ $toLower: { $ifNull: ["$difficulty", ""] } }, "regular"] },
                                        then: 2,
                                    },
                                    {
                                        case: { $eq: [{ $toLower: { $ifNull: ["$difficulty", ""] } }, "recruit"] },
                                        then: 1,
                                    },
                                ],
                                default: 0,
                            },
                        },
                    },
                },
                { $sort: { wavesSurvived: -1, difficultyRank: -1, timeAlive: 1, createdAt: -1 } },
                {
                    $group: {
                        _id: {
                            name: "$boardName",
                            region: "$region",
                            isTeam: { $and: [useFireteam, { $ne: [{ $ifNull: ["$squadName", ""] }, ""] }] },
                        },
                        val: { $first: "$wavesSurvived" },
                        time: { $first: "$timeAlive" },
                        submittedAt: { $first: "$createdAt" },
                        version: { $first: "$gameVersion" },
                        difficulty: { $first: "$difficulty" },
                        difficultyRank: { $first: "$difficultyRank" },
                        gameId: { $first: "$gameId" },
                        teamId: { $first: "$teamId" },
                        playerId: { $first: "$playerId" },
                        squadName: { $first: "$squadName" },
                        kills: { $first: "$kills" },
                        downs: { $first: "$downs" },
                        revives: { $first: "$revives" },
                        games: { $addToSet: "$gameId" },
                    },
                },
                {
                    $project: {
                        _id: 0,
                        username: "$_id.name",
                        region: "$_id.region",
                        val: 1,
                        time: 1,
                        submittedAt: 1,
                        version: 1,
                        difficulty: 1,
                        difficultyRank: 1,
                        gameId: 1,
                        teamId: 1,
                        playerId: 1,
                        squadName: 1,
                        kills: 1,
                        downs: 1,
                        revives: 1,
                        games: { $size: "$games" },
                        slug: { $literal: null },
                    },
                },
                { $sort: { val: -1, difficultyRank: -1, time: 1 } },
                ...(limit == null ? [] : [{ $limit: limit }]),
            ];
            const rows = await col("match_data").aggregate(wavesPipeline).toArray();
            const out = [];
            for (const row of rows) {
                const squadName = String(row.squadName || "");
                const isTeam = useFireteam && !!squadName;
                const roster = isTeam
                    ? await col("match_data").find({
                        gameId: row.gameId,
                        region: row.region,
                        teamMode,
                        mapId,
                        userBanned: { $ne: true },
                        ...(isTeam ? { teamId: row.teamId } : { playerId: row.playerId }),
                    }, { projection: { username: 1, kills: 1, downs: 1, revives: 1 } })
                        .sort({ username: 1, playerId: 1 }).toArray()
                    : [row];
                const players = roster.map((p) => ({
                    username: String(p.username),
                    kills: p.kills == null ? null : Number(p.kills),
                    downs: p.downs == null ? null : Number(p.downs),
                    revives: p.revives == null ? null : Number(p.revives),
                }));
                out.push({
                    username: String(row.username),
                    slug: null,
                    region: String(row.region),
                    val: Number(row.val),
                    games: Number(row.games),
                    time: Number(row.time),
                    version: row.version ? String(row.version) : undefined,
                    difficulty: row.difficulty ? String(row.difficulty) : undefined,
                    submittedAt: row.submittedAt instanceof Date
                        ? row.submittedAt.toISOString()
                        : undefined,
                    ...leaderboardRunDetails(players, isTeam ? String(row.username) : undefined),
                });
            }
            return out;
        }

        // Generic per-user boards
        const valueExpr: Record<string, object> = {
            kills: { $sum: "$kills" },
            most_damage_dealt: { $max: "$damageDealt" },
            most_kills: { $max: "$kills" },
            wins: {
                $sum: { $cond: [{ $eq: ["$rank", 1] }, 1, 0] },
            },
            longest_survived: { $max: "$timeAlive" },
            kpg: {
                $round: [
                    { $divide: [{ $sum: "$kills" }, { $max: [{ $size: "$games" }, 1] }] },
                    1,
                ],
            },
        };

        match.userId = { $nin: ["", null] };
        const pipeline: object[] = [
            { $match: match },
            {
                $group: {
                    _id: { userId: "$userId", region: "$region" },
                    username: { $last: "$username" },
                    games: { $addToSet: "$gameId" },
                    val: valueExpr[type] ?? { $sum: "$kills" },
                    mapId: { $first: "$mapId" },
                    teamMode: { $first: "$teamMode" },
                },
            },
            {
                $project: {
                    userId: "$_id.userId",
                    region: "$_id.region",
                    username: 1,
                    mapId: 1,
                    teamMode: 1,
                    games: { $size: "$games" },
                    val: 1,
                },
            },
            { $sort: { val: -1 } },
            ...(limit == null ? [] : [{ $limit: limit }]),
        ];

        const rows = await col("match_data").aggregate(pipeline).toArray();
        const userIds = rows.map((r) => String(r.userId)).filter(Boolean);
        const users = userIds.length
            ? await col<UsersTableSelect>("users")
                .find({ id: { $in: userIds }, banned: false })
                .toArray()
            : [];
        const slugMap = Object.fromEntries(users.map((u) => [u.id, u.slug]));
        const nameMap = Object.fromEntries(users.map((u) => [u.id, u.username]));

        return rows
            .filter((r) => slugMap[String(r.userId)])
            .map((r) => ({
                username: nameMap[String(r.userId)] || String(r.username),
                slug: slugMap[String(r.userId)] || null,
                region: String(r.region),
                mapId: Number(r.mapId),
                teamMode: Number(r.teamMode) as TeamMode,
                games: Number(r.games),
                val: Number(r.val),
            }));
    },

    async userStats(
        userId: string,
        mapIdFilter: string,
        interval: string,
    ): Promise<UserStatsResponse> {
        const user = await this.findUserById(userId);
        if (!user) {
            return { slug: "", username: "", modes: [] } as unknown as UserStatsResponse;
        }

        const match: Record<string, unknown> = { userId };
        if (mapIdFilter !== ALL_MAPS) match.mapId = parseInt(mapIdFilter, 10);
        if (interval === "daily") {
            match.createdAt = { $gte: new Date(Date.now() - 864e5) };
        } else if (interval === "weekly") {
            match.createdAt = { $gte: new Date(Date.now() - 7 * 864e5) };
        }

        const modes = await col("match_data").aggregate([
            { $match: match },
            {
                $group: {
                    _id: "$teamMode",
                    games: { $sum: 1 },
                    wins: { $max: "$wavesSurvived" },
                    kills: { $sum: "$kills" },
                    mostKills: { $max: "$kills" },
                    mostDamage: { $max: "$damageDealt" },
                    avgDamage: { $avg: "$damageDealt" },
                    avgTimeAlive: { $avg: "$timeAlive" },
                    avgWaves: { $avg: "$wavesSurvived" },
                },
            },
        ]).toArray();

        const modeRows = modes.map((m) => {
            const games = Number(m.games) || 1;
            return {
                wins: Number(m.wins),
                kills: Number(m.kills),
                teamMode: Number(m._id),
                avgDamage: Math.round(Number(m.avgDamage) || 0),
                avgTimeAlive: Math.round(Number(m.avgTimeAlive) || 0),
                mostDamage: Number(m.mostDamage),
                kpg: Math.round((Number(m.kills) / games) * 10) / 10,
                winPct: Math.round((Number(m.avgWaves) || 0) * 10) / 10,
                mostKills: Number(m.mostKills),
                games: Number(m.games),
            };
        });

        const games = modeRows.reduce((a, m) => a + m.games, 0);
        const kills = modeRows.reduce((a, m) => a + m.kills, 0);

        return {
            slug: user.slug,
            username: user.username,
            banned: user.banned,
            player_icon: (user.loadout as Loadout)?.player_icon ?? "",
            games,
            wins: modeRows.reduce((a, m) => Math.max(a, m.wins), 0),
            kills,
            kpg: games ? Math.round((kills / games) * 10) / 10 : 0,
            modes: modeRows,
        } as unknown as UserStatsResponse;
    },
};

export function newMongoUserId() {
    return randomUUID();
}
