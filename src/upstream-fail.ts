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
        if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
        // #1987: OpenSSL/undici certificate-TRUST codes (corporate interception /
        // MITM) are TLS failures too — before this they classified as "unknown",
        // losing the CA-remediation hint in logs and status output.
        if (code === "EPROTO" || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.startsWith("CERT_")
            || code.startsWith("DEPTH_ZERO_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") return "tls";
    }
    return "unknown";
}

// #3776: certificate-TRUST codes — the failure means "this CA chain is not
// trusted HERE", i.e. the upstream was re-signed by an intermediate Node.js
// does not know (security-software HTTPS scanning / corporate MITM), NOT "the
// upstream is broken". Single source of truth shared by preflight's summary-
// call note so the two channels never drift apart (preflight previously kept
// its own copy of this set).
export const TLS_TRUST_CODES = new Set([
    "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "DEPTH_ZERO_UNTRUSTED_ROOT",
    "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

export function isTlsTrustCode(code: unknown): boolean {
    return typeof code === "string" && TLS_TRUST_CODES.has(code);
}

/** #3776: the remediation text for a certificate-TRUST failure. Names the common
 *  producer (security-software HTTPS/encrypted-connection scanning, corporate
 *  MITM) and both fixes. Consumed verbatim by the log line, the 502 body, the
 *  circuit/alert banner and the preflight summary note so they stay word-for-
 *  word identical — the generic `UPSTREAM_FAIL_HINTS.tls` one-liner was what left
 *  a Kaspersky-scanned user digging through logs for a day (#3773/#3776). */
export function tlsTrustRemediation(): string {
    return "the presented certificate chain is not trusted by this Node.js process — usually security software doing HTTPS/encrypted-connection scanning (Kaspersky, enterprise DLP) or a corporate MITM proxy re-signing the upstream. Fix: export that scanner/vendor root CA to a PEM file and point NODE_EXTRA_CA_CERTS=/path/to/ca.pem at it (or set bili config \"network.caFile\"), or exclude node.exe from the software's HTTPS inspection";
}

// #3776 sub-defect 3: machine-readable slice of an upstream failure. Attached
// NON-enumerably to the thrown error so the egress 502 body can expose
// kind/code/hint verbatim instead of making the client parse free text — while
// the error still stringifies EXACTLY as before (the existing `detail` field is
// byte-identical; this only ADDS a structured sibling). A Symbol key keeps it
// off any accidental JSON.stringify of the error elsewhere.
export interface UpstreamFailureDetail {
    kind?: UpstreamFailureKind;
    code?: string;
    hint?: string;
    /** #4254: display-form host[:port] of the failing endpoint (loopback-exempt
     *  masked) so the egress can name WHICH endpoint failed in the client-facing
     *  `error` string and the structured diag. */
    host?: string;
    /** #4254: true when this is a round-level circuit-breaker fail-fast (endpoint
     *  proven dead, bili NOT contacting it) — drives 503 + Retry-After at the
     *  egress instead of a generic 502. */
    circuitOpen?: boolean;
    /** #4254: seconds until the next half-open probe (circuitOpen only) — becomes
     *  the Retry-After header so compliant hosts back off instead of resending. */
    retryAfterSeconds?: number;
}

const UPSTREAM_FAILURE = Symbol("upstreamFailure");

export function withUpstreamFailure(err: Error, detail: UpstreamFailureDetail): Error {
    Object.defineProperty(err, UPSTREAM_FAILURE, { value: detail, enumerable: false });
    return err;
}

export function upstreamFailureOf(err: unknown): UpstreamFailureDetail | undefined {
    if (err !== null && typeof err === "object") {
        const value = (err as Record<symbol, unknown>)[UPSTREAM_FAILURE];
        if (value !== null && typeof value === "object") return value as UpstreamFailureDetail;
    }
    return undefined;
}

// #4254: marks an error as a DELIBERATE circuit-breaker fail-fast so the egress catch
// can skip its per-request [error]+stack — the throttled [warn] at the throw site is
// the canonical record. Stops the log amplification where every blocked request used
// to re-log the full errno/url/hint.
const EXPECTED_FAIL_FAST = Symbol("expectedFailFast");

export function markExpectedFailFast(err: Error): Error {
    Object.defineProperty(err, EXPECTED_FAIL_FAST, { value: true, enumerable: false });
    return err;
}

export function isExpectedFailFast(err: unknown): boolean {
    return err !== null && typeof err === "object" && (err as Record<symbol, unknown>)[EXPECTED_FAIL_FAST] === true;
}

/** #4254: build the client-facing proxy-failure response (status + headers + JSON
 *  body) from a thrown error, shared by EVERY egress site (startServer dispatch
 *  catch + the inline engine) so they render identically. Three deliberate changes
 *  vs the old inline code:
 *   - `error` is no longer a constant: when the failure carries a structured slice
 *     it reads "acp-proxy failure: <kind> [<code>] [host[:port]]" plus a
 *     "(circuit open, next probe +Ns)" suffix for fail-fast — the prefix is kept
 *     verbatim so clients matching the old constant still match, and the shape stays
 *     a STRING (never the OpenAI {error:{message}} object form, which would break
 *     hosts that render error.text).
 *   - a round-level circuit-breaker fail-fast answers 503 + Retry-After (next-probe
 *     interval) instead of a generic 502, so compliant hosts back off rather than
 *     resending full context (#2847 precedent: the status carries retry semantics).
 *   - the structured diag gains host/circuitOpen/retryAfterSeconds alongside the
 *     existing kind/code/hint (purely additive; byte-identical when none present). */
export function buildProxyFailureResponse(msg: string, err: unknown): { status: number; headers: Record<string, string>; body: string } {
    const uf = upstreamFailureOf(err);
    let cause = "";
    if (uf && uf.kind !== undefined) {
        const bits: string[] = [uf.kind];
        if (uf.code !== undefined) bits.push(uf.code);
        if (uf.host !== undefined) bits.push(uf.host);
        cause = bits.join(" ");
        if (uf.circuitOpen === true) {
            cause += typeof uf.retryAfterSeconds === "number" ? ` (circuit open, next probe +${Math.max(1, Math.ceil(uf.retryAfterSeconds))}s)` : " (circuit open)";
        }
    }
    const errorField = cause !== "" ? `acp-proxy failure: ${cause}` : "acp-proxy failure";
    let status: number;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (msg.includes("exceeds")) {
        status = 413; // context-overflow doom (#2490/#2847) — unchanged
    } else if (uf && uf.circuitOpen === true) {
        status = 503;
        if (typeof uf.retryAfterSeconds === "number") headers["retry-after"] = String(Math.max(1, Math.ceil(uf.retryAfterSeconds)));
    } else {
        status = 502;
    }
    const diag: Record<string, unknown> = {};
    if (uf && uf.kind !== undefined) diag.kind = uf.kind;
    if (uf && uf.code !== undefined) diag.code = uf.code;
    if (uf && uf.hint !== undefined) diag.hint = uf.hint;
    if (uf && uf.host !== undefined) diag.host = uf.host;
    if (uf && uf.circuitOpen === true) diag.circuitOpen = true;
    if (uf && typeof uf.retryAfterSeconds === "number") diag.retryAfterSeconds = uf.retryAfterSeconds;
    const body = JSON.stringify({ error: errorField, detail: msg, ...(Object.keys(diag).length > 0 ? { upstreamFailure: diag } : {}) });
    return { status, headers, body };
}

/** Fail-fast kinds: the attempt died BEFORE any response byte existed, so a
 *  replay cannot double-deliver anything. Per-attempt cost stays bounded —
 *  milliseconds for resets/refusals/DNS, at most one connect timeout for
 *  connect-timeout — so retrying never stacks the 12-min idle budget across
 *  attempts the way a headers/body timeout would (#1263, #1453). */
export function isFailFastUpstreamKind(kind: UpstreamFailureKind): boolean {
    return kind === "proxy-reset" || kind === "upstream-reset" || kind === "connect-refused" || kind === "connect-timeout" || kind === "dns";
}

/** One-line remediation hint per kind — used by logs and the docs so the
 *  taxonomy and the checklist never drift apart. */
export const UPSTREAM_FAIL_HINTS: Record<UpstreamFailureKind, string> = {
    "client-abort": "downstream client disconnected — no bili-side action",
    "upstream-timeout": "idle budget expired (headers/body) — check upstream health; not retried by design",
    "connect-timeout": "TCP handshake never completed — upstream/proxy unreachable or blackholed; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "proxy-reset": "proxy dropped the connection before the response — check proxy idle-recycle/payload limits (BILI_PROXY_KEEPALIVE_MAX_MS can shorten our reuse window); a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "upstream-reset": "upstream/network reset before the response — check upstream and local network; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "connect-refused": "TCP refused (proxy when configured, else upstream) — endpoint down or wrong port",
    dns: "name resolution failed — DNS server or hostname typo; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    tls: "TLS/certificate failure at CONNECT or upstream handshake — CA/proxy MITM config",
    unknown: "unclassified transport failure — report with full error chain",
};

/** Mask proxy credentials for display surfaces (log lines, 502 detail, the
 *  #2809 skipped-proxy note, alert payloads). Lives HERE instead of
 *  upstream-proxy so every renderer below that layer can share one
 *  implementation without a new import edge. */
export function redactProxyUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        if (url.username || url.password) {
            url.username = "***";
            url.password = "***";
        }
        return url.href;
    } catch {
        return "(invalid proxy URL)";
    }
}

/** #2809: an AVAILABLE proxy that default-direct mode skipped for this host —
 *  the value the auto-detect chain would have resolved. Raw on purpose: each
 *  display channel redacts per its own needs (see redactedSkippedProxy). */
export type SkippedProxyInfo = {
    proxy: string;
    /** Tier that offered it: an env var name ("HTTPS_PROXY") or "windows-system". */
    source: string;
};

/** Display form of a skipped proxy: credentials masked, the normalization
 *  trailing slash stripped so the note reads like a human wrote it. */
export function redactedSkippedProxy(skipped: SkippedProxyInfo): string {
    return (redactProxyUrl(skipped.proxy) ?? "").replace(/\/$/, "");
}

/** #2809 dead-end: a fail-fast failure under UNSET proxy mode reads
 *  "unreachable/blackholed" while the machine's own env/system proxy could
 *  reach the host fine — and no channel ever named that proxy. This appends
 *  the conditional suffix naming it plus the opt-in paths. Only fail-fast
 *  kinds qualify: a post-connect failure may have run on a working path,
 *  where "skipped proxy" would mislead. Diagnostic text only — egress
 *  decisions never read it. */
export function hintWithSkippedProxy(kind: UpstreamFailureKind, skipped: SkippedProxyInfo | undefined): string {
    const base = UPSTREAM_FAIL_HINTS[kind];
    if (!skipped || !isFailFastUpstreamKind(kind)) return base;
    return `${base}; available proxy ${redactedSkippedProxy(skipped)} (${skipped.source}) was skipped because upstreamProxyMode is unset (direct is the default by design, #346/#357) — follow it with "upstreamProxyMode": "auto" or BILI_UPSTREAM_PROXY_MODE=auto, or give this provider a "proxy" lane`;
}
