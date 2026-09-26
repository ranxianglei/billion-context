// zcode native mode bootstrap (#1145): plan (off/attach/spawn), bring a proxy
// up, route the provider store through it, and report runtime-info. Shared by
// the MCP entry (authoritative) and the SessionStart hook (best-effort
// attach). Mirrors planNativeKimi (#963); per-session routing means no URL is
// ever frozen at install time.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LAUNCHER_DEFAULT_HOST, ensureProxyRunning } from "../launcher.js";
import { isPidAlive } from "../instance.js";
import { nativeAttachOrigin, nativeProxyScriptPath, proxyEnvOrigin } from "../agent/native-bootstrap.js";
import { reportRuntimeInfo, type RuntimeInfoReport } from "../agent/shared.js";
import {
    applyZcodeRouting,
    detectZcodeStore,
    resolveZcodeDataDir,
    stampZcodePluginHeader,
    unrouteZcodeText,
    zcodeStoreCandidates,
    type ZcodeStoreKind,
    type ZcodeWrappedEntry,
} from "./json-edit.js";

type ZcodeNativePlan =
    | { readonly mode: "off" }
    | { readonly mode: "attach"; readonly attachOrigin: string }
    | { readonly mode: "spawn" };

// Kill-switches > attach (BILLION_CONTEXT_ATTACH ?? BILLION_CONTEXT_PROXY) >
// spawn. A preset BILLION_CONTEXT_PROXY is the launcher (or a user attach):
// routing is already owned, so we attach — never rewrite, never spawn. Same
// contract as planNativeKimi (#963) / planNativeDsh (#941).
export function planNativeZcode(env: NodeJS.ProcessEnv = process.env): ZcodeNativePlan {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_ZCODE === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const attach = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attach !== undefined) return { mode: "attach", attachOrigin: attach };
    return { mode: "spawn" };
}

export async function probeProxyHealth(origin: string, timeoutMs = 2000): Promise<boolean> {
    try {
        const res = await fetch(`${origin}/__bili/plugin/status?conversationId=zcode&fallback=latest`, { signal: AbortSignal.timeout(timeoutMs) });
        // A live proxy answers this in EVERY boot state — 200 once a session
        // exists, 404 before the first request — so 404 is healthy too; only
        // a network failure means "not up yet".
        if (res.status >= 500) return false;
        const text = await res.text();
        return text.startsWith("{") && text.includes('"ok"');
    } catch {
        return false;
    }
}

export async function waitForProxyHealthy(origin: string, deadlineMs = 15000, intervalMs = 250): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
        if (await probeProxyHealth(origin)) return true;
        if (Date.now() + intervalMs > deadline) return false;
        await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
}

const CONFIG_LOCK_DIR = ".bili-config.lock";
const CONFIG_LOCK_TIMEOUT_MS = 5000;
const CONFIG_LOCK_STALE_MS = 30000;

function lockStale(lockDir: string): boolean {
    try {
        const pidRaw = fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim();
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > CONFIG_LOCK_STALE_MS) return true;
        const pid = Number.parseInt(pidRaw, 10);
        return Number.isInteger(pid) && pid > 0 && !isPidAlive(pid);
    } catch {
        return true;
    }
}

async function withConfigLock<T>(dataDir: string, fn: () => T): Promise<T> {
    const lockDir = path.join(dataDir, "v2", CONFIG_LOCK_DIR);
    fs.mkdirSync(path.join(dataDir, "v2"), { recursive: true });
    const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            fs.mkdirSync(lockDir);
            fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            if (lockStale(lockDir)) {
                fs.rmSync(lockDir, { recursive: true, force: true });
                continue;
            }
            if (Date.now() > deadline) throw new Error("timed out waiting for the zcode config lock");
            await new Promise<void>((r) => setTimeout(r, 100));
        }
    }
    try {
        return fn();
    } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
    }
}

export interface ZcodeRouteApplied {
    readonly origin: string;
    readonly port: number;
    readonly kind: ZcodeStoreKind;
    readonly file: string;
    readonly upstream: string;
    readonly wrapped: ZcodeWrappedEntry[];
}

interface RouteZcodeOptions {
    readonly origin: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly dataDir?: string;
    readonly log?: (msg: string) => void;
}

// #1002 snapshot discipline: .bili-bak holds the state before bili's LATEST
// write, re-snapshotted whenever the file changed since our previous write —
// i.e. user edits made while native mode is active are never lost on restore.
function hashText(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function snapshotAndWrite(file: string, text: string): void {
    const bak = `${file}.bili-bak`;
    const last = `${file}.bili-last`;
    if (fs.existsSync(file)) {
        let cur: string;
        try {
            cur = hashText(fs.readFileSync(file, "utf8"));
        } catch {
            return;
        }
        let prev: string | undefined;
        try {
            prev = fs.readFileSync(last, "utf8").trim();
        } catch {}
        if (!(prev === cur && fs.existsSync(bak))) fs.copyFileSync(file, bak);
    }
    fs.writeFileSync(file, text);
    try {
        fs.writeFileSync(last, `${hashText(text)}\n`);
    } catch {}
}

function removeSnapshots(file: string): void {
    try {
        fs.rmSync(`${file}.bili-bak`, { force: true });
    } catch {}
    try {
        fs.rmSync(`${file}.bili-last`, { force: true });
    } catch {}
}

/** Rewrite the detected provider store so the coding-plan traffic flows
 *  through `origin` (idempotent, re-wraps across sessions with different
 *  ports), snapshotting per #1002 before each mutation. Returns what was
 *  applied, or undefined with a logged reason when routing is not possible. */
export async function routeZcodeConfig(opts: RouteZcodeOptions): Promise<ZcodeRouteApplied | undefined> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const dataDir = opts.dataDir ?? resolveZcodeDataDir(env);
    const v2Dir = path.join(dataDir, "v2");
    const hasStore = fs.existsSync(v2Dir) || zcodeStoreCandidates(dataDir, "new", env).some((f) => fs.existsSync(f));
    if (!hasStore) {
        log(`no ${v2Dir} — nothing to route`);
        return undefined;
    }
    const { kind, file } = detectZcodeStore(dataDir, env);
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        log(`no ${file} — nothing to route`);
        return undefined;
    }
    const port = Number.parseInt(new URL(opts.origin).port, 10);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`cannot derive a port from proxy origin ${opts.origin}`);
    const applied = applyZcodeRouting(text, kind, opts.origin);
    if (applied.wrapped.length === 0) {
        log("no routable provider entry found — leaving the config untouched");
        return undefined;
    }
    await withConfigLock(dataDir, () => {
        snapshotAndWrite(file, applied.text);
    });
    // Re-apply against the written text to catch self-apply corruption early
    // (must be a fixed point: same wrapped set, byte-stable output).
    const check = applyZcodeRouting(fs.readFileSync(file, "utf8"), kind, opts.origin);
    if (check.wrapped.length !== applied.wrapped.length || check.text !== applied.text) {
        throw new Error(`zcode config rewrite verification failed for ${file}`);
    }
    return {
        origin: opts.origin,
        port,
        kind,
        file,
        upstream: applied.wrapped[0].upstream,
        wrapped: applied.wrapped,
    };
}

/** Stamp the plugin-mode header into the routed entries (after the ACP tool
 *  list is known good) and push runtime-info to the proxy. */
export async function activateZcodePluginMode(applied: ZcodeRouteApplied, opts: Omit<RouteZcodeOptions, "origin"> = {}): Promise<void> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const dataDir = opts.dataDir ?? resolveZcodeDataDir(env);
    await withConfigLock(dataDir, () => {
        fs.writeFileSync(applied.file, stampZcodePluginHeader(fs.readFileSync(applied.file, "utf8"), applied.kind));
    });
    const info: RuntimeInfoReport = {
        agent: "zcode",
        model: "zcode",
        baseURL: applied.upstream,
        source: "native-bootstrap",
    };
    try {
        await reportRuntimeInfo(applied.origin, info);
    } catch (err) {
        log(`runtime-info report failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Revert both provider stores to pre-native routing (watchdog give-up /
 *  kill-switch): strips the /bili/ wrapper in place so edits made while native
 *  mode was active survive. */
export function unrouteZcode(opts: { env?: NodeJS.ProcessEnv; dataDir?: string; log?: (msg: string) => void }): void {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const dataDir = opts.dataDir ?? resolveZcodeDataDir(env);
    try {
        for (const kind of ["legacy", "new"] as const) {
            for (const file of zcodeStoreCandidates(dataDir, kind, env)) {
                try {
                    const text = fs.readFileSync(file, "utf8");
                    if (text.includes("/bili/")) {
                        fs.writeFileSync(file, unrouteZcodeText(text, kind).text);
                        log(`reverted ${path.basename(file)} to pre-native routing`);
                    }
                } catch {}
                removeSnapshots(file);
            }
        }
    } catch (err) {
        log(`unroute failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

interface RestoreZcodeBackupResult {
    readonly restored: boolean;
}

/** Uninstall-level restore: put the pristine .bili-bak text back verbatim
 *  for every store that has one. */
export function restoreZcodeBackup(opts: { env?: NodeJS.ProcessEnv; dataDir?: string; log?: (msg: string) => void }): RestoreZcodeBackupResult {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const dataDir = opts.dataDir ?? resolveZcodeDataDir(env);
    let restoredAny = false;
    for (const kind of ["legacy", "new"] as const) {
        for (const file of zcodeStoreCandidates(dataDir, kind, env)) {
            try {
                const bak = fs.readFileSync(`${file}.bili-bak`, "utf8");
                fs.writeFileSync(file, bak);
                removeSnapshots(file);
                log(`restored ${path.basename(file)} from the pre-install snapshot`);
                restoredAny = true;
            } catch {}
        }
    }
    if (!restoredAny) unrouteZcode(opts);
    return { restored: restoredAny };
}

export function defaultLog(msg: string): void {
    process.stderr.write(`[bili-zcode] ${msg}\n`);
}

export type BootstrapMode =
    | { readonly mode: "off" }
    | {
        readonly mode: "active";
        readonly attached: boolean;
        readonly routed: ZcodeRouteApplied | undefined;
    };

interface BootstrapZcodeOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly dataDir?: string;
    readonly log?: (msg: string) => void;
    /** Test seam: replace the real ensureProxyRunning (spawn/attach probe). */
    readonly ensureProxy?: () => Promise<{ origin: string; attached: boolean }>;
    /** Attach health-probe deadline (slow-starting user proxies). */
    readonly healthDeadlineMs?: number;
}

export async function bootstrapZcodeNative(opts: BootstrapZcodeOptions = {}): Promise<BootstrapMode> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const plan = planNativeZcode(env);
    if (plan.mode === "off") return { mode: "off" };

    let origin: string;
    let attached: boolean;
    if (plan.mode === "attach") {
        origin = plan.attachOrigin;
        attached = true;
        if (!(await waitForProxyHealthy(origin, opts.healthDeadlineMs))) {
            throw new Error(`attach target ${origin} is not healthy — start your bili proxy first`);
        }
    } else {
        const ensure = opts.ensureProxy ?? defaultEnsureProxy;
        const handle = await ensure();
        origin = handle.origin;
        attached = !!handle.attached;
    }

    const routed = await routeZcodeConfig({ origin, env, dataDir: opts.dataDir, log });
    if (routed) log(`routed ${routed.wrapped.map((w) => w.id).join(", ")} via ${origin} → ${routed.upstream}`);
    return { mode: "active", attached, routed };
}

async function defaultEnsureProxy(): Promise<{ origin: string; attached: boolean }> {
    // The spawned proxy's parent-gone watchdog (#server.ts BILI_PARENT_PID)
    // keys off OUR pid: zcode kills this MCP child when its session ends, so
    // the per-session proxy tears itself down with it.
    const handle = await ensureProxyRunning(
        { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "zcode" },
        { scriptPath: nativeProxyScriptPath() },
    );
    return { origin: handle.origin, attached: !!handle.attached };
}
