// kimi native mode bootstrap (#963): plan (off/attach/spawn), bring a proxy
// up, route config.toml through it, and report runtime-info. Shared by the
// MCP entry (authoritative) and the SessionStart hook (best-effort attach).

import fs from "node:fs";
import path from "node:path";
import { LAUNCHER_DEFAULT_HOST, ensureProxyRunning } from "../launcher.js";
import { resolveKimiHome } from "../client-config.js";
import { isPidAlive } from "../instance.js";
import { nativeAttachOrigin, nativeProxyScriptPath, proxyEnvOrigin } from "../agent/native-bootstrap.js";
import { reportRuntimeInfo, type RuntimeInfoReport } from "../agent/shared.js";
import {
    applyKimiManagedConfig,
    unrouteKimiConfig,
    resolveKimiRoute,
    stampKimiPluginHeader,
    type KimiRouteState,
} from "./toml-edit.js";

type KimiNativePlan =
    | { readonly mode: "off" }
    | { readonly mode: "attach"; readonly attachOrigin: string }
    | { readonly mode: "spawn" };

// Kill-switches > attach (BILLION_CONTEXT_ATTACH ?? BILLION_CONTEXT_PROXY) >
// spawn. A preset BILLION_CONTEXT_PROXY is the `bili kimi` launcher (or a user
// attach): routing is already owned (MITM / /bili/ rewrite), so we attach —
// stamp headers only, never rewrite, never spawn. Same contract as
// planNativeDsh (#941).
export function planNativeKimi(env: NodeJS.ProcessEnv = process.env): KimiNativePlan {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_KIMI === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const attach = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attach !== undefined) return { mode: "attach", attachOrigin: attach };
    return { mode: "spawn" };
}

export async function probeProxyHealth(origin: string, timeoutMs = 2000): Promise<boolean> {
    try {
        const res = await fetch(`${origin}/__bili/plugin/status?conversationId=kimi&fallback=latest`, { signal: AbortSignal.timeout(timeoutMs) });
        // A live proxy answers this in EVERY boot state — 200 once a session
        // exists, 404 before the first request (#955 pre-first-request window)
        // — so 404 is healthy too; only a network failure means "not up yet".
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

async function withConfigLock<T>(kimiHome: string, fn: () => T): Promise<T> {
    const lockDir = path.join(kimiHome, CONFIG_LOCK_DIR);
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
            if (Date.now() > deadline) throw new Error("timed out waiting for the kimi config.toml lock");
            await new Promise<void>((r) => setTimeout(r, 100));
        }
    }
    try {
        return fn();
    } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
    }
}

export interface KimiRouteApplied {
    readonly origin: string;
    readonly port: number;
    readonly upstream: string;
    readonly modelId: string;
    readonly contextWindow?: number;
    readonly maxOutput?: number;
    readonly authSource: string;
}

interface RouteKimiOptions {
    readonly origin: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly kimiHome?: string;
    readonly log?: (msg: string) => void;
}

/** Rewrite config.toml so the active model route flows through `origin`
 *  (idempotent), snapshotting the pristine file on first mutation. Returns
 *  what was applied, or undefined with a logged reason when routing is not
 *  possible for this user's setup. */
export async function routeKimiConfig(opts: RouteKimiOptions): Promise<KimiRouteApplied | undefined> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const home = opts.kimiHome ?? resolveKimiHome(env);
    const cfgPath = path.join(home, "config.toml");
    let text: string;
    try {
        text = fs.readFileSync(cfgPath, "utf8");
    } catch {
        log(`no ${cfgPath} — nothing to route`);
        return undefined;
    }
    let res = resolveKimiRoute(text, env);
    if (!res.ok) {
        log(`skipping config rewrite: ${res.reason}`);
        return undefined;
    }
    const port = Number.parseInt(new URL(opts.origin).port, 10);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`cannot derive a port from proxy origin ${opts.origin}`);
    const state: KimiRouteState = {
        port,
        upstream: res.upstream,
        modelId: res.modelId,
        contextWindow: res.contextWindow,
        maxOutput: res.maxOutput,
        authLines: res.authLines,
    };
    const authSource = res.authSource;
    const bakPath = path.join(home, "config.toml.bili-bak");
    await withConfigLock(home, () => {
        const current = fs.readFileSync(cfgPath, "utf8");
        if (!fs.existsSync(bakPath)) fs.writeFileSync(bakPath, current);
        fs.writeFileSync(cfgPath, applyKimiManagedConfig(current, state));
    });
    // Re-resolve against the written text to catch self-apply corruption early.
    const check = resolveKimiRoute(fs.readFileSync(cfgPath, "utf8"), env);
    if (!check.ok || check.upstream !== res.upstream) throw new Error(`kimi config rewrite verification failed: ${check.ok ? "upstream mismatch" : check.reason}`);
    return {
        origin: opts.origin,
        port,
        upstream: res.upstream,
        modelId: res.modelId,
        contextWindow: res.contextWindow,
        maxOutput: res.maxOutput,
        authSource,
    };
}

/** Stamp the plugin-mode header into the managed block (after the ACP tool
 *  list is known good) and push runtime-info to the proxy. */
export async function activateKimiPluginMode(applied: KimiRouteApplied, opts: Omit<RouteKimiOptions, "origin"> = {}): Promise<void> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const home = opts.kimiHome ?? resolveKimiHome(env);
    const cfgPath = path.join(home, "config.toml");
    await withConfigLock(home, () => {
        fs.writeFileSync(cfgPath, stampKimiPluginHeader(fs.readFileSync(cfgPath, "utf8")));
    });
    const info: RuntimeInfoReport = {
        agent: "kimi",
        model: applied.modelId,
        baseURL: applied.upstream,
        source: "native-bootstrap",
    };
    if (applied.contextWindow !== undefined) info.contextWindow = applied.contextWindow;
    if (applied.maxOutput !== undefined) info.maxOutput = applied.maxOutput;
    try {
        await reportRuntimeInfo(applied.origin, info);
    } catch (err) {
        log(`runtime-info report failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Revert config.toml to pre-native routing (watchdog give-up / kill-switch /
 *  uninstall). Prefers the pristine snapshot; falls back to the in-block
 *  prev-default-model record. */
export function unrouteKimi(opts: { env?: NodeJS.ProcessEnv; kimiHome?: string; log?: (msg: string) => void }): void {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const home = opts.kimiHome ?? resolveKimiHome(env);
    const cfgPath = path.join(home, "config.toml");
    const bakPath = path.join(home, "config.toml.bili-bak");
    try {
        let text: string;
        try {
            text = fs.readFileSync(cfgPath, "utf8");
        } catch {
            return;
        }
        if (text.includes("# bili begin")) {
            fs.writeFileSync(cfgPath, unrouteKimiConfig(text));
            log("reverted config.toml to pre-native routing");
        }
        try {
            fs.rmSync(bakPath, { force: true });
        } catch {}
    } catch (err) {
        log(`unroute failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

interface RestoreKimiBackupResult {
    readonly restored: boolean;
}

/** Uninstall-level restore: put the pristine .bili-bak text back verbatim. */
export function restoreKimiBackup(opts: { env?: NodeJS.ProcessEnv; kimiHome?: string; log?: (msg: string) => void }): RestoreKimiBackupResult {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const home = opts.kimiHome ?? resolveKimiHome(env);
    const cfgPath = path.join(home, "config.toml");
    const bakPath = path.join(home, "config.toml.bili-bak");
    try {
        const bak = fs.readFileSync(bakPath, "utf8");
        fs.writeFileSync(cfgPath, bak);
        fs.rmSync(bakPath, { force: true });
        log("restored config.toml from the pre-install snapshot");
        return { restored: true };
    } catch {
        unrouteKimi(opts);
        return { restored: false };
    }
}

export function defaultLog(msg: string): void {
    process.stderr.write(`[bili-kimi] ${msg}\n`);
}

export type BootstrapMode =
    | { readonly mode: "off" }
    | {
        readonly mode: "active";
        readonly attached: boolean;
        readonly routed: KimiRouteApplied | undefined;
    };

interface BootstrapKimiOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly kimiHome?: string;
    readonly log?: (msg: string) => void;
    /** Test seam: replace the real ensureProxyRunning (spawn/attach probe). */
    readonly ensureProxy?: () => Promise<{ origin: string; attached: boolean }>;
    /** Attach health-probe deadline (slow-starting user proxies). */
    readonly healthDeadlineMs?: number;
}

export async function bootstrapKimiNative(opts: BootstrapKimiOptions = {}): Promise<BootstrapMode> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const plan = planNativeKimi(env);
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

    const routed = await routeKimiConfig({ origin, env, kimiHome: opts.kimiHome, log });
    if (routed) log(`routed ${routed.modelId} via ${origin} → ${routed.upstream}`);
    return { mode: "active", attached, routed };
}

async function defaultEnsureProxy(): Promise<{ origin: string; attached: boolean }> {
    // The spawned proxy's parent-gone watchdog (#server.ts BILI_PARENT_PID)
    // keys off OUR pid: kimi kills this MCP child when its session ends, so
    // the per-session proxy tears itself down with it.
    const handle = await ensureProxyRunning(
        { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "kimi" },
        { scriptPath: nativeProxyScriptPath() },
    );
    return { origin: handle.origin, attached: !!handle.attached };
}
