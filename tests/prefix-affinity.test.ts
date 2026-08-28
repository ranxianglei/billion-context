import assert from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";

import { PrefixAffinityResolver, affinityPartition, stableStringify } from "../src/prefix-affinity.ts";

const PART = affinityPartition("openai", "http://127.0.0.1:8787", "Bearer k1");
const PART2 = affinityPartition("openai", "http://127.0.0.1:8787", "Bearer k2");

function user(text: string): Record<string, unknown> {
    return { role: "user", content: text };
}

test("prefix-affinity: append-only continuation resolves to the same session", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve(PART, [user("hello there friend"), { role: "assistant", content: "hi" }]);
    assert.ok(a);
    assert.equal(a.matchedDepth, 0);
    assert.match(a.sessionId, /^pfa-[0-9a-f]{16}$/);
    r.note(PART, a.sessionId, a.incomingDepth, a.tailHash);

    const b = r.resolve(PART, [user("hello there friend"), { role: "assistant", content: "hi" }, user("second question")]);
    assert.ok(b);
    assert.equal(b.sessionId, a.sessionId, "appended history must resolve to the same session");
    assert.equal(b.matchedDepth, 2);
    assert.equal(b.incomingDepth, 3);
});

test("prefix-affinity: different conversations with distinct roots stay separate", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve(PART, [user("project one setup question")]);
    r.note(PART, a!.sessionId, a!.incomingDepth, a!.tailHash);
    const b = r.resolve(PART, [user("totally different topic opener")]);
    assert.notEqual(b!.sessionId, a!.sessionId, "different content must not collide");
    assert.equal(b!.matchedDepth, 0);
});

test("prefix-affinity: shared opening, divergent continuation forks on the next request", () => {
    const r = new PrefixAffinityResolver();
    const shared = [user("same opening message with substance"), { role: "assistant", content: "ok" }];
    const a = r.resolve(PART, shared);
    r.note(PART, a!.sessionId, a!.incomingDepth, a!.tailHash);

    // Branch A extends first — it keeps the session.
    const aNext = r.resolve(PART, [...shared, user("branch A continuation")]);
    assert.equal(aNext!.sessionId, a!.sessionId);
    r.note(PART, aNext!.sessionId, aNext!.incomingDepth, aNext!.tailHash);

    // Branch B diverges: its history does not extend the stored chain (hash
    // at stored depth differs), so it starts its own session.
    const bNext = r.resolve(PART, [...shared, user("branch B divergence")]);
    assert.equal(bNext!.matchedDepth, 0, "divergent branch must not match the stolen chain");
    assert.notEqual(bNext!.sessionId, a!.sessionId);
});

test("prefix-affinity: identical replay after restart reattaches the same deterministic id", () => {
    const first = new PrefixAffinityResolver();
    const a = first.resolve(PART, [user("persistent conversation anchor")]);
    first.note(PART, a!.sessionId, a!.incomingDepth, a!.tailHash);

    // Fresh process: no in-memory index, same first-turn content.
    const second = new PrefixAffinityResolver();
    const b = second.resolve(PART, [user("persistent conversation anchor")]);
    assert.equal(b!.sessionId, a!.sessionId, "deterministic id must reattach identical content");
});

test("prefix-affinity: trimmed history no longer matches — safe new session", () => {
    const r = new PrefixAffinityResolver();
    const full = [user("first message with content"), { role: "assistant", content: "r1" }, user("second message")];
    const a = r.resolve(PART, full);
    r.note(PART, a!.sessionId, a!.incomingDepth, a!.tailHash);

    // Client-side microcompact drops the middle turn: the stored 3-deep chain
    // is NOT a prefix of the trimmed history (it is longer).
    const trimmed = [user("first message with content"), user("second message")];
    const b = r.resolve(PART, trimmed);
    assert.equal(b!.matchedDepth, 0);
    assert.notEqual(b!.sessionId, a!.sessionId);
});

test("prefix-affinity: partitions isolate credentials", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve(PART, [user("same words across credentials")]);
    r.note(PART, a!.sessionId, a!.incomingDepth, a!.tailHash);
    const b = r.resolve(PART2, [user("same words across credentials")]);
    assert.notEqual(b!.sessionId, a!.sessionId, "different credential partitions must never share state");
    assert.equal(b!.matchedDepth, 0);
});

test("prefix-affinity: degenerate histories are rejected (null)", () => {
    const r = new PrefixAffinityResolver();
    assert.equal(r.resolve(PART, []), null, "empty");
    assert.equal(r.resolve(PART, [{ role: "system", content: "You are a helpful assistant with a fairly long system prompt." }]), null, "system-only: no user message");
    // An empty-content user message passes the byte floor ({"content":"","role":"user"}
    // is 24 canonical bytes): two such conversations would share a session,
    // which is harmless — there is no content to compress and they diverge on
    // the first real turn.
    assert.ok(r.resolve(PART, [{ role: "user", content: "" }]));
});

test("prefix-affinity: system+user openai shape (shared system must not collide)", () => {
    const r = new PrefixAffinityResolver();
    const sys = { role: "system", content: "You are ZCode, a shared IDE system prompt injected into every conversation." };
    const a = r.resolve(PART, [sys, user("question about project A")]);
    r.note(PART, a!.sessionId, a!.incomingDepth, a!.tailHash);
    const b = r.resolve(PART, [sys, user("question about project B")]);
    assert.notEqual(b!.sessionId, a!.sessionId, "identical system prefix must not merge distinct conversations");
});

test("prefix-affinity: LRU cap bounds tracked sessions", () => {
    const r = new PrefixAffinityResolver();
    for (let i = 0; i < 70; i++) {
        const a = r.resolve(PART, [user(`unique conversation number ${i} with filler content`)]);
        r.note(PART, a!.sessionId, a!.incomingDepth, a!.tailHash);
    }
    assert.equal(r.trackedSessionIds(PART).length, 64);
});

test("prefix-affinity: stableStringify sorts keys recursively", () => {
    assert.equal(
        stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }),
        stableStringify({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
});

test("prefix-affinity: key-order differences across replays still match", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve(PART, [{ role: "user", content: "key order robustness check", meta: { x: 1, y: 2 } }]);
    r.note(PART, a!.sessionId, a!.incomingDepth, a!.tailHash);
    const b = r.resolve(PART, [{ meta: { y: 2, x: 1 }, content: "key order robustness check", role: "user" }]);
    assert.equal(b!.sessionId, a!.sessionId, "same logical message in different key order must match");
});
