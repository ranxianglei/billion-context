import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress } from "../src/preflight.ts";
import type { Session } from "../src/session.ts";

process.env.NODE_ENV = "test";
const SUMMARY = "The preceding work is summarized here with all decisions and remaining tasks preserved for the next turn.";

// #2638 minimal geometry (full-log host resends the ENTIRE history every turn;
// mimics a days-old autoFold session whose middle is already fully folded):
//   b_head = m1..m6 (anchor m1)                   <- everything before the dead span is covered
//   A@7, B@17, M22@22, M37@37 = checkpoints (summaryOfBlockId=b_head, live carriers)
//   b_mid = m8..m21 minus carriers (anchor m8)     -> covered raws sit BETWEEN B and M22
//   b_tailblock = m23..m36 (anchor m23)            -> nests inside the advertised span
// The carrier cluster [A,B,M22] looks like a plain compressible group in the pruned view
// (covered raws invisible there), so the kernel advertises m00007..m00022 every turn; at
// apply time every message of that positional span is either covered by an active block or
// carved out as a live carrier -> structurally empty -> permanent "no new compressible
// messages" rejection loop (#2638).
async function buildDeadSpanFixture() {
    const core = createCore();
    const config = defaultConfig(1_000_000);
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 1000; // chars — merge batch gate: carrier cluster must clear it alone to be advertised
    const H: CoreMessage[] = [];
    let n = 0;
    const pushU = (text: string) => { n++; const id = `msg-${n}`; H.push({ id, role: "user", contentType: "text", text }); return id; };
    const pushA = (text: string) => { n++; const id = `msg-${n}`; H.push({ id, role: "assistant", contentType: "text", text }); return id; };
    let state = createInitialState();
    const refresh = () => {
        const t = core.processTurn({ messages: H, state, config, tokenCount: 9000, renderTags: "text-only" });
        state = t.state;
        return state.messageRefs.byRaw;
    };
    // Block ids are kernel-minted (b1, b2, ...) in creation order — capture them: the
    // checkpoint carriers must declare summaryOfBlockId against the REAL id to count as live.
    const fold = (a: string, z: string, label: string): { result: ReturnType<typeof core.applyCompression>["result"]; blockId: string } => {
        const refs = refresh();
        const before = state.blocks.length;
        const r = core.applyCompression({ messages: H, state, config, ranges: [{ startRef: refs[a], endRef: refs[z], summary: `${label} SUMMARY `.repeat(40) }] });
        state = r.state;
        assert.equal(state.blocks.length, before + 1, `fold ${label} must create exactly one block`);
        return { result: r.result, blockId: state.blocks[before]!.blockId };
    };
    refresh();
    pushU("FIRST USER ".repeat(40)); // m1
    pushA("S0a ".repeat(200)); pushA("S0b ".repeat(200)); pushA("S0c ".repeat(200)); // m2..m4
    pushU("continue stage 0"); // m5
    pushA("w6 ".repeat(200)); // m6
    const A = pushU("CHECKPOINT A: stage 0 complete; decisions recorded; proceed to stage 1 as agreed. ".repeat(6)); // m7 (~500 chars — below the merge gate alone)
    const head = fold("msg-1", "msg-6", "HEAD"); // covers m1..m6 (anchor idx 0)
    (H.find((m) => m.id === A) as CoreMessage).summaryOfBlockId = head.blockId;
    for (let i = 0; i < 9; i++) pushA(`S1 ${i} `.repeat(200)); // m8..m16
    const B = pushU("CHECKPOINT B: stage 1 complete; remaining tasks listed; proceed to stage 2 with the agreed plan. ".repeat(18)); // m17 (~1500 chars)
    (H.find((m) => m.id === B) as CoreMessage).summaryOfBlockId = head.blockId;
    for (let i = 0; i < 4; i++) pushA(`S1t ${i} `.repeat(200)); // m18..m21
    const M22 = pushU("follow-up: confirm stage 1 outputs landed and stage 2 inputs are ready before proceeding further ".repeat(24)); // m22 (~2300 chars)
    (H.find((m) => m.id === M22) as CoreMessage).summaryOfBlockId = head.blockId;
    const mid = fold("msg-8", "msg-21", "MID"); // carriers A,B,M22 excluded from coverage
    for (let i = 0; i < 14; i++) pushA(`S2 ${i} `.repeat(200)); // m23..m36
    const M37 = pushU("keep going with stage 2"); // m37
    (H.find((m) => m.id === M37) as CoreMessage).summaryOfBlockId = head.blockId;
    fold("msg-23", "msg-36", "TAILBLOCK");
    const bHead = state.blocks.find((b) => b.blockId === head.blockId)!;
    assert.equal(bHead.effectiveMessageIds.length, 6, "geometry precondition: head block covers the whole head");
    const bMid = state.blocks.find((b) => b.blockId === mid.blockId)!;
    assert.ok(bMid.active && !bMid.effectiveMessageIds.includes(A) && !bMid.effectiveMessageIds.includes(B) && !bMid.effectiveMessageIds.includes(M22), "geometry precondition: mid block must exclude its live carriers");
    assert.ok(mid.result.warnings.some((w) => w.includes("checkpoint")), "setup must show the carrier exclusion");
    return { core, config, H, state };
}

function makeSession(state: Awaited<ReturnType<typeof buildDeadSpanFixture>>["state"]): Session {
    return {
        id: "dead-range-preflight", meta: {}, metadata: {}, state,
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        createdAt: Date.now(), lastSeen: Date.now(), blockContents: new Map(), inFlight: 0, persisted: false, pendingRetrievals: [],
    } as unknown as Session;
}

test("#2638 a structurally-dead span is preview-rejected once, remembered, and never re-nominated", async () => {
    const { core, config, H, state } = await buildDeadSpanFixture();
    const session = makeSession(state);
    const summaries: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: { content: string }[] };
            summaries.push(body.input[0].content);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ output_text: SUMMARY }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as { port: number }).port;
    try {
        // Target sits between the post-tail-fold payload (~1.8K tok) and the pre-fold
        // payload (~2.1K tok) so each invocation's walk fires once and exits after folding.
        const runPreflight = async (logs: string[], cfg = config) => preflightCompress({ core, session, config: cfg, prompts: defaultPrompts, protocol: "responses", url: `http://127.0.0.1:${port}`, headers: {}, model: "test", unknownBaseline: false, compressionTarget: 2000, log: (_level, message) => logs.push(message) }, H);
        // Turn 1: the dead span is nominated, previewed, rejected ONCE, remembered; the
        // foldable tail still folds. Without the memory the same span is re-previewed in
        // later rounds of this very invocation ("nominated twice within one request").
        H.push({ id: `msg-${H.length + 1}`, role: "user", contentType: "text", text: "NEW TURN 1 ".repeat(60) });
        H.push({ id: `msg-${H.length + 1}`, role: "assistant", contentType: "text", text: "REPLY 1 ".repeat(60) });
        const logs1: string[] = [];
        const r1 = await runPreflight(logs1);
        const rejects1 = logs1.filter((l) => l.includes("preview rejected") && l.includes("no new compressible messages"));
        assert.equal(rejects1.length, 1, `expected exactly one structural rejection in invocation 1, got: ${logs1.join("\n")}`);
        const rejectsKey = /preview rejected range (m\d+:m\d+)/.exec(rejects1[0])?.[1];
        assert.equal(rejectsKey, "m00007:m00022", `the dead span is the carrier cluster A..M22, got: ${logs1.join("\n")}`);
        assert.ok(r1.hadFoldableCandidates, "the tail was foldable");
        assert.ok(r1.compressedRanges >= 1, "viable tail must still fold");
        const stored = session.metadata!.preflightDeadRanges as Array<{ key: string; blocks: string[] }>;
        assert.ok(stored.some((e) => e.key === "m00007:m00022"), "the dead span must be remembered on the session");
        assert.ok(stored.some((e) => e.key === "m00007:m00022" && e.blocks.includes("b2")), "the named nested block (b2) must be captured for diagnostics");
        // Turn 2: full-log host resends everything plus a fresh pair. The dead span must NOT
        // be re-nominated at all (no second rejection, no wasted preview), the new tail folds.
        H.push({ id: `msg-${H.length + 1}`, role: "user", contentType: "text", text: "NEW TURN 2 ".repeat(60) });
        H.push({ id: `msg-${H.length + 1}`, role: "assistant", contentType: "text", text: "REPLY 2 ".repeat(60) });
        const logs2: string[] = [];
        const r2 = await runPreflight(logs2);
        const rejects2 = logs2.filter((l) => l.includes("preview rejected") && l.includes("no new compressible messages"));
        assert.equal(rejects2.length, 0, `dead span must not be re-nominated in invocation 2, got: ${logs2.join("\n")}`);
        assert.ok(r2.compressedRanges >= 1, "fresh tail must still fold on invocation 2");
        assert.ok(r2.hadFoldableCandidates);
        // Carrier text must NEVER reach the summarizer through any plain-ref range.
        assert.ok(summaries.every((c) => !c.includes("CHECKPOINT A") && !c.includes("CHECKPOINT B")), "live checkpoint carriers must never be resummarized");
        // Steady state: raise minCompressRange above the (small) fresh tail but below the
        // (large) dead span — every above-min candidate is remembered-dead, so the walk must
        // find NOTHING foldable and report it as such (this is what keeps the auto-fold
        // backoff from arming in lean steady state).
        H.push({ id: `msg-${H.length + 1}`, role: "user", contentType: "text", text: "NEW TURN 3 ".repeat(60) });
        H.push({ id: `msg-${H.length + 1}`, role: "assistant", contentType: "text", text: "REPLY 3 ".repeat(60) });
        const cfg3 = structuredClone(config);
        cfg3.compress.minCompressRange = 4000; // below the dead span (4566 chars), above the fresh tail (~1140 chars)
        const logs3: string[] = [];
        const r3 = await runPreflight(logs3, cfg3);
        assert.equal(r3.compressedRanges, 0, "nothing foldable remains");
        assert.equal(r3.hadFoldableCandidates, false, `steady state must report no foldable candidates, got: ${JSON.stringify(r3)}\n${logs3.join("\n")}`);
        assert.ok(logs3.some((l) => l.includes("previously-dead structural verdicts")), "the suppression must leave a diagnosable trace");
    } finally {
        const closed = once(upstream, "close");
        upstream.close();
        upstream.closeAllConnections();
        await closed;
    }
});
