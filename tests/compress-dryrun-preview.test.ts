// #3185: dryRun preview mode — the model validates a range and reads the
// savings/exclusion report BEFORE committing; the preview must be side-effect
// free and the subsequent real call must behave exactly as without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { parseCompressInput, BILI_ACP_TOOLS_OPENAI, COMPRESS_TOOL_OPENAI_DRYRUN, withDryRunCompress, buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";

// This file exercises the ON path end-to-end (the switch defaults OFF); the
// default-OFF behavior is asserted explicitly in the final switch test below,
// which clears the env override there.
process.env.BILI_COMPRESS_DRYRUN = "1";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages: MESSAGES,
        session: {
            id: "dryrun-preview-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 , retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

/** refs m00001..m00080, one per message */
function seedRefs(ctx: Ctx): void {
    ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
}

test("#3185: object input (anthropic shape) — structured report, zero side effects", () => {
    const ctx = makeCtx();
    seedRefs(ctx);
    const parsed = parseCompressInput({ content: [{ startId: "m00001", endId: "m00030" }], dryRun: true });
    assert.equal(parsed.dryRun, true, "host boundary surfaces the flag");
    assert.equal(parsed.ranges.length, 1, "summary-less entry accepted under dryRun");
    assert.equal(parsed.ranges[0].summary, "");

    const before = JSON.stringify(ctx.session.state);
    const res = applyRanges(parsed, ctx);
    assert.equal(res.outcome, "success");
    assert.ok(res.text.startsWith("[Compress dry-run"), `report header, got: ${res.text.slice(0, 80)}`);
    assert.ok(!res.text.includes("FAILED"), "preview of a valid range is not a failure");
    assert.ok(res.text.includes("would fold m00001"), `fold list, got: ${res.text}`);
    assert.ok(res.text.includes("tokens saved"), `savings estimate, got: ${res.text}`);
    assert.ok(res.text.includes("Re-issue the same call WITHOUT dryRun"), "commit hint present");

    // Purity: state byte-identical, no block, no ref re-issuance.
    assert.equal(JSON.stringify(ctx.session.state), before, "state untouched");
    assert.equal(ctx.session.state.blocks.length, 0, "no block created");
    assert.equal(Object.keys(ctx.session.state.messageRefs.byRef).length, 80, "ref space unchanged");
});

test("#3185: stringified-JSON input (openai chat / responses shapes) — same report", () => {
    const ctx = makeCtx();
    seedRefs(ctx);
    const raw = JSON.stringify({ content: [{ startId: "m00040", endId: "m00060" }], dryRun: true });
    const parsed = parseCompressInput(raw);
    assert.equal(parsed.dryRun, true, "flag detected inside the gateway-stringified args");
    const res = applyRanges(parsed, ctx);
    assert.equal(res.outcome, "success");
    assert.ok(res.text.startsWith("[Compress dry-run"), `got: ${res.text.slice(0, 80)}`);
    assert.ok(res.text.includes("would fold m00040"), `fold list, got: ${res.text}`);
    assert.equal(ctx.session.state.blocks.length, 0);
});

test("#3185: line-form entry with the flag — header-only summary accepted", () => {
    const parsed = parseCompressInput(JSON.stringify({ content: ["m00005-m00015"], dryRun: true }));
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.ranges.length, 1, "header-only line accepted under dryRun");
    assert.equal(parsed.ranges[0].startRef, "m00005");
    assert.equal(parsed.ranges[0].endRef, "m00015");
});

test("#3185: WITHOUT dryRun a missing summary is still rejected (real path unchanged)", () => {
    const parsed = parseCompressInput({ content: [{ startId: "m00001", endId: "m00030" }] });
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.ranges.length, 0, "summary-less entry dropped without the flag");
    assert.equal(parsed.diagnostics.invalidItems, 1);
});

test("#3185: fully-protected range previews its exact would-fail error, still pure", () => {
    const ctx = makeCtx();
    seedRefs(ctx);
    // The protected zone (last 5 msgs) cannot reach the 5000-char min-range
    // gate at these fixture sizes — lower it so the per-range protected-zone
    // error is what the preview surfaces.
    ctx.config.compress.minCompressRange = 1;
    const before = JSON.stringify(ctx.session.state);
    const parsed = parseCompressInput({ content: [{ startId: "m00076", endId: "m00080" }], dryRun: true });
    const res = applyRanges(parsed, ctx);
    assert.equal(res.outcome, "success", "the preview call itself succeeds");
    assert.ok(res.text.includes("WOULD FAIL"), `would-fail marker, got: ${res.text}`);
    assert.ok(res.text.includes("protected zone"), `exact kernel error surfaced, got: ${res.text}`);
    assert.equal(JSON.stringify(ctx.session.state), before, "state untouched even for failing previews");
    assert.equal(ctx.session.state.blocks.length, 0);
});

test("#3185: repeated previews are idempotent (identical receipts)", () => {
    const ctx = makeCtx();
    seedRefs(ctx);
    const first = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00030" }], dryRun: true }), ctx);
    const second = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00030" }], dryRun: true }), ctx);
    assert.equal(second.text, first.text, "second preview byte-identical");
});

test("#3185: real compress after a preview behaves exactly like without one", () => {
    const control = makeCtx();
    seedRefs(control);
    const previewed = makeCtx();
    seedRefs(previewed);
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00030" }], dryRun: true }), previewed);

    const realInput = () => parseCompressInput({ content: [{ startId: "m00001", endId: "m00030", summary: "y".repeat(100) }] });
    const rPreviewd = applyRanges(realInput(), previewed);
    const rControl = applyRanges(realInput(), control);

    assert.equal(rPreviewd.outcome, "applied");
    assert.equal(rControl.outcome, "applied");
    assert.equal(rPreviewd.blocksCreated, 1);
    assert.equal(rControl.blocksCreated, 1);
    const bA = previewed.session.state.blocks[0];
    const bB = control.session.state.blocks[0];
    assert.deepEqual([...bA.effectiveMessageIds].sort(), [...bB.effectiveMessageIds].sort(), "same messages folded");
    assert.equal(bA.compressedTokens, bB.compressedTokens, "same token math");
    assert.deepEqual(previewed.session.state.messageRefs.byRef, control.session.state.messageRefs.byRef, "same ref space");
});

test("#3193 review: malformed dryRun (no valid ranges) reports PREVIEW FAILED and never arms failure tracking", () => {
    const ctx = makeCtx();
    seedRefs(ctx);
    // Two shapes that parse to ZERO valid ranges while carrying the flag:
    // a bare flag (missing content) and a non-object content entry.
    const shapes = [() => parseCompressInput({ dryRun: true }), () => parseCompressInput({ dryRun: true, content: [42] })];
    // Three repeats of one spec would trip the loop breaker on a real path (threshold 3).
    for (let i = 0; i < 3; i++) {
        for (const make of shapes) {
            const res = applyRanges(make(), ctx);
            assert.equal(res.outcome, "refused");
            assert.ok(res.text.includes("PREVIEW FAILED"), `preview-failed marker, got: ${res.text.slice(0, 120)}`);
            assert.ok(!res.text.includes("Repeat-failure guard"), "no repeat-guard text on a preview");
            assert.ok(!res.text.includes("COMPRESS CIRCUIT BREAKER"), "loop breaker must not arm from previews");
            assert.equal(ctx.session.metadata["compressFailKeys"], undefined, `fail-streak key must stay unset (round ${i + 1})`);
            assert.equal(ctx.session.metadata["compressFailStreak"], undefined, `loop streak must stay unset (round ${i + 1})`);
        }
    }
});

test("#3185 switch: served schema + prompt toggle with the knob (one gate serves every pack)", () => {
    const saved = process.env.BILI_COMPRESS_DRYRUN;
    try {
        delete process.env.BILI_COMPRESS_DRYRUN;
        const off = withDryRunCompress(BILI_ACP_TOOLS_OPENAI, COMPRESS_TOOL_OPENAI_DRYRUN);
        assert.deepEqual(off, BILI_ACP_TOOLS_OPENAI, "off -> base array served untouched");
        const compOff = off.find((t) => t.function.name === "compress")!;
        assert.ok(!("dryRun" in (compOff.function.parameters.properties ?? {})), "off -> no dryRun field in schema");
        assert.ok(!buildCompressSystemPrompt().includes("dryRun"), "off -> no strategy sentence in prompt");

        process.env.BILI_COMPRESS_DRYRUN = "1";
        const on = withDryRunCompress(BILI_ACP_TOOLS_OPENAI, COMPRESS_TOOL_OPENAI_DRYRUN);
        const compOn = on.find((t) => t.function.name === "compress")!;
        assert.ok("dryRun" in (compOn.function.parameters.properties ?? {}), "on -> dryRun field served");
        assert.ok(buildCompressSystemPrompt().includes("preview the whole batch first with dryRun:true"), "on -> strategy sentence present");
    } finally {
        if (saved === undefined) delete process.env.BILI_COMPRESS_DRYRUN;
        else process.env.BILI_COMPRESS_DRYRUN = saved;
    }
});

test("#3185 switch OFF: a dryRun:true call is ignored and summary-less previews are rejected (commit path unchanged)", () => {
    const saved = process.env.BILI_COMPRESS_DRYRUN;
    try {
        delete process.env.BILI_COMPRESS_DRYRUN;
        const parsed = parseCompressInput({ content: [{ startId: "m00001", endId: "m00030" }], dryRun: true });
        assert.equal(parsed.dryRun, false, "flag dropped when the switch is off");
        assert.equal(parsed.ranges.length, 0, "summary-less entry rejected as on the commit path");
        assert.equal(parsed.diagnostics.invalidItems, 1);
    } finally {
        if (saved === undefined) delete process.env.BILI_COMPRESS_DRYRUN;
        else process.env.BILI_COMPRESS_DRYRUN = saved;
    }
});
