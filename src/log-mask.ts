/**
 * Log-safety helpers (#255): keep credentials and non-public API endpoints
 * out of bili.log / launcher logs.
 *
 * Rule: well-known PUBLIC LLM API hosts (openai, anthropic, ...) may appear
 * in logs verbatim; anything else is a non-public endpoint (private relay,
 * self-hosted, internal domain) and its host is replaced with a placeholder.
 * Credential header values (authorization, x-api-key, cookie, ...) are
 * replaced by a length hint.
 */

export const PRIVATE_HOST = "<private-host>";

/** Well-known public LLM API host suffixes safe to log verbatim. Suffix
 *  matching covers subdomains (api.openai.com,
 *  generativelanguage.googleapis.com, ...). Unknown hosts are masked — the
 *  safe default. */
const PUBLIC_HOST_SUFFIXES = [
    "openai.com",
    "chatgpt.com",
    "anthropic.com",
    "deepseek.com",
    "googleapis.com",
    "azure.com",
    "amazonaws.com",
    "mistral.ai",
    "groq.com",
    "cohere.com",
    "together.ai",
    "fireworks.ai",
    "x.ai",
    "openrouter.ai",
    "huggingface.co",
    "moonshot.ai",
    "zhipuai.com",
    "volcengine.com",
    "aliyuncs.com",
    "baidu.com",
    "baidubce.com",
    "minimax.io",
];

export const CREDENTIAL_HEADER_RE = /key|auth|token|cookie/i;

// #897: host masking is ON by default (#255 — logs get pasted into public
// issues). Operators who want the real target hosts in their local log can
// opt out (env BILI_LOG_MASK_HOSTS=0 / config maskHosts:false); real hosts
// stay visible on the loopback-only /__bili/stats endpoint regardless.
// Credential masking is independent and always on.
let maskHostsEnabled = true;

export function setMaskHostsEnabled(enabled: boolean): void {
    maskHostsEnabled = enabled;
}

export function isMaskHostsEnabled(): boolean {
    return maskHostsEnabled;
}

export function isPublicApiHost(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    return PUBLIC_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

function hostMaskedOff(host: string): boolean {
    return !maskHostsEnabled || isPublicApiHost(host);
}

export function maskHostForLog(host: string): string {
    return hostMaskedOff(host) ? host : PRIVATE_HOST;
}

/** Mask a URL for logging: non-public host → placeholder; userinfo, query and
 *  hash are always dropped (query strings are a classic key-leak vector);
 *  the path is kept (debug signal, not sensitive). */
export function maskUrlForLog(url: string): string {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return "<unparseable-url>";
    }
    const host = hostMaskedOff(u.hostname) ? u.host : `${PRIVATE_HOST}${u.port ? `:${u.port}` : ""}`;
    return `${u.protocol}//${host}${u.pathname}`;
}

/** Mask every http(s) URL embedded anywhere in an arbitrary string (request
 *  paths like /bili/http://relay.internal/v1/..., error text). */
export function maskUrlsInText(text: string): string {
    return text.replace(/https?:\/\/[^\s"'<>]+/gi, (m) => maskUrlForLog(m));
}

/** Mask the host of a `host:port` target (e.g. an HTTP CONNECT request
 *  line) for logging. */
export function maskHostPortForLog(target: string): string {
    const i = target.lastIndexOf(":");
    if (i <= 0) return maskHostForLog(target);
    return `${maskHostForLog(target.slice(0, i))}${target.slice(i)}`;
}

/** Mask a single header value for logging. Credential headers become a
 *  length hint; the `host` header (host:port) follows the same
 *  public/private rule as URLs; anything else passes through. */
export function maskHeaderForLog(name: string, value: string): string {
    if (name.toLowerCase() === "host") return maskHostPortForLog(value);
    if (CREDENTIAL_HEADER_RE.test(name)) return `<masked ${value.length} chars>`;
    return value;
}

export function maskHeadersForLog(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) out[k] = maskHeaderForLog(k, v);
    return out;
}

/** Scrub a specific host (the tunnel/forward target) from arbitrary error
 *  text. OS/undici error messages embed the endpoint ("connect ECONNREFUSED
 *  10.0.0.5:8443", "getaddrinfo ENOTFOUND relay.internal"), so a log line
 *  that masks the host in its template still leaks it via `err.message`.
 *  Only the given host is replaced — other addresses in the text (e.g. the
 *  proxy's) are left as-is, matching the `proxy=` design decision. Handles
 *  both the bracketed ([::1]) and bare (::1) IPv6 forms. */
export function maskHostInText(text: string, host: string): string {
    if (!host || hostMaskedOff(host)) return text;
    const bare = host.replace(/^\[|\]$/g, "");
    const forms = new Set<string>([host, bare]);
    if (bare.includes(":")) forms.add(`[${bare}]`);
    for (const form of forms) {
        if (form.length > 0) text = text.split(form).join(PRIVATE_HOST);
    }
    return text;
}

// Canonical compressed/full IPv6 grammar — used to VALIDATE colon-run
// candidates so clocks ("12:34:56"), MACs ("aa:bb:cc:dd:ee:ff") and version
// strings never match.
const STRICT_IPV6_RE = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$|^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$|^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$|^:(?::[0-9a-fA-F]{1,4}){1,7}$|^::$/;

function isIpv4Literal(s: string): boolean {
    const parts = s.split(".");
    return parts.length === 4 && parts.every((p) => p.length >= 1 && p.length <= 3 && /^\d+$/.test(p) && Number(p) <= 255 && !(p.length > 1 && p[0] === "0"));
}

function isLoopbackIp(ip: string): boolean {
    return ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip === "0.0.0.0" || ip.startsWith("127.");
}

/**
 * Sink-level safety net (#1718): scrub non-loopback IP literals out of
 * arbitrary log text. undici/OS error messages embed the dialed endpoint
 * verbatim ("connect ETIMEDOUT 203.0.113.5:8443"), and per-site masking only
 * swaps the TARGET hostname's forms — a resolved IP or an IP-literal endpoint
 * still leaks through the generic catch-all. Applied at the logger choke point
 * alongside redactSecretsInText(). Gated by the same maskHostsEnabled switch
 * as host masking (IPs are host identity, not credentials): operators who set
 * BILI_LOG_MASK_HOSTS=0 to see real endpoints keep seeing real IPs. Ports are
 * preserved (matches maskHostPortForLog). Loopback (127.*, ::1, 0.0.0.0) is
 * exempt — it identifies bili's own local proxy, not an external party.
 */
export function maskIpsInText(text: string): string {
    if (!text || !maskHostsEnabled) return text;
    // Bracketed IPv6 (URL/socket form): [2001:db8::1]:8443 -> [<private-host>]:8443
    text = text.replace(/\[((?:[0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}|::+)\]/g, (m, inner: string) =>
        isLoopbackIp(inner.replace(/^:+|:+$/g, "") === "" ? "::" : inner) ? m : `[${PRIVATE_HOST}]`);
    // Bare IPv6: extract hex+colon runs, validate against the strict grammar.
    text = text.replace(/(?<![0-9a-zA-Z])([0-9a-fA-F:]{2,45})(?![0-9a-fA-F])/g, (m, run: string) => {
        if (!run.includes(":") || !STRICT_IPV6_RE.test(run)) return m;
        return isLoopbackIp(run) ? m : PRIVATE_HOST;
    });
    // Bare IPv4: validate octets (rejects "10.0.19045.3209"-style version strings).
    text = text.replace(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g, (m, ip: string) =>
        isIpv4Literal(ip) && !isLoopbackIp(ip) ? PRIVATE_HOST : m);
    return text;
}

/**
 * Sink-level safety net (#1718): scrub credential-shaped tokens out of
 * arbitrary log text. Per-call-site structural masking (maskHeaderForLog,
 * maskUrlForLog) covers known shapes, but free-form text — upstream/gateway
 * error bodies that echo the rejected API key, exception messages — can carry
 * secrets in any shape. Applied once at the logger choke point so every
 * current and future call site is covered. Patterns are deliberately
 * conservative: high-signal credential shapes only, no hits on prose or
 * usage-count labels ("prompt_tokens=", plural "tokens:" never match).
 */
export function redactSecretsInText(text: string): string {
    if (!text) return text;
    return text
        .replace(/\b(bearer|basic)\s+([A-Za-z0-9._~+\/=-]{8,})/gi, (_m, scheme: string, tok: string) => `${scheme} <masked ${tok.length} chars>`)
        .replace(/(?<![A-Za-z0-9])(?:sk|xai)-[A-Za-z0-9_-]{8,}/g, "<masked key>")
        .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "<masked jwt>")
        .replace(/(\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|secret|passwd|password|token)\b\s*[:=]\s*)(["']?)([A-Za-z0-9._~+\/=-]{8,})\2/gi, (_m, pre: string, q: string, val: string) => `${pre}${q}<masked ${val.length} chars>${q}`);
}
