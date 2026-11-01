// #5395: host-side tool-result pruner mutates folded messages → covered ids go
// PERMANENTLY unmatched (re-reported every turn, feeding #2438/#5223 escalation).
// The dsh desktop tool-result-pruner splices its sentinel between preserved head
// and tail; bili's identity channels all starve on that shape (norm/twin equality,
// wordbag/simhash distance, positional fence). This suite pins the byte-verified
// pruner-shape re-anchor: positive gate, every negative gate (#3617 both-directions
// discipline), convergence (the bug was NON-convergence), ledger visibility, and
// the steady-state zero-storage-read contract.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    planReconciliation,
    reconcileFoldCoverage,
    normalizedIdentity,
    normalizedIdentityNoToolCallId,
    type FoldAnchor,
    type ReconcileOptions,
} from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { conflictEventsOf } from "../src/conflict-watch.js";

const MARKER = "\n\n[... tool result middle pruned ...]\n\n";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}

function anchorOf(m: CoreMessage): FoldAnchor {
    const a: FoldAnchor = { n: normalizedIdentity(m), r: m.role, c: m.contentType, b: m.text?.length ?? 0 };
    if (m.toolCallId) {
        a.t = m.toolCallId;
        a.m = normalizedIdentityNoToolCallId(m);
    }
    return a;
}

function bigText(seed: number, lines = 400): string {
    return Array.from({ length: lines }, (_, i) => `line ${i} of tool output ${seed} with padding words`).join("\n");
}

/** The host pruner's transform: keep headChars + tailChars, splice the sentinel. */
function pruned(original: string, headChars = 2000, tailChars = 500): string {
    return original.slice(0, headChars) + MARKER + original.slice(-tailChars);
}

describe("planReconciliation pruner-shape pass (#5395)", () => {
    function setup() {
        const u1 = msg("u1", "user", "run the big query please");
        const t1 = msg("t1", "tool_result", bigText(7), { toolCallId: "call_1", toolName: "query", contentType: "tool-result" });
        const u2 = msg("u2", "user", "thanks, summarize it");
        const anchors: Record<string, FoldAnchor> = {};
        for (const m of [u1, t1, u2]) anchors[m.id!] = anchorOf(m);
        return { u1, t1, u2, anchors, covered: new Set(["u1", "t1", "u2"]), oldOrder: ["u1", "t1", "u2"] };
    }

    test("stable toolCallId: recovered by the exact tool pass (pre-existing behavior, not stolen)", () => {
        const s = setup();
        const p = msg("t1-pruned", "tool_result", pruned(s.t1.text!), { toolCallId: "call_1", toolName: "query", contentType: "tool-result" });
        const plan = planReconciliation(s.oldOrder, s.anchors, [s.u1, p, s.u2], s.covered, undefined, undefined, new Map([["t1", s.t1]]));
        assert.deepEqual(plan.claims.get("t1"), ["t1-pruned"]);
        assert.equal(plan.byTool, 1, "the exact channel claims first when the id survived");
        assert.equal(plan.byPrune, 0, "pruner-shape only fires when nothing else could claim");
        assert.equal(plan.unmatched.length, 0);
    });

    test("RE-MINTED toolCallId + pruned bytes: byte-verified re-anchor (positive gate — the #5395 regression)", () => {
        const s = setup();
        // Host re-mints the tool-call id across projections (#2396 class) AND the
        // pruner spliced its sentinel: every exact channel starves, only the byte
        // verification against the stored original can claim.
        const p = msg("t1-pruned", "tool_result", pruned(s.t1.text!), { toolCallId: "call_1_REMINTED", toolName: "query", contentType: "tool-result" });
        const plan = planReconciliation(s.oldOrder, s.anchors, [s.u1, p, s.u2], s.covered, undefined, undefined, new Map([["t1", s.t1]]));
        assert.deepEqual(plan.claims.get("t1"), ["t1-pruned"]);
        assert.equal(plan.byPrune, 1);
        assert.equal(plan.byTool, 0);
        assert.equal(plan.unmatched.length, 0);
    });

    test("marker text NOT byte-derived from the stored original stays unmatched (negative)", () => {
        const s = setup();
        const foreignOriginal = bigText(999);
        const p = msg("t1-fake", "tool_result", pruned(foreignOriginal), { toolCallId: "call_1_REMINTED", toolName: "query", contentType: "tool-result" });
        const plan = planReconciliation(s.oldOrder, s.anchors, [s.u1, p, s.u2], s.covered, undefined, undefined, new Map([["t1", s.t1]]));
        assert.equal(plan.byPrune, 0, "byte verification must fail: head/tail do not match the stored original");
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(plan.unmatched, ["t1"]);
    });

    test("unpruned edit (no marker) stays unmatched — channel inert (negative)", () => {
        const s = setup();
        const edited = msg("t1-edited", "tool_result", s.t1.text!.slice(0, 3000) + "\nUSER EDIT APPENDED\n" + s.t1.text!.slice(-3000), { toolCallId: "call_1_REMINTED", toolName: "query", contentType: "tool-result" });
        const plan = planReconciliation(s.oldOrder, s.anchors, [s.u1, edited, s.u2], s.covered, undefined, undefined, new Map([["t1", s.t1]]));
        assert.equal(plan.byPrune, 0, "no sentinel → no claim, whatever the shape");
        assert.deepEqual(plan.unmatched, ["t1"]);
    });

    test("growth (longer than the anchored original) rejected (negative)", () => {
        const s = setup();
        const grown = msg("t1-grown", "tool_result", s.t1.text! + MARKER + "appended tail", { toolCallId: "call_1_REMINTED", toolName: "query", contentType: "tool-result" });
        const plan = planReconciliation(s.oldOrder, s.anchors, [s.u1, grown, s.u2], s.covered, undefined, undefined, new Map([["t1", s.t1]]));
        assert.equal(plan.byPrune, 0, "a pruned variant is always SHORTER than the anchored original");
        assert.deepEqual(plan.unmatched, ["t1"]);
    });

    test("role mismatch rejected even when bytes verify (negative)", () => {
        const s = setup();
        // Same decomposition, wrong role: the candidate proves nothing about a
        // tool_result anchor.
        const p = msg("t1-wrongrole", "user", pruned(s.t1.text!), { contentType: "tool-result" });
        const plan = planReconciliation(s.oldOrder, s.anchors, [s.u1, p, s.u2], s.covered, undefined, undefined, new Map([["t1", s.t1]]));
        assert.equal(plan.byPrune, 0);
        assert.deepEqual(plan.unmatched, ["t1"]);
    });

    test("storedById absent: channel inert even with a valid marker shape (degradation)", () => {
        const s = setup();
        const p = msg("t1-pruned", "tool_result", pruned(s.t1.text!), { toolCallId: "call_1_REMINTED", toolName: "query", contentType: "tool-result" });
        const plan = planReconciliation(s.oldOrder, s.anchors, [s.u1, p, s.u2], s.covered);
        assert.equal(plan.byPrune, 0, "no stored original → honest unmatched, never a guess");
        assert.deepEqual(plan.unmatched, ["t1"]);
    });

    test("k-th pairing: two pruned tool results pair onto their OWN originals", () => {
        const u1 = msg("u1", "user", "run both queries");
        const t1 = msg("t1", "tool_result", bigText(1), { toolCallId: "c_a", toolName: "q", contentType: "tool-result" });
        const t2 = msg("t2", "tool_result", bigText(2), { toolCallId: "c_b", toolName: "q", contentType: "tool-result" });
        const u2 = msg("u2", "user", "done");
        const anchors: Record<string, FoldAnchor> = {};
        for (const m of [u1, t1, t2, u2]) anchors[m.id!] = anchorOf(m);
        const covered = new Set(["u1", "t1", "t2", "u2"]);
        const p1 = msg("t1-p", "tool_result", pruned(t1.text!), { toolCallId: "c_a'", toolName: "q", contentType: "tool-result" });
        const p2 = msg("t2-p", "tool_result", pruned(t2.text!), { toolCallId: "c_b'", toolName: "q", contentType: "tool-result" });
        const plan = planReconciliation(["u1", "t1", "t2", "u2"], anchors, [u1, p1, p2, u2], covered, undefined, undefined, new Map([["t1", t1], ["t2", t2]]));
        assert.deepEqual(plan.claims.get("t1"), ["t1-p"], "no cross-pairing: each original verifies only against its own decomposition");
        assert.deepEqual(plan.claims.get("t2"), ["t2-p"]);
        assert.equal(plan.byPrune, 2);
        assert.equal(plan.unmatched.length, 0);
    });

    test("one candidate serves at most one old id (deterministic k-th, no double-claim)", () => {
        // Two DISTINCT originals sharing head+tail around different middles
        // decompose into the SAME pruned bytes under one cut — one candidate
        // cannot cover both; the earlier backbone id wins, the later stays honest.
        const sharedHead = "H".repeat(3000);
        const sharedTail = "T".repeat(800);
        const o1 = msg("o1", "tool_result", sharedHead + "MID-ONE-" + sharedTail, { toolCallId: "x1", contentType: "tool-result" });
        const o2 = msg("o2", "tool_result", sharedHead + "MID-TWO-" + sharedTail, { toolCallId: "x2", contentType: "tool-result" });
        const anchors: Record<string, FoldAnchor> = {};
        anchors["o1"] = anchorOf(o1);
        anchors["o2"] = anchorOf(o2);
        const variant = pruned(o1.text!, 2500, 600);
        const p = msg("p1", "tool_result", variant, { toolCallId: "x1'", contentType: "tool-result" });
        const plan = planReconciliation(["o1", "o2"], anchors, [p], new Set(["o1", "o2"]), undefined, undefined, new Map([["o1", o1], ["o2", o2]]));
        assert.equal(plan.claims.size, 1);
        assert.deepEqual(plan.claims.get("o1"), ["p1"], "backbone order decides; deterministic");
        assert.deepEqual(plan.unmatched, ["o2"]);
    });
});

describe("reconcileFoldCoverage integration (#5395)", () => {
    type LogLine = { level: string; msg: string };
    interface RawRow { seq: number; msgId: string; content: string }

    /** Disabled real store (markDirty & friends stay safe) with unified rows shadowed in. */
    function storeWithRows(rows: RawRow[], calls?: number[]): SessionStore {
        const base = new SessionStore({ enabled: false });
        return Object.create(base, {
            unifiedMessageRows: {
                value: (_id: string, ids: readonly string[]) => {
                    calls?.push(ids.length);
                    return rows.filter((r) => ids.includes(r.msgId));
                },
            },
        }) as SessionStore;
    }

    const N_FILLER_BEFORE = 5;
    function fixture() {
        const t1 = msg("t1", "tool_result", bigText(7), { toolCallId: "call_1", toolName: "query", contentType: "tool-result" });
        const originals: CoreMessage[] = [
            ...Array.from({ length: N_FILLER_BEFORE }, (_, i) => msg(`f${i}`, "user", `filler turn ${i} padding words here`)),
            t1,
            ...Array.from({ length: N_FILLER_BEFORE }, (_, i) => msg(`g${i}`, "user", `trailing filler ${i} padding words`)),
        ];
        const session: Session = {
            id: "s-5395",
            state: { blocks: [{ active: true, blockId: "blk-1", effectiveMessageIds: originals.map((m) => m.id!) }], messageRefs: { byRaw: {}, byRef: {} } },
            metadata: {},
        } as unknown as Session;
        return { t1, originals, session };
    }
    function makeOpts(logs?: LogLine[]): ReconcileOptions & { mode: "repair" | "warn" } {
        return {
            sessionId: "s-5395",
            mode: "repair",
            log: logs ? (level: string, m: string) => logs.push({ level, msg: m }) : undefined,
        };
    }
    /** Pass 2 wire: same history, t1 replaced by the host-pruned variant under a RE-MINTED id. */
    function prunedPass(originals: CoreMessage[], t1: CoreMessage): CoreMessage[] {
        return originals.map((m, i) => i === N_FILLER_BEFORE
            ? msg("t1-pruned", "tool_result", pruned(t1.text!), { toolCallId: "call_1_REMINTED", toolName: "query", contentType: "tool-result" })
            : m);
    }

    test("repair mode: prune drift converges in ONE pass — rewrite + ledger event + log line", () => {
        const { t1, originals, session } = fixture();
        const store = storeWithRows([{ seq: 1, msgId: "t1", content: JSON.stringify(t1) }]);
        _setStoreForTest(store);
        const logs: LogLine[] = [];
        reconcileFoldCoverage(session, originals, makeOpts(logs));
        assert.equal(conflictEventsOf(session).length, 0, "clean seed pass records nothing");
        const r2 = reconcileFoldCoverage(session, prunedPass(originals, t1), makeOpts(logs));
        assert.equal(r2.kind, "reanchored");
        assert.equal(r2.byPrune, 1);
        assert.equal(r2.unmatched, 0, "the permanent residual is gone");
        const eff = (session.state.blocks[0] as { effectiveMessageIds: string[] }).effectiveMessageIds;
        assert.ok(eff.includes("t1-pruned"), "block rewritten onto the pruned id");
        assert.ok(!eff.includes("t1"), "old id retired from coverage");
        const events = conflictEventsOf(session).filter((e) => e.kind === "host-content-mutation");
        assert.equal(events.length, 1, "fix B: the double-compressor evidence lands in the ledger");
        assert.match(events[0].detail, /byte-verified sentinel splice/);
        assert.ok(logs.some((l) => /by pruner-shape byte verification/.test(l.msg)), "drift line names the channel");
    });

    test("second pass after re-anchor: clean resend, NO new ledger events (convergence — the bug was non-convergence)", () => {
        const { t1, originals, session } = fixture();
        _setStoreForTest(storeWithRows([{ seq: 1, msgId: "t1", content: JSON.stringify(t1) }]));
        const wire = prunedPass(originals, t1);
        reconcileFoldCoverage(session, originals, makeOpts());
        reconcileFoldCoverage(session, wire, makeOpts());
        const before = conflictEventsOf(session).length;
        const r3 = reconcileFoldCoverage(session, wire, makeOpts());
        assert.equal(r3.kind, "resend", "steady state after the one repair pass");
        assert.equal(r3.byPrune, 0);
        assert.equal(conflictEventsOf(session).length, before, "self-limiting: no per-turn event spam");
    });

    test("warn mode: counted but no repair; blocks untouched; ledger still lit", () => {
        const { t1, originals, session } = fixture();
        _setStoreForTest(storeWithRows([{ seq: 1, msgId: "t1", content: JSON.stringify(t1) }]));
        const before = JSON.stringify((session.state.blocks[0] as { effectiveMessageIds: string[] }).effectiveMessageIds);
        reconcileFoldCoverage(session, originals, makeOpts());
        const r2 = reconcileFoldCoverage(session, prunedPass(originals, t1), { ...makeOpts(), mode: "warn" });
        assert.equal(r2.kind, "unmatched", "warn mode never repairs");
        assert.equal(r2.byPrune, 1, "evidence still counted");
        assert.equal(JSON.stringify((session.state.blocks[0] as { effectiveMessageIds: string[] }).effectiveMessageIds), before, "blocks untouched");
        assert.equal(conflictEventsOf(session).filter((e) => e.kind === "host-content-mutation").length, 1, "visibility does not depend on repair mode");
    });

    test("store unavailable: graceful degradation to honest unmatched, no ledger event", () => {
        const { t1, originals, session } = fixture();
        _setStoreForTest(new SessionStore({ enabled: false }));
        reconcileFoldCoverage(session, originals, makeOpts());
        const r2 = reconcileFoldCoverage(session, prunedPass(originals, t1), makeOpts());
        assert.equal(r2.byPrune, 0, "no stored original → no guess");
        assert.equal(r2.unmatched, 1);
        assert.equal(conflictEventsOf(session).length, 0, "unverified mutation is not confirmed evidence");
    });

    test("no marker on the wire: zero storage reads (steady-state contract)", () => {
        const { t1, originals, session } = fixture();
        const calls: number[] = [];
        _setStoreForTest(storeWithRows([{ seq: 1, msgId: "t1", content: JSON.stringify(t1) }], calls));
        reconcileFoldCoverage(session, originals, makeOpts());
        assert.deepEqual(calls, [], "a marker-free pass never touches the index");
    });
});
