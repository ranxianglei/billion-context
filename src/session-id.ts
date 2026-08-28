export type ConversationIdentity = {
    value: string;
    source: "header" | "body-session" | "metadata-session" | "previous-response" | "prompt-cache-key" | "content-fingerprint" | "generated";
    clientProvided: boolean;
};

/**
 * Session identity for the proxy's OWN compression state.
 *
 * The session ID is the client-provided conversation value VERBATIM — no hash,
 * no other dimensions. The client explicitly states which conversation this
 * is (codex `session-id`/`thread-id`, claude `x-claude-code-session-id`,
 * opencode `x-opencode-session`, Responses body `session_id` /
 * `metadata.session_id`, `prompt_cache_key`, ...), and that value is the only
 * invariant that actually binds to the conversation. Everything else is
 * mutable mid-conversation and must not break session continuity (#280, #286):
 * credentials rotate (ChatGPT OAuth bearers), users switch relays/upstreams,
 * and the wire protocol itself can change (relay translation, cross-protocol
 * model switches).
 *
 * A protocol switch is safe under one id because session state is
 * protocol-neutral (kernel-normalized CompressionState, text block contents,
 * CoreMessage snapshots) and the client re-sends the full history every turn,
 * where the current protocol's adapter re-normalizes it.
 *
 * Requests WITHOUT a client-provided identity are rejected with 400 by the
 * server: the content-fingerprint fallback has a real collision surface and
 * would silently orphan state, so anonymous requests fail explicitly instead.
 *
 * The id is used ONLY inside the proxy (compression-state store, persistence,
 * UI label). It is NEVER sent upstream — if a per-conversation signal is
 * needed for upstream routing, use `affinityToken()` below.
 */

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

/**
 * Codex turn-metadata partitioning (#316 / PR-A).
 *
 * Codex (>=0.147) sends `x-codex-turn-metadata` (JSON) on every Responses
 * request carrying `thread_source` ("user" for the root thread, "subagent"
 * for spawned agent threads) and `thread_id`. Subagent threads REUSE the
 * root's `session-id` header, so the legacy identity chain maps every thread
 * of one task onto a single session — subagents inherit the root's
 * compression state, which breaks #150's isolation (a guardian subagent must
 * read the user's original authorization verbatim, never a compressed
 * summary).
 *
 * When the metadata is present AND cross-checked (metadata.thread_id ===
 * `thread-id` header), partition by thread_source:
 *   - "user"     → the `session-id` header (current root semantics, stable
 *                  across turns)
 *   - anything else → the `thread-id` header (fresh independent state per
 *                  thread; self-contained replay is lossless). codex's
 *                  ThreadSource serializes more than user/subagent —
 *                  "guardian_review" (review sessions), "memory_consolidation",
 *                  and arbitrary Feature strings such as "guardian_classifier"
 *                  (guardian-v2 async scorer) — all of which are internal
 *                  threads that need #150 isolation just as much, so the
 *                  discrimination is inverted: only "user" joins the root
 *                  session, every other source gets its own thread state.
 * A non-string/empty thread_source, unparseable JSON, missing/mismatched
 * thread_id, or a missing `session-id` header on a "user" turn → undefined:
 * the caller falls through to the legacy chain unchanged.
 */
export type CodexTurnIdentity = {
    value: string;
    threadSource: string;
};

export function codexTurnIdentity(headers: Record<string, string | string[] | undefined>): CodexTurnIdentity | undefined {
    const raw = headers["x-codex-turn-metadata"];
    if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const threadSource = record["thread_source"];
    if (typeof threadSource !== "string" || threadSource.trim().length === 0) return undefined;
    const metaThreadId = record["thread_id"];
    if (typeof metaThreadId !== "string" || metaThreadId.trim().length === 0) return undefined;
    const threadHeader = headers["thread-id"];
    if (typeof threadHeader !== "string" || threadHeader.trim() !== metaThreadId.trim()) return undefined;
    if (threadSource.trim() === "user") {
        const sessionHeader = headers["session-id"];
        if (typeof sessionHeader !== "string" || sessionHeader.trim().length === 0) return undefined;
        return { value: sessionHeader.trim(), threadSource: "user" };
    }
    return { value: threadHeader.trim(), threadSource };
}
