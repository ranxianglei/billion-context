// #3126: compress served from an EMPTY message view while refs are still
// mapped (session evicted from the resident pool / restarted between model
// requests) used to feed the kernel zero messages, dangle EVERY requested ref,
// record them all DEAD, and blame "content-changed". Now the host refuses up
// front with the honest cause and writes nothing. These tests pin: the
// refusal + its machine-readable reason, that NO deadRefs are recorded, that a
// fresh (ref-less) session still falls through to the kernel path unchanged,
// that a normal fold still applies, that the breaker arms with the honest
// cause, and that the external-summary lane hits the same gate pre-network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { applyConfiguredCompression } from "../src/external-summary-compress.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function makeCtx(opts?: { messages?: CoreMessage[]; refs?: boolean }): Ctx {
    const logs: string[] = [];
    const ctx: Ctx = {
        core: createCore(),
        // Explicit protect-zone override (same recipe as tests/compress-span-hint.test.ts):
        // the bare default would fence m00010..m00040 under "most recent user
        // message" protection and mask the gate behavior under test.
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages: opts?.messages ?? [],
        session: {
            id: "issue3126-test",
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
    if (opts?.refs) {
        // Refs m00001..m00080 mapped WITHOUT their messages present in the view —
        // the evicted/restarted shape: state survived, the message bytes did not.
        ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    }
    return ctx;
}

const SPEC = () => parseCompressInput({ content: [{ startId: "m00010", endId: "m00040", summary: "y".repeat(100) }] });

test("#3126: empty view + mapped refs refuses up front, records nothing", () => {
    const ctx = makeCtx({ refs: true });
    const res = applyRanges(SPEC(), ctx);
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context");
    assert.equal(res.blocksCreated, 0);
    assert.ok(res.text.includes("no visible context"), `receipt names the cause: ${res.text}`);
    assert.ok(res.text.includes("[cause: no-visible-context]"), `machine cause present: ${res.text}`);
    assert.ok(res.text.includes("Do NOT retry now"), `retry veto present: ${res.text}`);
    // The core of the fix: NOTHING was marked dead and no block was created.
    assert.equal(ctx.session.state.deadRefs, undefined, "no deadRefs recorded");
    assert.equal(ctx.session.state.blocks.length, 0, "no blocks created");
    // Operator log carries the correlation marker.
    assert.ok(ctx.logs.some((l) => l.includes("no visible context")), `operator log present: ${JSON.stringify(ctx.logs)}`);
});

test("#3126: a fresh (ref-less) session still falls through to the kernel path", () => {
    const ctx = makeCtx(); // no refs, empty view
    const res = applyRanges(SPEC(), ctx);
    assert.equal(res.outcome, "refused");
    assert.ok(!res.text.includes("[cause: no-visible-context]"), `must NOT hit the new gate: ${res.text}`);
    assert.ok(!res.text.includes("no visible context"), `new-gate wording absent: ${res.text}`);
});

test("#3126: a normal fold (view present) still applies past the gate", () => {
    const ctx = makeCtx({ messages: MESSAGES, refs: true });
    const res = applyRanges(SPEC(), ctx);
    assert.equal(res.outcome, "applied", `expected applied, got: ${res.text}`);
    assert.ok((res.blocksCreated ?? 0) >= 1, `a block was created: ${res.text}`);
    assert.equal(ctx.session.state.deadRefs, undefined, "no deadRefs on a clean fold");
});

test("#3126: three consecutive refusals arm the breaker with the honest cause", () => {
    const ctx = makeCtx({ refs: true });
    const r1 = applyRanges(SPEC(), ctx);
    const r2 = applyRanges(SPEC(), ctx);
    const r3 = applyRanges(SPEC(), ctx);
    assert.ok(!r1.text.includes("COMPRESS CIRCUIT BREAKER"), "not armed at n=1");
    assert.ok(r2.text.includes("Repeat-failure guard"), `repeat guard at n=2: ${r2.text}`);
    assert.ok(r3.text.includes("COMPRESS CIRCUIT BREAKER"), `armed at n=3: ${r3.text}`);
    const streak = ctx.session.metadata["compressFailStreak"] as { n?: number; cause?: string };
    assert.equal(streak.n, 3);
    assert.equal(streak.cause, "no-visible-context", "honest cause persisted on the streak");
});

test("#3859: a block-touching request on an EMPTY view is refused too — no dead refs", () => {
    const ctx = makeCtx({ messages: MESSAGES, refs: true });
    const first = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00020", summary: "z".repeat(60) }] }), ctx);
    assert.equal(first.outcome, "applied", `setup fold lands: ${first.text}`);
    // Evicted/restarted next round: the view is empty while SPEC (m00010–m00040)
    // partially overlaps the fresh block m00001–m00020. The pre-#3859 span-overlap
    // exemption handed this to the kernel, which could anchor neither endpoint on
    // an empty view and tombstoned m00040 (not point-covered by any block) as
    // DEAD — live refs killed by memory eviction. Now the gate refuses
    // unconditionally and writes nothing.
    ctx.messages = [];
    ctx.compressMessages = [];
    const res = applyRanges(SPEC(), ctx);
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context", `block-touching request must be refused on an empty view: ${res.text}`);
    assert.equal(ctx.session.state.deadRefs, undefined, "no deadRefs recorded (the #3859 corruption)");
    assert.equal(ctx.session.state.blocks.length, 1, "the setup block is untouched");
});

test("#3126: the external-summary lane hits the same gate before any network call", async () => {
    const ctx = makeCtx({ refs: true });
    // Expanded-shape target (what rides the request Config rail after
    // expandExternalSummaryChain): plan construction must SUCCEED here — the
    // assertion under test is that the shared gate refuses before any of these
    // fully-usable candidates is ever dispatched.
    ctx.config = { ...defaultConfig(200000), externalSummary: { enabled: true, targets: [{ name: "sum-sm", protocol: "openai", url: "https://summary.example.test/v1/chat/completions", model: "sm", apiKey: "sk-test-3126", contextWindow: 128000, outputTokens: 8192, stream: false }] } } as typeof ctx.config;
    const res = await applyConfiguredCompression({ content: [{ startId: "m00010", endId: "m00040", summary: "hint" }] }, ctx);
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context");
    assert.ok(res.text.includes("no visible context"), `external lane uses the shared gate: ${res.text}`);
    assert.equal(ctx.session.state.deadRefs, undefined, "no deadRefs recorded");
});
