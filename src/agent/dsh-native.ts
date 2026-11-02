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
//      initiator is active, latest-session fallback otherwise);
//   6. host-title channel (#2604): dsh owns its session names (the
//      dsh-session-title service emits log-backed `session/title` events on
//      fallback creation, LLM-generation acceptance and user rename,
//      latest-wins). The plugin mirrors each one to the proxy's
//      /__bili/plugin/session-name endpoint (pi.ts #2322 pattern) so the
//      panel labels a conversation with the host name instead of the
//      truncated first user message. Both services are optional — older
//      hosts degrade to the pre-#2604 labelless behavior, never block boot.
// Native auto-compaction stands down on BOTH planes: the INSTALLER/LAUNCHER
// patch file keeps the host-plane row at auto:false, and the always-on
// bili-compaction-gate entry (dsh-compaction-gate.ts) disables the web-profile
// PRESET instances at load time (#3354, vendored from
// deshark42/dsh-compaction-basic-disable — see dsh-compaction-disable.ts);
// this module only DECLARES that the lane is owned, so a disabled or
// kill-switched bili-native leaves the presets bootable with stock compaction
// instead of pending on a service no one provides anymore (#3662).
// dsh has no compaction event hook to observe a manual /compact, so its
// boundary is left to the kernel's natural ingest diff (#395 gap, acceptable:
// manual /compact is rare and auto mode is off).

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logHostEvent } from "./host-log.js";
import { DSH_BUILD_CHECK, emitNewerClientBuildNote, walkUpNodeModuleVersion } from "./client-build-note.js";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST, requestInstanceShutdown } from "../launcher.js";
import { isVersionNewer } from "../update.js";
import { VERSION } from "../version.js";
import { APIG_RESIGN_SCHEME, unresolvedRefusals } from "../apig-resign.js";
import { adminRelayEnabled, resolveResignSettings } from "../config.js";
import { decodeRequestBody } from "../content-encoding.js";
import { dshContextTabEnabled, dshContextTabLabel, limitsDecodedBytes } from "../knobs.js";
import { MIN_ASSUMED_WINDOW_TOKENS } from "../util.js";
import { markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, singleFlight } from "./native-bootstrap.js";
import { bodyProvablyOverWindow as sharedBodyProvablyOverWindow, installNativeFetchIntercept, liveStateSlotEffect, noteRoutedOrigin, observeRoutedOrigin, routedBiliModelUrl, type GateVerdict, type NativeInterceptState } from "./native-intercept.js";
import { asciiHeaderValue, fetchManifest, fetchProxyVersion, fetchStatus, fetchStatusLatest, forwardTool, reportAttributionHealth, reportRuntimeInfo, waitForProxyVersion, type ManifestTool } from "./shared.js";
import { createForkAdopter, sideShapedBody } from "./fork-adopt.js";
import { clearIncrementalProbe, createPrepareDirectSend, INCREMENTAL_TURN_MARKER_HEADER, INCREMENTAL_TURN_ID_HEADER, newIncrementalTurnId, noteIncrementalRejection, noteIncrementalAck, planIncrementalTurn, probeIncrementalTurns, rememberOriginalBody, sweepStale, wireMessagesLookAnthropic, type IncrementalWireMessage } from "./incremental-client.js";
import { declareDshCompactionActive, detectCompactionOverlayGap, dshCompactionGateTelemetry } from "./dsh-compaction-disable.js";
import { maskUrlForDiagnostics } from "../log-mask.js";
import { mediaBytesOfWireBody } from "./media-bytes.js";
import { conversationRecallStats, learnConversation, recallBoundaryOfMessages, recallConversation, recallHistoryFingerprints, recallLaneHasEntries, recallLaneKey } from "./conversation-recall.js";
export { sideShapedBody } from "./fork-adopt.js";
export { mediaBytesOfWireBody } from "./media-bytes.js";

export const name = "bili-native";
export const inject = ["tools", "commands", "agents"];

const RETRY_INTERVAL_MS = 10000;
/** #2082: BILI_DSH_RETRY_INTERVAL_MS — test/ops knob to shrink the retry
 *  wall without wall-clock waits (same pattern as BILI_MODEL_INFO_RETRY_MS). */
function retryIntervalMs(): number {
    const raw = process.env.BILI_DSH_RETRY_INTERVAL_MS;
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : RETRY_INTERVAL_MS;
}

// #3380 P2: a registration-failure streak doubles the back-off per step up to
// a hard cap — the incident retried an identical doomed failure on a flat 10s
// wall 145 times in an hour while the user saw nothing change. The cap (not a
// stop) keeps the loop alive for transient faults: a network blip or a slow
// manifest must still heal without user action.
const REG_RETRY_MAX_MS = 5 * 60 * 1000;
// #3380 P2: after this many consecutive failures, say it once in the user's
// face with the recovery action — silence is how the incident stayed hidden.
const REG_GIVE_UP_NOTICE_STREAK = 5;
/** #3380: capped exponential back-off for the registration-failure streak. */
function regBackoffMs(failStreak: number): number {
    const steps = Math.max(0, Math.min(failStreak - 1, 16));
    return Math.min(retryIntervalMs() * 2 ** steps, REG_RETRY_MAX_MS);
}

type AgentLike = {
    session?: {
        id?: unknown;
        // #2381: dsh-session Session surface — the EpochHeader the NEXT request
        // is compared against ({config:{provider,model,...}}). dsh-agent-loop
        // writes each step's header into the session log BEFORE its fetch, so
        // at fetch time this is exactly this request's routing. Absent on
        // older builds (duck-typed access below degrades to the global
        // selection).
        requestHeader?: () => { config?: { provider?: unknown; model?: unknown } } | undefined;
        // #2399: dsh fork children (commands.ts fork()) persist the parent
        // SessionId + isSeeded on the child's SessionHeader; isSeeded gates the
        // adoption (subagent children also carry parentSession but start from
        // a fresh task context — no replay to adopt).
        header?: { parentSession?: unknown; isSeeded?: unknown } | undefined;
    } | undefined;
};
// #1677: DSH's command executor hands the invoking agent to the handler via the
// invocation object ({ commandId, agent, rawInput, attachments, signal }) — but it
// does NOT establish the AsyncLocalStorage boundary that currentInitiator() reads,
// so command-path attribution through ALS is always empty and /acp silently fell
// back to another (most-recently-active) session's panel. The invocation is the
// authoritative "who ran this command" source. Every field is optional because older
// dsh builds may omit them and the handlers must degrade gracefully (see
// invocationSidOf's fallback chain).
type CommandInvocation = {
    commandId?: unknown;
    agent?: AgentLike | undefined;
    rawInput?: unknown;
    attachments?: unknown;
    signal?: AbortSignal | undefined;
};
type ToolExec = { agent?: AgentLike | undefined; signal?: AbortSignal };

type ToolDefinition = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: ToolExec) => Promise<unknown>;
};

type CommandOutcome = { kind: "success" | "error"; text: string };

export type PluginContext = {
    tools: { register: (definition: ToolDefinition) => unknown };
    commands: { register: (command: { name: string; description: string; handler: (invocation?: CommandInvocation) => Promise<CommandOutcome> }) => unknown };
    agents: { currentInitiator?: () => AgentLike | undefined; get?: (id: string) => AgentLike | undefined };
    // Runtime-info sources (#955), resolved via dynamic ctx.inject when the
    // host exposes them (both are core dsh services; optional so older dsh
    // builds or stripped hosts keep the plugin alive without model info).
    llm?: { resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number } | undefined> };
    agentDefaultModel?: { currentSelection?: () => { provider?: string; model?: string } | undefined };
    // #1772: boot-provided profile diagnostics ({startedBundles, ...}) — lets
    // the plugin warn when the active profile runs its compaction inside an
    // agent preset where the bundle patch cannot reach it.
    profileContext?: { startedBundles?: readonly string[] | undefined };
    inject?: (deps: readonly string[], callback: (sub: PluginContext) => void) => unknown;
    // #1809: lifecycle disposal for registrations made inside an injected
    // callback (cordis Context.effect); optional so non-cordis hosts skip it.
    effect?: (fn: () => void | (() => void), label?: string) => void;
    // #1590 host event bus + #2604 session bus (dsh-session Events): one
    // cordis ctx.on covers both shapes — webserver/index-inject gathers
    // per-startup rows for the web index (__BILI__ global for the settings
    // entry), while session/created and session/event feed the title channel.
    on?: (event: string, listener: ((table: Array<{ kind: string; name?: string; value?: unknown }>) => void) | ((session: { id?: unknown }, event: { type?: unknown; data?: { title?: unknown } }) => void) | ((raw: unknown, next: () => unknown) => unknown) | ((options: { sessionId?: unknown }, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>), options?: { global?: boolean }) => void;
    // #3354: cordis service registry — the load-time compaction-disable overlay
    // publishes its gate service here so the preset inject entries latch on it.
    // Optional: hosts without a registry skip the gate without breaking boot.
    reflect?: { provide?: (name: string, value: unknown) => void } | undefined;
    // #2604: dsh session store + title service (core services on modern
    // builds, optional so older hosts keep the plugin alive). The folded
    // snapshot seeds labels for sessions whose `session/title` events all
    // predate this process (resumes); the store lookup re-labels sids with
    // live traffic after a proxy respawn (fresh dedup key, nothing armed).
    sessions?: { get?: (id: string) => { id?: unknown } | undefined; list?: () => Array<{ id?: unknown }> };
    sessionTitle?: { get?: (session: unknown) => { title?: unknown } | undefined };
    // #1809: browser HTTP carrier (web/desktop profiles only) — hosts the live
    // /bili/origin route the settings entry polls. Optional like llm/
    // profileContext above: TUI/headless profiles lack it.
    webServer?: {
        // returns the disposer (cordis WebServer.register contract)
        register: (route: {
            kind: "exact" | "prefix";
            path: string;
            handler: (req: unknown, res: { writeHead: (status: number, headers?: Record<string, string>) => void; write?: (chunk: string | Uint8Array) => boolean; end: (body?: string | Uint8Array) => void }) => void | Promise<void>;
        }) => (() => void) | undefined;
    };
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

// One registration lifecycle per HOST CONTEXT. toolsReady is the ONLY gate
// for header stamping (pi.ts discipline): stamped headers flip the proxy into
// plugin mode, which suppresses wire tool injection — stamping before the
// local tools exist would send a tool-less request.
// #3380: registrations live in the host process's tool layer and die ONLY
// with their context (the apply() re-arm below is the sole reset). Proxy
// death merely moves the origin — the execute closures read the LIVE base
// (#983) — so proxy-death paths must NOT clear toolsReady: doing so forced a
// doomed re-registration that DSH rejects ("tool X is already registered"),
// locked the latch false forever, and silently stripped every request of its
// identity headers (wire mode → anonymous zero-fold ledgers → 413 on large
// sessions).
type RegisterState = {
    base: string | undefined;
    toolsReady: boolean;
    dead: boolean;
    retryAt: number;
    pending: Promise<void> | undefined;
    // #3380 P2: consecutive-failure bookkeeping — capped exponential back-off
    // (regBackoffMs) + the one-time "restart dsh" notice.
    failStreak: number;
    lastRegistrationError: string | undefined;
    // #3380/#3562: giveUp generation — every onGiveUp bumps this. In-flight
    // attach/recovery chains capture it at entry, so a late commit made after
    // the owner already gave up can no longer resurrect the cleared base
    // (a resurrected base stamps x-bili-plugin at a dead origin until the
    // next recovery tick).
    giveUpSeq: number;
};

const register: RegisterState = { base: undefined, toolsReady: false, dead: false, retryAt: 0, pending: undefined, failStreak: 0, lastRegistrationError: undefined, giveUpSeq: 0 };

// #3616: generation of the origin plane. Each non-off apply() (and each test
// reset) establishes a new world; an in-flight verify/spawn flight from an
// OLDER world must not land its writes on top of it — the healthy-attach
// branch used to bind register.base unconditionally, so a late probe landing
// (a slow machine mid-recovery, or a test reset that cannot cancel the chain)
// reverted the registered origin back to a stale one and tool calls followed
// it there.
let originGen = 0;

// #1797: attach/recovery chains still in flight after apply() returned — a late
// chain would clobber the shared register mid-run of whatever executes next.
const pendingChains = new Set<Promise<unknown>>();

function trackChain<T>(p: Promise<T>): Promise<T> {
    pendingChains.add(p);
    void p.then(
        () => { pendingChains.delete(p); },
        () => { pendingChains.delete(p); },
    );
    return p;
}

// #1772: once-per-process — the web-profile compaction caveat is logged a
// single time even though apply() may run again after context re-arming.
let webProfileWarned = false;

// #3651: once-per-process — the non-web-profile counterpart of the above: a
// durable trace that the #3354 load-time overlay IS registered in a profile
// that does not bundle @deepseek-ai/dsh-web-app (the web-profile note never
// fires there, leaving field verification blind).
let nonWebTraceLogged = false;

// #3380: once-per-process — the idempotent-adoption convergence notice must
// not repeat per attempt (same discipline as webProfileWarned).
// Unverified dsh client build note (#warn): once-per-process, same channel
// discipline.
let dshNewerBuildNoted = false; // #4545, once per process
let regAdoptLogged = false;

// #4545 newer-than-tested dsh client-build note (soft, never gates). Shared
// machinery AND per-lane identities live in client-build-note.ts — re-exported
// here so existing importers keep working. At-or-below-cap builds stay silent:
// known older-build break modes already have their own overlay-latch detectors
// (#3806 boot warning + #2474 fallback); only the untested-future direction is
// covered.
export { DSH_BUILD_CHECK } from "./client-build-note.js";

/** #3962: one-line overlay-coverage suffix for the durable profile notes.
 * The bundle-patch gate rows target four factory preset ids a profile may not
 * ship (their miss is visible only in the host loader log); the #4147
 * structural transform records every entry it actually rewrote on the shared
 * globalThis channel, so the note can state real coverage instead of leaving
 * the gate rows' fate implied. Best-effort by necessity: preset configs
 * resolve lazily, so "so far" is the honest frame. */
function gateCoverageSuffix(): string {
    const t = dshCompactionGateTelemetry();
    if (t === null || t.covered.length === 0) {
        return " Overlay coverage so far: no preset entry rewritten in this process (preset configs resolve lazily — zero at this point does not mean zero later).";
    }
    const entries = t.covered.map((c) => `${c.entry}\u00d7${c.rows}`).join(", ");
    return ` Overlay coverage so far: ${t.covered.length} preset ${t.covered.length === 1 ? "entry" : "entries"} rewritten (${entries}).`;
}

/** #1590/#1809: origin of the proxy as currently reachable — register.base
 *  once bound (attach synchronously, spawn after bootstrap), else the preset
 *  env origin. Shared by the index-inject row and the live /bili/origin route. */
function currentOrigin(): string | undefined {
    const envOrigin = process.env.BILLION_CONTEXT_PROXY?.trim();
    return register.base ?? (envOrigin !== undefined && envOrigin.length > 0 ? envOrigin : undefined);
}

/** #3373: the /__bili admin relay — dsh web's remote-panel path. With
 *  `security.adminRelay` on and the proxy bound, forward browser admin calls
 *  received on dsh's web entry to the loopback proxy, so a remote browser
 *  talks same-origin through the entry it already reached dsh by. The
 *  forwarded hop is a local non-browser client (loopback source, loopback
 *  Host via fetch, no Origin header), so the admin gate (#1538) holds
 *  unchanged; when the gate is off this stays a plain 404 (fail-closed). */
const RELAY_REQUEST_DROP = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
    "trailer", "transfer-encoding", "upgrade",
    // fetch re-derives these from the target; the browser's values describe
    // the entry origin and would leak host-session state into the proxy.
    "host", "origin", "cookie", "referer", "content-length", "accept-encoding",
]);
const RELAY_RESPONSE_DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);
const RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024;

type RelayRes = { writeHead: (status: number, headers?: Record<string, string>) => void; write?: (chunk: string | Uint8Array) => boolean; end: (body?: string | Uint8Array) => void };

async function relayAdminRequest(req: unknown, res: RelayRes): Promise<void> {
    const fail = (status: number, code: string): void => {
        try {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: code }));
        } catch {
            // socket already gone — nothing left to report
        }
    };
    // Fail-closed presentation first: while the gate is off the route answers
    // 404 regardless of proxy state (no state disclosure).
    if (!adminRelayEnabled()) {
        fail(404, "admin relay disabled");
        return;
    }
    const base = register.base;
    if (base === undefined) {
        fail(503, "bili proxy not running");
        return;
    }
    const rawMethod = (req as { method?: unknown }).method;
    const method = typeof rawMethod === "string" ? rawMethod : "GET";
    const rawUrl = (req as { url?: unknown }).url;
    const url = typeof rawUrl === "string" ? rawUrl : "/";
    // Contain the relay to the declared /__bili surface: fetch() normalizes
    // dot segments (literal and %2e-encoded alike), so an unchecked
    // "/__bili/.." would land on sibling paths of the loopback proxy.
    const cut = url.search(/[?#]/);
    const pathPart = cut === -1 ? url : url.slice(0, cut);
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(pathPart).replaceAll("\\", "/");
    } catch {
        fail(400, "bad request path");
        return;
    }
    if (decodedPath.split("/").includes("..")) {
        fail(400, "bad request path");
        return;
    }
    const headersIn = (req as { headers?: unknown }).headers;
    const headers: Record<string, string> = {};
    if (headersIn !== null && typeof headersIn === "object") {
        for (const [key, value] of Object.entries(headersIn as Record<string, unknown>)) {
            if (RELAY_REQUEST_DROP.has(key)) continue;
            if (typeof value === "string") headers[key] = value;
            else if (Array.isArray(value)) headers[key] = value.filter((entry): entry is string => typeof entry === "string").join(", ");
        }
    }
    let body: Uint8Array | undefined;
    if (method !== "GET" && method !== "HEAD") {
        const chunks: Buffer[] = [];
        let size = 0;
        try {
            for await (const chunk of req as AsyncIterable<unknown>) {
                const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : undefined;
                if (buf === undefined) break;
                size += buf.length;
                if (size > RELAY_MAX_BODY_BYTES) {
                    fail(413, "request body too large");
                    return;
                }
                chunks.push(buf);
            }
            body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        } catch {
            fail(400, "request body read failed");
            return;
        }
    }
    let upstream: Response;
    try {
        upstream = await fetch(`${base}${url}`, {
            method,
            headers,
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(120_000),
        });
    } catch {
        fail(502, "bili proxy unreachable");
        return;
    }
    const headersOut: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
        if (!RELAY_RESPONSE_DROP.has(key)) headersOut[key] = value;
    });
    try {
        res.writeHead(upstream.status, headersOut);
        if (upstream.body !== null) {
            if (typeof res.write === "function") {
                for await (const chunk of upstream.body) res.write(chunk);
                res.end();
            } else {
                res.end(Buffer.from(await upstream.arrayBuffer()));
            }
        } else {
            res.end();
        }
    } catch {
        // client hung up mid-stream — the upstream read dies with it
    }
}

// #2604: host-title channel (mirror of pi.ts #2322/#2354): dsh owns its
// session names; the proxy web UI labels a conversation from meta.hostTitle
// when present. Pushes are fire-and-forget, deduped per (base, sid) — a
// failed POST re-arms via map deletion, and keying on base means a
// respawned/rebound proxy re-learns every title on next traffic or event
// instead of trusting a dead origin's memory.
const lastReportedTitles = new Map<string, string>();
type DshSessionLike = { id?: unknown };
const titleServices: { sessions?: PluginContext["sessions"]; sessionTitle?: PluginContext["sessionTitle"] } = {};

function reportDshSessionName(base: string | undefined, sid: string | undefined, name: string): void {
    if (base === undefined || typeof sid !== "string" || sid.length === 0) return;
    const key = `${base}\u0000${sid}`;
    const prev = lastReportedTitles.get(key);
    if (prev === name || (name === "" && prev === undefined)) return;
    lastReportedTitles.set(key, name);
    fetch(`${base}/__bili/plugin/session-name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: sid, name }),
        signal: AbortSignal.timeout(5000),
    }).then((res) => {
        if (!res.ok) lastReportedTitles.delete(key);
    }).catch(() => {
        lastReportedTitles.delete(key);
    });
}

function seedDshSessionTitle(session: DshSessionLike): void {
    const sid = typeof session.id === "string" ? session.id : undefined;
    const get = titleServices.sessionTitle?.get;
    if (sid === undefined || typeof get !== "function") return;
    let title: unknown;
    try {
        title = get.call(titleServices.sessionTitle, session)?.title;
    } catch {
        return;
    }
    if (typeof title === "string" && title.length > 0) reportDshSessionName(register.base, sid, title);
}

// Lazy re-label for a sid with live traffic but no reported title yet: covers
// resumed sessions whose title predates this process and proxies that replaced
// a dead one since the last event (fresh base = fresh dedup key, nothing armed).
function ensureDshTitleReported(sid: string): void {
    const base = register.base;
    if (base === undefined || lastReportedTitles.has(`${base}\u0000${sid}`)) return;
    const lookup = titleServices.sessions?.get;
    if (typeof lookup !== "function") return;
    let session: DshSessionLike | undefined;
    try {
        session = lookup.call(titleServices.sessions, sid);
    } catch {
        return;
    }
    if (session !== undefined) seedDshSessionTitle(session);
}

function sweepLiveDshTitles(): void {
    const list = titleServices.sessions?.list;
    if (typeof list !== "function") return;
    let sessions: Array<DshSessionLike>;
    try {
        sessions = list.call(titleServices.sessions);
    } catch {
        return;
    }
    for (const session of sessions) seedDshSessionTitle(session);
}

// Runtime-info cache (#955, rekeyed per model in #2381): one entry per
// (provider, model) the host actually routes — what ctx.llm resolved for it
// (contextWindow / defaultMaxTokens). Written by async refreshes; read
// synchronously by headersFor on every model request. The pre-#2381 single
// slot tracked the GLOBAL agent default selection while headersFor ran under
// a SESSION initiator: a session on another model stamped the default model's
// name, the proxy's exact-match gate discarded the whole header channel, and
// the window fell to the unconfigured fallback. Per key, an entry can only
// ever hold its own key's numbers, so a foreign model's window can never land
// on another model's request.
type ModelInfoEntry = { provider: string; model: string; contextWindow?: number; maxOutput?: number };
const MODEL_INFO_CACHE_CAP = 32;
// #1812: retry cadence for window resolves that failed (or resolved without a
// window). The pre-#1812 code cached {provider, model} on failure and the
// early-return below then NEVER re-resolved — one boot-time race (catalog
// still loading) silently stripped x-bili-plugin-context-window from every
// request of the whole process lifetime, and the proxy sized the session
// against its unconfigured fallback. A failed resolve now retries after this
// cooldown instead of latching.
const MODEL_INFO_RETRY_COOLDOWN_MS = 30_000;
function modelInfoRetryCooldownMs(): number {
    // BILI_MODEL_INFO_RETRY_MS: test hook to exercise the retry cadence without wall-clock waits.
    const raw = process.env.BILI_MODEL_INFO_RETRY_MS;
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : MODEL_INFO_RETRY_COOLDOWN_MS;
}
const modelInfo: {
    byKey: Map<string, ModelInfoEntry>;
    refreshingKeys: Set<string>;
    retryAtByKey: Map<string, number>;
    services?: { llm?: PluginContext["llm"]; agentDefaultModel?: PluginContext["agentDefaultModel"] };
} = { byKey: new Map(), refreshingKeys: new Set(), retryAtByKey: new Map() };

function modelInfoKey(provider: string, model: string): string {
    return `${provider}\u0000${model}`;
}

function evictModelInfoEntries(): void {
    while (modelInfo.byKey.size > MODEL_INFO_CACHE_CAP) {
        const oldest = modelInfo.byKey.keys().next().value;
        if (oldest === undefined) break;
        modelInfo.byKey.delete(oldest);
        modelInfo.retryAtByKey.delete(oldest);
    }
}

function normalizeModelTarget(provider: unknown, model: unknown): { provider: string; model: string } | undefined {
    if (typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0) {
        return { provider, model };
    }
    return undefined;
}

// #2381: the model THIS request routes to — the session's own live header
// first (exact at fetch time, correct across per-session model switches), the
// host's global default selection only as fallback. Any miss degrades to
// pre-#2381 behavior; it never yields a wrong model.
function sessionModelTargetOf(ctx: PluginContext): { provider: string; model: string } | undefined {
    try {
        const init = ctx.agents?.currentInitiator?.();
        const header = init?.session?.requestHeader?.();
        return normalizeModelTarget(header?.config?.provider, header?.config?.model);
    } catch {
        return undefined;
    }
}

function globalModelTarget(svc: { agentDefaultModel?: PluginContext["agentDefaultModel"] } | undefined): { provider: string; model: string } | undefined {
    try {
        const sel = svc?.agentDefaultModel?.currentSelection?.();
        return normalizeModelTarget(sel?.provider, sel?.model);
    } catch {
        return undefined;
    }
}

// #2924: the context window the gate's oversize arm compares against — the
// SAME resolution headersFor stamps (#2381: the session's live model first,
// the host's global default as fallback, cached model info only). A miss
// anywhere disables the size arm; it must never yield a wrong model's window.
function effectiveContextWindow(ctx: PluginContext): number | undefined {
    const target = sessionModelTargetOf(ctx) ?? globalModelTarget(modelInfo.services);
    if (target === undefined) return undefined;
    return modelInfo.byKey.get(modelInfoKey(target.provider, target.model))?.contextWindow;
}

// Gate face of the shared doom math (#4111/#4516): keeps the gate's
// init-body signature for its call sites and tests, decoding init.body into
// the raw string the shared form (native-intercept.ts) prices with the
// media-aware walk (media-bytes.ts).
function rawBodyStringOf(init: RequestInit | undefined): string | undefined {
    const body: unknown = init?.body;
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
        try {
            return new TextDecoder().decode(body instanceof Uint8Array ? body : new Uint8Array(body));
        } catch {
            // #4912: undecodable buffer (>V8-max-string-length throws
            // RangeError) → undefined; sharedBodyProvablyOverWindow then
            // bills ALL bytes as core text (media=0) — the conservative
            // refusal direction, same convention as no-init call sites.
            return undefined;
        }
    }
    return undefined;
}

export function bodyProvablyOverWindow(
    body: { bytes: number } | undefined,
    init: RequestInit | undefined,
    declaredWindow: number | undefined,
): ReturnType<typeof sharedBodyProvablyOverWindow> {
    return sharedBodyProvablyOverWindow(body?.bytes, rawBodyStringOf(init), declaredWindow);
}

function refreshModelInfo(origin: string | undefined, target?: { provider: string; model: string }): void {
    const svc = modelInfo.services;
    if (svc === undefined) return;
    const sel = target ?? globalModelTarget(svc);
    if (sel === undefined) return;
    const provider = sel.provider;
    const model = sel.model;
    const key = modelInfoKey(provider, model);
    // #1812: a cached entry is final only when it actually carries a
    // window (or the service has no resolver at all). A failure-shaped cache
    // ({provider, model}, no contextWindow) retries after the cooldown.
    const cached = modelInfo.byKey.get(key);
    if (cached !== undefined && cached.contextWindow !== undefined) return;
    const retryAt = modelInfo.retryAtByKey.get(key);
    if (cached !== undefined && retryAt !== undefined && Date.now() < retryAt) return;
    if (modelInfo.refreshingKeys.has(key)) return;
    // The host registers llm as a service object, so resolveModelInfo needs its
    // receiver; called detached below, this threw
    // "Cannot read properties of undefined (reading 'resolveModelInfoFor')"
    // for every provider and model, and the failure-shaped cache (#1812) then
    // left the process without x-bili-plugin-context-window.
    const resolve = svc.llm?.resolveModelInfo?.bind(svc.llm);
    if (resolve === undefined) {
        modelInfo.byKey.set(key, { provider, model });
        evictModelInfoEntries();
        return;
    }
    modelInfo.refreshingKeys.add(key);
    modelInfo.retryAtByKey.set(key, Date.now() + modelInfoRetryCooldownMs());
    void Promise.resolve()
        .then(() => resolve(provider, model))
        .then((info) => {
            // Per-key commit (#2381): the entry belongs to its OWN key, so a
            // model switch mid-resolve can no longer strand or clobber it —
            // stamping reads only the live request's key, and a switched-away
            // model's numbers stay parked under their own key (#956's
            // user-visible contract, now structural instead of guarded).
            modelInfo.byKey.set(key, {
                provider,
                model,
                contextWindow: typeof info?.context?.contextWindow === "number" && info.context.contextWindow > 0 ? Math.floor(info.context.contextWindow) : undefined,
                // #2904: forwarded verbatim from the host's defaultMaxTokens — bili never
                // guesses. An undeclared custom model yields undefined here, emptying the
                // ceiling chain (poisoned high-water, max-tokens truncation); fix home is
                // DSH-side (report its configured default). See TECHNICAL-NOTES.md.
                maxOutput: typeof info?.defaultMaxTokens === "number" && info.defaultMaxTokens > 0 ? Math.floor(info.defaultMaxTokens) : undefined,
            });
            evictModelInfoEntries();
            if (modelInfo.byKey.get(key)?.contextWindow !== undefined) modelInfo.retryAtByKey.delete(key);
        })
        .catch(() => {
            // Resolution failed (transient catalog read, model offline): keep
            // the model id (usable for registry lookup) without window claims.
            modelInfo.byKey.set(key, { provider, model });
            evictModelInfoEntries();
        })
        .finally(() => {
            modelInfo.refreshingKeys.delete(key);
            const entry = modelInfo.byKey.get(key);
            if (entry !== undefined && origin !== undefined) {
                void reportRuntimeInfo(origin, {
                    agent: "dsh",
                    model: entry.model,
                    contextWindow: entry.contextWindow,
                    maxOutput: entry.maxOutput,
                    source: "client-config",
                }).catch(() => {});
            }
        });
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// #1158/#2831: GUI hosts swallow process stderr, so a bootstrap failure that
// only console.errors vanishes together with the symptom it causes (silent
// direct-send degradation — zero interception, zero trace). Append the fact
// to the shared bili.log in the proxy's own line shape, origin-marked
// [dsh-client]. Best-effort semantics, line grammar and rotation safety live
// in host-log.ts (#2827).
export function persistClientEvent(msg: string): void {
    logHostEvent("warn", "[dsh-client]", msg);
}

async function bootstrap(): Promise<string | undefined> {
    // #3616: superseded flights must not bind the newer world's origin plane.
    const gen = originGen;
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "dsh" },
            { scriptPath: nativeProxyScriptPath() },
        );
        if (gen !== originGen) return handle.origin;
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
        // #4811: a one-shot bootstrap failure must not become permanent. Plan-time
        // arming normally covers this, but this is where the failure IS KNOWN —
        // arm the recovery driver here so a base-less register always has a
        // re-spawn loop behind it. Idempotent; the timer clears itself once
        // healthy again (#4755 clear condition).
        armRecoveryTimer();
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
 *  keeps re-probing through the respawn hook). Exported for tests, like the
 *  omp/pi/opencode lanes' twins: the pinned-attach version decision (#3544) is
 *  driven hermetically against a version-controllable resident. */
export async function verifyAttachAndRecover(attachOrigin: string): Promise<string | undefined> {
    const seqAtEntry = register.giveUpSeq;
    // #3616: capture this flight's world — an apply() re-arm (or a test reset)
    // while any await below is pending supersedes the flight; its landings must
    // not write the newer world's register/state.
    const gen = originGen;
    // #1365: routed evidence outranks the planned origin — probe where the
    // model channel actually points, not where the env says it should. An
    // EXPLICIT BILLION_CONTEXT_ATTACH outranks both: it names the plugin API
    // endpoint directly, and a routed model origin may be a plain model-only
    // path (e.g. an admin-gated port) that never exposes the plugin manifest.
    const explicitAttachOrigin = nativeAttachOrigin(process.env);
    const home = explicitAttachOrigin ?? state.routedOrigin ?? attachOrigin;
    const version = await fetchProxyVersion(home).catch(() => undefined);
    if (gen !== originGen) return undefined;
    if (version !== undefined) {
        // #3544: healthy is NOT sufficient — a STRICTLY OLDER build is never
        // replaced by waiting (its fingerprint differs, so no bring-up can
        // attach or reuse it either, and the detached process outlives every
        // app restart). Rotate it out, then take the same spawn-fallback
        // transition as a dead target. Equal or newer versions — and versions
        // too malformed to compare (isVersionNewer → false) — attach exactly
        // as before; an unreachable target (no version at all) takes the
        // dead-target path below.
        if (!isVersionNewer(VERSION, version)) {
            if (seqAtEntry !== register.giveUpSeq) return undefined;
            // #1130: restore the interceptor's readyOrigin short-circuit — a
            // runtime recovery clears state.origin before re-probing, and a
            // transient blip must not leave it dangling.
            state.origin = home;
            register.base = home;
            return home;
        }
        persistClientEvent(`attach target ${home} runs v${version} (ours v${VERSION}) — requesting its graceful shutdown before spawning the current build`);
        const rotated = await rotatePinnedStaleProxy(home);
        if (gen !== originGen) return undefined;
        if (!rotated) {
            if (seqAtEntry !== register.giveUpSeq) return undefined;
            persistClientEvent(`attach target ${home} did not exit after /__bili/shutdown (older build or hung drain) — attaching anyway; kill its process manually for the update to take effect`);
            state.origin = home;
            register.base = home;
            return home;
        }
        return spawnFallback(attachOrigin, `attach target ${home} rotated out (was v${version}) — spawning the current build`, gen);
    }
    const pinned = explicitAttachOrigin ?? state.routedOrigin ?? (await observeRoutedOrigin(state));
    if (gen !== originGen) return undefined;
    if (pinned !== undefined) {
        const back = await waitForProxyVersion(pinned);
        if (gen !== originGen) return undefined;
        if (back !== undefined) {
            if (seqAtEntry !== register.giveUpSeq) return undefined;
            state.origin = back;
            register.base = back;
            persistClientEvent(`attach target ${pinned} recovered while waiting — attached, no second instance spawned`);
            return back;
        }
        persistClientEvent(
            explicitAttachOrigin !== undefined
                ? `explicit attach target ${pinned} unreachable within the health deadline — NOT spawning a second instance; re-checks continue`
                : `attach target ${pinned} unreachable within the health deadline — NOT spawning a second instance (model channel is pinned to it); re-checks continue`,
        );
        // #3380: only the origin dies here — the host-context tool
        // registrations survive, so toolsReady stays put.
        if (landingOwnsRegister(attachOrigin)) {
            register.base = undefined;
            register.retryAt = 0;
        }
        return undefined;
    }
    return spawnFallback(attachOrigin, `attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`, gen);
}

/** Shared "bring up our own proxy" tail of verifyAttachAndRecover (#3544):
 *  extracted so a ROTATED-AWAY stale target takes the same transition a DEAD
 *  target always took — identical unfreeze semantics and respawn bookkeeping.
 *  `gen` is the caller flight's #3616 world — the landing writes nothing when
 *  that world was superseded mid-spawn. */
async function spawnFallback(attachOrigin: string, note: string, gen: number): Promise<string | undefined> {
    persistClientEvent(note);
    // Unfreeze: only the preset (BILLION_CONTEXT_PROXY) freezes future
    // plans; an explicit BILLION_CONTEXT_ATTACH never touches the preset.
    delete process.env.BILLION_CONTEXT_PROXY;
    state.attach = false;
    if (state.origin === attachOrigin) state.origin = undefined;
    markNativeHost(process.env, "dsh");
    const start = singleFlight(_spawnForTest ?? bootstrap);
    state.respawn = start;
    state.onGiveUp = fireGiveUp;
    const landed = start().then((origin) => {
        // #3616: superseded while spawning — report the landing, write nothing.
        if (gen !== originGen) return origin;
        if (origin === undefined) {
            if (landingOwnsRegister(attachOrigin)) {
                register.base = undefined;
                // A back-off armed against the stale base must die with it:
                // the unfreeze is a one-shot transition to a fresh base-less
                // world and must not inherit the old base's 10s wall (#1783).
                register.retryAt = 0;
            }
            return undefined;
        }
        // A fresh spawn landing is live by construction — no giveUp may
        // invalidate it: the self-heal contract (#983/#1783) requires exactly
        // this late landing to re-base a given-up register.
        if (landingOwnsRegister(attachOrigin)) {
            register.base = origin;
            state.origin = origin;
        }
        return origin;
    });
    state.ready = landed;
    return landed;
}

const PINNED_ROTATION_WAIT_MS = 12_000;
const PINNED_ROTATION_POLL_MS = 500;

let pinnedRotationWaitMs = PINNED_ROTATION_WAIT_MS;
/** #5167 test seam: shrink the rotation deadline so negative cases (a
 *  resident that never releases the port) run in milliseconds instead of 12s. */
export function _setPinnedRotationWaitForTest(ms: number): void {
    pinnedRotationWaitMs = ms;
}

/** Pinned-attach twin of the launcher's discovery-path rotation (#3544): ask
 *  the strictly-older resident to drain+exit, then wait for the port. True
 *  only when the target stopped accepting FRESH connections (its listener
 *  closed — the port-release signal), NOT when it stopped answering pooled
 *  keep-alive sockets: post-#3890 a draining resident keeps serving pooled
 *  sockets for up to (1+10)×10s while its listener is already gone (#5167). */
export async function rotatePinnedStaleProxy(origin: string): Promise<boolean> {
    if (!(await requestInstanceShutdown(origin))) return false;
    const deadline = Date.now() + pinnedRotationWaitMs;
    for (;;) {
        // #5167: Connection: close → undici never reuses a pooled socket for
        // this poll, so "answers" means "the listener still accepts" — exactly
        // what must be false before the caller may spawn onto the freed port.
        const v = await fetchProxyVersion(origin, { headers: { connection: "close" } }).catch(() => undefined);
        if (v === undefined) return true;
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, PINNED_ROTATION_POLL_MS));
    }
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
            const out = await forwardTool(base, sid, tool.name, args, exec.signal, true);
            // #2204: dsh tool results are plain strings — a business failure
            // throws so the host renders an error, not success text.
            if (out.failed) throw new Error(out.text);
            return out.text;
        },
    };
}

/** Stale-landing guard (windows-22 CI #1783): async chains armed by
 *  verifyAttachAndRecover resolve long after they started (probe + evidence
 *  grace + spawn). While they were in flight, maybeRetry may have already
 *  self-healed the register onto a NEW origin — a late landing must never
 *  clobber that. A landing may only write the register while it still owns
 *  it: base is undefined (nothing better established) or still the stale
 *  origin this chain set out to replace. */
function landingOwnsRegister(staleOrigin: string | undefined): boolean {
    return register.base === undefined || register.base === staleOrigin;
}

/** #4125: the give-up line must name WHY nothing was routable — the bare
 *  sentence left users unable to self-diagnose (which branch failed: dead
 *  proxy, saturated proxy, failed spawn, or a send failure with no
 *  replacement). The interceptor sets state.lastUnavailableReason right
 *  before firing us; when it is absent we keep the original wording rather
 *  than invent a reason. */
function fireGiveUp(): void {
    const reason = state.lastUnavailableReason;
    persistClientEvent(reason === undefined
        ? "proxy respawn gave up — model traffic goes direct (uncompressed)"
        : `proxy respawn gave up — model traffic goes direct (uncompressed): ${reason}`);
    // #3380: only the origin dies here — the host-context tool
    // registrations survive, so toolsReady stays put.
    register.base = undefined;
    // #3562: invalidate in-flight attach chains started before this
    // giveUp — their late commits must not resurrect the base.
    register.giveUpSeq++;
    // #4755: the give-up is the moment the driver must start — degraded model
    // traffic never reaches headersFor (origin resolution fails first), so
    // without this arm nothing re-drives the respawn loop until an /acp
    // command or a host restart. Once a base lands again, the tick's healthy
    // gate clears the timer by itself.
    armRecoveryTimer();
}

async function registerTools(ctx: PluginContext): Promise<void> {
    if (register.pending !== undefined) return register.pending;
    const base = register.base;
    if (register.toolsReady || base === undefined) return;
    register.pending = (async () => {
        const tools = await fetchManifest(base, "anthropic");
        // #2082: land on the CURRENT context, not the one that started this
        // flight — a re-activation mid-fetch must not register into (or die
        // on) the deactivated context captured at call time.
        const target = activeCtx ?? ctx;
        let adopted = 0;
        for (const tool of tools) {
            try {
                target.tools.register(toolDefinition(tool));
            } catch (err) {
                // #3380: idempotent adoption — a name this process ALREADY
                // holds in the host tool layer throws "already registered";
                // that registration is exactly what we want, so skip it and
                // register the rest (also converges a partial registration
                // left by an earlier interrupted flight).
                if (!errMessage(err).includes("already registered")) throw err;
                adopted += 1;
            }
        }
        if (adopted > 0 && !regAdoptLogged) {
            regAdoptLogged = true;
            persistClientEvent(`tool registration adopted ${adopted} pre-existing registration(s) from this process — continuing`);
        }
        register.toolsReady = true;
        register.failStreak = 0;
        register.lastRegistrationError = undefined;
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
            // #3380 P2: consecutive failures escalate — capped exponential
            // back-off (a flat wall retried the incident's identical doomed
            // failure 145×/h) and a one-time loud notice with the recovery
            // action. Retries NEVER stop: a transient fault must still heal
            // (#983/#2082 — permanent non-recovery was the original bug class).
            register.failStreak += 1;
            register.lastRegistrationError = errMessage(err);
            if (register.failStreak === REG_GIVE_UP_NOTICE_STREAK) {
                persistClientEvent(`bili tools still unavailable after ${register.failStreak} failed registrations (last: ${register.lastRegistrationError}) — model requests ride bili WITHOUT identity headers (wire mode: no compression, anonymous sessions). Restart dsh to restore; retries continue in the background.`);
            }
            // Scope the back-off to the base that actually failed: if the
            // register moved on while this manifest fetch was in flight (the
            // apply chain unfroze a dead preset, maybeRetry healed elsewhere),
            // an armed retryAt would gate the NEXT base's first heal behind a
            // 10s wall — exactly the windows-22 CI deadlock (#1783).
            if (register.base === base) register.retryAt = Date.now() + regBackoffMs(register.failStreak);
            persistClientEvent(`manifest registration failed (${errMessage(err)}) — retrying; requests stay in wire mode until it succeeds`);
        })
        .finally(() => {
            register.pending = undefined;
        });
    return register.pending;
}

// #2082: recovery retries are traffic-driven (headersFor on model
// requests, statusOutcome on /acp). When the user goes idle — or the model
// already gave up on the missing tools, exactly the #2082 report — nothing
// re-arms them, so a proxy that recovered in the meantime sits unused until
// the next request. A detached repeating timer keeps the loop running while
// the tools are down and clears itself on the first healthy (or dead) tick.
// BILI_DSH_RECOVERY_INTERVAL_MS: test hook to shrink the cadence (also an
// ops knob); absent it tracks RETRY_INTERVAL_MS. Tests that do not opt in
// never start a timer at all (NODE_TEST_CONTEXT guard keeps suites quiet).
let recoveryTimer: NodeJS.Timeout | undefined;
// #2082: the LATEST context seen by apply()/maybeRetry. Every async recovery
// path (the timer tick below, an in-flight registration landing after a
// re-activation) must resolve its context at landing time, not from a capture
// taken when the retry was armed — a captured context may already be
// deactivated by then (dsh reload / profile switch), and registering into it
// throws "inactive context" and would re-poison register.dead, exactly what
// this fix removes.
let activeCtx: PluginContext | undefined;
function recoveryIntervalMs(): number {
    const raw = process.env.BILI_DSH_RECOVERY_INTERVAL_MS;
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : RETRY_INTERVAL_MS;
}
function armRecoveryTimer(): void {
    if (recoveryTimer !== undefined) return;
    if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.BILI_DSH_RECOVERY_INTERVAL_MS === undefined) return;
    recoveryTimer = setInterval(() => {
        // #4755: a given-up register is base-less while toolsReady stays true
        // (#3380: tool registrations survive proxy death) — clearing on
        // toolsReady alone disarmed the driver in exactly that state, leaving
        // a given-up lane with no self-heal until an /acp command or a host
        // restart. Healthy means tools ready AND a live base.
        if (register.dead || (register.toolsReady && register.base !== undefined)) {
            if (recoveryTimer !== undefined) clearInterval(recoveryTimer);
            recoveryTimer = undefined;
            return;
        }
        const ctx = activeCtx;
        if (ctx !== undefined) maybeRetry(ctx);
    }, recoveryIntervalMs());
    recoveryTimer.unref?.();
}

function maybeRetry(ctx: PluginContext): void {
    activeCtx = ctx;
    // #3380: the base-less state heals through the RESPAWN branch below even
    // when toolsReady is true (registrations survive proxy death) — gating on
    // toolsReady alone would strand a given-up register with no driver left.
    if (!register.dead && (register.base === undefined || !register.toolsReady)) armRecoveryTimer();
    if (register.dead) return;
    if (register.base !== undefined && register.toolsReady) return;
    if (register.pending !== undefined) return;
    if (Date.now() < register.retryAt) return;
    if (register.base === undefined) {
        // #983: a failed respawn (onGiveUp) left the register base-less —
        // without this branch the plugin never recovers and tools die for
        // good. Self-heal: re-arm the respawn every retry interval until a
        // proxy comes back (attach mode arms one since #1130).
        let respawn = state.respawn;
        if (respawn === undefined) {
            // #2082: nothing armed the respawn hook — a plan edge (attach
            // landing after a dead spawn chain) or an apply() that ran under
            // the NODE_TEST_CONTEXT spawn guard. A base-less register with no
            // respawn armed stays dead forever; arm the fallback here so the
            // retry chain below has something to drive.
            if (_spawnForTest === undefined && process.env.NODE_TEST_CONTEXT !== undefined) return;
            respawn = singleFlight(_spawnForTest ?? bootstrap);
            state.respawn = respawn;
        }
        register.retryAt = Date.now() + retryIntervalMs();
        // #3616: same supersession rule as bootstrap()'s own guard — a
        // self-heal flight that started in a previous origin world must not
        // bind its (possibly stale) origin onto the current world's register
        // when it lands. bootstrap()'s `if (gen !== originGen) return
        // handle.origin` only covers its OWN writes; this .then wrote the
        // returned origin unconditionally, so the guard was bypassed here.
        const gen = originGen;
        void trackChain(respawn())
            .then((origin) => {
                if (origin === undefined) return;
                if (gen !== originGen) return;
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

// #4082: session identity carried by the REQUEST OBJECT, not the async chain.
// dsh's `llm/stream` waterfall stamps `options.sessionId` on every model
// dispatch — the main loop's buildRequest, the compaction side-calls, the
// session-title lane — and re-stamps it on every retry re-send (retry is a
// `step()` `continue`, not an external queue). The LlmRuntime class documents
// the waterfall as THE interception point, and first-party plugins
// (dsh-session-checkpoint-policy) already listen there. Wrapping each
// stream's iteration in OUR scope gives the adapter's internal fetches an
// id that cannot be lost to chain shape: agentless side-calls (no initiator
// but a sessionId), disposed initiator scopes (currentInitiator throws), or
// host runtime gaps that reroute the ambient context.
// #4491: the same options also carry the host session message ids
// (`options.messages[].id` — dsh stamps a stable UUID on every message),
// so the scope payload grew from a bare sid into { sid, msgIds } and the
// incremental conversion can pin the turn's messages to the host's own
// identity (server-side canonical rows keyed by msgIds instead of
// content-derived hashes). All-or-nothing per dispatch: a sidecar whose
// messages carry no ids (compaction/title shapes) captures none, and the
// field simply stays off that turn — degradation, never a guess.
interface LlmDispatchScope {
    sid: string;
    msgIds: string[] | undefined;
}
const dispatchScope = new AsyncLocalStorage<LlmDispatchScope>();

let noticedScopedAttribution = false;

/** #4491: extract the host message ids from llm/stream `options.messages`,
 *  all-or-nothing. Mirrors validateMsgIds in src/msgid-pin.ts (the 400-class
 *  conditions — bad entry, reserved prefix, control/space, duplicate) so a
 *  hostile/odd host id can never hard-fail the turn; the host-side helper
 *  must not import server modules (same discipline as the marker-header
 *  twin in incremental-client.ts), so the constants are duplicated — keep
 *  them in sync. The COUNT check is deliberately absent: alignment against
 *  the actually-sent wire messages happens at send time (maybeIncrementalNative).
 */
function hostMsgIdsOf(messages: unknown): string[] | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
        if (m === null || typeof m !== "object") return undefined;
        const id = (m as { id?: unknown }).id;
        if (typeof id !== "string" || id.length === 0 || id.length > 512) return undefined;
        if (id.startsWith("acp_summary_")) return undefined; // kernel anchor namespace
        if (/[\s\p{C}]/u.test(id)) return undefined;
        if (seen.has(id)) return undefined;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

/** Re-enter the dispatch scope on every iterator advance: generator bodies
 *  resume in the consumer's dynamic context, so each `next()` must run the
 *  adapter's continuation (its awaits, and any fetches it starts) inside the
 *  same scope the dispatch carried. */
function wrapScopedIterable<T>(iter: AsyncIterable<T>, scope: LlmDispatchScope): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator]: () => {
            const it = iter[Symbol.asyncIterator]();
            const run = <R>(op: () => Promise<R>): Promise<R> => dispatchScope.run(scope, op);
            return {
                next: () => run(() => it.next()),
                return: (value?: unknown) => run(() => it.return !== undefined ? it.return(value as never) : Promise.resolve({ done: true, value: value as T })),
                throw: (reason?: unknown) => run(() => it.throw !== undefined ? it.throw(reason as never) : Promise.reject(reason)),
            };
        },
    };
}

function attributionOf(ctx: PluginContext): GateAttribution {
    // #4082: the llm/stream-carried sid outranks the ambient initiator — it
    // is the dispatch's own truth (the loop stamps the session it is
    // driving), and it survives exactly the shapes the ambient reading does
    // not (agentless compaction/title lanes, disposed scopes, retried
    // re-sends whose initiator scope went away between attempts).
    const scoped = dispatchScope.getStore();
    if (scoped !== undefined && scoped.sid.length > 0) {
        if (!noticedScopedAttribution) {
            noticedScopedAttribution = true;
            persistClientEvent("bili-native-dsh: llm/stream attribution active — session id rides the request object (#4082)");
        }
        return { state: "ok", sid: scoped.sid };
    }
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

// #2399: dsh fork-child adoption. A dsh fork child (header.isSeeded === true
// with a parentSession) replays its parent's event prefix; without adoption
// the replay lands as a brand-new conversation and preflight refolds the whole
// inherited history from scratch (#2383). The beforeSend hook below adopts the
// parent's compression state via the plugin fork protocol BEFORE the child's
// first stamped model request, so the very request that carries the replay
// already rides the inherited folds. The bookkeeping (once per sid, transient
// retry cap, single-flight) lives in the shared createForkAdopter coordinator
// (src/agent/fork-adopt.ts).
const dshForkAdopter = createForkAdopter((line) => {
    persistClientEvent(`bili-native-dsh: ${line}`);
});

// #4215/C10a: structured diagnostics for every skipped fork-adoption entry
// gate. The #4215 incident (seeded child with the correct parentSession, ZERO
// adoption trace in the whole log) showed that silent early returns make the
// fired predicate undiagnosable after the fact: this path had eight ways out
// and none of them wrote anything, so "not a fork" vs "a fork we could not
// see" was unanswerable from the log. The verdict names every shape; the
// caller warns once per session for seeded candidates blocked at a gate and
// notes the ambient-blind shapes ONCE per process (they fire on every
// agentless dispatch — title lanes, disposed scopes — so per-request lines
// would be pure noise). Plain non-fork traffic stays completely silent.
export type ForkChildSkipReason =
    | "initiator-threw"
    | "initiator-missing"
    | "session-missing"
    | "sid-missing"
    | "header-missing"
    | "not-seeded"
    | "parent-missing"
    | "parent-is-self";

export type ForkChildVerdict =
    | { ok: true; sid: string; parent: string }
    | { ok: false; reason: ForkChildSkipReason; sid?: string; detail?: string };

/** A seeded fork child of the current initiator, or the named reason it is
 *  not (or cannot be determined). The fork gate is header.isSeeded === true
 *  (set only by dsh's fork seed path): subagent sessions carry parentSession
 *  WITHOUT isSeeded — they run fresh task contexts, never replay the parent
 *  history, and must NOT inherit ("not-seeded" is intentional and stays
 *  silent — it is the documented majority of all traffic). */
export function forkChildVerdict(ctx: PluginContext): ForkChildVerdict {
    let init: AgentLike | undefined;
    let session: AgentLike["session"] | undefined;
    let threw: string | undefined;
    try {
        init = ctx.agents?.currentInitiator?.();
        session = init?.session;
    } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
    }
    if (session === undefined || session === null) {
        // #4424/#4082: the ambient initiator lost the chain (disposed scope,
        // agentless side lane) — the llm/stream scope may still carry the
        // dispatch's sid; resolve the session through it before naming a
        // blind shape. The lookup fails closed (#4424: a throwing or absent
        // agents.get must not break the gate — it just cannot help).
        try {
            const scopedSid = sessionIdOf(ctx);
            if (scopedSid !== undefined) {
                const scoped = ctx.agents?.get?.(scopedSid)?.session;
                if (scoped !== undefined && scoped.id === scopedSid) session = scoped;
            }
        } catch {
            /* fail closed: the scoped lookup is best-effort */
        }
    }
    if (session === undefined || session === null) {
        if (threw !== undefined) return { ok: false, reason: "initiator-threw", detail: threw };
        if (init === undefined || init === null) return { ok: false, reason: "initiator-missing" };
        return { ok: false, reason: "session-missing" };
    }
    const sid = typeof session.id === "string" && session.id.length > 0 ? session.id : undefined;
    if (sid === undefined) return { ok: false, reason: "sid-missing" };
    if (session.header === undefined) return { ok: false, reason: "header-missing", sid };
    const parent = session.header.parentSession;
    if (session.header.isSeeded !== true) return { ok: false, reason: "not-seeded", sid };
    if (typeof parent !== "string" || parent.length === 0) return { ok: false, reason: "parent-missing", sid };
    if (parent === sid) return { ok: false, reason: "parent-is-self", sid };
    return { ok: true, sid, parent };
}

const forkGateNoted = new Set<string>();
let noticedForkBlindSpot = false;

function noteForkGateOnce(key: string, level: "info" | "warn", line: string): void {
    if (forkGateNoted.has(key)) return;
    forkGateNoted.add(key);
    logHostEvent(level, "[dsh-client]", line);
}

function noteForkVerdict(verdict: Extract<ForkChildVerdict, { ok: false }>): void {
    switch (verdict.reason) {
        case "not-seeded":
            return; // intentional non-inheritance — see forkChildVerdict
        case "parent-missing":
            noteForkGateOnce(`lineage:${verdict.sid}`, "warn",
                `bili-native-dsh: fork adoption for ${verdict.sid} skipped — the session header says isSeeded but carries no usable parentSession; the child starts without inherited compression state (#4215)`);
            return;
        case "parent-is-self":
            noteForkGateOnce(`lineage:${verdict.sid}`, "warn",
                `bili-native-dsh: fork adoption for ${verdict.sid} skipped — the session header carries its own id as parentSession; the child starts without inherited compression state (#4215)`);
            return;
        default: {
            // Blind shapes: the ambient read could not determine whether this
            // dispatch was a seeded fork child at all. Once per process — these
            // fire on EVERY agentless dispatch, so per-request lines would be
            // noise. The scoped-attribution state is part of the message: with
            // #4082 active the sid rides the request object while fork
            // detection still reads only the ambient initiator — that split is
            // exactly what #4215 needs named in the log (C10b).
            if (noticedForkBlindSpot) return;
            noticedForkBlindSpot = true;
            // #4491 generalized the scope to LlmDispatchScope (dispatchScope);
            // scoped attribution is active when that store carries a sid.
            const scopedStore = dispatchScope.getStore();
            const scopedActive = scopedStore !== undefined && typeof scopedStore.sid === "string" && scopedStore.sid.length > 0;
            const shape =
                verdict.reason === "initiator-threw" ? `threw (${verdict.detail ?? "unknown"})`
                    : verdict.reason === "initiator-missing" ? "returned no agent"
                        : verdict.reason === "session-missing" ? "the agent has no session"
                            : verdict.reason === "sid-missing" ? "the session has no usable id"
                                : "the session has no epoch header";
            logHostEvent("info", "[dsh-client]",
                `bili-native-dsh: fork discovery blind on this dispatch — ambient currentInitiator ${shape}${scopedActive ? "; scoped llm/stream attribution WAS active but fork detection does not use it yet (#4082)" : ""}; a seeded fork child dispatched this way leaves NO adoption trace (#4215)`);
        }
    }
}

// #4829: the content-encoding header across every shape fetch accepts
// (Headers instance, [name, value] pairs, name → value record). Case-
// insensitive; malformed shapes yield undefined = "no encoding declared".
function contentEncodingOf(init: RequestInit | undefined): string | undefined {
    const headers = init?.headers;
    if (headers === undefined || headers === null) return undefined;
    try {
        if (typeof (headers as Headers).get === "function") {
            const v = (headers as Headers).get("content-encoding");
            return v === null ? undefined : v;
        }
    } catch {
        return undefined;
    }
    if (Array.isArray(headers)) {
        for (const pair of headers) {
            if (Array.isArray(pair) && pair.length >= 2 && String(pair[0]).toLowerCase() === "content-encoding" && typeof pair[1] === "string") return pair[1];
        }
        return undefined;
    }
    if (typeof headers === "object") {
        for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() !== "content-encoding") continue;
            if (typeof v === "string") return v;
            if (Array.isArray(v)) return v.join(", ");
        }
    }
    return undefined;
}

// #4829: hosts may ship the request body content-encoded — the Codex SSE
// transport (pi-ai) sends zstd-compressed Uint8Array bodies with a
// content-encoding header. Decode for INSPECTION ONLY (fork-adoption
// projection, #4082 recall fingerprints); the outgoing bytes are never
// touched. Decoding reuses the server-side codec table (#619) so lane and
// proxy agree on which codings are understood; every failure mode
// (undecodable bytes, unsupported coding, decompression-bomb cap) yields
// undefined = today's unparseable behavior. A JS string cannot be compressed,
// so it parses as-is even under an encoding header.
async function bodyJsonOf(init: RequestInit | undefined): Promise<unknown> {
    const raw = init?.body;
    let text: string | undefined;
    if (typeof raw === "string") {
        text = raw;
    } else if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const encoding = contentEncodingOf(init);
        if (encoding === undefined) {
            try {
                text = new TextDecoder().decode(bytes);
            } catch {
                // #4912: undecodable buffer (>V8-max-string-length throws
                // RangeError) → unreadable, same as any other parse failure
                // below — every caller treats undefined as a clean skip.
                return undefined;
            }
        } else {
            try {
                text = (await decodeRequestBody(encoding, Buffer.from(bytes), limitsDecodedBytes())).body.toString("utf8");
            } catch {
                return undefined;
            }
        }
    }
    if (text === undefined) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

async function maybeForkAdoptBeforeSend(ctx: PluginContext, init: RequestInit | undefined): Promise<void> {
    const child = forkChildVerdict(ctx);
    if (!child.ok) {
        noteForkVerdict(child);
        return;
    }
    if (!register.toolsReady) {
        noteForkGateOnce(`gate:tools-ready:${child.sid}`, "warn",
            `bili-native-dsh: fork adoption for ${child.sid} skipped at the tools-ready gate — this request arrived before bili tool registration completed; later requests can still adopt (#4215)`);
        return;
    }
    const body = await bodyJsonOf(init);
    if (body === undefined) {
        noteForkGateOnce(`gate:body-parse:${child.sid}`, "warn",
            `bili-native-dsh: fork adoption for ${child.sid} skipped at the body-parse gate — the request body was not parseable JSON after content-encoding decode, so the replay cannot be projected (#4215/#4829)`);
        return;
    }
    if (sideShapedBody(body)) {
        noteForkGateOnce(`gate:side-shaped:${child.sid}`, "info",
            `bili-native-dsh: fork adoption for ${child.sid} deferred for a side-shaped request (no tools, budget <= 200) — the adoption window stays open for the main request (#4215)`);
        return;
    }
    const base = register.base;
    if (base === undefined) {
        noteForkGateOnce(`gate:proxy-base:${child.sid}`, "warn",
            `bili-native-dsh: fork adoption for ${child.sid} skipped at the proxy-base gate — the proxy origin is not known yet, so the fork protocol cannot be reached (#4215)`);
        return;
    }
    await dshForkAdopter.maybeAdopt({ base, parent: child.parent, child: child.sid, body });
}

// #1677: session id of the command's invoking agent (host-passed invocation); malformed
// shapes yield undefined so callers fall through to ALS attribution then latest, never throw.
function invocationSidOf(invocation: CommandInvocation | undefined): string | undefined {
    const sid = invocation?.agent?.session?.id;
    return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}

// Banner for the /acp + /acp-cache latest-fallback: names the session actually shown so
// foreign data is never silently presented as the caller's own (#1677).
function latestSessionNote(status: Record<string, unknown>, requestedSid: string | undefined): string {
    const resolved = typeof status.conversationId === "string" && status.conversationId.length > 0 ? status.conversationId : "the most recently active session";
    return requestedSid !== undefined
        ? `⚠️ bili: session ${requestedSid} is not known to the proxy — showing ${resolved} instead.`
        : `⚠️ bili: could not identify the current session — showing ${resolved} instead.`;
}

async function statusOutcome(ctx: PluginContext, invocation?: CommandInvocation): Promise<CommandOutcome> {
    const base = register.base;
    if (!base) {
        // #3380 P3: toolsReady implies a proxy WAS serving this session — a
        // missing origin is then a transient outage with recovery running,
        // not a missing install.
        return {
            kind: "error",
            text: register.toolsReady
                ? "bili: proxy temporarily unreachable — it was serving this session before and recovery is running in the background; compression resumes automatically when it answers."
                : "bili: no proxy detected — install via `bili plugin install dsh` or launch through `bili dsh`.",
        };
    }
    maybeRetry(ctx);
    // #3380 P3: wire-mode exposure — the proxy answers but the local tools are
    // down, so every model request rides bili WITHOUT identity headers
    // (anonymous zero-fold sessions, no compression). Say so in the panel the
    // user already looks at instead of letting it stay silent.
    const wireNote = !register.toolsReady && !register.dead
        ? `⚠️ bili tools NOT registered — model requests ride bili WITHOUT identity headers (wire mode: no compression, anonymous sessions). Last error: ${register.lastRegistrationError ?? "unknown"}. Restart dsh to restore; retries continue in the background.\n\n`
        : "";
    // #1677: the command executor hands us the invoking session via the invocation —
    // DSH never establishes the AsyncLocalStorage boundary on the command path, so
    // currentInitiator() is always empty here and relying on it made /acp silently
    // show ANOTHER (most-recently-active) session's panel. Prefer the invocation's
    // agent session id; fall back to ALS attribution, then the latest-session fallback.
    const sid = invocationSidOf(invocation) ?? sessionIdOf(ctx);
    let fellBackToLatest = false;
    let status: Record<string, unknown> | undefined = sid !== undefined ? await fetchStatus(base, sid) : undefined;
    if (status === undefined) {
        fellBackToLatest = true;
        status = await fetchStatusLatest(base);
    }
    const panel = status?.panel;
    if (status && typeof panel === "string" && panel.length > 0) {
        // A panel reached through the latest-fallback belongs to some OTHER session —
        // say so instead of presenting foreign data as the caller's own (#1677).
        return { kind: "success", text: `${wireNote}${fellBackToLatest ? `${latestSessionNote(status, sid)}\n\n` : ""}${panel}` };
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
            text: `${wireNote}billion-context${version ? `@${version}` : ""} — proxy connected via ${base}, compression armed. Runtime info${typeof ri.source === "string" ? ` (${ri.source})` : ""}: ${parts.join(" ")}. No model request yet; send one, then run /acp again for the full panel.`,
        };
    }
    const version = await fetchProxyVersion(base);
    if (version) {
        return {
            kind: "success",
            text: `${wireNote}billion-context@${version} — proxy connected via ${base}, compression armed. No model request seen yet; send one, then run /acp again.`,
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
async function cacheOutcome(ctx: PluginContext, invocation?: CommandInvocation): Promise<CommandOutcome> {
    const base = register.base;
    if (!base) {
        return {
            kind: "error",
            text: "bili: no proxy detected — install via `bili plugin install dsh` or launch through `bili dsh`.",
        };
    }
    maybeRetry(ctx);
    // #1677: same session-resolution fix as /acp — the command path carries no ALS
    // attribution, so prefer the invocation's agent session id over currentInitiator().
    const sid = invocationSidOf(invocation) ?? sessionIdOf(ctx);
    let target = sid;
    let fallbackNote: string | undefined;
    if (target === undefined) {
        try {
            const status = await fetchStatusLatest(base);
            const cid = typeof status?.conversationId === "string" && status.conversationId.length > 0 ? status.conversationId : undefined;
            if (cid !== undefined) {
                target = cid;
                fallbackNote = latestSessionNote(status ?? {}, sid);
            }
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
            return { kind: "success", text: `billion-context@${version} — proxy connected via ${base}, compression armed. No model request seen yet; send one, then run /acp-cache again.` };
        }
        return {
            kind: "error",
            text: `bili: proxy not reachable at ${base} — is the bili proxy still running?`,
        };
    }
    try {
        const report = await forwardTool(base, target, "acp_cache", {}, undefined, true);
        if (report.failed) return { kind: "error", text: report.text };
        return { kind: "success", text: fallbackNote !== undefined ? `${fallbackNote}\n\n${report.text}` : report.text };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("no model request has arrived")) {
            return { kind: "success", text: "bili: no ACP session yet for this conversation (send a model request first, then run /acp-cache)" };
        }
        return { kind: "error", text: `bili: cache report failed: ${msg}` };
    }
}

// #3106: which CodeArts pool credential to re-sign with. Honors the inbound
// request's own signing account (inboundAk — its access_key_id from the
// Authorization header) so a multi-account pool never collapses to whichever
// account sorts first; falls back to first-resolvable-in-pool-order when no
// account matches. Pure + deterministic (now/ttlMs injectable) for testing.
const RESIGN_CACHE_MS = 10_000;
type ApigCredLike = { ak: string; sk: string; token?: string };
export async function pickCodeartsResignCred(opts: {
    candidates: readonly { ref: string }[];
    resolve: (ref: string) => Promise<{ value?: string } | undefined>;
    inboundAk?: string;
    cache: Map<string, { cred: ApigCredLike; at: number }>;
    now?: number;
    ttlMs?: number;
}): Promise<ApigCredLike | undefined> {
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? RESIGN_CACHE_MS;
    const parse = (value: unknown): ApigCredLike | undefined => {
        if (typeof value !== "string" || value === "") return undefined;
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const ak = typeof parsed["access_key_id"] === "string" ? parsed["access_key_id"] : "";
        const sk = typeof parsed["secret_access_key"] === "string" ? parsed["secret_access_key"] : "";
        if (ak === "" || sk === "") return undefined;
        const token = typeof parsed["security_token"] === "string" ? parsed["security_token"] : "";
        return { ak, sk, token };
    };
    const cachedOf = (ak: string): ApigCredLike | undefined => {
        const entry = opts.cache.get(ak);
        return entry !== undefined && now - entry.at < ttlMs ? entry.cred : undefined;
    };
    // Fast path: the account the request itself was signed with.
    if (opts.inboundAk !== undefined && opts.inboundAk !== "") {
        const hit = cachedOf(opts.inboundAk);
        if (hit !== undefined) return hit;
        for (const { ref } of opts.candidates) {
            let cred: ApigCredLike | undefined;
            try {
                cred = parse((await opts.resolve(ref))?.value);
            } catch {
                cred = undefined;
            }
            if (cred !== undefined && cred.ak === opts.inboundAk) {
                opts.cache.set(cred.ak, { cred, at: now });
                return cred;
            }
        }
        // No pool account matches the inbound AK (removed mid-flight): fall
        // through to first-valid below rather than refusing.
    }
    // Fallback (pre-#3106 semantics): first resolvable candidate in pool order.
    for (const { ref } of opts.candidates) {
        let cred: ApigCredLike | undefined;
        try {
            cred = parse((await opts.resolve(ref))?.value);
        } catch {
            cred = undefined;
        }
        if (cred === undefined) continue;
        const hit = cachedOf(cred.ak);
        if (hit !== undefined) return hit;
        opts.cache.set(cred.ak, { cred, at: now });
        return cred;
    }
    return undefined;
}

// #4082 negotiated conversation recall: per-dispatch memo from the takeover
// gate's recall decision to beforeSend's stamp. Keyed by the init object the
// interceptor threads through both hooks, so the claim and the stamp can
// never part ways across the awaited boundary (#3370 discipline).
const pendingNegotiatedStamps = new WeakMap<object, string>();


/** #4082: gate-side recall. Attribution is `none` (retry / model switch /
 * post-resume resend ran outside the agent scope). If the body's history
 * contains a remembered boundary for this lane — provably a known session's
 * continuation — claim the request for the plugin lane; beforeSend stamps the
 * negotiated sid. No evidence or ambiguity ⇒ undefined ⇒ today's refusal. */
async function maybeNegotiatedClaim(url: string, init: RequestInit | undefined): Promise<string | undefined> {
    if (init === undefined) return undefined;
    const laneKey = recallLaneKey(url);
    // #4082 review: probe before parsing — agentless sidecars (title-gen etc.)
    // hit this path constantly, and multi-MB quota-retry bodies must not pay
    // full JSON.parse + per-message hashing when no session was ever learned.
    if (!recallLaneHasEntries(laneKey)) return undefined;
    const body = await bodyJsonOf(init);
    if (body === undefined || typeof body !== "object") return undefined;
    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const sid = recallConversation(laneKey, recallHistoryFingerprints(messages));
    if (sid === undefined) return undefined;
    pendingNegotiatedStamps.set(init, sid);
    const stats = conversationRecallStatsLine();
    persistClientEvent(`bili-native-dsh: model request NEGOTIATED back onto session — takeover gate recalled ${maskUrlForDiagnostics(laneKey)} as a known continuation${stats}; compression and guards stay armed (#4082)`);
    return sid;
}

/** #4109: the lane key both sides of the recall agree on. The takeover
 *  gate is handed the UNWRAPPED upstream target (native-intercept resolves
 *  `/bili/` overlay URLs via routedBiliModelUrl before calling the gate, and
 *  maybeNegotiatedClaim keys on exactly that), while beforeSend receives the
 *  raw overlay URL. Normalizing through the SAME routedBiliModelUrl() makes
 *  the learn key equal the claim key for one logical lane in BOTH forms:
 *  routed overlays collapse to the upstream URL, raw URLs pass through
 *  unchanged (the helper returns undefined for them). Applied on the LEARN
 *  side only — the claim already receives the once-unwrapped target, and a
 *  second unwrap there could split the key again. */
function recallLaneKeyOf(url: string): string {
    return recallLaneKey(routedBiliModelUrl(url) ?? url);
}

function conversationRecallStatsLine(): string {
    const s = conversationRecallStats();
    return ` (recall: ${s.recalled} claimed / ${s.learned} learned / ${s.rejectedNoBoundary + s.rejectedAmbiguous} no-evidence)`;
}

/** #4082: beforeSend-side learn + stamp. Attributed dispatches teach the
 * recall table (lane → session + boundary); unattributed dispatches claimed
 * by the gate get the negotiated conversation header stamped atomically with
 * the body on the SAME init (#3370 discipline). */
async function maybeRecallBeforeSend(ctx: PluginContext, url: string, init: RequestInit | undefined): Promise<void> {
    if (!register.toolsReady || init === undefined) return;
    const attr = attributionOf(ctx);
    if (attr.state === "ok") {
        const body = await bodyJsonOf(init);
        if (body === undefined || typeof body !== "object") return;
        const messages = (body as { messages?: unknown }).messages;
        if (!Array.isArray(messages) || messages.length === 0) return;
        const boundary = recallBoundaryOfMessages(messages);
        if (boundary === undefined) return;
        learnConversation(recallLaneKeyOf(url), attr.sid, boundary);
        return;
    }
    if (attr.state !== "none") return;
    const negotiated = pendingNegotiatedStamps.get(init);
    if (negotiated === undefined) return;
    pendingNegotiatedStamps.delete(init);
    // #3370 discipline: rebuild rather than mutate — the host may hold the
    // original Headers object across retries; an in-place stamp would leak
    // the negotiated identity into later unclaimed requests.
    const headers = new Headers(init.headers);
    headers.set("x-bili-plugin", "dsh");
    headers.set("x-bili-plugin-conversation", negotiated);
    init.headers = headers;
}

export function apply(ctx: PluginContext): void {
    const plan = planNativeDsh(process.env);
    if (plan.mode === "off") return;
    // #3616: a fresh activation is a fresh origin world — in-flight recoveries
    // from the previous world are superseded here (their late landings must not
    // write this world's register/state). Off-mode arms nothing and bumps
    // nothing: invalidating recoveries on a kill-switch could strand the lane.
    originGen += 1;

    // #3354/#3662: declare that THIS process owns compression so the always-on
    // gate entry's load-time overlay (#3354) actually disables the web-profile
    // preset instances no patch layer can address by id (#1772/#2360). The
    // declaration — not the registration — is what's gated on plan.mode: a
    // kill-switched or disabled bili-native never declares, and the gate then
    // leaves every row stock while its service still lets the presets boot
    // (disabling the plugin must not brick session creation, #3662).
    declareDshCompactionActive();

    // #2082: a fresh activation invalidates the "host tearing down" verdict.
    // Without this reset, ONE registerTools rejection carrying "inactive
    // context" (a cordis deactivate/reactivate cycle — dsh reloading the
    // plugin after the desktop profile copy was swapped in place, a profile
    // switch, a settings toggle) poisons register.dead for the whole process
    // lifetime: every later maybeRetry() returns immediately and the bili
    // tools never come back until dsh restarts.
    // #2101: a re-activation ALSO invalidates a SUCCESSFUL registration.
    // Registrations die with their context: the tools registered into the
    // previous activation are disposed when that context deactivates, but
    // register.toolsReady keeps its stale stamp — and every
    // registerTools()/maybeRetry() early-returns on it, so the new context
    // never gets the bili tools (the #2082 symptom reached from the success
    // ordering: a settings toggle, a profile switch or a plugin reload
    // AFTER a healthy boot loses the tools until dsh restarts). Clear the
    // stale stamp so the retry loop re-registers into the live context;
    // retryAt goes with it (#1783: a fresh activation must not stand behind
    // a stale back-off wall).
    if (register.toolsReady && activeCtx !== undefined && activeCtx !== ctx) {
        register.toolsReady = false;
        register.retryAt = 0;
    }
    register.dead = false;
    // #3380: a fresh activation starts a clean registration cycle — stale
    // failure bookkeeping from the previous context must not carry over
    // (back-off would resume mid-ladder, the notice would stay spent).
    register.failStreak = 0;
    register.lastRegistrationError = undefined;
    regAdoptLogged = false;
    activeCtx = ctx;

    // #3394: release the live-state slot when THIS activation's context is torn
    // down — generation- AND ownership-guarded so neither an older instance's
    // late teardown nor an older activation of the same instance
    // (deactivate/reactivate re-applies the module-level state, #2082/#2101)
    // can clear a slot a newer apply() already rebound. While the slot is empty
    // the shared fetch chain passes through direct (clean "not active") rather
    // than hitting a disposed context. Guarded: node:test mock ctx has no
    // effect hook, and hosts without one skip it.
    if (typeof ctx.effect === "function") {
        ctx.effect(liveStateSlotEffect(state), "bili: native-intercept live-state slot");
    }

    // #1590: the dsh web-profile settings panel shows a "bili设置" entry
    // (dsh-native-client.js) that opens this proxy's Web UI. The origin is
    // only published while known — attach mode binds register.base
    // synchronously below; spawn mode binds it after bootstrap, so at
    // startup-time index collection that entry degrades to a hint instead of
    // a stale link.
    // #4237: the payload also carries the Context-tab face flags (register
    // gate + optional custom label), read live on every call so a web-settings
    // edit lands on the next page load without a proxy restart.
    const withCtxTabFace = (base: Record<string, unknown>): Record<string, unknown> => {
        base.contextTab = dshContextTabEnabled();
        const label = dshContextTabLabel();
        if (label !== undefined) base.contextTabLabel = label;
        return base;
    };
    ctx.on?.("webserver/index-inject", (table: Array<{ kind: string; name?: string; value?: unknown }>) => {
        // #4846: DSH Desktop captures this table ONCE per app launch (one-shot
        // boot snapshot), so a row dropped here is gone for the whole session —
        // browser/web re-renders per request and never hits this. The face flags
        // must therefore ride the row even before the origin is bound (spawn mode
        // reads register.base only after bootstrap), or dsh.contextTab=false fails
        // open on desktop forever. A null origin is safe: readOrigin() treats a
        // non-string origin as unresolved and keeps polling /bili/origin, and
        // readCtxTabFace() only needs contextTab/contextTabLabel. Mirrors the
        // /bili/origin route expression below so snapshot ≡ route at any instant.
        const origin = currentOrigin();
        table.push({ kind: "global", name: "__BILI__", value: withCtxTabFace(origin !== undefined && adminRelayEnabled() ? { origin: null, relay: true } : { origin: origin ?? null }) });
    });

    // #2604: follow the host session name (dsh-session-title service). Every
    // titled session emits `session/title` (fallback creation, LLM acceptance,
    // user rename — latest-wins); `session/created` seeds resumed sessions
    // whose title predates this process. Fire-and-forget: a title push must
    // never block session publication or the driver chain.
    if (typeof ctx.on === "function") {
        ctx.on("session/created", (session: { id?: unknown }) => {
            seedDshSessionTitle(session);
        });
        ctx.on("session/event", (session: { id?: unknown }, event: { type?: unknown; data?: { title?: unknown } }) => {
            if (event?.type !== "session/title") return;
            const title = event.data?.title;
            if (typeof title !== "string" || title.length === 0) return;
            reportDshSessionName(register.base, typeof session.id === "string" ? session.id : undefined, title);
        });
    }

    // #1809: the row above is a snapshot taken at index render — spawn mode
    // binds register.base only AFTER bootstrap, so an already-loaded page (a
    // web tab opened at launch) never sees the origin, and desktop is worse:
    // its boot payload is captured once per app launch, leaving the settings
    // entry degraded for the whole session even after the proxy is up. Serve
    // the origin live on a named route instead; the client half polls it
    // while unresolved. Missing webServer (TUI/headless profiles) keeps the
    // snapshot row as the only source.
    const originRoute = {
        kind: "exact" as const,
        path: "/bili/origin",
        handler: (_req: unknown, res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void }): void => {
            const origin = currentOrigin();
            // #3373: relay mode ⇒ the client derives its base from the probe
            // response URL itself; the loopback origin is useless (and leaky)
            // to a remote browser. #4237: same Context-tab face flags as the
            // snapshot row.
            const body = JSON.stringify(withCtxTabFace(origin !== undefined && adminRelayEnabled() ? { origin: null, relay: true } : { origin: origin ?? null }));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(body);
        },
    };
    const adminRelayRoute = {
        kind: "prefix" as const,
        path: "/__bili",
        handler: (req: unknown, res: RelayRes): void | Promise<void> => relayAdminRequest(req, res),
    };
    // #4082: the positive attribution fix. dsh routes EVERY streaming model
    // dispatch — first attempts, llm-retry re-sends, model switches, the
    // compaction and session-title side-calls — through the `llm/stream`
    // waterfall, and the loop stamps `options.sessionId` on each request
    // object (types.d.ts: "Session identity stamped by the loop for request
    // routing"). Listening there and wrapping the stream's iteration in our
    // sidScope means the adapter's fetches read a session id that survives
    // every chain shape the ambient initiator does not. Waterfall contract:
    // always call next() and faithfully pass the iterable through — a
    // listener that drops it would cut the stream (same discipline as the
    // first-party checkpoint-policy plugin). Dispatches WITHOUT a sessionId
    // (auto-review's agentless lane) pass through untouched and keep riding
    // the existing attribution ladder (ambient → negotiated recall).
    if (typeof ctx.inject === "function" && typeof ctx.on === "function") {
        const onEvent = ctx.on.bind(ctx);
        ctx.inject(["llm"], () => {
            onEvent("llm/stream", (options: { sessionId?: unknown; messages?: unknown }, next: () => AsyncIterable<unknown>) => {
                const sid = typeof options?.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : undefined;
                if (sid === undefined) return next();
                // #4491: capture the host message ids riding the same options
                // — undefined (all-or-nothing) when any message lacks a usable
                // id, so sidecar shapes degrade to id-less turns.
                const scope: LlmDispatchScope = { sid, msgIds: hostMsgIdsOf(options?.messages) };
                // next() may start the adapter's fetch eagerly (inside this
                // call), and lazy continuations resume on each advance — the
                // run() below covers the former, wrapScopedIterable the latter.
                return dispatchScope.run(scope, () => wrapScopedIterable(next(), scope));
            });
        });
    }

    if (typeof ctx.inject === "function") {
        // Cordis inject: fires once the service is available, re-runs on
        // change; the effect disposes the prior registration on each re-run
        // (same lifecycle as dsh's own bundle route). Profiles without a
        // webserver never fire the callback — the snapshot row alone stands.
        ctx.inject(["webServer"], (sub) => {
            const ws = sub.webServer;
            if (ws === undefined) return;
            if (typeof sub.effect === "function") sub.effect(() => {
                const offOrigin = ws.register(originRoute);
                const offRelay = ws.register(adminRelayRoute);
                // The effect's return value is how dsh disposes this
                // registration on re-run — combine both route disposers or
                // stale duplicates accumulate in the router table.
                return () => {
                    offOrigin?.();
                    offRelay?.();
                };
            }, "bili: panel routes (origin + admin relay)");
            else {
                ws.register(originRoute);
                ws.register(adminRelayRoute);
            }
        });
    } else if (ctx.webServer !== undefined) {
        ctx.webServer.register(originRoute);
        ctx.webServer.register(adminRelayRoute);
    }

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
            state.onGiveUp = fireGiveUp;
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
                });
            };
            state.ready = trackChain(start());
        } else {
            state.ready = Promise.resolve(undefined);
        }
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        markNativeHost(process.env, "dsh");
        const start = singleFlight(bootstrap);
        state.respawn = start;
        state.onGiveUp = fireGiveUp;
        state.ready = trackChain(start());
    }

    // #2187: arm the recovery loop at PLAN time, not on first traffic. After
    // a boot-time spawn failure NO caller can reach maybeRetry — headersFor
    // is only consulted once an origin has resolved, /acp early-returns while
    // base-less, and the recovery timer below arms itself only from inside
    // maybeRetry — so the lane stayed degraded for the whole session. Happy
    // path: single-flight joins the bootstrap started above (no second
    // spawn); failure path: the timer re-fires state.respawn() every
    // RETRY_INTERVAL_MS until a proxy lands.
    maybeRetry(ctx);

    // #1158 L2: a refusal sends model traffic DIRECT. First refusal per
    // endpoint logs once; same-state refusals accumulate silently and re-print
    // only on an attribution STATE change (none↔threw), always carrying the
    // cumulative count — bounded noise (#1117 silence preserved) while a
    // "dozens refused, one passed" distribution becomes visible. The durable
    // copy goes through persistClientEvent: GUI hosts swallow stderr, which is
    // exactly how the reported zero-traffic case stayed invisible.
    const gateRefusals = new Map<string, { state: string; count: number }>();
    const gateKeyOf = (url: string): string => {
        try {
            const u = new URL(url);
            return `${u.origin}${u.pathname}`;
        } catch {
            return url;
        }
    };
    // #3581/#3651: the refusal evidence above exists ONLY in this host process
    // — the proxy learns about the silent-direct degradation exclusively
    // through event reports. Under the #3651 owner contract only DIAGNOSABLE
    // failures report: by-design agentless lanes (`none`) are normal
    // interceptions and stay silent forever (their per-endpoint durables are
    // the record); internal errors (`threw`) report with error text + masked
    // endpoint so the panel can name the problem, its impact and the remedy.
    // Healthy lanes never POST, so the healthy path costs nothing; a missed
    // report delays visibility, never touches requests.
    const reportAttrHealth = (): void => {
        const base = register.base;
        if (base === undefined) return;
        void reportAttributionHealth(base, {
            agent: name,
            state: attrHealth.state,
            refusals: attrHealth.refusals,
            since: attrHealth.since,
            ...(attrHealth.error !== undefined ? { error: attrHealth.error } : {}),
            ...(attrHealth.endpoint !== undefined ? { endpoint: attrHealth.endpoint } : {}),
        }).catch(() => undefined);
    };
    // #3651 (owner contract, #3651 thread): 「正常拦截不报告，报告必须可诊断」.
    // A by-design agentless lane (dsh's title-gen sidecar et al.) refuses a
    // handful of small one-shot calls per host lifetime and can NEVER recover
    // — reporting it lit the #3581 banner ("takeover broken … restart the
    // host") on every short-lived worker boot while the main conversation
    // compressed fine (field shape: exactly one refused sidecar call per
    // worker, thousands of compressed turns elsewhere). So `none` accumulates
    // locally (counters + recovery semantics intact) but NEVER reports.
    // `threw` — an exception inside the host's attribution lookup, an internal
    // error, never legitimate agentless evidence (#1158 L2) — keeps the
    // #3581a cadence (first refusal immediate, then count doubling) and now
    // carries the thrown message + masked endpoint as diagnostics.
    const noteAttrRefusal = (state: "none" | "threw", detail?: { message?: string; endpoint?: string }): void => {
        if (state === "none") return;
        if (detail?.message !== undefined) attrHealth.error = detail.message;
        if (detail?.endpoint !== undefined) attrHealth.endpoint = detail.endpoint;
        const diag = {
            ...(attrHealth.error !== undefined ? { error: attrHealth.error } : {}),
            ...(attrHealth.endpoint !== undefined ? { endpoint: attrHealth.endpoint } : {}),
        };
        if (attrHealth.state === "ok") {
            attrHealth = { state, refusals: 1, since: Date.now(), ...diag };
            attrReportedRefusals = 1;
            reportAttrHealth();
            return;
        }
        attrHealth.refusals += 1;
        const changed = attrHealth.state !== state;
        attrHealth.state = state;
        const doubled = attrHealth.refusals >= attrReportedRefusals * 2;
        if (changed || doubled) {
            attrReportedRefusals = attrHealth.refusals;
            reportAttrHealth();
        }
    };
    const noteAttrRecovery = (): void => {
        if (attrHealth.state === "ok") return;
        attrHealth = { state: "ok", refusals: 0, since: 0 };
        attrReportedRefusals = 0;
        reportAttrHealth();
    };
    const refuse = (url: string, attr: GateAttribution): false => {
        const key = gateKeyOf(url);
        const prev = gateRefusals.get(key);
        const count = (prev?.count ?? 0) + 1;
        const changed = prev !== undefined && prev.state !== attr.state;
        if (prev === undefined && gateRefusals.size >= 256) gateRefusals.clear();
        gateRefusals.set(key, { state: attr.state, count });
        if (prev === undefined || changed) {
            const reason =
                attr.state === "threw"
                    ? `currentInitiator() threw (${attr.message}) — agent scope disposed/closing mid-request?`
                    : attr.state === "none" && attr.initiatorPresent
                        ? "initiator present but missing session id"
                        : "no active initiator attribution (agentless/background lane, third-party in-process caller, or stale attribution after host resume?)";
            const suffix = prev !== undefined ? ` (state ${prev.state}→${attr.state})` : "";
            const line = `bili-native-dsh: model request sent DIRECT (uncompressed) — takeover gate refused ${key}: ${reason} — refusals so far: ${count}${suffix}`;
            persistClientEvent(line);
        }
        if (attr.state !== "ok") {
            noteAttrRefusal(attr.state, {
                ...(attr.state === "threw" ? { message: attr.message } : {}),
                endpoint: maskUrlForDiagnostics(key),
            });
        }
        return false;
    };
    // #2924 direction 2: `threw` is an INTERNAL error in the host's
    // attribution lookup (a disposed/closing agent scope), never evidence of
    // a legitimate agentless lane — and the scope often settles within a tick
    // or two. Give it a bounded settle-retry before deciding: claiming the
    // request after recovery is the only path that RESTORES an over-window
    // session (the host's own compaction and the #1117 direct fallback must
    // both ship the full history upstream, which 400s once it exceeds the
    // window — all recovery paths vanish the instant the gate lets go).
    const settleThrewAttribution = async (message: string, url: string, body: { bytes: number } | undefined, init: RequestInit | undefined): Promise<GateVerdict> => {
        // #3581: after giveUpStreak consecutive requests whose settle-retry
        // exhausted STILL threw, stop re-settling — a disposed ctx stays
        // disposed for the host's whole lifetime (#3578), so retrying the same
        // dead scope per request is pure latency. The gate's single cheap
        // attributionOf probe per request keeps self-heal alive: the first ok
        // claim (new agent scope) clears the streak and resumes normal retries.
        if (threwStreak < threwRetry.giveUpStreak) {
            for (let attempt = 1; attempt < threwRetry.attempts; attempt++) {
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, threwRetry.delayMs);
                });
                const again = attributionOf(ctx);
                if (again.state === "ok") {
                    persistClientEvent(`bili-native-dsh: takeover gate attribution recovered after ${attempt} settle-retr${attempt === 1 ? "y" : "ies"} — ${gateKeyOf(url)} claimed (#2924)`);
                    noteAttrRecovery();
                    return true;
                }
                if (again.state === "none") return refuseUnattributed(url, again, body, init);
            }
        }
        // #2924 direction 1: still `threw` AND the body provably cannot fit —
        // fail this one request locally instead of handing upstream a request
        // that can only 400 (and, on a >window history, kills the session).
        // FLOOR estimate (bytes/4) on MEDIA-EXCLUDED core text: refuse only
        // when the OPTIMISTIC token count already exceeds the window, so the
        // guard cannot false-refuse — the session ledger shows this host's
        // real bodies run ABOVE the byte-estimate (calibratedEstimate ~1.14),
        // and that bias cuts the other way. #4111: the raw byte count includes
        // base64 media, which bytes/4 billed as ~4× its resolution-billed
        // reality and false-refused media-heavy bodies — the re-price bills
        // core text only (the relay egress fuse's caliber). Unknown window or
        // unreadable body keeps #1117 semantics.
        // #4079: the declared window can be wrong SMALL (stale host config,
        // model-catalog fallback) — size the bar at max(declared, 1M) so an
        // undersized declaration cannot false-refuse a body the real upstream
        // would accept.
        const doom = bodyProvablyOverWindow(body, init, effectiveContextWindow(ctx));
        if (doom !== undefined) {
            persistClientEvent(`bili-native-dsh: takeover gate refused ${gateKeyOf(url)} LOCALLY (422) — attribution threw and body ≥${doom.floorTokens} tok (core est ${doom.coreBytes}B/4${doom.mediaBytes > 0 ? `, ${doom.mediaBytes}B media excluded` : ""}) exceeds window ${doom.window} (declared ${doom.declaredWindow}; never assumes below ${MIN_ASSUMED_WINDOW_TOKENS}); a direct send would 400 upstream (#2924/#4111)`);
            noteAttrRefusal("threw", { message, endpoint: maskUrlForDiagnostics(gateKeyOf(url)) });
            return "refuse-oversized";
        }
        return refuse(url, attributionOf(ctx));
    };
    // #4068/#4079: `none` keeps #1117 direct semantics by design — an
    // agentless lane is not ours to manage — but a body whose optimistic
    // core-text byte-floor token count already exceeds the window has no
    // direct future: the raw send 400s/413s upstream and the host retries the
    // SAME oversized history every turn (the #4068 field shape: a
    // 6,165,048-token body against a 1,048,580 window, twice). Same floor
    // math and same never-false-refuse reasoning as the threw arm above
    // (#2924), including #4111's media exclusion — media mass is billed by the
    // upstream's image lane, not as text: unknown window or unreadable/stream
    // body keeps #1117.
    const refuseUnattributed = (url: string, attr: Exclude<GateAttribution, { state: "ok" }>, body: { bytes: number } | undefined, init: RequestInit | undefined): GateVerdict => {
        // #4079: same undersized-declaration guard as the threw arm — the
        // bar never assumes below the 1M common window floor. #4111: same
        // media-aware core-text caliber too (see bodyProvablyOverWindow).
        const unattributedDoom = bodyProvablyOverWindow(body, init, effectiveContextWindow(ctx));
        if (unattributedDoom !== undefined) {
            persistClientEvent(`bili-native-dsh: takeover gate refused ${gateKeyOf(url)} LOCALLY (422) — unattributed body ≥${unattributedDoom.floorTokens} tok (core est ${unattributedDoom.coreBytes}B/4${unattributedDoom.mediaBytes > 0 ? `, ${unattributedDoom.mediaBytes}B media excluded` : ""}) exceeds window ${unattributedDoom.window} (declared ${unattributedDoom.declaredWindow}; never assumes below ${MIN_ASSUMED_WINDOW_TOKENS}); a direct send would be a guaranteed upstream rejection (#4068/#4079/#4111)`);
            noteAttrRefusal(attr.state, { endpoint: maskUrlForDiagnostics(gateKeyOf(url)) });
            return "refuse-oversized-unattributed";
        }
        return refuse(url, attr);
    };
    state.takeoverGate = (url, body, init) => {
        const attr = attributionOf(ctx);
        if (attr.state === "ok") {
            threwStreak = 0;
            threwGiveUpNoticed = false;
            noteAttrRecovery();
            return true;
        }
        // #4082: before refusing an unattributed dispatch, try the negotiated
        // recall — the body itself may prove it is a known session's
        // continuation (retry / model switch shape). A claim here routes the
        // request onto the plugin lane with the negotiated sid; refusal below
        // stays byte-identical when there is no evidence. #4829: the claim may
        // now decode content-encoded bodies, so this arm settles async — the
        // gate contract already tolerates Promise verdicts (threw arm).
        if (attr.state === "none") {
            // #4829 review: without init there is no body to decode and the
            // claim can never succeed — settle synchronously so this shape
            // keeps the OLD verdict class: native-ws-intercept.ts compares
            // its gate result with === false WITHOUT awaiting.
            if (init === undefined) {
                threwStreak = 0;
                threwGiveUpNoticed = false;
                return refuseUnattributed(url, attr, body, init);
            }
            return maybeNegotiatedClaim(url, init).then((claimed) => {
                if (claimed !== undefined) {
                    // Deliberately NOT noteAttrRecovery(): the host attribution
                    // is still broken — the health signal stays honest; the
                    // REQUEST is what got rescued, not the initiator scope (#4082).
                    return true;
                }
                threwStreak = 0;
                threwGiveUpNoticed = false;
                return refuseUnattributed(url, attr, body, init);
            });
        }
        if (attr.state === "threw") {
            return settleThrewAttribution(attr.message, url, body, init).then((verdict) => {
                if (verdict === true) {
                    threwStreak = 0;
                    threwGiveUpNoticed = false;
                } else {
                    threwStreak += 1;
                    if (threwStreak >= threwRetry.giveUpStreak && !threwGiveUpNoticed) {
                        threwGiveUpNoticed = true;
                        persistClientEvent(`bili-native-dsh: takeover gate stopped settle-retrying after ${threwStreak} consecutive thrown request(s) — refusing immediately until attribution recovers (restart the host if it stays broken) (#3581)`);
                        reportAttrHealth();
                    }
                }
                return verdict;
            });
        }
        threwStreak = 0;
        threwGiveUpNoticed = false;
        return refuseUnattributed(url, attr, body, init);
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
        persistClientEvent(line);
    };

    // #1884 re-sign arm: bind the host's credential service (dynamic inject —
    // a host without it keeps the #1886 direct fallback), then expose a
    // resolver over the enabled CodeArts accounts in the host's account-pool
    // state ($DSH_HOME/jet-hub/state.json). It signs with THE SAME account the
    // inbound request was issued under (its access_key_id rides in the
    // Authorization header, passed in as inboundAk); substituting another pool
    // account would collapse a multi-account pool to one credential and break
    // off-account models (#3106), so first-resolvable-in-pool-order is only the
    // fallback when no account matches. BILI_CODEARTS_REF
    // pins a specific credential ref instead. The loopback markers carry
    // ak/sk/token to the proxy, which re-signs every egress body it produces
    // (src/apig-resign.ts). Credential refresh stays the plugin's job: when
    // a credential expires the upstream 401 is visible and the plugin's next
    // successful refresh re-arms through this same resolver. The pinned ref
    // comes from resolveResignSettings(): env BILI_CODEARTS_REF wins over the
    // config file's "resign": {"credentialRef": …}.
    let credentialsService: { resolve?: (ref: string) => Promise<{ value?: string } | undefined> } | undefined;
    if (typeof ctx.inject === "function") {
        try {
            ctx.inject(["credentials"], (sub) => {
                const svc = (sub as { credentials?: unknown }).credentials;
                if (svc !== undefined && typeof svc === "object") credentialsService = svc as typeof credentialsService;
            });
        } catch {
            // inject is best-effort: without the service signed traffic rides
            // the direct fallback (uncompressed, signature intact), as before.
        }
    } else {
        const svc = (ctx as { credentials?: unknown }).credentials;
        if (svc !== undefined && typeof svc === "object") credentialsService = svc as typeof credentialsService;
    }
    const codeartsRefCandidates = (): { ref: string; nickname?: string }[] => {
        const pinned = resolveResignSettings().credentialRef;
        if (pinned !== undefined && pinned.trim() !== "") return [{ ref: pinned.trim() }];
        try {
            const home = process.env.DSH_HOME ?? path.join(homedir(), ".dsh");
            const raw = readFileSync(path.join(home, "jet-hub", "state.json"), "utf8");
            const accounts = (JSON.parse(raw) as { accounts?: Array<Record<string, unknown>> }).accounts ?? [];
            const out: { ref: string; nickname?: string }[] = [];
            for (const account of accounts) {
                if (account["provider"] !== "codearts") continue;
                if (account["enabled"] === false) continue;
                const ref = account["credentialRef"];
                if (typeof ref !== "string" || ref === "") continue;
                const nickname = account["nickname"];
                out.push({ ref, nickname: typeof nickname === "string" ? nickname : undefined });
            }
            return out;
        } catch {
            return [];
        }
    };
    // Cache keyed by access_key_id (not a single global slot) so distinct pool
    // accounts stop clobbering each other within the TTL window (#3106).
    let resignCache: Map<string, { cred: { ak: string; sk: string; token?: string }; at: number }> | undefined;
    state.resignCredentialFor = async (_url, _scheme, inboundAk) => {
        if (credentialsService?.resolve === undefined) return undefined;
        return pickCodeartsResignCred({
            candidates: codeartsRefCandidates(),
            resolve: credentialsService.resolve.bind(credentialsService),
            inboundAk,
            cache: (resignCache ??= new Map()),
        });
    };
    const signedUrlSeen = new Set<string>();
    state.onSignedModelUrl = (rawUrl, scheme) => {
        const key = (() => {
            try {
                const u = new URL(rawUrl);
                return `${u.origin}${u.pathname}`;
            } catch {
                return rawUrl.split("?")[0];
            }
        })();
        if (signedUrlSeen.has(key)) return;
        if (signedUrlSeen.size >= 64) return;
        signedUrlSeen.add(key);
        const line = scheme === APIG_RESIGN_SCHEME
            ? `bili-native-dsh: signed model request observed (${key}, ${scheme}) — #1884 re-sign arm engaged when a credential resolves; otherwise local refusal (or byte-untouched direct with passthrough configured)`
            : `bili-native-dsh: signed model request observed (${key}, ${scheme}) — bili cannot re-sign this scheme: refusing per the compress-or-refuse contract (no unsigned pass-through — the link stays unavailable until bili ships a re-signer for it, #2090)`;
        persistClientEvent(line);
    };

    // #2090 plan A: say at BOOT, not after the first failure — unresolved
    // signed schemes remembered from earlier runs keep failing until the user
    // configures them away.
    {
        const unresolved = unresolvedRefusals();
        const entries = Object.entries(unresolved);
        if (entries.length > 0) {
            const list = entries.map(([scheme, e]) => `${scheme} (${e.origin}${e.count > 1 ? `, ${e.count}× since ${e.firstSeen.slice(0, 10)}` : ""})`).join("; ");
            const line = `bili-native-dsh: ${entries.length} signed scheme(s) were refused earlier and remain UNRESOLVED: ${list}. Per the compress-or-refuse contract they stay refused until bili ships a re-signer for each of them (no configuration passes a signed body through unsigned); see the bili web UI (/__bili/, Configuration → Signed upstreams) for details.`;
            console.warn(line);
            persistClientEvent(line);
        }
    }

    state.headersFor = (_url) => {
        maybeRetry(ctx);
        if (!register.toolsReady) return undefined;
        const attr = attributionOf(ctx);
        if (attr.state !== "ok") return undefined;
        const sid = attr.sid;
        ensureDshTitleReported(sid);
        // #2381: size this request against the model IT routes to — session
        // header first, global default only as fallback. Stamping reads ONLY
        // that key's own entry, so a mismatched model's numbers can never be
        // sent (the proxy-side exact-match gate stays as defense in depth).
        const target = sessionModelTargetOf(ctx) ?? globalModelTarget(modelInfo.services);
        refreshModelInfo(register.base, target);
        const headers: Record<string, string> = { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid };
        // #3370: the incremental-turn marker (and, since #3329, the turn id)
        // is no longer stamped here — a closure-level armed flag shared by
        // every session raced concurrent requests across the awaited
        // beforeSend → headersFor boundary. Both now ride init.headers from
        // the conversion itself (see maybeIncrementalNative), atomic with
        // the body swap.
        if (target !== undefined) {
            const cached = modelInfo.byKey.get(modelInfoKey(target.provider, target.model));
            if (cached !== undefined) {
                const modelHeader = asciiHeaderValue(cached.model);
                if (modelHeader !== undefined) headers["x-bili-plugin-model"] = modelHeader;
                if (cached.contextWindow !== undefined) headers["x-bili-plugin-context-window"] = String(cached.contextWindow);
                if (cached.maxOutput !== undefined) headers["x-bili-plugin-max-output"] = String(cached.maxOutput);
            }
        }
        return headers;
    };

    // #4894: window source for the degraded direct path. The shared guard in
    // directSendOrRefuse measures against the stamped header — but headersFor
    // only runs on the proxy branch, so a request that finds no live proxy
    // (slow boot past the spawn budget, #4609) carried none and the guard
    // stayed disarmed in exactly the state that produced the prompt_too_long
    // storm. Same resolution headersFor stamps (#2381: the session's live
    // model first, the host's global default as fallback, cached model info
    // only), minus the tools/attribution gates those serve plugin-mode
    // stamping — a miss anywhere answers undefined and the arm fails open,
    // so this can never false-refuse from missing data.
    state.declaredWindowForDirect = () => {
        const target = sessionModelTargetOf(ctx) ?? globalModelTarget(modelInfo.services);
        if (target !== undefined) refreshModelInfo(register.base, target);
        return effectiveContextWindow(ctx);
    };

    // #2399: fork-child adoption runs before headersFor stamps the child's
    // first plugin request — the proxy then binds the replayed prefix to the
    // adopted parent state on that very request instead of starting fresh.
    // #3248: the same awaited pre-send slot converts the outgoing anthropic
    // body to its incremental form when the lane advertises the feature —
    // init.body mutation propagates through withHeaders/send untouched.
    state.beforeSend = async (url, init) => {
        // #4082 review: learn + stamp run FIRST — the boundary fingerprint
        // must come from the ORIGINAL full history; fork-adopt and the
        // incremental swap both rewrite init.body afterwards (the delta form
        // happens to end with the newest message today, but learning must not
        // rest on that shape).
        await maybeRecallBeforeSend(ctx, url, init);
        await maybeForkAdoptBeforeSend(ctx, init);
        await maybeIncrementalNative(url, init);
    };
    // #3304: the dsh swap stamps the turn id atomically with the body, so the
    // strict shared guard applies — mutated + unrestorable ⇒ refuse locally.
    state.prepareDirectSend = createPrepareDirectSend();

    // #3248 incremental turns (#3370 hardened): reference wiring for the
    // native fetch lanes; opencode/omp-native follow the same recipe:
    //   beforeSend  — parse the anthropic body, plan (probe-gated), replace
    // #3248 incremental turns (#3370 hardened, #3329 attribution): reference
    // wiring for the native fetch lanes; opencode/omp-native follow the same
    // recipe:
    //   beforeSend  — parse the anthropic body, plan (probe-gated), replace
    //                  init.body with the delta payload and stamp the marker
    //                  + turn-id headers on the SAME init (atomic: omp
    //                  pattern) + stash the ack context keyed by the
    //                  per-request turn id (#3329 — keyed by URL, a late
    //                  response on a shared model endpoint could be
    //                  attributed to whichever conversation planned last);
    //   onResponse  — attribute the response via the turn id THIS dispatch
    //                  carried (threaded from the dispatch's outgoing
    //                  headers), read x-bili-applied-seq, record the ack (or
    //                  fall back to full resend on 409/503).
    // The old arms-a-shared-flag/consume-it-in-headersFor split raced when two
    // sessions crossed the awaited hook boundary (#3370) — init.headers is
    // merged by withHeaders and survives headersFor's own stamping, so the
    // marker and the body can never part ways again. The #3370 single-flight
    // guard per URL is KEPT on top of turn-id keying (#3340 rebase decision,
    // issuecomment-6212900441): while a marker'd request for this URL is
    // still awaiting its ack, later requests on the same URL ride the normal
    // pipeline — dropping it is a separate follow-up, not this PR.
    const INC_PENDING_TTL_MS = 30_000; // matches omp-native / opencode-native
    const incPendingAcks = new Map<string, { sid: string; url: string; messages: IncrementalWireMessage[]; system: unknown; base: string; at: number }>();
    async function maybeIncrementalNative(url: string, init: RequestInit | undefined): Promise<void> {
        if (!register.toolsReady || init === undefined) return;
        const attr = attributionOf(ctx);
        if (attr.state !== "ok") return;
        const body = init.body;
        if (typeof body !== "string" || body.length === 0) return; // stream/Request bodies ride full resend
        let parsed: { messages?: unknown; system?: unknown; model?: unknown };
        try {
            parsed = JSON.parse(body) as typeof parsed;
        } catch {
            return;
        }
        if (typeof parsed.model !== "string" || !wireMessagesLookAnthropic(parsed.messages)) return; // anthropic wire only — OpenAI tool shapes (tool_calls / role:"tool") resend full (#3433)
        const base = register.base ?? state.origin;
        if (base === undefined) return;
        if (!(await probeIncrementalTurns(base))) return;
        sweepStale(incPendingAcks, INC_PENDING_TTL_MS);
        // #3370 single-flight (omp/opencode pattern; kept over #3329's
        // removal per the rebase decision): while a marker'd request for
        // this URL is still awaiting its ack, later requests ride the normal
        // pipeline — pending entries are now keyed by turn id (#3329), so
        // the guard scans for a live entry stashed on THIS url.
        // The guard must run BEFORE planIncrementalTurn: planning claims the
        // turn's msgIds client-side (#4491), and a plan this guard then
        // discards would burn those ids — the host's retry screens against
        // the burned claims and silently drops the whole msgIds field.
        let inflight = false;
        for (const pending of incPendingAcks.values()) {
            if (pending.url === url && Date.now() - pending.at < INC_PENDING_TTL_MS) { inflight = true; break; }
        }
        if (inflight) return;
        const sid = attr.sid;
        // #4491: pin the turn to the host's own message ids — the ids captured
        // on the llm/stream options are only trustworthy when they line up
        // 1:1 with the wire messages ACTUALLY being sent (the adapter may
        // drop/reshape entries). Equal count ⇒ same order (the host renders
        // its session messages in order); anything else omits the field —
        // degrade over mis-pair, never pin a wrong id.
        const scopedIds = dispatchScope.getStore()?.msgIds;
        const msgIds = scopedIds !== undefined && scopedIds.length === (parsed.messages as unknown[]).length ? scopedIds : undefined;
        const plan = planIncrementalTurn({
            conversationId: sid,
            path: "/v1/messages", // placeholder — the marker divert uses the ORIGINAL routed URL
            messages: parsed.messages as IncrementalWireMessage[],
            system: "system" in parsed ? parsed.system : undefined,
            request: parsed as Record<string, unknown>,
            msgIds,
        });
        if (plan.mode === "skip") return;
        const turnId = newIncrementalTurnId();
        // #3304: stash the pre-swap body under this turn's id — if the proxy
        // dies before the send lands, the direct-send guard restores these
        // bytes instead of forwarding the lane-only payload upstream.
        rememberOriginalBody(turnId, body);
        init.body = (plan as { body: string }).body;
        const headers = new Headers(init.headers);
        headers.set(INCREMENTAL_TURN_MARKER_HEADER, "1");
        headers.set(INCREMENTAL_TURN_ID_HEADER, turnId);
        init.headers = headers;
        incPendingAcks.set(turnId, { sid, url, messages: parsed.messages as IncrementalWireMessage[], system: "system" in parsed ? parsed.system : undefined, base, at: Date.now() });
    }
    state.onResponse = (_url, response, headers) => {
        const turnId = headers?.[INCREMENTAL_TURN_ID_HEADER];
        if (turnId === undefined) return; // not an incremental dispatch — nothing to attribute (#3329)
        const pending = incPendingAcks.get(turnId);
        if (pending === undefined) return; // unknown/stale turn — nothing to attribute
        const seq = response.headers.get("x-bili-applied-seq");
        if (response.status === 200 && (seq === null || !/^\d+$/.test(seq))) {
            // 200 without an ack header CANNOT be the marker'd response — the
            // lane stamps x-bili-applied-seq on every diverted response that
            // reaches the forward (incremental-lane.ts writeHead wrap). It is
            // a concurrent full-resend response on the shared model-endpoint
            // URL: keep the pending entry for the marker'd response still in
            // flight, or its ack is lost and the next turn 409s into a resync.
            return;
        }
        incPendingAcks.delete(turnId);
        if (response.status === 200) {
            noteIncrementalAck(pending.sid, Number(seq), pending.messages, pending.system);
            return;
        }
        if (response.status === 409) {
            // #3369: one drift re-seeds next turn; only a rejection streak
            // permanently falls back to full resend.
            const verdict = noteIncrementalRejection(pending.sid);
            logHostEvent("warn", "[native-client]", `bili-native-dsh: incremental turn rejected (409) for ${pending.sid} — ${verdict === "dead" ? "sticky fallback to full resend (rejection circuit)" : "re-seeding with a full resync next turn"} (#3369)`);
            return;
        }
        if (response.status === 503) {
            // #3369: lane temporarily unavailable — keep the conversation's
            // ack state; just force a re-probe on the next turn.
            clearIncrementalProbe(pending.base);
            logHostEvent("warn", "[native-client]", `bili-native-dsh: incremental turns unavailable (503) — conversation ${pending.sid} state preserved, re-probing next turn (#3369)`);
        }
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

    // #2604: title-channel services (dsh-session / dsh-session-title) — same
    // dynamic-inject discipline as the runtime-info sources above: missing
    // services degrade to the pre-#2604 labelless behavior, never block boot.
    // The sweep seeds whatever is already live (resume published before us).
    if (typeof ctx.inject === "function") {
        try {
            ctx.inject(["sessions", "sessionTitle"], (sub) => {
                titleServices.sessions = sub.sessions;
                titleServices.sessionTitle = sub.sessionTitle;
                sweepLiveDshTitles();
            });
        } catch {
            // older builds without the services: labels stay host-less
        }
    } else if (ctx.sessions !== undefined || ctx.sessionTitle !== undefined) {
        titleServices.sessions = ctx.sessions;
        titleServices.sessionTitle = ctx.sessionTitle;
        sweepLiveDshTitles();
    }

    // Newer-than-tested dsh client build (#4545): one boot-time note per
    // process, emitted through both house channels (durable bili.log record +
    // console banner) by the shared helper. Soft by design — a wrong guess
    // must never gate a working session (see client-build-note.ts).
    if (!dshNewerBuildNoted) {
        try {
            const found = walkUpNodeModuleVersion(path.dirname(fileURLToPath(import.meta.url)), "node_modules/@deepseek-ai/dsh/package.json");
            if (found !== undefined) logHostEvent("info", "[native-client]", `bili-native-dsh: detected dsh build v${found}`);
            if (emitNewerClientBuildNote(DSH_BUILD_CHECK, found)) dshNewerBuildNoted = true;
        } catch {
            // resolver is fail-open: layout surprises stay silent
        }
    }

    // #1772/#3354: in profiles bundling @deepseek-ai/dsh-web-app the RUNNING
    // compaction-basic instance sits inside an agent preset (preset-standard's
    // config.plugins) where no patch layer can address the NESTED row by id
    // (#1772/#2360). Since #3354 bili disables those preset rows at LOAD TIME
    // (the always-on bili-compaction-gate entry, active while this module's
    // verdict holds — #3662; vendored from
    // deshark42/dsh-compaction-basic-disable, MIT), so native auto-compaction
    // is off in these profiles too. The durable note confirms the stance and
    // keeps the #2474 full-snapshot recipe as the fallback for dsh builds
    // whose internal 'internal/config' hook moved. Surface it once through the
    // durable channel (GUI hosts swallow stderr); ACP compression is
    // unaffected.
    if (!webProfileWarned) {
        let bundles: readonly string[] | undefined;
        try {
            if (typeof ctx.inject === "function") {
                ctx.inject(["profileContext"], (sub) => {
                    bundles = sub.profileContext?.startedBundles;
                });
            } else {
                bundles = ctx.profileContext?.startedBundles;
            }
        } catch {
            // older dsh builds without the service: diagnostic only
        }
        if (bundles !== undefined && bundles.includes("@deepseek-ai/dsh-web-app")) {
            webProfileWarned = true;
            // #3806: overlay failed to latch -> escalate the passive note into a boot-time alarm.
            const gap = detectCompactionOverlayGap(ctx);
            if (gap !== null) {
                persistClientEvent(`profile bundles include @deepseek-ai/dsh-web-app and the load-time compaction-disable overlay (#3354) could not latch on this dsh build (${gap}) — dsh native auto-compaction is likely ARMED here. bili's wire-level refusal (#1729) refuses routed compaction calls but CANNOT stop dsh writing its checkpoint locally, so a landed checkpoint will destroy the compression substrate and surface later as a 'compression conflict' banner. Apply the #2474 full-snapshot override of preset-standard in your profile's cordis.patch.yml now (a partial snippet silently drops everything not restated; see CONFIGURATION.md)`);
            } else {
                persistClientEvent("profile bundles include @deepseek-ai/dsh-web-app — its agent presets run their own compaction-basic in nested rows no patch layer can address by id (#1772/#2360); bili disables those preset rows at load time via a vendored overlay (deshark42/dsh-compaction-basic-disable, MIT, #3354; since #4147 the match is structural, covering custom presets too), so dsh native auto-compaction stays OFF in this profile (ACP compression unaffected). If you still see a dsh compaction checkpoint land on a newer/older dsh build — the overlay rides cordis' INTERNAL 'internal/config' hook and is version-sensitive — fall back to the #2474 full-snapshot override of preset-standard in your profile's cordis.patch.yml (a partial snippet silently drops everything not restated; see CONFIGURATION.md)." + gateCoverageSuffix());
            }
        } else if (bundles !== undefined && !nonWebTraceLogged) {
            // #3651: the web-profile note above is the ONLY confirmation that
            // the #3354 overlay took effect, and it is scoped to dsh-web-app
            // bundles — every other profile boots silently even though
            // registerCompactionDisable ran unconditionally. Leave one durable
            // trace so a field log can tell "overlay registered" from "profile
            // shape unconfirmed".
            nonWebTraceLogged = true;
            persistClientEvent("profile bundles do not include @deepseek-ai/dsh-web-app — the #3354 load-time compaction-disable middleware is registered anyway (it rewrites any entry's nested compaction-basic/command-compact rows through cordis' version-sensitive internal 'internal/config' hook, covering custom presets as of #4147), but no web-profile disable note applies here; if dsh native auto-compaction still lands in this profile, apply the #2474 full-snapshot override of preset-standard (CONFIGURATION.md) — and note the #1729 wire guard now refuses such native compaction calls unconditionally (the #2028 allowDshCompaction opt-in was removed in #3651)." + gateCoverageSuffix());
        }
    }

    // #1677: forward the host-passed invocation — it carries the invoking agent's
    // session id, which the command path cannot recover from currentInitiator().
    ctx.commands.register({
        name: "acp",
        description: "Show bili context-compression status",
        handler: (invocation) => statusOutcome(ctx, invocation),
    });
    ctx.commands.register({
        name: "acp-cache",
        description: "Prompt-cache reconciliation (same report as the acp_cache tool)",
        handler: (invocation) => cacheOutcome(ctx, invocation),
    });

    // node:test drives apply() directly with a mock ctx — never patch
    // globalThis.fetch from inside a test run.
    if (process.env.NODE_TEST_CONTEXT === undefined) installNativeFetchIntercept(state);
}

/** Test hook: reset the module-level registration lifecycle so suites can
 *  drive apply() repeatedly with a fresh mock ctx. (#4215: optional
 *  toolsReady so gate scenarios can arm the registration state directly.) */
export function _resetRegisterForTest(base: string | undefined, toolsReady = false): void {
    // #3616: invalidate every in-flight recovery chain from earlier scenarios —
    // their late landings must not write this scenario's register/state.
    originGen += 1;
    if (recoveryTimer !== undefined) {
        clearInterval(recoveryTimer);
        recoveryTimer = undefined;
    }
    activeCtx = undefined;
    // #2187: apply() now reaches the respawn arming on every plan, so a stale
    // single-flight wrapper (capturing a previous test's spawn stub) must not
    // survive a reset.
    state.respawn = undefined;
    state.onGiveUp = undefined;
    // #4125: a stale unavailability reason from an earlier scenario must not
    // leak into this scenario's give-up line.
    state.lastUnavailableReason = undefined;
    register.base = base;
    register.toolsReady = toolsReady;
    register.dead = false;
    register.retryAt = 0;
    register.pending = undefined;
    register.failStreak = 0;
    register.lastRegistrationError = undefined;
    register.giveUpSeq = 0;
    regAdoptLogged = false;
    modelInfo.byKey.clear();
    modelInfo.refreshingKeys.clear();
    modelInfo.retryAtByKey.clear();
    modelInfo.services = undefined;
}

/** Test hook (#2082): drive the recovery loop directly — production callers
 *  are traffic-side (headersFor / statusOutcome); tests trigger the same
 *  path without fabricating model traffic. */
export function maybeRetryForTest(ctx: PluginContext): void {
    maybeRetry(ctx);
}

/** Test hook (#4215): drive the fork-adoption entry gate directly without
 *  arming apply() (the fetch patch is not installed under NODE_TEST_CONTEXT). */
export function _maybeForkAdoptBeforeSendForTest(ctx: PluginContext, init: RequestInit | undefined): Promise<void> {
    return maybeForkAdoptBeforeSend(ctx, init);
}

/** Test hook (#4215): reset the fork-gate diagnostics throttle state. */
export function _resetForkGateDiagnosticsForTest(): void {
    forkGateNoted.clear();
    noticedForkBlindSpot = false;
}

/** Test hook (#2604): reset the host-title channel (dedup map + resolved
 *  services) so scenarios start un-armed. */
export function _resetTitlesForTest(): void {
    lastReportedTitles.clear();
    titleServices.sessions = undefined;
    titleServices.sessionTitle = undefined;
}

/** Test hook (#1797): resolve once every in-flight attach/recovery chain has
 *  settled, plus one macrotask so their .then state-writes have run. */
export function _settleNativeForTest(): Promise<void> {
    const all = [...pendingChains];
    return Promise.all(all).catch(() => undefined).then(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

export function _stateHeadersForTest(): ((url: string) => Record<string, string> | undefined) | undefined {
    return state.headersFor;
}

export function _stateTakeoverGateForTest(): ((url: string, body?: { bytes: number }, init?: RequestInit) => GateVerdict | Promise<GateVerdict>) | undefined {
    return state.takeoverGate;
}

/** Test hook (#3370): expose the beforeSend/onResponse hooks so suites can
 * drive the incremental conversion + ack seams directly (the fetch patch is
 * not installed under NODE_TEST_CONTEXT). */
export function _stateBeforeSendForTest(): ((url: string, init: RequestInit | undefined) => Promise<void>) | undefined {
    return state.beforeSend;
}

export function _stateOnResponseForTest(): ((url: string, response: Response, headers?: Record<string, string>) => void) | undefined {
    return state.onResponse;
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

/** Test hook (#3380): expose the armed give-up seam so a suite can fire the
 *  exact callback the interceptor's death branch drives. */
export function _stateOnGiveUpForTest(): (() => void) | undefined {
    return state.onGiveUp;
}

/** Test hook (#4125): expose the shared intercept state so a suite can seed
 *  the fields the interceptor writes (lastUnavailableReason) and observe what
 *  the give-up seam reads. */
export function _nativeStateForTest(): NativeInterceptState {
    return state;
}

/** Test hook (#3380): read-only snapshot of the registration lifecycle. */
export function _registerStateForTest(): { base: string | undefined; toolsReady: boolean; dead: boolean; retryAt: number; failStreak: number; lastRegistrationError: string | undefined } {
    return { base: register.base, toolsReady: register.toolsReady, dead: register.dead, retryAt: register.retryAt, failStreak: register.failStreak, lastRegistrationError: register.lastRegistrationError };
}

/** Test hook (#3380): the capped exponential registration back-off schedule. */
export function _regBackoffForTest(failStreak: number): number {
    return regBackoffMs(failStreak);
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

/** Test hook (#1772): reset the once-per-process web-profile warning flag. */
export function _resetWebProfileWarningForTest(): void {
    webProfileWarned = false;
}

/** Test hook (#3651): reset the once-per-process non-web-profile trace flag. */
export function _resetNonWebTraceForTest(): void {
    nonWebTraceLogged = false;
}

/** Test hook: reset the once-per-process unverified-dsh-build note flag. */
export function _resetDshNewerBuildNoteForTest(): void {
    dshNewerBuildNoted = false;
}

/** #2924 direction 2: a `threw` attribution (host agent scope disposed
 *  mid-request) gets a bounded settle-retry before the gate decides. The
 *  defaults cap the added latency of a dying turn at ~(attempts-1)×delayMs;
 *  #3581 adds giveUpStreak — after that many consecutive requests whose
 *  settle-retry exhausted STILL threw, the gate stops re-settling (a disposed
 *  ctx stays disposed for the host's lifetime, #3578). The hook exists so
 *  tests exercise the cadence without wall-clock waits (same discipline as
 *  BILI_MODEL_INFO_RETRY_MS). */
const DEFAULT_THREW_RETRY = { attempts: 3, delayMs: 250, giveUpStreak: 3 };
let threwRetry = { ...DEFAULT_THREW_RETRY };

/** Test hook (#2924/#3581): override the `threw` settle-retry cadence (merge;
 *  missing fields keep production defaults); no argument restores all defaults. */
export function _setThrewRetryForTest(cfg?: Partial<typeof DEFAULT_THREW_RETRY>): void {
    threwRetry = { ...DEFAULT_THREW_RETRY, ...cfg };
}

// #3581/#3651: attribution-health counters backing the /__bili status
// surface. Module-level like register/webProfileWarned (one live injection
// per host process); _resetAttributionHealthForTest isolates test scenarios.
// error/endpoint ride along on `threw` reports only (#3651 diagnosable-
// failure contract) — `none` episodes never report at all.
let attrHealth: { state: "ok" | "none" | "threw"; refusals: number; since: number; error?: string; endpoint?: string } = { state: "ok", refusals: 0, since: 0 };
let attrReportedRefusals = 0;
let threwStreak = 0;
let threwGiveUpNoticed = false;

/** Test hook (#3581): snapshot the attribution-health counters and give-up latch. */
export function _attributionHealthForTest(): { state: "ok" | "none" | "threw"; refusals: number; since: number; error?: string; endpoint?: string; threwStreak: number; gaveUp: boolean } {
    return { state: attrHealth.state, refusals: attrHealth.refusals, since: attrHealth.since, ...(attrHealth.error !== undefined ? { error: attrHealth.error } : {}), ...(attrHealth.endpoint !== undefined ? { endpoint: attrHealth.endpoint } : {}), threwStreak, gaveUp: threwGiveUpNoticed };
}

/** Test hook (#3581): reset the attribution-health counters between scenarios. */
export function _resetAttributionHealthForTest(): void {
    attrHealth = { state: "ok", refusals: 0, since: 0 };
    attrReportedRefusals = 0;
    threwStreak = 0;
    threwGiveUpNoticed = false;
}

/** Test hook (#2924): seed the model-info cache the gate's oversize arm
 *  reads (production fills it via refreshModelInfo; tests bypass the proxy
 *  round-trip). No argument clears it. */
export function _setModelInfoForTest(entry?: { provider: string; model: string; contextWindow: number }): void {
    if (entry === undefined) {
        modelInfo.byKey.clear();
        return;
    }
    modelInfo.byKey.set(modelInfoKey(entry.provider, entry.model), { provider: entry.provider, model: entry.model, contextWindow: entry.contextWindow });
}
