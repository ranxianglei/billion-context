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
 *  - the host's leftover-socket hook (#2895): CONNECT tunnels / claimed
 *    upgrades leave HTTP-parser tracking yet still count against the
 *    net.Server connection count, so closeAllConnections() alone could never
 *    fire the close callback under HTTPS_PROXY/MITM setups — the force-close
 *    step destroys whatever the host ledger still holds (idle at that point);
 *  - the on-disk install passes the same entry verification a fresh
 *    auto-update applies (verifyInstallLoadable), so a half-written install
 *    can never take over;
 *  - a cooldown marker since the last attempt at the point of no return, so a
 *    version flap can never loop-restart. A successful re-exec cannot
 *    re-trigger either way: the child runs the new version and is not stale.
 *
 * The replacement always inherits env (BILI_PARENT_PID / BILI_LAUNCH_TOKEN, so
 * the launcher liveness watcher keeps working). Spawn options are split by
 * platform (#2095): on win32 the child is spawned DETACHED + windowsHide with
 * ignored stdio — a NON-detached child of a console-attached parent rides
 * libuv's kill-on-job-close job object and is terminated the instant the parent
 * exits mid-boot, taking bili offline after every auto-update until something
 * else starts it; detaching removes both the console attachment and the job
 * object so the replacement outlives the parent, and ignoring stdio loses
 * nothing because the durable log file (logger.ts) is independent of stderr.
 * On POSIX the child stays NON-detached with inherited stdio: it joins this
 * process's group so a launcher's stopProxy() group kill still reaches it
 * (#414) and logs wherever the parent does. The #414 group-kill rationale is
 * moot on win32 — stopProxy() relies on the BILI_PARENT_PID watchdog there,
 * never a group kill — so detaching costs nothing there.
 *
 * #3044 handover contract: the replacement is marked BILI_UPGRADE_REPLACEMENT
 * so it binds-or-dies on exactly the port freed here (no +1 ladder — hopping
 * stranded replacements serving no client while the prior instance kept the
 * real port). The parent verifies the child through its OWN registry record
 * (pid + actual bound port) rather than trusting a raw TCP answer on the port
 * (a racing host respawn could masquerade as the child), terminates any
 * misplaced or still-starting child and VERIFIES the kill, and exits instead
 * of resuming when another live bili instance has taken over the port
 * (resuming would ladder-drift this old-code copy onto a fresh port — the
 * zombie half of the leak).
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
import { flushPrefixAffinity } from "./affinity-persist.js";
import { flushOrderSkeletons } from "./order-persist.js";
import { findInstallDir, isVersionNewer, verifyInstallLoadable } from "./update.js";
import { isPidAlive, listInstances } from "./instance.js";
import { UPGRADE_REPLACEMENT_ENV } from "./listen-policy.js";

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
/** #3044: how long to wait for a killed replacement to actually die before
 *  escalating to a loud manual-cleanup error — an unverified kill is how the
 *  orphan processes of that report survived their parent's timeout. */
const KILL_VERIFY_MS = 2_000;

type AutoRestartInput = {
    enabled: boolean;
    runningVersion: string;
    diskVersion: string | undefined;
    inFlight: number;
    restarting: boolean;
    nowMs: number;
    lastRestartMs: number | undefined;
    cooldownMs: number;
};

type AutoRestartDecision = { go: boolean; reason: string };

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

/** #2095: spawn options for the self-restart replacement, split by platform.
 *  win32: a NON-detached child of a console-attached parent rides libuv's
 *  kill-on-job-close job object and dies the moment the parent exits mid-boot —
 *  bili goes offline after every auto-update until something else starts it.
 *  Detaching (DETACHED_PROCESS) removes both the console attachment and the job
 *  object so the replacement outlives the parent; stdio is ignored because the
 *  durable log file (logger.ts) is independent of stderr, mirroring the
 *  launcher's own proxy spawn (detached + windowsHide + redirected stdio). The
 *  #414 group-kill rationale does not apply here: on win32 stopProxy() relies on
 *  the BILI_PARENT_PID watchdog, never a group kill.
 *  posix: unchanged — non-detached + inherited stdio keeps the replacement in
 *  this process's group so a launcher's stopProxy() group kill reaches it
 *  (#414) and it logs wherever the parent does. Exported pure so tests can pin
 *  both branches without faking the OS. */
export function selfRestartSpawnOptions(platform: NodeJS.Platform): SpawnOptions {
    if (platform === "win32") {
        return { detached: true, windowsHide: true, stdio: "ignore", env: process.env };
    }
    return { stdio: "inherit", env: process.env };
}

type SelfRestartDeps = {
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
    /** Durable-state flush run after the drain and before the replacement is
     *  spawned, so the child hydrates the freshest snapshot instead of a stale
     *  one (#1724). Defaults to conversations + sessions + prefix-affinity.
     *  Injectable for tests. */
    preSpawnFlush?: () => Promise<void> | void;
    /** Platform seam (defaults to process.platform). Injectable so tests can
     *  pin the win32 vs posix spawn options without faking the OS (#2095). */
    platform?: NodeJS.Platform;
    /** #2895: destroy the sockets that survive closeAllConnections() — CONNECT
     *  tunnels (MITM + blind) and claimed upgrades leave HTTP-parser tracking
     *  when they're taken over, yet still count against the net.Server
     *  connection count, so the close callback never fired and every handover
     *  aborted as "connections-stuck" under HTTPS_PROXY/MITM setups. Wired by
     *  startServer() (restartForceCloseOf); returns how many were destroyed.
     *  Absent for plain servers (tests) — force-close stays as before. */
    destroyLingeringSockets?: () => number;
    /** Kill-verification window in ms after terminating a failed replacement
     *  (#3044). Injectable for tests; defaults to KILL_VERIFY_MS. */
    killVerifyMs?: number;
};

type SelfRestartResult = { ok: boolean; error?: string; childPid?: number };

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
            // #2895: closeAllConnections() cannot reach CONNECT tunnels /
            // claimed upgrades (off HTTP-parser tracking, still counted), so
            // destroy whatever the host ledger still holds. In-flight is zero
            // here, so only idle tunnels/upgrades remain; their clients
            // reconnect once the replacement binds the port (#806).
            const lingering = deps.destroyLingeringSockets?.();
            if (lingering !== undefined && lingering > 0) {
                log("info", `[restart] force-closed ${lingering} lingering socket(s) outside HTTP tracking (tunnels/upgrades)`);
            }
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

    // #1724: persist durable state BEFORE spawning the replacement. The child
    // hydrates the shared store as soon as it boots, so the old order (spawn,
    // wait for readiness, then flush in finish) made it read a stale snapshot
    // while our final flush went unread — the lost-update / prefix-cache-busting
    // race. State is frozen here (listener closed, in-flight 0), so one flush
    // captures everything, and the port is already released so this adds no
    // handover delay.
    try {
        await (deps.preSpawnFlush ?? defaultPreSpawnFlush)();
    } catch (e) {
        log("warn", `[restart] pre-spawn state flush failed (${e instanceof Error ? e.message : String(e)}) — continuing; the replacement may hydrate a slightly stale snapshot`);
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
        // Platform-split (#2095): win32 detaches so the replacement outlives our
        // exit (a non-detached child rides libuv's kill-on-job-close job object);
        // posix stays non-detached so the launcher's stopProxy() group kill still
        // reaches it (#414). Full rationale in selfRestartSpawnOptions.
        const baseOptions = selfRestartSpawnOptions(deps.platform ?? process.platform);
        child = (deps.spawnImpl ?? spawn)(
            process.execPath,
            [entry, ...process.argv.slice(2)],
            {
                ...baseOptions,
                // #3044: mark the replacement so it binds-or-dies on exactly this
                // port instead of inheriting the launcher's +1 ladder rights.
                env: { ...(baseOptions.env as NodeJS.ProcessEnv), [UPGRADE_REPLACEMENT_ENV]: "1" },
            },
        );
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

    // Readiness signal ladder (#3044). The authoritative proof that the
    // handover landed is the replacement's OWN registry record (its pid plus
    // the port it ACTUALLY bound, written on announceListening). A raw TCP
    // answer on our port can come from a racing peer (a host respawn during
    // our drain window) — trusting it made us exit believing the upgrade had
    // landed while the real replacement idled on a drifted port serving no
    // client. The TCP probe remains as fallback only (pre-registry children,
    // and children that have not announced yet).
    type HandoverOutcome =
        | { kind: "ready" }
        | { kind: "misplaced"; boundPort: number }
        | { kind: "superseded"; peerPid: number }
        | { kind: "not-ready"; exitReason?: string };
    const childPid = child.pid;
    const readyDeadline = Date.now() + readyTimeoutMs;
    let outcome: HandoverOutcome = { kind: "not-ready", exitReason };
    while (Date.now() < readyDeadline) {
        if (exitReason !== undefined) { outcome = { kind: "not-ready", exitReason }; break; }
        const ownRecord = childPid !== undefined ? listInstances().find((e) => e.pid === childPid) : undefined;
        if (ownRecord !== undefined) {
            outcome = ownRecord.port === port
                ? { kind: "ready" }
                : { kind: "misplaced", boundPort: ownRecord.port };
            break;
        }
        if (await probeReady(probeHostFor(host), port)) {
            // Our OWN registry record (written at our announceListening) still
            // claims this port while we drain — without excluding process.pid a
            // healthy not-yet-announced replacement reads as "superseded by us"
            // and gets killed (pinned by the #2895 tunnel handover test).
            const foreignPeer = listInstances().find((e) => e.port === port && e.pid !== childPid && e.pid !== process.pid && isPidAlive(e.pid));
            if (foreignPeer !== undefined) {
                outcome = { kind: "superseded", peerPid: foreignPeer.pid };
            } else {
                outcome = { kind: "ready" };
            }
            break;
        }
        await sleep(POLL_MS);
    }
    if (outcome.kind === "ready") {
        log("info", `[restart] replacement is up (pid ${childPid ?? "?"}) — handing over v${deps.runningVersion} -> v${deps.diskVersion}, exiting`);
        (deps.finish ?? defaultFinish)();
        return { ok: true, childPid };
    }
    if (outcome.kind === "misplaced") {
        log("error", `[restart] replacement bound port ${outcome.boundPort} instead of ${port} — terminating it; a drifted replacement serves no client while the prior instance keeps the real port (#3044)`);
    } else if (outcome.kind === "superseded") {
        log("warn", `[restart] port ${port} is already served by another bili instance (pid ${outcome.peerPid}) — treating the upgrade as landed there; terminating our still-starting replacement`);
    } else {
        log("warn", `[restart] aborted: replacement did not become ready within ${readyTimeoutMs / 1000}s${outcome.exitReason ? ` (${outcome.exitReason})` : ""}`);
    }
    await killAndVerify(child, childPid, deps.killVerifyMs ?? KILL_VERIFY_MS, log);
    // Terminal decision (#3044): if another LIVE bili instance now owns our
    // port, resuming THIS old-code copy would ladder-drift it onto a fresh
    // port nobody routes to — the zombie half of the reported leak. The
    // upgrade effectively landed elsewhere; exit cleanly instead. A foreign
    // non-bili squatter keeps today's resume behavior.
    const biliPeer = listInstances().find((e) => e.port === port && e.pid !== process.pid && isPidAlive(e.pid));
    if (biliPeer !== undefined) {
        log("warn", `[restart] port ${port} is served by bili instance pid ${biliPeer.pid} — exiting instead of resuming (a resumed old-code copy would drift to a new port and leak, #3044)`);
        (deps.finish ?? defaultFinish)();
        return { ok: true, childPid };
    }
    log("warn", "[restart] resuming service");
    resumeListening(server, host, port, log);
    return {
        ok: false,
        error: outcome.kind === "misplaced"
            ? `replacement-misplaced:${outcome.boundPort}`
            : outcome.kind === "superseded"
              ? "superseded-by-peer"
              : (outcome.exitReason ?? "replacement-not-ready"),
    };
}

/** Wait up to `ms` for `pid` to die; true once it's gone (final recheck
 *  after the loop so a death landing exactly at the deadline isn't missed). */
async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) return true;
        await sleep(POLL_MS);
    }
    return !isPidAlive(pid);
}

/** Terminate a failed replacement and verify it actually died (#3044): a
 *  kill that silently no-ops leaves exactly the orphan processes that report
 *  describes — idle, holding a port nobody routes to, accumulating memory.
 *  #3344: escalate SIGTERM → SIGKILL before asking a human — a replacement
 *  stuck in a SIGTERM-resistant state (blocked syscall / TERM ignored) is
 *  still force-killable; manual cleanup stays only the last resort. */
async function killAndVerify(child: ChildProcess, pid: number | undefined, verifyMs: number, log: Logger): Promise<void> {
    try { child.kill(); } catch { /* already gone */ }
    if (pid === undefined) return;
    if (await waitUntilGone(pid, verifyMs)) return;
    // SIGTERM didn't take within the window — escalate before reporting.
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    if (await waitUntilGone(pid, verifyMs)) return;
    log("error", `[restart] replacement pid ${pid} is still alive after SIGTERM+SIGKILL — manual cleanup required (kill -9 ${pid}); until it dies it keeps leaking CPU/memory on a port nobody routes to (#3044)`);
}

function resumeListening(server: http.Server, host: string, port: number, log: Logger): void {
    try {
        server.listen(port, host);
    } catch (e) {
        log("error", `[restart] failed to resume listening on ${host}:${port}: ${String(e)}`);
    }
}

/** #1724: durable-state set captured before the replacement boots — mirrors
 *  what the normal shutdown path persists (conversations + sessions +
 *  prefix-affinity + session-order skeletons #3397). */
async function defaultPreSpawnFlush(): Promise<void> {
    flushConversations();
    await flushAllSessions();
    flushPrefixAffinity();
    flushOrderSkeletons();
}

function defaultFinish(): void {
    flushConversations();
    flushPrefixAffinity();
    flushOrderSkeletons();
    void flushAllSessions().finally(() => {
        closeLogger();
        process.exit(0);
    });
}

type StaleInstallInfo = { diskVersion: string; runningVersion: string };

type AutoRestartHandlerConfig = {
    enabled: boolean;
    packageName: string;
    server: http.Server;
    host: string;
    portProvider: () => number;
    log: Logger;
    /** #2895: passthrough to performSelfRestart (see SelfRestartDeps). */
    destroyLingeringSockets?: () => number;
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
                    destroyLingeringSockets: cfg.destroyLingeringSockets,
                });
                if (!result.ok) restarting = false;
            } catch (e) {
                restarting = false;
                cfg.log("warn", `[restart] unexpected failure: ${String(e)} — keeping the current process`);
            }
        })();
    };
}
