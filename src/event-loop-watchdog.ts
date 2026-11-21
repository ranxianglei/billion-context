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
 * a warning; after HARD_TIMEOUT_MS it writes a forensic line and kills the
 * WHOLE process so the spawner respawns onto the freed port. The kill is a
 * SIGKILL to its own pid, NOT process.exit(): inside a worker thread
 * process.exit() ends only the worker, so the wedged proxy used to survive its
 * own watchdog and run on unwatched. SIGKILL needs nothing from the blocked
 * main thread (a JS SIGTERM listener would never run); on Windows
 * process.kill maps to TerminateProcess. Legit work never blocks the loop for
 * five straight minutes — compression runs in sync slices that complete in
 * seconds to minutes and yield between requests — so the hard threshold is
 * deadlock detection, not load detection.
 *
 * Freeze detection (#7482): the worker's OWN tick interval is the signal that
 * separates a real main-thread wedge from an OS-level freeze (a sleeping
 * phone / deep-sleep laptop suspends the WHOLE process — main thread AND
 * worker). On a wedge the worker keeps ticking on schedule, so its tick gap
 * stays near `checkIntervalMs`; on a freeze the worker misses its own ticks
 * and the tick gap jumps. When the tick gap exceeds 2× `checkIntervalMs` the
 * worker resets its baseline (lastBeat/warned/tripped) instead of tripping, so
 * an unattended lane survives the freeze and is still alive when the device
 * wakes — instead of self-exiting into a dead port with no spawner to
 * respawn it. A genuine wedge that happens to span a freeze is delayed by one
 * freeze cycle, never masked permanently: after the reset the heartbeat gap
 * grows again from the fresh baseline and trips as before.
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
 */
import { Worker, type WorkerOptions } from "node:worker_threads";

export const WATCHDOG_HEARTBEAT_MS = 5_000;
const WATCHDOG_CHECK_INTERVAL_MS = 5_000;
export const WATCHDOG_SOFT_WARN_MS = 30_000;
export const WATCHDOG_HARD_TIMEOUT_MS = 5 * 60_000;

type WatchdogVerdict = "ok" | "warn" | "trip";

/** Pure gap→verdict mapping — the worker's tick logic, unit-testable without
 *  spawning anything. `warned` prevents re-warning on every tick. */
export function watchdogVerdict(gapMs: number, warned: boolean, softWarnMs: number, hardTimeoutMs: number): WatchdogVerdict {
    if (gapMs >= hardTimeoutMs) return "trip";
    if (gapMs >= softWarnMs && !warned) return "warn";
    return "ok";
}

/** Pure freeze-detection (#7482): `true` when the worker's OWN tick interval
 *  jumped far beyond `checkIntervalMs` — the worker missed its own ticks, so
 *  the WHOLE process was frozen by the OS (a sleeping phone / deep-sleep
 *  laptop), NOT a main-thread wedge (where the worker's event loop keeps
 *  running on schedule). On a freeze the worker resets its baseline instead of
 *  tripping, so an unattended lane survives the freeze instead of self-exiting
 *  into a dead port with no spawner to respawn it. */
export function watchdogFreezeVerdict(tickGapMs: number, checkIntervalMs: number): boolean {
    return tickGapMs > 2 * checkIntervalMs;
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
    /** "exit" (production): the worker SIGKILLs its own process itself,
     *  required because a wedged main thread can never receive a message
     *  asking it to die (and process.exit() in a worker ends only the worker).
     *  "report": the worker posts {type:"trip"} and stays alive — test
     *  seam so the suite process is not killed. */
    fatalMode?: "exit" | "report";
    /** Test seam: swap the Worker constructor. */
    spawnWorker?: (code: string, opts: WorkerOptions) => Worker;
    /** Called (report mode) when the worker trips. */
    onTrip?: (gapMs: number) => void;
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
}
interface WatchdogBeatMsg {
    type: "beat";
}
type WatchdogToWorker = WatchdogInitMsg | WatchdogBeatMsg;
interface WatchdogTripMsg {
    type: "trip";
    gapMs: number;
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
    "let lastWorkerTick = Date.now();",
    "let checkIntervalMs = 5000;",
    "let warned = false;",
    "let tripped = false;",
    "let timer = null;",
    "let emitStderr = false;",
    "",
    "function verdict(gap) {",
    "  if (gap >= hardTimeoutMs) return \"trip\";",
    "  if (gap >= softWarnMs && !warned) return \"warn\";",
    "  return \"ok\";",
    "}",
    "",
    "function isFrozen(tickGap) {",
    "  return tickGap > 2 * checkIntervalMs;",
    "}",
    "",
    "function fmt(ms) {",
    "  return ms >= 1000 ? Math.round(ms / 1000) + \"s\" : ms + \"ms\";",
    "}",
    "",
    "function line(level, msg) {",
    "  const row = new Date().toISOString() + \" [\" + level + \"][v=\" + version + \"] \" + msg + \"\\n\";",
    "  try { if (logFile !== null) require(\"fs\").appendFileSync(logFile, row); } catch (e) {}",
    "  if (emitStderr) { try { process.stderr.write(row); } catch (e) {} }",
    "}",
    "",
    "function killWholeProcess() {",
    "  try { process.kill(process.pid, \"SIGKILL\"); } catch (e) {}",
    "  process.exit(1);",
    "}",
    "",
    "function tick() {",
    "  const now = Date.now();",
    "  const tickGap = now - lastWorkerTick;",
    "  lastWorkerTick = now;",
    "  if (isFrozen(tickGap)) {",
    "    // The worker's own tick interval jumped: the WHOLE process was frozen",
    "    // by the OS (sleeping device), not a main-thread wedge. Reset the",
    "    // baseline so the freeze does not count as silence (#7482).",
    "    lastBeat = now;",
    "    warned = false;",
    "    tripped = false;",
    "    line(\"info\", \"[event-loop-watchdog] process frozen for \" + fmt(tickGap) + \" (worker tick interval jumped) — resetting baseline, not tripping (#7482)\");",
    "    return;",
    "  }",
    "  const gap = now - lastBeat;",
    "  const v = verdict(gap);",
    "  if (v === \"warn\") {",
    "    warned = true;",
    "    line(\"warn\", \"[event-loop-watchdog] main event loop silent for \" + fmt(gap) + \" (soft threshold \" + fmt(softWarnMs) + \") — self-exit after \" + fmt(hardTimeoutMs) + \" of continuous block (#4762)\");",
    "  } else if (v === \"trip\" && !tripped) {",
    "    tripped = true;",
    "    line(\"error\", \"[event-loop-watchdog] FATAL: main event loop silent for \" + fmt(gap) + \" (hard threshold \" + fmt(hardTimeoutMs) + \") — exiting so the spawner can respawn onto the freed port (#4762)\");",
    "    try { parentPort.postMessage({ type: \"trip\", gapMs: gap }); } catch (e) {}",
    "    if (fatalMode === \"exit\") killWholeProcess();",
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
    "    checkIntervalMs = Math.max(10, Number(m.checkIntervalMs) || 5000);",
    "    lastBeat = Date.now();",
    "    lastWorkerTick = Date.now();",
    "    warned = false;",
    "    tripped = false;",
    "    if (timer === null) timer = setInterval(tick, checkIntervalMs);",
    "  } else if (m.type === \"beat\") {",
    "    lastBeat = Date.now();",
    "    warned = false;",
    "    tripped = false;",
    "  }",
    "});",
].join("\n");

export function armEventLoopWatchdog(opts: ArmEventLoopWatchdogOptions = {}): EventLoopWatchdogHandle | undefined {
    const heartbeatMs = opts.heartbeatMs ?? WATCHDOG_HEARTBEAT_MS;
    const softWarnMs = opts.softWarnMs ?? WATCHDOG_SOFT_WARN_MS;
    const hardTimeoutMs = opts.hardTimeoutMs ?? WATCHDOG_HARD_TIMEOUT_MS;
    const checkIntervalMs = opts.checkIntervalMs ?? WATCHDOG_CHECK_INTERVAL_MS;
    const fatalMode: "exit" | "report" = opts.fatalMode ?? "exit";

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
            worker.postMessage({ type: "beat" } satisfies WatchdogToWorker);
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
        if (m && m.type === "trip" && typeof m.gapMs === "number") opts.onTrip?.(m.gapMs);
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
