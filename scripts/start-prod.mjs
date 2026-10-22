import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configRunsApi, configRunsFrontend, configRunsGame, getConfig } from "../config.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, NODE_ENV: "production" };
const Config = getConfig(true, root);

const needsFrontend = configRunsFrontend(Config);
if (needsFrontend && !existsSync(path.join(root, "client/dist/index.html"))) {
    console.error("client/dist is missing. Run once: bun run build");
    process.exit(1);
}

/**
 * Spawn each service directly (no concurrently / no cmd.exe shell).
 * Windows was splitting "bun run start:game" so `start` became the CMD builtin
 * and failed with "cannot find ':game'".
 *
 * @type {Array<{ name: string, args: string[] }>}
 */
const procs = [];
if (configRunsApi(Config)) {
    procs.push({ name: "api", args: ["run", "--cwd", "server", "start:api"] });
}
if (configRunsGame(Config)) {
    procs.push({ name: "game", args: ["run", "--cwd", "server", "start:game"] });
}
if (needsFrontend) {
    procs.push({ name: "web", args: ["scripts/prod-web.ts"] });
}

if (!procs.length) {
    console.error(
        "Nothing to start — set api.enabled / game.enabled / client.enabled "
            + "(at least one true).",
    );
    process.exit(1);
}

const bun = process.platform === "win32" ? "bun.exe" : "bun";
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let shuttingDown = false;
let exitCode = 0;

function stopAll(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
        if (!child.killed) {
            try {
                child.kill(signal);
            } catch {
                // ignore
            }
        }
    }
}

for (const proc of procs) {
    const child = spawn(bun, proc.args, {
        cwd: root,
        env,
        stdio: "inherit",
        // Never use shell:true — breaks "start:game" on Windows.
        shell: false,
        windowsHide: true,
    });
    children.push(child);

    child.on("exit", (code, signal) => {
        if (shuttingDown) return;
        if (signal) {
            exitCode = 1;
        } else if (typeof code === "number" && code !== 0) {
            exitCode = code;
        }
        console.error(
            `[${proc.name}] exited`
                + (signal ? ` (signal ${signal})` : ` with code ${code ?? 0}`),
        );
        stopAll("SIGTERM");
        // Give siblings a moment, then exit.
        setTimeout(() => process.exit(exitCode || 1), 200).unref?.();
    });

    child.on("error", (err) => {
        console.error(`[${proc.name}] failed to start:`, err);
        exitCode = 1;
        stopAll("SIGTERM");
        process.exit(1);
    });
}

console.log(`Starting: ${procs.map((p) => p.name).join(", ")}`);

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        stopAll(sig);
        setTimeout(() => process.exit(0), 300).unref?.();
    });
}
