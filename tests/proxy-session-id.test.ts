import { test } from "node:test";
import assert from "node:assert/strict";
import { affinityToken, clientConversationHeader, codexTurnIdentity, preferPromptCacheKeyIdentity } from "../src/session-id.ts";
import { conversationIdentityResponses, conversationSignalResponses } from "acp-kernel/wire";

test("preferPromptCacheKeyIdentity: fingerprint + prompt_cache_key → stable client-provided identity (omp stateless replay)", () => {
    // omp replays full history with no headers/session_id/previous_response_id:
    // kernel mints a per-request fingerprint. Two turns (different tails) must
    // both resolve to the SAME prompt_cache_key identity.
    const body1 = { input: [{ type: "message", role: "user", content: "hi" }], prompt_cache_key: "01a03971-c498-7000-a904-1c6bb148cccf" };
    const body2 = { input: [...body1.input, { type: "message", role: "user", content: "and more" }], prompt_cache_key: "01a03971-c498-7000-a904-1c6bb148cccf" };
    const id1 = preferPromptCacheKeyIdentity(conversationIdentityResponses(body1, undefined), body1);
    const id2 = preferPromptCacheKeyIdentity(conversationIdentityResponses(body2, undefined), body2);
    assert.ok(id1 && id2);
    assert.equal(id1.source, "prompt-cache-key");
    assert.equal(id1.value, "01a03971-c498-7000-a904-1c6bb148cccf");
    assert.equal(id1.value, id2.value);
    assert.equal(id1.clientProvided, true);
    // without the key the two turns would have diverged (per-request sessions)
    assert.notEqual(
        conversationIdentityResponses(body1, undefined).value,
        conversationIdentityResponses(body2, undefined).value,
    );
});

test("preferPromptCacheKeyIdentity: stronger signals win over prompt_cache_key", () => {
    const pckBody = { input: [], prompt_cache_key: "cache-key-x" };
    const header = preferPromptCacheKeyIdentity(
        conversationIdentityResponses(pckBody, "hdr-conv-1"),
        pckBody,
    );
    assert.equal(header!.source, "header");
    assert.equal(header!.value, "hdr-conv-1");
    const bodySession = preferPromptCacheKeyIdentity(
        conversationIdentityResponses({ input: [], session_id: "sess-1", prompt_cache_key: "cache-key-x" }, undefined),
        { prompt_cache_key: "cache-key-x" },
    );
    assert.equal(bodySession!.source, "body-session");
    const prevResp = preferPromptCacheKeyIdentity(
        conversationIdentityResponses({ input: [], previous_response_id: "resp_1" }, undefined),
        { prompt_cache_key: "cache-key-x" },
    );
    assert.equal(prevResp!.source, "previous-response");
});

test("preferPromptCacheKeyIdentity: no/blank/non-string prompt_cache_key keeps fingerprint", () => {
    for (const body of [{ input: [] }, { input: [], prompt_cache_key: "   " }, { input: [], prompt_cache_key: 42 }]) {
        const id = preferPromptCacheKeyIdentity(conversationIdentityResponses(body, undefined), body);
        assert.equal(id!.source, "content-fingerprint");
        assert.equal(id!.clientProvided, false);
    }
    assert.equal(preferPromptCacheKeyIdentity(undefined, { prompt_cache_key: "x" }), undefined);
});

test("preferPromptCacheKeyIdentity: client-provided value IS the session id, stable across growing turns (#286)", () => {
    const body1 = { input: [{ type: "message", role: "user", content: "hi" }], prompt_cache_key: "pck-omp-1" };
    const body2 = { input: [...body1.input, { type: "message", role: "user", content: "turn 2" }], prompt_cache_key: "pck-omp-1" };
    const id1 = preferPromptCacheKeyIdentity(conversationIdentityResponses(body1, undefined), body1)!;
    const id2 = preferPromptCacheKeyIdentity(conversationIdentityResponses(body2, undefined), body2)!;
    assert.equal(id1.value, id2.value);
    assert.equal(affinityToken(id1), "pck-omp-1");
});

test("affinityToken: uses client signal when present (passthrough, preserves ses_ format)", () => {
    const t = affinityToken({ value: "ses_opencode_xyz", source: "header", clientProvided: true });
    assert.equal(t, "ses_opencode_xyz");
});

test("affinityToken: generated identities are never forwarded upstream", () => {
    assert.equal(affinityToken({ value: "generated-random", source: "generated", clientProvided: false }), undefined);
});

test("clientConversationHeader: reads known session header names in priority order", () => {
    // Claude Code's true per-session UUID is the strongest signal and wins
    // over any other session header (only claude-code-family clients send it).
    assert.equal(clientConversationHeader({ "x-claude-code-session-id": "S", "x-session-affinity": "A" }), "S");
    assert.equal(clientConversationHeader({ "x-claude-code-session-id": "S" }), "S");
    assert.equal(clientConversationHeader({ "x-session-affinity": "A", "x-acp-session": "B" }), "A");
    assert.equal(clientConversationHeader({ "x-acp-session": "B" }), "B");
    assert.equal(clientConversationHeader({ "x-session-id": "C" }), "C");
    assert.equal(clientConversationHeader({ "x-opencode-session": "D" }), "D");
    assert.equal(clientConversationHeader({ "session-id": "E" }), "E");
    assert.equal(clientConversationHeader({ session_id: "F" }), "F");
    assert.equal(clientConversationHeader({}), undefined);
});

test("affinityToken: client-provided identity passes through verbatim (credentials never in scope)", () => {
    // affinityToken receives only the resolved identity object
    // ({ value, source, clientProvided }) — never raw headers or the
    // API key — so credential leakage is impossible by construction.
    const token = affinityToken({ value: "client-session", source: "body-session", clientProvided: true });
    assert.equal(token, "client-session");
});

test("conversationSignalResponses: prefers codex body.session_id (UUID) over previous_response_id and content hash", () => {
    // Codex 0.147+ sends body.session_id (a per-conversation UUID). It is the
    // most explicit identifier and must win over the fallbacks.
    const body = {
        input: "hello",
        session_id: "019fdc81-a420-7a00-bbd1-0a64e3eb772c",
        previous_response_id: "resp_abc",
    } as unknown as Parameters<typeof conversationSignalResponses>[0];
    const sig = conversationSignalResponses(body, undefined);
    assert.equal(sig, "019fdc81-a420-7a00-bbd1-0a64e3eb772c");
    const identity = conversationIdentityResponses(body, undefined);
    assert.equal(identity.source, "body-session");
    assert.equal(identity.clientProvided, true);
});

test("conversationSignalResponses: header (opencode x-session-affinity) still wins over body.session_id", () => {
    // A client-provided session header is the strongest signal (it is what
    // the client itself uses to identify the conversation).
    const body = {
        input: "hello",
        session_id: "019fdc81-a420-7a00-bbd1-0a64e3eb772c",
    } as unknown as Parameters<typeof conversationSignalResponses>[0];
    const sig = conversationSignalResponses(body, "ses_opencode-123");
    assert.equal(sig, "ses_opencode-123");
});

test("conversationIdentityResponses: previous_response_id is NOT client-provided (per-turn, not a stable conversation id)", () => {
    const body = {
        input: "hello",
        previous_response_id: "resp_xyz",
    } as unknown as Parameters<typeof conversationSignalResponses>[0];
    const identity = conversationIdentityResponses(body, undefined);
    assert.equal(identity.source, "previous-response");
    assert.equal(identity.value, "resp_xyz");
    assert.equal(identity.clientProvided, false);
});

test("conversationIdentityResponses: identical anonymous openers share a content fingerprint (rejected upstream by the server, #286)", () => {
    const body = { input: "hello world" } as unknown as Parameters<typeof conversationSignalResponses>[0];
    const a = conversationSignalResponses(body, undefined);
    const b = conversationSignalResponses({ input: "hello world" } as never, undefined);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
});

// ---- codexTurnIdentity (#316 / PR-A): codex turn-metadata partitioning ----

const ROOT_SESSION = "01a048b8-c704-7c00-8000-000000000000";
const SUB_THREAD = "01a048b8-c728-7c00-8000-000000000000";
const rootMeta = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ request_kind: "turn", thread_source: "user", thread_id: ROOT_SESSION, turn_id: "turn-1", window_id: "win-1", ...over });
const subMeta = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ request_kind: "turn", thread_source: "subagent", thread_id: SUB_THREAD, turn_id: "turn-2", window_id: "win-1", ...over });

test("codexTurnIdentity: thread_source user → session-id header (current root semantics)", () => {
    const id = codexTurnIdentity({
        "session-id": ROOT_SESSION,
        "thread-id": ROOT_SESSION,
        "x-codex-turn-metadata": rootMeta(),
    });
    assert.deepEqual(id, { value: ROOT_SESSION, threadSource: "user" });
});

test("codexTurnIdentity: thread_source subagent → thread-id header (fresh per-thread state, #150)", () => {
    // A subagent REUSES the root's session-id header but carries its own
    // thread-id — it must resolve to the thread-id, NOT the root session.
    const id = codexTurnIdentity({
        "session-id": ROOT_SESSION,
        "thread-id": SUB_THREAD,
        "x-codex-turn-metadata": subMeta(),
    });
    assert.deepEqual(id, { value: SUB_THREAD, threadSource: "subagent" });
});

test("codexTurnIdentity: root identity is stable across turns (turn_id/window_id churn is irrelevant)", () => {
    const a = codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": rootMeta({ turn_id: "turn-1", window_id: "w1" }) });
    const b = codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": rootMeta({ turn_id: "turn-99", window_id: "w42" }) });
    assert.deepEqual(a, b);
    assert.equal(a!.value, ROOT_SESSION);
});

test("codexTurnIdentity: metadata.thread_id must equal the thread-id header (cross-check, PR #249)", () => {
    // metadata says one thread, header says another → do not trust.
    const mismatch = codexTurnIdentity({
        "session-id": ROOT_SESSION,
        "thread-id": SUB_THREAD,
        "x-codex-turn-metadata": rootMeta({ thread_id: "01a048b8-ffff-7c00-8000-000000000000" }),
    });
    assert.equal(mismatch, undefined);
    // header missing entirely → do not trust.
    const noHeader = codexTurnIdentity({
        "session-id": ROOT_SESSION,
        "x-codex-turn-metadata": subMeta(),
    });
    assert.equal(noHeader, undefined);
});

test("codexTurnIdentity: JSON parse failure / non-object → do not trust (legacy chain)", () => {
    assert.equal(codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": "{not json" }), undefined);
    assert.equal(codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": "42" }), undefined);
    assert.equal(codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": "[1,2,3]" }), undefined);
    assert.equal(codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": "null" }), undefined);
    assert.equal(codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": "   " }), undefined);
});

test("codexTurnIdentity: unknown/missing thread_source → do not trust (legacy chain)", () => {
    assert.equal(codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": rootMeta({ thread_source: "system" }) }), undefined);
    assert.equal(codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": rootMeta({ thread_source: undefined }) }), undefined);
    assert.equal(codexTurnIdentity({ "session-id": ROOT_SESSION, "thread-id": ROOT_SESSION, "x-codex-turn-metadata": rootMeta({ thread_id: 123 }) }), undefined);
});

test("codexTurnIdentity: user turn with no session-id header → do not trust (legacy chain)", () => {
    assert.equal(codexTurnIdentity({ "thread-id": ROOT_SESSION, "x-codex-turn-metadata": rootMeta() }), undefined);
});

test("codexTurnIdentity: no metadata header (omp / other Responses clients) → undefined, legacy chain untouched", () => {
    // omp-style stateless replay: prompt_cache_key identity, no codex headers.
    // codexTurnIdentity must return undefined so the pck promotion chain runs.
    const id = codexTurnIdentity({});
    assert.equal(id, undefined);
    const body = { input: [{ type: "message", role: "user", content: "hi" }], prompt_cache_key: "omp-pck-1" };
    const promoted = preferPromptCacheKeyIdentity(conversationIdentityResponses(body, undefined), body);
    assert.equal(promoted!.source, "prompt-cache-key");
    assert.equal(promoted!.value, "omp-pck-1");
});
