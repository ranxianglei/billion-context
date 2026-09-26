import { isCodexClient } from "./codex-compact.js";

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
    return conversationHeaderSource(headers)?.value;
}

/** Same header walk as clientConversationHeader, but also reports WHICH header
 *  won — needed by callers whose trust decision depends on the signal's origin
 *  (#1102), not just its value. */
export function conversationHeaderSource(headers: Record<string, string | string[] | undefined>): { name: string; value: string } | undefined {
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
    // x-grok-session-id next: grok-shell (xAI's CLI) stamps its per-session
    // UUID on every model request (verified against grok-shell 1.0.34; the
    // parallel x-grok-conv-id carries the same value and stays as a
    // fallback). Client-specific name — same trust class as the claude
    // header above: without it the request is anonymous and falls to
    // prefix-affinity, which forks every turn because grok-shell reorders
    // its replayed history head between turns.
    // x-mavis-session-id: MiniMax Code (mcode) stamps its per-conversation id
    // on every model request (#1050). Client-specific name — same trust class
    // as the claude/grok headers above.
    const pluginMarker = typeof headers["x-bili-plugin"] === "string";
    const names = ["x-bili-plugin-conversation", "x-claude-code-session-id", "x-grok-session-id", "x-grok-conv-id", "x-mavis-session-id", "x-session-affinity", "x-acp-session", "x-session-id", "x-opencode-session", "session-id", "session_id"];
    for (const name of names) {
        if (name === "x-bili-plugin-conversation" && !pluginMarker) continue;
        const v = headers[name];
        if (typeof v === "string" && v.trim().length > 0) return { name, value: v.trim() };
    }
    return undefined;
}

/** #1106/#1102: whether the Responses-wire instructions fingerprint should
 *  participate in the compression-session key at all. Inverted allowlist: the
 *  fingerprint is OFF by default and applies ONLY to signals with a verified
 *  id-sharing persona problem.
 *
 * subagentNamespace's instructions fingerprint exists to separate PERSONAS that
 *  share one conversation id. Exactly two defendants ever needed it:
 *  - codex (#150): task-level session ids are REUSED across tasks, so
 *    different task instructions under one id must not merge. Modern codex
 *    (>=0.147) already isolates subagent threads via x-codex-turn-metadata ->
 *    thread-id verbatim (server.ts keys those directly, bypassing this
 *    predicate); the fingerprint still matters for root threads and older
 *    codex builds, detected by the turn-metadata header or the user agent
 *    (same convention as isCodexClient, #645).
 *  - claude over Responses (#970): subagents SHARE the main agent's session
 *    id (the Anthropic path splits them via claudeSubagentSplit; a claude
 *    client on the Responses wire only has this fingerprint).
 *
 * Everyone else keys VERBATIM: instructions drift mid-id means "same
 * conversation, evolved system context" (software upgrade, plugin install,
 * AGENTS.md edit - the relay-station majority case, #1106), and forking there
 * resets all compression state for no defending bug. opencode (persona-scoped
 * ses_ ids, #1102/#1104), grok/mcode (per-session ids by their own source),
 * plugin conversation ids, and generic x-session-id / body session_id all
 * stay on the verbatim path now. The x-bili-plugin-instructions-mutable
 * declaration (#1104) is vestigial: exempt is the default; hosts keep
 * stamping it for protocol compatibility with older proxies.
 *
 * A future client that shares one id across personas and separates them ONLY
 * by instructions must be added here (same evidence-per-client discipline as
 * #1104, inverted).
 */
export function instructionsFingerprintApplies(headers: Record<string, string | string[] | undefined>): boolean {
    const turnMeta = headers["x-codex-turn-metadata"];
    if (typeof turnMeta === "string" && turnMeta.trim().length > 0) return true;
    // One definition of "codex traffic" process-wide (every other codex path in
    // server.ts uses isCodexClient, #645). Its lenient substring fallback stays
    // CASE-SENSITIVE precisely because a case-insensitive match would pull
    // non-codex relays with "Codex"-shaped UAs back into the fingerprint and
    // re-fork them mid-conversation (#1106); only known codex prefixes (incl.
    // Codex Desktop, #1169) match case-insensitively.
    if (isCodexClient(headers)) return true;
    return conversationHeaderSource(headers)?.name === "x-claude-code-session-id";
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
 *   - "user"     → undefined (validated, but the id resolves through the
 *                  legacy precedence chain — binding the session-id header
 *                  directly would leapfrog stronger headers such as
 *                  x-bili-plugin-conversation and flip the identity when a
 *                  wrapper adds/drops the metadata mid-session; the legacy
 *                  chain reads the same session-id header for plain codex
 *                  traffic, so the root value is unchanged)
 *   - anything else → the `thread-id` header (fresh independent state per
 *                  thread; self-contained replay is lossless). codex's
 *                  ThreadSource serializes more than user/subagent —
 *                  "guardian_review" (review sessions), "memory_consolidation",
 *                  and arbitrary Feature strings such as "guardian_classifier"
 *                  (guardian-v2 async scorer) — all of which are internal
 *                  threads that need #150 isolation just as much, so the
 *                  discrimination is inverted: only "user" joins the root
 *                  session, every other source gets its own thread state.
 * A non-string/empty thread_source, unparseable JSON, or missing/mismatched
 * thread_id → undefined: the caller falls through to the legacy chain
 * unchanged.
 */
type CodexTurnIdentity = {
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
        // A root turn's headers are validated (the pair cross-checks), but the
        // session id still resolves through the legacy precedence chain:
        // binding directly to the session-id header here would leapfrog
        // stronger headers (e.g. x-bili-plugin-conversation) and flip the
        // identity when a wrapper adds or drops the metadata mid-session. The
        // legacy chain reads the same session-id header for plain codex
        // traffic, so the root value is unchanged.
        return undefined;
    }
    return { value: threadHeader.trim(), threadSource };
}

/**
 * Claude Code subagent split (#970).
 *
 * Claude Code stamps the SAME `x-claude-code-session-id` on every model
 * request of a session — including requests made by Task-tool subagents —
 * so the identity chain maps main turn and all subagents onto ONE session.
 * Every request then serializes on that session's lock (withSessionLock
 * covers prepare + forward + the streamed response), and a slow subagent
 * first request head-of-line-blocks the main turn (and vice versa) for the
 * full upstream latency.
 *
 * Discrimination is two-signal, both verified against live Claude Code
 * 2.1.274 traffic (`-p` mode AND custom agent types like Explore):
 *
 * 1. HEADER: the request carries `x-claude-code-agent-id` and/or
 *    `x-claude-code-parent-agent-id`. Main-turn requests carry agent-id only
 *    from their second request on (the very first request and side requests
 *    like title generation carry neither), so the header alone can't decide —
 *    the parent header is NOT reliable (general-purpose `-p` subagents send
 *    it, custom agent types like Explore do not).
 *
 * 2. SYSTEM: the MAIN agent's system always contains a block starting with
 *    one of the MAIN_SYSTEM_PREFIXES ("You are Claude Code…" for interactive
 *    sessions, "You are an interactive agent…" for -p/SDK sessions), while a
 *    subagent's system blocks are its agent definition ("This session is a
 *    background job…", "You are a file search specialist for…", …) — no
 *    stable positive marker exists across agent types, so the check is
 *    negative: none of the main prefixes may match.
 *
 * A request splits only when BOTH signals say subagent (header present AND
 * no main prefix in system). Failure modes degrade in the safe direction:
 * if a future Claude Code rewords its main prompts, subagents stop being
 * split (back to today's serial behavior) — the main session can never be
 * mis-split, because its prefixes are the gate and its system legitimately
 * mutates turn to turn without ever losing the prefix block.
 *
 * Split sessions keep per-subagent compression state (a subagent is its own
 * conversation; isolation matches the codex #316/#150 semantics) and get
 * their own lock chain, so subagents stop queueing behind the main turn.
 * The namespace format mirrors subagentNamespace's `<id>|sub:<hash>` on the
 * Responses branch. Clients without these headers (older Claude Code, other
 * agents, curl) are untouched.
 */
const MAIN_SYSTEM_PREFIXES = ["You are Claude Code", "You are an interactive agent"] as const;

export function claudeSubagentAgentId(
    headers: Record<string, string | string[] | undefined>,
    systemBlocks: string[],
): string | undefined {
    // Node lowercases inbound header names; an array value (repeated header)
    // is ambiguous and treated as absent, same posture as
    // clientConversationHeader.
    const agent = headers["x-claude-code-agent-id"];
    const parent = headers["x-claude-code-parent-agent-id"];
    const agentId = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined;
    const parentId = typeof parent === "string" && parent.trim().length > 0 ? parent.trim() : undefined;
    if (agentId === undefined && parentId === undefined) return undefined;
    const isMain = systemBlocks.some((block) => {
        const t = block.trimStart();
        return MAIN_SYSTEM_PREFIXES.some((p) => t.startsWith(p));
    });
    if (isMain) return undefined;
    return agentId ?? parentId;
}

/** Derive the subagent session id `<id>|sub:<agent-id>`; unchanged when the
 *  request is not a Claude Code subagent (no agent header, or main-turn
 *  system prefixes present). */
export function claudeSubagentSplit(id: string, headers: Record<string, string | string[] | undefined>, systemBlocks: string[]): string {
    const agent = claudeSubagentAgentId(headers, systemBlocks);
    return agent ? `${id}|sub:${agent}` : id;
}
