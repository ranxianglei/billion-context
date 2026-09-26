// Native-mode fetch interception (#519): a globalThis.fetch patch that
// silently routes model-API requests through a bili proxy that the extension
// itself spawned (see pi-native.ts). Verified end-to-end on pi 0.83.6: pi's
// provider stack (pi-stable-ai → Anthropic/OpenAI SDKs) resolves its fetch
// from the global at FIRST-request client construction, so a patch installed
// at extension load always wins. The patch is surgical — it rewrites ONLY
// model-API shaped URLs and leaves every other request untouched.

import { envMillis } from "./native-bootstrap.js";
import { BILI_PASSTHROUGH_HEADER } from "../util.js";

export interface NativeInterceptState {
    /** Proxy origin ("http://127.0.0.1:PORT") once the bootstrap resolved.
     *  Written by the owner (pi-native.ts); read synchronously on each call. */
    origin: string | undefined;
    /** Resolves to the proxy origin once healthy, or undefined on failure. */
    ready: Promise<string | undefined>;
    /** Owner hook: re-run the bootstrap (proxy died → respawn). */
    respawn?: () => Promise<string | undefined>;
    /** Owner hook: fired once when a respawn attempt fails and the session
     *  degrades to direct sends for good — clear proxy-owned state (e.g. the
     *  BILLION_CONTEXT_PROXY env) so event-time ownership checks disarm with
     *  the traffic. */
    onGiveUp?: () => void;
    /** Attach mode (#809): route through a user-supplied external proxy at
     *  state.origin instead of a spawned one. Set by the host entry when a
     *  BILLION_CONTEXT_ATTACH / launcher-preset BILLION_CONTEXT_PROXY is
     *  present. Rewrites model URLs to the attach origin exactly like spawn
     *  mode (opencode V1's fetch patch and #809's probe+rewrite semantics
     *  depend on it); already-routed `/bili/` URLs still pass through except
     *  for headersFor stamping. The attached proxy is often owned by ANOTHER
     *  launcher that can exit mid-session (#1130) — hosts arm state.respawn
     *  so an observed death triggers the same runtime recovery as spawn
     *  mode; without respawn, an observed death degrades to direct sends
     *  instead of failing every request forever. */
    attach?: boolean;
    /** Optional header hook (#941): called synchronously per model-API
     *  request with the (pre-rewrite) target URL. A non-undefined return is
     *  merged into the outgoing request headers — dsh-native uses it to
     *  stamp x-bili-plugin* once its tools are registered, gating plugin
     *  mode exactly like pi.ts's before_provider_headers stamp. Returning
     *  undefined sends the request untouched (wire mode). */
    headersFor?: (url: string) => Record<string, string> | undefined;
    /** #1117: attribution gate — called synchronously per model-API request
     *  with the (pre-rewrite) target URL. Returning false means the caller is
     *  NOT the host itself (e.g. a third-party in-process plugin riding the
     *  host's LLM bridge, whose model calls hit the same URLs): the request is
     *  NOT claimed — raw URLs send direct, already-routed `/bili/` URLs are
     *  stamped with the passthrough marker instead. Undefined (hosts without
     *  an attribution signal) keeps URL-shape claiming for every caller. */
    takeoverGate?: (url: string) => boolean;
    /** How long a pre-ready model request waits for the bootstrap before
     *  falling back to a direct (uncompressed) send. */
    readyTimeoutMs?: number;
    /** Owner hook (#1268): resolves when the host-side ACP tool registration
     *  has finished its FIRST attempt (success OR failure). Model-API requests
     *  await it (bounded by readyTimeoutMs) before headersFor is consulted, so
     *  the first request of a fresh session is stamped into plugin mode instead
     *  of silently riding wire mode because registration lost the boot race
     *  (observed live: dsh fires R1 ~90ms before the manifest lands). Undefined
     *  (every lane that does not arm one) = no wait, behavior unchanged. */
    toolsReady?: Promise<unknown>;
    /** #1365: origin baked into already-routed `/bili/` model URLs observed
     *  by this process (sticky; last observation wins). Routed URLs are
     *  STATICALLY pinned to that origin — a spawned replacement can never
     *  carry them — so attach lanes treat this as evidence their model
     *  channel cannot follow a new instance: wait for the pinned target /
     *  fail loudly instead of spawning a second proxy (split brain). */
    routedOrigin?: string;
    /** #1365 owner hook: fired when routed model traffic is observed at an
     *  origin different from the one previously noted (late evidence — e.g.
     *  the first routed request landing after the attach decision already
     *  settled elsewhere). The owner binds its tool surface to the observed
     *  origin when healthy, or the session splits across two instances. */
    onRoutedOriginObserved?: (origin: string) => void;
    /** Test/observability hook: every dispatched decision. */
    onDispatch?: (url: string, action: "rewrite" | "direct" | "self" | "retry") => void;
    /** #1290: observability hook — fired for every request the fetch patch lets
     *  through WITHOUT routing because its URL is not a recognized model endpoint
     *  (isModelApiUrl miss). Such requests never reach a bili proxy, so without
     *  this their "went direct (uncompressed)" outcome was completely silent —
     *  #1158's logging promise only covered the attribution gate below. Called
     *  per request; hosts dedup once-per-process-per-endpoint like takeoverGate.
     *  Undefined hosts stay silent. */
    onUnroutedModelUrl?: (url: string) => void;
}

/** Ownership marker for bili's own chain links (#1410). Every function
 *  makeChain produces carries this symbol as an OWN property, so a write-back
 *  of our own (possibly stale) link to globalThis.fetch is recognized as ours
 *  — never counted as a third-party evict spending re-arm budget. */
const CHAIN_MARKER = Symbol.for("billion-context.native-fetch-chain");

function markOwnChain(fn: typeof globalThis.fetch): void {
    Object.defineProperty(fn, CHAIN_MARKER, { value: true, configurable: true, writable: true, enumerable: false });
}

function isOwnChain(v: unknown): boolean {
    return typeof v === "function" && Object.prototype.hasOwnProperty.call(v, CHAIN_MARKER);
}

// #1410: same-process installs share one identity — Symbol.for keeps the
// double-load check working across duplicate copies of this module (a plain
// Symbol would let a second copy re-install on top of the first).
const INTERCEPT_FLAG = Symbol.for("billion-context.native-fetch-intercept");

/** #1158 escape hatch: `BILI_RECLAIM_FETCH_PATCH=0` keeps the classic direct
 *  install — a third-party re-arm (dsh-http-proxy refresh) then wins and
 *  bili stops seeing model traffic (documented degradation, visible instead
 *  of silently healed) for setups that NEED the third-party chain on top
 *  (e.g. a socks egress bili's upstream proxying does not support). */
function shouldReclaimFetchPatch(): boolean {
    const raw = process.env.BILI_RECLAIM_FETCH_PATCH;
    if (raw === undefined) return true;
    return !/^(0|false|off|no)$/i.test(raw.trim());
}

/** #1158 self-heal: the property descriptor captured before we installed the
 *  guarded accessor, so _resetForTest can restore a plain writable data
 *  property. Undefined before the first install in a process. */
let preInstallDesc: PropertyDescriptor | undefined;

/** The accessor descriptor we defined on globalThis.fetch — identity-compared
 *  by _resetForTest before restoring preInstallDesc, so a third party's legal
 *  delete/redefine in between (#1410) is never clobbered. */
let installedDesc: PropertyDescriptor | undefined;

/** #1410 re-anchor ledger: every fetch this process has ever observed at the
 *  top slot, ordered oldest→newest. The oldest entry is the module-load
 *  anchor — whatever fetch existed BEFORE any plugin ran, i.e. the host's
 *  native fetch. When the adopted downstream dies underneath us (its owner
 *  tore its wrapper down behind our back — scope end nulling its closure
 *  locals) we re-anchor to the OLDEST still-live entry instead of the
 *  newest: the newest may itself be someone else's transient scope wrapper
 *  (adopting it would just repeat the failure one teardown later), while the
 *  oldest has already survived every prior teardown in this process. */
let moduleAnchor: typeof globalThis.fetch | undefined = typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;
let observedFetches: Array<typeof globalThis.fetch> = moduleAnchor !== undefined ? [moduleAnchor] : [];
const knownDeadFetches = new Set<typeof globalThis.fetch>();
let warnedReanchor = false;

/** #1410: the dead-closure signature. A wrapper whose owner nulled its
 *  closure locals dies exactly like this ("baseFetch is not a function").
 *  Network failures NEVER match: undici throws "fetch failed", provider SDKs
 *  throw their own messages — only the missing-closure shape does. */
function isDeadClosureError(err: unknown): boolean {
    return err instanceof TypeError && /is not a function$/.test(err.message);
}

function noteFetch(f: unknown): void {
    if (typeof f !== "function") return;
    const fn = f as typeof globalThis.fetch;
    if (!observedFetches.includes(fn)) observedFetches.push(fn);
}

/** Mark `dead` (just proven torn down) and return the oldest observed fetch
 *  still believed live, or undefined when nothing is left. */
function nextLiveAnchor(dead: typeof globalThis.fetch): typeof globalThis.fetch | undefined {
    knownDeadFetches.add(dead);
    return observedFetches.find((f) => !knownDeadFetches.has(f));
}

// Model-API endpoint suffixes across the wires bili proxies: Anthropic
// `/v1/messages`, OpenAI chat `/v1/chat/completions` (and legacy
// `/v1/completions`), Responses `/v1/responses`, Mistral
// `/v1/chat/completions`|`/v1/conversations`. Version segment is optional
// and unpinned (zhipuai uses `/v4/chat/completions`, bailian mounts
// `/apps/anthropic/v1/messages`), so match on the trailing shape only.
const MODEL_API_SUFFIX = /(?:^|\/)(?:v\d+\/)?(?:messages|chat\/completions|completions|responses|conversations)\/?$/;

/** True when the URL points at a model-API endpoint worth proxying. Never
 *  true for bili's own proxy paths (`/bili/…`, `/__bili/…`) or non-HTTP(S). */
export function isModelApiUrl(url: string): boolean {
    if (!/^https?:\/\//i.test(url)) return false;
    if (url.includes("/__bili/") || url.includes("/__acp/")) return false;
    try {
        const u = new URL(url);
        const segments = u.pathname.split("/").filter((s) => s.length > 0);
        if (segments[0] === "bili") return false;
        const pathname = u.pathname.replace(/\/+$/, "");
        return MODEL_API_SUFFIX.test(pathname);
    } catch {
        return false;
    }
}

/** True when the URL addresses bili's own control plane (`/__bili/*`,
 *  `/__acp/*`, or a `/bili/<protocol>/<url>` tunnel) — expected direct
 *  traffic, not an unrecognized endpoint (#1290): reporting it as "not a
 *  recognized model endpoint" would flag bili's own requests. */
function isBiliControlUrl(url: string): boolean {
    if (url.includes("/__bili/") || url.includes("/__acp/")) return true;
    try {
        const segments = new URL(url).pathname.split("/").filter((s) => s.length > 0);
        return segments[0] === "bili";
    } catch {
        return false;
    }
}

/** A URL already routed by a bili proxy in `/bili/` rewrite form
 *  (`${proxy}/bili/${upstream}`): returns the embedded upstream URL when it
 *  is model-API shaped, else undefined. The launcher's settings overlay
 *  produces these; the patch does not rewrite them (routing is already
 *  done) but DOES stamp plugin headers on them. */
export function routedBiliModelUrl(url: string): string | undefined {
    if (!/^https?:\/\//i.test(url) || url.includes("/__bili/") || url.includes("/__acp/")) return undefined;
    const m = /^https?:\/\/[^/]+\/bili\/(https?:\/.+)$/i.exec(url);
    if (m === null) return undefined;
    return isModelApiUrl(m[1]) ? m[1] : undefined;
}

function fetchUrlOf(input: string | URL | Request): string | undefined {
    try {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.href;
        if (input !== null && typeof input === "object" && typeof (input as Request).url === "string") {
            return (input as Request).url;
        }
    } catch {
        // fallthrough
    }
    return undefined;
}

/** Merge extra headers into a (input, init) pair, preserving all three
 *  init.headers forms (Headers instance, entries array, plain object) and
 *  rebuilding a Request-object input with the merged headers (its body
 *  stream passes through explicitly — undici refuses to copy a body-bearing
 *  Request without duplex). Returns the original pair unchanged when there
 *  is nothing to merge. */
function withHeaders(input: string | URL | Request, init: RequestInit | undefined, extra: Record<string, string> | undefined): { input: string | URL | Request; init: RequestInit | undefined } {
    if (extra === undefined || Object.keys(extra).length === 0) return { input, init };
    if (input instanceof Request) {
        try {
            const headers = new Headers(input.headers);
            for (const [k, v] of Object.entries(extra)) headers.set(k, v);
            const rebuilt = new Request(input.url, { method: input.method, headers, body: input.body, duplex: "half" });
            return { input: rebuilt, init };
        } catch {
            return { input, init };
        }
    }
    if (init?.headers === undefined) return { input, init: { ...init, headers: { ...extra } } };
    if (init.headers instanceof Headers) {
        const headers = new Headers(init.headers);
        for (const [k, v] of Object.entries(extra)) headers.set(k, v);
        return { input, init: { ...init, headers } };
    }
    if (Array.isArray(init.headers)) {
        return { input, init: { ...init, headers: [...init.headers, ...Object.entries(extra)] } };
    }
    if (typeof init.headers === "object" && init.headers !== null) {
        return { input, init: { ...init, headers: { ...(init.headers as Record<string, string>), ...extra } } };
    }
    return { input, init };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } catch (err) {
        // #983: a rejected bootstrap used to vanish silently here — surface
        // the real error so a dead-spawn looks different from a slow one.
        console.error(`bili-native: proxy bootstrap failed (${err instanceof Error ? err.message : String(err)}) — falling back after timeout`);
        return undefined;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function readyOrigin(state: NativeInterceptState): Promise<string | undefined> {
    if (state.origin !== undefined) return state.origin;
    return withTimeout(state.ready, state.readyTimeoutMs ?? 15000);
}

// ———— Routed-channel evidence (#1365) ————————————————————————————
// Already-routed `/bili/` model URLs carry their proxy origin baked into the
// string; nothing bili does at runtime can move them to a different instance.
// Observing one is therefore DIRECT EVIDENCE that this process's model channel
// is pinned — the attach lanes consume it to decide wait/fail over spawn.

/** Record the origin of an already-routed model URL on the shared state and
 *  fire the owner hook on a transition (first observation or a NEW origin).
 *  MUST be called before any gate/await in the dispatch path: the recording
 *  must never be blocked by machinery it itself informs (the #1268 toolsReady
 *  gate waits on tool registration, which waits on the attach decision, which
 *  consumes this evidence — ordering it after the gate would self-deadlock
 *  the first request). */
export function noteRoutedOrigin(state: NativeInterceptState, url: string): void {
    let origin: string;
    try {
        origin = new URL(url).origin;
    } catch {
        return;
    }
    if (state.routedOrigin === origin) return;
    state.routedOrigin = origin;
    state.onRoutedOriginObserved?.(origin);
}

const EVIDENCE_GRACE_DEFAULT_MS = 5000;
const EVIDENCE_GRACE_POLL_MS = 100;

/** Wait up to the evidence-grace window for the first routed model request to
 *  reveal where this process's model channel is pinned. The startup attach
 *  decision runs BEFORE the first request (the liveness probe fails in
 *  milliseconds; the request lands seconds later), so an immediate spawn
 *  fallback would race ahead of the evidence — the grace window lets the
 *  channel shape declare itself. Returns the observed origin (pinned channel:
 *  never spawn) or undefined (no routed traffic within the window — the
 *  channel is presumed raw and may follow a replacement, legacy behavior).
 *  BILI_ATTACH_EVIDENCE_GRACE_MS overrides the default; unset = unchanged. */
export async function observeRoutedOrigin(state: NativeInterceptState): Promise<string | undefined> {
    const limit = envMillis(process.env, "BILI_ATTACH_EVIDENCE_GRACE_MS", EVIDENCE_GRACE_DEFAULT_MS);
    const startedAt = Date.now();
    for (;;) {
        const observed = state.routedOrigin;
        if (observed !== undefined) return observed;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= limit) return undefined;
        await new Promise((r) => setTimeout(r, Math.min(EVIDENCE_GRACE_POLL_MS, limit - elapsed)));
    }
}

// ———— Live-origin resolution (#1135) ——————————————————————————————
// Shared by BOTH OpenCode lanes (the native entry's V2 route and the
// launcher plugin's V2 route): each outgoing request resolves the LIVE proxy
// origin — fast-path the held origin through a TTL-cached health probe, and
// when it is dead drive state.respawn (cooldown-gated unless we just lost an
// origin we were actively routing to) and adopt whatever replacement lands.
// A transient blip that recovers to the SAME origin costs nothing (the
// session never migrates); a genuinely dead origin falls back to whatever the
// owner's respawn produces (a self-spawned proxy, or another healthy shared
// instance via discovery). Returns undefined when nothing is alive — callers
// MUST degrade to direct sends, not fail-closed.

const HEALTH_TIMEOUT_MS = 1500;
/** Probe-verdict trust window (#928). Far below RESPAWN_COOLDOWN_MS: that
 *  cooldown already assumes multi-second proxy stability, so a few-second
 *  detection horizon is consistent with it while removing the per-request RTT. */
const HEALTH_PROBE_TTL_MS = 2_000;
const RESPAWN_COOLDOWN_MS = 15_000;

export async function probeHealth(origin: string): Promise<boolean> {
    try {
        const res = await fetch(`${origin}/__bili/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        return res.ok;
    } catch {
        return false;
    }
}

/** Wrap a probe in a per-origin TTL cache (#928). Both verdicts are cached: a
 *  healthy hit skips the steady-state loopback RTT; a dead hit avoids re-paying
 *  the full HEALTH_TIMEOUT_MS on every request across the death+cooldown window.
 *  Stale entries for other origins are evicted on insert, keeping the map bounded. */
export function withProbeTtl(probe: (origin: string) => Promise<boolean>, ttlMs: number): (origin: string) => Promise<boolean> {
    const cache = new Map<string, { ok: boolean; at: number }>();
    return (origin) => {
        const now = Date.now();
        const hit = cache.get(origin);
        if (hit !== undefined && now - hit.at < ttlMs) return Promise.resolve(hit.ok);
        return probe(origin).then((ok) => {
            const t = Date.now();
            for (const [key, entry] of cache) if (t - entry.at >= ttlMs) cache.delete(key);
            cache.set(origin, { ok, at: t });
            return ok;
        });
    };
}

export interface LiveOriginResolverDeps {
    /** Injectable health probe (tests); defaults to GET /__bili/health. */
    probe?: (origin: string) => Promise<boolean>;
    /** Bootstrap retry interval when no live origin is held (tests shrink it). */
    respawnCooldownMs?: number;
    /** Probe-verdict cache TTL; defaults to HEALTH_PROBE_TTL_MS (tests shrink it). */
    probeTtlMs?: number;
}

/** Build the per-request live-origin resolver over a shared intercept state.
 *  The owner arms `state.respawn` (self-spawn for spawn mode, probe-then-
 *  fallback for attach mode — #1130/#1135); this resolver only decides WHEN
 *  to fire it and whether the result is actually alive. */
export function createLiveOriginResolver(state: NativeInterceptState, deps: LiveOriginResolverDeps = {}): () => Promise<string | undefined> {
    const probe = withProbeTtl(deps.probe ?? probeHealth, deps.probeTtlMs ?? HEALTH_PROBE_TTL_MS);
    const respawnCooldownMs = deps.respawnCooldownMs ?? RESPAWN_COOLDOWN_MS;
    let lastRespawn = 0;
    return async (): Promise<string | undefined> => {
        let ownedThenLost = false;
        if (state.origin !== undefined) {
            if (await probe(state.origin)) return state.origin;
            // Proxy died mid-session. Clearing origin first makes concurrent
            // callers share the same state.ready (dedup).
            ownedThenLost = true;
            state.origin = undefined;
        }
        // Retry bootstrap whenever no live origin is held — either just lost
        // it or the load-time bootstrap failed (the hook cannot observe send
        // failures, so nothing else would retry). Cooldown bounds attempts to
        // one per interval instead of one per request.
        if (state.respawn !== undefined && (ownedThenLost || Date.now() - lastRespawn >= respawnCooldownMs)) {
            lastRespawn = Date.now();
            state.ready = state.respawn();
        }
        const o = await readyOrigin(state);
        if (o !== undefined && (await probe(o))) return o;
        if (ownedThenLost) state.onGiveUp?.();
        return undefined;
    };
}

/** Replace the outgoing request reference with a new Request against
 *  `target`, preserving method/headers/body (a Request.url is read-only,
 *  #810 — the reference itself moves). When the body cannot be copied the
 *  original request is left untouched (it goes direct rather than dying). */
export function replaceRequestTarget(e: { request?: unknown }, target: string): void {
    const old = e.request;
    if (old == null) return;
    try {
        e.request = new Request(target, old as unknown as Request);
    } catch {
        // undici refuses to copy a body-bearing Request without explicit
        // duplex — reconstruct with the body stream passed explicitly.
        const src = old as unknown as { method?: unknown; headers?: Iterable<readonly [string, string]> | null; body?: ReadableStream<Uint8Array> | null };
        try {
            const init: RequestInit & { duplex?: "half" } = { method: typeof src.method === "string" ? src.method : "GET" };
            const pairs: [string, string][] = [];
            try {
                for (const pair of src.headers ?? []) pairs.push([pair[0], pair[1]]);
            } catch {}
            if (pairs.length > 0) init.headers = pairs;
            if (src.body != null) {
                init.body = src.body as RequestInit["body"];
                init.duplex = "half";
            }
            e.request = new Request(target, init);
        } catch {
            // replacement impossible (exotic body) — request goes direct
        }
    }
}

/** Install the global fetch patch. Idempotent: a second call is a no-op
 *  (returns false) so double-loading the entry cannot double-wrap. */
export function installNativeFetchIntercept(state: NativeInterceptState): boolean {
    const g = globalThis as Record<PropertyKey, unknown>;
    if (g[INTERCEPT_FLAG] === true) return false;
    const orig = globalThis.fetch;
    noteFetch(orig);
    // Shared across every re-armed chain link (a re-arm replaces the chain
    // top but must not forget what this process already learned).
    let warned = false;
    // Origins verified dead-and-replaced during a runtime recovery (#1130).
    // Launcher settings overlays bake the origin into request URLs, so after
    // a replace we must reroute those pre-baked URLs before they touch the
    // network again. Only ever contains origins we ourselves observed dying.
    const replacedOrigins = new Set<string>();

    const makeChain = (downstream: typeof globalThis.fetch) => {
        // #1410: the downstream reference is MUTABLE. send() swaps it when
        // proof arrives that the current one was torn down underneath us
        // (dead-closure error) and retries on the oldest still-live fetch.
        let ds = downstream;
        const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            let cur = ds;
            for (;;) {
                try {
                    return await cur(input, init);
                } catch (err) {
                    const next = isDeadClosureError(err) ? nextLiveAnchor(cur) : undefined;
                    if (next === undefined) throw err;
                    if (!warnedReanchor) {
                        warnedReanchor = true;
                        console.warn("[bili-native] adopted downstream fetch was torn down by its owner (#1410) — re-anchored the chain onto the oldest live fetch");
                    }
                    ds = next;
                    cur = next;
                }
            }
        };
        const patched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = fetchUrlOf(input);
        if (url === undefined) return send(input, init);
        // #1268: hold the request until the host's ACP tool registration has
        // finished its first attempt, so headersFor can stamp it into plugin
        // mode. Steady state costs nothing (gate already resolved). A timeout
        // or a failed registration falls through exactly like today — the
        // request proceeds un-stamped (wire mode).
        let gateLogged = false;
        const waitToolsGate = async (): Promise<void> => {
            const gate = state.toolsReady;
            if (gate === undefined) return;
            const t0 = Date.now();
            await withTimeout(gate, state.readyTimeoutMs ?? 15000);
            const held = Date.now() - t0;
            if (!gateLogged && held >= 50) {
                gateLogged = true;
                console.warn(`[bili-native] held model request ${held}ms for ACP tool registration (#1268)`);
            }
        };
        // Rebuild a Request-object input against a different target. A
        // caller-side defect here (already-consumed or locked body) must not
        // reach the proxy-death branch below — respawning would orphan a
        // fresh proxy for a request that can never be sent.
        const makeTarget = (target: string): string | URL | Request =>
            typeof input === "string" || input instanceof URL ? target : new Request(target, input);

        // Runtime recovery (#1130): the origin just failed against is dead.
        // Clear it first (readyOrigin must not short-circuit onto the stale
        // value), ask the owner to bring up a replacement, await it. Returns
        // the replacement origin, or undefined when nothing came up. An
        // origin that comes back as ITSELF (transient blip) is not recorded
        // as replaced — URLs baked against it stay valid.
        const recover = async (deadOrigin: string): Promise<string | undefined> => {
            if (state.respawn === undefined) return undefined;
            state.origin = undefined;
            state.ready = state.respawn();
            const again = await readyOrigin(state);
            if (again !== undefined && again !== deadOrigin) replacedOrigins.add(deadOrigin);
            return again;
        };

        // Already-routed `/bili/` model requests (launcher settings overlay):
        // routing is done, but plugin headers still decide wire vs plugin
        // mode — stamp and pass through untouched otherwise.
        const routedTarget = routedBiliModelUrl(url);
        if (routedTarget !== undefined) {
            // #1117: routing already happened (settings overlay), so an
            // unattributed caller cannot be refused here — mark it for
            // byte-untouched passthrough instead of letting it ride the
            // pipeline as an anonymous client. Its failures are not ours to
            // recover: the host's own attributed traffic drives the respawn
            // below, and once a replacement lands the pre-emptive reroute
            // carries unattributed riders along (still passthrough-marked).
            const unattributed = state.takeoverGate !== undefined && !state.takeoverGate(routedTarget);
            if (unattributed) {
                const stamped = withHeaders(input, init, { [BILI_PASSTHROUGH_HEADER]: "1" });
                state.onDispatch?.(url, "direct");
                return send(stamped.input, stamped.init);
            }
            // #1365: attributed routed traffic pins this process's model channel
            // to the baked origin — record it BEFORE the gate (noteRoutedOrigin).
            noteRoutedOrigin(state, url);
            // The gate must clear BEFORE headersFor is consulted — the hook
            // reads the host's live tool-registration state, and evaluating
            // it pre-gate would freeze an un-stamped decision forever.
            await waitToolsGate();
            const routedExtra = state.headersFor?.(routedTarget);
            let target = url;
            const baked = new URL(url);
            if (replacedOrigins.has(baked.origin)) {
                // This URL was baked against an origin we already verified
                // dead-and-replaced (#1130) — reroute it before paying
                // another connection failure.
                const fresh = await readyOrigin(state);
                if (fresh !== undefined && fresh !== baked.origin) target = `${fresh}${baked.pathname}${baked.search}`;
            }
            const stamped = withHeaders(target === url ? input : makeTarget(target), init, routedExtra);
            try {
                state.onDispatch?.(target, target === url ? "self" : "retry");
                return await send(stamped.input, stamped.init);
            } catch (err) {
                // The overlay bakes a specific proxy origin into these URLs;
                // that proxy can die mid-session when its owning launcher
                // exits while later sessions still ride it (#1130). A
                // network-level failure (undici TypeError) triggers one
                // recovery + one retry; if no replacement comes up, degrade
                // to a direct send of the embedded upstream instead of
                // failing the request forever. Recovery re-attempts on every
                // subsequent failure — only this path can reroute the
                // overlay-baked URLs. A dead-closure error (#1410) is NOT a
                // proxy death — send() already exhausted every live anchor;
                // respawning would churn a healthy proxy for the wrong fault.
                if (!(err instanceof TypeError) || isDeadClosureError(err)) throw err;
                const deadOrigin = new URL(target).origin;
                const again = await recover(deadOrigin);
                if (again !== undefined && again !== deadOrigin) {
                    const u = new URL(target);
                    const retried = `${again}${u.pathname}${u.search}`;
                    const restamped = withHeaders(makeTarget(retried), init, routedExtra);
                    state.onDispatch?.(retried, "retry");
                    return await send(restamped.input, restamped.init);
                }
                state.onGiveUp?.();
                if (!warned) {
                    warned = true;
                    console.error(`bili-native: no live proxy — model requests go direct (uncompressed): ${routedTarget}`);
                }
                state.onDispatch?.(routedTarget, "direct");
                return send(makeTarget(routedTarget), init);
            }
        }
        if (!isModelApiUrl(url)) {
            if (!isBiliControlUrl(url)) state.onUnroutedModelUrl?.(url);
            return send(input, init);
        }
        // #1117: URL shape alone cannot claim a request — every model call in
        // the process hits the same endpoints. When the host supplies an
        // attribution gate, an unattributed caller keeps its original URL and
        // sends direct (never touches a bili proxy).
        if (state.takeoverGate !== undefined && !state.takeoverGate(url)) {
            state.onDispatch?.(url, "direct");
            return send(input, init);
        }

        const origin = await readyOrigin(state);
        if (origin === undefined) {
            // Bootstrap failed or timed out — NEVER break the agent: send
            // direct (uncompressed) and say so once.
            if (!warned) {
                warned = true;
                console.error(`bili-native: proxy not ready — model request goes direct (uncompressed): ${url}`);
            }
            state.onDispatch?.(url, "direct");
            return send(input, init);
        }
        // Attach mode rewrites exactly like spawn mode (#809 semantics —
        // opencode's attach probe+rewrite; the V1 fetch patch relies on it to
        // catch providers without an explicit baseURL). For dsh under the
        // `bili dsh` launcher this is doubly safe: settings-overlay URLs are
        // already `/bili/`-shaped and take the routed branch above, and
        // rewriting a raw upstream URL to the loopback proxy bypasses the
        // MITM envs entirely (an http loopback target is never proxied).
        if (url.startsWith(`${origin}/`)) {
            state.onDispatch?.(url, "self");
            return send(input, init);
        }
        await waitToolsGate();
        const first = makeTarget(`${origin}/bili/${url}`);
        state.onDispatch?.(`${origin}/bili/${url}`, "rewrite");
        try {
            const stamped = withHeaders(first, init, state.headersFor?.(url));
            return await send(stamped.input, stamped.init);
        } catch (err) {
            // The proxy can die mid-session (its parent watchdog fires when
            // the FIRST owner exits while later sessions still ride it —
            // spawned, or shared-attached via another launcher, #1130). A
            // network-level failure (undici throws TypeError) triggers one
            // recovery + one retry. A dead-closure error (#1410) is NOT a
            // proxy death — send() already exhausted every live anchor; let
            // it propagate instead of churning a healthy proxy.
            if (err instanceof TypeError && !isDeadClosureError(err)) {
                const again = await recover(origin);
                if (again !== undefined) {
                    const retried = makeTarget(`${again}/bili/${url}`);
                    state.onDispatch?.(`${again}/bili/${url}`, "retry");
                    const stamped = withHeaders(retried, init, state.headersFor?.(url));
                    return await send(stamped.input, stamped.init);
                }
                // No replacement available — this session runs direct for its
                // lifetime. Degrade exactly like a bootstrap failure: actually
                // send the request direct, then let the owner clear proxy-owned
                // state.
                state.onGiveUp?.();
                if (!warned) {
                    warned = true;
                    console.error(`bili-native: proxy respawn failed — model requests go direct (uncompressed): ${url}`);
                }
                state.onDispatch?.(url, "direct");
                return send(input, init);
            }
            throw err;
        }
    };

        const chain = patched as typeof globalThis.fetch;
        markOwnChain(chain);
        return chain;
    };

    // #1158 self-heal re-arm: dsh-http-proxy (0.1.3) re-applies by writing its
    // module-load-time frozen originalFetch over globalThis.fetch, silently
    // un-routing every model request away from bili while the session keeps
    // working (observed live on Windows). Guard the property instead of
    // trusting the assignment to survive: any third-party install becomes
    // our downstream and model traffic keeps routing through bili.
    const desc = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    let rearmCount = 0;
    const REARM_LIMIT = 16;
    const guard = desc === undefined || desc.configurable;
    let top = makeChain(orig);
    if (guard && shouldReclaimFetchPatch()) {
        preInstallDesc = desc;
        const accessor: PropertyDescriptor = {
            configurable: true,
            enumerable: desc?.enumerable ?? true,
            get: () => top,
            set: (v: unknown) => {
                if (typeof v !== "function" || v === top) return;
                // #1410: our own (possibly stale) chain link written back —
                // recognize it by marker and ignore, never spend re-arm
                // budget on ourselves.
                if (isOwnChain(v)) return;
                // Visibility (#1158): an evict attempt used to be silent —
                // log it so "un-routed by a third party" is diagnosable even
                // when the heal itself is not wanted/limited away.
                if (rearmCount < REARM_LIMIT) {
                    console.warn(`[bili-native] third-party globalThis.fetch install detected (#1158) — re-chaining as downstream (evict attempt ${rearmCount + 1})`);
                }
                if (rearmCount >= REARM_LIMIT) {
                    // A fighting patch (two self-healers) would loop forever;
                    // past the limit stop guarding and let the winner stand.
                    top = v as typeof globalThis.fetch;
                    return;
                }
                rearmCount += 1;
                noteFetch(v);
                top = makeChain(v as typeof globalThis.fetch);
            },
        };
        installedDesc = accessor;
        Object.defineProperty(globalThis, "fetch", accessor);
    } else {
        // Non-configurable host property or reclaim disabled
        // (BILI_RECLAIM_FETCH_PATCH=0): keep the classic direct install
        // (no guard, the old behavior).
        globalThis.fetch = top;
    }
    g[INTERCEPT_FLAG] = true;
    return true;
}

/** Test-only: drop the patch guard so a suite can install again. The
 *  caller owns restoring globalThis.fetch. `opts.anchor` overrides the
 *  module-load anchor (#1410) for suites that simulate a foreign scope. */
export function _resetForTest(opts: { anchor?: typeof globalThis.fetch } = {}): void {
    const g = globalThis as Record<PropertyKey, unknown>;
    delete g[INTERCEPT_FLAG];
    if (opts.anchor !== undefined) moduleAnchor = opts.anchor;
    observedFetches = moduleAnchor !== undefined ? [moduleAnchor] : [];
    knownDeadFetches.clear();
    warnedReanchor = false;
    if (preInstallDesc !== undefined) {
        const d = preInstallDesc;
        preInstallDesc = undefined;
        // #1410: restore ONLY while the property is still ours — it is
        // configurable, so a third party may legally have deleted/redefined
        // it meanwhile; restoring blindly would clobber their install. The
        // comparison must be on the accessor FUNCTIONS, not the descriptor
        // object: on the global object V8 rebuilds the descriptor wrapper
        // around every set, so object identity is never stable.
        const cur = Object.getOwnPropertyDescriptor(globalThis, "fetch");
        if (cur !== undefined && installedDesc !== undefined && cur.get === installedDesc.get && cur.set === installedDesc.set) {
            Object.defineProperty(globalThis, "fetch", { ...d, configurable: true });
        }
        installedDesc = undefined;
    }
}
