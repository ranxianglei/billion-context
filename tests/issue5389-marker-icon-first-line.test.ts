// #5389: the confirmation-marker icon used to be chosen by scanning the tool
// receipt TEXT for FAILED / "not found" / "is required" — originally EVERY
// line, so a SUCCESS receipt whose embedded model-authored content (the
// compress summary fingerprint excerpt, decompress's restored history, search
// evidence snippets, status-report block topics) merely mentioned a keyword
// rendered as ❌ while its text said "Compressed …".
// The judgment is now PROTOCOLIZED: the executor's structured outcome
// (#1875 ProxyToolResult.outcome) is authoritative — failure/refused → ❌,
// applied/partial/success → the tool icon — threaded through every marker
// call site (loop/core.ts streaming + re-request paths, all five wire
// adapters' emitMarker, the responses lane). Receipt text is scanned ONLY as
// a fallback when outcome is absent (first non-empty line only — no executor
// today omits it; the fallback guards a future executor that forgets to set
// it). Text scanning could never see two whole classes: keyword-less failure
// wordings (pre-fix acp_read_original_image) and the "[Compression REFUSED:
// …]" refusal whose text contains no "FAILED".
// Mirror defect fixed in the same PR: acp_read_original_image failure receipts
// carried no keyword at all → failures rendered 📦; they now follow the
// [tool FAILED: …] convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { createSession } from "../src/session.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { buildVisibilityMarker } from "../src/loop/core.ts";
import { executeReadOriginalImage } from "../src/image-rescale.ts";
import { stripAcpStatusMarkers } from "../src/acp-panel.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void };

function makeCtx(): Ctx {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: `i5389-${Math.random().toString(36).slice(2)}`,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: () => {},
    };
}

/** Deterministic compressible seed: small head turns + recent tail, protection
 *  disabled so m00001–m00004 is always foldable (same pattern as
 *  tests/compress-fingerprint-refold.test.ts). */
function seedTurn(ctx: Ctx): void {
    const turns: Array<[string, string]> = [
        ["user", "A historical exchange covering setup steps."],
        ["assistant", "x".repeat(3000)],
        ["user", "Follow-up questions about the configuration."],
        ["assistant", "y".repeat(3000)],
        ...Array.from({ length: 5 }, (_, i): [string, string] => [i % 2 === 0 ? "user" : "assistant", `recent ${i}`]),
    ];
    const msgs: CoreMessage[] = turns.map(([role, text], i) => ({ id: `raw${i}`, role: role as "user" | "assistant", contentType: "text", text }));
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    ctx.config.compress.minSummaryLength = 0;
}

test("#5389: successful compress whose summary mentions FAILED renders 📦, not ❌", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx);
    const res = applyRanges(
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "The deploy FAILED on first attempt; retried after fixing the environment variables and it went green." }] }),
        ctx,
    );
    const out = res.text;
    assert.equal(res.outcome, "applied");
    assert.ok(out.startsWith("[Compressed m00001–m00004 → 1 block(s)"), `success receipt expected, got: ${out.split("\n")[0]}`);
    // Teeth: the keyword really does sit in a NON-FIRST line of this receipt
    // (the summary fingerprint excerpt), which is exactly what the old
    // all-lines scan misread as a failure.
    const lines = out.split("\n");
    assert.ok(lines.slice(1).some((l) => l.includes("FAILED")), "keyword present in an embedded non-first line (test would be toothless otherwise)");
    // The loop now judges from the structured outcome (protocolized, #5389).
    const marker = buildVisibilityMarker("compress", out, res.outcome);
    assert.ok(marker.includes("📦 [ACP] Compressed"), `success icon expected, got: ${JSON.stringify(marker.split("\n").find((l) => l.includes("[ACP]")))}`);
    assert.ok(!marker.includes("❌"), "no failure icon on a success receipt");
});

test("#5389: structured outcome is authoritative — text is never consulted when present (both directions)", () => {
    // outcome says success → tool icon even though the text carries a keyword
    // on line 1 (defensive: a success-shaped receipt must never flip on its
    // own words).
    const okText = "[Compressed m00001–m00004 → 1 block(s), ~120 tokens saved.]";
    const okMarker = buildVisibilityMarker("compress", okText, "success");
    assert.ok(okMarker.includes("📦 [ACP] Compressed"), okMarker);
    assert.ok(!okMarker.includes("❌"));

    // outcome says failure → ❌ even when NO keyword appears anywhere in the
    // text — the class of keyword-less failure wordings no text scan could
    // ever catch.
    const failClean = "Original image for m00001 could not be restored from local storage.";
    assert.ok(buildVisibilityMarker("acp_read_original_image", failClean, "failure").includes("❌ [ACP]"));

    // refused → ❌ — including the "[Compression REFUSED: …]" refusal whose
    // wording contains no "FAILED" at all (a gap EVERY text-scan scheme had).
    const refused = "[Compression REFUSED: the refs in this call no longer identify the same messages and folding them would compress the wrong span. Re-issue the compress call with the updated labels.]";
    assert.ok(buildVisibilityMarker("compress", refused, "refused").includes("❌ [ACP]"));
    // …and WITHOUT the outcome the same text still reads as success — proof
    // the protocolized judgment closes a hole the text scan cannot.
    const refusedNoOutcome = buildVisibilityMarker("compress", refused);
    assert.ok(refusedNoOutcome.includes("📦 [ACP] Compression"), refusedNoOutcome);
    assert.ok(!refusedNoOutcome.includes("❌"));

    // partial fold: success-shaped leading line → tool icon, not ❌.
    const partial = "[Compressed m00001–m00004 → 1 block(s), ~120 tokens saved.]\n[1 of the submitted entries was REJECTED and NOT compressed: entry 1 missing endId]";
    const partialMarker = buildVisibilityMarker("compress", partial, "partial");
    assert.ok(partialMarker.includes("📦 [ACP] Compressed"), partialMarker);
    assert.ok(!partialMarker.includes("❌"));
});

test("#5389: success receipts with keywords in embedded content keep their tool icon (unit, fallback path without outcome)", () => {
    // decompress success embeds restored history — "not found" in the body is normal prose.
    const dec = buildVisibilityMarker("decompress", "[Block b1 content — 2 item(s)]\nuser: earlier probe reported 'not found' for the missing key\nassistant: we worked around it then");
    assert.ok(dec.includes("📤 [ACP] Block b1 content"), dec);
    assert.ok(!dec.includes("❌"), "embedded 'not found' must not flip the icon");

    // search_context hits embed evidence excerpts — "is required" in a snippet is normal.
    const srch = buildVisibilityMarker("search_context", 'Found 2 block(s) for "auth":\n\n[b2] user: the API docs say the token is required\n[b3] assistant: added it to the header');
    assert.ok(srch.includes("🔍 [ACP] Found 2 block(s)"), srch);
    assert.ok(!srch.includes("❌"), "evidence excerpt must not flip the icon");

    // acp_status reports embed block topics — a topic mentioning FAILED is normal.
    const rep = 'ACTIVE SURFACE: pack=default | host=billion-context 0.1.999 (abc1234)\n\nCOMPRESSED BLOCKS — 2 active\n\n  b1 (T1)  474.4K→169  3 msgs  "why the deploy FAILED"\n  b2 (T1)  400.0K→150  5 msgs  "exploration"';
    const st = buildVisibilityMarker("acp_status", rep);
    assert.ok(st.includes("📊 [ACP] acp_status result:"), st);
    assert.ok(!st.includes("❌"), "report body topic must not flip the icon");
});

test("#5389: real failures still render ❌ (negative direction — keywords live on line 1)", () => {
    const cases: Array<[string, string]> = [
        ["compress", "[Compression FAILED: no valid ranges parsed (kind=no-valid-ranges, dropped=2).]"],
        ["decompress", "[Block b7 not found]"],
        ["decompress", "[decompress FAILED: block b7 has no stored content]"],
        ["search_context", "[search_context FAILED: query is required]"],
        ["absorb", "[absorb FAILED: no absorbable content]"],
        // exception path shape built by src/compress-loop-responses.ts (single line, ❌-prefixed)
        ["compress", "❌ [ACP] compress FAILED: RangeError: invalid range spec"],
    ];
    for (const [name, result] of cases) {
        const marker = buildVisibilityMarker(name, result);
        assert.ok(marker.includes("❌ [ACP]"), `${name} failure must keep the ❌ icon, got: ${JSON.stringify(marker)}`);
    }
});

test("#5389 mirror: acp_read_original_image failures carry the FAILED convention and render ❌", async () => {
    const session: Session = createSession("i5389-img");
    const log = () => {};
    const bad = await executeReadOriginalImage({ ref: "not-a-ref" }, session, log);
    assert.equal(bad.outcome, "failure");
    assert.match(bad.text, /^\[acp_read_original_image FAILED: invalid ref "not-a-ref"/);
    assert.match(bad.text, /pass the mNNNNN message ref/, "actionable guidance preserved");
    assert.ok(buildVisibilityMarker("acp_read_original_image", bad.text, bad.outcome).includes("❌ [ACP]"));

    const missing = await executeReadOriginalImage({ ref: "m99999" }, session, log);
    assert.equal(missing.outcome, "failure");
    assert.match(missing.text, /^\[acp_read_original_image FAILED: no original image stored for m99999/);
    assert.match(missing.text, /Work from the downscaled version you already have\./, "actionable guidance preserved");
    assert.ok(buildVisibilityMarker("acp_read_original_image", missing.text, missing.outcome).includes("❌ [ACP]"));
});

test("#5389: partial fold renders 📦 even when the embedded lines mention a keyword (old all-lines scan red)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx);
    // One valid entry + one rejected entry (missing endId) → the valid range
    // folds, the rest ride as a dropped-entries note after the success line.
    const res = applyRanges(
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "The deploy FAILED on first attempt; environment variables fixed." }, { startId: "m00003" }] }),
        ctx,
    );
    assert.equal(res.outcome, "partial", "one applied entry + one rejected entry is a partial fold");
    const lines = res.text.split("\n");
    assert.ok(lines[0].startsWith("[Compressed m00001–m00004 → 1 block(s)"), `success-shaped leading line expected, got: ${lines[0]}`);
    assert.ok(lines.slice(1).some((l) => l.includes("FAILED")), "keyword in an embedded non-first line (teeth against the old all-lines scan)");
    const marker = buildVisibilityMarker("compress", res.text, res.outcome);
    assert.ok(marker.includes("📦 [ACP] Compressed"), marker);
    assert.ok(!marker.includes("❌"), "a partial fold is not a failure");
});

test("#5389: idempotent no-op re-compress keeps the success icon (#4521 contract pin)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx);
    const first = applyRanges(
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "Initial fold of the setup exchange." }] }),
        ctx,
    );
    assert.equal(first.outcome, "applied");
    const again = applyRanges(
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "Re-fold attempt over the same range." }] }),
        ctx,
    );
    assert.equal(again.outcome, "applied", "the no-op class reports applied with zero blocks (#4521)");
    assert.ok(again.text.startsWith("[Compression no-op:"), `no-op receipt expected, got: ${again.text.split("\n")[0]}`);
    const marker = buildVisibilityMarker("compress", again.text, again.outcome);
    assert.ok(marker.includes("📦 [ACP] Compression no-op"), marker);
    assert.ok(!marker.includes("❌"), "a no-op folded nothing but failed nothing either");
});

test("#5389: incoming strip is icon-agnostic — success and failure markers both removed by shape", () => {
    const good = "\n📦 [ACP] Compressed m00001–m00004 → 1 block(s), ~120 tokens saved.\n";
    const bad = "\n❌ [ACP] Compression FAILED: no valid ranges parsed.\n";
    const msgs: unknown[] = [
        { role: "assistant", content: `intro${good}tail keeps` },
        { role: "assistant", content: `intro${bad}tail keeps` },
    ];
    const n = stripAcpStatusMarkers(msgs);
    assert.equal(n, 2, "both markers stripped regardless of icon");
    // marker-line semantics (#1029): the marker line itself goes, the newline
    // before it stays
    assert.equal((msgs[0] as { content: string }).content, "intro\ntail keeps");
    assert.equal((msgs[1] as { content: string }).content, "intro\ntail keeps");
});
