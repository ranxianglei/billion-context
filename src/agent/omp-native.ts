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
import { markNativeHost, nativeBootstrapGate, nativeProxyScriptPath, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, setDeclaredModelEndpoints, type NativeInterceptState } from "./native-intercept.js";
import { loadDeclaredModelEndpoints } from "../model-endpoints.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNativeOmp(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_OMP");
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

// node:test imports this module for shouldBootstrapNativeOmp — never
// bootstrap a real proxy from inside a test run.
if (process.env.NODE_TEST_CONTEXT === undefined && nativeActive) {
    const start = singleFlight(bootstrap);
    state.respawn = start;
    state.onGiveUp = () => {
        // We wrote BILLION_CONTEXT_PROXY at successful bootstrap. If the proxy
        // dies mid-session and the respawn fails, traffic goes direct — clear
        // the env so event-time ownership checks (session_before_compact
        // cancel, prompt_cache_key stamping) stop claiming compression
        // ownership and native compaction comes back with the direct traffic.
        delete process.env.BILLION_CONTEXT_PROXY;
    };
    state.ready = start();
    // #1295: declared custom-wire endpoints — same config source as the proxy;
    // takes effect on the next host start (config is read once at arm time).
    void loadDeclaredModelEndpoints().then(setDeclaredModelEndpoints);
    installNativeFetchIntercept(state);
}

export default createBiliPlugin("omp");
