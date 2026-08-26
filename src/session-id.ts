import { hashId } from "./util.js";

export type ConversationIdentity = {
    value: string;
    source: "header" | "body-session" | "metadata-session" | "previous-response" | "prompt-cache-key" | "content-fingerprint" | "generated";
    clientProvided: boolean;
};

/**
 * Session identity for the proxy's OWN compression state.
 *
 * A session is uniquely keyed by FOUR dimensions (all AND-ed):
 *   1. protocol  — "anthropic" | "openai" | "responses"  (different wire
 *                  formats must never share compression state)
 *   2. upstream  — the resolved upstream origin, e.g. "https://open.bigmodel.cn"
 *                  (same key hitting two providers must not share state)
 *   3. account   — a stable account id when the upstream provides one, else
 *                  the credential from Authorization / x-api-key
 *   4. conversation — the client's own notion of "which conversation this is",
 *                  taken from a client-provided signal when available, falling
 *                  back to a content fingerprint.
 *
 * The result is a stable, opaque id used ONLY inside the proxy (to key the
 * compression-state store). It is NEVER sent upstream — it embeds the key and
 * upstream origin, which the upstream either already knows or must not see.
 *
 * If a client-provided per-conversation signal is needed for upstream routing,
 * use `affinityToken()` below. Generated proxy identities are never forwarded.
 */

/** Resolve the account scope used only inside the proxy's session hash.
 *  ChatGPT's account id is stable across OAuth bearer rotation; other
 *  upstreams retain credential-based isolation. No raw value is stored or
 *  logged, and case-sensitive credentials are never normalized. */
function extractKey(headers: Record<string, string | string[] | undefined>, upstream: string): string {
    let hostname = "";
    try {
        hostname = new URL(upstream).hostname.toLowerCase();
    } catch {
    }
    if (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com")) {
        const accountId = headers["chatgpt-account-id"];
        if (typeof accountId === "string" && accountId.trim().length > 0) return `account:${accountId.trim()}`;
    }
    const auth = headers["authorization"];
    if (typeof auth === "string" && auth.length > 0) return auth.trim();
    const apiKey = headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.length > 0) return `key:${apiKey.trim()}`;
    return "(no-key)";
}

/**
 * Return Codex's per-agent thread identity when the explicit header agrees
 * with the structured turn metadata. A spawned Codex agent keeps the root
 * `session-id`, but receives its own `thread-id`; compression state must follow
 * the latter or a short subagent turn can overwrite the root agent's usage and
 * folding state.
 *
 * Requiring both Codex-specific metadata and a matching `thread-id` avoids
 * changing the meaning of a generic `thread-id` header for other clients.
 */
export function codexThreadHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
    const metadata = headers["x-codex-turn-metadata"];
    const threadHeader = headers["thread-id"];
    if (typeof metadata !== "string" || typeof threadHeader !== "string") return undefined;
    const threadId = threadHeader.trim();
    if (!threadId) return undefined;
    try {
        const parsed = JSON.parse(metadata) as { thread_id?: unknown };
        return typeof parsed.thread_id === "string" && parsed.thread_id.trim() === threadId ? threadId : undefined;
    } catch {
        return undefined;
    }
}

/** Pull a client-provided conversation signal from headers, if any. */
export function clientConversationHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
    // x-bili-plugin-conversation first: a cooperative plugin's explicit
    // statement of which conversation it is driving (see src/plugin.ts).
    // It outranks every other signal — the plugin owns the session identity
    // in plugin mode (this is what fixes pi's content-fingerprint collision
    // risk for plugin-equipped agents). Honored ONLY when the plugin marker
    // header x-bili-plugin is present: the protocol always sends both
    // together, and trusting a plugin-protocol header from any client would
    // let an unauthenticated LAN client steer the proxy's session identity.
    // x-claude-code-session-id next: the CLI's true per-session UUID — the
    // strongest legacy signal. The name is client-specific, so no other agent
    // (opencode/codex/zcode/curl) ever hits it; their own headers are
    // unchanged below.
    const pluginMarker = typeof headers["x-bili-plugin"] === "string";
    const names = ["x-bili-plugin-conversation", "x-claude-code-session-id", "x-session-affinity", "x-acp-session", "x-session-id", "x-opencode-session", "session-id", "session_id"];
    for (const name of names) {
        if (name === "x-bili-plugin-conversation" && !pluginMarker) continue;
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
    const key = extractKey(headers, upstream);
    return hashId(`${protocol}|${upstream}|${key}|${conversation}`);
}

/**
 * Return only an identity the client already supplied. Generated identities
 * remain proxy-internal so billion-context does not invent upstream headers.
 */
export function affinityToken(identity: ConversationIdentity): string | undefined {
    return identity.clientProvided ? identity.value : undefined;
}

/**
 * Promote a Responses body's `prompt_cache_key` over a content-fingerprint
 * identity. Clients that replay full history statelessly (omp, some codex
 * builds) send NO conversation headers and NO previous_response_id, so the
 * kernel's identity chain falls to a hash of the ENTIRE input array — which
 * changes every turn as the conversation grows, minting a brand-new session
 * per request. Consequences: compression state never accumulates (the nudge
 * sees tokenCount=0 at evaluation time, so a 90%-full context is never
 * compressed) and the upstream affinity token churns every turn.
 *
 * `prompt_cache_key` is exactly the missing signal: it is the client's own
 * stable per-conversation id (the OpenAI Responses cache-routing field).
 * It only replaces the fingerprint — real conversation headers, body
 * session_ids, and previous_response_id all stay stronger, so this can never
 * override an identity the client stated more explicitly.
 */
export function preferPromptCacheKeyIdentity<T extends ConversationIdentity>(
    identity: T | undefined,
    body: { prompt_cache_key?: unknown },
): T | undefined {
    if (!identity || identity.source !== "content-fingerprint") return identity;
    const pck = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key.trim() : "";
    if (pck.length === 0) return identity;
    return { ...identity, value: pck, source: "prompt-cache-key", clientProvided: true };
}
