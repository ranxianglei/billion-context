// Native dsh (deepseek-harness) cordis plugin (#941): full plugin-mode
// compression for dsh WITHOUT a launcher — bare `dsh` with this plugin
// installed via `bili plugin install dsh` (cordis.patch.yml entry) or
// injected by the `bili dsh` launcher through the same --patch overlay that
// used to carry dsh-acp.ts. Architecture mirrors pi-native.ts:
//   1. plan: attach (BILLION_CONTEXT_ATTACH ?? BILLION_CONTEXT_PROXY — the
//      launcher preset, or a user-supplied external proxy) or spawn the
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

import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, type NativeInterceptState } from "./native-intercept.js";
import { fetchManifest, fetchProxyVersion, fetchStatus, fetchStatusLatest, forwardTool, reportRuntimeInfo, type ManifestTool } from "./shared.js";

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
 *  stamp headers only, never rewrite, never spawn. */
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

/** Apply a freshly-resolved proxy origin to the in-process routing state.
 *  #983: deliberately does NOT write BILLION_CONTEXT_PROXY — that var is the
 *  external-preset attach channel (launcher/user), and freezing our own
 *  ephemeral port there makes a later apply() mis-plan a liveness-unchecked
 *  attach to a dead port (every tool fetch-fails until the host restarts). */
function adoptOrigin(origin: string): string {
    state.origin = origin;
    register.base = origin;
    return origin;
}

/** Give-up handler: the proxy died and the last respawn failed. Clear the
 *  proxy-owned routing state and arm the backoff so maybeRetry can re-bootstrap
 *  and re-register once the proxy recovers (#983) instead of bricking until the
 *  host restarts. */
function giveUp(): void {
    delete process.env.BILLION_CONTEXT_PROXY;
    register.base = undefined;
    register.toolsReady = false;
    register.retryAt = Date.now() + RETRY_INTERVAL_MS;
}

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false },
            { scriptPath: nativeProxyScriptPath() },
        );
        return adoptOrigin(handle.origin);
    } catch (err) {
        console.error(`bili-native-dsh: proxy bootstrap failed — model traffic goes direct (uncompressed): ${errMessage(err)}`);
        return undefined;
    }
}

function toolDefinition(base: string, tool: ManifestTool): ToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : String(value ?? "") }],
        },
        execute: async (args, exec) => {
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
        for (const tool of tools) ctx.tools.register(toolDefinition(base, tool));
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

async function reestablishBase(): Promise<string | undefined> {
    const respawn = state.respawn;
    if (respawn === undefined) return undefined;
    await respawn();
    return register.base;
}

function maybeRetry(ctx: PluginContext): void {
    if (register.dead || register.toolsReady) return;
    if (register.pending !== undefined) return;
    if (Date.now() < register.retryAt) return;
    if (register.base !== undefined) {
        void registerTools(ctx).catch(() => {});
        return;
    }
    // #983: base was cleared by onGiveUp after a failed respawn, and every
    // caller above bails on base===undefined — so without this branch the tools
    // stay unregistered until the host restarts. Re-run the single-flight
    // bootstrap so a recovered proxy re-registers them; a failed re-bootstrap
    // re-arms the backoff (armed in onGiveUp).
    void reestablishBase()
        .then((base) => {
            if (base === undefined) {
                register.retryAt = Date.now() + RETRY_INTERVAL_MS;
                return;
            }
            return registerTools(ctx);
        })
        .catch(() => {
            register.retryAt = Date.now() + RETRY_INTERVAL_MS;
        });
}

function sessionIdOf(ctx: PluginContext): string | undefined {
    try {
        const sid = ctx.agents?.currentInitiator?.()?.session?.id;
        return typeof sid === "string" && sid.length > 0 ? sid : undefined;
    } catch {
        return undefined;
    }
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

export function apply(ctx: PluginContext): void {
    const plan = planNativeDsh(process.env);
    if (plan.mode === "off") return;

    if (plan.mode === "attach") {
        state.attach = true;
        state.origin = plan.attachOrigin;
        state.ready = Promise.resolve(plan.attachOrigin);
        register.base = plan.attachOrigin;
        process.env.BILLION_CONTEXT_PROXY = plan.attachOrigin;
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        markNativeHost(process.env, "dsh");
        const start = singleFlight(bootstrap);
        state.respawn = start;
        state.onGiveUp = giveUp;
        state.ready = start();
    }

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

    void state.ready.then((origin) => {
        if (origin !== undefined) void registerTools(ctx).catch(() => {});
    });

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

/** Test hook (#983): wire the spawn-mode recovery state (respawn + give-up)
 *  without spawning a proxy or patching fetch, so suites can drive the
 *  give-up → re-bootstrap → re-register cycle and assert it recovers. */
export function _armSpawnRecoveryForTest(respawn: () => Promise<string | undefined>): { giveUp: () => void; clearBackoff: () => void } {
    state.respawn = respawn;
    state.onGiveUp = giveUp;
    return {
        giveUp,
        clearBackoff: () => {
            register.retryAt = 0;
        },
    };
}

/** Test hook (#983): expose the origin-adoption side effect so a suite can
 *  assert a self-spawned origin is routed in-process WITHOUT freezing
 *  BILLION_CONTEXT_PROXY (the removed write that caused #983). */
export function _adoptOriginForTest(origin: string): string {
    return adoptOrigin(origin);
}
