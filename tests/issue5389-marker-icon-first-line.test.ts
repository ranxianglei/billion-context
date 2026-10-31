// #5389: buildVisibilityMarker used to scan EVERY line of a tool receipt for
// FAILED / "not found" / "is required" when choosing the confirmation icon, so
// a SUCCESS receipt whose embedded model-authored content (the compress summary
// fingerprint excerpt, decompress's restored history, search evidence snippets,
// status-report block topics) merely mentioned a keyword rendered as ❌ while
// its text said "Compressed …". The first non-empty line is the authoritative
// status line for every proxy tool — judge only that.
// Mirror defect fixed in the same PR: acp_read_original_image failure receipts
// carried no keyword at all → failures rendered 📦; they now follow the
// [tool FAILED: …] convention so both judgment schemes read them correctly.
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
    const out = applyRanges(
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "The deploy FAILED on first attempt; retried after fixing the environment variables and it went green." }] }),
        ctx,
    ).text;
    assert.ok(out.startsWith("[Compressed m00001–m00004 → 1 block(s)"), `success receipt expected, got: ${out.split("\n")[0]}`);
    // Teeth: the keyword really does sit in a NON-FIRST line of this receipt
    // (the summary fingerprint excerpt), which is exactly what the old
    // all-lines scan misread as a failure.
    const lines = out.split("\n");
    assert.ok(lines.slice(1).some((l) => l.includes("FAILED")), "keyword present in an embedded non-first line (test would be toothless otherwise)");
    const marker = buildVisibilityMarker("compress", out);
    assert.ok(marker.includes("📦 [ACP] Compressed"), `success icon expected, got: ${JSON.stringify(marker.split("\n").find((l) => l.includes("[ACP]")))}`);
    assert.ok(!marker.includes("❌"), "no failure icon on a success receipt");
});

test("#5389: success receipts with keywords in embedded content keep their tool icon (unit, both directions)", () => {
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
    assert.ok(buildVisibilityMarker("acp_read_original_image", bad.text).includes("❌ [ACP]"));

    const missing = await executeReadOriginalImage({ ref: "m99999" }, session, log);
    assert.equal(missing.outcome, "failure");
    assert.match(missing.text, /^\[acp_read_original_image FAILED: no original image stored for m99999/);
    assert.match(missing.text, /Work from the downscaled version you already have\./, "actionable guidance preserved");
    assert.ok(buildVisibilityMarker("acp_read_original_image", missing.text).includes("❌ [ACP]"));
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
