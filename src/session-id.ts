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
export function clientConversationHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
    const names = ["x-session-affinity", "x-acp-session", "x-session-id", "x-opencode-session"];
    for (const name of names) {
        const v = headers[name];
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return undefined;
}

/**
 * Derive the proxy-internal session id. The conversation dimension MUST be
 * supplied by the caller via `extra.conversation` (typically the output of
 * the per-protocol conversationSignal* helper, which already falls back to a
 * hash of the first user message). There is intentionally NO content-
 * fingerprint fallback inside this function — a silent "" default would
 * collapse every anonymous session onto one id. If `conversation` is missing
 * the caller has a bug and we throw rather than silently mis-isolating.
 */
export function deriveSessionId(
    headers: Record<string, string | string[] | undefined>,
    protocol: "anthropic" | "openai" | "responses",
    upstream: string,
    conversation: string,
): string {
    if (!conversation) throw new Error("deriveSessionId: conversation dimension is required (pass the conversationSignal* output)");
    const key = extractKey(headers);
    return hashId(`${protocol}|${upstream}|${key}|${conversation}`);
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
    conversation: string,
): string {
    const client = clientConversationHeader(headers);
    if (client) return client;
    return `ses_${conversation}`;
}
