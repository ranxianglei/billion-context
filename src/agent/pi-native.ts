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
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { createBiliPlugin } from "./pi.js";
import { isLegacyBcpEntry, legacyBcpEntriesIn, markNativeHost, nativeAttachOrigin, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, setNativeOriginWaiter, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, noteRoutedOrigin, observeRoutedOrigin, readyOrigin, type NativeInterceptState } from "./native-intercept.js";
import { fetchProxyVersion, fetchStatus, waitForProxyVersion } from "./shared.js";

// Shared plumbing lives in native-bootstrap.ts (side-effect-free — importing
// pi-native.ts from another host entry must not run pi's bootstrap).
export { nativeProxyScriptPath, singleFlight } from "./native-bootstrap.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNative(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_PI");
}

/** Decide this process's native posture (#886/#983 mechanism, ported to the pi
 *  lane in #1795). Precedence kill-switch > /bili/ rewrite launch > attach >
 *  spawn. A preset BILLION_CONTEXT_PROXY is an ATTACH target, not a stand-down:
 *  the pseudo-attach hole (preset env + bare pi) used to disarm routing entirely
 *  while tools still found the proxy through the env — model traffic went direct
 *  and uncompressed, the proxy never saw the session, and every tool forward
 *  404'd. Attach keeps the user's intent ("route through THIS proxy"); explicit
 *  BILLION_CONTEXT_ATTACH wins when both are set. A /bili/ launch
 *  (BILI_PROVIDER_REWRITES) still stands us down — its URLs are already
 *  proxy-shaped. */
export function planNativePi(env: NodeJS.ProcessEnv): { mode: "off" | "attach" | "spawn"; attachOrigin?: string } {
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_PI === "0") return { mode: "off" };
    if (env.BILI_PROVIDER_REWRITES !== undefined) return { mode: "off" };
    const attachOrigin = nativeAttachOrigin(env) ?? proxyEnvOrigin(env);
    if (attachOrigin !== undefined) return { mode: "attach", attachOrigin };
    return { mode: "spawn" };
}

export { isLegacyBcpEntry, legacyBcpEntriesIn };

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
        console.error(
            `[bili-native] billion-context-pi is also installed (${file}: ${found.join(", ")}) — it compresses in-process and cannot see the native proxy, so every request would be compressed twice.\n` +
            `[bili-native] remove it: \`bili plugin install pi\` (strips global entries) or \`pi remove ${found[0]}\` — and check <project>/.pi/settings.json for a project-scope entry.`,
        );
    }
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };

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
        console.error(`bili-native: proxy bootstrap failed — model traffic goes direct (uncompressed): ${errMessage(err)}`);
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
            console.log(`bili-native(pi): attach target ${pinned} is healthy again — attached, no second instance spawned`);
            return back;
        }
        console.error(`bili-native(pi): attach target ${pinned} is down and this process's model channel is pinned to it — refusing to spawn a second instance (bili tools would 404 against the other one). Start your proxy at ${pinned} or unset BILLION_CONTEXT_PROXY; bili keeps re-checking and self-heals when it comes back.`);
        state.origin = undefined;
        return undefined;
    }
    console.error(`bili-native(pi): attach target ${attachOrigin} is not healthy — falling back to a spawned proxy`);
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

let _started = false;

/** Run this module's bootstrap exactly once: decide the posture, arm the
 *  shared intercept state, and install the fetch-layer rewrite outside test
 *  runs. The standalone dist/agent/pi-native.js entry calls this at module
 *  evaluation (below) — preserving the original load-time behavior including
 *  the synchronous BILLION_CONTEXT_NATIVE stamp (#820/#824). The in-process
 *  entry (dist/agent/pi-inprocess.js) reaches it only through its BILI_PI_INPROC=0
 *  fallback, via dynamic import, so the default in-process mode never
 *  evaluates this module at all. */
export function startPiNative(): void {
    if (_started) return;
    _started = true;
    const plan = planNativePi(process.env);
    if (plan.mode === "off") return;
    armNativePi(plan);
    // node:test imports this module for shouldBootstrapNative/nativeProxyScriptPath —
    // never patch globalThis.fetch or bootstrap a real proxy from inside a test run.
    if (process.env.NODE_TEST_CONTEXT === undefined) {
        installNativeFetchIntercept(state);
    }
}

startPiNative();

/** Wire the shared intercept state for the planned mode. Attach mode arms
 *  even under NODE_TEST_CONTEXT (it installs no global patches and spawns
 *  nothing while the target is healthy, so tests can drive it directly);
 *  spawn mode stays test-guarded because bootstrap forks a real proxy. */
export function armNativePi(p: ReturnType<typeof planNativePi>): void {
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
                    console.warn(`bili-native(pi): model channel pinned to ${origin} — rebinding bili tools there`);
                });
            };
            state.ready = start();
        } else {
            state.ready = Promise.resolve(undefined);
        }
    } else if (process.env.NODE_TEST_CONTEXT === undefined) {
        const start = singleFlight(bootstrap);
        state.respawn = start;
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
    state.ready = Promise.resolve(undefined);
    _spawnForTest = undefined;
    delete process.env.BILLION_CONTEXT_PROXY;
}

const nativeExtension = createBiliPlugin();

// Fallback bridge for the in-process entry (dist/agent/pi-inprocess.js under
// BILI_PI_INPROC=0): the host passes its REAL ExtensionAPI, while
// createBiliPlugin() is typed against pi.ts's structurally-narrower local copy
// (predating the host package becoming a devDep). Runtime-safe: pi invokes the
// default export below with this same object in production (#519), so every
// member the local type names exists on the real one.
export function nativePiExtension(api: import("@earendil-works/pi-coding-agent").ExtensionAPI): void {
    nativeExtension(api as unknown as Parameters<typeof nativeExtension>[0]);
}
export default nativeExtension;

export { fetchStatus } from "./pi.js";
