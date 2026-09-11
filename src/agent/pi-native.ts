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
// Skipped when a proxy is already managed (BILLION_CONTEXT_PROXY set by a
// `bili` MITM launch, or BILI_PROVIDER_REWRITES set by a `bili` /bili/
// launch) or opted out (BILI_NATIVE_PI=0).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBiliPlugin } from "./pi.js";
import { installNativeFetchIntercept, type NativeInterceptState } from "./native-intercept.js";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";

/** dist/agent/pi-native.js → dist/index.js (the package bin). Resolved at
 *  runtime so the artifact works from any install root. */
export function nativeProxyScriptPath(fromUrl: string = import.meta.url): string {
    return path.resolve(path.dirname(fileURLToPath(fromUrl)), "..", "index.js");
}

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNative(env: NodeJS.ProcessEnv): boolean {
    if (env.BILLION_CONTEXT_PLUGIN === "0") return false;
    if (env.BILI_NATIVE_PI === "0") return false;
    // A `bili` launch already owns a proxy — attach to its mode instead of
    // spawning a second one (MITM transparent sets BILLION_CONTEXT_PROXY;
    // /bili/ rewrite mode sets BILI_PROVIDER_REWRITES).
    if (env.BILLION_CONTEXT_PROXY !== undefined && env.BILLION_CONTEXT_PROXY.trim().length > 0) return false;
    if (env.BILI_PROVIDER_REWRITES !== undefined) return false;
    return true;
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false },
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

// node:test imports this module for shouldBootstrapNative/nativeProxyScriptPath —
// never bootstrap a real proxy from inside a test run.
if (process.env.NODE_TEST_CONTEXT === undefined && shouldBootstrapNative(process.env)) {
    state.respawn = bootstrap;
    state.ready = bootstrap();
    installNativeFetchIntercept(state);
}

export default createBiliPlugin();

export { fetchStatus } from "./pi.js";
