import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    extractThinkingMerge,
    planReconciliation,
    reconcileFoldCoverage,
    turnContexts,
    normalizedIdentity,
    type FoldAnchor,
    type ReconcileOptions,
} from "../src/fold-reconcile.ts";
import { resolveStoredDecompositions, type StoredRow } from "../src/fold-decomposition-lookup.ts";
import { planIngest, planIngestDelta, type LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}

const THINK_OPEN = "\x3cthink\x3e\n";
const THINK_CLOSE = "\n\x3c/think\x3e";
const THINKING_OPEN = "\x3cthinking\x3e\n";
const THINKING_CLOSE = "\n\x3c/thinking\x3e";
const FENCE_OPEN = "```thinking\n";
const FENCE_CLOSE = "\n```";

describe("extractThinkingMerge (#3301)", () => {
    test("each kernel-listed form splits at offset 0", () => {
        assert.deepEqual(extractThinkingMerge(`${THINK_OPEN}R${THINK_CLOSE}\nT`), { reasoning: "R", text: "T" });
        assert.deepEqual(extractThinkingMerge(`${THINKING_OPEN}R${THINKING_CLOSE}\nT`), { reasoning: "R", text: "T" });
        assert.deepEqual(extractThinkingMerge(`${FENCE_OPEN}R${FENCE_CLOSE}\nT`), { reasoning: "R", text: "T" });
    });
    test("multi-block runs join reasoning with \\n (kernel parity)", () => {
        const s = `${THINK_OPEN}A${THINK_CLOSE}\n${THINK_OPEN}B${THINK_CLOSE}\nT`;
        assert.deepEqual(extractThinkingMerge(s), { reasoning: "A\nB", text: "T" });
    });
    test("thinking-only merge keeps empty text", () => {
        assert.deepEqual(extractThinkingMerge(`${THINK_OPEN}R${THINK_CLOSE}`), { reasoning: "R", text: "" });
    });
    test("tag not at offset 0 never matches (prose safety)", () => {
        assert.equal(extractThinkingMerge(`prefix ${THINK_OPEN}R${THINK_CLOSE}\nT`), null);
        assert.equal(extractThinkingMerge(`\n${THINK_OPEN}R${THINK_CLOSE}\nT`), null);
    });
    test("empty or unterminated blocks do not match", () => {
        assert.equal(extractThinkingMerge(`${THINK_OPEN}${THINK_CLOSE}\nT`), null);
        assert.equal(extractThinkingMerge(`${THINK_OPEN}R never closed`), null);
    });
    test("plain prose, empty and undefined return null", () => {
        assert.equal(extractThinkingMerge("just prose"), null);
        assert.equal(extractThinkingMerge(""), null);
        assert.equal(extractThinkingMerge(undefined), null);
    });
});

describe("turnContexts bridges split vs merged forms (#3301)", () => {
    test("merged tagged core carries the same turn keys as the rc pair", () => {
        const R = "alpha beta gamma delta epsilon zeta eta theta";
        const T = "one two three four five six seven eight nine ten";
        const rcPairCtx = turnContexts([
            msg("r1", "assistant", R, { contentType: "reasoning" }),
            msg("t1", "assistant", T),
        ]);
        const mergedCtx = turnContexts([
            msg("m1", "assistant", `${THINK_OPEN}${R}${THINK_CLOSE}\n${T}`),
        ]);
        const pair = rcPairCtx.get("r1");
        const merged = mergedCtx.get("m1");
        assert.ok(pair && merged);
        assert.equal(merged!.p, pair!.p, "primary seam key matches");
        assert.equal(merged!.p2 ?? merged!.p, pair!.p2 ?? pair!.p, "seamless key matches");
    });
});

describe("planReconciliation shape flips (#3301)", () => {
    const R = "alpha beta gamma delta epsilon zeta eta theta";
    const T = "one two three four five six seven eight nine ten";
    const MERGED = `${THINK_OPEN}${R}${THINK_CLOSE}\n${T}`;

    function rcAnchors(): Record<string, FoldAnchor> {
        const r1 = msg("r1", "assistant", R, { contentType: "reasoning" });
        const t1 = msg("t1", "assistant", T);
        const ctx = turnContexts([r1, t1]);
        const a1 = { n: normalizedIdentity(r1), r: "assistant", c: "reasoning", b: R.length, p: ctx.get("r1")?.p, p2: ctx.get("r1")?.p2, x: "t1" };
        const a2 = { n: normalizedIdentity(t1), r: "assistant", c: "text", b: T.length, p: ctx.get("t1")?.p, p2: ctx.get("t1")?.p2, x: "r1" };
        return { r1: a1, t1: a2 };
    }

    test("rc pair -> merged core: both member ids claim the one witness", () => {
        const merged = msg("m1", "assistant", MERGED);
        const plan = planReconciliation(["r1", "t1"], rcAnchors(), [merged], new Set(["r1", "t1"]));
        assert.deepEqual(plan.claims.get("r1"), ["m1"]);
        assert.deepEqual(plan.claims.get("t1"), ["m1"]);
        assert.equal(plan.unmatched.length, 0);
        assert.ok(plan.byTurn >= 1, `turn-key pass did the bridging (counters: ${JSON.stringify({ byTurn: plan.byTurn, bySim: plan.bySim, byOrder: plan.byOrder })})`);
    });

    test("merged core -> rc pair: one old id claims both new ids", () => {
        const merged = msg("m1", "assistant", MERGED);
        const ctx = turnContexts([merged]);
        const anchors = { m1: { n: normalizedIdentity(merged), r: "assistant", c: "text", b: MERGED.length, p: ctx.get("m1")?.p } };
        const plan = planReconciliation(["m1"], anchors, [
            msg("r2", "assistant", R, { contentType: "reasoning" }),
            msg("t2", "assistant", T),
        ], new Set(["m1"]));
        assert.deepEqual(plan.claims.get("m1"), ["r2", "t2"]);
        assert.equal(plan.unmatched.length, 0);
        assert.ok(plan.byTurn >= 1);
    });

    test("untagged merges stay bridgeable through the bare-concat keys", () => {
        for (const seam of ["\n", ""]) {
            const mergedUntagged = msg(`mu-${seam === "\n" ? "nl" : "flat"}`, "assistant", R + seam + T);
            const plan = planReconciliation(["r1", "t1"], rcAnchors(), [mergedUntagged], new Set(["r1", "t1"]));
            assert.equal(plan.unmatched.length, 0, `seam ${JSON.stringify(seam)} bridged`);
            assert.deepEqual(plan.claims.get("r1"), [mergedUntagged.id]);
        }
    });

    test("ambiguous duplicate turns skip honestly (never fuzzy)", () => {
        const mergedA = msg("mA", "assistant", MERGED);
        const mergedB = msg("mB", "assistant", MERGED);
        const plan = planReconciliation(["r1", "t1"], rcAnchors(), [mergedA, mergedB], new Set(["r1", "t1"]));
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(new Set(plan.unmatched), new Set(["r1", "t1"]));
    });
});

describe("reconcileFoldCoverage end-to-end flips (#3301)", () => {
    function fakeSession(blocks: { effectiveMessageIds: string[]; directMessageIds?: string[] }[]): Session {
        return {
            state: { blocks: blocks.map((b) => ({ active: true, ...b })) },
            metadata: {},
        } as unknown as Session;
    }
    const opts = (extra?: Partial<ReconcileOptions>) =>
        ({ mode: "repair", sessionId: "s1", log: () => {}, ...extra }) satisfies ReconcileOptions;

    // 10 fillers + one rc thinking turn (ids f0..f8, r1, t1)
    function rcHistory() {
        const R = "alpha beta gamma delta epsilon zeta eta theta";
        const T = "one two three four five six seven eight nine ten";
        const fillers = Array.from({ length: 9 }, (_, i) => msg(`f${i}`, "user", `filler context words number ${i}`));
        const r1 = msg("r1", "assistant", R, { contentType: "reasoning" });
        const t1 = msg("t1", "assistant", T);
        return { R, T, all: [...fillers.slice(0, 5), r1, t1, ...fillers.slice(5)] };
    }

    test("rc -> merged: covered thinking turn survives the flip", () => {
        const { R, T, all } = rcHistory();
        const allIds = all.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: allIds, directMessageIds: allIds }]);
        reconcileFoldCoverage(session, all, opts());
        const merged = msg("m1", "assistant", `${THINK_OPEN}${R}${THINK_CLOSE}\n${T}`);
        const flipped = all.filter((m) => m.id !== "t1").map((m) => (m.id === "r1" ? merged : m));
        const result = reconcileFoldCoverage(session, flipped, opts());
        assert.equal(result.unmatched, 0, `drift residual must be zero (got ${JSON.stringify(result)})`);
        const rewritten = allIds.map((id) => (id === "r1" || id === "t1" ? "m1" : id));
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, rewritten);
        assert.deepEqual(session.state.blocks[0].directMessageIds, rewritten);
    });

    test("merged -> rc: the reverse flip survives too", () => {
        const { R, T, all } = rcHistory();
        const mergedFirst = all.map((m) => (m.id === "r1" ? msg("m1", "assistant", `${THINK_OPEN}${R}${THINK_CLOSE}\n${T}`) : m)).filter((m) => m.id !== "t1");
        const idsAfterMerge = mergedFirst.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: idsAfterMerge, directMessageIds: idsAfterMerge }]);
        reconcileFoldCoverage(session, mergedFirst, opts());
        const backToRc = mergedFirst.flatMap((m) => m.id === "m1"
            ? [msg("r2", "assistant", R, { contentType: "reasoning" }), msg("t2", "assistant", T)]
            : [m]);
        const result = reconcileFoldCoverage(session, backToRc, opts());
        assert.equal(result.unmatched, 0, `reverse flip must fully re-anchor (got ${JSON.stringify(result)})`);
        const expected = idsAfterMerge.flatMap((id) => (id === "m1" ? ["r2", "t2"] : [id]));
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, expected);
    });

    test("pre-#2644 anchors heal on the flip pass itself from stored decompositions", () => {
        const { R, T, all } = rcHistory();
        const allIds = all.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: allIds, directMessageIds: allIds }]);
        reconcileFoldCoverage(session, all, opts());
        // emulate anchors persisted before turn keys existed
        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        for (const id of ["r1", "t1"]) {
            delete anchors[id].p;
            delete anchors[id].p2;
            delete anchors[id].x;
        }
        const merged = msg("m1", "assistant", `${THINK_OPEN}${R}${THINK_CLOSE}\n${T}`);
        const flipped = all.filter((m) => m.id !== "t1").map((m) => (m.id === "r1" ? merged : m));
        const stored = [
            msg("r1", "assistant", R, { contentType: "reasoning" }),
            msg("t1", "assistant", T),
        ];
        // The flip pass is the LAST pass in which r1/t1 sit in the order
        // backbone (nextOrder rolls forward to the flipped history), so the
        // stored-decomposition backfill must land BEFORE the plan runs and
        // this very pass must claim — a later backfill can never do it.
        const pass1 = reconcileFoldCoverage(session, flipped, opts({ storedMessages: stored }));
        assert.equal(pass1.unmatched, 0, `flip pass claims through stored keys (got ${JSON.stringify(pass1)})`);
        const rewritten = allIds.map((id) => (id === "r1" || id === "t1" ? "m1" : id));
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, rewritten);
        const healed = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        assert.ok(healed["m1"] !== undefined && healed["m1"].p !== undefined, "merged core anchored with extracted turn key");
        assert.equal(healed["r1"], undefined, "old form ids retired from anchors");
        assert.equal(healed["t1"], undefined);
        const pass2 = reconcileFoldCoverage(session, flipped, opts());
        assert.equal(pass2.unmatched, 0, "steady state after recovery is clean");
    });

    test("legacy anchors without a stored source stay honestly blind", () => {
        const { R, T, all } = rcHistory();
        const allIds = all.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: allIds }]);
        reconcileFoldCoverage(session, all, opts());
        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        for (const id of ["r1", "t1"]) {
            delete anchors[id].p;
            delete anchors[id].p2;
            delete anchors[id].x;
        }
        const merged = msg("m1", "assistant", `${THINK_OPEN}${R}${THINK_CLOSE}\n${T}`);
        const flipped = all.filter((m) => m.id !== "t1").map((m) => (m.id === "r1" ? merged : m));
        const result = reconcileFoldCoverage(session, flipped, opts());
        assert.equal(result.unmatched, 2, "no index, no wire bytes: honest miss, no fuzzy claim");
    });
});

describe("resolveStoredDecompositions (#3301)", () => {
    function lookupSession(anchorCount: number, mutate?: (anchors: Record<string, FoldAnchor>) => void): Session {
        const anchors: Record<string, FoldAnchor> = {};
        for (let i = 0; i < anchorCount; i++) {
            anchors[`a${i}`] = { n: `n${i}`, r: "assistant", c: "text", b: 10 };
        }
        mutate?.(anchors);
        return { state: { blocks: [] }, metadata: { foldAnchors: anchors } } as unknown as Session;
    }
    const wireIds = new Set<string>();

    test("filters to legacy bare-assistant anchors off the wire, caps at 256", () => {
        const session = lookupSession(300, (a) => {
            a["a0"].p = "has-key";
            a["a1"].r = "user";
            a["a2"].t = "tool-call-id";
        });
        const seenCalls: string[][] = [];
        const source = { rows: (_sid: string, ids: readonly string[]) => { seenCalls.push([...ids]); return []; } };
        const out = resolveStoredDecompositions(session, "s1", wireIds, source);
        assert.equal(out, undefined, "empty rows yield undefined");
        assert.equal(seenCalls.length, 1, "source consulted once");
        const seen = seenCalls[0];
        assert.equal(seen.length, 256, "cap applied");
        assert.ok(!seen.includes("a0") && !seen.includes("a1") && !seen.includes("a2"), "ineligible anchors excluded");
    });

    test("rows === null (index unavailable) does not burn the retry budget", () => {
        const session = lookupSession(3);
        let calls = 0;
        const source = { rows: () => { calls++; return null; } };
        assert.equal(resolveStoredDecompositions(session, "s1", wireIds, source), undefined);
        assert.equal(resolveStoredDecompositions(session, "s1", wireIds, source), undefined);
        assert.equal(calls, 2, "still retried on the next pass");
    });

    test("absent rows mark tried once; later passes skip the lookup", () => {
        const session = lookupSession(3);
        let calls = 0;
        const source = { rows: () => { calls++; return []; } };
        assert.equal(resolveStoredDecompositions(session, "s1", wireIds, source), undefined);
        assert.equal(calls, 1);
        assert.equal(resolveStoredDecompositions(session, "s1", wireIds, source), undefined);
        assert.equal(calls, 1, "tried-set suppresses repeat lookups");
    });

    test("latest-seq-per-id wins, neighbors kept, output sorted by seq", () => {
        const rows: StoredRow[] = [
            { seq: 1, msgId: "r1", content: JSON.stringify(msg("r1", "assistant", "OLD", { contentType: "reasoning" })) },
            { seq: 2, msgId: "t1", content: JSON.stringify(msg("t1", "assistant", "reply")) },
            { seq: 3, msgId: "r1", content: JSON.stringify(msg("r1", "assistant", "NEW", { contentType: "reasoning" })) },
            { seq: 4, msgId: "u2", content: "{not-json" },
        ];
        const session = lookupSession(2);
        delete (session.metadata.foldAnchors as Record<string, FoldAnchor>)["a1"];
        const source = { rows: () => rows };
        const out = resolveStoredDecompositions(session, "s1", wireIds, source);
        assert.ok(out !== undefined);
        assert.deepEqual(out!.map((m) => m.id), ["t1", "r1"], "sorted by surviving seq (t1=2 < r1=3), unparseable row dropped");
        assert.equal(out![1].text, "NEW", "latest serialization wins");
    });

    test("wire-present ids are excluded from the lookup", () => {
        const session = lookupSession(2);
        let seen: readonly string[] = [];
        const source = { rows: (_sid: string, ids: readonly string[]) => { seen = ids; return []; } };
        resolveStoredDecompositions(session, "s1", new Set(["a0"]), source);
        assert.deepEqual(seen, ["a1"]);
    });
});

describe("decompositionLog ingest (#3301)", () => {
    function mkLegacy(id: string, lastMessages: CoreMessage[], decompositionLog?: CoreMessage[]): LegacySessionLike {
        return {
            id,
            createdAt: 1_000,
            lastSeen: 2_000,
            meta: { protocol: "openai" },
            stats: { requests: 1 },
            metadata: {},
            state: {
                blocks: [],
                messageRefs: { byRaw: {}, byRef: {} },
                nextBlockId: 1,
                nextRunId: 1,
            },
            blockContents: new Map(),
            lastMessages,
            lastMessagesFolded: false,
            decompositionLog,
        };
    }

    test("import payload rows sit below tail seqs and dedup against the tail", () => {
        const r1 = msg("r1", "assistant", "R words", { contentType: "reasoning" });
        const t1 = msg("t1", "assistant", "T words");
        const u2 = msg("u2", "user", "hello");
        // payload: one older message + a byte-identical copy of a tail message
        const legacy = mkLegacy("imp", [r1, t1, u2], [msg("d0", "user", "older evidence"), r1]);
        const plan = planIngest(legacy);
        assert.deepEqual(plan.messages.map((m) => m.msgId), ["d0", "r1", "t1", "u2"], "payload interned first, duplicate not re-logged");
        assert.deepEqual(plan.tailSeqs, [1, 2, 3]);
    });

    test("delta planner forces the full path while an import payload is present", () => {
        const r1 = msg("r1", "assistant", "R words", { contentType: "reasoning" });
        const legacy = mkLegacy("imp2", [r1], [msg("d0", "user", "older evidence")]);
        const out = planIngestDelta(legacy, 0, [], { msgId: "x", contentHash: "y" }, true);
        assert.equal(out, null, "payload must not be skipped as trusted prefix");
    });
});
