// In-process fetch interception for dsh native mode (#521). dsh's LLM stack
// (pi-ai) issues bare `fetch(url, init)` calls resolved against globalThis at
// call time, so wrapping globalThis.fetch is sufficient to route its traffic
// through bili without touching dsh's config files.
//
// Routing targets are resolved ASYNC per call via `resolveTargets`: the caller
// may still be bootstrapping its proxy (spawning `bili daemon`) when the first
// LLM fetch fires, so each call awaits the (memoized, bounded) readiness check
// instead of leaking that early traffic direct. Once resolved, only requests
// whose target origin equals the ACTIVE upstream origin are rewritten to
// `<proxyOrigin>/bili/<original-url>`. Everything else — the plugin's own
// management calls (they target the proxy origin), npm, telemetry, arbitrary
// http — passes through byte-identical. If a rewritten call fails at the
// network layer (proxy died), that single request degrades to a direct
// upstream call: the user's session never breaks because of us. Abort errors
// are never retried — the caller asked to stop.

export interface FetchInterceptTargets {
    /** scheme://host[:port] of the active LLM upstream, no trailing slash. */
    upstreamOrigin: string;
    /** bili proxy origin, e.g. http://127.0.0.1:8787, no trailing slash. */
    proxyOrigin: string;
}

export interface FetchInterceptOptions {
    /** Resolve the current routing targets; `undefined` = pass this call
     *  through untouched. Awaited before every routing decision, so calls
     *  made before bootstrap completes are intercepted once it finishes. */
    resolveTargets: () => Promise<FetchInterceptTargets | undefined>;
    fetchImpl?: typeof fetch;
}

export interface FetchInterceptStats {
    rewritten: number;
    passthrough: number;
    degraded: number;
}

export interface FetchInterceptor {
    uninstall(): void;
    stats(): FetchInterceptStats;
}

type FetchInput = string | URL | Request;
type FetchFn = (input: FetchInput, init?: RequestInit) => Promise<Response>;

function isNetworkError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === "AbortError") return false;
    // undici/node fetch reports connection-level failures as TypeError
    // ("fetch failed") with the cause on .cause.
    return err.name === "TypeError";
}

export function installFetchInterceptor(opts: FetchInterceptOptions): FetchInterceptor {
    const real: FetchFn = (opts.fetchImpl ?? globalThis.fetch) as FetchFn;
    const stats: FetchInterceptStats = { rewritten: 0, passthrough: 0, degraded: 0 };
    const previous = globalThis.fetch;
    let active = true;

    async function wrapped(input: FetchInput, init?: RequestInit): Promise<Response> {
        if (!active) return real(input, init);
        let upstream: string | undefined;
        let proxy: string | undefined;
        try {
            const t = await opts.resolveTargets();
            if (t) {
                upstream = new URL(t.upstreamOrigin).origin;
                proxy = new URL(t.proxyOrigin).origin;
                if (upstream === proxy) {
                    upstream = undefined;
                    proxy = undefined;
                }
            }
        } catch {
            upstream = undefined;
            proxy = undefined;
        }
        if (!upstream || !proxy) {
            stats.passthrough++;
            return real(input, init);
        }
        let urlStr: string | undefined;
        if (typeof input === "string") urlStr = input;
        else if (input instanceof URL) urlStr = input.href;
        else if (input instanceof Request) urlStr = input.url;
        let target: string | Request | undefined;
        if (urlStr !== undefined) {
            try {
                if (new URL(urlStr).origin === upstream) {
                    target = `${proxy}/bili/${urlStr}`;
                    if (input instanceof Request) target = new Request(target, input);
                }
            } catch {
                target = undefined;
            }
        }
        if (target === undefined) {
            stats.passthrough++;
            return real(input, init);
        }
        stats.rewritten++;
        try {
            return await real(target, init);
        } catch (err) {
            if (!isNetworkError(err)) throw err;
            stats.degraded++;
            return real(input, init);
        }
    }

    globalThis.fetch = wrapped as typeof fetch;
    return {
        uninstall(): void {
            if (!active) return;
            active = false;
            if (globalThis.fetch === (wrapped as typeof fetch)) {
                globalThis.fetch = previous;
            }
        },
        stats(): FetchInterceptStats {
            return { ...stats };
        },
    };
}
