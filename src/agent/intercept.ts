/**
 * Runtime egress interception for native mode (#519).
 *
 * Wraps globalThis.fetch inside the host agent's Node process so requests
 * destined for an active model's upstream origin are routed through a
 * per-session bili proxy (`<proxyOrigin>/bili/<original-url>` — the same
 * zero-config prefix format the proxy already terminates). Everything else
 * passes through untouched, so a host process that makes unrelated HTTP
 * calls (telemetry, update checks) is unaffected.
 *
 * JS identifiers resolve to globals dynamically at call time, and provider
 * SDKs pass bare `fetch` identifiers (no local shadowing), so patching the
 * global intercepts real provider traffic without touching client config.
 */

export interface InterceptOptions {
    /** Proxy origin, e.g. `http://127.0.0.1:43210`. Trailing slash tolerated. */
    proxyOrigin: string;
    /** Exact origins (scheme+host+port) whose outgoing requests get rewritten. */
    upstreamOrigins: Iterable<string>;
}

type FetchFn = typeof globalThis.fetch;

interface ActiveInterceptor {
    original: FetchFn;
    wrapped: FetchFn;
}

type FetchInput = string | URL | Request;

let active: ActiveInterceptor | null = null;

function normalizeOrigins(entries: Iterable<string>): Set<string> {
    const set = new Set<string>();
    for (const entry of entries) {
        const s = entry.trim();
        if (!s) continue;
        try {
            set.add(new URL(s).origin);
        } catch {
            // Unparseable entry — skip rather than poison the whole set.
        }
    }
    return set;
}

function inputUrl(input: FetchInput): string | null {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
    return null;
}

export function installFetchInterceptor(opts: InterceptOptions): () => void {
    if (!opts.proxyOrigin || typeof opts.proxyOrigin !== "string") {
        throw new Error("installFetchInterceptor: proxyOrigin is required");
    }
    const proxyOrigin = opts.proxyOrigin.replace(/\/+$/, "");
    const origins = normalizeOrigins(opts.upstreamOrigins);
    if (origins.size === 0) {
        throw new Error("installFetchInterceptor: no valid upstreamOrigins");
    }

    // Re-installing replaces any prior wrapper (model/provider switches, tests).
    if (active && globalThis.fetch === active.wrapped) {
        globalThis.fetch = active.original;
    }
    const original = globalThis.fetch;
    if (typeof original !== "function") {
        throw new Error("installFetchInterceptor: globalThis.fetch unavailable");
    }

    const rewrite = (urlStr: string): string | null => {
        let u: URL;
        try {
            u = new URL(urlStr);
        } catch {
            return null;
        }
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        // Already proxied — never double-wrap (#519).
        if (u.pathname.startsWith("/bili/")) return null;
        if (!origins.has(u.origin)) return null;
        return `${proxyOrigin}/bili/${urlStr}`;
    };

    const wrapped: FetchFn = ((input: FetchInput, init?: RequestInit) => {
        const url = inputUrl(input);
        const target = url !== null ? rewrite(url) : null;
        if (target === null) return original.call(globalThis, input, init);
        if (typeof input === "string" || input instanceof URL) {
            return original.call(globalThis, target, init);
        }
        const req: Request = input;
        const rinit: RequestInit & { duplex?: "half" } = {
            method: req.method,
            headers: req.headers,
            signal: req.signal,
        };
        if (req.body != null) {
            rinit.body = req.body;
            rinit.duplex = "half";
        }
        return original.call(globalThis, target, rinit);
    }) as FetchFn;

    globalThis.fetch = wrapped;
    active = { original, wrapped };

    return () => {
        if (globalThis.fetch === wrapped) globalThis.fetch = original;
    };
}
