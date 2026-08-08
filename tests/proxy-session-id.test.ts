import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessionId, affinityToken, clientConversationHeader } from "../src/session-id.ts";

/** Helper: build a minimal headers object. */
function hdrs(auth?: string, sessionAffinity?: string): Record<string, string> {
    const h: Record<string, string> = {};
    if (auth) h.authorization = auth;
    if (sessionAffinity) h["x-session-affinity"] = sessionAffinity;
    return h;
}

test("deriveSessionId: same conversation + same key + same protocol + same upstream → stable", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world");
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world");
    assert.equal(a, b);
});

test("deriveSessionId: stable for same (key, protocol, upstream, conversation)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world");
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world");
    assert.equal(a, b);
});

test("deriveSessionId: different API key → different session (no cross-account bleed)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello world");
    const b = deriveSessionId(hdrs("Bearer keyB"), "anthropic", "https://bailian.example", "hello world");
    assert.notEqual(a, b);
});

test("deriveSessionId: different upstream origin → different session (no cross-provider bleed)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "openai", "https://zhipu.example", "hello");
    const b = deriveSessionId(hdrs("Bearer keyA"), "openai", "https://bailian.example", "hello");
    assert.notEqual(a, b);
});

test("deriveSessionId: different protocol → different session (no cross-format bleed)", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello");
    const b = deriveSessionId(hdrs("Bearer keyA"), "openai", "https://bailian.example", "hello");
    assert.notEqual(a, b);
});

test("deriveSessionId: different conversation → different session", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello");
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "goodbye");
    assert.notEqual(a, b);
});

test("deriveSessionId: conversation signal is the only conversation dimension", () => {
    // The conversation dimension is whatever the caller passes — typically the
    // output of conversationSignal*, which already prefers a client header
    // and falls back to a content hash. Here we just confirm the passed value
    // is what matters (same key/proto/upstream, different convo → different).
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://up", "ses_111");
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://up", "ses_222");
    assert.notEqual(a, b);
    // Same convo signal → same session, regardless of anything else.
    assert.equal(a, deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://up", "ses_111"));
});

test("deriveSessionId: no Authorization header → still works (uses placeholder key)", () => {
    const id = deriveSessionId({}, "anthropic", "https://up", "convo-1");
    assert.ok(id.length > 0);
    // Two keyless requests with same content → same session.
    assert.equal(id, deriveSessionId({}, "anthropic", "https://up", "convo-1"));
});

test("deriveSessionId: empty conversation dimension THROWS (no silent collapse)", () => {
    // A caller that forgets to pass the conversation signal must fail loudly,
    // not silently collapse every anonymous session onto one id.
    assert.throws(() => deriveSessionId({}, "anthropic", "https://up", ""), /conversation dimension is required/);
});

test("affinityToken: uses client signal when present (passthrough, preserves ses_ format)", () => {
    const t = affinityToken(hdrs("Bearer k", "ses_opencode_xyz"), "convo-1");
    assert.equal(t, "ses_opencode_xyz");
});

test("affinityToken: falls back to ses_<convo> when no client signal", () => {
    const t = affinityToken(hdrs("Bearer k"), "convo-hash-xyz");
    assert.equal(t, "ses_convo-hash-xyz");
    // Different conversation → different token.
    assert.notEqual(t, affinityToken(hdrs("Bearer k"), "other-convo"));
});

test("affinityToken: protocolConversation (Responses previous_response_id) is just the conversation arg", () => {
    const t = affinityToken(hdrs("Bearer k"), "resp_resp_abc123");
    assert.equal(t, "ses_resp_resp_abc123");
});

test("clientConversationHeader: reads known session header names in priority order", () => {
    assert.equal(clientConversationHeader({ "x-session-affinity": "A", "x-acp-session": "B" }), "A");
    assert.equal(clientConversationHeader({ "x-acp-session": "B" }), "B");
    assert.equal(clientConversationHeader({ "x-session-id": "C" }), "C");
    assert.equal(clientConversationHeader({ "x-opencode-session": "D" }), "D");
    assert.equal(clientConversationHeader({}), undefined);
});

test("affinityToken is safe to send upstream: does NOT embed the API key", () => {
    // The affinity token must be derivable from the conversation alone — an
    // upstream that receives it should not be able to learn the key.
    const withKeyA = affinityToken(hdrs("Bearer keyA"), "hello");
    const withKeyB = affinityToken(hdrs("Bearer keyB"), "hello");
    assert.equal(withKeyA, withKeyB, "affinity token identical regardless of key");
});
