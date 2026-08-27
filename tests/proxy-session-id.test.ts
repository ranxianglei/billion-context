import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessionId, affinityToken, clientConversationHeader, preferPromptCacheKeyIdentity } from "../src/session-id.ts";
import { conversationIdentityResponses, conversationSignalResponses } from "acp-kernel/wire";

/** Helper: build a minimal headers object. */
function hdrs(auth?: string, sessionAffinity?: string): Record<string, string> {
    const h: Record<string, string> = {};
    if (auth) h.authorization = auth;
    if (sessionAffinity) h["x-session-affinity"] = sessionAffinity;
    return h;
}

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

test("preferPromptCacheKeyIdentity: derived session id stable across growing turns + affinity forwards it", () => {
    const body1 = { input: [{ type: "message", role: "user", content: "hi" }], prompt_cache_key: "pck-omp-1" };
    const body2 = { input: [...body1.input, { type: "message", role: "user", content: "turn 2" }], prompt_cache_key: "pck-omp-1" };
    const h = hdrs("Bearer keyOmp");
    const id1 = preferPromptCacheKeyIdentity(conversationIdentityResponses(body1, undefined), body1)!;
    const id2 = preferPromptCacheKeyIdentity(conversationIdentityResponses(body2, undefined), body2)!;
    assert.equal(
        deriveSessionId(h, "responses", "http://127.0.0.1:8199", id1.value, id1.clientProvided),
        deriveSessionId(h, "responses", "http://127.0.0.1:8199", id2.value, id2.clientProvided),
    );
    assert.equal(affinityToken(id1), "pck-omp-1");
});

test("deriveSessionId: same conversation + same key + same protocol + same upstream → stable (weak signal)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world", false);
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world", false);
    assert.equal(a, b);
});

test("deriveSessionId: stable for same (key, protocol, upstream, conversation) (weak signal)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world", false);
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world", false);
    assert.equal(a, b);
});

test("deriveSessionId: different API key → different session (no cross-account bleed, weak signal)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world", false);
    const b = deriveSessionId(hdrs("Bearer keyB"), "anthropic", "https://bailian.example", "hello world", false);
    assert.notEqual(a, b);
});

test("deriveSessionId: credentials remain case-sensitive opaque values (weak signal)", () => {
    const upper = deriveSessionId(hdrs("Bearer AbCd"), "responses", "https://chatgpt.com", "session", false);
    const lower = deriveSessionId(hdrs("Bearer abcd"), "responses", "https://chatgpt.com", "session", false);
    assert.notEqual(upper, lower);
});

test("deriveSessionId: different upstream origin → different session (no cross-provider bleed, weak signal)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "openai", "https://zhipu.example", "hello", false);
    const b = deriveSessionId(hdrs("Bearer keyA"), "openai", "https://bailian.example", "hello", false);
    assert.notEqual(a, b);
});

test("deriveSessionId: different protocol → different session (no cross-format bleed, weak signal)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello", false);
    const b = deriveSessionId(hdrs("Bearer keyA"), "openai", "https://bailian.example", "hello", false);
    assert.notEqual(a, b);
});

test("deriveSessionId: different conversation → different session (weak signal)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello", false);
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "goodbye", false);
    assert.notEqual(a, b);
});

test("deriveSessionId: conversation signal is the only conversation dimension (weak signal)", () => {
    // The conversation dimension is whatever the caller passes — typically the
    // output of conversationSignal*, which already prefers a client header
    // and falls back to a content hash. Here we just confirm the passed value
    // is what matters (same key/proto/upstream, different convo → different).
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://up", "ses_111", false);
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://up", "ses_222", false);
    assert.notEqual(a, b);
    // Same convo signal → same session, regardless of anything else.
    assert.equal(a, deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://up", "ses_111", false));
});

test("deriveSessionId: no Authorization header → still works (uses placeholder key, weak signal)", () => {
    const id = deriveSessionId({}, "anthropic", "https://up", "convo-1", false);
    assert.ok(id.length > 0);
    // Two keyless requests with same content → same session.
    assert.equal(id, deriveSessionId({}, "anthropic", "https://up", "convo-1", false));
});

test("deriveSessionId: empty conversation dimension THROWS (no silent collapse)", () => {
    // A caller that forgets to pass the conversation signal must fail loudly,
    // not silently collapse every anonymous session onto one id.
    assert.throws(() => deriveSessionId({}, "anthropic", "https://up", "", false), /conversation dimension is required/);
});

test("deriveSessionId: strong signal ignores credential rotation (ChatGPT OAuth bearer, #286)", () => {
    const convo = "019fdc81-a420-7a00-bbd1-0a64e3eb772c";
    const a = deriveSessionId(hdrs("Bearer bearer-old"), "responses", "https://chatgpt.com", convo, true);
    const b = deriveSessionId(hdrs("Bearer bearer-new"), "responses", "https://chatgpt.com", convo, true);
    assert.equal(a, b);
});

test("deriveSessionId: strong signal survives upstream/relay switching (#286)", () => {
    const convo = "019fdc81-a420-7a00-bbd1-0a64e3eb772c";
    const a = deriveSessionId(hdrs("Bearer keyA"), "responses", "https://relay-1.example", convo, true);
    const b = deriveSessionId(hdrs("Bearer keyA"), "responses", "https://relay-2.example", convo, true);
    assert.equal(a, b);
});

test("deriveSessionId: strong signal stable for same (protocol, conversation)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "responses", "https://chatgpt.com", "convo-1", true);
    const b = deriveSessionId(hdrs("Bearer keyB"), "responses", "https://other.example", "convo-1", true);
    assert.equal(a, b);
});

test("deriveSessionId: strong signal different conversation → different session", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "responses", "https://chatgpt.com", "convo-1", true);
    const b = deriveSessionId(hdrs("Bearer keyA"), "responses", "https://chatgpt.com", "convo-2", true);
    assert.notEqual(a, b);
});

test("deriveSessionId: strong signal different protocol → different session (no cross-format bleed)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://chatgpt.com", "convo-1", true);
    const b = deriveSessionId(hdrs("Bearer keyA"), "responses", "https://chatgpt.com", "convo-1", true);
    assert.notEqual(a, b);
});

test("deriveSessionId: strong and weak tiers never collide for the same conversation value", () => {
    // hash(protocol|convo) and hash(protocol|upstream|key|convo) are different
    // hash inputs, so a session must not migrate between tiers when the
    // client's signal strength changes mid-flight.
    const strong = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://up", "hello", true);
    const weak = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://up", "hello", false);
    assert.notEqual(strong, weak);
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
    // After the refactor, affinityToken receives only the resolved identity
    // object ({ value, source, clientProvided }) — never raw headers or the
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

test("conversationIdentityResponses: previous_response_id provides a stable conversation link", () => {
    const body = {
        input: "hello",
        previous_response_id: "resp_xyz",
    } as unknown as Parameters<typeof conversationSignalResponses>[0];
    const identity = conversationIdentityResponses(body, undefined);
    assert.equal(identity.source, "previous-response");
    assert.equal(identity.value, "resp_xyz");
    assert.equal(identity.clientProvided, false);
});

test("conversationIdentityResponses: identical anonymous openers share a content fingerprint (enables compression)", () => {
    const body = { input: "hello world" } as unknown as Parameters<typeof conversationSignalResponses>[0];
    const a = conversationSignalResponses(body, undefined);
    const b = conversationSignalResponses({ input: "hello world" } as never, undefined);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
});
