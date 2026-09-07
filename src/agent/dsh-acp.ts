// Native dsh (deepseek-harness) cordis plugin: registers the `/acp` command
// AND owns this process's bili proxy (#521). Deployed natively by
// `bili plugin install dsh` into every profile's cordis.patch.yml; the
// `bili dsh` launcher falls back to a `--patch` overlay only when no profile
// carries a live native entry. Pure protocol client like the other agent
// plugins: no acp-kernel import, every byte of displayed data comes from the
// proxy's HTTP endpoints.
//
// Proxy bootstrap (apply-time, once per process):
//   1. BILLION_CONTEXT_PROXY set (launcher mode) → use that proxy.
//   2. else spawn `bili daemon --fresh --json --parent-pid <this pid>` —
//      dynamic port, session-scoped instance file; the daemon passes our pid
//      as BILI_PARENT_PID so the proxy's parent-gone watcher (#414) reaps it
//      ≤2s after dsh exits.
//   3. Resolve the active upstream origin (settings baseURL ?? DEEPSEEK_BASE_URL
//      ?? official deepseek default) and arm the fetch interceptor so LLM
//      traffic reaches the proxy via /bili/ without touching dsh's config.
//
// The interceptor is installed synchronously in apply() but resolves its
// routing targets asynchronously per fetch: dsh's first LLM call can fire
// before the daemon spawn finishes, and each early call waits on the bounded
// readiness gate instead of leaking direct (uncompressed) upstream traffic.
// Wire mode stays by design: dsh conversations carry no client-side id, so
// compression happens proxy-side and /acp reads the latest session panel.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proxyBaseFromEnv, fetchStatusLatest, fetchProxyVersion } from "./shared.js";
import { installFetchInterceptor, type FetchInterceptor, type FetchInterceptTargets } from "./intercept.js";
import { parseDshSettings, resolveDshUpstreamOrigin } from "./dsh-settings.js";

export const name = "bili-acp";
export const inject = ["commands"];

type CommandOutcome = { kind: "success" | "error"; text: string };

type CommandsService = {
    register: (command: { name: string; description: string; handler: () => Promise<CommandOutcome> }) => unknown;
};

type PluginContext = { commands: CommandsService };

type SetupResult =
    | { ok: true; proxyBase: string; upstreamOrigin?: string; intercepted: boolean; notes: string[] }
    | { ok: false; reason: string };

let setupPromise: Promise<SetupResult> | undefined;
let interceptor: FetchInterceptor | undefined;
// Resolved the moment the routing targets are KNOWN (base + upstream origin),
// i.e. BEFORE the health probe finishes: LLM traffic can be intercepted as
// soon as we know where to send it (a dead proxy degrades per-request via the
// interceptor's network-error fallback), and the health probe itself passes
// through the wrapper unblocked because it targets the proxy origin.
let routingPromise: Promise<FetchInterceptTargets | undefined> | undefined;

type Spawner = (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
type SettingsReader = () => { text: string; exists: boolean };

let spawnImpl: Spawner = defaultSpawn;
let readSettingsImpl: SettingsReader = defaultReadSettings;

// The cordis loader fixes apply(ctx)'s signature, so unit-test injection goes
// through module state instead of constructor arguments.
export function _setTestHooks(hooks: { spawn?: Spawner; readSettings?: SettingsReader }): void {
    if (hooks.spawn !== undefined) spawnImpl = hooks.spawn;
    if (hooks.readSettings !== undefined) readSettingsImpl = hooks.readSettings;
}

export function _resetTestHooks(): void {
    interceptor?.uninstall();
    interceptor = undefined;
    setupPromise = undefined;
    routingPromise = undefined;
    spawnImpl = defaultSpawn;
    readSettingsImpl = defaultReadSettings;
}

const DAEMON_SPAWN_TIMEOUT_MS = 30_000;
// Upper bound a single fetch may wait on bootstrap before passing through
// direct (setup keeps running in the background; later calls still intercept).
const GATE_TIMEOUT_MS = 8_000;

function cliEntry(): string {
    // dist/agent/dsh-acp.js → package root two levels up, resolved via
    // import.meta.url so global symlink bins keep working.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    return path.join(root, "dist", "index.js");
}

function defaultSpawn(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${err.message}\n${String(stderr).trim()}`.trim()));
            else resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

function defaultReadSettings(): { text: string; exists: boolean } {
    const raw = process.env.DSH_HOME?.trim();
    const home = raw && raw.length > 0 ? raw : path.join(os.homedir(), ".dsh");
    try {
        return { text: fs.readFileSync(path.join(home, "settings.yaml"), "utf8"), exists: true };
    } catch {
        return { text: "", exists: false };
    }
}

async function spawnDaemon(): Promise<{ origin: string; pid: number; logPath: string }> {
    const out = await spawnImpl(
        [cliEntry(), "daemon", "--fresh", "--json", "--parent-pid", String(process.pid)],
        DAEMON_SPAWN_TIMEOUT_MS,
    );
    const lines = out.stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const last = lines[lines.length - 1] ?? "";
    const parsed = JSON.parse(last) as { origin?: unknown; pid?: unknown; logPath?: unknown };
    if (typeof parsed.origin !== "string" || parsed.origin.length === 0) {
        throw new Error(`daemon reported no origin${typeof parsed.logPath === "string" && parsed.logPath ? ` (log: ${parsed.logPath})` : ""}`);
    }
    return {
        origin: parsed.origin,
        pid: typeof parsed.pid === "number" ? parsed.pid : -1,
        logPath: typeof parsed.logPath === "string" ? parsed.logPath : "",
    };
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function doSetup(settleRouting: (t: FetchInterceptTargets | undefined) => void): Promise<SetupResult> {
    const notes: string[] = [];
    let base = proxyBaseFromEnv();
    if (base) {
        notes.push(`proxy from BILLION_CONTEXT_PROXY: ${base}`);
    } else {
        try {
            const d = await spawnDaemon();
            base = d.origin;
            notes.push(`started session proxy at ${base}${d.pid > 0 ? ` (pid ${d.pid})` : ""}`);
        } catch (err) {
            settleRouting(undefined);
            return {
                ok: false,
                reason: `could not start the bili proxy (${errMsg(err)}) — run \`bili plugin install dsh\`, relaunch dsh, or launch through \`bili dsh\``,
            };
        }
    }
    let upstreamOrigin: string | undefined;
    const s = readSettingsImpl();
    if (s.exists) {
        try {
            const route = parseDshSettings(s.text);
            upstreamOrigin = resolveDshUpstreamOrigin(route, process.env);
            notes.push(`upstream route ${route.provider}/${route.model}${upstreamOrigin ? ` → ${upstreamOrigin}` : " (no origin resolved)"}`);
        } catch (err) {
            notes.push(`settings.yaml unreadable: ${errMsg(err)}`);
        }
    }
    const intercepted = upstreamOrigin !== undefined && upstreamOrigin !== base;
    if (intercepted) notes.push(`fetch interception armed: ${upstreamOrigin} → ${base}/bili/`);
    settleRouting(intercepted ? { upstreamOrigin: upstreamOrigin!, proxyOrigin: base } : undefined);
    try {
        const res = await fetch(`${base}/__bili/health`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    } catch (err) {
        return { ok: false, reason: `proxy at ${base} is not reachable (${errMsg(err)}) — is the bili proxy still running?` };
    }
    return { ok: true, proxyBase: base, upstreamOrigin, intercepted, notes };
}

function ensureSetupStarted(): void {
    if (!setupPromise) {
        let resolveRouting!: (t: FetchInterceptTargets | undefined) => void;
        routingPromise = new Promise((r) => {
            resolveRouting = r;
        });
        setupPromise = doSetup(resolveRouting);
    }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("gate timeout")), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}

async function resolveTargets(): Promise<FetchInterceptTargets | undefined> {
    ensureSetupStarted();
    try {
        return await withTimeout(routingPromise!, GATE_TIMEOUT_MS);
    } catch {
        return undefined;
    }
}

/** One `/acp` invocation: setup state first (proxy bootstrap may still be
 *  running), then the latest session panel, else armed-but-idle info, else a
 *  reachable-proxy failure. */
async function statusOutcome(): Promise<CommandOutcome> {
    ensureSetupStarted();
    const setup = await setupPromise!;
    if (!setup.ok) {
        return { kind: "error", text: `bili: ${setup.reason}` };
    }
    const base = setup.proxyBase;
    const status = await fetchStatusLatest(base);
    const panel = status?.panel;
    if (status && typeof panel === "string" && panel.length > 0) {
        const head = setup.intercepted ? `billion-context: ${setup.upstreamOrigin} → ${base}\n\n` : "";
        return { kind: "success", text: `${head}${panel}` };
    }
    const version = await fetchProxyVersion(base);
    if (version) {
        const head = setup.intercepted ? `billion-context: ${setup.upstreamOrigin} → ${base}\n\n` : "";
        return {
            kind: "success",
            text: `${head}billion-context@${version} — proxy connected, compression armed. No model request seen yet; send one, then run /acp again.`,
        };
    }
    return {
        kind: "error",
        text: `bili: proxy not reachable at ${base} — is the bili proxy still running?`,
    };
}

export function apply(ctx: PluginContext): void {
    ensureSetupStarted();
    // Synchronous install so NO fetch can precede the wrapper; the wrapper's
    // async target resolution absorbs the daemon-spawn latency.
    interceptor ??= installFetchInterceptor({ resolveTargets });
    ctx.commands.register({
        name: "acp",
        description: "Show bili context-compression status",
        handler: statusOutcome,
    });
}
