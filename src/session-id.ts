import { hashId } from "./util.js";

export type ConversationIdentity = {
    value: string;
    source: "header" | "body-session" | "metadata-session" | "previous-response" | "prompt-cache-key" | "content-fingerprint" | "generated";
    clientProvided: boolean;
};

/**
 * Session identity for the proxy's OWN compression state.
 *
 * A session is keyed by protocol + conversation, where the conversation
 * dimension is the client's own notion of "which conversation this is" —
 * taken from a client-provided signal when available, falling back to a
 * content fingerprint.
 *
 * When the conversation is a CLIENT-PROVIDED native session id (session
 * header, body session_id, prompt_cache_key), the final id is
 * hash(protocol | conversation) only (issue #286): the session id is the
 * only invariant tied to a conversation, and the account credential
 * (rotating OAuth bearer) or the upstream (relay switch) changing must not
 * orphan the conversation's compression state.
 *
 * When the conversation is a CONTENT FINGERPRINT (no client signal), the id
 * keeps FOUR dimensions (all AND-ed):
 *   1. protocol  — "anthropic" | "openai" | "responses"  (different wire
 *                  formats must never share compression state)
 *   2. upstream  — the resolved upstream origin, e.g. "https://open.bigmodel.cn"
 *                  (same key hitting two providers must not share state)
 *   3. apiKey    — the account credential from Authorization / x-api-key
 *                  (different accounts must never share state, even if they
 *                  happen to send the same conversation content)
 *   4. conversation — the content fingerprint (a content hash with a real
 *                  collision surface, hence the isolation dimensions).
 *
 * The result is a stable, opaque id used ONLY inside the proxy (to key the
 * compression-state store). It is NEVER sent upstream — it embeds the key and
 * upstream origin, which the upstream either already knows or must not see.
 *
 * If a client-provided per-conversation signal is needed for upstream routing,
 * use `affinityToken()` below. Generated proxy identities are never forwarded.
 */

/** Extract the account credential from common auth headers, verbatim.
 *  The value is fed into a hash — it is NEVER stored, logged, or compared.
 *  Normalization is intentionally minimal: trim whitespace only. We do NOT
 *  lowercase: while that reduces hash collisions in theory (two keys that
 *  differ only in case would hash the same), in practice API keys are
 *  case-sensitive and a lowercase normalization would collapse two distinct
 *  valid keys into one hash bucket — a silent isolation violation. Keep the
 *  raw value so each distinct key hashes distinctly. */
function extractKey(headers: Record<string, string | string[] | undefined>): string {
    const auth = headers["authorization"];
    if (typeof auth === "string" && auth.length > 0) return auth.trim();
    const apiKey = headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.length > 0) return `key:${apiKey.trim()}`;
    return "(no-key)";
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
 * supplied by the caller (typically the output of the per-protocol
 * conversationSignal* helper, which already falls back to a content hash).
 * There is intentionally NO content-fingerprint fallback inside this
 * function — a silent "" default would collapse every anonymous session onto
 * one id. If `conversation` is missing the caller has a bug and we throw
 * rather than silently mis-isolating.
 *
 * Identity strength (issue #286): when the caller passes a
 * client-provided identity (native session header, body session_id,
 * prompt_cache_key — `identity.clientProvided`), the id is
 * `hash(protocol | conversation)` ONLY. The native session id is the only
 * invariant tied to a conversation: the account credential rotates (OAuth
 * bearer) and the upstream can change (relay) without the conversation
 * changing, so neither may break continuity. The 4-way hash
 * (protocol|upstream|credential|conversation) is kept for the
 * content-fingerprint fallback, where the "conversation" is a content hash
 * with a real collision surface and needs the account and upstream
 * dimensions to stay isolated.
 */
export function deriveSessionId(
    headers: Record<string, string | string[] | undefined>,
    protocol: "anthropic" | "openai" | "responses",
    upstream: string,
    conversation: string,
    identity?: ConversationIdentity,
): string {
    if (!conversation) throw new Error("deriveSessionId: conversation dimension is required (pass the conversationSignal* output)");
    if (identity?.clientProvided) return hashId(`${protocol}|${conversation}`);
    const key = extractKey(headers);
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
