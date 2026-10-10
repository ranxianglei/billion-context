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
    /** Idle-budget / read-phase timeout expiry: our own watchdog aborted, or
     *  OS/undici reported a headers/body timeout. NOT retried — the budget
     *  already waited and the request may have reached the upstream. */
    | "upstream-timeout"
    /** Connect-phase timeout (undici UND_ERR_CONNECT_TIMEOUT): the TCP
     *  handshake never completed, so nothing reached the upstream and each
     *  attempt costs at most one connect timeout — replayed within the retry
     *  budget (#1453). */
    | "connect-timeout"
    /** Connect-phase ICMP "no route" rejection (EHOSTUNREACH / ENETUNREACH /
     *  EHOSTDOWN): the kernel refused the connection IMMEDIATELY — same
     *  pre-response status as connect-refused (nothing reached the upstream,
     *  per-attempt cost is milliseconds) so it replays within the budget
     *  (#2465). Deliberately distinct from connect-timeout: immediate
     *  rejection vs deadline expiry point at different remedies (route/ACL
     *  check vs timeout-budget/upstream-health), keeping the #1263 goal of
     *  distinguishable remedies. */
    | "upstream-unreachable"
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

interface UpstreamFailCtx {
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
        if (code === "UND_ERR_CONNECT_TIMEOUT") return "connect-timeout";
        if (code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "upstream-timeout";
        if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "UND_ERR_SOCKET") return ctx.viaProxy ? "proxy-reset" : "upstream-reset";
        if (code === "ECONNREFUSED") return "connect-refused";
        // #2465: ICMP no-route family — before this it fell through to
        // "unknown", which is neither fail-fast (no replay) nor alertable
        // (no banner), so field EHOSTUNREACH storms died on attempt 1.
        if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EHOSTDOWN") return "upstream-unreachable";
        if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
        // #1987: OpenSSL/undici certificate-TRUST codes (corporate interception /
        // MITM) are TLS failures too — before this they classified as "unknown",
        // losing the CA-remediation hint in logs and status output.
        if (code === "EPROTO" || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.startsWith("CERT_")
            || code.startsWith("DEPTH_ZERO_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") return "tls";
    }
    return "unknown";
}

/** Fail-fast kinds: the attempt died BEFORE any response byte existed, so a
 *  replay cannot double-deliver anything. Per-attempt cost stays bounded —
 *  milliseconds for resets/refusals/DNS/no-route rejections, at most one
 *  connect timeout for connect-timeout — so retrying never stacks the 12-min
 *  idle budget across attempts the way a headers/body timeout would
 *  (#1263, #1453, #2465). */
export function isFailFastUpstreamKind(kind: UpstreamFailureKind): boolean {
    return kind === "proxy-reset" || kind === "upstream-reset" || kind === "connect-refused" || kind === "connect-timeout" || kind === "dns" || kind === "upstream-unreachable";
}

/** One-line remediation hint per kind — used by logs and the docs so the
 *  taxonomy and the checklist never drift apart. */
export const UPSTREAM_FAIL_HINTS: Record<UpstreamFailureKind, string> = {
    "client-abort": "downstream client disconnected — no bili-side action",
    "upstream-timeout": "idle budget expired (headers/body) — check upstream health; not retried by design",
    "connect-timeout": "TCP handshake never completed — upstream/proxy unreachable or blackholed; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "upstream-unreachable": "ICMP no-route rejection (EHOSTUNREACH/ENETUNREACH/EHOSTDOWN) — nothing reached the upstream; check routing/firewall/ACL; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "proxy-reset": "proxy dropped the connection before the response — check proxy idle-recycle/payload limits (BILI_PROXY_KEEPALIVE_MAX_MS can shorten our reuse window); a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "upstream-reset": "upstream/network reset before the response — check upstream and local network; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "connect-refused": "TCP refused (proxy when configured, else upstream) — endpoint down or wrong port",
    dns: "name resolution failed — DNS server or hostname typo; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    tls: "TLS/certificate failure at CONNECT or upstream handshake — CA/proxy MITM config",
    // #2465 P1: state the fact instead of demanding a report — formatUpstreamError
    // already puts the full masked error chain on the same log line.
    unknown: "unclassified transport failure — full masked error chain is on this log line",
};
