import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assignRefs, createCore, defaultConfig, emptyRefMap, type CoreMessage } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, reapDestroyedSubstrate } from "../src/session.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { recordProbeFailures } from "../src/loop/core.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "Synthetic fold summary; keep the remaining recent messages.";

function makeCtx(count: number, preserveRecentMessages = 5): RewriteCtx & { messages: CoreMessage[] } {
    const messages: CoreMessage[] = Array.from({ length: count }, (_, i) => ({
        id: `raw-${i + 1}`,
        role: i === count - 1 ? "user" : "assistant",
        contentType: "text",
        text: `Synthetic message ${i + 1}. ` + "x".repeat(6000),
    }));
    const session = getSession(`issue3302-${randomUUID()}`);
    session.state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages, preserveRecentTokens: 0 }),
        messages,
        session,
        log: () => {},
    };
}

function request(ctx: RewriteCtx, startId: string, endId: string, summary = SUMMARY) {
    return applyRanges(parseCompressInput({ content: [{ startId, endId, summary }] }), ctx);
}

/** Simulate the host-side prune dropping one message's ref pair. */
function dropRef(ctx: ReturnType<typeof makeCtx>, ref: string): void {
    const rawId = ctx.session.state.messageRefs.byRef[ref];
    assert.ok(rawId, `${ref} must be allocated`);
    delete ctx.session.state.messageRefs.byRef[ref];
    delete ctx.session.state.messageRefs.byRaw[rawId];
}

test("reapDestroyedSubstrate tombstones pruned refs into state.deadRefs (billion-context#3302 Ask 5)", () => {
    const ctx = makeCtx(6);
    request(ctx, "m00001", "m00002");
    assert.equal(ctx.session.state.blocks.length, 1);
    const blockId = ctx.session.state.blocks[0]!.blockId;

    const liveRawIds = new Set(ctx.messages.filter((m) => m.id !== "raw-5").map((m) => m.id));
    reapDestroyedSubstrate(ctx.session, new Set([blockId]), liveRawIds, () => {});

    assert.equal(ctx.session.state.messageRefs.byRef["m00005"], undefined);
    assert.equal(ctx.session.state.messageRefs.byRef["m00003"], "raw-3");
    assert.deepEqual(ctx.session.state.deadRefs, ["m00005"]);
});

test("tombstone merge keeps pre-existing dead refs, dedupes, sorts ascending (billion-context#3302 Ask 5)", () => {
    const ctx = makeCtx(6);
    request(ctx, "m00001", "m00002");
    const blockId = ctx.session.state.blocks[0]!.blockId;
    ctx.session.state.deadRefs = ["m00008", "m00005"];

    const liveRawIds = new Set(ctx.messages.filter((m) => m.id !== "raw-5" && m.id !== "raw-3").map((m) => m.id));
    reapDestroyedSubstrate(ctx.session, new Set([blockId]), liveRawIds, () => {});

    assert.deepEqual(ctx.session.state.deadRefs, ["m00003", "m00005", "m00008"]);
});

test("pruned endpoint without tombstone reports sparse-space gap, not cross-session (billion-context#3302)", () => {
    const ctx = makeCtx(6);
    dropRef(ctx, "m00005");
    const result = request(ctx, "m00003", "m00005");
    assert.equal(result.outcome, "refused");
    assert.match(result.text, /endId="m00005" was never allocated in this session or was pruned after allocation/);
    assert.doesNotMatch(result.text, /typo or wrong session/);
});

test("tombstoned pruned endpoint snaps instead of failing (billion-context#3302 Ask 5)", () => {
    const ctx = makeCtx(12);
    dropRef(ctx, "m00009");
    ctx.session.state.deadRefs = ["m00009"];
    const result = request(ctx, "m00004", "m00009");
    assert.equal(result.outcome, "applied", result.text);
    assert.match(result.text, /endId="m00009" no longer backs any visible message/);
});

test("failure receipt falls back to the last nudge's compressible table when no live decision exists (billion-context#3302 Ask 3)", () => {
    const ctx = makeCtx(10);
    const baseCore = ctx.core;
    const decision = baseCore.processTurn({
        messages: ctx.messages,
        state: ctx.session.state,
        config: ctx.config,
        tokenCount: 180000,
    }).nudge;
    assert.ok(decision?.shouldInject, "fixture must produce an injectable nudge decision");
    assert.ok(decision.compressibleRanges.length > 0);
    ctx.lastNudge = decision;
    ctx.core = {
        ...baseCore,
        processTurn: (input: Parameters<typeof baseCore.processTurn>[0]) => ({
            ...baseCore.processTurn(input),
            nudge: undefined,
        }),
    };

    request(ctx, "m00001", "m00002");
    // #4521 flip: re-requesting an already-covered range is now an idempotent no-op SUCCESS,
    // so the refusal trigger moves to refs unknown to the session (stale generation) — the
    // fallback-to-last-nudge-table behavior under test is unchanged.
    const rejected = request(ctx, "m00099", "m00100");
    assert.equal(rejected.outcome, "refused");
    assert.match(rejected.text, /Current compressible ranges from the last compression check/);
    assert.doesNotMatch(rejected.text, /Call acp_status before retrying/);
});

test("recordProbeFailures flags a probe family only on >=2 distinct values at one endpoint (billion-context#3302 Ask 6)", () => {
    const probes = new Map<string, Set<string>>();
    assert.equal(recordProbeFailures(probes, []), null);
    assert.equal(
        recordProbeFailures(probes, [
            { name: "compress", result: '[Compression FAILED: range m00003..m00007: endId="m00007" ...]' },
        ]),
        null,
    );
    assert.equal(
        recordProbeFailures(probes, [
            { name: "decompress", result: '[Decompression FAILED: endId="m00007" unknown]' },
            { name: "bash", result: "FAILED exit 1" },
        ]),
        null,
    );
    const hit = recordProbeFailures(probes, [
        { name: "compress", result: '[Compression FAILED: range m00003..m00007: endId="m00007" ...]' },
        { name: "compress", result: '[Compression FAILED: range m00003..m00009: endId="m00009" ...]' },
    ]);
    assert.deepEqual(hit, { label: "endId", values: ["m00007", "m00009"] });
});
