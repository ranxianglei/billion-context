import { test } from "node:test";
import assert from "node:assert/strict";
import { createContentStore, parseStoredPlaceholder, refToIndex, retrieveByRef, RETRIEVE_TOOL_NAME, type CoreMessage } from "acp-kernel";
import { applyFoldSummaryCcr, extractFoldAnchors, foldSummariesToCcr, readFoldSummaryIndex, syntheticSummaryRef } from "../src/fold-summary-ccr.js";
import { getSession } from "../src/session.js";
import { contentStoreOf, executeRetrieve, storeEffectiveCcr } from "../src/store.js";

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

// --- seam gate (applyFoldSummaryCcr): both directions, per gate discipline #3617 ---

const GATE_ENV = "BILI_ROLLOUT_FOLD_SUMMARY_CCR_PLACEHOLDER";

function withGateEnv(value: string | undefined, fn: () => void): void {
    const prev = process.env[GATE_ENV];
    if (value === undefined) delete process.env[GATE_ENV];
    else process.env[GATE_ENV] = value;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env[GATE_ENV];
        else process.env[GATE_ENV] = prev;
    }
}

test("gate: feature OFF + ccr ON → summary stays inline prose (no placeholder)", () => {
    const session = getSession(`t-fsc-gate-off-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    const summary = summaryMsg("g-off", "[Compressed conversation section]\nSome summary prose.");
    withGateEnv("0", () => {
        const out = applyFoldSummaryCcr([summary], session);
        assert.equal(out.applied, false, "must not apply when the feature is off");
        assert.equal(out.messages[0], summary, "prose untouched (same ref) when feature off");
    });
});

test("gate: feature ON + ccr OFF → summary stays inline prose (no placeholder)", () => {
    const session = getSession(`t-fsc-gate-noccr-${Math.random().toString(36).slice(2)}`);
    const summary = summaryMsg("g-noccr", "[Compressed conversation section]\nSome summary prose.");
    withGateEnv("1", () => {
        const out = applyFoldSummaryCcr([summary], session);
        assert.equal(out.applied, false, "must not apply when CCR is not armed");
        assert.equal(out.messages[0], summary, "prose untouched when ccr not armed");
    });
});

test("gate: feature ON + ccr ON → summary becomes a retrievable placeholder", () => {
    const session = getSession(`t-fsc-gate-on-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    const prose = "[Compressed conversation section]\nUser asked for X; chose A over B because Z.";
    const summary = summaryMsg("g-on", prose);
    withGateEnv("1", () => {
        const out = applyFoldSummaryCcr([summary], session);
        assert.equal(out.applied, true, "must apply when feature + ccr both on");
        assert.ok(out.messages[0]!.text!.startsWith("📦 [acp-stored #"), `placeholder shape:\n${out.messages[0]!.text}`);
        const res = retrieveByRef(contentStoreOf(session), syntheticSummaryRef("g-on"));
        assert.equal(res.ok, true, "stored ref must be retrievable from the session store");
        assert.equal(res.text, prose, "retrieved bytes equal the original prose");
    });
});

// --- #6111 POC hybrid: bounded head + inverted index (keyword localization) ---

test("extractFoldAnchors pulls the grep-able literals, lowercases, dedupes, drops short", () => {
    const prose = "Edited src/server/prepare-openai.ts and kernel/src/ccr.ts; build hash f089220f67ee " +
        "resolved issue #6111. Config key `k84bd` set to `f089220f67ee`. 事项「灰度窗口说明 #1-1」 noted. " +
        "The word and the token ab (too short) are dropped.";
    const anchors = extractFoldAnchors(prose);
    // backtick-quoted
    assert.ok(anchors.includes("k84bd"), "backtick key");
    assert.ok(anchors.includes("f089220f67ee"), "backtick value (also hex)");
    // 「」-quoted (CJK)
    assert.ok(anchors.includes("灰度窗口说明 #1-1"), "CJK-quoted key");
    // file paths (>=2 segments)
    assert.ok(anchors.includes("src/server/prepare-openai.ts"), "path 1");
    assert.ok(anchors.includes("kernel/src/ccr.ts"), "path 2");
    // hex-6+
    assert.ok(anchors.includes("f089220f67ee"), "hex token");
    // #issue refs
    assert.ok(anchors.includes("#6111"), "issue ref");
    // lowercased
    assert.ok(!anchors.some((a) => a !== a.toLowerCase()), "all anchors lowercased");
    // deduped (f089220f67ee appears twice in prose)
    assert.equal(anchors.filter((a) => a === "f089220f67ee").length, 1, "deduped");
    // short dropped
    assert.ok(!anchors.includes("ab"), "sub-3-char dropped");
    // deterministic
    assert.deepEqual(extractFoldAnchors(prose), anchors, "same prose → same anchors");
});

test("bounded head: fold-summary placeholder head uses the 256-char default (not the 96 tool-result default)", () => {
    const session = getSession(`t-fsc-head-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    // A prose summary with no literals (the head is its only topical signal).
    // Long enough that 96 chars is a fragment but 256 chars carries the topic.
    const prose = "[Compressed conversation section]\n" +
        "The user was debugging a flaky integration test in the storage layer. " +
        "Root cause traced to a connection pool exhaustion under load; the fix " +
        "bounded the pool and added a retry with backoff. Verified across three " +
        "consecutive runs on both the sqlite and mysql backends before closing.";
    const summary = summaryMsg("head-1", prose);
    withGateEnv("1", () => {
        const out = applyFoldSummaryCcr([summary], session);
        assert.equal(out.applied, true);
        const parsed = parseStoredPlaceholder(out.messages[0]!.text!);
        assert.ok(parsed, "placeholder must parse");
        // The head (the backtick-quoted group, parsed as `title`) is the first
        // 256 chars (bounded), NOT 96 — so it extends well past the 96-char
        // mark and carries real topical signal.
        assert.ok(parsed!.title, "placeholder must carry a head (backtick group)");
        assert.ok(parsed!.title!.length > 96, `head must exceed the 96 tool-result default (got ${parsed!.title!.length})`);
        // normalizeHead caps at maxHeadChars and appends an ellipsis on truncation,
        // so the bound is maxHeadChars + a small margin.
        assert.ok(parsed!.title!.length <= 260, `head must stay bounded near 256 (got ${parsed!.title!.length})`);
    });
});

test("index: applyFoldSummaryCcr populates session.metadata.foldSummaryIndex (anchor → synthetic ref)", () => {
    const session = getSession(`t-fsc-idx-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    const prose = "[Compressed conversation section]\nEdited src/server/prepare-openai.ts; hash f089220f67ee; key `k84bd`.";
    const summary = summaryMsg("idx-1", prose);
    withGateEnv("1", () => {
        const out = applyFoldSummaryCcr([summary], session);
        assert.equal(out.applied, true);
        const idx = readFoldSummaryIndex(session);
        const ref = syntheticSummaryRef("idx-1");
        assert.ok(idx["k84bd"]?.includes(ref), "backtick anchor maps to the synthetic ref");
        assert.ok(idx["f089220f67ee"]?.includes(ref), "hex anchor maps to the synthetic ref");
        assert.ok(idx["src/server/prepare-openai.ts"]?.includes(ref), "path anchor maps to the synthetic ref");
    });
});

test("index: idempotent across turns (re-applying the same summary does not duplicate refs)", () => {
    const session = getSession(`t-fsc-idx-idem-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    const prose = "[Compressed conversation section]\nKey `k84bd` and hash f089220f67ee discussed.";
    const summary = summaryMsg("idx-2", prose);
    withGateEnv("1", () => {
        applyFoldSummaryCcr([summary], session);
        applyFoldSummaryCcr([summaryMsg("idx-2", prose)], session); // next turn, same summary
        const idx = readFoldSummaryIndex(session);
        assert.equal(idx["k84bd"]!.length, 1, "ref listed once despite two passes");
    });
});

test("keyword search: executeRetrieve with a non-ref arg returns the matching fold block ref", () => {
    const session = getSession(`t-fsc-kw-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    const prose = "[Compressed conversation section]\nKey `k84bd` and hash f089220f67ee discussed at length.";
    withGateEnv("1", () => {
        applyFoldSummaryCcr([summaryMsg("kw-1", prose)], session);
        const ref = syntheticSummaryRef("kw-1");
        const res = executeRetrieve({ ref: "k84bd" }, session);
        assert.equal(res.outcome, "success", `keyword search must succeed:\n${res.text}`);
        assert.ok(res.text!.includes(ref), `result must name the matching ref:\n${res.text}`);
        assert.ok(res.text!.includes("k84bd"), "result echoes the keyword");
    });
});

test("keyword search: miss returns an honest not-found (no index entry for the keyword)", () => {
    const session = getSession(`t-fsc-kw-miss-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    const prose = "[Compressed conversation section]\nKey `k84bd` discussed.";
    withGateEnv("1", () => {
        applyFoldSummaryCcr([summaryMsg("kw-miss", prose)], session);
        const res = executeRetrieve({ ref: "zzz-not-an-anchor-xyz" }, session);
        assert.equal(res.outcome, "failure", "a keyword with no index entry must fail");
        assert.match(res.text!, /no compressed-history block contains/);
    });
});

test("keyword search: feature OFF → a non-ref arg is a plain miss (no index consulted)", () => {
    const session = getSession(`t-fsc-kw-off-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    // Pre-seed an index entry so we can prove the OFF path ignores it.
    session.metadata.foldSummaryIndex = { k84bd: [syntheticSummaryRef("kw-off")] };
    withGateEnv("0", () => {
        const res = executeRetrieve({ ref: "k84bd" }, session);
        assert.equal(res.outcome, "failure", "feature off → keyword search must not run");
        assert.match(res.text!, /no fold-block index is active/);
    });
});

test("keyword search: a valid mNNNNN ref still resolves by ref (no regression to the exact-ref path)", () => {
    const session = getSession(`t-fsc-kw-ref-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: RETRIEVE_TOOL_NAME, minToolTokens: 50 });
    const prose = "[Compressed conversation section]\nKey `k84bd` discussed.";
    withGateEnv("1", () => {
        applyFoldSummaryCcr([summaryMsg("kw-ref", prose)], session);
        const ref = syntheticSummaryRef("kw-ref");
        const res = executeRetrieve({ ref }, session);
        assert.equal(res.outcome, "success", `exact-ref retrieve must still work:\n${res.text}`);
        assert.ok(res.text!.includes(prose), `exact-ref retrieve must carry the full prose verbatim:\n${res.text}`);
    });
});
