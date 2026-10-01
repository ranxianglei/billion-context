// zcode native mode bootstrap (#1145): plan (off/attach/spawn), bring a proxy
// up, route the provider store through it, and report runtime-info. Shared by
// the MCP entry (authoritative) and the SessionStart hook (best-effort
// attach). Mirrors planNativeKimi (#963); per-session routing means no URL is
// ever frozen at install time.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LAUNCHER_DEFAULT_HOST, ensureProxyRunning, findLiveAttachableInstance } from "../launcher.js";
import { isPidAlive } from "../instance.js";
import { nativeAttachOrigin, nativeProxyScriptPath, proxyEnvOrigin } from "../agent/native-bootstrap.js";
import { reportRuntimeInfo, type RuntimeInfoReport } from "../agent/shared.js";
import { resolveZcodeNativePort, zcodeDirectPrefixes } from "../config.js";
import {
    applyZcodeRouting,
    defaultZcodeRoutePolicy,
    detectCurrentZcodeOrigin,
    detectZcodeStore,
    resolveZcodeDataDir,
    stampZcodePluginHeader,
    unrouteZcodeText,
    zcodeSigningBlocksRouting,
    zcodeStoreCandidates,
    ZcodeRoutePolicy,
    ZcodeStoreKind,
    ZcodeWrappedEntry,
} from "./json-edit.js";

const SIGNING_BLOCK_MESSAGE =
    'zcode v3.14+ client signing (#1621) rejects the http://127.0.0.1 /bili/ origin at model creation ("Client signing handshake requires HTTPS.") — skipping native routing; provider store left untouched. For compression on this build use the GUI cert-MITM setup (Settings → Network: HTTP proxy + root CA path).';

export type ZcodeNativePlan =
    | { readonly mode: "off" }
    | { readonly mode: "attach"; readonly attachOrigin: string }
    | { readonly mode: "spawn" };

// Kill-switches > attach (BILLION_CONTEXT_ATTACH ?? BILLION_CONTEXT_PROXY) >
// spawn. A preset BILLION_CONTEXT_PROXY is the launcher (or a user attach):
// we ATTACH to it instead of spawning. The shared provider store is still
// rewritten to the attached origin on every bootstrap (#1623: last-writer-
// wins across all instances; watchdog drift repair keeps the pointer alive),
// so an external store pin only survives when it matches the attached origin.
// Same contract as planNativeKimi (#963) / planNativeDsh (#941).
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

export interface RouteZcodeOptions {
    readonly origin: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly dataDir?: string;
    readonly log?: (msg: string) => void;
    /** Routing scope/exemptions (#1622). Default: route:"all" with no
     *  exemptions — call sites that resolve config themselves (bootstrap,
     *  watchdog, handoff) pass their resolved policy through. */
    readonly policy?: ZcodeRoutePolicy;
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

/** Policy for entry points that don't thread a resolved policy through
 *  options (mcp-entry watchdog, SessionStart hook, drift repair, exit
 *  handoff): read env + providers table now. Route scope is env-only
 *  (BILI_ZCODE_ROUTE) — the compat escape hatch; exemptions come from
 *  `direct: true` provider routes (#1622). */
export function zcodePolicyFromEnv(env: NodeJS.ProcessEnv): ZcodeRoutePolicy {
    const raw = (env.BILI_ZCODE_ROUTE ?? "").trim().toLowerCase();
    const route = raw === "plans" || raw === "none" ? raw : "all";
    const signRaw = (env.BILI_ZCODE_SIGNING_FIXED ?? "").trim().toLowerCase();
    return { route, directPrefixes: zcodeDirectPrefixes(env), assumeSigningFixed: signRaw === "1" || signRaw === "true" };
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
    const policy = opts.policy ?? defaultZcodeRoutePolicy();
    if (zcodeSigningBlocksRouting(kind, policy)) {
        log(SIGNING_BLOCK_MESSAGE);
        return undefined;
    }
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        log(`no ${file} — nothing to route`);
        return undefined;
    }
    const port = Number.parseInt(new URL(opts.origin).port, 10);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`cannot derive a port from proxy origin ${opts.origin}`);
    const applied = applyZcodeRouting(text, kind, opts.origin, policy);
    if (applied.wrapped.length === 0) {
        log("no routable provider entry found — leaving the config untouched");
        if (applied.skipped.length > 0) {
            log(`skipped ${applied.skipped.length} entr${applied.skipped.length === 1 ? "y" : "ies"}: ${applied.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}`);
        }
        return undefined;
    }
    await withConfigLock(dataDir, () => {
        snapshotAndWrite(file, applied.text);
    });
    // Re-apply against the written text to catch self-apply corruption early
    // (must be a fixed point: same wrapped set, byte-stable output).
    const check = applyZcodeRouting(fs.readFileSync(file, "utf8"), kind, opts.origin, policy);
    if (check.wrapped.length !== applied.wrapped.length || check.text !== applied.text) {
        throw new Error(`zcode config rewrite verification failed for ${file}`);
    }
    if (applied.skipped.length > 0) {
        log(`skipped ${applied.skipped.length} entr${applied.skipped.length === 1 ? "y" : "ies"}: ${applied.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}`);
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

export interface RestoreZcodeBackupResult {
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

export interface BootstrapZcodeOptions {
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

    // #1622: routing is on by default; BILI_ZCODE_ROUTE=none is the env-only
    // opt-out (behaves like plan "off"), "plans" the legacy whitelist mode.
    const policy = zcodePolicyFromEnv(env);
    if (policy.route === "none") {
        log('zcode route is "none" (BILI_ZCODE_ROUTE) — leaving the provider store direct');
        return { mode: "off" };
    }

    // #1621: degrade BEFORE any proxy bring-up; the caller's off-path runs
    // unrouteZcode, which also strips wrappers left by older bili versions.
    const dataDir = opts.dataDir ?? resolveZcodeDataDir(env);
    if (zcodeSigningBlocksRouting(detectZcodeStore(dataDir, env).kind, policy)) {
        log(SIGNING_BLOCK_MESSAGE);
        return { mode: "off" };
    }

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

    const routed = await routeZcodeConfig({ origin, env, dataDir, log, policy });
    if (routed) log(`routed ${routed.wrapped.map((w) => w.id).join(", ")} via ${origin} → ${routed.upstream}`);
    return { mode: "active", attached, routed };
}

async function defaultEnsureProxy(): Promise<{ origin: string; attached: boolean }> {
    // The spawned proxy's parent-gone watchdog (#server.ts BILI_PARENT_PID)
    // keys off OUR pid: zcode kills this MCP child when its session ends, so
    // the per-session proxy tears itself down with it. #1660 zone semantics:
    // BILI_ZCODE_PORT (explicit) keeps strict-port behavior; otherwise the
    // zcode lane binds its zone preference (sticky record > 18787 base) and
    // the proxy child's EADDRINUSE +1 ladder resolves collisions zero-config
    // — wrappers written by one session stay valid for the next one even
    // when nothing else hands the port off (#1622/#1623), and the store
    // drift-repair below follows any drift.
    const explicit = resolveZcodeNativePort();
    const handle = await ensureProxyRunning(
        { host: LAUNCHER_DEFAULT_HOST, port: explicit ?? 0, passthrough: false, debug: false, strictPort: explicit !== undefined, lane: "zcode" },
        { scriptPath: nativeProxyScriptPath() },
    );
    return { origin: handle.origin, attached: !!handle.attached };
}

// #1623 — shared-store drift repair & exit handoff. The provider store is a
// LAST-WRITER-WINS pointer across all instances (attach AND spawn rewrites it);
// an instance that dies without handoff leaves it pointing at a dead port, and
// every fresh reader then routes into ECONNREFUSED until the next bootstrap
// happens to rewrite it. These two entry points close that gap from the mcp-
// entry process: on exit we hand our own pointer off, and the watchdog tick
// repairs a dead pointer left by ANYONE (including hard-killed processes whose
// JS exit handlers never run).

export type StoreDriftOutcome =
    | "unmanaged"
    | "self"
    | "foreign-live"
    | "repointed-self"
    | "repointed-replacement"
    | "reverted-direct";

export interface StoreDriftOptions {
    readonly selfOrigin: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly dataDir?: string;
    readonly log?: (msg: string) => void;
    /** Test seam: liveness probe (default: probeProxyHealth). */
    readonly probe?: (origin: string) => Promise<boolean>;
    /** Test seam: find a live replacement instance (default: findLiveAttachableInstance). */
    readonly findReplacement?: () => Promise<{ origin: string } | undefined>;
}

async function defaultFindReplacement(): Promise<{ origin: string } | undefined> {
    // Called lazily: launcher.ts and this module are cycle-adjacent (via the
    // plugin-install lane), so the call must wait until both modules have
    // finished evaluating.
    const inst = await findLiveAttachableInstance(
        { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "zcode" },
        { scriptPath: nativeProxyScriptPath() },
    );
    return inst ? { origin: inst.origin } : undefined;
}

export async function repairSharedStoreDrift(opts: StoreDriftOptions): Promise<StoreDriftOutcome> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const probe = opts.probe ?? probeProxyHealth;
    const dataDir = opts.dataDir ?? resolveZcodeDataDir(env);
    const current = detectCurrentZcodeOrigin(dataDir, env);
    if (!current) return "unmanaged";
    if (current === opts.selfOrigin) return "self";
    if (await probe(current)) return "foreign-live";
    log(`shared store points at dead instance ${current} — repairing`);
    const policy = zcodePolicyFromEnv(env);
    if (await probe(opts.selfOrigin)) {
        const routed = await routeZcodeConfig({ origin: opts.selfOrigin, env, dataDir: opts.dataDir, log, policy });
        if (routed) {
            await activateZcodePluginMode(routed, { env, dataDir: opts.dataDir, log });
            log(`store repaired → ${opts.selfOrigin}`);
            return "repointed-self";
        }
    } else {
        const replacement = await (opts.findReplacement ?? defaultFindReplacement)();
        if (replacement) {
            const routed = await routeZcodeConfig({ origin: replacement.origin, env, dataDir: opts.dataDir, log, policy });
            if (routed) {
                await activateZcodePluginMode(routed, { env, dataDir: opts.dataDir, log });
                log(`store repaired → ${replacement.origin}`);
                return "repointed-replacement";
            }
        }
    }
    unrouteZcode({ env, dataDir: opts.dataDir, log });
    log(`store reverted to direct upstream (${current} is dead)`);
    return "reverted-direct";
}

export type ExitHandoffOutcome = "not-ours" | "handed-off" | "reverted-direct";

export interface ExitHandoffOptions {
    readonly ownOrigin: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly dataDir?: string;
    readonly log?: (msg: string) => void;
    /** Test seam: find a live replacement instance (default: findLiveAttachableInstance). */
    readonly findReplacement?: () => Promise<{ origin: string } | undefined>;
}

export async function handoffZcodeRoutingOnExit(opts: ExitHandoffOptions): Promise<ExitHandoffOutcome> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? defaultLog;
    const dataDir = opts.dataDir ?? resolveZcodeDataDir(env);
    const current = detectCurrentZcodeOrigin(dataDir, env);
    if (!current || current !== opts.ownOrigin) return "not-ours";
    const replacement = await (opts.findReplacement ?? defaultFindReplacement)();
    if (replacement) {
        const routed = await routeZcodeConfig({ origin: replacement.origin, env, dataDir: opts.dataDir, log, policy: zcodePolicyFromEnv(env) });
        if (routed) {
            await activateZcodePluginMode(routed, { env, dataDir: opts.dataDir, log });
            log(`exit handoff: store → ${replacement.origin}`);
            return "handed-off";
        }
    }
    unrouteZcode({ env, dataDir: opts.dataDir, log });
    log("exit handoff: store reverted to direct upstream");
    return "reverted-direct";
}
