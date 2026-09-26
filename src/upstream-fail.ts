/** Upstream transport failure taxonomy (#1263).
 *
 *  Field diagnosis of long-session failures (omp → bili → external proxy →
 *  upstream) was blind because every network error surfaced as a flattened
 *  `code=/message=` blob: a proxy that recycles the socket mid-CONNECT, an
 *  upstream that goes silent past the idle budget, and a client disconnect
 *  are three different remedies, but were indistinguishable in the log. This
 *  module owns the ONE classification used everywhere (fetchWithRetry's
 *  replay decision, formatUpstreamError's log prefix, the status snapshot).
 *
 *  Kept dependency-free and below both fetch-util and upstream-proxy so
 *  neither imports the other just for this (they already form an import
 *  edge upstream-proxy → fetch-util; adding the reverse would be a cycle). */

export type UpstreamFailureKind =
    /** Downstream client disconnected (external abort fired). Nothing bili
     *  did or can retry — the request is dead by definition. */
    | "client-abort"
    /** Idle-budget / connect-time expiry: our own watchdog aborted, or the
     *  OS/undici reported a timeout. NOT retried — the budget already waited. */
    | "upstream-timeout"
    /** Connect-phase reset THROUGH a proxy: socket died before the response
     *  started, and a proxy sits in the path — prime suspect is the proxy
     *  recycling the tunnel (idle recycle, payload cap, node churn). */
    | "proxy-reset"
    /** Same fail-fast reset, direct connection (no proxy): suspect the
     *  upstream or the local network, not a proxy. */
    | "upstream-reset"
    /** TCP refused — the proxy when one is configured, else the upstream. */
    | "connect-refused"
    /** Name resolution failed (ENOTFOUND / EAI_AGAIN). */
    | "dns"
    /** TLS/certificate failure at the proxy CONNECT or upstream handshake. */
    | "tls"
    | "unknown";

export interface UpstreamFailCtx {
    /** A proxy dispatcher is in the path — changes reset/refused attribution. */
    viaProxy?: boolean;
    /** True when the caller's EXTERNAL abort signal (client disconnect) has
     *  fired. Without it, an AbortError is attributed to bili's own idle
     *  watchdog (upstream-timeout) — the common internal-abort shape. */
    externalAborted?: boolean;
}

function chainOf(error: unknown): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    let cur: unknown = error;
    for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
        out.push(cur as unknown as Record<string, unknown>);
        cur = (cur as Error & { cause?: unknown }).cause;
    }
    return out;
}

/** Classify a transport-level failure into the diagnostic taxonomy. Pure:
 *  no IO, no clock — safe to call from anywhere, including tests. */
export function classifyUpstreamFailure(error: unknown, ctx: UpstreamFailCtx = {}): UpstreamFailureKind {
    if (ctx.externalAborted === true) return "client-abort";
    const chain = chainOf(error);
    if (chain.length === 0) return "unknown";
    for (const entry of chain) {
        const code = typeof entry.code === "string" ? entry.code : undefined;
        const name = typeof entry.name === "string" ? entry.name : undefined;
        if (code === undefined) {
            if (name === "AbortError") return "upstream-timeout";
            continue;
        }
        if (code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "upstream-timeout";
        if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "UND_ERR_SOCKET") return ctx.viaProxy ? "proxy-reset" : "upstream-reset";
        if (code === "ECONNREFUSED") return "connect-refused";
        if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
        if (code === "EPROTO" || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.startsWith("CERT_")) return "tls";
    }
    return "unknown";
}

/** Fail-fast kinds: the attempt died BEFORE any response byte existed, so a
 *  replay cannot double-deliver anything and the failure cost milliseconds —
 *  the opposite of the timeout/abort family, where the budget already waited
 *  and retrying would stack wait times (#1263 handshake-resilience scope). */
export function isFailFastUpstreamKind(kind: UpstreamFailureKind): boolean {
    return kind === "proxy-reset" || kind === "upstream-reset" || kind === "connect-refused";
}

/** One-line remediation hint per kind — used by logs and the docs so the
 *  taxonomy and the checklist never drift apart. */
export const UPSTREAM_FAIL_HINTS: Record<UpstreamFailureKind, string> = {
    "client-abort": "downstream client disconnected — no bili-side action",
    "upstream-timeout": "idle budget expired or connect timed out — check upstream health; not retried by design",
    "proxy-reset": "proxy dropped the connection before the response — check proxy idle-recycle/payload limits (BILI_PROXY_KEEPALIVE_MAX_MS can shorten our reuse window); a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "upstream-reset": "upstream/network reset before the response — check upstream and local network; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "connect-refused": "TCP refused (proxy when configured, else upstream) — endpoint down or wrong port",
    dns: "name resolution failed — DNS server or hostname typo",
    tls: "TLS/certificate failure at CONNECT or upstream handshake — CA/proxy MITM config",
    unknown: "unclassified transport failure — report with full error chain",
};
