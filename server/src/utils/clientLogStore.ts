import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Config } from "../config.ts";

export type ClientLogEntry = {
    ts: string;
    ip?: string;
    sessionId?: string;
    level?: string;
    loc?: string;
    message?: string;
    data?: unknown;
    userAgent?: string;
    href?: string;
    protocol?: number;
    clientGitVersion?: string;
};

function resolveClientLogDir(): string | undefined {
    const logging = Config.logging as { clientLogDir?: string; clientLogs?: boolean };
    if (logging.clientLogs === false) return undefined;
    const dir = logging.clientLogDir?.trim() || "logs/client";
    return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
}

function dayStamp(d = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

let ensureDirPromise: Promise<string | undefined> | null = null;

async function ensureLogDir(): Promise<string | undefined> {
    if (!ensureDirPromise) {
        ensureDirPromise = (async () => {
            const dir = resolveClientLogDir();
            if (!dir) return undefined;
            await mkdir(dir, { recursive: true });
            return dir;
        })().catch((err) => {
            ensureDirPromise = null;
            console.error("[clientLogStore] failed to create log dir", err);
            return undefined;
        });
    }
    return ensureDirPromise;
}

function sanitizeLine(value: unknown): string {
    try {
        return JSON.stringify(value).replace(/\r?\n/g, " ");
    } catch {
        return JSON.stringify({ ts: new Date().toISOString(), level: "error", message: "serialize_failed" });
    }
}

/** Append one or more client log records to today's JSONL file. */
export async function appendClientLogs(entries: ClientLogEntry[]): Promise<void> {
    if (!entries.length) return;
    const dir = await ensureLogDir();
    if (!dir) return;

    const file = path.join(dir, `${dayStamp()}.jsonl`);
    const body = `${entries.map((e) => sanitizeLine(e)).join("\n")}\n`;
    try {
        await appendFile(file, body, "utf8");
    } catch (err) {
        console.error("[clientLogStore] append failed", err);
    }
}

export async function appendClientLog(entry: ClientLogEntry): Promise<void> {
    await appendClientLogs([entry]);
}
