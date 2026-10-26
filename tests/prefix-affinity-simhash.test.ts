import assert from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";

import { PrefixAffinityResolver, setSimhashAdoptionEnabled } from "../src/prefix-affinity.ts";
import { simhashHex, hammingHex } from "../src/affinity-simhash.ts";

/**
 * #2265: simhash chain alignment — identity ladder rung 2. A client that
 * decoratively rewrites its history (Trae re-stamps every assistant message
 * with the new model's tag on a model switch) breaks the exact progressive
 * hash at the FIRST mutated message and used to mint a fresh session on every
 * request, orphaning the fold state. Chain-level similarity (count lines up,
 * every position ~99% similar) re-attaches the existing session.
 */

function user(text: string): Record<string, unknown> {
    return { role: "user", content: text };
}

function assistant(text: string): Record<string, unknown> {
    return { role: "assistant", content: text };
}

/** A conversation deep enough for alignment (ALIGN_MIN_DEPTH = 8) with
 *  message bodies long enough that a one-line mutation stays "99% similar". */
function buildConversation(turns: number): Record<string, unknown>[] {
    const msgs: Record<string, unknown>[] = [];
    for (let i = 0; i < turns; i++) {
        msgs.push(user(`turn ${i}: please analyze the deployment pipeline for service alpha-${i} and report the latency profile of stage ${i} through stage ${i + 3}, including retry counts and queue depth`));
        msgs.push(assistant(`analysis ${i}: stage ${i} shows a stable latency profile with a p95 of ${120 + i}ms; the retry budget was consumed ${i} times; queue depth stayed under ${10 + i}; overall the pipeline for alpha-${i} is healthy and no intervention is required at this point in time`));
    }
    return msgs;
}

/** Trae-shaped mutation: prepend a model stamp line to every assistant
 *  message (a couple of user messages get an injected reminder too). */
function restampWithModel(msgs: Record<string, unknown>[], model: string): Record<string, unknown>[] {
    return msgs.map((m, i) => {
        if (m.role !== "assistant") {
            if (i % 5 === 0) return { ...m, content: `${(m as { content: string }).content}\n<system-reminder>session migrated to ${model}</system-reminder>` };
            return m;
        }
        return { ...m, content: `You are a coding agent powered by the ${model} model.\n${(m as { content: string }).content}` };
    });
}

function track(r: PrefixAffinityResolver, msgs: Record<string, unknown>[]): string {
    const a = r.resolve(msgs);
    assert.ok(a, "resolve must produce an affinity for a valid conversation");
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes, false, a.sketches, a.userFlags);
    return a.sessionId;
}

test("simhash math: identical → 0, small mutation → small Hamming, unrelated → large", () => {
    const base = "analysis of the deployment pipeline for service alpha shows stable latency with a p95 of 120ms, retry budget consumed twice, queue depth under ten, no intervention required";
    const a = simhashHex(JSON.stringify({ role: "assistant", content: base }));
    assert.equal(hammingHex(a, a), 0);
    const mutated = simhashHex(JSON.stringify({ role: "assistant", content: `You are a coding agent powered by the glm-5.3 model.\n${base}` }));
    assert.ok(hammingHex(a, mutated) <= 10, `decorative mutation must stay SIMILAR, got ${hammingHex(a, mutated)}`);
    const unrelated = simhashHex(JSON.stringify({ role: "assistant", content: "completely different content about baking sourdough bread with a long fermentation schedule and hydration ratios" }));
    assert.ok(hammingHex(a, unrelated) >= 24, `unrelated text must be far, got ${hammingHex(a, unrelated)}`);
});

test("#2265 simhash adoption: model-switch rewrite re-attaches the existing session", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8); // depth 16
    const sessionId = track(r, original);

    // The client switches models and rewrites its history; the exact chain
    // breaks at the FIRST mutated message — this is the #2265 death spiral.
    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r.resolve(rewritten);
    assert.ok(b);
    assert.equal(b.via, "simhash", "chain-level similarity must adopt the existing session");
    assert.equal(b.sessionId, sessionId);
    assert.ok(b.adoption && b.adoption.coverage >= 0.9, `coverage ${b.adoption?.coverage}`);
    r.note(b.sessionId, b.incomingDepth, b.tailHash, b.itemHashes, false, b.sketches, b.userFlags);

    // Self-healing: the stored chain is re-anchored on the rewritten bytes, so
    // the next identical replay resolves by exact prefix again (fast path).
    const c = r.resolve(rewritten);
    assert.ok(c);
    assert.equal(c.via, "prefix", "post-adoption replay must return to the exact fast path");
    assert.equal(c.sessionId, sessionId);
});

test("#2265: a different conversation is NOT adopted (coverage gate)", () => {
    const r = new PrefixAffinityResolver();
    const sessionId = track(r, buildConversation(8));

    // Same depth, same roles, entirely different content.
    const other = buildConversation(8).map((m, i) => ({ ...m, content: `unrelated ${i}: ${Math.random().toString(36).slice(2)} quantum chromodynamics lattice gauge theory renormalization group flow equations with fermion determinant` }));
    const b = r.resolve(other);
    assert.ok(b);
    assert.equal(b.via, "new", "a different conversation must mint fresh, not adopt");
    assert.notEqual(b.sessionId, sessionId);
});

test("#2265: a divergent fork is NOT adopted (one completely-different message fails the candidate)", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);

    // Fork shape: shared history up to turn 4, then the conversation went a
    // completely different way. Most positions differ hard → divergent gate.
    const forked = [...original.slice(0, 8)];
    for (let i = 4; i < 8; i++) {
        forked.push(user(`fork turn ${i}: completely unrelated question about kubernetes operator reconciliation loops number ${i}`));
        forked.push(assistant(`fork answer ${i}: the operator retried because of the generation delta and the resistive throughput of the cache layer exceeded the memetic dampener threshold`));
    }
    const b = r.resolve(forked);
    assert.ok(b);
    assert.equal(b.via, "new", "a divergent fork must not adopt the parent");
    assert.notEqual(b.sessionId, sessionId);
});

test("#2265: tail append after a rewrite still adopts (client added turns)", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);

    const rewritten = restampWithModel(original, "deepseek-v4.1");
    rewritten.push(user("brand new follow-up question after the model switch"));
    const b = r.resolve(rewritten);
    assert.ok(b);
    assert.equal(b.via, "simhash");
    assert.equal(b.sessionId, sessionId);
    assert.equal(b.incomingDepth, original.length + 1);
});

test("#2265: two similar candidates → ambiguity refuses to guess", () => {
    const r = new PrefixAffinityResolver();
    // Longer bodies than buildConversation so a model-stamp rewrite stays
    // comfortably within the similarity gate against BOTH chains.
    const tail = " with additional surrounding context about the deployment environment covering the release cadence the rollback policy the observability dashboards the alert routing rules the on-call rotation schedule the incident review process the change freeze calendar the capacity planning model the cost allocation tags the network topology diagram the storage tiering policy the backup retention window the disaster recovery runbook the performance regression budget the load shedding thresholds the graceful degradation matrix the configuration drift detection the secret rotation cadence the certificate renewal pipeline and the end to end tracing correlation that ties every stage of the pipeline together";
    const original = buildConversation(8).map((m) => ({ ...m, content: `${(m as { content: string }).content}${tail}` }));
    const idA = track(r, original);
    // A second chain with the SAME shape. It cannot be created via resolve()
    // — the adoption rung would (correctly) merge it into idA — so note it
    // directly, the way a historical snapshot would have carried it.
    const sibling = restampWithModel(original, "glm-5.3");
    let siblingFp: { sessionId: string; incomingDepth: number; tailHash: string; itemHashes: string[]; sketches?: string[]; userFlags?: boolean[] };
    try {
        setSimhashAdoptionEnabled(false);
        siblingFp = r.resolve(sibling)!; // via "new", carrying sketches
    } finally {
        setSimhashAdoptionEnabled(true);
    }
    r.note(siblingFp.sessionId, siblingFp.incomingDepth, siblingFp.tailHash, siblingFp.itemHashes, false, siblingFp.sketches, siblingFp.userFlags);
    assert.notEqual(idA, siblingFp.sessionId);

    // The incoming rewrite is 99%-similar to BOTH chains — a coin flip is
    // not ownership evidence; the resolver must refuse and mint fresh.
    const incoming = restampWithModel(original, "glm-5.4");
    const b = r.resolve(incoming);
    assert.ok(b);
    assert.equal(b.via, "new", "ambiguity must refuse adoption");
    assert.notEqual(b.sessionId, idA);
    assert.notEqual(b.sessionId, siblingFp.sessionId);
});

test("#2265: a POINT mutation (edit-and-resend fork) is not adopted — #629 separation preserved", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const a = r.resolve(original)!;
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes, false, a.sketches, a.userFlags);
    // One middle message edited — the classic edit-and-resend fork. 15/16
    // positions remain byte-identical, which satisfies coverage, but the
    // mutation is POINT, not PERVASIVE: adopting would permanently merge the
    // fork branch into the parent session, breaking the #629 contract that
    // an edit fork mints its own session (and adopts blocks via forkAdoption).
    const edited = original.map((m, i) =>
        i === 8 ? { ...m, content: `${(m as { content: string }).content} (edited branch)` } : m,
    );
    const b = r.resolve(edited)!;
    assert.ok(b);
    assert.equal(b.via, "new", "point-edit fork must mint, not adopt");
    assert.notEqual(b.sessionId, a.sessionId);
});

test("#2265: a DIFFERENT conversation with shared boilerplate is not adopted (user-word anchor)", () => {
    // Shape found via tests/fork-adoption.test.ts: two scenarios of the same
    // mock harness produce conversations whose assistant replies are
    // byte-identical boilerplate and whose user turns differ only by a small
    // run token — every position passes the Hamming gate (coverage 100%,
    // pervasive mutations), so the statistics alone CANNOT tell them apart.
    // The ownership anchor can: no USER message is byte-identical, so this is
    // a different conversation, not a rewrite. Must mint, never adopt.
    const r = new PrefixAffinityResolver();
    const boiler = `analysis: the pipeline is healthy and no intervention is required ${"the quick brown fox jumps over the lazy dog again and again. ".repeat(10)}`;
    const convA: Array<{ role: string; content: string }> = [];
    const convB: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 8; i++) {
        convA.push({ role: "user", content: `run scenario-alpha-${i} user turn ${i}: please analyze the deployment pipeline for service alpha-${i}` });
        convA.push({ role: "assistant", content: boiler });
        convB.push({ role: "user", content: `run scenario-beta-${i} user turn ${i}: please analyze the deployment pipeline for service beta-${i}` });
        convB.push({ role: "assistant", content: boiler });
    }
    const a = r.resolve(convA)!;
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes, false, a.sketches, a.userFlags);
    const b = r.resolve(convB)!;
    assert.ok(b);
    assert.equal(b.via, "new", "different conversation (even with identical assistant boilerplate) must mint");
    assert.notEqual(b.sessionId, a.sessionId);
});

test("#2265: kill-switch BILI_AFFINITY_SIMHASH=0 restores the pre-#2265 mint", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);
    try {
        setSimhashAdoptionEnabled(false);
        const rewritten = restampWithModel(original, "glm-5.3");
        const b = r.resolve(rewritten);
        assert.ok(b);
        assert.equal(b.via, "new", "adoption rung disabled → fresh mint (old behavior)");
        assert.notEqual(b.sessionId, sessionId);
    } finally {
        setSimhashAdoptionEnabled(true);
    }
});

test("#2265: stale sketches (older than the TTL window) are not adoption candidates", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);
    // Age the entry past SKETCH_TTL_MS by re-importing the snapshot with an
    // old lastSeen — the persistence path is the honest way to touch it.
    const snapshot = r.exportSnapshot().map((e) => (e.sessionId === sessionId ? { ...e, lastSeen: Date.now() - 25 * 60 * 60 * 1000 } : e));
    const r2 = new PrefixAffinityResolver();
    assert.equal(r2.importSnapshot(snapshot), 1);

    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r2.resolve(rewritten);
    assert.ok(b);
    assert.equal(b.via, "new", "stale sketches must not adopt");
});

test("#2265: shallow chains (below ALIGN_MIN_DEPTH) never adopt", () => {
    const r = new PrefixAffinityResolver();
    const original = [user("a short but substantial opening question about latency"), assistant("a short answer with some substance in it")];
    const sessionId = track(r, original);
    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r.resolve(rewritten);
    assert.ok(b);
    assert.equal(b.via, "new", "a 2-position alignment is not ownership evidence");
    assert.notEqual(b.sessionId, sessionId);
});

test("#2265: sketches survive the persistence roundtrip and adopt after a restart", () => {
    const r1 = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r1, original);
    const snapshot = r1.exportSnapshot();
    assert.ok(snapshot[0]!.sketches?.length === 16, "snapshot must carry full-depth sketches");

    const r2 = new PrefixAffinityResolver();
    assert.equal(r2.importSnapshot(JSON.parse(JSON.stringify(snapshot))), 1);
    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r2.resolve(rewritten);
    assert.ok(b);
    assert.equal(b.via, "simhash", "adopted across the restart");
    assert.equal(b.sessionId, sessionId);
});

test("#2265: malformed sketches in a snapshot degrade to exact-hash resolution", () => {
    const r1 = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r1, original);
    const snapshot = r1.exportSnapshot().map((e) => (e.sessionId === sessionId ? { ...e, sketches: ["zz", "nothex", ...Array(16).fill("deadbeefdeadbeef")] } : e));
    const r2 = new PrefixAffinityResolver();
    r2.importSnapshot(snapshot);
    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r2.resolve(rewritten);
    assert.ok(b);
    assert.equal(b.via, "new", "corrupt sketches must not crash or adopt");
});

test("#2265: exact replay of the ORIGINAL bytes after adoption still hits the exact fast path", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);
    // Client switches back: the rewritten bytes were noted, but the ORIGINAL
    // history exact-matches... nothing (chain was re-anchored) — then aligns
    // as a rewrite again. Proves adoption works in BOTH directions.
    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r.resolve(rewritten);
    assert.equal(b!.via, "simhash");
    r.note(b!.sessionId, b!.incomingDepth, b!.tailHash, b!.itemHashes, false, b!.sketches, b!.userFlags);
    const back = r.resolve(original);
    assert.ok(back);
    assert.equal(back.via, "simhash", "the reverse rewrite must also re-attach");
    assert.equal(back.sessionId, sessionId);
});

test("#2265: sketches are retained only for the most recently noted chains", () => {
    const r = new PrefixAffinityResolver();
    // Noted-first chain — its sketches will age out of the SKETCH_MAX_CHAINS
    // window once 64 newer chains carry sketches. The filler chains must be
    // genuinely DIFFERENT conversations (not near-identical variants — those
    // legitimately adopt each other per the #2265 disclosure).
    const original = buildConversation(8);
    const firstId = track(r, original);
    const topics = ["lattice gauge theory renormalization", "kubernetes operator reconciliation", "sourdough hydration schedules", "compiler register allocation graphs", "ocean thermohaline circulation", "protein folding energy landscapes"];
    for (let i = 0; i < 70; i++) {
        const topic = topics[i % topics.length]!;
        const filler = Array.from({ length: 12 }, (_, j) => `${topic}-${i}-${j}`).join(" ");
        track(r, buildConversation(8).map((m) => ({ ...m, content: `${(m as { content: string }).content} ${filler}` })));
    }
    const snapshot = r.exportSnapshot();
    const first = snapshot.find((e) => e.sessionId === firstId);
    assert.ok(first);
    assert.equal(first.sketches, undefined, "the oldest chain beyond the retention window must lose its sketches");
    assert.ok(snapshot.filter((e) => e.sketches !== undefined).length <= 64, "sketch carriers stay within the retention bound");

    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r.resolve(rewritten);
    assert.ok(b);
    assert.equal(b.via, "new", "no sketches → no adoption candidate");
    assert.notEqual(b.sessionId, firstId);
});

test("#2265: identified chains are never adoption candidates", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const a = r.resolve(original);
    assert.ok(a);
    // Note as IDENTIFIED (client-provided id lane) WITH sketches — the
    // adoption scan must still skip it (anonymous world keeps pfa-* ids).
    r.note("cc-identified-session", a.incomingDepth, a.tailHash, a.itemHashes, true, a.sketches, a.userFlags);
    const rewritten = restampWithModel(original, "glm-5.3");
    const b = r.resolve(rewritten);
    assert.ok(b);
    assert.equal(b.via, "new");
    assert.notEqual(b.sessionId, "cc-identified-session");
});

test("#2265: fast path carries sketches so note() keeps the chain adoptable", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const a = r.resolve(original);
    assert.ok(a);
    assert.ok(a.sketches && a.sketches.length === 16, "resolve must attach sketches on every outcome");
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes, false, a.sketches, a.userFlags);

    // Second request: identical history → exact prefix fast path; note()
    // again (as the server does) — sketches must still be on the entry, so a
    // THIRD request with a rewrite can still adopt.
    const b = r.resolve(original);
    assert.equal(b!.via, "prefix");
    r.note(b!.sessionId, b!.incomingDepth, b!.tailHash, b!.itemHashes, false, b!.sketches, b!.userFlags);
    const rewritten = restampWithModel(original, "glm-5.3");
    const c = r.resolve(rewritten);
    assert.equal(c!.via, "simhash", "sketches survive fast-path notes");
    assert.equal(c!.sessionId, a.sessionId);
});
