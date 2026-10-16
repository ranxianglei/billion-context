// #3376: idle prompt-cache keepalive. Anthropic's prefix cache expires on a
// TTL (5m/1h) measured from the last HIT; a user pause (lunch, overnight)
// turns the next real request into a full-price cold rebuild. While a session
// is idle, bili replays the EXACT body its relay just shipped upstream
// (rewriting only max_tokens=1 and stream=false — both live outside the
// cached prefix region, so the prefix stays byte-identical and the ping
// refreshes the TTL at near-zero cost). Verdict per ping:
//   usage.cache_read_input_tokens > 0 → reschedule;
//   0/absent                          → disarm (prefix already dead);
//   HTTP 429                          → immediate disarm (quota pressure);
//   ≥3 consecutive other failures     → disarm (upstream problem, don't burn).
// Pings go DIRECTLY upstream (bypassing the bili pipeline), so they never
// touch sessions, the compress loop, or the /acp-cache hit-rate ledger.
//
// v1 scope (owner-approved, issue #3376 thread): Anthropic wire only,
// in-memory snapshots (a restart loses them — the next real request re-arms),
// re-sign lanes excluded (the stored signature covers the OLD body), and no
// arming for passthrough requests (no prepared pipeline state). Phase 2:
// provider adapter interface (Gemini's official cache-refresh API), restart
// persistence.

import { findRoute, loadConfigFile, type CacheKeepaliveSettings, type ProviderRoutes } from "./config.js";
import { credentialFingerprint } from "./cache-ledger.js";
import { log as loggerLog } from "./logger.js";
import { peekSession } from "./session.js";
import { usageTotals, type WireProtocol } from "./util.js";

const KEEPALIVE_TIER_5M_MS = 300_000;
const KEEPALIVE_TIER_1H_MS = 3_600_000;
const KEEPALIVE_DEFAULT_TTL_FACTOR = 0.9;
const KEEPALIVE_DEFAULT_MAX_DURATION_MS = 86_400_000; // 24h
const KEEPALIVE_DEFAULT_MAX_PINGS = 4;
const PING_TIMEOUT_MS = 60_000;
const BUSY_RESCHEDULE_MS = 5_000;
const MAX_FAIL_STREAK = 3;
// Hard per-snapshot cap: keepalive memory is otherwise bounded by
// maxConcurrentPings × prefix size, but a pathological multi-MB body must
// not be retained for minutes at a time.
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export interface ResolvedKeepalive {
    enabled: boolean;
    ttlFactor: number;
    maxDurationMs: number;
    maxConcurrentPings: number;
    assumeTtl: "5m" | "1h" | undefined;
    armWithoutBreakpoints: boolean;
    intervalMs: number | undefined;
}

function envBool(name: string): boolean | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    if (raw === "1" || raw.toLowerCase() === "true") return true;
    if (raw === "0" || raw.toLowerCase() === "false") return false;
    return undefined;
}

function envNum(name: string): number | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function fileNum(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** env > file(provider) > file(global) > default, per field (#2030 knob
 *  convention). A malformed value at ANY tier falls through to the NEXT
 *  tier — never straight to the default — so `BILI_..._MAX_PINGS=0` still
 *  honors a provider-level setting. This resolver runs on the hot path of
 *  every successful forward, so it never throws. */
function pickMs(envName: string, fileValue: unknown, valid: (n: number) => boolean, fallback: number | undefined): number | undefined {
    const env = envNum(envName);
    if (env !== undefined && valid(env)) return env;
    const file = fileNum(fileValue);
    if (file !== undefined && valid(file)) return file;
    return fallback;
}

/** True when any model under the matched route declares a keepalive tier —
 *  the only reason armInternal must parse the body while globally disabled. */
function modelTierPresent(routes: ProviderRoutes | undefined, upstreamUrl: string | undefined): boolean {
    const models = routes ? findRoute(routes, upstreamUrl)?.models : undefined;
    if (!models) return false;
    return Object.values(models).some((e) => e !== null && typeof e === "object" && "cacheKeepalive" in e);
}

export function resolveCacheKeepalive(routes: ProviderRoutes | undefined, upstreamUrl: string | undefined, model?: string): ResolvedKeepalive {
    const g: CacheKeepaliveSettings = loadConfigFile().cacheKeepalive ?? {};
    const route = routes ? findRoute(routes, upstreamUrl) : undefined;
    const p: CacheKeepaliveSettings = route?.cacheKeepalive ?? {};
    const m: CacheKeepaliveSettings = typeof model === "string" && model.length > 0 ? route?.models?.[model]?.cacheKeepalive ?? {} : {};
    const lvl = <K extends keyof CacheKeepaliveSettings>(k: K): CacheKeepaliveSettings[K] => (m[k] !== undefined ? m[k] : p[k] !== undefined ? p[k] : g[k]);

    let assumeTtl: "5m" | "1h" | undefined;
    const assumeEnv = process.env["BILI_CACHE_KEEPALIVE_ASSUME_TTL"];
    if (assumeEnv === "5m" || assumeEnv === "1h") assumeTtl = assumeEnv;
    else {
        const l = lvl("assumeTtl");
        if (l === "5m" || l === "1h") assumeTtl = l;
    }

    return {
        enabled: envBool("BILI_CACHE_KEEPALIVE") ?? lvl("enabled") === true,
        ttlFactor: pickMs("BILI_CACHE_KEEPALIVE_TTL_FACTOR", lvl("ttlFactor"), (n) => n > 0 && n <= 1, KEEPALIVE_DEFAULT_TTL_FACTOR) ?? KEEPALIVE_DEFAULT_TTL_FACTOR,
        maxDurationMs: pickMs("BILI_CACHE_KEEPALIVE_MAX_DURATION_MS", lvl("maxDurationMs"), (n) => Number.isInteger(n) && n > 0, KEEPALIVE_DEFAULT_MAX_DURATION_MS) ?? KEEPALIVE_DEFAULT_MAX_DURATION_MS,
        maxConcurrentPings: pickMs("BILI_CACHE_KEEPALIVE_MAX_PINGS", lvl("maxConcurrentPings"), (n) => Number.isInteger(n) && n >= 1, KEEPALIVE_DEFAULT_MAX_PINGS) ?? KEEPALIVE_DEFAULT_MAX_PINGS,
        assumeTtl,
        armWithoutBreakpoints: envBool("BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS") ?? lvl("armWithoutBreakpoints") === true,
        intervalMs: pickMs("BILI_CACHE_KEEPALIVE_INTERVAL_MS", lvl("intervalMs"), (n) => Number.isInteger(n) && n > 0, undefined),
    };
}

/** Pure: the TTL tier declared by the snapshot's cache_control breakpoints —
 *  any "1h" wins over "5m"; undefined when the body carries none. */
export function detectKeepaliveTier(body: unknown): "5m" | "1h" | undefined {
    let found: "5m" | "1h" | undefined;
    const walk = (n: unknown): void => {
        if (found === "1h" || n === null || typeof n !== "object") return;
        if (Array.isArray(n)) {
            for (const item of n) walk(item);
            return;
        }
        const o = n as Record<string, unknown>;
        const cc = o["cache_control"];
        if (cc && typeof cc === "object" && !Array.isArray(cc)) {
            const ttl = (cc as Record<string, unknown>)["ttl"];
            if (ttl === "1h") {
                found = "1h";
                return;
            }
            if (ttl === "5m") found = "5m";
        }
        for (const v of Object.values(o)) walk(v);
    };
    walk(body);
    return found;
}

/** Pure: the ping body — the snapshot with ONLY max_tokens and stream
 *  rewritten. Both fields sit after the cached prefix region on every
 *  Anthropic request shape, so the replayed prefix stays byte-identical. */
export function buildPingBody(snapshot: string): string {
    const obj = JSON.parse(snapshot) as Record<string, unknown>;
    obj["max_tokens"] = 1;
    obj["stream"] = false;
    return JSON.stringify(obj);
}

interface KeepaliveEntry {
    sessionId: string;
    body: string;
    upstreamUrl: string;
    headers: Record<string, string>;
    dispatcher: object | undefined;
    credFp: string | undefined;
    cadenceMs: number;
    tierLabel: string;
    armedAt: number;
    lastRealActivityAt: number;
    maxDurationMs: number;
    pingCount: number;
    failStreak: number;
    lastPingAt?: number;
    lastHitAt?: number;
    timerId: ReturnType<typeof setTimeout> | undefined;
    pingInFlight: boolean;
}

const registry = new Map<string, KeepaliveEntry>();

let clock: () => number = () => Date.now();
let scheduleFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms);
let cancelFn: (id: ReturnType<typeof setTimeout>) => void = (id) => clearTimeout(id);

export interface KeepaliveArmInput {
    sessionId: string;
    protocol: WireProtocol;
    reqMethod: string;
    sidePassthrough: boolean;
    resignLane: boolean;
    wireBody: string | Buffer | undefined;
    upstreamUrl: string;
    headers: Record<string, string>;
    dispatcher: object | undefined;
    routes: ProviderRoutes | undefined;
    /** The request's model name — selects the model-level config tier. */
    model?: string;
}

/** Relay hook — call once per SUCCESSFUL anthropic-wire forward with the
 *  exact bytes that went upstream. Never throws into the request path: any
 *  keepalive defect degrades to "no keepalive", logged once per cause. */
export function noteSuccessfulForward(inp: KeepaliveArmInput): void {
    try {
        armInternal(inp);
    } catch (err) {
        loggerLog("warn", `[${inp.sessionId}] [keepalive] arm failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Live per-session keepalive state for status surfaces (acp_status, web UI) —
 *  undefined when the session has no armed snapshot. */
export interface KeepaliveStatus {
    tierLabel: string;
    cadenceMs: number;
    pingCount: number;
    failStreak: number;
    armedAt: number;
    lastRealActivityAt: number;
    lastPingAt?: number;
    lastHitAt?: number;
}

export function keepaliveStatusFor(sessionId: string): KeepaliveStatus | undefined {
    const e = registry.get(sessionId);
    if (!e) return undefined;
    return {
        tierLabel: e.tierLabel,
        cadenceMs: e.cadenceMs,
        pingCount: e.pingCount,
        failStreak: e.failStreak,
        armedAt: e.armedAt,
        lastRealActivityAt: e.lastRealActivityAt,
        lastPingAt: e.lastPingAt,
        lastHitAt: e.lastHitAt,
    };
}

function armInternal(inp: KeepaliveArmInput): void {
    if (inp.protocol !== "anthropic" || inp.reqMethod !== "POST" || inp.sidePassthrough || inp.resignLane) return;
    if (typeof inp.wireBody !== "string" || inp.wireBody.length === 0) return;
    if (inp.wireBody.length > MAX_SNAPSHOT_BYTES) {
        loggerLog("warn", `[${inp.sessionId}] [keepalive] snapshot skipped: body ${inp.wireBody.length} bytes exceeds ${MAX_SNAPSHOT_BYTES} cap`);
        return;
    }
    // Fast path while the feature is off everywhere: decide WITHOUT parsing
    // the (potentially multi-MiB) body. A per-model tier may still enable it,
    // so only skip when no route declares one.
    if (!resolveCacheKeepalive(inp.routes, inp.upstreamUrl).enabled && !modelTierPresent(inp.routes, inp.upstreamUrl)) {
        disarm(inp.sessionId, "disabled");
        return;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(inp.wireBody);
    } catch {
        return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    // The relay hook cannot reference the request-scoped model variable at the
    // 2xx commit point, so the model comes from the body itself (top-level
    // "model" on the anthropic wire) unless an explicit hint was passed.
    const rec = parsed as { model?: unknown };
    const model =
        typeof inp.model === "string" && inp.model.length > 0
            ? inp.model
            : typeof rec.model === "string"
              ? rec.model
              : undefined;
    const cfg = resolveCacheKeepalive(inp.routes, inp.upstreamUrl, model);
    if (!cfg.enabled) {
        disarm(inp.sessionId, "disabled");
        return;
    }

    const now = clock();
    const credFp = credentialFingerprint(inp.headers);
    const prev = registry.get(inp.sessionId);
    // Credential rotated since the snapshot (#2131): the old body was signed
    // for another key — drop it before deciding about the new one.
    if (prev && prev.credFp !== credFp) registry.delete(inp.sessionId);

    const breakpointTier = detectKeepaliveTier(parsed);
    let cadenceMs: number;
    let tierLabel: string;
    if (cfg.intervalMs !== undefined) {
        cadenceMs = cfg.intervalMs;
        tierLabel = `interval:${cfg.intervalMs}ms`;
    } else if (cfg.assumeTtl) {
        cadenceMs = Math.round((cfg.assumeTtl === "1h" ? KEEPALIVE_TIER_1H_MS : KEEPALIVE_TIER_5M_MS) * cfg.ttlFactor);
        tierLabel = `${cfg.assumeTtl}(assumed)`;
    } else if (breakpointTier) {
        cadenceMs = Math.round((breakpointTier === "1h" ? KEEPALIVE_TIER_1H_MS : KEEPALIVE_TIER_5M_MS) * cfg.ttlFactor);
        tierLabel = breakpointTier;
    } else if (cfg.armWithoutBreakpoints) {
        cadenceMs = Math.round(KEEPALIVE_TIER_5M_MS * cfg.ttlFactor);
        tierLabel = "5m(no-breakpoints)";
    } else {
        return;
    }

    if (!registry.has(inp.sessionId) && registry.size >= cfg.maxConcurrentPings) {
        let oldestId: string | undefined;
        let oldestAt = Infinity;
        for (const [id, e] of registry) {
            if (e.armedAt < oldestAt) {
                oldestAt = e.armedAt;
                oldestId = id;
            }
        }
        if (oldestId !== undefined) disarm(oldestId, "concurrency-cap");
    }
    if (prev) cancelFn(prev.timerId!);

    const entry: KeepaliveEntry = {
        sessionId: inp.sessionId,
        body: inp.wireBody,
        upstreamUrl: inp.upstreamUrl,
        headers: { ...inp.headers },
        dispatcher: inp.dispatcher,
        credFp,
        cadenceMs,
        tierLabel,
        armedAt: now,
        lastRealActivityAt: now,
        maxDurationMs: cfg.maxDurationMs,
        pingCount: 0,
        failStreak: 0,
        timerId: undefined,
        pingInFlight: false,
    };
    registry.set(inp.sessionId, entry);
    entry.timerId = scheduleFn(() => {
        void firePing(entry);
    }, entry.cadenceMs);
    loggerLog("info", `[${entry.sessionId}] [keepalive] armed tier=${tierLabel} cadence=${Math.round(entry.cadenceMs / 1000)}s body=${Math.ceil(entry.body.length / 1024)}KiB`);
}

async function firePing(entry: KeepaliveEntry): Promise<void> {
    if (registry.get(entry.sessionId) !== entry) return;
    const now = clock();
    if (now - entry.lastRealActivityAt > entry.maxDurationMs) {
        disarm(entry.sessionId, "max-duration");
        return;
    }
    const session = peekSession(entry.sessionId);
    if (!session) {
        disarm(entry.sessionId, "session-gone");
        return;
    }
    // A real request in flight refreshes the cache itself — skip this tick
    // rather than race it (and its own re-arm replaces the snapshot anyway).
    if (entry.pingInFlight || session.inFlight > 0) {
        entry.timerId = scheduleFn(() => {
            void firePing(entry);
        }, BUSY_RESCHEDULE_MS);
        return;
    }
    entry.pingInFlight = true;
    entry.lastPingAt = clock();
    let resp: Response;
    try {
        resp = await sendPing(entry);
    } catch (err) {
        entry.pingInFlight = false;
        handleFailure(entry, `network: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    entry.pingInFlight = false;
    if (registry.get(entry.sessionId) !== entry) return;
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
        if (resp.status === 429) {
            disarm(entry.sessionId, "rate-limited(429)");
            return;
        }
        handleFailure(entry, `http ${resp.status}: ${text.slice(0, 200)}`);
        return;
    }
    let usage: Record<string, unknown> | undefined;
    try {
        const j = JSON.parse(text) as { usage?: unknown };
        if (j && typeof j === "object" && j.usage && typeof j.usage === "object") usage = j.usage as Record<string, unknown>;
    } catch {
        usage = undefined;
    }
    const cached = usage ? usageTotals("anthropic", usage).cached : undefined;
    entry.pingCount += 1;
    if (typeof cached === "number" && cached > 0) {
        entry.failStreak = 0;
        entry.lastHitAt = clock();
        loggerLog("info", `[${entry.sessionId}] [keepalive] ping#${entry.pingCount} hit=${cached}tok`);
        reschedule(entry);
    } else {
        disarm(entry.sessionId, "prefix-dead(cache_read=0)");
    }
}

function handleFailure(entry: KeepaliveEntry, detail: string): void {
    if (registry.get(entry.sessionId) !== entry) return;
    entry.failStreak += 1;
    loggerLog("warn", `[${entry.sessionId}] [keepalive] ping failed (${entry.failStreak}/${MAX_FAIL_STREAK}): ${detail}`);
    if (entry.failStreak >= MAX_FAIL_STREAK) {
        disarm(entry.sessionId, `errors(${detail})`);
        return;
    }
    reschedule(entry);
}

function reschedule(entry: KeepaliveEntry): void {
    if (registry.get(entry.sessionId) !== entry) return;
    entry.timerId = scheduleFn(() => {
        void firePing(entry);
    }, entry.cadenceMs);
}

async function sendPing(entry: KeepaliveEntry): Promise<Response> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.headers)) {
        const lk = k.toLowerCase();
        if (lk === "content-length" || lk === "transfer-encoding" || lk === "connection") continue;
        headers[k] = v;
    }
    // Same dispatcher typing as fetch-util.ts: @types/node types
    // RequestInit.dispatcher as its internal Dispatcher interface; undici's
    // global accepts it at runtime. Assert to RequestInit at the call site.
    const init: Omit<RequestInit, "dispatcher"> & { dispatcher?: object } = {
        method: "POST",
        headers,
        body: buildPingBody(entry.body),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    };
    if (entry.dispatcher) init.dispatcher = entry.dispatcher;
    return await fetch(entry.upstreamUrl, init as RequestInit) as Response;
}

function disarm(sessionId: string, reason: string): void {
    const entry = registry.get(sessionId);
    if (!entry) return;
    registry.delete(sessionId);
    if (entry.timerId !== undefined) cancelFn(entry.timerId);
    loggerLog("info", `[${sessionId}] [keepalive] disarmed reason=${reason} pings=${entry.pingCount}`);
}

// ---- test seams (repo convention: _setXForTest / _resetXForTest) ----

export function _setKeepaliveClockForTest(fn: (() => number) | undefined): void {
    clock = fn ?? (() => Date.now());
}

export interface FakeScheduler {
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (id: unknown) => void;
}

export function _setKeepaliveSchedulerForTest(sched: FakeScheduler | undefined): void {
    if (sched) {
        scheduleFn = (fn, ms) => sched.schedule(fn, ms) as ReturnType<typeof setTimeout>;
        cancelFn = (id) => sched.cancel(id as unknown);
    } else {
        scheduleFn = (fn, ms) => setTimeout(fn, ms);
        cancelFn = (id) => clearTimeout(id);
    }
}

export function _resetKeepaliveForTest(): void {
    for (const id of [...registry.keys()]) disarm(id, "test-reset");
    _setKeepaliveClockForTest(undefined);
    _setKeepaliveSchedulerForTest(undefined);
}

export function _keepaliveArmedForTest(): string[] {
    return [...registry.keys()];
}

export function _keepaliveEntryForTest(sessionId: string): { cadenceMs: number; tierLabel: string; pingCount: number; failStreak: number } | undefined {
    const e = registry.get(sessionId);
    return e ? { cadenceMs: e.cadenceMs, tierLabel: e.tierLabel, pingCount: e.pingCount, failStreak: e.failStreak } : undefined;
}
