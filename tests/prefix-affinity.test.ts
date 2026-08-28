import assert from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";

import { PrefixAffinityResolver, stableStringify } from "../src/prefix-affinity.ts";

function user(text: string): Record<string, unknown> {
    return { role: "user", content: text };
}

test("prefix-affinity: append-only continuation resolves to the same session", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve([user("hello there friend"), { role: "assistant", content: "hi" }]);
    assert.ok(a);
    assert.equal(a.matchedDepth, 0);
    assert.match(a.sessionId, /^pfa-[0-9a-f]{16}$/);
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);

    const b = r.resolve([user("hello there friend"), { role: "assistant", content: "hi" }, user("second question")]);
    assert.ok(b);
    assert.equal(b.sessionId, a.sessionId, "appended history must resolve to the same session");
    assert.equal(b.matchedDepth, 2);
    assert.equal(b.incomingDepth, 3);
});

test("prefix-affinity: different conversations with distinct roots stay separate", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve([user("project one setup question")]);
    r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);
    const b = r.resolve([user("totally different topic opener")]);
    assert.notEqual(b!.sessionId, a!.sessionId, "different content must not collide");
    assert.equal(b!.matchedDepth, 0);
});

test("prefix-affinity: shared opening, divergent continuation forks on the next request", () => {
    const r = new PrefixAffinityResolver();
    const shared = [user("same opening message with substance"), { role: "assistant", content: "ok" }];
    const a = r.resolve(shared);
    r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);

    // Branch A extends first — it keeps the session.
    const aNext = r.resolve([...shared, user("branch A continuation")]);
    assert.equal(aNext!.sessionId, a!.sessionId);
    r.note(aNext!.sessionId, aNext!.incomingDepth, aNext!.tailHash, aNext!.itemHashes);

    // Branch B diverges: its history does not extend the stored chain (hash
    // at stored depth differs), so it starts its own session.
    const bNext = r.resolve([...shared, user("branch B divergence")]);
    assert.equal(bNext!.matchedDepth, 0, "divergent branch must not match the stolen chain");
    assert.notEqual(bNext!.sessionId, a!.sessionId);
});

test("prefix-affinity: identical replay after restart reattaches the same deterministic id", () => {
    const first = new PrefixAffinityResolver();
    const a = first.resolve([user("persistent conversation anchor")]);
    first.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);

    // Fresh process: no in-memory index, same first-turn content.
    const second = new PrefixAffinityResolver();
    const b = second.resolve([user("persistent conversation anchor")]);
    assert.equal(b!.sessionId, a!.sessionId, "deterministic id must reattach identical content");
});

test("prefix-affinity: trimmed history no longer matches — safe new session", () => {
    const r = new PrefixAffinityResolver();
    const full = [user("first message with content"), { role: "assistant", content: "r1" }, user("second message")];
    const a = r.resolve(full);
    r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);

    // Client-side microcompact drops the middle turn: the stored 3-deep chain
    // is NOT a prefix of the trimmed history (it is longer).
    const trimmed = [user("first message with content"), user("second message")];
    const b = r.resolve(trimmed);
    assert.equal(b!.matchedDepth, 0);
    assert.notEqual(b!.sessionId, a!.sessionId);
});

test("prefix-affinity: no environmental partitioning — same content survives credential/relay rotation (#286)", () => {
    const r = new PrefixAffinityResolver();
    const history = [user("same words across rotating credentials")];
    const a = r.resolve(history);
    r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);
    // #286 lesson: bearer rotation / relay switching / protocol translation
    // happen MID-CONVERSATION. There is no partition surface at all, so the
    // identical replay keeps resolving to the same session.
    const b = r.resolve(history);
    assert.equal(b!.sessionId, a!.sessionId, "content-only resolution must not fork on env changes");
    const c = r.resolve([...history, user("next turn after key rotation")]);
    assert.equal(c!.sessionId, a!.sessionId, "continuation after rotation must keep the session");
    assert.equal(c!.matchedDepth, 1);
});

test("prefix-affinity: degenerate histories are rejected (null)", () => {
    const r = new PrefixAffinityResolver();
    assert.equal(r.resolve([]), null, "empty");
    assert.equal(r.resolve([{ role: "system", content: "You are a helpful assistant with a fairly long system prompt." }]), null, "system-only: no user message");
    // An empty-content user message passes the byte floor ({"content":"","role":"user"}
    // is 24 canonical bytes): two such conversations would share a session,
    // which is harmless — there is no content to compress and they diverge on
    // the first real turn.
    assert.ok(r.resolve([{ role: "user", content: "" }]));
});

test("prefix-affinity: system+user openai shape (shared system must not collide)", () => {
    const r = new PrefixAffinityResolver();
    const sys = { role: "system", content: "You are ZCode, a shared IDE system prompt injected into every conversation." };
    const a = r.resolve([sys, user("question about project A")]);
    r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);
    const b = r.resolve([sys, user("question about project B")]);
    assert.notEqual(b!.sessionId, a!.sessionId, "identical system prefix must not merge distinct conversations");
});

test("prefix-affinity: LRU cap bounds tracked sessions", () => {
    const r = new PrefixAffinityResolver();
    for (let i = 0; i < 262; i++) {
        const a = r.resolve([user(`unique conversation number ${i} with filler content`)]);
        r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);
    }
    assert.equal(r.trackedSessionIds().length, 256);
});

test("prefix-affinity: stableStringify sorts keys recursively", () => {
    assert.equal(
        stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }),
        stableStringify({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
});

test("prefix-affinity: key-order differences across replays still match", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve([{ role: "user", content: "key order robustness check", meta: { x: 1, y: 2 } }]);
    r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);
    const b = r.resolve([{ meta: { y: 2, x: 1 }, content: "key order robustness check", role: "user" }]);
    assert.equal(b!.sessionId, a!.sessionId, "same logical message in different key order must match");
});
