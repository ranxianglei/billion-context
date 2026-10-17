import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    reconcileFoldCoverage,
    type FoldAnchor,
    type ReconcileOptions,
} from "../src/fold-reconcile.ts";
import { resolveStoredDecompositions, type StoredRow } from "../src/fold-decomposition-lookup.ts";
import { planIngest, planIngestDelta, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}

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

// #3301: producer-side shape pinning (opencode-acp / opencode-native transform)
// makes the wire form deterministic, so the runtime reconciler no longer
// guesses shapes. What remains here is the DETERMINISTIC recovery half:
// rebuilding pre-#2644 anchors from stored ground truth (index.db rows /
// import payload) — never fuzzy, never speculative.

describe("reconcileFoldCoverage stored-decomposition recovery (#3301)", () => {
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

    function stripTurnKeys(session: Session): void {
        // emulate anchors persisted before turn keys existed (#2644)
        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        for (const id of ["r1", "t1"]) {
            delete anchors[id].p;
            delete anchors[id].p2;
            delete anchors[id].x;
        }
    }

    test("pre-#2644 anchors heal on the flip pass itself from stored decompositions", () => {
        const { R, T, all } = rcHistory();
        const allIds = all.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: allIds, directMessageIds: allIds }]);
        reconcileFoldCoverage(session, all, opts());
        stripTurnKeys(session);
        // the host re-serialized the turn as ONE untagged core (bytes changed,
        // structure 2->1): exact-id cannot match, and the legacy anchors have
        // no turn keys to bridge it — only the stored ground truth can.
        const merged = msg("m1", "assistant", `${R}\n${T}`);
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
        assert.ok(healed["m1"] !== undefined && healed["m1"].p !== undefined, "merged core anchored");
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
        stripTurnKeys(session);
        const merged = msg("m1", "assistant", `${R}\n${T}`);
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

describe("UnifiedStore.messagesForIds (#3301)", () => {
    test("returns id rows plus seq±1 neighbors, sorted by seq, CAS-resolved content", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3301-mfi-"));
        let store: UnifiedStore | null = null;
        try {
            const r1 = msg("r1", "assistant", "R words here", { contentType: "reasoning" });
            const t1 = msg("t1", "assistant", "T reply words");
            const u2 = msg("u2", "user", "hello user");
            store = UnifiedStore.open(path.join(tmp, "index.db"));
            store.ingestSession(planIngest(mkLegacy("s-mfi", [r1, t1, u2])));
            // one rc member with neighbors → the adjacent core lands too, so
            // turn-key derivation keeps split-form pairs adjacent.
            const rows = store.messagesForIds("s-mfi", ["r1"], true);
            assert.deepEqual(rows.map((r) => r.msgId), ["r1", "t1"], "rc pair stays adjacent");
            assert.equal(rows[1].seq - rows[0].seq, 1, "neighbor is the very next row");
            assert.equal(rows[0].content, JSON.stringify(r1), "content resolved through the CAS blob");
            // without neighbors: exactly the requested ids, nothing more
            const bare = store.messagesForIds("s-mfi", ["u2"], false);
            assert.deepEqual(bare.map((r) => r.msgId), ["u2"]);
            // ids absent from the index → empty list (null is the persist-layer
            // signal for "no index at all"; [] means the index has none)
            assert.deepEqual(store.messagesForIds("s-mfi", ["missing"], true), []);
        } finally {
            store?.close();
            try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
        }
    });
});
