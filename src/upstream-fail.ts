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

// #4403: a certificate-TRUST failure has TWO live producers that need OPPOSITE
// remedies: security software / a corporate MITM re-signing traffic (fix = trust
// the vendor root) versus DNS hijacking / link injection presenting a forged or
// foreign cert (fix = do NOT trust it; verify resolution first). #3776 shipped
// one text assuming only the former — under active hijacking it told the user to
// install the ATTACKER's CA. The branches below split on what the error code and
// the probe-captured certificate actually show; the unqualified call keeps the
// verify-first default so no channel ever leads with "install this CA" without
// evidence.
interface TlsTrustRemediationCtx {
    /** The trust code that fired — picks the branch (alt-name mismatch vs
     *  self-signed family vs expired). */
    code?: string;
    /** Target hostname — SAN cross-check and readable text. */
    hostname?: string;
    /** Enterprise-interception signal available in-process: a local/private
     *  proxy in the path, or extra CA material already configured (#4403). */
    enterpriseSignal?: boolean;
    /** Probe-captured certificate facts (upstream-cert-probe); absent on the
     *  first event while the async probe is still in flight. */
    cert?: { san?: string[] };
}

/** #3776/#4403: the remediation text for a certificate-TRUST failure. Consumed
 *  verbatim by the log line, the 502 body, the circuit/alert banner and the
 *  preflight summary note so they stay word-for-word identical. Branches:
 *  expired → upstream misconfiguration; alt-name-invalid → strong MITM signal
 *  (a trusted CA signed it but for another name); self-signed family whose SAN
 *  provably lacks the target host → mitm-suspect; enterprise signal present →
 *  the original scanner/vendor-CA advice; otherwise verify-DNS-first. */
// RFC 6125: a wildcard matches exactly ONE leftmost label ("*.example.com"
// covers "a.example.com", never "example.com" nor "a.b.example.com"). Enterprise
// scanners commonly re-sign whole internal domains with a single wildcard cert —
// treating such a SAN as "lacks the host" would mislabel legitimate inspection
// as hijacking.
function sanCoversHost(san: string[], hostname: string): boolean {
    const host = hostname.toLowerCase();
    for (const entry of san) {
        const e = entry.toLowerCase();
        if (e === host) return true;
        if (e.startsWith("*.")) {
            const suffix = e.slice(1);
            if (host.endsWith(suffix)) {
                const label = host.slice(0, host.length - suffix.length);
                if (label.length > 0 && !label.includes(".")) return true;
            }
        }
    }
    return false;
}

export function tlsTrustRemediation(ctx: TlsTrustRemediationCtx = {}): string {
    const host = ctx.hostname ?? "the target host";
    const verifyDns = `verify what ${host} resolves to (compare your resolver against public DoH such as 1.1.1.1 / 8.8.8.8 / 223.5.5.5)`;
    if (ctx.code === "CERT_HAS_EXPIRED") {
        return `the presented certificate has EXPIRED — typically an upstream-side lapse (or a skewed local clock), not interception; there is nothing to install locally`;
    }
    if (ctx.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        return `the certificate IS signed by a CA this process trusts, but its names do not include ${host} — a classic sign of DNS hijacking / link injection presenting a valid-looking certificate for another domain (or a broken inspection policy). Do NOT install any new CA for this; ${verifyDns} and confirm the address you reach is the real endpoint`;
    }
    const san = ctx.cert?.san;
    if (san !== undefined && san.length > 0 && ctx.hostname !== undefined && !sanCoversHost(san, ctx.hostname)) {
        return `the presented certificate is self-signed/untrusted AND its subject alt names (${san.join(", ")}) do not include ${host} — pattern consistent with DNS hijacking / link injection. Do NOT install this CA; ${verifyDns}`;
    }
    if (ctx.enterpriseSignal === true) {
        return "the presented certificate chain is not trusted by this Node.js process — usually security software doing HTTPS/encrypted-connection scanning (Kaspersky, enterprise DLP) or a corporate MITM proxy re-signing the upstream. Fix: export that scanner/vendor root CA to a PEM file and point NODE_EXTRA_CA_CERTS=/path/to/ca.pem at it (or set bili config \"network.caFile\"), or exclude node.exe from the software's HTTPS inspection";
    }
    return `the presented certificate chain is not trusted by this Node.js process. This is EITHER security software doing HTTPS/encrypted-connection scanning (Kaspersky, enterprise DLP) or a corporate MITM re-signing traffic — OR a hijacked DNS answer presenting a forged cert. Before installing ANY CA: ${verifyDns}, confirm HTTPS-inspection software on this machine actually owns the presented chain, and only then export its vendor root CA to a PEM file and point NODE_EXTRA_CA_CERTS=/path/to/ca.pem at it (or set bili config \"network.caFile\")`;
}

/** #4403: should a FINAL failure trigger the forensic cert probe — trust-code
 *  TLS deaths on DIRECT connections only. Through a proxy the presented chain
 *  is the tunnel's doing and a direct probe bypasses it, so probing would
 *  capture the wrong endpoint's certificate. */
export function wantsCertProbe(error: unknown, viaProxy: boolean): boolean {
    if (viaProxy) return false;
    let cur: unknown = error;
    for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
        const code = (cur as unknown as Record<string, unknown>).code;
        if (typeof code === "string" && isTlsTrustCode(code)) return true;
        cur = (cur as Error & { cause?: unknown }).cause;
    }
    return false;
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
    /** #4403 P0-2: probe-captured forensics of the certificate the endpoint
     *  presented (upstream-cert-probe). Absent unless a trust-code TLS failure
     *  ran on a direct connection AND the async probe already landed. */
    remoteAddress?: string;
    certSubject?: string;
    certIssuer?: string;
    certSan?: string[];
    certFingerprint256?: string;
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

/** Transparently replayable kinds: the attempt died BEFORE any response byte
 *  existed, so a replay cannot double-deliver anything. Per-attempt cost stays
 *  bounded — milliseconds for resets/refusals/DNS, at most one connect timeout
 *  for connect-timeout — so retrying never stacks the 12-min idle budget across
 *  attempts the way a headers/body timeout would (#1263, #1453). Renamed from
 *  isFailFastUpstreamKind (#4403 P2-2): every kind in this set IS fail-fast, but
 *  "fail-fast" said nothing about WHY they may be retried — transparency does. */
export function isTransparentReplayableKind(kind: UpstreamFailureKind): boolean {
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
    if (!skipped || !isTransparentReplayableKind(kind)) return base;
    return `${base}; available proxy ${redactedSkippedProxy(skipped)} (${skipped.source}) was skipped because upstreamProxyMode is unset (direct is the default by design, #346/#357) — follow it with "upstreamProxyMode": "auto" or BILI_UPSTREAM_PROXY_MODE=auto, or give this provider a "proxy" lane`;
}
