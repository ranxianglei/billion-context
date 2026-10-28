// Native pi mode (#519): the package-installed pi extension bootstraps its
// own proxy — bare `pi` (with this package installed via pi's package
// manager or `bili plugin install pi`) gets full plugin-mode compression
// with NO launcher. Flow at extension load:
//   1. spawn the package's own proxy (`dist/index.js start`, ephemeral
//      port, parent-pid watchdog = this pi process) via ensureProxyRunning —
//      a healthy compatible instance is ATTACHED, not doubled;
//   2. patch globalThis.fetch (native-intercept.ts) so model-API requests
//      are rewritten to `<proxy>/bili/<full-upstream-url>`;
//   3. set BILLION_CONTEXT_PROXY so the shared plugin (pi.ts) detects the
//      proxy through its existing env fallback — tools, headers, /acp and
//      the compaction cancel all reuse the launcher-mode code paths.
// Inline mode (#3278, BILI_PI_INLINE=1 or "pi": {"inline": true}, default off): NO proxy process at all
// — a fetch-chain link below the intercept routes the pseudo-origin traffic
// into an in-process engine (inline-engine.ts) that runs the same per-request
// pipeline startServer serves over HTTP.
// Posture (planNativePi — #886/#983 mechanism, ported to the pi lane in
// #1795): a preset BILLION_CONTEXT_PROXY (or explicit BILLION_CONTEXT_ATTACH)
// is an ATTACH target, not a stand-down — the pseudo-attach hole used to disarm
// routing entirely while tools still found the proxy through the env, sending
// every model request direct and uncompressed. Stand down only for a /bili/
// rewrite launch (BILI_PROVIDER_REWRITES) or an opt-out (BILLION_CONTEXT_PLUGIN=0
// / BILI_NATIVE_PI=0). Once we own a proxy we scan the pi settings files for a
// co-resident legacy billion-context-pi entry and warn — see
// warnLegacyBcpCoResident (#939).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST, SPAWN_BUDGET_MS } from "../launcher.js";
import { piPackageStrings } from "../plugin-install.js";
import { createBiliPlugin, createPiDirectSendGuard } from "./pi.js";
import { isLegacyBcpEntry, markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, setNativeOriginWaiter, singleFlight } from "./native-bootstrap.js";
import { loadConfigFile } from "../config.js";
import { getInlineEngine, INLINE_ORIGIN } from "../inline-engine.js";
import { installNativeFetchIntercept, noteRoutedOrigin, observeRoutedOrigin, readyOrigin, type NativeInterceptState } from "./native-intercept.js";
import { installInlineTransport } from "./pi-inline.js";
import { installNativeWebSocketIntercept } from "./native-ws-intercept.js";
import { fetchProxyVersion, fetchStatus, waitForProxyVersion } from "./shared.js";
import { logHostEvent } from "./host-log.js";

// Shared plumbing lives in native-bootstrap.ts (side-effect-free — importing
// pi-native.ts from another host entry must not run pi's bootstrap).
export { nativeProxyScriptPath, singleFlight } from "./native-bootstrap.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNative(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_PI");
}

/** Decide this process's native posture (#886/#983 mechanism, ported to the pi
 *  lane in #1795). Precedence kill-switch > /bili/ rewrite launch > explicit
 *  inline > attach > spawn (DEFAULT). A preset BILLION_CONTEXT_PROXY is an ATTACH target, not a
 *  stand-down: the pseudo-attach hole (preset env + bare pi) used to disarm
 *  routing entirely while tools still found the proxy through the env — model
 *  traffic went direct and uncompressed, the proxy never saw the session, and
 *  every tool forward 404'd. Attach keeps the user's intent ("route through
 *  THIS proxy"); explicit BILLION_CONTEXT_ATTACH wins when both are set. A
 *  /bili/ launch (BILI_PROVIDER_REWRITES) still stands us down — its URLs are
 *  already proxy-shaped. BILI_PI_INLINE (#3278) outranks ambient attach envs:
 *  it is a deliberate choice about WHERE compression runs (in this process),
 *  not just which proxy to use. Resolved env > file > default(off): the
 *  config-file home is `"pi": {"inline": true}`; an explicit BILI_PI_INLINE=0/
 *  false disables over the file. OPT-IN ONLY (owner decision on #4687:
 *  never flip defaults) — unset env/file behaves exactly as before the
 *  #4571 default flip (attach > spawned proxy); `bili pi-inline` presets
 *  BILI_PI_INLINE=1 for the one-command lane. */
export function planNativePi(env: NodeJS.ProcessEnv, fileInline: boolean | undefined = undefined): { mode: "off" | "attach" | "spawn" | "inline"; attachOrigin?: string } {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_PI === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const inlineEnv = env.BILI_PI_INLINE?.trim().toLowerCase();
    // Truthy set deliberately wide: "on"/"yes" are common shells' habit and a
    // miss here silently fell through to spawn mode — the user saw a proxy
    // server start, concluded inline "didn't work", and never learned why.
    const inlineEnvOff = inlineEnv === "0" || inlineEnv === "false" || inlineEnv === "no" || inlineEnv === "off";
    const inlineEnvOn = inlineEnv !== undefined && inlineEnv !== "" && !inlineEnvOff;
    // Explicit choices keep the historical precedence — an explicit env OFF
    // still suppresses a file-true value (env > file, #3278 contract):
    if (!inlineEnvOff && (inlineEnvOn || fileInline === true)) return { mode: "inline" };
    const attachOrigin = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attachOrigin !== undefined) return { mode: "attach", attachOrigin };
    // …then spawn: the historical default (owner decision on #4687 — inline
    // is opt-in only, the #4571 default flip is reverted; a proxy server is
    // spawned unless BILI_PI_INLINE / pi.inline=true opted into in-process).
    return { mode: "spawn" };
}

export { isLegacyBcpEntry };

/** packages[] entries in one pi settings.json that load billion-context-pi. */
export function legacyBcpEntriesIn(file: string): string[] {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return [];
    }
    try {
        const parsed = JSON.parse(text) as { packages?: unknown };
        // #3131: string specs only — object entries ({source: "…"}) stringify
        // to "[object Object]" and can never match.
        return piPackageStrings(parsed.packages).filter(isLegacyBcpEntry);
    } catch {
        return [];
    }
}

// Co-residence net for manual installs (#939): `bili plugin install pi`
// strips legacy entries from the GLOBAL settings, but a project-scope entry
// (`pi install -l`) or a post-install manual `pi install npm:billion-context-pi`
// re-adds one without our installer ever seeing it. Scan both settings files
// once we know THIS process owns compression and say so loudly — the legacy
// side stays silent exactly when it is most dangerous.
function warnLegacyBcpCoResident(): void {
    const piHome = process.env.PI_CODING_AGENT_DIR?.trim() || process.env.PI_HOME?.trim() || path.join(os.homedir(), ".pi", "agent");
    for (const file of [path.join(piHome, "settings.json"), path.join(process.cwd(), ".pi", "settings.json")]) {
        const found = legacyBcpEntriesIn(file);
        if (found.length === 0) continue;
        logHostEvent(
            "error",
            "[native-client]",
            `[bili-native] billion-context-pi is also installed (${file}: ${found.join(", ")}) — it compresses in-process and cannot see the native proxy, so every request would be compressed twice.\n` +
                `[bili-native] remove it: \`bili plugin install pi\` (strips global entries) or \`pi remove ${found[0]}\` — and check <project>/.pi/settings.json for a project-scope entry.`,
        );
    }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
// #3304: the pi extension swaps payloads inside its runner — the guard
// sniffs the outgoing envelope and restores the stashed original before any
// direct-send fall-back reaches the real upstream.
state.prepareDirectSend = createPiDirectSendGuard();

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "pi" },
            { scriptPath: nativeProxyScriptPath() },
        );
        const origin = handle.origin;
        state.origin = origin;
        process.env.BILLION_CONTEXT_PROXY = origin;
        warnLegacyBcpCoResident();
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
        state.origin = home;
        process.env.BILLION_CONTEXT_PROXY = home;
        return home;
    }
    const pinned = explicitAttachOrigin ?? state.routedOrigin ?? (await observeRoutedOrigin(state));
    if (pinned !== undefined) {
        const back = await waitForProxyVersion(pinned);
        if (back !== undefined) {
            state.origin = back;
            process.env.BILLION_CONTEXT_PROXY = back;
            logHostEvent("info", "[native-client]", `bili-native(pi): attach target ${pinned} is healthy again — attached, no second instance spawned`);
            return back;
        }
        logHostEvent(
            "error",
            "[native-client]",
            explicitAttachOrigin !== undefined
                ? `bili-native(pi): explicit attach target ${pinned} unreachable within the health deadline — refusing to spawn a second instance (your declared endpoint stays authoritative). Start your proxy at ${pinned} or unset BILLION_CONTEXT_ATTACH; bili keeps re-checking and self-heals when it comes back.`
                : `bili-native(pi): attach target ${pinned} is down and this process's model channel is pinned to it — refusing to spawn a second instance (bili tools would 404 against the other one). Start your proxy at ${pinned} or unset BILLION_CONTEXT_PROXY; bili keeps re-checking and self-heals when it comes back.`,
        );
        state.origin = undefined;
        return undefined;
    }
    logHostEvent("error", "[native-client]", `bili-native(pi): attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`);
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

const plan = planNativePi(process.env, loadConfigFile().pi?.inline);

/** Wire the shared intercept state for the planned mode. Attach mode arms
 *  even under NODE_TEST_CONTEXT (it installs no global patches and spawns
 *  nothing while the target is healthy, so tests can drive it directly);
 *  spawn mode stays test-guarded because bootstrap forks a real proxy. */
export function armNativePi(p: typeof plan): void {
    if (p.mode === "off") return;
    markNativeHost(process.env, "pi");
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
                    logHostEvent("warn", "[native-client]", `bili-native(pi): model channel pinned to ${origin} — rebinding bili tools there`);
                });
            };
            state.ready = start();
        } else {
            state.ready = Promise.resolve(undefined);
        }
    } else if (p.mode === "inline") {
        // #3278: no proxy process exists. The pseudo-origin is frozen
        // SYNCHRONOUSLY so readyOrigin() short-circuits per request and no
        // health probe can ever target a host that never listens; the fetch
        // link installed below routes its traffic into the in-process engine.
        state.attach = false;
        state.origin = INLINE_ORIGIN;
        process.env.BILLION_CONTEXT_PROXY = INLINE_ORIGIN;
        warnLegacyBcpCoResident();
        logHostEvent("info", "[native-client]", "bili-native(pi): inline mode — compression runs in-process, no proxy server will be started");
        const start = singleFlight(async () => {
            await getInlineEngine();
            return INLINE_ORIGIN;
        });
        state.respawn = start;
        // Codex Responses WS lane (#3278 follow-up): the pseudo-origin is
        // never dialable, so the WS wrapper rewrites to the engine's loopback
        // bridge instead. Assigned SYNCHRONOUSLY as a promise — any WS
        // constructed before the bridge listens defers (bounded), and a failed
        // bridge settles undefined → the wrapper degrades that lane DIRECT
        // (warned) while HTTP compression keeps running in-process.
        state.wsOrigin = (async () => (await getInlineEngine()).wsOrigin)().catch(() => undefined);
        setNativeOriginWaiter({ wait: () => readyOrigin(state) });
        state.onGiveUp = () => {
            delete process.env.BILLION_CONTEXT_PROXY;
            state.origin = undefined;
        };
        // Production mirrors spawn mode's fail-fast posture (bootstrap at arm
        // time); tests stay lazy so nothing starts until one asks for it.
        state.ready = process.env.NODE_TEST_CONTEXT === undefined ? start() : Promise.resolve(undefined);
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        const start = singleFlight(bootstrap);
        state.respawn = start;
        // #4516: a request may hold out for an IN-FLIGHT spawn under the
        // launcher's own bring-up budget (+margin for health settle) instead of
        // degrading at the generic 15s readiness cap — a slow cold start
        // (#4515) must not refuse or direct-send a turn the proxy would have
        // served had it finished starting a few seconds later.
        state.spawnWaitMs = SPAWN_BUDGET_MS + 10_000;
        // #1243: the factory's before_provider_headers reads the proxy base from
        // BILLION_CONTEXT_PROXY, which bootstrap() writes asynchronously — a
        // one-shot's single header event fires before that. Publish the ready
        // promise so the reader can await the writer instead of racing it.
        setNativeOriginWaiter({ wait: () => readyOrigin(state) });
        state.onGiveUp = () => {
            delete process.env.BILLION_CONTEXT_PROXY;
        };
        state.ready = start();
    }
}

if (plan.mode !== "off") armNativePi(plan);

// node:test imports this module for shouldBootstrapNative/nativeProxyScriptPath —
// never patch globalThis.fetch or bootstrap a real proxy from inside a test run.
if (process.env.NODE_TEST_CONTEXT === undefined && plan.mode !== "off") {
    // #3278: chain order is install order — the inline transport must sit
    // BELOW the fetch intercept so its `/bili/<upstream>` rewrite lands on
    // this link instead of egressing toward a proxy port that does not exist.
    if (plan.mode === "inline") installInlineTransport();
    installNativeFetchIntercept(state);
    // #2111: the Codex Responses WS leg shares the fetch intercept's enable
    // conditions and lifecycle — off mode patches nothing, repeated loads are
    // no-ops, and the wrapper installs before any model connection exists.
    // Inline mode rewrites WS traffic to the engine's loopback bridge
    // (state.wsOrigin) — the lane was previously left unpatched there, which
    // let codex WS traffic bypass compression entirely.
    installNativeWebSocketIntercept(state);
}

/** Test hook: expose the armed runtime-recovery seam (mirrors opencode/dsh). */
export function _stateRespawnForTest(): (() => Promise<string | undefined>) | undefined {
    return state.respawn;
}

/** Test hook (#1365): record routed-channel evidence without the fetch patch. */
export function _noteRoutedForTest(url: string): void {
    noteRoutedOrigin(state, url);
}

/** Test hook: reset the module-level state in place (closures capture the
 *  object reference) so suites can drive armNativePi repeatedly. */
export function _resetNativeStateForTest(): void {
    state.attach = undefined;
    state.origin = undefined;
    state.routedOrigin = undefined;
    state.onRoutedOriginObserved = undefined;
    state.respawn = undefined;
    state.onGiveUp = undefined;
    state.spawnWaitMs = undefined;
    state.ready = Promise.resolve(undefined);
    _spawnForTest = undefined;
    delete process.env.BILLION_CONTEXT_PROXY;
    delete process.env.BILI_PI_INLINE;
}

// The extension factory is agent="pi" — the SAME code pi/extension mode
// runs — so the incremental-turn wiring (marker stamp in
// before_provider_headers + payload swap in before_provider_request + ack in
// after_provider_response) is inherited unchanged; pi-native only changes
// HOW the proxy base is found (self-spawned handle vs external lane). No
// incremental-specific code lives here by design (#3248 phase 2).
export default createBiliPlugin();

export { fetchStatus } from "./pi.js";
