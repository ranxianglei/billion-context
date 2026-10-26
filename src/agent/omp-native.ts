// Native omp mode (#957): the package-installed omp extension bootstraps its
// own proxy — bare `omp` (with this package installed via
// `bili plugin install omp`) gets full plugin-mode compression with NO
// launcher. Same flow as pi-native.ts (#519):
//   1. spawn the package's own proxy (`dist/index.js start`, ephemeral
//      port, parent-pid watchdog = this omp process) via ensureProxyRunning —
//      a healthy compatible instance is ATTACHED, not doubled;
//   2. patch globalThis.fetch (native-intercept.ts) so model-API requests
//      are rewritten to `<proxy>/bili/<full-upstream-url>` (verified
//      patchable under Bun — omp runs on a bundled bun);
//   3. set BILLION_CONTEXT_PROXY so the shared plugin (pi.ts) detects the
//      proxy through its existing env fallback — tools, /acp, the compaction
//      cancel and the prompt_cache_key stamp all reuse the launcher-mode
//      code paths. omp never emits before_provider_headers, so its
//      runtime-info report (#955) rides before_provider_request instead.
// Posture (planNativeOmp — #886/#983 mechanism, ported to the omp lane for
// #1795): a preset BILLION_CONTEXT_PROXY (or explicit BILLION_CONTEXT_ATTACH)
// is an ATTACH target, not a stand-down — the pseudo-attach hole used to
// disarm routing entirely while tools still found the proxy through the env,
// sending every model request direct and uncompressed. Stand down only for a
// /bili/ rewrite launch (BILI_PROVIDER_REWRITES) or an opt-out
// (BILLION_CONTEXT_PLUGIN=0 / BILI_NATIVE_OMP=0).

import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { createBiliPlugin } from "./pi.js";
import { applyOmpFirstEventTimeout, markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, setNativeOriginWaiter, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, noteRoutedOrigin, observeRoutedOrigin, readyOrigin, type NativeInterceptState } from "./native-intercept.js";
import { clearIncrementalProbe, createPrepareDirectSend, hostMsgIdHintFor, INCREMENTAL_TURN_MARKER_HEADER, INCREMENTAL_TURN_ID_HEADER, newIncrementalTurnId, noteIncrementalAck, noteIncrementalRejection, planIncrementalTurn, probeIncrementalTurns, rememberOriginalBody, sweepStale, wireMessagesLookAnthropic, type IncrementalWireMessage } from "./incremental-client.js";
import { fetchProxyVersion, waitForProxyVersion } from "./shared.js";
import { logHostEvent } from "./host-log.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNativeOmp(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_OMP");
}

/** Decide this process's native posture (#886/#983 mechanism, ported to the
 *  omp lane in #1795). Precedence kill-switch > /bili/ rewrite launch >
 *  attach > spawn. A preset BILLION_CONTEXT_PROXY is an ATTACH target, not a
 *  stand-down: the pseudo-attach hole (preset env + bare omp) used to disarm
 *  routing entirely while tools still found the proxy through the env — model
 *  traffic went direct and uncompressed, the proxy never saw the session, and
 *  every tool forward 404'd. Attach keeps the user's intent ("route through
 *  THIS proxy"); explicit BILLION_CONTEXT_ATTACH wins when both are set. A
 *  /bili/ launch (BILI_PROVIDER_REWRITES) still stands us down — its URLs are
 *  already proxy-shaped. */
export function planNativeOmp(env: NodeJS.ProcessEnv): { mode: "off" | "attach" | "spawn"; attachOrigin?: string } {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_OMP === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const attachOrigin = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attachOrigin !== undefined) return { mode: "attach", attachOrigin };
    return { mode: "spawn" };
}

/** #1774: true when this OMP process routes model traffic through a bili proxy —
 *  self-bootstrap (gate passed), launcher/MITM launch (BILLION_CONTEXT_PROXY), or
 *  /bili/-rewrite launch (BILI_PROVIDER_REWRITES). Only then can a long preflight
 *  outrun OMP's 300s first-parsed-event watchdog. */
export function ompTrafficRidesBili(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_OMP")
        || proxyEnvOrigin(env) !== undefined
        || env.BILI_PROVIDER_REWRITES !== undefined;
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };

// #3248 phase 2: incremental-turn divert for omp. omp never emits header
// events, so the ONLY identity signal at the fetch layer is the
// `prompt_cache_key` body field the omp extension stamps (pi.ts
// stampPromptCacheKey — present exactly when the plugin is active). The
// beforeSend hook reads it as the conversation id, plans the incremental
// body, swaps init.body and stamps the plugin headers DIRECTLY ON init —
// plugin mode is safe here: x-bili-plugin-conversation gets the same value
// wire mode already resolves to via preferPromptCacheKeyIdentity, so the
// session id does not fork. #3329: each planned turn is keyed by a fresh
// per-request turn id stamped onto init's headers (x-bili-turn-id) —
// several sessions share one provider URL, and keying the pending table by
// URL mis-attributes a late response to whichever session planned last on
// that URL. The #3378 single-flight guard per URL is KEPT on top of turn-id
// keying (#3340 rebase decision): while a marker'd request for this URL is
// still awaiting its ack, later requests on the same URL ride the normal
// pipeline — attribution answers "which ack consumes which pending", the
// guard answers "no second conversion on this URL until the first is acked
// or ages out"; dropping the guard is a separate follow-up.
interface IncrementalPendingTurn {
    sid: string;
    url: string;
    messages: IncrementalWireMessage[];
    system: unknown;
    base: string;
    at: number;
}
/** Keyed by per-request turn id (#3329); each entry remembers the URL it
 *  was planned on so the #3378 single-flight guard can scan for live
 *  same-URL entries. */
const incPendingOmp = new Map<string, IncrementalPendingTurn>();

/** Planned turns age out (onResponse only fires on successful sends — a
 *  network-dead request must not pin its slot forever). Memory hygiene only
 *  (#3329): attribution is exact per turn id. Mirrors opencode. */
const INC_PENDING_TTL_MS = 30_000;

/** #4491 omp msgids: align the host's branch-entry ids (stashed by the omp
 *  extension's before_provider_request for this conversation id) against the
 *  ACTUALLY-sent wire messages — count + role, pairwise. Returns the id
 *  sequence only on a provable 1:1 match; any mismatch (branch out of sync
 *  with the sent history, a native-compaction summary that became a wire
 *  message but has no entry id, an aux persona, an older host without
 *  getBranch) returns undefined and the turn rides without the field. The
 *  sent messages are the alignment authority: a sequence that cannot be
 *  proven parallel is never sent — a misaligned id would pin the wrong
 *  identity server-side, while a missing field merely falls back to
 *  content-derived ids. */
function ompTurnMsgIds(sid: string, messages: IncrementalWireMessage[]): string[] | undefined {
    const hint = hostMsgIdHintFor(sid);
    if (hint === undefined || hint.length !== messages.length) return undefined;
    const ids: string[] = [];
    for (let i = 0; i < hint.length; i++) {
        if (hint[i].role !== messages[i].role) return undefined;
        ids.push(hint[i].id);
    }
    return ids;
}

/** Test hook: drop all planned turns (module state across suites). */
export function __resetOmpIncrementalForTests(): void {
    incPendingOmp.clear();
}

export async function ompIncrementalBeforeSend(url: string, init: RequestInit | undefined): Promise<void> {
    try {
        if (init === undefined || typeof init.body !== "string") { return; }
        sweepStale(incPendingOmp, INC_PENDING_TTL_MS);
        let parsed: unknown;
        try {
            parsed = JSON.parse(init.body);
        } catch {
            return;
        }
        if (parsed === null || typeof parsed !== "object") return;
        const b = parsed as { messages?: unknown; model?: unknown; system?: unknown; prompt_cache_key?: unknown };
        if (typeof b.model !== "string" || !wireMessagesLookAnthropic(b.messages)) { return; }
        const sid = typeof b.prompt_cache_key === "string" ? b.prompt_cache_key.trim() : "";
        if (sid.length === 0) { return; }
        const base = state.origin;
        if (base === undefined) { return; }
        if (!(await probeIncrementalTurns(base))) { return; }
        const plan = planIncrementalTurn({ conversationId: sid, path: "/v1/messages", messages: b.messages as IncrementalWireMessage[], system: b.system as unknown, request: b as { model?: unknown } & Record<string, unknown>, msgIds: ompTurnMsgIds(sid, b.messages as IncrementalWireMessage[]) });
        if (plan.mode === "skip") { return; }
        // #3378 single-flight (kept over #3329's removal per the rebase
        // decision): while a marker'd request for this URL is still awaiting
        // its ack, later requests ride the normal pipeline. Pending entries
        // are keyed by turn id (#3329), so the guard scans for a live entry
        // stashed on THIS url (sweepStale above already aged out the stale
        // ones — an aged entry must not block a fresh conversion).
        let inflight = false;
        for (const pending of incPendingOmp.values()) {
            if (pending.url === url && Date.now() - pending.at < INC_PENDING_TTL_MS) { inflight = true; break; }
        }
        if (inflight) { return; }
        const turnId = newIncrementalTurnId();
        // #3304: stash the pre-swap body under this turn's id — if the proxy
        // dies before the send lands, the direct-send guard restores these
        // bytes instead of forwarding the lane-only payload upstream.
        rememberOriginalBody(turnId, init.body);
        init.body = plan.body;
        const headers = new Headers(init.headers);
        headers.set("x-bili-plugin", "omp");
        headers.set("x-bili-plugin-conversation", sid);
        headers.set(INCREMENTAL_TURN_MARKER_HEADER, "1");
        headers.set(INCREMENTAL_TURN_ID_HEADER, turnId);
        init.headers = headers;
        incPendingOmp.set(turnId, { sid, url, messages: b.messages as IncrementalWireMessage[], system: b.system as unknown, base, at: Date.now() });
    } catch (e) {
        // never break the host's request on adapter failure
    }
}

state.beforeSend = ompIncrementalBeforeSend;
// #3304: the omp swap stamps the turn id atomically with the body, so the
// strict shared guard applies — mutated + unrestorable ⇒ refuse locally.
state.prepareDirectSend = createPrepareDirectSend();

export function ompIncrementalOnResponse(_url: string, response: Response, headers?: Record<string, string>): void {
    const turnId = headers?.[INCREMENTAL_TURN_ID_HEADER];
    if (turnId === undefined) return; // not an incremental dispatch — nothing to attribute (#3329)
    const pending = incPendingOmp.get(turnId);
    if (pending === undefined) return; // unknown/stale turn — nothing to attribute
    const seq = response.headers.get("x-bili-applied-seq");
    if (response.status === 200 && (seq === null || !Number.isFinite(Number(seq)))) {
        // 200 without an ack header CANNOT be the marker'd response — the
        // lane stamps x-bili-applied-seq on every diverted response that
        // reaches the forward (incremental-lane.ts writeHead wrap). It is a
        // concurrent full-resend response on the shared model-endpoint URL:
        // keep the pending entry for the marker'd response still in flight.
        return;
    }
    incPendingOmp.delete(turnId);
    try {
        if (response.status === 200) {
            noteIncrementalAck(pending.sid, Number(seq), pending.messages, pending.system);
            return;
        }
        if (response.status === 409) {
            // #3369: reset (re-seed next turn) unless the rejection circuit
            // trips — one drift must not permanently kill the conversation.
            const verdict = noteIncrementalRejection(pending.sid);
            logHostEvent("warn", "[native-client]", `[omp] incremental turn rejected (409) — conversation ${pending.sid} ${verdict === "dead" ? "falls back to full resend (rejection circuit)" : "re-seeds with a full resync next turn"} (#3369)`);
            return;
        }
        if (response.status === 503) {
            // #3369: lane temporarily unavailable — keep the conversation's
            // ack state; just force a re-probe on the next turn.
            clearIncrementalProbe(pending.base);
            logHostEvent("warn", "[native-client]", `[omp] incremental turns unavailable (503) — conversation ${pending.sid} state preserved, re-probing next turn (#3369)`);
        }
    } catch {
        // observability only
    }
}

state.onResponse = ompIncrementalOnResponse;

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "omp" },
            { scriptPath: nativeProxyScriptPath() },
        );
        const origin = handle.origin;
        state.origin = origin;
        process.env.BILLION_CONTEXT_PROXY = origin;
        return origin;
    } catch (err) {
        logHostEvent("error", "[native-client]", `bili-native: proxy bootstrap failed — model traffic goes direct (uncompressed): ${errMessage(err)}`);
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
 *  back to spawning our own proxy, re-arming respawn as a pure spawn. Resolves
 *  to the origin the client should use — the (recovered) attach origin, the
 *  fallback origin, or undefined when nothing came up. */
export async function verifyAttachAndRecover(attachOrigin: string): Promise<string | undefined> {
    // #1365: routed evidence outranks the planned origin — probe where the
    // model channel actually points, not where the env says it should. An
    // EXPLICIT BILLION_CONTEXT_ATTACH outranks both: it names the plugin API
    // endpoint directly, and a routed model origin may be a plain model-only
    // path (e.g. an admin-gated port) that never exposes the plugin manifest.
    const explicitAttachOrigin = nativeAttachOrigin(process.env);
    const home = explicitAttachOrigin ?? state.routedOrigin ?? attachOrigin;
    const version = await fetchProxyVersion(home).catch(() => undefined);
    if (version !== undefined) {
        // Restore the readyOrigin short-circuit — a runtime recovery clears
        // state.origin before re-probing, and a transient blip must not leave
        // it dangling.
        publishOrigin(home);
        return home;
    }
    const pinned = explicitAttachOrigin ?? state.routedOrigin ?? (await observeRoutedOrigin(state));
    if (pinned !== undefined) {
        const back = await waitForProxyVersion(pinned);
        if (back !== undefined) {
            publishOrigin(back);
            logHostEvent("info", "[native-client]", `bili-native(omp): attach target ${pinned} is healthy again — attached, no second instance spawned`);
            return back;
        }
        logHostEvent(
            "error",
            "[native-client]",
            explicitAttachOrigin !== undefined
                ? `bili-native(omp): explicit attach target ${pinned} unreachable within the health deadline — refusing to spawn a second instance (your declared endpoint stays authoritative). Start your proxy at ${pinned} or unset BILLION_CONTEXT_ATTACH; bili keeps re-checking and self-heals when it comes back.`
                : `bili-native(omp): attach target ${pinned} is down and this process's model channel is pinned to it — refusing to spawn a second instance (bili tools would 404 against the other one). Start your proxy at ${pinned} or unset BILLION_CONTEXT_PROXY; bili keeps re-checking and self-heals when it comes back.`,
        );
        state.origin = undefined;
        return undefined;
    }
    logHostEvent("error", "[native-client]", `bili-native(omp): attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`);
    delete process.env.BILLION_CONTEXT_PROXY;
    state.attach = false;
    publishOrigin(undefined, false); // env already cleared above

    const start = singleFlight(_spawnForTest ?? bootstrap);
    state.respawn = start;
    // Publish whatever origin lands on BOTH the shared state and the env —
    // env readers (compaction reporter, /acp status) must never disagree with
    // what the route resolves, whoever produced the origin.
    const landed = start().then((o) => {
        if (o !== undefined) publishOrigin(o);
        return o;
    });
    state.ready = landed;
    return landed;
}

const plan = planNativeOmp(process.env);

/** Wire the shared intercept state for the planned mode. Attach mode arms
 *  even under NODE_TEST_CONTEXT (it installs no global patches and spawns
 *  nothing while the target is healthy, so tests can drive it directly);
 *  spawn mode stays test-guarded because bootstrap forks a real proxy. */
export function armNativeOmp(p: typeof plan): void {
    if (p.mode === "off") return;
    markNativeHost(process.env, "omp");
    if (p.mode === "attach") {
        state.attach = true;
        const attachOrigin = p.attachOrigin;
        if (attachOrigin !== undefined) {
            // #1135: arm the SAME probe+fallback for runtime death — the
            // attached proxy is usually owned by ANOTHER launcher that can
            // exit while this session rides it; the resolver then re-probes
            // and falls back exactly like at startup. No synchronous
            // state.origin freeze: the fetch intercept resolves live per
            // request via readyOrigin(state).
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
                    logHostEvent("warn", "[native-client]", `bili-native(omp): model channel pinned to ${origin} — rebinding bili tools there`);
                });
            };
            state.ready = start();
        } else {
            state.ready = Promise.resolve(undefined);
        }
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        const start = singleFlight(bootstrap);
        state.respawn = start;
        // #1531: pi-native's #1243 pattern — before_provider_request reads the
        // proxy base from BILLION_CONTEXT_PROXY, which bootstrap() writes
        // asynchronously. Publish the ready promise so the awaited runtime-info
        // report can wait on the writer instead of racing it.
        setNativeOriginWaiter({ wait: () => readyOrigin(state) });
        state.onGiveUp = () => {
            // We wrote BILLION_CONTEXT_PROXY at successful bootstrap. If the proxy
            // dies mid-session and the respawn fails, traffic goes direct — clear
            // the env so event-time ownership checks (session_before_compact
            // cancel, prompt_cache_key stamping) stop claiming compression
            // ownership and native compaction comes back with the direct traffic.
            delete process.env.BILLION_CONTEXT_PROXY;
        };
        state.ready = start();
    }
}

if (plan.mode !== "off") armNativeOmp(plan);

// #1774: widen OMP's first-parsed-event watchdog before any stream can start — a
// preflight over a large context holds the response for minutes while OMP only
// sees keep-alive comments, and its default 300s timer would abort mid-compression.
// Sync at module eval so it lands before the first request; user-pinned values win.
if (process.env.NODE_TEST_CONTEXT === undefined && ompTrafficRidesBili(process.env)) {
    applyOmpFirstEventTimeout(process.env);
}

// node:test imports this module for shouldBootstrapNativeOmp — never
// patch globalThis.fetch or bootstrap a real proxy from inside a test run.
if (process.env.NODE_TEST_CONTEXT === undefined && plan.mode !== "off") {
    installNativeFetchIntercept(state);
}

/** Test hook: point the module state at a lane origin (the incremental
 *  beforeSend reads state.origin as its probe base). */
let originPinnedForTest = false;

/** Publish a discovered origin to the shared state + env. Every async
 *  discovery path funnels through here so a test-pinned base (see
 *  _setOmpOriginForTest) survives attach verify / respawn landing at an
 *  arbitrary point during a suite — without the guard the pin gets clobbered
 *  mid-test and probes race off to the REAL lane. */
function publishOrigin(origin: string | undefined, envToo = true): void {
    if (originPinnedForTest) return;
    state.origin = origin;
    if (!envToo) return;
    if (origin === undefined) delete process.env.BILLION_CONTEXT_PROXY;
    else process.env.BILLION_CONTEXT_PROXY = origin;
}

export function _setOmpOriginForTest(origin: string | undefined): void {
    originPinnedForTest = origin !== undefined;
    state.origin = origin;
}

/** Test hook: expose the armed runtime-recovery seam (mirrors pi/opencode/dsh). */
export function _stateRespawnForTest(): (() => Promise<string | undefined>) | undefined {
    return state.respawn;
}

/** Test hook (#1365): record routed-channel evidence without the fetch patch. */
export function _noteRoutedForTest(url: string): void {
    noteRoutedOrigin(state, url);
}

/** Test hook: reset the module-level state in place (closures capture the
 *  object reference) so suites can drive armNativeOmp repeatedly. */
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

export default createBiliPlugin("omp");
