// Native opencode mode (#820 opencode line; npm-package design tracked in
// #809): the package-installed OpenCode 2.x plugin bootstraps its own proxy —
// the pi pattern (#519/#706), adapted to opencode's egress seam. Flow at
// plugin load:
//   1. spawn the package's own proxy (`dist/index.js start`, ephemeral port,
//      parent-pid watchdog = this opencode process) via ensureProxyRunning —
//      a healthy compatible instance is ATTACHED, not doubled;
//   2. register an http.request hook that rewrites model-API URLs to
//      `<proxy>/bili/<full-upstream-url>` and stamps nothing else — header
//      stamping / tools / compaction reporting all reuse the shared V2 setup
//      (opencode-v2.ts), which detects the proxy through the env var set in
//      step 1;
//   3. set BILLION_CONTEXT_PROXY after bootstrap so tool execute() and the
//      compaction reporter find the proxy through their existing env path.
//
// Why URL rewrite instead of pi's global fetch patch: opencode's plugins have
// no fetch seam they can patch — the only observed egress hook is http.request
// with the outgoing fetch Request at e.request. WHATWG Request.url is
// read-only at runtime (verified live on 2.0.x, #810), so the request REFERENCE
// is replaced with a new Request to `<proxy>/bili/<url>` carrying the same
// method/headers/body.
//
// Liveness gate (differs from pi by design): an http.request hook CANNOT
// observe send failures (the host swallows them; #809 verification list), so
// unlike pi's post-failure respawn, each outgoing request checks
// `/__bili/health` of the current origin and respawns if dead. The verdict is
// TTL-cached per origin (#928): steady-state requests reuse the last result
// and re-probe only after HEALTH_PROBE_TTL_MS, so a healthy proxy costs no
// per-request RTT and a dead one is found within at most one TTL. If no origin
// can be made healthy the request goes DIRECT (uncompressed) and a one-time
// stderr warning fires — recovery is automatic once a proxy is healthy again
// (no permanent latch; re-checked at least every TTL). Bootstrap retries are
// rate-limited to one attempt per RESPAWN_COOLDOWN_MS so a persistently
// failing spawn does not become a per-request spawn storm.
//
// Skipped when opted out (BILI_NATIVE_OPENCODE=0 / BILLION_CONTEXT_PLUGIN=0)
// or when a `bili` /bili/ launch owns routing (BILI_PROVIDER_REWRITES). A
// preset BILLION_CONTEXT_PROXY is treated as an EXTERNAL attach target
// (probe + rewrite + stamp) instead of a stand-down — see planNativeOpencode.
//
// Deployment: OpenCode 2.x `plugin` entries must be DIRECTORIES whose index.js
// is the entrypoint (bare file paths are rejected, #754 probe) — `bili plugin
// install opencode` writes <configDir>/plugins/billion-context/index.js
// re-exporting this entry (same wrapper shape the launcher builds,
// src/launcher.ts prepareOpencodeHttpRewrite).
//
// OpenCode 1.x loads the SAME entry through `.server(ctx)` (hooks object).
// V1 runtime facts (probed on 1.14.46, ~/projects/opencode-stable):
//   - config hook: receives the SHARED cached config object (Config.get →
//     InstanceState.use) — mutating provider.<id>.options.baseURL persists
//     for the process lifetime, no file writes needed. Providers WITHOUT an
//     explicit baseURL (SDK defaults) are caught by the global fetch patch
//     installed in server() (see installNativeFetchIntercept below).
//   - "chat.headers": per-LLM-request header mutation — the V1 equivalent of
//     V2's stampHeaders (x-bili-plugin + conversation id).
//   - tool: { [name]: { description, args, execute } } registers native tools;
//     args must be REAL zod fields (registry wraps them with its own
//     z.object(...).safeParse) — hence zod is a runtime dependency, lazily
//     imported below. Same tool set/schemas as V2 (ACP_TOOLS_OPENAI),
//     converted JSON-schema → zod. When zod cannot be resolved (dist copied
//     without node_modules) the plugin degrades to proxy mode: no headers, no
//     tools — the proxy injects wire tools, compression still works.
//   - command.execute.before + ctx.client.session.prompt: /acp command
//     (shared factory opencode-acp-command.ts).
//   - "experimental.session.compacting" exists but config compaction.auto=false
//     (written by the config hook, same as the launcher/installer) is the
//     owner-switch; no compaction-prompt surgery needed.

import { ACP_TOOLS_OPENAI } from "../compress-tool.js";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST, unwrapUpstream, wrapUpstream } from "../launcher.js";
import { createAcpCommandHooks, showAcpText } from "./opencode-acp-command.js";
import { markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, singleFlight } from "./native-bootstrap.js";
import { createLiveOriginResolver, installNativeFetchIntercept, isModelApiUrl, noteRoutedOrigin, observeRoutedOrigin, readyOrigin, replaceRequestTarget, routedBiliModelUrl, type LiveOriginResolverDeps, type NativeInterceptState } from "./native-intercept.js";
import { createOpencodeV2Setup, type V2HttpRequestEvent, type V2State } from "./opencode-v2.js";
import { fetchProxyVersion, postIdentityRegister, reportRuntimeInfoOnChange, waitForProxyVersion } from "./shared.js";
import { callLegacyAcpConfig, isLegacyAcpSession, loadLegacyAcp, type LegacyAcpModule } from "./opencode-legacy.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNativeOpencode(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_OPENCODE");
}

/** Decide this process's native posture (#809). Precedence kill-switch >
 *  /bili/ rewrite launch > attach > spawn. A preset BILLION_CONTEXT_PROXY is
 *  an ATTACH target, not a stand-down: the pseudo-attach hole (preset env +
 *  bare opencode) used to disarm routing entirely while tools still found the
 *  proxy through the env — model traffic went direct, the proxy never saw the
 *  session, and every tool forward 404'd. Attach keeps the user's intent
 *  ("route through THIS proxy") and matches BILLION_CONTEXT_ATTACH semantics
 *  (probe + rewrite + stamp); explicit BILLION_CONTEXT_ATTACH wins when both
 *  are set. A /bili/ launch (BILI_PROVIDER_REWRITES) still stands us down —
 *  its URLs are already proxy-shaped and isModelApiUrl skips them. */
export function planNativeOpencode(env: NodeJS.ProcessEnv): { mode: "off" | "attach" | "spawn"; attachOrigin?: string } {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_OPENCODE === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const attachOrigin = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attachOrigin !== undefined) return { mode: "attach", attachOrigin };
    return { mode: "spawn" };
}

export type OpencodeNativeRouteDeps = LiveOriginResolverDeps;

/** Build the native-mode route callback consumed by createOpencodeV2Setup.
 *  #1135: spawn and attach share ONE liveness gate — attach arms
 *  state.respawn (verifyAttachAndRecover), so a dead external proxy is
 *  re-probed and, when truly gone, replaced by a self-spawned proxy instead
 *  of failing every request forever (the old fail-closed branch is gone). */
export function createNativeRoute(state: NativeInterceptState, deps: OpencodeNativeRouteDeps = {}): (e: V2HttpRequestEvent, s: V2State) => Promise<void> {
    const resolveLive = createLiveOriginResolver(state, deps);
    let warned = false;
    return async (e, s) => {
        const url = typeof e.request?.url === "string" ? e.request.url : undefined;
        if (url === undefined) return;
        // #1365: routed URLs are skipped by isModelApiUrl by design — record
        // the pinned model channel before that gate so attach recovery can see it.
        if (routedBiliModelUrl(url) !== undefined) noteRoutedOrigin(state, url);
        if (!isModelApiUrl(url)) return;

        const target = await resolveLive();
        if (target === undefined) {
            if (!warned) {
                warned = true;
                console.error("bili-native-opencode: proxy unavailable — model requests go direct (uncompressed)");
            }
            s.proxyBase = undefined;
            return;
        }
        warned = false;
        s.proxyBase = target;
        replaceRequestTarget(e, `${target}/bili/${url}`);
    };
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "opencode" },
            { scriptPath: nativeProxyScriptPath() },
        );
        state.origin = handle.origin;
        process.env.BILLION_CONTEXT_PROXY = handle.origin;
        return handle.origin;
    } catch (err) {
        console.error(`bili-native-opencode: proxy bootstrap failed — model traffic goes direct (uncompressed): ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

let _spawnForTest: (() => Promise<string | undefined>) | undefined;

/** Test hook: replace the attach-fallback spawn (and the respawn self-heal's
 *  spawn) with a stub. Pass undefined to restore. */
export function _setSpawnForTest(fn?: () => Promise<string | undefined>): void {
    _spawnForTest = fn;
}

/** #1135/#1365: the attached origin can go stale — at startup (the owning
 *  launcher exited before this process started) or at runtime (it exits while
 *  this session still rides the shared proxy, #1130). Probe before trusting
 *  it: healthy → keep attaching (a transient blip costs nothing — the session
 *  never migrates). DEAD + routed-channel evidence (#1365: /bili/-baked model
 *  traffic was observed at some origin) → the session's context lives at THAT
 *  origin, so wait for the pinned target to come back (bounded by
 *  BILI_ATTACH_HEALTH_DEADLINE_MS) instead of spawning — a second instance
 *  would serve tools while the model channel stays pinned elsewhere and every
 *  bili tool call 404s against it (unrecoverable split); the env is preserved
 *  so the user's target stays declared. DEAD with no evidence after the grace
 *  window (BILI_ATTACH_EVIDENCE_GRACE_MS) → unfreeze the preset env and fall
 *  back to spawning our own proxy (instance discovery may find another
 *  healthy one first), re-arming respawn as a pure spawn for subsequent
 *  deaths. Resolves to the origin the client should use — the (recovered)
 *  attach origin, the fallback origin, or undefined when nothing came up. */
export async function verifyAttachAndRecover(attachOrigin: string): Promise<string | undefined> {
    // #1365: routed evidence outranks the planned origin — probe where the
    // model channel actually points, not where the env says it should.
    const home = state.routedOrigin ?? attachOrigin;
    const version = await fetchProxyVersion(home).catch(() => undefined);
    if (version !== undefined) {
        // Restore the readyOrigin short-circuit — a runtime recovery clears
        // state.origin before re-probing, and a transient blip must not leave
        // it dangling.
        state.origin = home;
        process.env.BILLION_CONTEXT_PROXY = home;
        return home;
    }
    const pinned = state.routedOrigin ?? (await observeRoutedOrigin(state));
    if (pinned !== undefined) {
        const back = await waitForProxyVersion(pinned);
        if (back !== undefined) {
            state.origin = back;
            process.env.BILLION_CONTEXT_PROXY = back;
            console.log(`bili-native-opencode: attach target ${pinned} is healthy again — attached, no second instance spawned`);
            return back;
        }
        console.error(`bili-native-opencode: attach target ${pinned} is down and this process's model channel is pinned to it — refusing to spawn a second instance (bili tools would 404 against the other one). Start your proxy at ${pinned} or unset BILLION_CONTEXT_PROXY; bili keeps re-checking and self-heals when it comes back.`);
        state.origin = undefined;
        return undefined;
    }
    console.error(`bili-native-opencode: attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`);
    delete process.env.BILLION_CONTEXT_PROXY;
    state.attach = false;
    state.origin = undefined;
    const start = singleFlight(_spawnForTest ?? bootstrap);
    state.respawn = start;
    // Publish whatever origin lands on BOTH the shared state and the env —
    // env readers (compaction reporter, /acp status) must never disagree with
    // what the route resolves, whoever produced the origin.
    const landed = start().then((o) => {
        if (o !== undefined) {
            state.origin = o;
            process.env.BILLION_CONTEXT_PROXY = o;
        }
        return o;
    });
    state.ready = landed;
    return landed;
}

const plan = planNativeOpencode(process.env);

/** Wire the shared intercept state for the planned mode. Attach mode arms
 *  even under NODE_TEST_CONTEXT (it installs no global patches and spawns
 *  nothing while the target is healthy, so tests can drive it directly);
 *  spawn mode stays test-guarded because bootstrap forks a real proxy. */
export function armNativeOpencode(p: typeof plan): void {
    if (p.mode === "off") return;
    markNativeHost(process.env, "opencode");
    if (p.mode === "attach") {
        state.attach = true;
        const attachOrigin = p.attachOrigin;
        if (attachOrigin !== undefined) {
            // #1135: arm the SAME probe+fallback for runtime death — the
            // attached proxy is usually owned by ANOTHER launcher that can
            // exit while this session rides it; the resolver then re-probes
            // and falls back exactly like at startup. No synchronous
            // state.origin freeze: V1's server() awaits state.ready so hooks
            // bind to the LANDED origin, and the V2 route resolves live per
            // request regardless.
            process.env.BILLION_CONTEXT_PROXY = attachOrigin;
            const start = singleFlight(() => verifyAttachAndRecover(attachOrigin));
            state.respawn = start;
            state.onGiveUp = () => {
                delete process.env.BILLION_CONTEXT_PROXY;
            };
            // #1365: late routed evidence — if model traffic later arrives baked
            // against a DIFFERENT origin than the one we attached to, rebind there
            // (the context lives where the models go). Fire-and-forget with a
            // liveness check: only converge on a target we can actually reach.
            state.onRoutedOriginObserved = (origin) => {
                if (state.origin === origin) return;
                void fetchProxyVersion(origin).catch(() => undefined).then((version) => {
                    if (version === undefined || state.origin === origin) return;
                    state.origin = origin;
                    process.env.BILLION_CONTEXT_PROXY = origin;
                    console.warn(`bili-native-opencode: model channel pinned to ${origin} — rebinding bili tools there`);
                });
            };
            state.ready = start();
        } else {
            state.ready = Promise.resolve(undefined);
        }
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        const start = singleFlight(bootstrap);
        state.respawn = start;
        state.onGiveUp = () => {
            delete process.env.BILLION_CONTEXT_PROXY;
        };
        state.ready = start();
    }
}

if (plan.mode !== "off") armNativeOpencode(plan);

/** Test hook: expose the armed runtime-recovery seam (mirrors dsh-native). */
export function _stateRespawnForTest(): (() => Promise<string | undefined>) | undefined {
    return state.respawn;
}

/** Test hook (#1365): record routed-channel evidence without the fetch patch. */
export function _noteRoutedForTest(url: string): void {
    noteRoutedOrigin(state, url);
}

/** Test hook: reset the module-level state in place (closures capture the
 *  object reference) so suites can drive armNativeOpencode repeatedly. */
export function _resetNativeStateForTest(): void {
    state.attach = undefined;
    state.origin = undefined;
    state.routedOrigin = undefined;
    state.onRoutedOriginObserved = undefined;
    state.respawn = undefined;
    state.onGiveUp = undefined;
    state.ready = Promise.resolve(undefined);
    _spawnForTest = undefined;
    delete process.env.BILLION_CONTEXT_PROXY;
}

// ———— OpenCode 1.x native surface (V1 `.server()`) ————————————————————

type ZodLike = typeof import("zod");

interface V1ToolContext {
    sessionID: string;
    messageID?: string;
    agent?: string;
    abort?: AbortSignal;
}

interface V1Tool {
    description: string;
    args: Record<string, unknown>;
    execute: (args: Record<string, unknown>, ctx: V1ToolContext) => Promise<string>;
}

export interface V1ProviderOptions {
    baseURL?: unknown;
    [key: string]: unknown;
}

export interface V1ModelLimit {
    context?: unknown;
    [key: string]: unknown;
}

export interface V1ModelDef {
    limit?: V1ModelLimit | undefined;
    [key: string]: unknown;
}

export interface V1ProviderDef {
    options?: V1ProviderOptions | undefined;
    models?: Record<string, V1ModelDef | undefined> | undefined;
    [key: string]: unknown;
}

export interface V1Config {
    provider?: Record<string, V1ProviderDef | undefined> | undefined;
    command?: Record<string, import("./opencode-acp-command.js").OpencodeCommandConfig>;
    compaction?: unknown;
    [key: string]: unknown;
}

export interface V1ChatHeadersInput {
    sessionID: string;
    agent?: string;
    model?: { providerID?: unknown; id?: unknown };
}

export interface V1Hooks {
    config?: (input: V1Config) => Promise<void>;
    "chat.headers"?: (input: V1ChatHeadersInput, output: { headers: Record<string, string> }) => Promise<void>;
    "command.execute.before"?: (input: { command: string; sessionID: string; arguments?: string }, output?: { parts: unknown[] }) => Promise<void>;
    tool?: Record<string, V1Tool>;
    event?: (input: { event?: unknown }) => Promise<void>;
    "experimental.chat.system.transform"?: (input: { sessionID?: string }, output: { system?: unknown[] }) => Promise<void>;
    "experimental.chat.messages.transform"?: (input: unknown, output: { messages?: unknown }) => Promise<void>;
    "experimental.text.complete"?: (input: { sessionID: string }, output: { text?: unknown }) => Promise<void>;
}

export interface V1PluginContext {
    client?: import("./opencode-acp-command.js").OpencodeClient;
    directory?: string;
}

/** JSON-schema (ACP_TOOLS_OPENAI parameters) → zod raw shape. Only the shapes
 *  our own tools use; anything exotic degrades to z.any() — the proxy
 *  re-validates server-side anyway (parseCompressArgs), client zod is just
 *  the host's parameter gate. */
export function jsonSchemaToZodShape(schema: unknown, z: ZodLike): Record<string, unknown> {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return {};
    const props = (schema as { properties?: unknown }).properties;
    if (props === null || typeof props !== "object" || Array.isArray(props)) return {};
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
        out[key] = jsonSchemaFieldToZod(raw, z);
    }
    return out;
}

function jsonSchemaFieldToZod(raw: unknown, z: ZodLike): unknown {
    if (raw === null || typeof raw !== "object") return z.any();
    const spec = raw as { type?: unknown; enum?: unknown; items?: unknown; anyOf?: unknown; description?: unknown };
    if (Array.isArray(spec.enum) && spec.enum.length > 0 && spec.enum.every((v) => typeof v === "string")) {
        return z.enum(spec.enum as [string, ...string[]]);
    }
    switch (spec.type) {
        case "string":
            return typeof spec.description === "string" ? z.string().describe(spec.description) : z.string();
        case "number":
            return z.number();
        case "boolean":
            return z.boolean();
        case "array": {
            const item = jsonSchemaFieldToZod(spec.items, z);
            return item === undefined ? z.array(z.any()) : z.array(item as never);
        }
        default:
            // object / anyOf / unknown — accept anything; the proxy validates
            return z.any();
    }
}

/** Rewrite provider baseURLs to `<origin>/bili/<url>` (idempotent) and flip
 *  compaction.auto off. Providers without an explicit baseURL keep their SDK
 *  default (traffic goes direct) — V1 has no request seam to catch those. */
export function rewriteV1Providers(cfg: V1Config, origin: string): number {
    const providers = cfg.provider;
    if (providers === null || typeof providers !== "object") return 0;
    let rewritten = 0;
    for (const entry of Object.values(providers)) {
        const options = entry?.options;
        if (options === null || typeof options !== "object") continue;
        const base = options.baseURL;
        if (typeof base !== "string" || base.trim().length === 0) continue;
        if (!/^https?:\/\//i.test(base)) continue;
        // unwrapUpstream strips ANY existing `<…>/bili/` prefix (stale wrap
        // from another proxy origin included), wrapUpstream re-adds ours.
        const next = wrapUpstream(origin, unwrapUpstream(base));
        if (next === base) continue;
        options.baseURL = next;
        rewritten++;
    }
    const compaction = cfg.compaction;
    cfg.compaction = {
        ...(compaction !== null && typeof compaction === "object" && !Array.isArray(compaction) ? (compaction as Record<string, unknown>) : {}),
        auto: false,
    };
    return rewritten;
}

/** Provider-declared model windows (`provider.<id>.models.<m>.limit.context`) as a `${id}/${m}` map.
 *  V1 has no catalog seam (cf. V2 `ctx.catalog.model.list()`), so config is the only window source;
 *  non-finite/non-positive values are dropped so a partial table stays unstamped rather than fabricated. */
export function extractV1Windows(cfg: V1Config): Map<string, number> {
    const map = new Map<string, number>();
    const providers = cfg.provider;
    if (providers === null || typeof providers !== "object") return map;
    for (const [pid, entry] of Object.entries(providers)) {
        const models = entry?.models;
        if (models === null || typeof models !== "object") continue;
        for (const [mid, model] of Object.entries(models)) {
            const c = model?.limit?.context;
            if (typeof c === "number" && Number.isFinite(c) && c > 0) map.set(`${pid}/${mid}`, Math.floor(c));
        }
    }
    return map;
}

/** Configured max output per model (runtime-info #955): opencode's provider
 *  models declare `limit.output` — the ceiling the client will actually
 *  request. Same shape as extractV1Windows. */
export function extractV1Outputs(cfg: V1Config): Map<string, number> {
    const map = new Map<string, number>();
    const providers = cfg.provider;
    if (providers === null || typeof providers !== "object") return map;
    for (const [pid, entry] of Object.entries(providers)) {
        const models = entry?.models;
        if (models === null || typeof models !== "object") continue;
        for (const [mid, model] of Object.entries(models)) {
            const o = model?.limit?.output;
            if (typeof o === "number" && Number.isFinite(o) && o > 0) map.set(`${pid}/${mid}`, Math.floor(o));
        }
    }
    return map;
}

export interface V1NativeDeps {
    /** zod module (tests inject; runtime lazy-imports "zod"). */
    z?: ZodLike;
    /** Tool forwarder (tests inject; runtime POSTs /__bili/plugin/tool). */
    forward?: (origin: string, conversationId: string, tool: string, args: unknown) => Promise<string>;
    /** Absorbed opencode-acp for legacy sessions (#920); when present its DCP
     *  tool slots serve BOTH lanes (legacy → acp executor, new → forward). */
    legacy?: LegacyAcpModule;
    /** Legacy-session predicate (tests inject; runtime = state file exists). */
    isLegacy?: (sessionId: string | undefined) => boolean;
    /** Derived-report retry cooldown after a failed register (tests inject a
     *  short window; runtime default 10s, same order as pi's RETRY_INTERVAL). */
    derivedRetryMs?: number;
    log?: (msg: string) => void;
}

/** Build the V1 hooks for a RESOLVED proxy origin. `deps.z` present → plugin
 *  mode (tools + header stamping); absent → proxy mode (rewrite only, the
 *  proxy injects wire tools). Exported for tests; the `server` export below
 *  wires the real bootstrap + zod. */
function lastSessionFromMessages(messages: unknown): string | undefined {
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const info = (messages[i] as { info?: { sessionID?: unknown } } | undefined)?.info;
        if (typeof info?.sessionID === "string") return info.sessionID;
    }
    return undefined;
}

// #1135: dynamic origin getter instead of a captured constant — after a
// runtime death+recovery the live origin changes, and hooks bound to the
// startup origin would keep forwarding tools to the dead port while traffic
// had already recovered. A transient undefined (recovery window / give-up)
// skips proxy-dependent work instead of pointing at a dead origin.
export function createV1ServerHooks(getOrigin: () => string | undefined, ctx: V1PluginContext, deps: V1NativeDeps = {}): V1Hooks {
    const acp = createAcpCommandHooks(getOrigin, ctx);
    const legacy = deps.legacy;
    const isLegacy = deps.isLegacy ?? isLegacyAcpSession;
    const log = deps.log ?? ((msg: string) => console.log(msg));
    let windows = new Map<string, number>();
    let outputs = new Map<string, number>();
    // #1362: derived-session inheritance for the V1 lane (same register
    // channel as pi/omp, #1333). opencode mints a fresh session id per
    // persona/subagent (#1102); a child's SDK session info declares its
    // parent (session.get → data.parentID). Report each derived session once
    // so the proxy records a read-only parent link (decompress/search_context
    // fall back to the parent chain — no state is copied). Fire-and-forget
    // with a per-sid cooldown after failure: a missed report degrades to "no
    // inheritance", never to a broken request; root sessions send nothing.
    const derivedReported = new Map<string, "pending" | "done" | "none">();
    const derivedRetryAt = new Map<string, number>();
    const derivedRetryMs = deps.derivedRetryMs ?? 10000;
    const maybeReportDerived = (base: string, sid: string): void => {
        const get = ctx.client?.session?.get;
        if (!sid || typeof get !== "function") return;
        if (derivedReported.has(sid)) return;
        const retryAt = derivedRetryAt.get(sid);
        if (retryAt !== undefined && Date.now() < retryAt) return;
        derivedReported.set(sid, "pending");
        void (async () => {
            try {
                const res = await get({ path: { id: sid } });
                const parent = res?.data?.parentID;
                if (typeof parent === "string" && parent.length > 0 && parent !== sid) {
                    await postIdentityRegister(base, sid, "opencode", parent);
                    derivedReported.set(sid, "done");
                } else {
                    derivedReported.set(sid, "none");
                }
            } catch {
                derivedReported.delete(sid);
                derivedRetryAt.set(sid, Date.now() + derivedRetryMs);
            }
        })();
    };
    const hooks: V1Hooks = {
        config: async (cfg) => {
            if (legacy?.configHook !== undefined) {
                await callLegacyAcpConfig(legacy.configHook, cfg);
            }
            await acp.config?.(cfg);
            const o = getOrigin();
            if (o !== undefined) {
                const n = rewriteV1Providers(cfg, o);
                if (n > 0) log(`[bili-opencode-native] v1: rewrote ${n} provider baseURL(s) -> ${o}/bili/`);
            }
            windows = extractV1Windows(cfg);
            outputs = extractV1Outputs(cfg);
        },
        "command.execute.before": async (input, output) => {
            if ((input.command === "acp" || input.command === "dcp") && legacy?.commandHook !== undefined && isLegacy(input.sessionID)) {
                await legacy.commandHook(input, output);
                return;
            }
            // Legacy sessions ride x-bili-plugin-bypass — their traffic never
            // enters this proxy's compression state, so the cache report has
            // nothing to read. Say so instead of surfacing a raw 404.
            if (input.command === "acp-cache" && isLegacy(input.sessionID)) {
                await showAcpText(ctx, input.sessionID, "bili: /acp-cache is unavailable for this legacy DCP session (#920) — its traffic bypasses this proxy's compression state; start a new session for the cache report");
                throw new Error("__BILI_ACP_HANDLED__");
            }
            await acp["command.execute.before"]?.(input);
        },
    };
    if (legacy !== undefined) {
        // Legacy lane (#920): route acp's own transforms to legacy sessions
        // only — new sessions never enter acp's registry (no adoption).
        const sys = legacy.hooks["experimental.chat.system.transform"];
        if (typeof sys === "function") {
            hooks["experimental.chat.system.transform"] = async (input, output) => {
                if (!isLegacy(input.sessionID)) return;
                await (sys as (i: unknown, o: unknown) => Promise<void>)(input, output);
            };
        }
        const msgT = legacy.hooks["experimental.chat.messages.transform"];
        if (typeof msgT === "function") {
            hooks["experimental.chat.messages.transform"] = async (input, output) => {
                if (!isLegacy(lastSessionFromMessages(output?.messages))) return;
                await (msgT as (i: unknown, o: unknown) => Promise<void>)(input, output);
            };
        }
        const textC = legacy.hooks["experimental.text.complete"];
        if (typeof textC === "function") {
            hooks["experimental.text.complete"] = async (input, output) => {
                if (!isLegacy(input.sessionID)) return;
                await (textC as (i: unknown, o: unknown) => Promise<void>)(input, output);
            };
        }
        // Event hook carries no session (acp uses it only for compress timing
        // on message.part.updated) — pass through ungated, state-independent.
        const evt = legacy.hooks.event;
        if (typeof evt === "function") {
            hooks.event = evt as V1Hooks["event"];
        }
    }
    if (deps.z !== undefined || legacy !== undefined) {
        hooks["chat.headers"] = async (input, output) => {
            if (isLegacy(input.sessionID)) {
                // Legacy sessions run through absorbed acp; the proxy must
                // forward their traffic verbatim (no injection, no binding).
                output.headers["x-bili-plugin-bypass"] = "1";
                return;
            }
            const base = getOrigin();
            // No live proxy: traffic goes direct — stamping would leak the
            // conversation id to a raw upstream and mark plugin mode for a
            // request no bili proxy will ever see.
            if (base === undefined) return;
            output.headers["x-bili-plugin"] = "opencode";
            output.headers["x-bili-plugin-conversation"] = input.sessionID;
            // #1102: opencode mints one session id per persona (task-tool
            // subagents get fresh child ids), so instruction drift (AGENTS.md
            // reconcile) must not fork the compression session.
            output.headers["x-bili-plugin-instructions-mutable"] = "1";
            const model = input.model;
            if (model && typeof model.providerID === "string" && typeof model.id === "string") {
                const key = `${model.providerID}/${model.id}`;
                const w = windows.get(key);
                if (w !== undefined) output.headers["x-bili-plugin-context-window"] = String(w);
                const o = outputs.get(key);
                if (o !== undefined) output.headers["x-bili-plugin-max-output"] = String(o);
                output.headers["x-bili-plugin-model"] = model.id;
                reportRuntimeInfoOnChange(base, { agent: "opencode", model: model.id, contextWindow: w, maxOutput: o, source: "client-config" });
            }
            maybeReportDerived(base, input.sessionID);
        };
        const forward = deps.forward ?? ((o, conversationId, tool, args) => import("./shared.js").then((m) => m.forwardTool(o, conversationId, tool, args)));
        if (legacy !== undefined) {
            // Tool slots carry acp's DCP schemas (kernel-parseable object form)
            // for BOTH lanes; executors route per session. acp_context_recap
            // has no proxy counterpart — legacy-only, forwarded calls fail
            // with the endpoint's unknown-tool message (documented).
            const tools: Record<string, V1Tool> = {};
            for (const [name, def] of Object.entries(legacy.tools)) {
                const exec = typeof def.execute === "function" ? def.execute : undefined;
                tools[name] = {
                    description: typeof def.description === "string" ? def.description : name,
                    args: (def.args ?? {}) as Record<string, unknown>,
                    execute: async (args, v1ctx) => {
                        if (exec !== undefined && isLegacy(v1ctx.sessionID)) {
                            return String((await exec(args, v1ctx)) ?? "");
                        }
                        const base = getOrigin();
                        if (base === undefined) return "bili: no live proxy yet — compression temporarily unavailable";
                        return forward(base, v1ctx.sessionID, name, args);
                    },
                };
            }
            hooks.tool = tools;
        } else {
            const tools: Record<string, V1Tool> = {};
            if (deps.z !== undefined) {
                for (const t of ACP_TOOLS_OPENAI) {
                    const fn = t.function;
                    tools[fn.name] = {
                        description: fn.description ?? fn.name,
                        args: jsonSchemaToZodShape(fn.parameters, deps.z),
                        execute: async (args, v1ctx) => {
                            const base = getOrigin();
                            if (base === undefined) return "bili: no live proxy yet — compression temporarily unavailable";
                            return forward(base, v1ctx.sessionID, fn.name, args);
                        },
                    };
                }
            } else {
                console.error("[bili-opencode-native] v1: zod unavailable — plugin tools skipped; sessions run in proxy mode (wire-injected compress)");
            }
            if (Object.keys(tools).length > 0) hooks.tool = tools;
        }
    }
    return hooks;
}

async function resolveV1Origin(): Promise<string | undefined> {
    try {
        return await readyOrigin(state);
    } catch {
        return undefined;
    }
}

const server = async (ctx: V1PluginContext): Promise<V1Hooks> => {
    if (plan.mode === "off") return {};
    const origin = await resolveV1Origin();
    // Global fetch patch (pi-native's mechanism): the config-hook rewrite can
    // only catch providers with an EXPLICIT baseURL — V1 has no request-level
    // hook, and providers relying on the SDK default (e.g. bare
    // `@ai-sdk/openai` → api.openai.com) would silently bypass the proxy.
    // v1's provider stack resolves `fetch` late (`customFetch ?? fetch` inside
    // the per-request wrapper, provider.ts), so a global patch catches those
    // requests too. Idempotent (flag-guarded) and disjoint from the config
    // rewrite: isModelApiUrl passes `/bili/`-prefixed URLs straight through,
    // so already-rewritten providers never double-wrap. Proxy-death respawn /
    // degrade-to-direct semantics come with the shared state. Installed BEFORE
    // the resolution gate (#1135): a failed startup (attach target dead AND
    // the spawn fallback failed) still recovers at runtime — the patch
    // observes network failures and drives state.respawn, so SDK-default
    // providers route again as soon as any proxy is alive.
    if (installNativeFetchIntercept(state)) {
        console.log("[bili-opencode-native] v1: fetch patch installed (catches providers without an explicit baseURL)");
    }
    if (origin === undefined) {
        console.error("[bili-opencode-native] v1: no live proxy at startup — traffic goes direct until runtime recovery lands one");
        return {};
    }
    console.log(`[bili-opencode-native] v1 active (proxy ${origin})`);
    let z: ZodLike | undefined;
    try {
        z = (await import("zod")) as ZodLike;
    } catch {
        z = undefined;
    }
    // Legacy lane (#920): absorb the installed opencode-acp so pre-migration
    // sessions keep their DCP machinery. Absent/failing package → undefined →
    // bili-only mode (legacy sessions degrade to read-only, documented).
    let legacy: LegacyAcpModule | undefined;
    try {
        // Pass the host's full ctx object through: V1PluginContext types only
        // what bili uses (client/directory), but the runtime object may carry
        // extra host fields acp's hooks need at action time.
        legacy = await loadLegacyAcp(ctx, (msg) => console.log(msg));
    } catch {
        legacy = undefined;
    }
    return createV1ServerHooks(() => state.origin, ctx, { z, legacy });
};

export default { id: "billion-context-opencode-native", setup: createOpencodeV2Setup({ route: createNativeRoute(state) }), server };
