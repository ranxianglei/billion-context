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

const CREDENTIAL_HEADER_RE = /key|auth|token|cookie/i;

export function isPublicApiHost(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    return PUBLIC_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

export function maskHostForLog(host: string): string {
    return isPublicApiHost(host) ? host : PRIVATE_HOST;
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
    const host = isPublicApiHost(u.hostname) ? u.host : `${PRIVATE_HOST}${u.port ? `:${u.port}` : ""}`;
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
