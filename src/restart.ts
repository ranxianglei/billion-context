/**
 * Opt-in self-restart (#811): when a newer billion-context is already on disk
 * but this process still runs the old code (#806: the stale install could
 * serve indefinitely, visible only as a log-line reminder), re-exec the
 * process so the new version actually takes over.
 *
 * Gated by --auto-restart-on-update / ACP_AUTO_RESTART_ON_UPDATE /
 * "autoRestartOnUpdate" in the config file — default OFF, where behavior stays
 * exactly the #808 warn-once reminder.
 *
 * Safety gates, all applied before the listener is touched:
 *  - zero in-flight requests (session inFlight counters) at decision time AND
 *    through the drain window;
 *  - the on-disk install passes the same entry verification a fresh
 *    auto-update applies (verifyInstallLoadable), so a half-written install
 *    can never take over;
 *  - a cooldown marker since the last attempt at the point of no return, so a
 *    version flap can never loop-restart. A successful re-exec cannot
 *    re-trigger either way: the child runs the new version and is not stale.
 *
 * The replacement is spawned non-detached with inherited stdio/env: it joins
 * this process's group (a launcher's stopProxy() kills the whole group, so
 * the replacement stays collectable — #414) and inherits BILI_PARENT_PID /
 * BILI_LAUNCH_TOKEN (the launcher liveness watcher keeps working).
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import net from "node:net";
import path from "node:path";
import type http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cacheDir } from "./paths.js";
import { closeLogger, type Logger } from "./logger.js";
import { flushAllSessions, totalInFlight } from "./session.js";
import { flushConversations } from "./plugin.js";
import { findInstallDir, isVersionNewer, verifyInstallLoadable } from "./update.js";

const MARKER_FILE = path.join(cacheDir(), ".auto-restart");

/** Minimum gap between two attempts that reached the point of no return
 *  (after drain, right before spawn). After a successful re-exec the child
 *  is not stale at all, so this only bounds pathological loops (flapping
 *  versions, repeated spawn failures). Aborts BEFORE this point (sanity
 *  check, in-flight) do not write the marker and retry next cycle. */
export const RESTART_COOLDOWN_MS = 10 * 60 * 1000;

/** How long to wait for the listener to drain after stopping acceptance. */
const SETTLE_MS = 10_000;
/** How long to wait for the replacement to bind the port. */
const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 200;
/** Grace for the close callback after force-closing idle sockets down. */
const FORCE_CLOSE_GRACE_MS = 1_000;

export type AutoRestartInput = {
    enabled: boolean;
    runningVersion: string;
    diskVersion: string | undefined;
    inFlight: number;
    restarting: boolean;
    nowMs: number;
    lastRestartMs: number | undefined;
    cooldownMs: number;
};

export type AutoRestartDecision = { go: boolean; reason: string };

/** Pure gate for one self-restart attempt — exported for tests. Reasons, in
 *  evaluation order: disabled | restart-in-progress | not-stale |
 *  in-flight:<n> | cooldown | ok. */
export function decideAutoRestart(input: AutoRestartInput): AutoRestartDecision {
    if (!input.enabled) return { go: false, reason: "disabled" };
    if (input.restarting) return { go: false, reason: "restart-in-progress" };
    if (!input.diskVersion || !isVersionNewer(input.diskVersion, input.runningVersion)) {
        return { go: false, reason: "not-stale" };
    }
    if (input.inFlight > 0) return { go: false, reason: `in-flight:${input.inFlight}` };
    if (input.lastRestartMs !== undefined && input.nowMs - input.lastRestartMs < input.cooldownMs) {
        return { go: false, reason: "cooldown" };
    }
    return { go: true, reason: "ok" };
}

export async function readLastRestart(): Promise<number | undefined> {
    try {
        const data = JSON.parse(await readFile(MARKER_FILE, "utf-8")) as { ts?: unknown };
        return typeof data.ts === "number" && Number.isFinite(data.ts) ? data.ts : undefined;
    } catch {
        return undefined;
    }
}

async function writeLastRestart(ts: number, from: string, to: string): Promise<void> {
    try {
        await mkdir(path.dirname(MARKER_FILE), { recursive: true });
        await writeFile(MARKER_FILE, JSON.stringify({ ts, from, to }), "utf-8");
    } catch {
        // best-effort: a lost marker only means the cooldown is skipped once
    }
}

/** Map a bind address to the address a local readiness probe should dial
 *  (wildcards → their loopback counterpart). Exported for tests. */
export function probeHostFor(bindHost: string): string {
    if (bindHost === "0.0.0.0") return "127.0.0.1";
    if (bindHost === "::") return "::1";
    return bindHost;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeReady(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}

export type SelfRestartDeps = {
    server: http.Server;
    host: string;
    port: number;
    /** Install directory holding the newer version. */
    installDir: string;
    runningVersion: string;
    diskVersion: string;
    log: Logger;
    /** In-flight request counter (defaults to the session store). Injectable
     *  for tests. */
    inFlightProvider?: () => number;
    /** Process-exit seam (defaults to flush + exit(0)). Injectable so tests
     *  never kill the test runner. */
    finish?: () => void;
    /** Spawn seam (defaults to child_process.spawn). Injectable so tests can
     *  substitute a stub replacement instead of re-exec'ing the test runner. */
    spawnImpl?: (execPath: string, args: string[], options: SpawnOptions) => ChildProcess;
    /** Drain-window override in ms (tests). Defaults to SETTLE_MS. */
    settleMs?: number;
    /** Readiness-window override in ms (tests). Defaults to READY_TIMEOUT_MS. */
    readyTimeoutMs?: number;
};

export type SelfRestartResult = { ok: boolean; error?: string; childPid?: number };

/**
 * Hand the port over to a freshly spawned copy of this process running the
 * on-disk version. Every abort path resumes the original listener, so a
 * failed handover degrades to the pre-existing warn-once behavior instead of
 * killing service. Never throws.
 */
export async function performSelfRestart(deps: SelfRestartDeps): Promise<SelfRestartResult> {
    const { server, host, port, log } = deps;
    const countInFlight = deps.inFlightProvider ?? totalInFlight;
    const settleMs = deps.settleMs ?? SETTLE_MS;
    const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;

    log("info", `[restart] self-restart v${deps.runningVersion} -> v${deps.diskVersion}: verifying the on-disk install first`);
    const bad = await verifyInstallLoadable(deps.installDir);
    if (bad) {
        log("warn", `[restart] aborted: ${bad} — keeping the current process; restart bili manually`);
        return { ok: false, error: bad };
    }

    // Stop accepting NEW connections; existing ones keep draining. Requests
    // arriving now get connection-refused and retry — clients reconnect once
    // the replacement binds the same port (#806 verified this recovers).
    let closed = false;
    server.close(() => { closed = true; });
    log("info", `[restart] stopped accepting new connections; waiting for in-flight requests to drain (up to ${settleMs / 1000}s)`);

    const settleDeadline = Date.now() + settleMs;
    let settled = false;
    while (Date.now() < settleDeadline) {
        if (countInFlight() === 0) {
            if (closed) { settled = true; break; }
            // Zero in-flight but sockets linger (idle keep-alives carry no
            // data worth preserving) — force them down rather than waiting
            // out the whole window.
            server.closeAllConnections?.();
            const graceEnd = Date.now() + FORCE_CLOSE_GRACE_MS;
            while (!closed && Date.now() < graceEnd) await sleep(POLL_MS);
            if (closed) { settled = true; break; }
            log("warn", "[restart] aborted: connections stuck after forced close — resuming service");
            resumeListening(server, host, port, log);
            return { ok: false, error: "connections-stuck" };
        }
        await sleep(POLL_MS);
    }
    if (!settled) {
        log("warn", `[restart] aborted: ${countInFlight()} request(s) still in flight after ${settleMs / 1000}s — resuming service`);
        resumeListening(server, host, port, log);
        return { ok: false, error: "in-flight-remained" };
    }

    // Point of no return: past sanity check and drain. The marker throttles
    // any future attempt for RESTART_COOLDOWN_MS even if the spawn below
    // fails and we resume (a flapping install must not loop-restart).
    await writeLastRestart(Date.now(), deps.runningVersion, deps.diskVersion);

    const entry = process.argv[1];
    if (!entry) {
        log("error", "[restart] aborted: cannot determine the entry script (process.argv[1]) — resuming service");
        resumeListening(server, host, port, log);
        return { ok: false, error: "no-entry" };
    }

    log("info", `[restart] spawning replacement v${deps.diskVersion} on port ${port}...`);
    let child: ChildProcess;
    try {
        // Non-detached: the replacement joins THIS process's group, so a
        // launcher's group kill (stopProxy -> kill(-pid)) reaches it (#414).
        // stdio inherit: launcher children log to a file fd, manual starts to
        // the terminal — the replacement logs wherever the parent does.
        child = (deps.spawnImpl ?? spawn)(process.execPath, [entry, ...process.argv.slice(2)], {
            stdio: "inherit",
            env: process.env,
        });
    } catch (e) {
        log("error", `[restart] spawn failed: ${String(e)} — resuming service`);
        resumeListening(server, host, port, log);
        return { ok: false, error: String(e) };
    }
    child.unref?.();

    let exitReason: string | undefined;
    child.once("exit", (code, signal) => {
        exitReason = code !== null ? `exited code ${code}` : signal ? `killed by ${signal}` : "exited";
    });
    child.once("error", (err) => { exitReason = String(err); });

    const readyDeadline = Date.now() + readyTimeoutMs;
    let ready = false;
    while (Date.now() < readyDeadline) {
        if (exitReason !== undefined) break;
        if (await probeReady(probeHostFor(host), port)) { ready = true; break; }
        await sleep(POLL_MS);
    }
    if (!ready) {
        try { child.kill(); } catch { /* already gone */ }
        log("warn", `[restart] aborted: replacement did not become ready within ${readyTimeoutMs / 1000}s${exitReason ? ` (${exitReason})` : ""} — resuming service`);
        resumeListening(server, host, port, log);
        return { ok: false, error: exitReason ?? "replacement-not-ready" };
    }

    log("info", `[restart] replacement is up (pid ${child.pid ?? "?"}) — handing over v${deps.runningVersion} -> v${deps.diskVersion}, exiting`);
    (deps.finish ?? defaultFinish)();
    return { ok: true, childPid: child.pid };
}

function resumeListening(server: http.Server, host: string, port: number, log: Logger): void {
    try {
        server.listen(port, host);
    } catch (e) {
        log("error", `[restart] failed to resume listening on ${host}:${port}: ${String(e)}`);
    }
}

function defaultFinish(): void {
    flushConversations();
    void flushAllSessions().finally(() => {
        closeLogger();
        process.exit(0);
    });
}

export type StaleInstallInfo = { diskVersion: string; runningVersion: string };

export type AutoRestartHandlerConfig = {
    enabled: boolean;
    packageName: string;
    server: http.Server;
    host: string;
    portProvider: () => number;
    log: Logger;
};

/** Build the stale-install hook passed as UpdateOptions.onStaleInstall
 *  (#811). Returns a fire-and-forget callback: each notification runs the
 *  pure gate, and only a green decision touches the listener. Deferrals are
 *  logged once per distinct reason (the notification repeats every check
 *  interval while the state persists). */
export function createAutoRestartHandler(cfg: AutoRestartHandlerConfig): (info: StaleInstallInfo) => void {
    let restarting = false;
    let lastDeferredReason: string | undefined;
    return (info) => {
        void (async () => {
            const decision = decideAutoRestart({
                enabled: cfg.enabled,
                runningVersion: info.runningVersion,
                diskVersion: info.diskVersion,
                inFlight: totalInFlight(),
                restarting,
                nowMs: Date.now(),
                lastRestartMs: await readLastRestart(),
                cooldownMs: RESTART_COOLDOWN_MS,
            });
            if (!decision.go) {
                if (cfg.enabled && decision.reason !== "disabled" && decision.reason !== "not-stale" && decision.reason !== lastDeferredReason) {
                    cfg.log("info", `[restart] deferred (${decision.reason}); will retry on the next update check`);
                    lastDeferredReason = decision.reason;
                }
                return;
            }
            restarting = true;
            try {
                const installDir = await findInstallDir(cfg.packageName);
                if (!installDir) {
                    cfg.log("warn", "[restart] deferred: cannot locate the install directory");
                    restarting = false;
                    return;
                }
                const result = await performSelfRestart({
                    server: cfg.server,
                    host: cfg.host,
                    port: cfg.portProvider(),
                    installDir,
                    runningVersion: info.runningVersion,
                    diskVersion: info.diskVersion,
                    log: cfg.log,
                });
                if (!result.ok) restarting = false;
            } catch (e) {
                restarting = false;
                cfg.log("warn", `[restart] unexpected failure: ${String(e)} — keeping the current process`);
            }
        })();
    };
}
