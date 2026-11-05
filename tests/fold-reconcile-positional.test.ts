// [#2480] Positional fold identity — Pass 0 tests.
//
// Identity paradigm shift: the fold's ownership evidence is POSITION in the
// resent array (backed by bili's self-stored canonical fingerprint copy,
// `foldPositions`, aligned 1:1 with `foldAnchorOrder`), while content shrinks
// to a per-cell confidence comparator (role+toolName+canonical text; the
// protocol-volatile toolCallId/contentType are stripped). A codec switch
// re-serializes every message → every content-hash id churns (#2454) → the
// old anchor passes whiff; Pass 0 realigns by index and keeps coverage.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    canonicalJson,
    canonicalTextOf,
    positionalFingerprint,
    planReconciliation,
    reconcileFoldCoverage,
    resetPositionalFingerprintWork,
    positionalFingerprintWorkCount,
    type FoldAnchor,
    type ReconcileOptions,
} from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}
function anchorOf(m: CoreMessage): FoldAnchor {
    const a: FoldAnchor = { n: `norm:${m.id}`, r: m.role, b: m.text?.length ?? 0 };
    if (m.toolCallId) a.t = m.toolCallId;
    return a;
}
function fakeSession(blocks: { effectiveMessageIds: string[]; directMessageIds?: string[] }[]): Session {
    return {
        state: { blocks: blocks.map((b) => ({ active: true, blockId: `blk-${Math.random().toString(36).slice(2)}`, ...b })) },
        metadata: {},
    } as unknown as Session;
}
const opts = (mode?: "off" | "warn" | "repair"): ReconcileOptions => ({ mode, sessionId: "s1", log: () => {} });

describe("canonical projection (#2480)", () => {
    test("canonicalJson is key-order and whitespace invariant", () => {
        const a = canonicalJson(JSON.parse('{"b":1,"a":{"d":1,"c":2}}'));
        const b = canonicalJson(JSON.parse('{\n  "a": { "c": 2, "d": 1 },\n  "b": 1\n}'));
        assert.equal(a, b);
    });
    test("canonicalTextOf: re-serialized JSON payloads project identically", () => {
        const a = canonicalTextOf('{"query":"find files","limit":10}');
        const b = canonicalTextOf('{ "limit":  10, "query": "find files" }');
        assert.equal(a, b);
    });
    test("canonicalTextOf: prose and XML-ish payloads keep raw bytes", () => {
        assert.equal(canonicalTextOf("just prose"), "just prose");
        assert.equal(canonicalTextOf("<result>ok</result>"), "<result>ok</result>");
        // trailing non-JSON disqualifies the JSON fast path entirely
        const weird = '{"a":1} trailing';
        assert.equal(canonicalTextOf(weird), weird);
    });
    test("fingerprint excludes toolCallId, normalizes content; reasoning is an id-carrier", () => {
        const a = positionalFingerprint(msg("h1", "assistant", '{"cmd":"ls"}', { toolName: "bash", toolCallId: "call_A", contentType: "tool-call" }));
        const b = positionalFingerprint(msg("h2", "assistant", '{ "cmd": "ls" }', { toolName: "bash", toolCallId: "toolu_B", contentType: "tool-call" }));
        assert.equal(a, b, "codec re-serialization + id scheme rewrite must not move the fingerprint");
        const c = positionalFingerprint(msg("h3", "assistant", '{"cmd":"ls -la"}', { toolName: "bash", toolCallId: "call_A", contentType: "tool-call" }));
        assert.notEqual(a, c, "a real edit is a real mismatch");
        const d = positionalFingerprint(msg("h4", "user", '{"cmd":"ls"}', { toolName: "bash", toolCallId: "call_A", contentType: "tool-call" }));
        assert.notEqual(a, d, "role participates");
        // reasoning core text IS the provider item id (responses adapter), so
        // the fingerprint deliberately ignores it: churning rs_0→alt_rs_0 must
        // not move the pairing (kind changes, though, are structural — see
        // codecSwitch()).
        const r1 = positionalFingerprint(msg("r1", "assistant", "rs_0", { contentType: "reasoning" }));
        const r2 = positionalFingerprint(msg("r2", "assistant", "alt_rs_0", { contentType: "reasoning" }));
        assert.equal(r1, r2, "reasoning id churn must not move the fingerprint");
        const r3 = positionalFingerprint(msg("r3", "user", "rs_0", { contentType: "reasoning" }));
        assert.notEqual(r1, r3, "role still participates for reasoning");
    });
    test("pathological nesting never throws (falls back to raw bytes)", () => {
        const deep = "[".repeat(50000) + "]".repeat(50000);
        assert.equal(typeof positionalFingerprint(msg("d", "user", deep)), "string");
    });
});

/** Build a #2454-shaped history: mixed roles, tool messages with JSON args. */
function oldHistory(): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < 10; i++) {
        if (i % 3 === 1) {
            out.push(msg(`old_${i}`, "assistant", `{"query":"step ${i}","limit":${i}}`, {
                contentType: "tool-call", toolName: "search", toolCallId: `call_x|fc_${i}`,
            }));
        } else {
            out.push(msg(`old_${i}`, i % 2 === 0 ? "user" : "assistant", `message number ${i} body text`));
        }
    }
    return out;
}

/** Re-serialize through a "different codec": new ids, new toolCallId scheme,
 *  new contentType literal, re-encoded JSON arguments. Content is identical.
 *  `idPrefix` distinguishes drift generations so their ids never collide. */
function codecSwitch(old: CoreMessage[], editIndex?: number, idPrefix = "new"): CoreMessage[] {
    return old.map((m, i) => {
        const text = i === editIndex ? `${m.text} EDITED` : m.text;
        if (m.toolCallId === undefined) return msg(`${idPrefix}_${i}`, m.role, text ?? "", { contentType: "text" });
        const parsed = JSON.parse(m.text ?? "{}") as Record<string, unknown>;
        const reserialized = Object.keys(parsed).reverse().map((k) => `${JSON.stringify(k)}:${JSON.stringify(parsed[k])}`).join(", ");
        // contentType stays "tool-call": real wire adapters normalize item kinds
        // onto the core kinds (anthropic tool_use / openai function / responses
        // function_call all land as tool-call), and the #2480 fingerprint is
        // deliberately kind-sensitive — a message CHANGING kind is a
        // structural edit Pass 0 must refuse to bridge. Reasoning is the one
        // kind whose core text is the provider item id itself (id-carrier),
        // handled explicitly in positionalFingerprint().
        return msg(`${idPrefix}_${i}`, m.role, `{${reserialized}}`, {
            contentType: "tool-call", toolName: m.toolName, toolCallId: `call_x_fc_${i}`,
        });
    });
}

function planFor(old: CoreMessage[], next: CoreMessage[], positions?: { ids: string[]; canon: string[] }) {
    const order = old.map((m) => m.id as string);
    const anchors: Record<string, FoldAnchor> = {};
    for (const m of old) anchors[m.id as string] = anchorOf(m);
    const covered = new Set(order);
    return { plan: planReconciliation(order, anchors, next, covered, positions), order, covered, anchors };
}

/** The stored-copy form reconcileFoldCoverage persists after a pass over
 *  `msgs` (ids + fingerprints of THAT pass, pre-churn). */
function storedOf(msgs: CoreMessage[]): { ids: string[]; canon: string[] } {
    return { ids: msgs.map((m) => m.id as string), canon: msgs.map((m) => positionalFingerprint(m)) };
}

describe("planReconciliation Pass 0 (#2480)", () => {
    test("codec switch: full re-serialization is claimed positionally, zero anchor-pass work", () => {
        const old = oldHistory();
        const pos = storedOf(old);
        const { plan } = planFor(old, codecSwitch(old), pos);
        assert.equal(plan.pass0Desync, undefined, "aligned copy must not flag a desync");
        assert.equal(plan.byPos, 10, "every covered id claimed at its position");
        assert.equal(plan.byTool, 0, "rewritten toolCallId scheme defeats the tool pass — positional did the work");
        assert.equal(plan.byNorm, 0, "changed contentType literal defeats the norm pass — positional did the work");
        assert.equal(plan.unmatched.length, 0);
        for (let i = 0; i < 10; i++) assert.deepEqual(plan.claims.get(`old_${i}`), [`new_${i}`]);
    });

    test("without the stored copy the same churn falls to the old heuristics (and the pass rebuilds the copy)", () => {
        const old = oldHistory();
        const { plan } = planFor(old, codecSwitch(old), undefined);
        assert.equal(plan.byPos, 0);
        // legacy behavior preserved: toolCallId rewritten + contentType changed
        // → nothing claims, everything re-enters unfolded (the #2454 bug class)
        assert.equal(plan.unmatched.length, 10);
    });

    test("append-only resend with stored copy claims nothing and hashes only the appended tail", () => {
        const old = oldHistory();
        const pos = storedOf(old);
        resetPositionalFingerprintWork();
        const { plan } = planFor(old, old, pos);
        assert.equal(plan.claims.size, 0);
        assert.equal(positionalFingerprintWorkCount(), 0, "same id at same index → stored fingerprint reused, zero hashing");
        const { plan: plan2 } = planFor(old, [...old, msg("extra_1", "user", "new turn"), msg("extra_2", "assistant", "reply")], pos);
        assert.equal(plan2.claims.size, 0);
        assert.equal(positionalFingerprintWorkCount(), 2, "only the appended messages hash — the resent prefix is free");
    });

    test("mid-history edit inside verified flanks: the order bracket claims the slot (#2915 owner rule)", () => {
        const old = oldHistory();
        const pos = storedOf(old);
        const { plan } = planFor(old, codecSwitch(old, 5), pos);
        // head claims 0-4, tail claims 6-9; the edited 5 sits at the SAME
        // index between two VERIFIED runs — owner rule 2026-10-12: none of
        // the content channels match, but the flanks do → the fold asserts
        // the SLOT, not the stale bytes.
        assert.equal(plan.byPos, 9);
        assert.equal(plan.byOrder, 1);
        assert.equal(plan.unmatched.length, 0);
        assert.deepEqual(plan.claims.get("old_0"), ["new_0"]);
        assert.deepEqual(plan.claims.get("old_9"), ["new_9"]);
        assert.deepEqual(plan.claims.get("old_5"), ["new_5"], "bracketed edit keeps coverage — no island loss");
    });

    test("mid-history edit WITHOUT a verified far flank stays honestly unmatched (no guessing)", () => {
        const old = oldHistory();
        const pos = storedOf(old);
        // cells 5..9 ALL rewritten: head claims 0-4, the tail scan finds no
        // 3-run agreement anywhere — old_5 is NOT bracketed (no verified
        // claim beyond it), so no tier may claim it.
        const switched = codecSwitch(old);
        for (let i = 5; i <= 9; i++) switched[i] = msg(`new_${i}`, "user", `completely different body ${i}`);
        const { plan } = planFor(old, switched, pos);
        assert.equal(plan.byPos, 5, "only the verified head span claims");
        assert.equal(plan.byOrder, 0, "unbracketed — the bracket tier must stay silent");
        assert.equal(plan.unmatched.length, 5);
        assert.equal(plan.claims.get("old_5"), undefined);
    });

    test("insertion inside the churn region: dual scans still realign both flanks", () => {
        const old = oldHistory();
        const pos = storedOf(old);
        const switched = codecSwitch(old);
        const next = [...switched.slice(0, 5), msg("ins_0", "user", "brand new inserted turn"), ...switched.slice(5)];
        const { plan } = planFor(old, next, pos);
        assert.equal(plan.byPos, 10);
        assert.equal(plan.unmatched.length, 0);
        assert.deepEqual(plan.claims.get("old_4"), ["new_4"]);
        assert.deepEqual(plan.claims.get("old_5"), ["new_5"]);
    });

    test("deleting one of two identical messages leaves exactly one unmatched", () => {
        const old = [
            ...oldHistory().slice(0, 4),
            msg("dup_a", "user", "ok"),
            msg("dup_b", "user", "ok"),
            ...oldHistory().slice(6),
        ];
        const pos = storedOf(old);
        const switched = codecSwitch(old);
        const next = [...switched.slice(0, 4), switched[4], ...switched.slice(6)]; // drop one twin
        const { plan } = planFor(old, next, pos);
        assert.equal(plan.unmatched.length, 1, "the deleted twin is honestly unmatched");
        assert.equal(plan.claims.size, 9);
        // the surviving twin is claimed onto the identical-content survivor
        assert.ok(plan.claims.get("dup_a")?.[0] === "new_4" || plan.claims.get("dup_b")?.[0] === "new_4");
    });

    test("client-native compaction + codec switch: tail keeps coverage, head is honestly lost", () => {
        const old = [
            ...oldHistory(),
            msg("old_10", "user", "tail turn one"),
            msg("old_11", "assistant", "tail turn two"),
        ];
        const pos = storedOf(old);
        const compacted = [
            msg("summary_0", "assistant", "[compacted summary of the first half]"),
            ...codecSwitch(old.slice(6)),
        ];
        const { plan } = planFor(old, compacted, pos);
        // head scan stops at the summary; tail scan claims the 6 survivors
        assert.equal(plan.byPos, 6);
        for (let i = 6; i < 12; i++) assert.deepEqual(plan.claims.get(`old_${i}`), [`new_${i - 6}`]);
        // the compacted-away head is honestly unmatched — no death spiral claim
        const headUnmatched = plan.unmatched.filter((id) => Number(id.slice(4)) < 6);
        assert.equal(headUnmatched.length, 6);
    });

    test("prose whitespace churn keeps the pairing (#2487 discipline)", () => {
        const old = [
            msg("p_0", "user", "hello   world\r\nsecond   line"),
            msg("p_1", "assistant", "answer"),
            msg("p_2", "user", "done"),
        ];
        const churned = [
            msg("q_0", "user", "hello world\nsecond line"), // whitespace collapsed, CR→LF
            msg("q_1", "assistant", "answer"),
            msg("q_2", "user", "done"),
        ];
        const { plan } = planFor(old, churned, storedOf(old));
        assert.equal(plan.byPos, 3, "formatting churn must not break the positional pairing");
        // …but a REAL edit still mismatches
        const edited = [msg("q_0", "user", "hello world\nsecond line EDITED"), churned[1]!, churned[2]!];
        const { plan: plan2 } = planFor(old, edited, storedOf(old));
        assert.equal(plan2.byPos, 2);
        assert.deepEqual(plan2.unmatched, ["p_0"]);
    });

    test("reuse-by-id fast path: surviving ids pay zero hashes even when positions shift", () => {
        const old = oldHistory();
        // head deletion: every surviving id SHIFTS left — same-index reuse would
        // recompute all of them, reuse-by-id reuses all of them.
        const shifted = old.slice(1);
        const pos = storedOf(old); // counted BEFORE the seam reset
        resetPositionalFingerprintWork();
        const { plan } = planFor(old, shifted, pos);
        assert.equal(positionalFingerprintWorkCount(), 0, "surviving ids reuse their stored canon wherever they sit");
        assert.ok(plan.nextCanon !== undefined && plan.nextCanon.every((c) => typeof c === "string"));
    });

    test("desync guard: a stored copy whose ids no longer match the backbone disables Pass 0 (self-containment)", () => {
        const old = oldHistory();
        const drifted = codecSwitch(old);
        const wrong = { ids: [...old.map((m) => m.id as string)].reverse(), canon: old.map((m) => positionalFingerprint(m)) };
        const { plan } = planFor(old, drifted, wrong);
        assert.equal(plan.byPos, 0, "misaligned copy must not claim");
        assert.ok(plan.unmatched.length > 0, "honest fallback to the legacy passes");
        assert.equal(plan.pass0Desync, true, "#4390 p3: the silent Pass-0 degrade must be flagged for logging");
    });

    test("legacy plain-canon[] storage from the #2488 merge window still reconciles", () => {
        const old = oldHistory();
        const drifted = codecSwitch(old);
        const order = old.map((m) => m.id as string);
        const anchors: Record<string, FoldAnchor> = {};
        for (const m of old) anchors[m.id as string] = anchorOf(m);
        const covered = new Set(order);
        // pre-#2487 shape: bare canon array, aligned with the backbone
        const plan = planReconciliation(order, anchors, drifted, covered, { ids: order, canon: old.map((m) => positionalFingerprint(m)) });
        assert.equal(plan.byPos, 10);
    });
});

describe("reconcileFoldCoverage positional wiring (#2480)", () => {
    test("full lifecycle: steady pass stores the copy, codec switch repairs by position, next pass self-heals", () => {
        const old = oldHistory();
        const session = fakeSession([{ effectiveMessageIds: old.map((m) => m.id as string) }]);
        // Pass 1 — steady state: establishes anchors/order/positions copy.
        resetPositionalFingerprintWork();
        const r1 = reconcileFoldCoverage(session, old, opts("repair"));
        assert.equal(r1.kind, "resend");
        const stored1 = session.metadata.foldPositions as { ids: string[]; canon: string[] };
        assert.ok(Array.isArray(stored1.ids) && Array.isArray(stored1.canon), "self-contained {ids, canon} shape (#2487)");
        assert.equal(stored1.ids.length, 10);
        assert.deepEqual(stored1.ids, session.metadata.foldAnchorOrder as string[]);
        assert.equal(stored1.canon.length, 10);

        // Pass 2 — codec switch: positional claims repair the blocks.
        const next = codecSwitch(old);
        const r2 = reconcileFoldCoverage(session, next, opts("repair"));
        assert.equal(r2.kind, "reanchored");
        assert.equal(r2.byPos, 10);
        assert.equal(r2.unmatched, 0);
        const coveredNow = (session.state.blocks as { effectiveMessageIds: string[] }[])[0].effectiveMessageIds;
        assert.deepEqual(coveredNow.sort(), next.map((m) => m.id as string).sort());
        // the copy rolled forward to the new ids (aligned with the new order)
        const stored2 = session.metadata.foldPositions as { ids: string[]; canon: string[] };
        assert.deepEqual(stored2.canon, next.map((m) => positionalFingerprint(m)));
        assert.deepEqual(stored2.ids, next.map((m) => m.id as string));

        // Pass 3 — append on the new ids: steady again; only the appended
        // message hashes (resent prefix rides the fast path).
        resetPositionalFingerprintWork();
        const r3 = reconcileFoldCoverage(session, [...next, msg("post_1", "user", "later turn")], opts("repair"));
        assert.equal(r3.kind, "resend");
        assert.equal(positionalFingerprintWorkCount(), 1, "one hash for the one appended message");
    });

    test("legacy session without foldPositions: steady pass rebuilds the copy, so the NEXT drift is fully positional (migration is free)", () => {
        const old = oldHistory();
        const session = fakeSession([{ effectiveMessageIds: old.map((m) => m.id as string) }]);
        // Seed only anchors/order the legacy way (no positions key).
        reconcileFoldCoverage(session, old, opts("repair"));
        assert.ok(Array.isArray((session.metadata.foldPositions as { ids: string[] }).ids), "copy established on the very first steady pass");
        delete session.metadata.foldPositions; // simulate the pre-upgrade state
        reconcileFoldCoverage(session, old, opts("repair")); // steady pass rebuilds it
        assert.ok(Array.isArray((session.metadata.foldPositions as { canon: string[] }).canon));
        const drift = codecSwitch(old);
        const r = reconcileFoldCoverage(session, drift, opts("repair"));
        assert.equal(r.byPos, 10);
        assert.equal(r.unmatched, 0);
    });

    test("upgrade landing mid-drift-episode: recovery is partial but honest, and never worse than legacy", () => {
        const old = oldHistory();
        const session = fakeSession([{ effectiveMessageIds: old.map((m) => m.id as string) }]);
        reconcileFoldCoverage(session, old, opts("repair"));
        delete session.metadata.foldPositions;
        // Drift A — copy missing: the legacy anchor passes still claim the
        // plain-text messages (contentType/normalized text unchanged), but the
        // three tool messages (toolCallId scheme + args re-encoded + literal
        // contentType churn) are exactly the #2454 residue.
        const driftA = codecSwitch(old, undefined, "a");
        const rA = reconcileFoldCoverage(session, driftA, opts("repair"));
        assert.equal(rA.byPos, 0);
        assert.equal(rA.byNorm, 7);
        assert.equal(rA.unmatched, 3);
        assert.ok(Array.isArray((session.metadata.foldPositions as { canon: string[] }).canon), "copy built from driftA bytes");
        // Drift B — another codec hop: the 7 reanchored ids are now positional;
        // the 3 legacy remnants (still keyed by their pre-upgrade ids) honestly
        // stay unmatched — blocks keep them, the #2193 machinery reports.
        const driftB = codecSwitch(driftA, undefined, "b");
        const rB = reconcileFoldCoverage(session, driftB, opts("repair"));
        assert.equal(rB.byPos, 7);
        assert.equal(rB.unmatched, 3);
    });

    test("compaction + codec switch: surviving tail blocks stay covered (graceful landing), streak then resets on recovery", () => {
        const old = [
            ...oldHistory(),
            ...Array.from({ length: 6 }, (_, i) => msg(`old_${10 + i}`, i % 2 === 0 ? "user" : "assistant", `tail turn ${i} body`)),
        ];
        const session = fakeSession([{ effectiveMessageIds: old.map((m) => m.id as string) }]);
        reconcileFoldCoverage(session, old, opts("repair"));
        // compaction replaces the head with a summary and replays the tail —
        // conversation-sized payload (>=10), so the pass qualifies as evidence
        const compacted = [msg("summary_0", "assistant", "[compacted summary]"), ...codecSwitch(old.slice(6))];
        const r = reconcileFoldCoverage(session, compacted, opts("repair"));
        assert.equal(r.byPos, 10);
        assert.equal(r.unmatched, 6, "compacted-away head honestly lost, tail kept");
        const coveredNow = (session.state.blocks as { effectiveMessageIds: string[] }[])[0].effectiveMessageIds;
        const tailIds = compacted.slice(1).map((m) => m.id as string);
        for (const id of tailIds) assert.ok(coveredNow.includes(id), `tail id ${id} stays covered`);
        // #3641 doctrine: the compacted-away head is a sanctioned host-side
        // deletion (summary + surviving tail = wire suffix-continuation of the
        // previous order). The fold keeps the snapshot, no drift streak ever
        // starts, and one benign truncation note is latched for the panel.
        const r2 = reconcileFoldCoverage(session, [...compacted, msg("post_1", "user", "resume")], opts("repair"));
        assert.equal(r2.byPos, 0);
        assert.equal(session.metadata.foldDriftStreak, undefined, "#3641: sanctioned compaction never starts the collapse streak");
        assert.equal(session.metadata.foldTruncationNoted, true, "one benign truncation note is latched");
    });

    test("side-request-shaped passes take no positional evidence", () => {
        const old = oldHistory();
        const session = fakeSession([{ effectiveMessageIds: old.map((m) => m.id as string) }]);
        reconcileFoldCoverage(session, old, opts("repair"));
        const before = JSON.stringify(session.metadata.foldPositions);
        reconcileFoldCoverage(session, codecSwitch(old.slice(0, 5)), opts("repair"));
        assert.equal(JSON.stringify(session.metadata.foldPositions), before, "short pass must not roll the copy onto side-request ids");
    });

    test("warn mode computes positional claims but does not rewrite blocks", () => {
        const old = oldHistory();
        const session = fakeSession([{ effectiveMessageIds: old.map((m) => m.id as string) }]);
        reconcileFoldCoverage(session, old, opts("repair"));
        const before = JSON.stringify((session.state.blocks as { effectiveMessageIds: string[] }[])[0].effectiveMessageIds);
        const r = reconcileFoldCoverage(session, codecSwitch(old), opts("warn"));
        assert.equal(r.byPos, 10);
        assert.equal(JSON.stringify((session.state.blocks as { effectiveMessageIds: string[] }[])[0].effectiveMessageIds), before);
    });

    test("repair log line names the positional pass", () => {
        const old = oldHistory();
        const session = fakeSession([{ effectiveMessageIds: old.map((m) => m.id as string) }]);
        reconcileFoldCoverage(session, old, opts("repair"));
        const lines: string[] = [];
        reconcileFoldCoverage(session, codecSwitch(old), { mode: "repair", sessionId: "s1", log: (_l, m) => lines.push(m) });
        assert.ok(lines.some((l) => l.includes("10 positional")), lines.join("\n"));
    });
});
