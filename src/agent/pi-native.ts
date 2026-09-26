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
// launch) or opted out (BILI_NATIVE_PI=0). Once the proxy is up we also scan
// the pi settings files for a co-resident legacy billion-context-pi entry
// and warn — see warnLegacyBcpCoResident (#939).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { createBiliPlugin } from "./pi.js";
import { isLegacyBcpEntry, markNativeHost, nativeBootstrapGate, nativeProxyScriptPath, setNativeOriginWaiter, singleFlight } from "./native-bootstrap.js";
import { installNativeFetchIntercept, readyOrigin, type NativeInterceptState } from "./native-intercept.js";
import { fetchStatus } from "./shared.js";

// Shared plumbing lives in native-bootstrap.ts (side-effect-free — importing
// pi-native.ts from another host entry must not run pi's bootstrap).
export { nativeProxyScriptPath, singleFlight } from "./native-bootstrap.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNative(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_PI");
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
        if (!Array.isArray(parsed.packages)) return [];
        return (parsed.packages as unknown[]).map(String).filter(isLegacyBcpEntry);
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

const nativeActive = shouldBootstrapNative(process.env);
if (nativeActive) markNativeHost(process.env, "pi");

// node:test imports this module for shouldBootstrapNative/nativeProxyScriptPath —
// never bootstrap a real proxy from inside a test run.
if (process.env.NODE_TEST_CONTEXT === undefined && nativeActive) {
    const start = singleFlight(bootstrap);
    state.respawn = start;
    // #1243: the factory's before_provider_headers reads the proxy base from
    // BILLION_CONTEXT_PROXY, which bootstrap() writes asynchronously — a
    // one-shot's single header event fires before that. Publish the ready
    // promise so the reader can await the writer instead of racing it.
    setNativeOriginWaiter({ wait: () => readyOrigin(state) });
    state.onGiveUp = () => {
        // We wrote BILLION_CONTEXT_PROXY at successful bootstrap. If the proxy
        // dies mid-session and the respawn fails, traffic goes direct — clear
        // the env so event-time ownership checks (session_before_compact
        // cancel, header stamping) stop claiming compression ownership and
        // native compaction comes back with the direct traffic.
        delete process.env.BILLION_CONTEXT_PROXY;
    };
    state.ready = start();
    installNativeFetchIntercept(state);
}

export default createBiliPlugin();

export { fetchStatus } from "./pi.js";
