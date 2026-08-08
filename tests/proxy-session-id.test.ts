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

test("deriveSessionId: different conversation (different first-user) → different session", () => {
    const a = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "hello");
    const b = deriveSessionId(hdrs("Bearer keyA"), "anthropic", "https://bailian.example", "goodbye");
    assert.notEqual(a, b);
});

test("deriveSessionId: client conversation signal overrides content fingerprint", () => {
    // Same first-user content but different client conversation headers → different sessions
    const a = deriveSessionId(hdrs("Bearer keyA", "ses_111"), "anthropic", "https://up", "hello", {
        clientConversation: "ses_111",
    });
    const b = deriveSessionId(hdrs("Bearer keyA", "ses_222"), "anthropic", "https://up", "hello", {
        clientConversation: "ses_222",
    });
    assert.notEqual(a, b);
    // And two requests with the SAME client signal hit the same session even if
    // the first-user content fingerprint input differs (the signal wins).
    const c = deriveSessionId(hdrs("Bearer keyA", "ses_111"), "anthropic", "https://up", "different text", {
        clientConversation: "ses_111",
    });
    assert.equal(a, c);
});

test("deriveSessionId: no Authorization header → still works (uses placeholder key)", () => {
    const id = deriveSessionId({}, "anthropic", "https://up", "hello");
    assert.ok(id.length > 0);
    // Two keyless requests with same content → same session.
    assert.equal(id, deriveSessionId({}, "anthropic", "https://up", "hello"));
});

test("affinityToken: uses client signal when present (passthrough, preserves ses_ format)", () => {
    const t = affinityToken(hdrs("Bearer k", "ses_opencode_xyz"), "hello");
    assert.equal(t, "ses_opencode_xyz");
});

test("affinityToken: falls back to ses_<hash(convo)> when no client signal (no key, no upstream)", () => {
    const t = affinityToken(hdrs("Bearer k"), "hello world");
    assert.match(t, /^ses_[0-9a-f]+$/);
    // Stable for same input.
    assert.equal(t, affinityToken(hdrs("Bearer k"), "hello world"));
    // Different content → different token.
    assert.notEqual(t, affinityToken(hdrs("Bearer k"), "goodbye"));
});

test("affinityToken: protocolConversation (Responses previous_response_id) wins over content fingerprint", () => {
    const t = affinityToken(hdrs("Bearer k"), "some content", "resp_resp_abc123");
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
