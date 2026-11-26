// #6855: the compress SUCCESS headline echoed the requested range even when
// the kernel clamped the endId down to the session's highest allocated ref
// (#4521 leniency). The receipt taught the model a ceiling that was never
// minted ("Compressed m03693–m03799" when only m03693–m03712 was folded);
// its next call then anchored START at requested-end+1 — above the frontier,
// which #4521 refuses by design — and was refused (observed: session
// 01a1dd94, 22:13 clamp → 22:15 m03800 refusal ×2). The success headline
// must name the effective (clamped) range; the requested number stays in the
// trailing clamped warning for correlation.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, effectiveCompressedDetail, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [] as CoreMessage[],
        session: {
            id: "issue6855-headline",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, rangeRestores: 0 },
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

function seedTurn(ctx: Ctx, turns: Array<[string, string]>): void {
    const msgs: CoreMessage[] = turns.map(([role, text], i) => ({ id: `raw${i}`, role: role as "user" | "assistant", text })) as unknown as CoreMessage[];
    ctx.messages = msgs;
    ctx.session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
}

const LONG_SUMMARY = "summary of a test compress call — decisions, artifacts, next steps recorded";

test("#6855: clamped endId → headline names the effective range, warning keeps the requested one", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    // 8 long messages: the protected zone keeps only the last 3 visible,
    // so m00001–m00005 is foldable. Highest allocated ref is m00008.
    seedTurn(ctx, Array.from({ length: 8 }, (_, i) => (i % 2 ? ["assistant", "y".repeat(6000)] : ["user", "x".repeat(6000)])) as Array<[string, string]>);
    // endId m00015 is above the highest allocated ref: the #4521 clamp folds
    // up to the last visible message and succeeds.
    const out = applyRanges(parseCompressedInputSafe("m00001", "m00015", LONG_SUMMARY), ctx).text;
    assert.ok(out.startsWith("[Compressed m00001–m00008 →"), `headline must echo the effective range: ${out}`);
    assert.ok(!out.includes("m00001–m00015"), `requested range must not lead the headline: ${out}`);
    assert.ok(out.includes('endId="m00015"'), `requested number stays in the clamped warning: ${out}`);
    assert.ok(out.includes("clamped"), `clamped note preserved: ${out}`);
});

test("#6855: in-bounds call → headline unchanged (no over-clamping)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const ctx = makeCtx();
    seedTurn(ctx, Array.from({ length: 8 }, (_, i) => (i % 2 ? ["assistant", "y".repeat(6000)] : ["user", "x".repeat(6000)])) as Array<[string, string]>);
    const out = applyRanges(parseCompressedInputSafe("m00001", "m00005", LONG_SUMMARY), ctx).text;
    assert.ok(out.startsWith("[Compressed m00001–m00005 →"), out);
    assert.ok(!out.includes("clamped"), `no clamp note for an in-bounds call: ${out}`);
});

test("#6855: pure function — only kernel-confirmed clamps are re-stated", () => {
    const clampNote = 'endId="m00007" is above this session\'s highest allocated ref (m00003) — clamped to it (refs are minted in order and never pre-allocated, so higher numbers do not exist yet); the fold lands at m00003, the last visible message at or below the frontier.';
    // clamped by the kernel (note present) → effective end shown
    assert.equal(
        effectiveCompressedDetail([{ startRef: "m00001", endRef: "m00007" }], 3, [clampNote]),
        "m00001–m00003",
    );
    // end above the frontier but NO clamped note (kernel hard-refused, e.g.
    // start also above) → shown exactly as requested
    assert.equal(
        effectiveCompressedDetail([{ startRef: "m00008", endRef: "m00012" }], 3, ["startId=\"m00008\" is above this session's highest allocated ref (m00003) — ..."]),
        "m00008–m00012",
    );
    // end above, start above → unchanged even if an unrelated note exists
    assert.equal(
        effectiveCompressedDetail([{ startRef: "m00008", endRef: "m00012" }], 3, [clampNote]),
        "m00008–m00012",
    );
    // mixed batch: one clamped, one untouched
    assert.equal(
        effectiveCompressedDetail(
            [{ startRef: "m00001", endRef: "m00007" }, { startRef: "m00010", endRef: "m00020" }],
            12,
            ['endId="m00020" is above this session\'s highest allocated ref (m00012) — clamped to it.'],
        ),
        "m00001–m00007, m00010–m00012",
    );
    // bN-shaped endpoints never carry m-numbers → unchanged
    assert.equal(
        effectiveCompressedDetail([{ startRef: "b5", endRef: "b9" }], 3, [clampNote]),
        "b5–b9",
    );
    // empty ref map → unchanged, never invents a ceiling
    assert.equal(
        effectiveCompressedDetail([{ startRef: "m00001", endRef: "m00007" }], 0, [clampNote]),
        "m00001–m00007",
    );
});

// parseCompressInput wants the tool-call content shape; keep the fixture in
// one place so the receipt tests read as plain (start, end, summary) calls.
function parseCompressedInputSafe(startId: string, endId: string, summary: string) {
    return parseCompressInput({ content: [{ startId, endId, summary }] });
}
