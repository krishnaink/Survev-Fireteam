import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../api/db/index.ts";
import { userQuestTable, usersTable } from "../api/db/schema.ts";
import { Config } from "../config.ts";
import { firstValidIp } from "../utils/requestIp.ts";
import type { FindGamePrivateBody } from "../utils/types.ts";

export function getHonoIp(c: Context, proxyHeader?: string): string | undefined {
    if (proxyHeader) {
        const fromHeader = firstValidIp(c.req.header(proxyHeader));
        if (fromHeader) return fromHeader;
        if (proxyHeader !== "X-Forwarded-For") {
            const fromXff = firstValidIp(c.req.header("X-Forwarded-For"));
            if (fromXff) return fromXff;
        }
    }

    const remote = c.env?.incoming?.socket?.remoteAddress as string | undefined;
    return firstValidIp(remote);
}

export async function verifyTurnsStile(token: string, ip: string): Promise<boolean> {
    const url = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    const result = await fetch(url, {
        body: JSON.stringify({
            secret: Config.secrets.TURNSTILE_SECRET_KEY,
            response: token,
            remoteip: ip,
        }),
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
    });

    const outcome = await result.json();

    if (!outcome.success) {
        return false;
    }
    return true;
}

export async function getFindGamePlayerData(
    players: Pick<
        FindGamePrivateBody["playerData"][number],
        "token" | "userId" | "ip" | "reclaimPlayerId"
    >[],
): Promise<FindGamePrivateBody["playerData"]> {
    const userIds = [
        ...new Set(players.map((p) => p.userId).filter((id) => id !== null)),
    ];

    let accountData: Record<
        string,
        {
            loadout: FindGamePrivateBody["playerData"][0]["loadout"];
            quests: FindGamePrivateBody["playerData"][0]["quests"];
        }
    > = {};

    if (userIds.length && Config.database.enabled) {
        const query = await db
            .select({
                userId: usersTable.id,
                loadout: usersTable.loadout,
                quests: sql<
                    string[]
                >`array_agg(${userQuestTable.questType}) filter (where ${userQuestTable.questType} is not null)`,
            })
            .from(usersTable)
            .leftJoin(userQuestTable, and(eq(userQuestTable.userId, usersTable.id)))
            .where(inArray(usersTable.id, userIds))
            .groupBy(usersTable.id);

        accountData = Object.fromEntries(query.map((r) => [r.userId, r]));
    }

    return players.map(({ token, userId, ip, reclaimPlayerId }) => ({
        token,
        userId,
        ip,
        reclaimPlayerId,
        loadout: userId ? accountData[userId]?.loadout : undefined,
        quests: userId ? (accountData[userId]?.quests ?? []) : [],
    }));
}
