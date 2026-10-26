// claude native MCP entry (#1821): spawned per-session by Claude Code as the
// "bili" MCP server the installer registers (plugin-install.ts). Serves the
// ACP tools over stdio like dist/mcp.js, plus a session-lived watchdog that
// respawns the lane proxy when it dies MID-SESSION: the model channel rides
// claude's own HTTP client against the static baked base URL, and nothing else
// re-arms it until the next SessionStart hook (which does not re-run mid-session).
// Mirrors src/zcode/mcp-entry.ts (30 s tick × 3 failures). No exit handoff is
// needed: the proxy watches the claude host pid (parent-gone anti-orphan) and
// the next hook drops dead pins via pid liveness (launcher.ts attach filter).
// Logs go through the shared bili.log tee because claude does not surface this
// child's stderr.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProxyOrigin, runMcpStdio } from "./mcp.js";
import { configureLogger, log as teeLog } from "./logger.js";
import { defaultLogFile } from "./paths.js";
import { LAUNCHER_DEFAULT_HOST, ensureProxyRunning, healthUrl } from "./launcher.js";
import { chooseWatchdogParentPid, planClaudeNativeBootstrap } from "./claude-native-bootstrap.js";
import { repinClaudeManagedBaseUrl, readClaudeManagedBaseUrl } from "./plugin-install.js";

const WATCHDOG_INTERVAL_MS = 30000;
const WATCHDOG_FAILURE_LIMIT = 3;

/** dist/claude-mcp-entry.js → sibling dist/index.js (the package bin) — the
 *  same guard as claude-native-bootstrap's proxyScriptPath: ensureProxyRunning's
 *  default script would re-invoke THIS script as the proxy. */
function proxyScriptPath(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
}

async function probeProxyHealth(origin: string): Promise<boolean> {
    try {
        const res = await fetch(healthUrl(origin), { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

export interface WatchdogDeps {
    /** Test seam: liveness probe (default: GET /__bili/health). */
    probe?: (origin: string) => Promise<boolean>;
    /** Test seam: bring-up (default: ensureProxyRunning). */
    ensure?: typeof ensureProxyRunning;
    /** Test seam: settings repin (default: repinClaudeManagedBaseUrl). */
    repin?: (origin: string) => string[];
    intervalMs?: number;
    failureLimit?: number;
}

export interface WatchdogState {
    origin: string;
}

export interface MutableWatchdogState extends WatchdogState {
    failures: number;
}

/** One watchdog pass: healthy → reset; dead `failureLimit` times in a row →
 *  bring the lane proxy back up with the SAME semantics as the SessionStart
 *  hook (explicit pin strict; zone mode port 0 so the launcher settles the
 *  sticky record), watching the CLAUDE host pid — not this child, so a child
 *  crash never kills a healthy proxy. A respawn on a drifted origin repins the
 *  managed settings (heals the NEXT session — the current one keeps dialing
 *  the base URL claude loaded at startup, the same #1660 constraint as the
 *  hook) and follows it in our own BILI_MCP_PROXY pin so bili tools keep working. */
export async function watchdogTick(state: MutableWatchdogState, plan: { port: number; strict: boolean }, deps: WatchdogDeps, log: (msg: string) => void): Promise<void> {
    const probeFn = deps.probe ?? probeProxyHealth;
    const limit = deps.failureLimit ?? WATCHDOG_FAILURE_LIMIT;
    if (await probeFn(state.origin)) {
        state.failures = 0;
        return;
    }
    state.failures += 1;
    if (state.failures < limit) return;
    const ensure = deps.ensure ?? ensureProxyRunning;
    const handle = await ensure(
        {
            host: LAUNCHER_DEFAULT_HOST,
            port: plan.strict ? plan.port : 0,
            passthrough: false,
            debug: false,
            parentPid: chooseWatchdogParentPid(),
            strictPort: plan.strict,
            lane: "claude",
        },
        { scriptPath: proxyScriptPath() },
    );
    if ((handle.refusedWatcher ?? false)) {
        log(`WARNING: proxy at ${handle.origin} has NO session-lifecycle watchdog (#1322) — kill it or start a session-owned proxy to restore the lifecycle contract`);
    }
    if (handle.origin !== state.origin) {
        const repin = deps.repin ?? repinClaudeManagedBaseUrl;
        try {
            const notes = repin(handle.origin);
            if (notes.length > 0) log(`managed settings repinned: ${notes.join("; ")}`);
        } catch (err) {
            log(`managed settings repin failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
        process.env.BILI_MCP_PROXY = handle.origin;
        state.origin = handle.origin;
    }
    log(`proxy ${handle.attached ? "attached" : "respawned"} at ${handle.origin}`);
    // Cool the counter only once the bring-up actually completed — a failed
    // attempt leaves it hot so the NEXT tick retries immediately (zcode parity):
    // a transient spawn failure must not cost another full failure cycle.
    state.failures = 0;
}

export function startWatchdog(state: MutableWatchdogState, plan: { port: number; strict: boolean }, log: (msg: string) => void, deps: WatchdogDeps = {}): NodeJS.Timeout {
    let busy = false;
    const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void watchdogTick(state, plan, deps, log)
            .catch((err) => log(`watchdog error: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => { busy = false; });
    }, deps.intervalMs ?? WATCHDOG_INTERVAL_MS);
    timer.unref?.();
    return timer;
}

export async function main(opts: WatchdogDeps & { runStdio?: () => void } = {}): Promise<void> {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return;
    configureLogger(defaultLogFile());
    const log = (msg: string) => teeLog("info", `[bili-claude-mcp] ${msg}`);
    const plan = planClaudeNativeBootstrap(process.env);
    if (plan.action !== "start") {
        // attach (BILLION_CONTEXT_PROXY / BILI_PROVIDER_REWRITES) or passthrough
        // (opt-out): someone else owns routing — serve tools only, NEVER respawn
        // (a second proxy beside an attach target would split sessions across two).
        (opts.runStdio ?? runMcpStdio)();
        return;
    }
    // Track what THIS running claude dialed: the managed block's last-repinned
    // URL wins (settings.json), then the installer pin / live discovery.
    const state: MutableWatchdogState = { origin: readClaudeManagedBaseUrl() ?? resolveProxyOrigin(), failures: 0 };
    startWatchdog(state, plan, log, opts);
    (opts.runStdio ?? runMcpStdio)();
}

if (process.argv[1] && /(?:^|[\\/])claude-mcp-entry\.(?:ts|js)$/.test(process.argv[1])) {
    main().catch((err) => {
        process.stderr.write(`[bili-claude-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    });
}
