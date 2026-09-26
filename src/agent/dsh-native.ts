// Native dsh (deepseek-harness) cordis plugin (#941): full plugin-mode
// compression for dsh WITHOUT a launcher — bare `dsh` with this plugin
// installed via `bili plugin install dsh` (cordis.patch.yml entry) or
// injected by the `bili dsh` launcher through the same --patch overlay that
// used to carry dsh-acp.ts. Architecture mirrors pi-native.ts:
//   1. plan: attach (BILLION_CONTEXT_ATTACH ?? BILLION_CONTEXT_PROXY — the
//      launcher preset, or a user-supplied external proxy; #983: the preset
//      is probed and a dead one falls back to spawn; #1130: runtime death of
//      the shared proxy re-runs the same probe+fallback) or spawn the
//      package's own proxy (ensureProxyRunning, ephemeral port, parent-pid
//      watchdog = this dsh process);
//   2. patch globalThis.fetch (native-intercept.ts) — model-API URLs are
//      rewritten to `<proxy>/bili/<url>` in BOTH modes (attach shares
//      #809 rewrite semantics; a loopback proxy target is never proxied,
//      so launcher MITM envs are simply bypassed); already-routed `/bili/`
//      URLs pass through untouched except for header stamping;
//   3. register the proxy's tool manifest (compress/decompress/acp_status)
//      as native dsh tools — parameters pass through verbatim (the manifest
//      serves real JSON Schema, and ctx.tools.register projects
//      definition.parameters as-is onto the wire);
//   4. headersFor gates plugin mode exactly like pi.ts's
//      before_provider_headers stamp: no x-bili-plugin headers until the
//      tools are registered, so round 1 rides the proxy's wire mode instead
//      of arriving tool-less. The conversation id comes from
//      ctx.agents.currentInitiator() — dsh's AsyncLocalStorage attribution,
//      read synchronously at request time inside the agent's driver chain;
//   5. /acp command (absorbs dsh-acp.ts, now session-bound when an
//      initiator is active, latest-session fallback otherwise).
// Native auto-compaction is disabled by the INSTALLER/LAUNCHER patch file
// (compaction-basic auto:false override) — not by this module. dsh has no
// compaction event hook to observe a manual /compact, so its boundary is
// left to the kernel's natural ingest diff (#395 gap, acceptable: manual
// /compact is rare and auto mode is off).

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defaultLogFile } from "../paths.js";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, noteRoutedOrigin, observeRoutedOrigin, type NativeInterceptState } from "./native-intercept.js";
import { fetchManifest, fetchProxyVersion, fetchStatus, fetchStatusLatest, forwardTool, reportRuntimeInfo, waitForProxyVersion, type ManifestTool } from "./shared.js";

export const name = "bili-native";
export const inject = ["tools", "commands", "agents"];

const RETRY_INTERVAL_MS = 10000;

type AgentLike = { session?: { id?: unknown } | undefined };
type ToolExec = { agent?: AgentLike | undefined; signal?: AbortSignal };

type ToolDefinition = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: ToolExec) => Promise<unknown>;
};

type CommandOutcome = { kind: "success" | "error"; text: string };

type PluginContext = {
    tools: { register: (definition: ToolDefinition) => unknown };
    commands: { register: (command: { name: string; description: string; handler: () => Promise<CommandOutcome> }) => unknown };
    agents: { currentInitiator?: () => AgentLike | undefined };
    // Runtime-info sources (#955), resolved via dynamic ctx.inject when the
    // host exposes them (both are core dsh services; optional so older dsh
    // builds or stripped hosts keep the plugin alive without model info).
    llm?: { resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number } | undefined> };
    agentDefaultModel?: { currentSelection?: () => { provider?: string; model?: string } | undefined };
    inject?: (deps: readonly string[], callback: (sub: PluginContext) => void) => unknown;
};

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNativeDsh(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_DSH");
}

/** Native posture (#809 precedence, opencode plan shape): kill-switches >
 *  attach (BILLION_CONTEXT_ATTACH ?? BILLION_CONTEXT_PROXY) > spawn. A preset
 *  BILLION_CONTEXT_PROXY is the `bili dsh` launcher (or a user attach):
 *  routing is already owned (proxy envs / settings overlay), so we attach —
 *  probe first (#983), stamp plugin headers, rewrite raw model URLs like
 *  spawn mode, and fall back to spawning when the attach target is dead
 *  (at startup, #983, or at runtime, #1130). */
export function planNativeDsh(env: NodeJS.ProcessEnv): { mode: "off" | "attach" | "spawn"; attachOrigin?: string } {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_DSH === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const attachOrigin = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attachOrigin !== undefined) return { mode: "attach", attachOrigin };
    return { mode: "spawn" };
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };

// One registration lifecycle per process. toolsReady is the ONLY gate for
// header stamping (pi.ts discipline): stamped headers flip the proxy into
// plugin mode, which suppresses wire tool injection — stamping before the
// local tools exist would send a tool-less request.
type RegisterState = { base: string | undefined; toolsReady: boolean; dead: boolean; retryAt: number; pending: Promise<void> | undefined };

const register: RegisterState = { base: undefined, toolsReady: false, dead: false, retryAt: 0, pending: undefined };

// Runtime-info cache (#955): the host's current model selection plus what
// ctx.llm resolved for it (contextWindow / defaultMaxTokens). Written by an
// async refresh; read synchronously by headersFor on every model request.
// Stale entries never leak across a model switch: refresh() keys off the
// LIVE selection, and a changed selection re-resolves before overwriting.
type ModelInfoCache = { provider: string; model: string; contextWindow?: number; maxOutput?: number };
const modelInfo: { cached?: ModelInfoCache; services?: { llm?: PluginContext["llm"]; agentDefaultModel?: PluginContext["agentDefaultModel"] }; refreshing: boolean } = { refreshing: false };

function selectionStillCurrent(svc: { agentDefaultModel?: PluginContext["agentDefaultModel"] }, provider: string, model: string): boolean {
    try {
        const live = svc.agentDefaultModel?.currentSelection?.();
        return live?.provider === provider && live?.model === model;
    } catch {
        return false;
    }
}

function refreshModelInfo(origin: string | undefined): void {
    const svc = modelInfo.services;
    if (svc === undefined || modelInfo.refreshing) return;
    let selection: { provider?: string; model?: string } | undefined;
    try {
        selection = svc.agentDefaultModel?.currentSelection?.();
    } catch {
        return;
    }
    const provider = selection?.provider;
    const model = selection?.model;
    if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) return;
    if (modelInfo.cached?.provider === provider && modelInfo.cached?.model === model) return;
    const resolve = svc.llm?.resolveModelInfo;
    if (resolve === undefined) {
        modelInfo.cached = { provider, model };
        return;
    }
    modelInfo.refreshing = true;
    void Promise.resolve()
        .then(() => resolve(provider, model))
        .then((info) => {
            // Commit only if the LIVE selection still matches what we
            // resolved: a model switch mid-resolve must not overwrite the
            // cache (and report) the OLD model's numbers — the next
            // headersFor refresh re-resolves the new one (review on #956).
            if (!selectionStillCurrent(svc, provider, model)) return;
            modelInfo.cached = {
                provider,
                model,
                contextWindow: typeof info?.context?.contextWindow === "number" && info.context.contextWindow > 0 ? Math.floor(info.context.contextWindow) : undefined,
                maxOutput: typeof info?.defaultMaxTokens === "number" && info.defaultMaxTokens > 0 ? Math.floor(info.defaultMaxTokens) : undefined,
            };
        })
        .catch(() => {
            if (!selectionStillCurrent(svc, provider, model)) return;
            // Resolution failed (transient catalog read, model offline): keep
            // the model id (usable for registry lookup) without window claims.
            modelInfo.cached = { provider, model };
        })
        .finally(() => {
            modelInfo.refreshing = false;
            const cached = modelInfo.cached;
            if (cached !== undefined && cached.provider === provider && cached.model === model && origin !== undefined) {
                void reportRuntimeInfo(origin, {
                    agent: "dsh",
                    model: cached.model,
                    contextWindow: cached.contextWindow,
                    maxOutput: cached.maxOutput,
                    source: "client-config",
                }).catch(() => {});
            }
        });
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// #1158: GUI hosts swallow process stderr, so a bootstrap failure that only
// console.errors vanishes together with the symptom it causes (silent
// direct-send degradation — zero interception, zero trace). Append the same
// fact to the shared bili.log in the proxy's own line shape, origin-marked
// [dsh-client], best-effort: a failed append must never break the host.
// appendFileSync reopens by path on every call, so the proxy's 10MB rotation
// (rename to .old) can't strand these writes on a renamed inode.
export function persistClientEvent(msg: string): void {
    try {
        const file = defaultLogFile();
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${new Date().toISOString()} [warn] [dsh-client] ${msg}\n`);
    } catch {
        // best-effort: logging must never break the host
    }
}

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "dsh" },
            { scriptPath: nativeProxyScriptPath() },
        );
        state.origin = handle.origin;
        register.base = handle.origin;
        // #983: do NOT write BILLION_CONTEXT_PROXY — dsh has no reader for it
        // here (tools use register.base, /acp uses it too), and a frozen env
        // turns a later same-process re-apply (cordis deactivate/reactivate)
        // into an unverified attach to a possibly-dead origin. Reuse across
        // lifecycles goes through ensureProxyRunning's instance discovery.
        return handle.origin;
    } catch (err) {
        const msg = `proxy bootstrap failed — model traffic goes direct (uncompressed): ${errMessage(err)}`;
        persistClientEvent(msg);
        console.error(`bili-native-dsh: ${msg}`);
        return undefined;
    }
}

// #983: test injection for the stale-attach fallback's spawn — production
// always uses the real bootstrap; tests substitute a recorder that returns
// an origin (side effects on register/state live in the fallback itself).
let _spawnForTest: (() => Promise<string | undefined>) | undefined;

/** Test hook: replace the fallback spawn (and the respawn self-heal's
 *  spawn) with a stub. Pass undefined to restore. */
export function _setSpawnForTest(fn?: () => Promise<string | undefined>): void {
    _spawnForTest = fn;
}

/** #983/#1130/#1365: the attached origin can go stale — at startup (the
 *  `bili dsh` launcher's proxy died, or a pre-#983 build froze its spawned
 *  origin into process.env and cordis re-activated this plugin in the same
 *  process) or at runtime (the owning launcher of a SHARED proxy exits while
 *  this session still rides it). Probe before trusting it: healthy → attach
 *  as planned. DEAD + routed-channel evidence (#1365: /bili/-baked model
 *  traffic was observed at some origin) → the session's context lives at
 *  THAT origin, so wait for the pinned target to come back (bounded by
 *  BILI_ATTACH_HEALTH_DEADLINE_MS) instead of spawning — a second instance
 *  would serve tools while the model channel stays pinned elsewhere and
 *  every bili tool call 404s against it (unrecoverable split). DEAD with no
 *  evidence after the grace window (BILI_ATTACH_EVIDENCE_GRACE_MS) → unfreeze
 *  the preset env and fall back to spawning our own proxy (instance
 *  discovery may find another healthy one first). Resolves to the origin the
 *  plugin should use — the (recovered) attach origin, the fallback origin,
 *  or undefined when nothing came up (register left base-less; maybeRetry
 *  keeps re-probing through the respawn hook). */
async function verifyAttachAndRecover(attachOrigin: string): Promise<string | undefined> {
    // #1365: routed evidence outranks the planned origin — probe where the
    // model channel actually points, not where the env says it should.
    const home = state.routedOrigin ?? attachOrigin;
    const version = await fetchProxyVersion(home).catch(() => undefined);
    if (version !== undefined) {
        // #1130: restore the interceptor's readyOrigin short-circuit — a
        // runtime recovery clears state.origin before re-probing, and a
        // transient blip must not leave it dangling.
        state.origin = home;
        register.base = home;
        return home;
    }
    const pinned = state.routedOrigin ?? (await observeRoutedOrigin(state));
    if (pinned !== undefined) {
        const back = await waitForProxyVersion(pinned);
        if (back !== undefined) {
            state.origin = back;
            register.base = back;
            persistClientEvent(`attach target ${pinned} recovered while waiting — attached, no second instance spawned`);
            console.log(`bili-native-dsh: attach target ${pinned} is healthy again — attached, no second instance spawned`);
            return back;
        }
        persistClientEvent(`attach target ${pinned} unreachable within the health deadline — NOT spawning a second instance (model channel is pinned to it); re-checks continue`);
        console.error(`bili-native-dsh: attach target ${pinned} is down and this process's model channel is pinned to it — refusing to spawn a second instance (bili tools would 404 against the other one). Start your proxy at ${pinned} or unset BILLION_CONTEXT_PROXY; bili keeps re-checking and self-heals when it comes back.`);
        register.base = undefined;
        register.toolsReady = false;
        return undefined;
    }
    persistClientEvent(`attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`);
    console.error(`bili-native-dsh: attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`);
    // Unfreeze: only the preset (BILLION_CONTEXT_PROXY) freezes future
    // plans; an explicit BILLION_CONTEXT_ATTACH never touches the preset.
    delete process.env.BILLION_CONTEXT_PROXY;
    state.attach = false;
    state.origin = undefined;
    markNativeHost(process.env, "dsh");
    const start = singleFlight(_spawnForTest ?? bootstrap);
    state.respawn = start;
    state.onGiveUp = () => {
        persistClientEvent("proxy respawn gave up — model traffic goes direct (uncompressed)");
        register.base = undefined;
        register.toolsReady = false;
    };
    const landed = start().then((origin) => {
        if (origin === undefined) {
            register.base = undefined;
            register.toolsReady = false;
            return undefined;
        }
        register.base = origin;
        state.origin = origin;
        return origin;
    });
    state.ready = landed;
    return landed;
}

function toolDefinition(tool: ManifestTool): ToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : String(value ?? "") }],
        },
        execute: async (args, exec) => {
            // #983: read the LIVE base — a respawn after a proxy death moves
            // the origin, and a captured base would keep firing at a dead port.
            const base = register.base;
            if (base === undefined) {
                throw new Error("bili: proxy is down — recovery in progress, retry shortly");
            }
            const sid = exec.agent?.session?.id;
            if (typeof sid !== "string" || sid.length === 0) {
                throw new Error(`bili tool ${tool.name} requires an owning agent session`);
            }
            return forwardTool(base, sid, tool.name, args, exec.signal);
        },
    };
}

async function registerTools(ctx: PluginContext): Promise<void> {
    if (register.pending !== undefined) return register.pending;
    const base = register.base;
    if (register.toolsReady || base === undefined) return;
    register.pending = (async () => {
        const tools = await fetchManifest(base, "anthropic");
        for (const tool of tools) ctx.tools.register(toolDefinition(tool));
        register.toolsReady = true;
    })()
        .catch((err: unknown) => {
            // Cordis deactivates the plugin context while the host tears down
            // (dsh --help, early CLI exits): every later register attempt hits
            // "cannot get required service ... in inactive context" and would
            // never succeed — stop retrying and stay quiet (dsh 0.1.5+).
            if (errMessage(err).includes("inactive context")) {
                register.dead = true;
                return;
            }
            register.retryAt = Date.now() + RETRY_INTERVAL_MS;
            console.error(`bili-native-dsh: manifest registration failed (${errMessage(err)}) — retrying; requests stay in wire mode until it succeeds`);
        })
        .finally(() => {
            register.pending = undefined;
        });
    return register.pending;
}

function maybeRetry(ctx: PluginContext): void {
    if (register.dead || register.toolsReady) return;
    if (register.pending !== undefined) return;
    if (Date.now() < register.retryAt) return;
    if (register.base === undefined) {
        // #983: a failed respawn (onGiveUp) left the register base-less —
        // without this branch the plugin never recovers and tools die for
        // good. Self-heal: re-arm the respawn every retry interval until a
        // proxy comes back (attach mode arms one since #1130).
        const respawn = state.respawn;
        if (respawn === undefined) return;
        register.retryAt = Date.now() + RETRY_INTERVAL_MS;
        void respawn()
            .then((origin) => {
                if (origin === undefined) return;
                register.base = origin;
                state.origin = origin;
                void registerTools(ctx).catch(() => {});
            })
            .catch(() => {});
        return;
    }
    void registerTools(ctx).catch(() => {});
}

// #1158 L2: three-state attribution for the takeover gate. The old bare catch
// swallowed currentInitiator() exceptions (disposed/closing agent scope) as
// plain "no attribution", making a throwing ALS boundary indistinguishable
// from a legitimate agentless lane — both went silent-direct behind one flat
// log line each. Three states + per-endpoint cumulative counts make the
// "dozens refused, one passed" distribution diagnosable at a glance.
type GateAttribution =
    | { state: "ok"; sid: string }
    | { state: "none"; initiatorPresent: boolean }
    | { state: "threw"; message: string };

function attributionOf(ctx: PluginContext): GateAttribution {
    try {
        const init = ctx.agents?.currentInitiator?.();
        const sid = init?.session?.id;
        if (typeof sid === "string" && sid.length > 0) return { state: "ok", sid };
        return { state: "none", initiatorPresent: init !== undefined && init !== null };
    } catch (err) {
        return { state: "threw", message: err instanceof Error ? err.message : String(err) };
    }
}

function sessionIdOf(ctx: PluginContext): string | undefined {
    const attr = attributionOf(ctx);
    return attr.state === "ok" ? attr.sid : undefined;
}

async function statusOutcome(ctx: PluginContext): Promise<CommandOutcome> {
    const base = register.base;
    if (!base) {
        return {
            kind: "error",
            text: "bili: no proxy detected — install via `bili plugin install dsh` or launch through `bili dsh`.",
        };
    }
    maybeRetry(ctx);
    const sid = sessionIdOf(ctx);
    const status = (sid !== undefined ? await fetchStatus(base, sid) : undefined) ?? (await fetchStatusLatest(base));
    const panel = status?.panel;
    if (status && typeof panel === "string" && panel.length > 0) {
        return { kind: "success", text: panel };
    }
    // #955: pre-first-request view — the proxy answers from the runtime-info
    // table this plugin populated at bootstrap, so /acp shows the client's
    // own model config before any model request has sized a session.
    const ri = status?.runtimeInfo as { model?: unknown; contextWindow?: unknown; maxOutput?: unknown; source?: unknown } | null | undefined;
    if (status !== undefined && ri !== null && ri !== undefined && (typeof ri.model === "string" || typeof ri.contextWindow === "number")) {
        const parts: string[] = [];
        if (typeof ri.model === "string") parts.push(`model=${ri.model}`);
        if (typeof ri.contextWindow === "number") parts.push(`window=${ri.contextWindow}`);
        if (typeof ri.maxOutput === "number") parts.push(`maxOut=${ri.maxOutput}`);
        const version = await fetchProxyVersion(base);
        return {
            kind: "success",
            text: `billion-context${version ? `@${version}` : ""} — proxy connected, compression armed. Runtime info${typeof ri.source === "string" ? ` (${ri.source})` : ""}: ${parts.join(" ")}. No model request yet; send one, then run /acp again for the full panel.`,
        };
    }
    const version = await fetchProxyVersion(base);
    if (version) {
        return {
            kind: "success",
            text: `billion-context@${version} — proxy connected, compression armed. No model request seen yet; send one, then run /acp again.`,
        };
    }
    return {
        kind: "error",
        text: `bili: proxy not reachable at ${base} — is the bili proxy still running?`,
    };
}

/** One `/acp-cache` invocation (#1146): same report as the acp_cache tool.
 *  Session-bound when the host exposes the current session id, else resolved
 *  through the status endpoint's latest-active fallback. The host's command
 *  API passes no arguments, so this lane always shows the default
 *  (summary-ledger) report — no `full`. */
async function cacheOutcome(ctx: PluginContext): Promise<CommandOutcome> {
    const base = register.base;
    if (!base) {
        return {
            kind: "error",
            text: "bili: no proxy detected — install via `bili plugin install dsh` or launch through `bili dsh`.",
        };
    }
    maybeRetry(ctx);
    const sid = sessionIdOf(ctx);
    let target = sid;
    if (target === undefined) {
        try {
            const status = await fetchStatusLatest(base);
            target = typeof status?.conversationId === "string" && status.conversationId.length > 0 ? status.conversationId : undefined;
        } catch {
            target = undefined;
        }
    }
    if (target === undefined) {
        let version: string | undefined;
        try {
            version = await fetchProxyVersion(base);
        } catch {
            version = undefined;
        }
        if (version) {
            return { kind: "success", text: `billion-context@${version} — proxy connected, compression armed. No model request seen yet; send one, then run /acp-cache again.` };
        }
        return {
            kind: "error",
            text: `bili: proxy not reachable at ${base} — is the bili proxy still running?`,
        };
    }
    try {
        return { kind: "success", text: await forwardTool(base, target, "acp_cache", {}) };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("no model request has arrived")) {
            return { kind: "success", text: "bili: no ACP session yet for this conversation (send a model request first, then run /acp-cache)" };
        }
        return { kind: "error", text: `bili: cache report failed: ${msg}` };
    }
}

export function apply(ctx: PluginContext): void {
    const plan = planNativeDsh(process.env);
    if (plan.mode === "off") return;

    if (plan.mode === "attach") {
        const attachOrigin = plan.attachOrigin;
        state.attach = true;
        state.origin = attachOrigin;
        register.base = attachOrigin;
        // #983: no env write (it freezes future plans); the origin is probed
        // first — a dead preset falls back to a spawned proxy, and tools only
        // register once the landed origin is known.
        if (attachOrigin !== undefined) {
            // #1130: arm the SAME probe+fallback for runtime death — the
            // attached proxy is usually owned by ANOTHER launcher that can
            // exit while this session rides it; the interceptor then re-probes
            // and falls back exactly like at startup.
            const start = singleFlight(() => verifyAttachAndRecover(attachOrigin));
            state.respawn = start;
            state.onGiveUp = () => {
                persistClientEvent("proxy respawn gave up — model traffic goes direct (uncompressed)");
                register.base = undefined;
                register.toolsReady = false;
            };
            // #1365: late routed evidence — if model traffic later arrives baked
            // against a DIFFERENT origin than the one we attached to, rebind the
            // tools there (the context lives where the models go). Fire-and-forget
            // with a liveness check: only converge on a target we can actually reach.
            state.onRoutedOriginObserved = (origin) => {
                if (register.base === origin) return;
                void fetchProxyVersion(origin).catch(() => undefined).then((version) => {
                    if (version === undefined || register.base === origin) return;
                    register.base = origin;
                    state.origin = origin;
                    const line = `bili-native-dsh: model channel pinned to ${origin} — rebinding bili tools there`;
                    persistClientEvent(line);
                    console.warn(line);
                });
            };
            state.ready = start();
        } else {
            state.ready = Promise.resolve(undefined);
        }
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        markNativeHost(process.env, "dsh");
        const start = singleFlight(bootstrap);
        state.respawn = start;
        state.onGiveUp = () => {
            persistClientEvent("proxy respawn gave up — model traffic goes direct (uncompressed)");
            register.base = undefined;
            register.toolsReady = false;
        };
        state.ready = start();
    }

    // #1158 L2: a refusal sends model traffic DIRECT. First refusal per
    // endpoint logs once; same-state refusals accumulate silently and re-print
    // only on an attribution STATE change (none↔threw), always carrying the
    // cumulative count — bounded noise (#1117 silence preserved) while a
    // "dozens refused, one passed" distribution becomes visible. The durable
    // copy goes through persistClientEvent: GUI hosts swallow stderr, which is
    // exactly how the reported zero-traffic case stayed invisible.
    const gateRefusals = new Map<string, { state: string; count: number }>();
    state.takeoverGate = (url) => {
        const attr = attributionOf(ctx);
        if (attr.state === "ok") return true;
        let key: string;
        try {
            const u = new URL(url);
            key = `${u.origin}${u.pathname}`;
        } catch {
            key = url;
        }
        const prev = gateRefusals.get(key);
        const count = (prev?.count ?? 0) + 1;
        const changed = prev !== undefined && prev.state !== attr.state;
        if (prev === undefined && gateRefusals.size >= 256) gateRefusals.clear();
        gateRefusals.set(key, { state: attr.state, count });
        if (prev === undefined || changed) {
            const reason =
                attr.state === "threw"
                    ? `currentInitiator() threw (${attr.message}) — agent scope disposed/closing mid-request?`
                    : attr.initiatorPresent
                        ? "initiator present but missing session id"
                        : "no active initiator attribution (agentless/background lane, third-party in-process caller, or stale attribution after host resume?)";
            const suffix = prev !== undefined ? ` (state ${prev.state}→${attr.state})` : "";
            const line = `bili-native-dsh: model request sent DIRECT (uncompressed) — takeover gate refused ${key}: ${reason} — refusals so far: ${count}${suffix}`;
            console.error(line);
            persistClientEvent(line);
        }
        return false;
    };

    // #1290: the isModelApiUrl gate (native-intercept) returns BEFORE the
    // takeover gate above, so a URL that is not a recognized model endpoint
    // (e.g. a third-party plugin's custom wire such as commandcode's
    // POST /alpha/generate) went direct with ZERO signal — contradicting the
    // #1158 promise. Surface each distinct unrouted endpoint once per process
    // through the durable channel GUI hosts need (persistClientEvent), bounded
    // like gateRefusals above.
    const unroutedEndpoints = new Set<string>();
    state.onUnroutedModelUrl = (rawUrl) => {
        let key: string;
        try {
            const u = new URL(rawUrl);
            key = `${u.origin}${u.pathname}`;
        } catch {
            key = rawUrl.split("?")[0];
        }
        if (unroutedEndpoints.has(key)) return;
        if (unroutedEndpoints.size >= 256) return;
        unroutedEndpoints.add(key);
        const line = `bili-native-dsh: request sent DIRECT (uncompressed) — ${key} is not a recognized model endpoint, so bili did not route it through the proxy. bili only compresses known protocol paths (/chat/completions, /v1/messages, /responses, …); a custom-wire endpoint needs its own support.`;
        console.error(line);
        persistClientEvent(line);
    };

    state.headersFor = (_url) => {
        maybeRetry(ctx);
        if (!register.toolsReady) return undefined;
        const sid = sessionIdOf(ctx);
        if (sid === undefined) return undefined;
        refreshModelInfo(register.base);
        const headers: Record<string, string> = { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid };
        if (modelInfo.cached !== undefined) {
            headers["x-bili-plugin-model"] = modelInfo.cached.model;
            if (modelInfo.cached.contextWindow !== undefined) headers["x-bili-plugin-context-window"] = String(modelInfo.cached.contextWindow);
            if (modelInfo.cached.maxOutput !== undefined) headers["x-bili-plugin-max-output"] = String(modelInfo.cached.maxOutput);
        }
        return headers;
    };

    // #1268: arm the interceptor's toolsReady gate — the first model request
    // holds until this resolves, so it stamps into plugin mode instead of
    // losing the boot race and silently riding wire mode. Resolves when the
    // FIRST registration attempt finishes (success OR failure): on failure
    // headersFor still returns undefined (wire mode, exactly as before) and a
    // later maybeRetry success flips stamping on without re-arming the gate.
    let resolveToolsGate!: () => void;
    state.toolsReady = new Promise<void>((r) => {
        resolveToolsGate = r;
    });
    if (register.toolsReady) {
        resolveToolsGate();
    } else {
        void state.ready.then(async (origin) => {
            if (origin !== undefined) await registerTools(ctx).catch(() => {});
            resolveToolsGate();
        });
    }

    // Runtime-info sources (#955): bind the model services when the host
    // exposes them (dynamic inject — a missing service must never keep the
    // whole plugin from activating), then report once so the proxy knows the
    // model config before the first request.
    if (typeof ctx.inject === "function") {
        try {
            ctx.inject(["llm", "agentDefaultModel"], (sub) => {
                modelInfo.services = { llm: sub.llm, agentDefaultModel: sub.agentDefaultModel };
                refreshModelInfo(register.base ?? state.origin);
            });
        } catch {
            // inject is best-effort: without the services the plugin just
            // runs header-less (wire mode + registry guess), as before.
        }
    } else if (ctx.llm !== undefined || ctx.agentDefaultModel !== undefined) {
        modelInfo.services = { llm: ctx.llm, agentDefaultModel: ctx.agentDefaultModel };
        refreshModelInfo(register.base ?? state.origin);
    }

    ctx.commands.register({
        name: "acp",
        description: "Show bili context-compression status",
        handler: () => statusOutcome(ctx),
    });
    ctx.commands.register({
        name: "acp-cache",
        description: "Prompt-cache reconciliation (same report as the acp_cache tool)",
        handler: () => cacheOutcome(ctx),
    });

    // node:test drives apply() directly with a mock ctx — never patch
    // globalThis.fetch from inside a test run.
    if (process.env.NODE_TEST_CONTEXT === undefined) installNativeFetchIntercept(state);
}

/** Test hook: reset the module-level registration lifecycle so suites can
 *  drive apply() repeatedly with a fresh mock ctx. */
export function _resetRegisterForTest(base: string | undefined): void {
    register.base = base;
    register.toolsReady = false;
    register.dead = false;
    register.retryAt = 0;
    register.pending = undefined;
    modelInfo.cached = undefined;
    modelInfo.services = undefined;
    modelInfo.refreshing = false;
}

export function _stateHeadersForTest(): ((url: string) => Record<string, string> | undefined) | undefined {
    return state.headersFor;
}

export function _stateTakeoverGateForTest(): ((url: string) => boolean) | undefined {
    return state.takeoverGate;
}

/** Test hook (#1268): expose the armed toolsReady gate so a suite can prove
 *  it resolves on the first registration attempt (success or failure). */
export function _stateToolsReadyForTest(): Promise<unknown> | undefined {
    return state.toolsReady;
}

/** Test hook: expose the armed runtime-recovery seam — the interceptor's
 *  death branch drives exactly this call (the fetch patch itself is covered
 *  in native-intercept.test.ts; under NODE_TEST_CONTEXT it is not installed). */
export function _stateRespawnForTest(): (() => Promise<string | undefined>) | undefined {
    return state.respawn;
}

/** Test hook (#1365): record routed-channel evidence exactly as the fetch
 *  patch would (the patch is not installed under NODE_TEST_CONTEXT). */
export function _noteRoutedForTest(url: string): void {
    noteRoutedOrigin(state, url);
}

/** Test hook (#1365): clear the sticky routed-channel evidence between scenarios. */
export function _resetRoutedForTest(): void {
    state.routedOrigin = undefined;
    state.onRoutedOriginObserved = undefined;
}
