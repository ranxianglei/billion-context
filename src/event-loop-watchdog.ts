/**
 * #4762: event-loop watchdog for STANDALONE proxy processes (`bili start` and
 * everything else that goes through startServer — lane-spawned children, the
 * claude-native session proxy, …).
 *
 * Failure being guarded: a synchronous computation (observed once: a
 * ~357K-token fold-reconcile re-anchor region on a 48 MiB session) wedges the
 * single-threaded event loop while the process still HOLDS its listen socket.
 * HTTP stops answering, but the open socket makes every spawner respawn die
 * with EADDRINUSE — the zombie squats the port until someone kills it by hand
 * (the #4762 incident: 7 respawn failures over 10 minutes on Windows).
 *
 * Mechanism: a worker thread has its OWN event loop, so it keeps running while
 * the main thread spins. The main thread posts a heartbeat every 5 s; the
 * worker measures the gap and, after SOFT_WARN_MS of continuous silence, logs
 * a warning; after HARD_TIMEOUT_MS it writes a forensic line and exits the
 * WHOLE process (code 1) so the spawner respawns onto the freed port. Legit
 * work never blocks the loop for five straight minutes — compression runs in
 * sync slices that complete in seconds to minutes and yield between requests —
 * so the hard threshold is deadlock detection, not load detection.
 *
 * Second axis (#5449): the same worker probes the SPAWNER'S owner pid off-loop
 * (`process.kill(pid, 0)` — EPERM counts as alive, #3890 discipline). When the
 * owner has failed its probe N ticks running, the main loop has been silent ≥
 * SOFT_WARN_MS (a still-yielding loop reaches its OWN graceful shutdown path
 * first — this axis only acts where the in-loop reaper cannot), and no other
 * owner is attached (#7 shared-proxy semantics: die when the LAST owner
 * exits), the worker exits the process so the spawner respawns onto the freed
 * port. This closes the orphan window the in-loop watcher cannot close: under
 * sparse event-loop yields the in-loop reaper's detect→decide chain takes
 * minutes, while the incident orphan held its port and DB write lock for 33.
 * A reused pid reads alive, so the probe can miss a reap but never false-trips.
 *
 * Scope discipline: plugin-injection mode (dist/agent/*) never calls
 * startServer, so a wedged HOST process is never at risk of being killed by
 * this guardrail. Thresholds are deliberately hardcoded — a new config/env
 * surface for an internal safety timer is not worth the owner-gated cost.
 *
 * Degradation: if the worker cannot be spawned (restricted environments), the
 * proxy continues UNWATCHED with a single warning — availability over
 * guardrail, same posture as every other best-effort facility here.
 *
 * Forensic-line routing: the worker appends to bili.log when a file leg is
 * configured; its STDERR leg ships only when stderr is a TTY (a human terminal
 * drains by design) or when there is no file leg at all (stderr is then the
 * sole record). Rationale: Node writes to a PIPE are blocking, and a full,
 * undrained pipe never emits an error event (#5012 class) — a worker that
 * wrote its FATAL line into exactly that dead pipe would wedge ITSELF instead
 * of tripping the exit. try/catch cannot rescue a synchronous blocking write,
 * so the condition has to be structural, not defensive.
 *
 * CI rerun trigger (2026-11-07, no behavior change): the only red on this
 * branch was the documented msgid-lane-flow settle-race load flake (#4599
 * floor-903 family) — a single stale read right after the #5155 ack/flush
 * decoupling under CI load; not caused by this diff. This note re-triggers
 * the matrix.
 */
import { Worker, type WorkerOptions } from "node:worker_threads";

export const WATCHDOG_HEARTBEAT_MS = 5_000;
const WATCHDOG_CHECK_INTERVAL_MS = 5_000;
export const WATCHDOG_SOFT_WARN_MS = 30_000;
export const WATCHDOG_HARD_TIMEOUT_MS = 5 * 60_000;
/** Consecutive failed kill-0 probes of the owner before the off-loop axis may
 *  act (#5449). Mirrors the in-loop watcher's confirm-tick posture (#3890):
 *  Windows probe errors are transient, one bad read must not kill the proxy. */
export const WATCHDOG_OWNER_DEAD_CONFIRM_TICKS = 3;

type WatchdogVerdict = "ok" | "warn" | "trip";
type WatchdogTripReason = "loop-wedge" | "parent-gone";

/** Pure gap→verdict mapping — the worker's tick logic, unit-testable without
 *  spawning anything. `warned` prevents re-warning on every tick. */
export function watchdogVerdict(gapMs: number, warned: boolean, softWarnMs: number, hardTimeoutMs: number): WatchdogVerdict {
    if (gapMs >= hardTimeoutMs) return "trip";
    if (gapMs >= softWarnMs && !warned) return "warn";
    return "ok";
}

/** Pure predicate for the off-loop owner-reap axis (#5449): true only when ALL
 *  three hold — the owner failed its kill-0 probe `confirmTicks` times running,
 *  the main loop has been silent ≥ softWarnMs (a still-yielding loop reaches
 *  its own graceful shutdown first, so this axis never preempts it), and no
 *  other owner is attached (#7: die when the LAST owner exits). */
export function ownerReapVerdict(deadStreak: number, confirmTicks: number, gapMs: number, softWarnMs: number, watcherCount: number): boolean {
    return deadStreak >= confirmTicks && gapMs >= softWarnMs && watcherCount <= 0;
}

/** The production count of OTHER attached owners for the off-loop reap guard
 *  (#5449/#7): the in-loop watcher set minus the probed parentPid, whose
 *  removal from the set depends on the in-loop reaper this axis backstops —
 *  without the exclusion the guard freezes at ≥1 and the off-loop reap
 *  degenerates back into the starved in-loop path (the incident shape).
 *  undefined = pre-context window, where no socket exists yet so no attach
 *  could have landed: 0 is truth there, not a fallback. */
export function otherOwnerCount(watchers: ReadonlySet<number> | undefined, probedPid: number | null): number {
    if (!watchers) return 0;
    let n = watchers.size;
    if (probedPid !== null && watchers.has(probedPid)) n -= 1;
    return n;
}

interface EventLoopWatchdogHandle {
    /** Stop heartbeating and terminate the worker. Idempotent. */
    stop(): void;
}

interface ArmEventLoopWatchdogOptions {
    /** File the worker appends forensic lines to (the configured bili.log).
     *  undefined/null = stderr only. */
    logFile?: string | null;
    version?: string;
    heartbeatMs?: number;
    softWarnMs?: number;
    hardTimeoutMs?: number;
    checkIntervalMs?: number;
    /** "exit" (production): the worker calls process.exit itself — required,
     *  because a wedged main thread can never receive a message asking it to
     *  die. "report": the worker posts {type:"trip"} and stays alive — test
     *  seam so the suite process is not killed. */
    fatalMode?: "exit" | "report";
    /** Test seam: swap the Worker constructor. */
    spawnWorker?: (code: string, opts: WorkerOptions) => Worker;
    /** Owner pid to probe off-loop (#5449): BILI_PARENT_PID on spawned proxies.
     *  undefined/0 = axis disabled (manual `bili start`) — zero behavior change. */
    parentPid?: number | null;
    /** Number of OTHER attached owners — excluding the probed parentPid, whose
     *  removal from the in-loop set depends on the reaper this axis backstops
     *  (#5449) — sampled per beat so a wedged loop freezes the last known value
     *  (#7: reap only when the LAST owner is gone). */
    getWatcherCount?: () => number;
    /** Called when the worker trips (report mode). */
    onTrip?: (gapMs: number, reason?: WatchdogTripReason) => void;
    /** Called once when the worker fails to spawn or dies early. */
    onSpawnFailure?: (err: unknown) => void;
    /** Test seam: pin the TTY verdict so both directions of the stderr gate
     *  run deterministically regardless of the runner's terminal. */
    stderrTty?: boolean;
}

interface WatchdogInitMsg {
    type: "init";
    logFile: string | null;
    version: string;
    softWarnMs: number;
    hardTimeoutMs: number;
    checkIntervalMs: number;
    fatalMode: "exit" | "report";
    stderrTty: boolean;
    parentPid: number;
    parentConfirmTicks: number;
    watcherCount: number;
}
interface WatchdogBeatMsg {
    type: "beat";
    count: number;
}
type WatchdogToWorker = WatchdogInitMsg | WatchdogBeatMsg;
interface WatchdogTripMsg {
    type: "trip";
    gapMs: number;
    reason?: WatchdogTripReason;
}

// The worker runs as inline code (eval): dist/index.js is a SINGLE bundled
// file, so the worker cannot reference a sibling module path. Its only import
// is a GUARDED require of node:worker_threads — the parentPort global does not
// exist in eval workers (ReferenceError, verified on Node 22), so the port
// must be fetched from the module itself.
const WORKER_CODE = [
    "let parentPort = null;",
    "try { parentPort = require(\"worker_threads\").parentPort; } catch (e) {}",
    "let logFile = null;",
    "let version = \"\";",
    "let softWarnMs = 0;",
    "let hardTimeoutMs = 0;",
    "let fatalMode = \"exit\";",
    "let lastBeat = Date.now();",
    "let warned = false;",
    "let tripped = false;",
    "let parentPid = 0;",
    "let parentConfirmTicks = 3;",
    "let parentDeadStreak = 0;",
    "let parentTripped = false;",
    "let watcherCount = 0;",
    "let timer = null;",
    "let emitStderr = false;",
    "",
    "function verdict(gap) {",
    "  if (gap >= hardTimeoutMs) return \"trip\";",
    "  if (gap >= softWarnMs && !warned) return \"warn\";",
    "  return \"ok\";",
    "}",
    "",
    "function fmt(ms) {",
    "  return ms >= 1000 ? Math.round(ms / 1000) + \"s\" : ms + \"ms\";",
    "}",
    "",
    // kill-0 liveness probe, #3890 discipline: EPERM means the pid EXISTS but
    // belongs to someone else — alive. Only ESRCH (and friends) mean gone.
    "function ownerAlive() {",
    "  try { process.kill(parentPid, 0); return true; } catch (e) { return e !== null && e.code === \"EPERM\"; }",
    "}",
    "",
    "function line(level, msg) {",
    "  const row = new Date().toISOString() + \" [\" + level + \"][v=\" + version + \"] \" + msg + \"\\n\";",
    "  try { if (logFile !== null) require(\"fs\").appendFileSync(logFile, row); } catch (e) {}",
    "  if (emitStderr) { try { process.stderr.write(row); } catch (e) {} }",
    "}",
    "",
    "function tick() {",
    "  const gap = Date.now() - lastBeat;",
    "  const v = verdict(gap);",
    "  if (v === \"warn\") {",
    "    warned = true;",
    "    line(\"warn\", \"[event-loop-watchdog] main event loop silent for \" + fmt(gap) + \" (soft threshold \" + fmt(softWarnMs) + \") — self-exit after \" + fmt(hardTimeoutMs) + \" of continuous block (#4762)\");",
    "  } else if (v === \"trip\" && !tripped) {",
    "    tripped = true;",
    "    line(\"error\", \"[event-loop-watchdog] FATAL: main event loop silent for \" + fmt(gap) + \" (hard threshold \" + fmt(hardTimeoutMs) + \") — exiting so the spawner can respawn onto the freed port (#4762)\");",
    "    try { parentPort.postMessage({ type: \"trip\", gapMs: gap, reason: \"loop-wedge\" }); } catch (e) {}",
    "    if (fatalMode === \"exit\") process.exit(1);",
    "  }",
    // Owner axis (#5449), independent of the loop-gap verdict above: fires only
    // when ALL of dead-streak / loop-silence / no-other-watchers hold, so a
    // still-yielding loop always reaches its own graceful shutdown first.
    "  if (!parentTripped && parentPid > 0) {",
    "    if (ownerAlive()) { parentDeadStreak = 0; } else { parentDeadStreak++; }",
    "    if (parentDeadStreak >= parentConfirmTicks && gap >= softWarnMs && watcherCount <= 0) {",
    "      parentTripped = true;",
    "      line(\"error\", \"[event-loop-watchdog] FATAL: owner pid \" + parentPid + \" gone (kill-0 x\" + parentConfirmTicks + \" off-loop) with loop silent for \" + fmt(gap) + \" and no other watchers — exiting so the spawner can respawn onto the freed port (#5449)\");",
    "      try { parentPort.postMessage({ type: \"trip\", gapMs: gap, reason: \"parent-gone\" }); } catch (e) {}",
    "      if (fatalMode === \"exit\") process.exit(1);",
    "    }",
    "  }",
    "}",
    "",
    "if (parentPort !== null) parentPort.on(\"message\", (m) => {",
    "  if (!m || typeof m !== \"object\") return;",
    "  if (m.type === \"init\") {",
    "    logFile = typeof m.logFile === \"string\" ? m.logFile : null;",
    "    emitStderr = (logFile === null) || m.stderrTty === true;",
    "    version = String(m.version ?? \"\");",
    "    softWarnMs = Number(m.softWarnMs) || 0;",
    "    hardTimeoutMs = Number(m.hardTimeoutMs) || 0;",
    "    fatalMode = m.fatalMode === \"report\" ? \"report\" : \"exit\";",
    "    lastBeat = Date.now();",
    "    warned = false;",
    "    tripped = false;",
    "    parentPid = Number.isInteger(m.parentPid) && m.parentPid > 0 ? m.parentPid : 0;",
    "    parentConfirmTicks = Number.isInteger(m.parentConfirmTicks) && m.parentConfirmTicks > 0 ? m.parentConfirmTicks : 3;",
    "    parentDeadStreak = 0;",
    "    parentTripped = false;",
    "    watcherCount = Number.isInteger(m.watcherCount) && m.watcherCount >= 0 ? m.watcherCount : 0;",
    "    if (timer === null) timer = setInterval(tick, Math.max(10, Number(m.checkIntervalMs) || 5000));",
    "  } else if (m.type === \"beat\") {",
    "    lastBeat = Date.now();",
    "    warned = false;",
    "    tripped = false;",
    // count rides every beat; a wedged loop freezes the last known value —
    // sound, because attaching a new owner during a wedge needs an HTTP answer.
    "    watcherCount = Number.isInteger(m.count) && m.count >= 0 ? m.count : watcherCount;",
    "  }",
    "});",
].join("\n");

export function armEventLoopWatchdog(opts: ArmEventLoopWatchdogOptions = {}): EventLoopWatchdogHandle | undefined {
    const heartbeatMs = opts.heartbeatMs ?? WATCHDOG_HEARTBEAT_MS;
    const softWarnMs = opts.softWarnMs ?? WATCHDOG_SOFT_WARN_MS;
    const hardTimeoutMs = opts.hardTimeoutMs ?? WATCHDOG_HARD_TIMEOUT_MS;
    const checkIntervalMs = opts.checkIntervalMs ?? WATCHDOG_CHECK_INTERVAL_MS;
    const fatalMode: "exit" | "report" = opts.fatalMode ?? "exit";
    // #5449 axis off-switch: non-positive / non-integer pids disable the owner
    // probe entirely (manual `bili start` passes nothing — zero behavior change).
    const parentPid = typeof opts.parentPid === "number" && Number.isInteger(opts.parentPid) && opts.parentPid > 0 ? opts.parentPid : 0;
    const readWatcherCount = (): number => {
        try {
            const n = opts.getWatcherCount?.();
            return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
        } catch {
            return 0;
        }
    };

    let worker: Worker;
    try {
        const spawn = opts.spawnWorker ?? ((code: string, o: WorkerOptions) => new Worker(code, { ...o, eval: true }));
        worker = spawn(WORKER_CODE, {});
    } catch (err) {
        opts.onSpawnFailure?.(err);
        return undefined;
    }

    let stopped = false;
    const beatTimer = setInterval(() => {
        if (stopped) return;
        try {
            // count rides every beat so the worker's last-owner guard sees live
            // watcher-set changes even between trips (#7 semantics, #5449).
            worker.postMessage({ type: "beat", count: readWatcherCount() } satisfies WatchdogToWorker);
        } catch {
            // worker already gone — nothing left to heartbeat to.
        }
    }, heartbeatMs);
    // #4762 review follow-up: unref like the worker below — a ref'd heartbeat
    // keeps every startServer caller (incl. all 362 test files that drive it)
    // alive forever after their last real handle closed. Retention-only change:
    // while the loop runs, beats still fire, so wedge detection is untouched.
    beatTimer.unref();

    worker.on("message", (msg: unknown) => {
        const m = msg as Partial<WatchdogTripMsg>;
        if (m && m.type === "trip" && typeof m.gapMs === "number") opts.onTrip?.(m.gapMs, m.reason);
    });
    // An unhandled 'error' on a Worker THROWS — swallow it: a dead watchdog
    // worker degrades to "unwatched", never crashes the proxy.
    worker.on("error", (err) => {
        if (!stopped) opts.onSpawnFailure?.(err);
    });
    worker.on("exit", (code) => {
        if (!stopped && code !== 0 && code !== null) opts.onSpawnFailure?.(new Error(`watchdog worker exited with code ${code}`));
    });

    try {
        worker.postMessage({
            type: "init",
            logFile: opts.logFile ?? null,
            version: opts.version ?? "",
            softWarnMs,
            hardTimeoutMs,
            checkIntervalMs,
            fatalMode,
            parentPid,
            parentConfirmTicks: WATCHDOG_OWNER_DEAD_CONFIRM_TICKS,
            watcherCount: readWatcherCount(),
            stderrTty: opts.stderrTty ?? process.stderr.isTTY === true,
        } satisfies WatchdogInitMsg);
    } catch (err) {
        clearInterval(beatTimer);
        void worker.terminate().catch(() => {});
        opts.onSpawnFailure?.(err);
        return undefined;
    }

    // #4762 review: the safety net must not hold the process hostage — an
    // un-unref'd worker would delay a clean natural exit of a SHUTTING-DOWN
    // proxy (exit paths here end in process.exit, but availability over
    // guardrail says the watchdog degrades away rather than lingers).
    worker.unref?.();

    return {
        stop(): void {
            if (stopped) return;
            stopped = true;
            clearInterval(beatTimer);
            void worker.terminate().catch(() => {});
        },
    };
}
