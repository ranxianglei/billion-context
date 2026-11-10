import { test } from "node:test";
import assert from "node:assert/strict";
import { createContentStore, parseStoredPlaceholder, refToIndex, retrieveByRef, RETRIEVE_TOOL_NAME, type CoreMessage } from "acp-kernel";
import { foldSummariesToCcr, syntheticSummaryRef } from "../src/fold-summary-ccr.js";

// #6111 POC (from #6025): proxy-mode fold summaries rendered as CCR placeholders
// on the outbound view. The transform lives in src/fold-summary-ccr.ts; these
// tests pin the MECHANISM (the behavioral A/B/C metrics — misread rate, retrieve
// call count/size, cache delta — are measured against real weak models in the
// experiment, not here).

function summaryMsg(blockId: string, text: string): CoreMessage {
    return { id: `acp_summary_${blockId}`, role: "system", contentType: "text", text };
}
function userMsg(id: string, text: string): CoreMessage {
    return { id, role: "user", contentType: "text", text };
}

test("syntheticSummaryRef is deterministic, canonical m-form, and in the reserved band", () => {
    const r = syntheticSummaryRef("b1");
    assert.equal(r, syntheticSummaryRef("b1"), "stable across calls");
    assert.match(r, /^m[1-9]\d{5,6}$/, "canonical mNNNNN form");
    const idx = refToIndex(r)!;
    assert.ok(idx >= 5_000_000 && idx <= 9_999_998, `band violation: ${r}`);
    // distinct blockIds map to distinct refs (spot check — no collision here)
    const seen = new Set<string>();
    for (const bid of ["b1", "b2", "b3", "blk-abc", "x"]) {
        seen.add(syntheticSummaryRef(bid));
    }
    assert.equal(seen.size, 5, "spot-checked blockIds must not collide");
});

test("replaces rendered summaries with placeholders; non-summaries pass through unchanged (same ref)", () => {
    const store = createContentStore();
    const summary = summaryMsg("b1", "[Compressed conversation section]\nUser asked for research; sub-agent returned findings.");
    const normal = userMsg("raw_9", "what is the capital of France?");
    const out = foldSummariesToCcr([summary, normal], store, RETRIEVE_TOOL_NAME, 96);

    // only the summary was replaced; the normal message is the SAME object
    assert.equal(out.replaced, 1);
    assert.equal(out.messages[1], normal, "non-summary must pass through by reference");

    const ph = out.messages[0]!;
    assert.equal(ph.id, summary.id, "id preserved");
    assert.equal(ph.role, "system", "role preserved (systemToUser re-voices it)");
    assert.equal(ph.contentType, "text", "contentType preserved");
    assert.notEqual(ph.text, summary.text, "prose replaced");
    assert.ok(ph.text!.startsWith("📦 [acp-stored #"), `placeholder shape:\n${ph.text}`);
});

test("placeholder is a canonical CCR placeholder whose ref matches the synthetic ref", () => {
    const store = createContentStore();
    const summary = summaryMsg("b7", "summary prose body");
    const out = foldSummariesToCcr([summary], store, RETRIEVE_TOOL_NAME, 96);
    const parsed = parseStoredPlaceholder(out.messages[0]!.text!);
    assert.ok(parsed, "placeholder must parse as canonical CCR placeholder");
    assert.equal(parsed!.ref, syntheticSummaryRef("b7"));
    assert.equal(parsed!.kind, "compressed history");
    assert.equal(parsed!.retrieveToolName, RETRIEVE_TOOL_NAME);
});

test("retrieve round-trips the exact stored prose under the synthetic ref", () => {
    const store = createContentStore();
    const prose = "[Compressed conversation section]\nThe user asked for X over many turns.\n\nKey decisions: chose A over B because Z.";
    const out = foldSummariesToCcr([summaryMsg("b42", prose)], store, RETRIEVE_TOOL_NAME, 96);
    const ref = syntheticSummaryRef("b42");
    const res = retrieveByRef(out.store, ref);
    assert.equal(res.ok, true, "stored ref must be retrievable");
    assert.equal(res.text, prose, "retrieved bytes must equal the original prose verbatim");
    assert.equal(res.entry.kind, "compressed history");
});

test("byte-stable across repeated passes — second pass reads back the stored entry", () => {
    const store = createContentStore();
    const summary = summaryMsg("b9", "A fairly long summary body that repeats turn after turn so the placeholder stays byte-identical for the prefix cache.");
    const first = foldSummariesToCcr([summary], store, RETRIEVE_TOOL_NAME, 96);
    const ref = syntheticSummaryRef("b9");
    // simulate the NEXT turn: a fresh egress view re-renders the same summary;
    // the store already holds the entry → placeholder must be byte-identical.
    const nextTurnView = [summaryMsg("b9", summary.text!)];
    const second = foldSummariesToCcr(nextTurnView, first.store, RETRIEVE_TOOL_NAME, 96);
    assert.equal(second.messages[0]!.text, first.messages[0]!.text, "placeholder must be byte-stable across turns");
    assert.equal(second.replaced, 1);
    // store grew exactly once (first-write-wins — no duplicate entry)
    assert.equal(Object.keys(second.store.byRef).length, 1);
    assert.ok(Object.keys(second.store.byRef).includes(ref));
});

test("empty-text summary is left untouched and counts as unreplaced", () => {
    const store = createContentStore();
    const empty = summaryMsg("bEmpty", "");
    const out = foldSummariesToCcr([empty], store, RETRIEVE_TOOL_NAME, 96);
    assert.equal(out.replaced, 0);
    assert.equal(out.messages[0], empty, "empty summary passes through by reference");
    assert.deepEqual(out.store.byRef, {}, "nothing stored");
});
