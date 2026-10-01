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

/** Normalize a preset BILLION_CONTEXT_PROXY value (http/https, trailing
 *  slashes stripped) for attach-style routing. Returns undefined when unset,
 *  blank, or not a valid http(s) origin. */
export function proxyEnvOrigin(env: NodeJS.ProcessEnv): string | undefined {
    const raw = env.BILLION_CONTEXT_PROXY;
    if (raw === undefined) return undefined;
    const url = raw.trim();
    if (url.length === 0 || !/^https?:\/\//i.test(url)) return undefined;
    try {
        new URL(url);
    } catch {
        return undefined;
    }
    return url.replace(/\/+$/, "");
}

/** External-proxy attach signal (#809): when BILLION_CONTEXT_ATTACH holds a
 *  valid http(s) origin, a host-native entry routes model traffic THROUGH that
 *  pre-existing proxy instead of spawning its own — no ownership, no respawn,
 *  fail-closed on its death. Returns the normalized origin (trailing slash
 *  stripped) or undefined when unset/blank/malformed/non-http(s). */
export function nativeAttachOrigin(env: NodeJS.ProcessEnv): string | undefined {
    const raw = env.BILLION_CONTEXT_ATTACH;
    if (raw === undefined) return undefined;
    const url = raw.trim();
    if (url.length === 0 || !/^https?:\/\//i.test(url)) return undefined;
    try {
        new URL(url);
    } catch {
        return undefined;
    }
    return url.replace(/\/+$/, "");
}

/** Millisecond env-var knob (#1365): a finite positive number wins, anything
 *  else (unset, blank, garbage, non-positive) falls back to the default so a
 *  bad value can never produce a zero/negative timeout. */
export function envMillis(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** #1774: OMP's SSE watchdog aborts the turn when no PARSED model event arrives
 *  within PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS (default 300s). A bili preflight
 *  over a large context holds the response for minutes before the first SSE event,
 *  and the `: bili-preflight` keep-alive comments (#568) are filtered by OMP's SSE
 *  parser before the iterator, so they cannot reset that timer. When bili owns the
 *  process's model traffic we therefore export a wider first-event budget; the
 *  post-first-event idle timeout stays at OMP's default. The cap stays finite so a
 *  genuinely stuck preflight still fails in bounded time instead of hanging. */
export const OMP_FIRST_EVENT_TIMEOUT_ENV = "PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS";
export const OMP_FIRST_EVENT_TIMEOUT_DEFAULT_MS = 1_800_000;

/** The value bili exports for OMP's first-event watchdog: the default above, or
 *  undefined when the user pinned their own value (blank counts as unset — same
 *  convention as nativeBootstrapGate). Explicit values are never clobbered,
 *  including "0" (OMP's disable sentinel). */
export function ompFirstEventTimeoutValue(env: NodeJS.ProcessEnv): string | undefined {
    const raw = env[OMP_FIRST_EVENT_TIMEOUT_ENV];
    if (raw !== undefined && raw.trim().length > 0) return undefined;
    return String(OMP_FIRST_EVENT_TIMEOUT_DEFAULT_MS);
}

/** Stamp the first-event watchdog value onto env when (and only when) the user
 *  has not pinned one. No-op otherwise. */
export function applyOmpFirstEventTimeout(env: NodeJS.ProcessEnv): void {
    const value = ompFirstEventTimeoutValue(env);
    if (value !== undefined) env[OMP_FIRST_EVENT_TIMEOUT_ENV] = value;
}

/** Coexistence marker (#820): tells standalone in-process bili extensions
 *  (billion-context-pi / opencode-acp) that a host-native entry owns THIS
 *  process so they back off instead of double-compressing. Set synchronously
 *  at module evaluation — before any await — because those extensions check
 *  BILLION_CONTEXT_PROXY at load time (our bootstrap writes it only after the
 *  proxy is up) and their /bili/ baseUrl check never sees our fetch-layer
 *  rewrite. First writer wins: one process hosts one native entry. Callers
 *  gate on their own shouldBootstrap*() so opt-outs and launches where a bili
 *  launcher already manages the proxy leave the marker unset. */
export function markNativeHost(env: NodeJS.ProcessEnv, host: string): void {
    if (env.BILLION_CONTEXT_NATIVE === undefined || env.BILLION_CONTEXT_NATIVE.length === 0) {
        env.BILLION_CONTEXT_NATIVE = host;
    }
}

/** True when a pi/opencode packages[] entry loads the LEGACY standalone
 *  billion-context-pi extension (#939): npm spec (bare or versioned), or any
 *  path whose segments contain billion-context-pi (node_modules install, git
 *  spec or checkout path). That extension compresses IN-PROCESS, and versions
 *  without the BILLION_CONTEXT_NATIVE stand-down (billion-context-pi#461,
 *  unreleased at 0.1.71) cannot see the proxy their entry spawns — their
 *  BILLION_CONTEXT_PROXY check runs at factory time, before our async
 *  bootstrap writes it, and the fetch-layer rewrite keeps the baseUrl clean.
 *  Co-resident = every request compressed twice, silently. Shared between the
 *  pi host entry's co-residence net and the #1206 third-party scan because
 *  importing pi-native.ts from a non-pi process would run its bootstrap gate. */
export function isLegacyBcpEntry(entry: string): boolean {
    const e = entry.trim();
    const bare = e.replace(/^npm:/, "");
    return bare === "billion-context-pi"
        || /^billion-context-pi@/.test(bare)
        || /(^|[/\\])billion-context-pi([/\\]|$)/.test(e);
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

// ———— Native-origin waiter (#1243) ——————————————————————————————————
// Native entries spawn the proxy asynchronously and publish its origin via
// NativeInterceptState; the shared factory's before_provider_headers reads
// BILLION_CONTEXT_PROXY, which bootstrap() writes only after the spawn. A
// one-shot's single header event can fire inside that window, so the reader
// awaits the writer through this channel instead of racing it. Hosts without
// a native entry register no waiter — awaitNativeProxyOrigin() resolves
// undefined immediately and the session rides wire mode as before.

export interface NativeOriginWaiter {
    wait: () => Promise<string | undefined>;
}

let originWaiter: NativeOriginWaiter | undefined;

export function setNativeOriginWaiter(waiter: NativeOriginWaiter): void {
    originWaiter = waiter;
}

export async function awaitNativeProxyOrigin(): Promise<string | undefined> {
    return originWaiter === undefined ? undefined : originWaiter.wait();
}
