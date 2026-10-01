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
// Skipped when a proxy is already managed (BILLION_CONTEXT_PROXY set by a
// `bili` MITM launch, or BILI_PROVIDER_REWRITES set by a `bili` /bili/
// launch) or opted out (BILI_NATIVE_OMP=0).

import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { createBiliPlugin } from "./pi.js";
import { applyOmpFirstEventTimeout, markNativeHost, nativeBootstrapGate, nativeProxyScriptPath, proxyEnvOrigin, setNativeOriginWaiter, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, readyOrigin, type NativeInterceptState } from "./native-intercept.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNativeOmp(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_OMP");
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
        console.error(`bili-native: proxy bootstrap failed — model traffic goes direct (uncompressed): ${errMessage(err)}`);
        return undefined;
    }
}

const nativeActive = shouldBootstrapNativeOmp(process.env);
if (nativeActive) markNativeHost(process.env, "omp");
// #1774: widen OMP's first-parsed-event watchdog before any stream can start — a
// preflight over a large context holds the response for minutes while OMP only
// sees keep-alive comments, and its default 300s timer would abort mid-compression.
// Sync at module eval so it lands before the first request; user-pinned values win.
if (process.env.NODE_TEST_CONTEXT === undefined && ompTrafficRidesBili(process.env)) {
    applyOmpFirstEventTimeout(process.env);
}

// node:test imports this module for shouldBootstrapNativeOmp — never
// bootstrap a real proxy from inside a test run.
if (process.env.NODE_TEST_CONTEXT === undefined && nativeActive) {
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
    installNativeFetchIntercept(state);
}

export default createBiliPlugin("omp");
