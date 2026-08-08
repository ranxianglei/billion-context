import { hashId } from "./util.js";

/**
 * Session identity for the proxy's OWN compression state.
 *
 * A session is uniquely keyed by FOUR dimensions (all AND-ed):
 *   1. protocol  — "anthropic" | "openai" | "responses"  (different wire
 *                  formats must never share compression state)
 *   2. upstream  — the resolved upstream origin, e.g. "https://open.bigmodel.cn"
 *                  (same key hitting two providers must not share state)
 *   3. apiKey    — the account credential from Authorization / x-api-key
 *                  (different accounts must never share state, even if they
 *                  happen to send the same conversation content)
 *   4. conversation — the client's own notion of "which conversation this is",
 *                  taken from a client-provided signal when available, falling
 *                  back to a content fingerprint.
 *
 * The result is a stable, opaque id used ONLY inside the proxy (to key the
 * compression-state store). It is NEVER sent upstream — it embeds the key and
 * upstream origin, which the upstream either already knows or must not see.
 *
 * If a separate per-conversation signal is needed for upstream routing (e.g.
 * to keep a multi-account load-balancer's prefix cache warm), use
 * `affinityToken()` below — it is the conversation dimension alone, formatted
 * to mirror OpenCode's `x-session-affinity` header so upstreams/LBs that
 * understand that convention work without bespoke support.
 */

/** Extract the account credential from common auth headers, normalized. */
function extractKey(headers: Record<string, string | string[] | undefined>): string {
    const auth = headers["authorization"];
    if (typeof auth === "string" && auth.length > 0) return auth.trim().toLowerCase();
    const apiKey = headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.length > 0) return `key:${apiKey.trim().toLowerCase()}`;
    return "(no-key)";
}

/** Pull a client-provided conversation signal from headers, if any. */
function clientConversationHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
    const names = ["x-session-affinity", "x-acp-session", "x-session-id", "x-opencode-session"];
    for (const name of names) {
        const v = headers[name];
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return undefined;
}

/**
 * Derive the proxy-internal session id. `firstUserContent` is a short prefix
 * of the first user message in the request, used as the conversation
 * fingerprint fallback when the client sends no session signal.
 */
export function deriveSessionId(
    headers: Record<string, string | string[] | undefined>,
    protocol: "anthropic" | "openai" | "responses",
    upstream: string,
    firstUserContent: string,
    extra?: { clientConversation?: string; protocolConversation?: string },
): string {
    const key = extractKey(headers);
    const convo =
        extra?.clientConversation ??
        extra?.protocolConversation ??
        hashId(firstUserContent);
    return hashId(`${protocol}|${upstream}|${key}|${convo}`);
}

/**
 * The conversation dimension alone, formatted as OpenCode's
 * `x-session-affinity: ses_<hash>` value. Suitable for forwarding to an
 * upstream that understands that convention (e.g. a multi-account
 * load-balancer doing sticky routing). Contains NO key or upstream, so it is
 * safe to send upstream and stable across account rotations.
 */
export function affinityToken(
    headers: Record<string, string | string[] | undefined>,
    firstUserContent: string,
    protocolConversation?: string,
): string {
    const client = clientConversationHeader(headers);
    if (client) return client;
    const convo = protocolConversation ?? hashId(firstUserContent);
    return `ses_${convo}`;
}

export { clientConversationHeader };
