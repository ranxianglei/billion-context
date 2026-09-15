// Native opencode mode (#820 opencode line; npm-package design tracked in
// #809): the package-installed OpenCode 2.x plugin bootstraps its own proxy —
// the pi pattern (#519/#706), adapted to opencode's egress seam. Flow at
// plugin load:
//   1. spawn the package's own proxy (`dist/index.js start`, ephemeral port,
//      parent-pid watchdog = this opencode process) via ensureProxyRunning —
//      a healthy compatible instance is ATTACHED, not doubled;
//   2. register an http.request hook that rewrites model-API URLs to
//      `<proxy>/bili/<full-upstream-url>` and stamps nothing else — header
//      stamping / tools / compaction reporting all reuse the shared V2 setup
//      (opencode-v2.ts), which detects the proxy through the env var set in
//      step 1;
//   3. set BILLION_CONTEXT_PROXY after bootstrap so tool execute() and the
//      compaction reporter find the proxy through their existing env path.
//
// Why URL rewrite instead of pi's global fetch patch: opencode's plugins have
// no fetch seam they can patch — the only observed egress hook is http.request
// with the outgoing fetch Request at e.request. WHATWG Request.url is
// read-only at runtime (verified live on 2.0.x, #810), so the request REFERENCE
// is replaced with a new Request to `<proxy>/bili/<url>` carrying the same
// method/headers/body.
//
// Liveness gate (differs from pi by design): an http.request hook CANNOT
// observe send failures (the host swallows them; #809 verification list), so
// unlike pi's post-failure respawn, every outgoing request first probes
// `/__bili/health` (bounded) of the current origin and respawns if dead. If
// no origin can be made healthy the request goes DIRECT (uncompressed) and a
// one-time stderr warning fires — recovery is automatic once a proxy is
// healthy again (no permanent latch; each request re-verifies). Bootstrap
// retries are rate-limited to one attempt per RESPAWN_COOLDOWN_MS so a
// persistently failing spawn does not become a per-request spawn storm.
//
// Skipped when a proxy is already managed (BILLION_CONTEXT_PROXY set by a
// `bili` launch, or BILI_PROVIDER_REWRITES set by a `bili` /bili/ launch) or
// opted out (BILI_NATIVE_OPENCODE=0 / BILLION_CONTEXT_PLUGIN=0).
//
// Deployment: OpenCode 2.x `plugin` entries must be DIRECTORIES whose index.js
// is the entrypoint (bare file paths are rejected, #754 probe) — `bili plugin
// install opencode` writes <configDir>/plugins/billion-context/index.js
// re-exporting this entry (same wrapper shape the launcher builds,
// src/launcher.ts prepareOpencodeHttpRewrite).

import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "../launcher.js";
import { nativeBootstrapGate, nativeProxyScriptPath, singleFlight } from "./native-bootstrap.js";
import { isModelApiUrl, readyOrigin, type NativeInterceptState } from "./native-intercept.js";
import { createOpencodeV2Setup, type V2HttpRequestEvent, type V2State } from "./opencode-v2.js";

/** Decides whether the native bootstrap should run in this process. */
export function shouldBootstrapNativeOpencode(env: NodeJS.ProcessEnv): boolean {
    return nativeBootstrapGate(env, "BILI_NATIVE_OPENCODE");
}

const HEALTH_TIMEOUT_MS = 1500;
const RESPAWN_COOLDOWN_MS = 15_000;

async function probeHealth(origin: string): Promise<boolean> {
    try {
        const res = await fetch(`${origin}/__bili/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        return res.ok;
    } catch {
        return false;
    }
}

export interface OpencodeNativeRouteDeps {
    probe?: (origin: string) => Promise<boolean>;
    /** Bootstrap retry interval when no live origin is held (tests shrink it). */
    respawnCooldownMs?: number;
}

/** Build the native-mode route callback consumed by createOpencodeV2Setup.
 *  The probe is injectable for tests; the default does a bounded GET of
 *  /__bili/health. */
export function createNativeRoute(state: NativeInterceptState, deps: OpencodeNativeRouteDeps = {}): (e: V2HttpRequestEvent, s: V2State) => Promise<void> {
    const probe = deps.probe ?? probeHealth;
    const respawnCooldownMs = deps.respawnCooldownMs ?? RESPAWN_COOLDOWN_MS;
    let warned = false;
    let lastRespawn = 0;

    const healthyOrigin = async (): Promise<string | undefined> => {
        let ownedThenLost = false;
        if (state.origin !== undefined) {
            if (await probe(state.origin)) return state.origin;
            // Proxy died mid-session. Clearing origin first makes concurrent
            // callers share the same state.ready (dedup).
            ownedThenLost = true;
            state.origin = undefined;
        }
        // Retry bootstrap whenever no live origin is held — either just lost
        // it or the load-time bootstrap failed (the hook cannot observe send
        // failures, so nothing else would retry). Cooldown bounds attempts to
        // one per interval instead of one per request.
        if (state.respawn !== undefined && (ownedThenLost || Date.now() - lastRespawn >= respawnCooldownMs)) {
            lastRespawn = Date.now();
            state.ready = state.respawn();
        }
        const o = await readyOrigin(state);
        if (o !== undefined && (await probe(o))) return o;
        if (ownedThenLost) state.onGiveUp?.();
        return undefined;
    };

    return async (e, s) => {
        const url = typeof e.request?.url === "string" ? e.request.url : undefined;
        if (url === undefined) return;
        if (!isModelApiUrl(url)) return;
        const target = await healthyOrigin();
        if (target === undefined) {
            if (!warned) {
                warned = true;
                console.error("bili-native-opencode: proxy unavailable — model requests go direct (uncompressed)");
            }
            return;
        }
        warned = false;
        s.proxyBase = target;
        try {
            e.request = new Request(`${target}/bili/${url}`, e.request as unknown as Request);
        } catch {
            // undici refuses to copy a body-bearing Request without explicit
            // duplex — reconstruct with the body stream passed explicitly.
            const old = e.request as unknown as { method?: unknown; headers?: Iterable<readonly [string, string]> | null; body?: ReadableStream<Uint8Array> | null };
            try {
                const init: RequestInit & { duplex?: "half" } = { method: typeof old.method === "string" ? old.method : "GET" };
                const pairs: [string, string][] = [];
                try {
                    for (const pair of old.headers ?? []) pairs.push([pair[0], pair[1]]);
                } catch {}
                if (pairs.length > 0) init.headers = pairs;
                if (old.body != null) {
                    init.body = old.body as RequestInit["body"];
                    init.duplex = "half";
                }
                e.request = new Request(`${target}/bili/${url}`, init);
            } catch {
                // replacement impossible (exotic body) — request goes direct
            }
        }
    };
}

const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };

async function bootstrap(): Promise<string | undefined> {
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false },
            { scriptPath: nativeProxyScriptPath() },
        );
        state.origin = handle.origin;
        process.env.BILLION_CONTEXT_PROXY = handle.origin;
        return handle.origin;
    } catch (err) {
        console.error(`bili-native-opencode: proxy bootstrap failed — model traffic goes direct (uncompressed): ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

if (process.env.NODE_TEST_CONTEXT === undefined && shouldBootstrapNativeOpencode(process.env)) {
    const start = singleFlight(bootstrap);
    state.respawn = start;
    state.onGiveUp = () => {
        delete process.env.BILLION_CONTEXT_PROXY;
    };
    state.ready = start();
}

export default { id: "billion-context-opencode-native", setup: createOpencodeV2Setup({ route: createNativeRoute(state) }) };
