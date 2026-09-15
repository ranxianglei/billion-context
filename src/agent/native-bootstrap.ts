// Shared native-mode bootstrap plumbing (#519 pi pattern, reused by every
// host-native entry — opencode 2.x per #820). Kept free of host-specific side
// effects: importing this module must NEVER spawn a proxy or patch anything —
// the host entries (pi-native.ts / opencode-native.ts) own their module-level
// bootstrap blocks.

import path from "node:path";
import { fileURLToPath } from "node:url";

/** dist/agent/<entry>.js → dist/index.js (the package bin). Resolved at
 *  runtime so the artifact works from any install root. */
export function nativeProxyScriptPath(fromUrl: string = import.meta.url): string {
    return path.resolve(path.dirname(fileURLToPath(fromUrl)), "..", "index.js");
}

/** Common gate for host-native bootstraps: off when the global plugin kill
 *  switch or the per-host opt-out key is set, or when a `bili` launch already
 *  owns a proxy (MITM transparent sets BILLION_CONTEXT_PROXY; /bili/ rewrite
 *  mode sets BILI_PROVIDER_REWRITES). */
export function nativeBootstrapGate(env: NodeJS.ProcessEnv, optOutKey: string): boolean {
    if (env.BILLION_CONTEXT_PLUGIN === "0") return false;
    if (env[optOutKey] === "0") return false;
    if (env.BILLION_CONTEXT_PROXY !== undefined && env.BILLION_CONTEXT_PROXY.trim().length > 0) return false;
    if (env.BILI_PROVIDER_REWRITES !== undefined) return false;
    return true;
}

/** Concurrent callers share one in-flight bootstrap — a burst of failures
 *  (the proxy died mid-session) must not spawn one proxy per failing request:
 *  ensureProxyRunning has no in-flight dedup of its own. */
export function singleFlight(fn: () => Promise<string | undefined>): () => Promise<string | undefined> {
    let inFlight: Promise<string | undefined> | undefined;
    return (): Promise<string | undefined> => {
        if (inFlight === undefined) {
            inFlight = fn().finally(() => {
                inFlight = undefined;
            });
        }
        return inFlight;
    };
}
