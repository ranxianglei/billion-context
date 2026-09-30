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

test("prefix-affinity: short crafted window cannot adopt an unrelated stored session (#1064 #13)", () => {
    const r = new PrefixAffinityResolver();
    const chain = Array.from({ length: 8 }, (_, i) => user(`stored turn ${i} with enough substance`));
    const a = r.resolve(chain);
    r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);
    // Replaying only 3 contiguous middle turns (sub-8 window) used to auto-adopt
    // the victim's session via "tail-window"; it must now fall through to a new one.
    // Mid-chain adoption no longer exists at any window size (#1115).
    const crafted = [chain[2]!, chain[3]!, chain[4]!];
    const b = r.resolve(crafted);
    assert.ok(b);
    assert.notEqual(b.sessionId, a.sessionId, "sub-8 leading run must not adopt the stored session");
    assert.equal(b.matchedDepth, 0);
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

test("prefix-affinity: rotating inline system prompt keeps the session (#1148)", () => {
    const r = new PrefixAffinityResolver();
    const sysV1 = { role: "system", content: "You are a harness. date=2026-09-23 cwd=/home/x budget=50000" };
    const sysV2 = { role: "system", content: "You are a harness. date=2026-09-24 cwd=/home/y budget=12000" };
    const a = r.resolve([sysV1, user("first question about caching layers")]);
    assert.ok(a);
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);
    const b = r.resolve([sysV2, user("first question about caching layers"), user("follow-up after the system rotated")]);
    assert.ok(b);
    assert.equal(b.sessionId, a.sessionId, "dynamic inline system must not fork the session every turn");
    assert.equal(b.via, "prefix");
    assert.equal(b.matchedDepth, a.incomingDepth, "match is measured on the system-stripped chain");
});

test("prefix-affinity: leading developer+system run is stripped together (#1148)", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve([{ role: "developer", content: "policy revision 7" }, user("the actual question")]);
    assert.ok(a);
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes);
    const b = r.resolve([{ role: "developer", content: "policy revision 9" }, { role: "system", content: "base prompt v3" }, user("the actual question")]);
    assert.equal(b!.sessionId, a.sessionId, "leading system/developer items are identity-invisible");
    // System-only requests stay rejected: the stripped array is empty.
    assert.equal(r.resolve([{ role: "system", content: "only system, however long this text is" }]), null);
});

test("prefix-affinity: mid-conversation system items remain identity data (#1148)", () => {
    const r = new PrefixAffinityResolver();
    const a = r.resolve([user("opening turn"), { role: "assistant", content: "answer one" }]);
    r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);
    const b = r.resolve([user("opening turn"), { role: "system", content: "course correction mid-chat" }, user("next turn")]);
    assert.notEqual(b!.sessionId, a!.sessionId, "a system item INSIDE the chain is conversation data, not a top-level system field");
});

test("prefix-affinity: LRU cap bounds tracked sessions", () => {
    const r = new PrefixAffinityResolver();
    for (let i = 0; i < 1030; i++) {
        const a = r.resolve([user(`unique conversation number ${i} with filler content`)]);
        r.note(a!.sessionId, a!.incomingDepth, a!.tailHash, a!.itemHashes);
    }
    assert.equal(r.trackedSessionIds().length, 1024);
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

test("prefix-affinity: resume-fork — full-transcript replay under a new id finds the parent chain (#1486)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? user(`parent turn ${i} with real substance`) : { role: "assistant", content: `parent reply ${i}` }));
    const fp = r.chainFingerprint(parent);
    assert.ok(fp);
    r.note("sess-parent", fp.depth, fp.tailHash, fp.itemHashes);
    const resumed = [...parent, user("resumed conversation next question")];
    assert.deepEqual(r.findResumeParent(resumed, "sess-child"), { sessionId: "sess-parent", sharedDepth: 10 });
});

test("prefix-affinity: resume-fork rejects short parents and short candidates (#1486)", () => {
    const r = new PrefixAffinityResolver();
    const short = Array.from({ length: 7 }, (_, i) => user(`short chain message ${i} with substance`));
    const sfp = r.chainFingerprint(short)!;
    r.note("sess-short", sfp.depth, sfp.tailHash, sfp.itemHashes);
    assert.equal(r.findResumeParent([...short, user("one more")], "other"), null, "7-deep parent below the floor must not match");
    const deep = Array.from({ length: 12 }, (_, i) => user(`deep chain message ${i} with substance`));
    const dfp = r.chainFingerprint(deep)!;
    r.note("sess-deep", dfp.depth, dfp.tailHash, dfp.itemHashes);
    assert.equal(r.findResumeParent(deep.slice(0, 5), "other"), null, "a sub-floor candidate cannot resume");
});

test("prefix-affinity: resume-fork rejects an edited head (not a byte-exact replay) (#1486)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => user(`stable parent turn ${i} with substance`));
    const fp = r.chainFingerprint(parent)!;
    r.note("sess-parent", fp.depth, fp.tailHash, fp.itemHashes);
    const edited = [...parent];
    edited[2] = user("edited third turn — different bytes");
    assert.equal(r.findResumeParent(edited, "child"), null, "a mid-history edit breaks the head-anchored match");
});

test("prefix-affinity: resume-fork rejects a candidate shorter than the stored chain (#1486)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => user(`full parent turn ${i} with substance`));
    const fp = r.chainFingerprint(parent)!;
    r.note("sess-parent", fp.depth, fp.tailHash, fp.itemHashes);
    assert.equal(r.findResumeParent(parent.slice(0, 9), "child"), null, "trimmed history is not a resume of this chain");
});

test("prefix-affinity: resume-fork excludes the caller's own session id (#1486)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => user(`self check turn ${i} with substance`));
    const fp = r.chainFingerprint(parent)!;
    r.note("sess-self", fp.depth, fp.tailHash, fp.itemHashes);
    assert.equal(r.findResumeParent(parent, "sess-self"), null, "an exact self-replay must not inherit from itself");
});

test("prefix-affinity: resume-fork picks the deepest matching chain (#1486)", () => {
    const r = new PrefixAffinityResolver();
    const base = Array.from({ length: 10 }, (_, i) => user(`common base turn ${i} with substance`));
    const fpA = r.chainFingerprint(base)!;
    r.note("sess-shallow", fpA.depth, fpA.tailHash, fpA.itemHashes);
    const extended = [...base, user("extension one"), { role: "assistant", content: "reply one" }];
    const fpB = r.chainFingerprint(extended)!;
    r.note("sess-deep", fpB.depth, fpB.tailHash, fpB.itemHashes);
    const candidate = [...extended, user("and further along")];
    assert.deepEqual(r.findResumeParent(candidate, "child"), { sessionId: "sess-deep", sharedDepth: 12 });
});

test("prefix-affinity: resume-fork matches beyond the per-item cap via progressive hash (#1486)", () => {
    const r = new PrefixAffinityResolver();
    const long = Array.from({ length: 130 }, (_, i) => user(`long chain message number ${i} with substance`));
    const fp = r.chainFingerprint(long)!;
    assert.equal(fp.itemHashes.length, 128, "per-item hashes stay capped");
    r.note("sess-long", fp.depth, fp.tailHash, fp.itemHashes);
    const candidate = [...long, user("thirteen-one"), user("thirteen-two")];
    assert.deepEqual(r.findResumeParent(candidate, "child"), { sessionId: "sess-long", sharedDepth: 130 });
});

test("prefix-affinity: resume-fork survives a restart via the persisted snapshot (#1486)", () => {
    const first = new PrefixAffinityResolver();
    const parent = Array.from({ length: 9 }, (_, i) => user(`persisted chain turn ${i} with substance`));
    const fp = first.chainFingerprint(parent)!;
    first.note("sess-persist", fp.depth, fp.tailHash, fp.itemHashes);
    const second = new PrefixAffinityResolver();
    assert.ok(second.importSnapshot(first.exportSnapshot()) >= 1);
    assert.deepEqual(second.findResumeParent([...parent, user("after the restart")], "child"), { sessionId: "sess-persist", sharedDepth: 9 });
});

test("prefix-affinity: equal-depth replay under a different id is NOT a resume (#1486)", () => {
    const r = new PrefixAffinityResolver();
    const transcript = Array.from({ length: 10 }, (_, i) => user(`duplicate conversation turn ${i} with substance`));
    const fp = r.chainFingerprint(transcript)!;
    r.note("sess-one", fp.depth, fp.tailHash, fp.itemHashes);
    assert.equal(r.findResumeParent(transcript, "sess-two"), null, "a byte-exact replay at the SAME depth under another id is a duplicate conversation, not a resume — linking it would adopt foreign blocks");
});

test("prefix-affinity: anonymous resolution never adopts an identified chain (#1486 #309)", () => {
    const r = new PrefixAffinityResolver();
    const transcript = Array.from({ length: 10 }, (_, i) => user(`cross identity turn ${i} with substance`));
    const fp = r.chainFingerprint(transcript)!;
    r.note("cross-proto-1", fp.depth, fp.tailHash, fp.itemHashes, true);
    const a = r.resolve([...transcript, user("anonymous follow-up")]);
    assert.ok(a);
    assert.match(a.sessionId, /^pfa-[0-9a-f]{16}$/, "anonymous clients keep their own pfa- ids even when replaying an identified transcript");
    assert.equal(a.via, "new");
    assert.equal(a.matchedDepth, 0);
});
