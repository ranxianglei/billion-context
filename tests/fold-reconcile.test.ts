import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeMessageText,
    normalizedIdentity,
    normalizedIdentityNoToolCallId,
    planReconciliation,
    reconcileFoldCoverage,
    resolveFoldReconcileMode,
    noteSystemPromptFingerprint,
    METADATA_FOLD_COVERAGE,
    resetNormalizedIdentityWork,
    turnContexts,
    normalizedIdentityWorkCount,
    type FoldAnchor,
    type FoldBlockCoverage,
    type ReconcileOptions,
} from "../src/fold-reconcile.ts";
import { defaultCountTokens } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}

function anchorOf(m: CoreMessage): FoldAnchor {
    const a: FoldAnchor = { n: normalizedIdentity(m), r: m.role, b: m.text?.length ?? 0 };
    if (m.toolCallId) {
        a.t = m.toolCallId;
        a.m = normalizedIdentityNoToolCallId(m);
    }
    return a;
}

describe("normalizeMessageText (#1921)", () => {
    test("collapses CRLF, trailing spaces, and blank-line runs", () => {
        assert.equal(normalizeMessageText("hello  world\r\n\r\nnext \t line\n\n\nend  "), "hello world\nnext line\nend");
    });
    test("empty and undefined normalize to empty", () => {
        assert.equal(normalizeMessageText(undefined), "");
        assert.equal(normalizeMessageText(""), "");
    });
    test("NFC-composes equivalent unicode", () => {
        const decomposed = "cafe\u0301"; // e + combining acute
        const composed = "caf\u00e9"; // precomposed é
        assert.equal(normalizeMessageText(decomposed), normalizeMessageText(composed));
    });
    test("real edits survive normalization", () => {
        assert.notEqual(normalizeMessageText("please analyze module 2"), normalizeMessageText("please analyze module 2X"));
    });
});

describe("resolveFoldReconcileMode (#1921)", () => {
    test("env beats config beats default repair", () => {
        assert.equal(resolveFoldReconcileMode({} as NodeJS.ProcessEnv), "repair");
        assert.equal(resolveFoldReconcileMode({}, "warn"), "warn");
        assert.equal(resolveFoldReconcileMode({ BILI_FOLD_RECONCILE: "off" } as NodeJS.ProcessEnv, "repair"), "off");
    });
    test("invalid env falls back to config", () => {
        assert.equal(resolveFoldReconcileMode({ BILI_FOLD_RECONCILE: "sometimes" } as NodeJS.ProcessEnv, "warn"), "warn");
    });
});

describe("planReconciliation (#1921)", () => {
    const u1 = "u1", u2 = "u2", u3 = "u3";
    const oldMsgs = [
        msg(u1, "user", "first turn"),
        msg(u2, "user", "please analyze module 2"),
        msg(u3, "user", "final turn"),
    ];
    const anchors: Record<string, FoldAnchor> = {};
    for (const m of oldMsgs) anchors[m.id!] = anchorOf(m);
    const covered = new Set([u1, u2, u3]);
    const oldOrder = [u1, u2, u3];

    test("clean resend plans no claims", () => {
        const plan = planReconciliation(oldOrder, anchors, oldMsgs, covered);
        assert.equal(plan.claims.size, 0);
        assert.equal(plan.unmatched.length, 0);
    });

    test("single churned middle message is re-anchored by normalized identity", () => {
        // u2's bytes churned (client re-serialization) -> new id, same words.
        const churned = msg("u2-new", "user", "please analyze  module 2\r\n");
        const plan = planReconciliation(oldOrder, anchors, [oldMsgs[0], churned, oldMsgs[2]], covered);
        assert.deepEqual(plan.claims.get(u2), ["u2-new"]);
        assert.equal(plan.byNorm, 1);
        assert.equal(plan.unmatched.length, 0);
    });

    test("real edit of a covered message stays unmatched (honest re-entry)", () => {
        const edited = msg("u2-edited", "user", "please analyze module 2X");
        const plan = planReconciliation(oldOrder, anchors, [oldMsgs[0], edited, oldMsgs[2]], covered);
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(plan.unmatched, [u2]);
    });

    test("toolCallId anchor claims churned tool results across byte changes", () => {
        const oldTool = msg("t1", "tool_result", '{"rows":[1,2, 3]}', { toolCallId: "toolu_01ABC", toolName: "query" });
        const anchorsT = { t1: anchorOf(oldTool) };
        const churnedTool = msg("t1-new", "tool_result", '{"rows": [1, 2, 3]}', { toolCallId: "toolu_01ABC", toolName: "query" });
        const plan = planReconciliation(["t1"], anchorsT, [churnedTool], new Set(["t1"]));
        assert.deepEqual(plan.claims.get("t1"), ["t1-new"]);
        assert.equal(plan.byTool, 1);
    });

    test("duplicate-cluster shift claims the survivors, leaves the deleted one unmatched", () => {
        const mk = (id: string) => msg(id, "tool_result", "(no content)", { toolCallId: `call-${id}` });
        const dupes = ["d1", "d2", "d3"].map(mk);
        const anchorsD: Record<string, FoldAnchor> = {};
        for (const m of dupes) anchorsD[m.id!] = anchorOf(m);
        // client deleted d2's sibling d1: identical survivors re-serialized with new ids
        const survivors = [msg("d2-new", "tool_result", "(no content)", { toolCallId: "call-d2" }),
                           msg("d3-new", "tool_result", "(no content)", { toolCallId: "call-d3" })];
        const plan = planReconciliation(["d1", "d2", "d3"], anchorsD, survivors, new Set(["d1", "d2", "d3"]));
        // tool anchors are authoritative: d2 -> d2-new, d3 -> d3-new, d1 (deleted) unmatched
        assert.deepEqual(plan.claims.get("d2"), ["d2-new"]);
        assert.deepEqual(plan.claims.get("d3"), ["d3-new"]);
        assert.deepEqual(plan.unmatched, ["d1"]);
    });

    test("norm-ordinal pairing without tool ids: k-th to k-th inside the churn region", () => {
        const ids = ["n1", "n2", "n3"];
        const anchorsN: Record<string, FoldAnchor> = {};
        for (const id of ids) anchorsN[id] = anchorOf(msg(id, "user", "ok"));
        // identical texts, no tool ids, one deleted (n2), survivors churned
        const survivors = [msg("n1-new", "user", " ok"), msg("n3-new", "user", "ok ")];
        const plan = planReconciliation(ids, anchorsN, survivors, new Set(ids));
        // k-th-to-k-th pairing: after deleting n2, the survivor n3 IS the 2nd
        // occurrence — its content (identical to n2) stays covered, and the
        // truly-deleted ordinal is the unmatched one.
        assert.deepEqual(plan.claims.get("n1"), ["n1-new"]);
        assert.deepEqual(plan.claims.get("n2"), ["n3-new"]);
        assert.deepEqual(plan.unmatched, ["n3"]);
        // both survivors end up covered: zero identical-content loss
        const coveredNow = new Set([...plan.claims.values()].flat());
        assert.deepEqual([...coveredNow].sort(), ["n1-new", "n3-new"].sort());
    });

    test("appended turns are never claimed", () => {
        const fresh = msg("fresh", "user", "a brand new turn");
        const plan = planReconciliation(oldOrder, anchors, [...oldMsgs, fresh], covered);
        assert.equal(plan.claims.size, 0);
        assert.equal(plan.unmatched.length, 0);
    });

    test("length guard rejects same-norm different-scale candidates", () => {
        // Same normalized identity as the anchor ("x" — non-newline whitespace
        // collapses and trims away), but raw length drifts far beyond
        // max(256, b>>2): the guard in the norm-pairing path must reject before
        // the ordinal pairing can claim it (#1930: this is the only defense
        // against a same-norm/different-scale false match).
        const anchorsL = { big: { n: normalizedIdentity(msg("big", "user", "x")), r: "user", b: 1 } };
        const incoming = [msg("big-new", "user", "x" + " ".repeat(10_000))];
        const plan = planReconciliation(["big"], anchorsL, incoming, new Set(["big"]));
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(plan.unmatched, ["big"]);
    });

    test("length guard accepts same-norm candidates within tolerance", () => {
        // Control side of the branch: identical norm, raw delta 200 <= max(256, b>>2)
        // -> the guard passes and k-th-to-k-th pairing claims the churn.
        const anchorsL = { big: { n: normalizedIdentity(msg("big", "user", "hello world")), r: "user", b: 11 } };
        const incoming = [msg("big-new", "user", "hello world" + " ".repeat(200))];
        const plan = planReconciliation(["big"], anchorsL, incoming, new Set(["big"]));
        assert.deepEqual(plan.claims.get("big"), ["big-new"]);
        assert.equal(plan.byNorm, 1);
    });

    test("covered-present ids inside the churn region are not claimable twice", () => {
        // u2 churns AND u1 moves after it (reorder) — u1 is present, must not be claimed
        const churned = msg("u2-new", "user", "please analyze module 2");
        const plan = planReconciliation(oldOrder, anchors, [churned, oldMsgs[0], oldMsgs[2]], covered);
        assert.deepEqual(plan.claims.get(u2), ["u2-new"]);
        assert.equal(plan.unmatched.includes(u1), false);
    });

    // #2283 sub-defect 3 / #1921: expose a token estimate of the re-entering unfolded
    // mass so the fold-rollback growth contribution is quantifiable offline.
    test("clean resend leaves churn token fields unset (no drift path)", () => {
        const plan = planReconciliation(oldOrder, anchors, oldMsgs, covered);
        assert.equal(plan.churnTokens, undefined);
        assert.equal(plan.claimedChurnTokens, undefined);
    });

    test("reanchored churn reports churn tokens equal to claimed tokens", () => {
        const churnedText = "please analyze  module 2\r\n";
        const churned = msg("u2-new", "user", churnedText);
        const plan = planReconciliation(oldOrder, anchors, [oldMsgs[0], churned, oldMsgs[2]], covered);
        assert.ok(typeof plan.churnTokens === "number" && typeof plan.claimedChurnTokens === "number");
        assert.equal(plan.churnTokens, defaultCountTokens(churnedText));
        assert.equal(plan.claimedChurnTokens, defaultCountTokens(churnedText), "claimed candidate is the only churn-region message");
        assert.ok(plan.claimedChurnTokens! <= plan.churnTokens!, "claimed never exceeds total churn");
    });

    test("unmatched real edit reports full churn tokens and zero claimed", () => {
        const editedText = "please analyze module 2X";
        const edited = msg("u2-edited", "user", editedText);
        const plan = planReconciliation(oldOrder, anchors, [oldMsgs[0], edited, oldMsgs[2]], covered);
        assert.equal(plan.churnTokens, defaultCountTokens(editedText));
        assert.equal(plan.claimedChurnTokens, 0, "nothing re-anchored -> no claimed mass");
    });
});

describe("reconcileFoldCoverage (#1921)", () => {
    function fakeSession(blocks: { effectiveMessageIds: string[]; directMessageIds?: string[] }[]): Session {
        return {
            state: { blocks: blocks.map((b) => ({ active: true, ...b })) },
            metadata: {},
        } as unknown as Session;
    }
    const opts = (mode?: "off" | "warn" | "repair"): ReconcileOptions & { mode?: "off" | "warn" | "repair" } =>
        ({ mode, sessionId: "s1", log: () => {} });

    test("off mode is a no-op", () => {
        const session = fakeSession([{ effectiveMessageIds: ["a"] }]);
        const before = JSON.stringify(session.state.blocks);
        const result = reconcileFoldCoverage(session, [msg("b", "user", "changed")], opts("off"));
        assert.equal(result.kind, "off");
        assert.equal(JSON.stringify(session.state.blocks), before);
    });

    // #2202: passes carry a conversation-sized payload (>=10 msgs) — real hosts
    // resend their full history every turn; side-request-shaped short passes take
    // no evidence at all (see the guard in reconcileFoldCoverage).
    const tenMsgs = (prefix: string, text: (i: number) => string): CoreMessage[] =>
        Array.from({ length: 10 }, (_, i) => msg(`${prefix}${i}`, "user", text(i)));

    test("repair rewrites block ids and refreshes anchors", () => {
        const originals = tenMsgs("a", (i) => `stable context words ${i}`);
        const allIds = originals.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: allIds, directMessageIds: allIds }]);
        // real sequence: one clean pass seeds anchors+order, the next pass churns
        reconcileFoldCoverage(session, originals, opts("repair"));
        const churned = originals.map((m, i) => (i === 4 ? msg("a4-new", "user", "stable context  words 4\r\n") : m));
        const result = reconcileFoldCoverage(session, churned, opts("repair"));
        assert.equal(result.kind, "reanchored");
        // whitespace-only churn now claims POSITIONALLY (#2487 prose
        // normalization: canon equal after NFC/CR→LF/space-collapse, so Pass 0
        // pairs it; the norm pass no longer needs to)
        assert.equal(result.byPos, 1);
        assert.equal(result.byNorm, 0);
        const rewritten = allIds.map((id, i) => (i === 4 ? "a4-new" : id));
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, rewritten);
        assert.deepEqual(session.state.blocks[0].directMessageIds, rewritten);
        // claimed ids land in lastPassIds so the kernel's remint node
        // (reconcileLiveIdsNode) does not re-mint them before prune
        assert.deepEqual((session.state as { lastPassIds?: string[] }).lastPassIds, ["a4-new"]);
        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        assert.ok(anchors["a4-new"] !== undefined, "anchor keyed by the new id");
        assert.ok(anchors["a4"] === undefined, "old anchor dropped");
        assert.deepEqual(session.metadata.foldAnchorOrder, rewritten);
    });

    test("warn mode computes but never rewrites", () => {
        const originals = tenMsgs("w", (i) => `warn mode context ${i}`);
        const allIds = originals.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: allIds }]);
        reconcileFoldCoverage(session, originals, opts("warn"));
        const churned = originals.map((m, i) => (i === 2 ? msg("w2-new", "user", "warn mode context 2 ") : m));
        const result = reconcileFoldCoverage(session, churned, opts("warn"));
        assert.equal(result.claims, 1);
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, allIds);
    });

    test("clean resend seeds anchors without touching blocks", () => {
        const originals = tenMsgs("c", (i) => `clean resend words ${i}`);
        const allIds = originals.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: allIds }]);
        const result = reconcileFoldCoverage(session, originals, opts("repair"));
        assert.equal(result.kind, "resend");
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, allIds);
        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        for (const id of allIds) assert.ok(anchors[id] !== undefined, `anchor seeded for ${id}`);
    });

    test("system-only fingerprint: change logs, absence does not", () => {
        const session = fakeSession([]);
        const logs: string[] = [];
        const logOpts = { sessionId: "s1", log: (_l: string, m: string) => logs.push(m) };
        noteSystemPromptFingerprint(session, "You are Claude.", logOpts);
        assert.equal(logs.length, 0);
        noteSystemPromptFingerprint(session, [{ type: "text", text: "different" }], logOpts);
        assert.equal(logs.length, 1);
        assert.match(logs[0], /system prompt changed/);
        assert.match(logs[0], /fold state unaffected/);
    });
});

describe("reconcileFoldCoverage drift escalation (#2193)", () => {
    type LogLine = { level: string; msg: string };
    function coveredSession(n: number): Session {
        const ids = Array.from({ length: n }, (_, i) => `c${i}`);
        return {
            state: { blocks: [{ active: true, effectiveMessageIds: ids }] },
            metadata: {},
        } as unknown as Session;
    }
    function makeOpts(logs: LogLine[]): ReconcileOptions & { mode: "repair" } {
        return { sessionId: "s1", mode: "repair", log: (level: string, m: string) => logs.push({ level, msg: m }) };
    }
    const errorLines = (logs: LogLine[]) => logs.filter((l) => l.level === "error");
    // #2202: post-compaction passes carry conversation-sized payloads — real
    // hosts replay their full (shadowed) history, they don't send one message;
    // sub-10-message passes are side-request-shaped and take no evidence.
    const freshPass = (tag: string): CoreMessage[] =>
        Array.from({ length: 10 }, (_, i) => msg(`${tag}${i}`, "assistant", `post-compaction turn ${tag} message ${i} padding`));

    test("persistent total-loss drift escalates to exactly one error naming the suspect cause", () => {
        // #2193 incident shape: a host-native compaction lands outside bili's
        // knowledge; the covered region never rides the wire again and every
        // subsequent turn used to print the identical warn forever (166x in
        // the incident log). After three consecutive zero-reanchor passes the
        // episode must escalate ONCE to an error.
        const n = 12; // above the 10-id escalation floor
        const session = coveredSession(n);
        const originals = Array.from({ length: n }, (_, i) => msg(`c${i}`, "user", `covered text ${i} with enough words`));
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        reconcileFoldCoverage(session, originals, opts);
        assert.equal(errorLines(logs).length, 0);

        for (let pass = 1; pass <= 5; pass++) {
            reconcileFoldCoverage(session, freshPass(`p${pass}`), opts);
        }
        const errs = errorLines(logs);
        assert.equal(errs.length, 1, "exactly ONE error for the whole episode");
        assert.match(errs[0].msg, /compression substrate appears destroyed/);
        assert.match(errs[0].msg, /host-native compaction/);
        assert.match(errs[0].msg, /#2193/);
        // #2297: the per-pass warn now STOPS once the episode escalated —
        // passes 1-2 warn, pass 3's error supersedes its own warn, 4-5 silent.
        assert.equal(logs.filter((l) => l.level === "warn" && /no anchor match/.test(l.msg)).length, 2, "per-pass warns stop after the single escalation error");
    });

    test("a clean pass resets the streak; a later episode escalates again", () => {
        const n = 12;
        const session = coveredSession(n);
        const originals = Array.from({ length: n }, (_, i) => msg(`c${i}`, "user", `covered text ${i} with enough words`));
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        reconcileFoldCoverage(session, originals, opts);
        reconcileFoldCoverage(session, freshPass("p1"), opts);
        reconcileFoldCoverage(session, freshPass("p2"), opts);
        assert.equal(errorLines(logs).length, 0, "streak below threshold stays at warn");
        reconcileFoldCoverage(session, originals, opts);
        assert.equal(session.metadata.foldDriftStreak, undefined, "recovery clears the streak state");
        reconcileFoldCoverage(session, freshPass("q1"), opts);
        reconcileFoldCoverage(session, freshPass("q2"), opts);
        reconcileFoldCoverage(session, freshPass("q3"), opts);
        assert.equal(errorLines(logs).length, 1, "a new episode may escalate again");
    });

    test("small permanent loss below the id floor stays at warn level", () => {
        const session = coveredSession(5);
        const originals = Array.from({ length: 5 }, (_, i) => msg(`c${i}`, "user", `small loss text ${i}`));
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        reconcileFoldCoverage(session, originals, opts);
        for (let pass = 1; pass <= 4; pass++) {
            reconcileFoldCoverage(session, freshPass(`s${pass}`), opts);
        }
        assert.equal(errorLines(logs).length, 0, "5 permanently-missing ids never reach the error floor");
        assert.ok(logs.some((l) => l.level === "warn"));
    });

    test("early exits (no folds / reconcile off) reset the streak instead of inflating a later episode", () => {
        // #2193 follow-up: without the reset on those exits, a stale
        // foldDriftStreak survives an episode boundary and the next episode
        // escalates with an inflated consecutive-pass count.
        const n = 12;
        const session = coveredSession(n);
        const originals = Array.from({ length: n }, (_, i) => msg(`c${i}`, "user", `covered text ${i} with enough words`));
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        reconcileFoldCoverage(session, originals, opts);
        reconcileFoldCoverage(session, freshPass("p1"), opts);
        reconcileFoldCoverage(session, freshPass("p2"), opts);
        assert.equal(session.metadata.foldDriftStreak, 2, "two total-loss passes build a streak");

        // Boundary A: every fold block disappears (e.g. native-compaction
        // archive prune) — the covered set is empty.
        const state = session.state as unknown as { blocks: unknown[] };
        const origBlocks = state.blocks;
        state.blocks = [];
        reconcileFoldCoverage(session, [msg("p3", "assistant", "pass with no folds")], opts);
        assert.equal(session.metadata.foldDriftStreak, undefined, "empty-covered pass clears the streak");

        // Boundary B: reconcile toggled off mid-episode also resets.
        state.blocks = origBlocks;
        reconcileFoldCoverage(session, freshPass("q0"), opts);
        assert.equal(session.metadata.foldDriftStreak, 1);
        reconcileFoldCoverage(session, [msg("q1", "assistant", "x")], { ...opts, mode: "off" });
        assert.equal(session.metadata.foldDriftStreak, undefined, "mode=off pass clears the streak");

        // The fresh episode escalates on its OWN third total-loss pass.
        reconcileFoldCoverage(session, freshPass("q2"), opts);
        reconcileFoldCoverage(session, freshPass("q3"), opts);
        assert.equal(errorLines(logs).length, 0, "stale streak must not pull escalation forward");
        reconcileFoldCoverage(session, freshPass("q4"), opts);
        assert.equal(errorLines(logs).length, 1, "fresh episode escalates on its own third pass");
    });
});

describe("reconcileFoldCoverage coverage evidence + side-request guard (#2202)", () => {
    type LogLine = { level: string; msg: string };
    // #2695: the majority-loss streak reaps blocks on the third consecutive
    // loss pass — reapDestroyedSubstrate calls markDirty, so a disabled store
    // must be injected before any mock session flows through it.
    _setStoreForTest(new SessionStore({ enabled: false }));
    function blockSession(blockId: string, ids: string[]): Session {
        return {
            id: "s-cov",
            state: { blocks: [{ active: true, blockId, effectiveMessageIds: ids }], messageRefs: { byRaw: {}, byRef: {} } },
            metadata: {},
        } as unknown as Session;
    }
    function makeOpts(logs?: LogLine[]): ReconcileOptions & { mode: "repair" } {
        return {
            sessionId: "s2",
            mode: "repair",
            log: logs ? (level: string, m: string) => logs.push({ level, msg: m }) : undefined,
        };
    }
    const covOf = (s: Session) => s.metadata[METADATA_FOLD_COVERAGE] as Record<string, FoldBlockCoverage>;
    const filler = (tag: string, n = 12): CoreMessage[] =>
        Array.from({ length: n }, (_, i) => msg(`${tag}${i}`, "user", `filler turn ${tag} index ${i} padding words`));

    test("records split present/reclaimed/unmatched per block; ever flag latches once verified", () => {
        const session = blockSession("blk1", ["x1", "x2", "x3", "x4", "x5"]);
        const x = (i: number) => msg(`x${i}`, "user", `covered payload ${i} words here`);
        const first = [x(1), x(2), x(3), x(4), x(5), ...filler("f1")];
        reconcileFoldCoverage(session, first, makeOpts());
        let cov = covOf(session)["blk1"];
        assert.ok(cov, "record written on the first qualifying pass");
        assert.deepEqual(cov, { p: 5, r: 0, t: 5, e: 1, z: 0 });
        // Pass 2: x2 churns (claimable via normalized identity), x3 is genuinely
        // edited (unmatchable), the rest ride along verbatim.
        const second = [
            x(1),
            msg("x2-new", "user", "covered payload  2 words here"),
            msg("x3-edited", "user", "completely different content"),
            x(4),
            x(5),
            ...filler("f2"),
        ];
        reconcileFoldCoverage(session, second, makeOpts());
        cov = covOf(session)["blk1"];
        assert.ok(cov);
        assert.equal(cov.p, 3, "x1/x4/x5 present verbatim");
        assert.equal(cov.r, 1, "x2 reclaimed through a claim");
        assert.equal(cov.e, 1);
        // Pass 3: total loss — nothing covered rides the wire anymore. The
        // majority-loss zombie streak (#2695) starts counting: z=1 this pass
        // (pass 2 was fully covered, z reset to 0).
        reconcileFoldCoverage(session, filler("f3"), makeOpts());
        cov = covOf(session)["blk1"];
        assert.ok(cov);
        assert.deepEqual(cov, { p: 0, r: 0, t: 5, e: 1, z: 1 });
    });

    test("never-present class stays unverifiable (structural absence keeps status quo)", () => {
        const session = blockSession("blk2", ["y1", "y2", "y3"]);
        // A host whose resends never carry raw originals: the very first evidence
        // pass already shows everything missing, so the fold can never be
        // verified — booking must stay status quo rather than silently freezing.
        reconcileFoldCoverage(session, filler("g1"), makeOpts());
        const cov = covOf(session)["blk2"];
        assert.ok(cov, "record exists");
        assert.equal(cov.e, undefined, "never observed present → unverifiable");
        assert.equal(cov.p + cov.r, 0);
    });

    test("side-request passes take no evidence, advance no streak, reset nothing", () => {
        const ids = Array.from({ length: 12 }, (_, i) => `z${i}`);
        const session = blockSession("blk3", ids);
        const originals = ids.map((id, i) => msg(id, "user", `shadowable original ${i} words`));
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        reconcileFoldCoverage(session, originals, opts);
        // Two conversation-sized total-loss passes build a streak of 2.
        reconcileFoldCoverage(session, filler("h1"), opts);
        reconcileFoldCoverage(session, filler("h2"), opts);
        assert.equal(session.metadata.foldDriftStreak, 2);
        const covBefore = JSON.stringify(session.metadata[METADATA_FOLD_COVERAGE]);
        const anchorsBefore = JSON.stringify(session.metadata.foldAnchors);
        const orderBefore = JSON.stringify(session.metadata.foldAnchorOrder);
        // Title-gen shaped pass: same session id, a handful of messages.
        const result = reconcileFoldCoverage(session, [msg("t1", "user", "hi"), msg("t2", "assistant", "title"), msg("t3", "user", "more")], opts);
        assert.equal(result.kind, "noop");
        assert.equal(session.metadata.foldDriftStreak, 2, "short pass neither advances nor resets the streak");
        assert.equal(JSON.stringify(session.metadata[METADATA_FOLD_COVERAGE]), covBefore, "coverage records untouched");
        assert.equal(JSON.stringify(session.metadata.foldAnchors), anchorsBefore, "anchors untouched");
        assert.equal(JSON.stringify(session.metadata.foldAnchorOrder), orderBefore, "backbone untouched");
        // The next conversation-sized total-loss pass escalates on its own merit
        // AND completes the #2695 zombie streak (z was 2 before the side pass;
        // h3 makes it 3): the block is reaped — removed from state.blocks, the
        // loss recorded as a conflict event, blockContents semantics preserved
        // by the reap helper (kept, so derived decompress still works).
        const h3 = reconcileFoldCoverage(session, filler("h3"), opts);
        assert.equal(logs.filter((l) => l.level === "error").length, 1);
        assert.equal(h3.reaped, 1, "third consecutive majority-loss pass reaps the zombie block");
        assert.equal(session.state.blocks.length, 0, "reaped block removed from state.blocks");
        assert.ok(!covOf(session)["blk3"], "coverage record for the reaped block dropped");
        const conflict = (session.metadata.conflictEvents as Array<{ kind: string }>)[0];
        assert.equal(conflict?.kind, "orphan-reap");
    });

    test("short passes do not skew the next pass's alignment", () => {
        const ids = Array.from({ length: 10 }, (_, i) => `k${i}`);
        const session = blockSession("blk4", ids);
        const originals = ids.map((id, i) => msg(id, "user", `alignment context ${i} words`));
        const opts = makeOpts();
        reconcileFoldCoverage(session, originals, opts);
        // A title-gen pass sneaks in between two real turns. Without the guard
        // the backbone would roll onto tg1/tg2 and k4 would land outside the
        // aligned churn region → straight to unmatched instead of claimed.
        reconcileFoldCoverage(session, [msg("tg1", "user", "x"), msg("tg2", "assistant", "y")], opts);
        const drifted = originals.map((m, i) => (i === 4 ? msg("k4-new", "user", "alignment context  4 words\r\n") : m));
        const result = reconcileFoldCoverage(session, drifted, opts);
        assert.equal(result.kind, "reanchored");
        assert.equal(result.claims, 1);
        assert.equal(result.unmatched, 0);
        assert.equal(session.state.blocks[0].effectiveMessageIds[4], "k4-new");
    });
});

describe("reconcileFoldCoverage owner-deletion drift (#2297)", () => {
    type LogLine = { level: string; msg: string };
    function coveredSession(n: number): Session {
        const ids = Array.from({ length: n }, (_, i) => `c${i}`);
        return {
            state: { blocks: [{ active: true, effectiveMessageIds: ids }] },
            metadata: {},
        } as unknown as Session;
    }
    function makeOpts(logs: LogLine[]): ReconcileOptions & { mode: "repair" } {
        return { sessionId: "s1", mode: "repair", log: (level: string, m: string) => logs.push({ level, msg: m }) };
    }
    const errorLines = (logs: LogLine[]) => logs.filter((l) => l.level === "error");
    const driftWarns = (logs: LogLine[]) => logs.filter((l) => l.level === "warn" && /no anchor match/.test(l.msg)).length;
    // #2202 guard: reconciliation only runs on conversation-sized passes (>=10
    // msgs); side-request-shaped short passes take no evidence. Every drift pass
    // below therefore carries a fresh 10-message tail whose ids never overlap the
    // covered set — still a total-loss pass, now past the guard.
    const freshTail = (tag: string, n = 10): CoreMessage[] =>
        Array.from({ length: n }, (_, i) => msg(`${tag}${i}`, "assistant", `${tag} fresh tail turn ${i} padding words`));

    test("missing counts only ACTIVE block coverage; dead-lineage ids drop out", () => {
        // #2293 shape: the host truncated its own history; syncBlocks has
        // already deactivated the old blocks (active=false) but their
        // effectiveMessageIds persist in state — they can never re-anchor and
        // must not sit in `missing` forever. Pre-seeded anchors simulate the
        // persisted state from when those blocks were still live.
        const liveIds = Array.from({ length: 12 }, (_, i) => `live${i}`);
        const deadIds = Array.from({ length: 50 }, (_, i) => `dead${i}`);
        const seedAnchors: Record<string, FoldAnchor> = {};
        for (const id of [...deadIds, ...liveIds]) seedAnchors[id] = anchorOf(msg(id, "user", `text ${id}`));
        const session = {
            state: { blocks: [
                { active: true, effectiveMessageIds: liveIds },
                { active: false, effectiveMessageIds: deadIds.slice(0, 40) },
                { active: false, effectiveMessageIds: deadIds.slice(40) },
            ]},
            metadata: { foldAnchors: seedAnchors, foldAnchorOrder: [...deadIds, ...liveIds] },
        } as unknown as Session;
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        // Owner-deletion pass: the client resends only a fresh tail (>=10 msgs to
        // clear the #2202 side-request guard), none of which is a covered id.
        const result = reconcileFoldCoverage(session, freshTail("tail"), opts);
        assert.equal(result.missing, 12, "only active coverage counts as missing");
        assert.equal(result.unmatched, 12);
        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        assert.equal(Object.keys(anchors).length, 12, "dead-id anchors pruned (MAX_ANCHORS budget freed)");
        assert.ok(!("dead0" in anchors));
        assert.ok("live0" in anchors);
    });

    test("per-pass WARN stops once the episode escalated; recovery re-arms", () => {
        const n = 12; // above the 10-id escalation floor
        const session = coveredSession(n);
        const originals = Array.from({ length: n }, (_, i) => msg(`c${i}`, "user", `covered text ${i} with enough words`));
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        reconcileFoldCoverage(session, originals, opts);
        reconcileFoldCoverage(session, freshTail("p1"), opts);
        reconcileFoldCoverage(session, freshTail("p2"), opts);
        assert.equal(driftWarns(logs), 2, "pre-escalation total-loss passes still warn");
        reconcileFoldCoverage(session, freshTail("p3"), opts);
        assert.equal(errorLines(logs).length, 1, "third total-loss pass escalates once");
        assert.equal(driftWarns(logs), 2, "the escalation pass's error supersedes its own warn");
        reconcileFoldCoverage(session, freshTail("p4"), opts);
        reconcileFoldCoverage(session, freshTail("p5"), opts);
        assert.equal(driftWarns(logs), 2, "escalated episode stays silent after the error line");
        assert.equal(session.metadata.foldDriftEscalated, true);
        // Recovery resets the latch so a later episode reports fresh.
        reconcileFoldCoverage(session, originals, opts);
        assert.equal(session.metadata.foldDriftEscalated, undefined, "recovery clears the latch");
    });

    test("total-loss warn names both mutation and benign client-side deletion", () => {
        const n = 12;
        const session = coveredSession(n);
        const originals = Array.from({ length: n }, (_, i) => msg(`c${i}`, "user", `covered text ${i} with enough words`));
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        reconcileFoldCoverage(session, originals, opts);
        reconcileFoldCoverage(session, freshTail("p1"), opts);
        const warn = logs.find((l) => l.level === "warn" && /no anchor match/.test(l.msg));
        assert.ok(warn, "pre-escalation drift pass warns");
        assert.match(warn!.msg, /client-side deletion\/truncation/);
        assert.match(warn!.msg, /benign/);
        assert.doesNotMatch(warn!.msg, /originals re-enter the wire unfolded/, "deletion-misleading wording removed");
    });

    test("a persisted escalation latch stays silent across a process restart (#2293 terminal state)", () => {
        // The #2293 incident window: the episode predates the log window, the
        // latch is restored from persisted metadata — no duplicate error line,
        // no per-pass warn flood.
        const n = 12;
        const session = coveredSession(n);
        session.metadata["foldDriftStreak"] = 5;
        session.metadata["foldDriftSince"] = Date.now() - 3_600_000;
        session.metadata["foldDriftEscalated"] = true;
        const logs: LogLine[] = [];
        const opts = makeOpts(logs);
        for (let pass = 1; pass <= 3; pass++) {
            reconcileFoldCoverage(session, freshTail(`r${pass}`), opts);
        }
        assert.equal(errorLines(logs).length, 0, "no duplicate error line after restart");
        assert.equal(logs.filter((l) => l.level === "warn").length, 0, "no per-pass warn flood either");
        assert.equal(session.metadata["foldDriftStreak"], 8, "the streak keeps counting across the restart");
    });
});
describe("reconcileFoldCoverage anchor cap boundary (#2334)", () => {
    // MAX_ANCHORS (src/fold-reconcile.ts) pinned at 16384 — hardcoded here on
    // purpose so a constant move breaks the pin loudly instead of sliding it.
    const CAP = 16_384;
    function capSession(ids: string[]): Session {
        return {
            state: { blocks: [{ active: true, effectiveMessageIds: ids }] },
            metadata: {},
        } as unknown as Session;
    }
    const opts: ReconcileOptions = { mode: "repair", sessionId: "cap", log: () => {} };

    test("steady-state resend beyond the cap pays zero normalizations and stays byte-stable", () => {
        // The issue's minimal repro shape: 20000 distinct covered ids (> CAP).
        // Pre-fix the second identical pass re-normalized + re-hashed exactly
        // the 20000 − 16384 tail ids whose anchors were deleted on pass one.
        const n = 20_000; // > CAP — the 8K perf history sits below the cap and cannot see this edge
        const msgs = Array.from({ length: n }, (_, i) => msg(`x${i}`, "user", `covered payload ${i}`));
        const session = capSession(msgs.map((m) => m.id!));

        resetNormalizedIdentityWork();
        const first = reconcileFoldCoverage(session, msgs, opts);
        assert.equal(first.kind, "resend");
        assert.equal(normalizedIdentityWorkCount(), CAP,
            "cold fill stops at the cap — never pays for anchors that would be discarded");

        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        assert.equal(Object.keys(anchors).length, CAP, "anchor table capped");
        assert.equal(Object.keys(anchors)[0], "x0", "survivors keep covered order (oldest first)");
        assert.equal(Object.keys(anchors)[CAP - 1], `x${CAP - 1}`);
        assert.equal(anchors[`x${CAP}`], undefined, "the overflow tail holds no anchor (pre-existing semantics)");
        assert.deepEqual(anchors["x5"], {
            n: normalizedIdentity(msgs[5]),
            r: "user",
            b: msgs[5].text!.length,
        }, "retained anchor values keep the fresh anchorFrom shape");

        const snapshot = JSON.stringify(session.metadata);
        resetNormalizedIdentityWork();
        const second = reconcileFoldCoverage(session, msgs, opts);
        assert.deepEqual(second, { kind: "resend", missing: 0, claims: 0, byPos: 0, byTool: 0, byNorm: 0, byTurn: 0, byImage: 0, reaped: 0, unmatched: 0 });
        assert.equal(normalizedIdentityWorkCount(), 0,
            "the overflow tail must not be normalized+hashed and dropped AGAIN every pass (#2334)");
        assert.equal(JSON.stringify(session.metadata), snapshot, "steady-state resend leaves metadata byte-stable");
    });

    test("a fully tool-claimable churn pays no candidate norms (lazy normalization)", () => {
        // Verbatim bookends + 8 churned middles carrying stable protocol
        // toolCallIds: every claim resolves in the toolCallId pass, so the
        // normalized-identity pass sees no unclaimed candidates. Expected work
        // is exactly the 8 claim-anchor rebuilds (post-churn bytes must be
        // anchored for the next churn) — pre-fix eager normalization paid 8
        // extra candidate norms that were never compared.
        const originals: CoreMessage[] = [msg("b0", "user", "bookend zero")];
        const churned: CoreMessage[] = [msg("b0", "user", "bookend zero")];
        for (let i = 1; i <= 8; i++) {
            originals.push(msg(`t${i}`, "tool_result", `tool payload ${i} raw`, { toolCallId: `call-${i}`, toolName: "probe" }));
            churned.push(msg(`t${i}-new`, "tool_result", `tool payload ${i}  re-encoded\r\n`, { toolCallId: `call-${i}`, toolName: "probe" }));
        }
        originals.push(msg("b9", "assistant", "bookend nine"));
        churned.push(msg("b9", "assistant", "bookend nine"));
        const session = capSession(originals.map((m) => m.id!));
        reconcileFoldCoverage(session, originals, opts); // seed anchors + order backbone

        resetNormalizedIdentityWork();
        const result = reconcileFoldCoverage(session, churned, opts);
        assert.equal(result.kind, "reanchored");
        assert.equal(result.byTool, 8);
        assert.equal(result.byNorm, 0);
        assert.equal(result.unmatched, 0);
        assert.equal(normalizedIdentityWorkCount(), 16,
            "exactly the 8 claim-anchor rebuilds × 2 (full norm + #2396 no-tool norm) — zero wasted candidate norms");
        assert.deepEqual(
            (session.state.blocks[0] as { effectiveMessageIds: string[] }).effectiveMessageIds,
            ["b0", ...Array.from({ length: 8 }, (_, i) => `t${i + 1}-new`), "b9"],
        );
    });

    test("mixed churn normalizes only the tool-unclaimed candidates", () => {
        // 4 toolCallId-churned + 4 plain-text-churned middles. Expected work:
        // 8 claim-anchor rebuilds + 4 candidate norms for the plain messages
        // the tool pass left behind. Pre-fix eager normalization paid all 8
        // candidate norms up front — the 4 tool-claimed ones included.
        const originals: CoreMessage[] = [msg("b0", "user", "bookend zero")];
        const churned: CoreMessage[] = [msg("b0", "user", "bookend zero")];
        for (let i = 1; i <= 4; i++) {
            originals.push(msg(`t${i}`, "tool_result", `tool payload ${i} raw`, { toolCallId: `call-${i}`, toolName: "probe" }));
            churned.push(msg(`t${i}-new`, "tool_result", `tool payload ${i}  re-encoded\r\n`, { toolCallId: `call-${i}`, toolName: "probe" }));
        }
        for (let i = 5; i <= 8; i++) {
            originals.push(msg(`u${i}`, "user", `plain turn ${i}`));
            churned.push(msg(`u${i}-new`, "user", `plain  turn ${i}\r\n`));
        }
        originals.push(msg("b9", "assistant", "bookend nine"));
        churned.push(msg("b9", "assistant", "bookend nine"));
        const session = capSession(originals.map((m) => m.id!));
        reconcileFoldCoverage(session, originals, opts);
        // #2487 prose normalization makes whitespace churn positionally
        // claimable, which would route ALL 8 middles through Pass 0; drop the
        // stored copy so this test keeps exercising the tool/norm passes and
        // their #2334 lazy-norm accounting (the no-copy fallback path).
        delete (session.metadata as Record<string, unknown>).foldPositions;

        resetNormalizedIdentityWork();
        const result = reconcileFoldCoverage(session, churned, opts);
        assert.equal(result.kind, "reanchored");
        assert.equal(result.byTool, 4);
        assert.equal(result.byNorm, 4);
        assert.equal(result.unmatched, 0);
        assert.equal(normalizedIdentityWorkCount(), 16,
            "4 tool claim-anchor rebuilds × 2 (#2396 no-tool norm rides along) + 4 plain claim rebuilds + 4 unclaimed-candidate norms");
    });
});

describe("rewrite-suspect detection (#2396)", () => {
    // A host may rewrite authoritative tool-call ids across provider
    // projections (Prime: call_x|fc_0 → call_x_fc_0 on both sides of every
    // pair). Both claim passes key on the toolCallId, so such pairs defeat
    // reconciliation by construction; the module must COUNT them (detection
    // only) and never claim or repair onto them.
    const oldCall = msg("tc1", "tool_result", "payload body words", { toolCallId: "call_seed|fc_0", toolName: "probe" });
    const rewrittenTwin = msg("tc1-rw", "tool_result", "payload body words", { toolCallId: "call_seed_fc_0", toolName: "probe" });

    test("identical-content twin under a different toolCallId is counted, never claimed", () => {
        const plan = planReconciliation(["tc1"], { tc1: anchorOf(oldCall) }, [rewrittenTwin], new Set(["tc1"]));
        assert.equal(plan.claims.size, 0, "no host knowledge → no pairing");
        assert.deepEqual(plan.unmatched, ["tc1"]);
        assert.equal(plan.idRewriteSuspects, 1);
    });

    test("stable toolCallId with churned bytes still claims (unchanged path)", () => {
        const churned = msg("tc1-new", "tool_result", "payload body  words\r\n", { toolCallId: "call_seed|fc_0", toolName: "probe" });
        const plan = planReconciliation(["tc1"], { tc1: anchorOf(oldCall) }, [churned], new Set(["tc1"]));
        assert.equal(plan.byTool, 1);
        assert.deepEqual([...plan.claims.entries()], [["tc1", ["tc1-new"]]]);
        assert.equal(plan.idRewriteSuspects, 0);
    });

    test("genuinely edited content under a new id is NOT a suspect", () => {
        const edited = msg("tc1-edit", "tool_result", "completely different body", { toolCallId: "call_seed_fc_0", toolName: "probe" });
        const plan = planReconciliation(["tc1"], { tc1: anchorOf(oldCall) }, [edited], new Set(["tc1"]));
        assert.deepEqual(plan.unmatched, ["tc1"]);
        assert.equal(plan.idRewriteSuspects, 0, "content differs → real edit, not a rewrite");
    });

    test("pre-#2396 persisted anchors (no m) stay residual-pinned", () => {
        const v0: FoldAnchor = { n: normalizedIdentity(oldCall), r: oldCall.role, b: oldCall.text!.length, t: oldCall.toolCallId };
        const plan = planReconciliation(["tc1"], { tc1: v0 }, [rewrittenTwin], new Set(["tc1"]));
        assert.deepEqual(plan.unmatched, ["tc1"]);
        assert.equal(plan.idRewriteSuspects, 0, "without the no-tool norm there is no evidence to pair on");
    });

    type LogLine = { level: string; msg: string };
    function makeOpts(logs: LogLine[]): ReconcileOptions & { mode: "repair" } {
        return { sessionId: "s1", mode: "repair", log: (level: string, m: string) => logs.push({ level, msg: m }) };
    }
    const errorLines = (logs: LogLine[]) => logs.filter((l) => l.level === "error");

    test("provider-switch rewrite (#2396 shape): identical-content twins under rewritten tool-call ids are repaired positionally (#2480)", () => {
        const ids = ["b0", ...Array.from({ length: 10 }, (_, i) => `t${i + 1}`), "b9"];
        const originals: CoreMessage[] = [msg("b0", "user", "bookend zero")];
        for (let i = 1; i <= 10; i++) originals.push(msg(`t${i}`, "tool_result", `tool payload ${i}`, { toolCallId: `call_${i}|raw`, toolName: "probe" }));
        originals.push(msg("b9", "assistant", "bookend nine"));
        const session: Session = {
            state: { blocks: [{ active: true, effectiveMessageIds: [...ids] }] },
            metadata: {},
        } as unknown as Session;
        reconcileFoldCoverage(session, originals, makeOpts([])); // seed anchors + order + positional copy

        const rewritten = (): CoreMessage[] => [
            msg("b0", "user", "bookend zero"),
            ...Array.from({ length: 10 }, (_, i) => msg(`t${i + 1}-rw`, "tool_result", `tool payload ${i + 1}`, { toolCallId: `call_${i + 1}_raw`, toolName: "probe" })),
            msg("b9", "assistant", "bookend nine"),
        ];

        const logs: LogLine[] = [];
        resetNormalizedIdentityWork();
        const first = reconcileFoldCoverage(session, rewritten(), makeOpts(logs));
        // #2480: the old detection-only stance assumed pairing without host
        // knowledge would be guessing — but position + canonical fingerprint
        // IS host knowledge: same index, identical content, only the id scheme
        // rewritten. Every pair is claimed; nothing escalates.
        assert.equal(first.kind, "reanchored");
        assert.equal(first.byPos, 10);
        assert.equal(first.unmatched, 0);
        assert.equal(normalizedIdentityWorkCount(), 20,
            "zero candidate norms (all claims are positional); 2 per re-seeded tool anchor (n + m)");
        assert.deepEqual(
            (session.state.blocks[0] as { effectiveMessageIds: string[] }).effectiveMessageIds,
            ["b0", ...Array.from({ length: 10 }, (_, i) => `t${i + 1}-rw`), "b9"],
            "fold coverage survives the provider switch (the #2396 death spiral, closed)");
        assert.equal(errorLines(logs).length, 0, "nothing escalates — the drift was repaired, not destroyed");
        const firstInfo = logs.filter((l) => l.level === "info");
        assert.equal(firstInfo.length, 1, "the repair pass logs one reanchor line");
        assert.match(firstInfo[0].msg, /reanchored 10 \(10 positional/);
        // steady state after the repair: zero work, no drift lines
        resetNormalizedIdentityWork();
        const second = reconcileFoldCoverage(session, rewritten(), makeOpts(logs));
        assert.equal(second.kind, "resend");
        assert.equal(normalizedIdentityWorkCount(), 0);
        assert.equal(logs.length, 1, "steady pass adds nothing — the only line is the repair notice above");
        assert.equal(errorLines(logs).length + logs.filter((l) => l.level === "warn").length, 0);
    });

    test("v0 anchors backfill their no-tool norm while bytes are still on the wire", () => {
        const ids = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);
        const originals: CoreMessage[] = ids.map((id, i) =>
            msg(id, "tool_result", `backfill payload ${i + 1}`, { toolCallId: `bf_${i + 1}|old`, toolName: "probe" }));
        const v0Anchors: Record<string, FoldAnchor> = {};
        for (const m of originals) {
            v0Anchors[m.id!] = { n: normalizedIdentity(m), r: m.role, b: m.text!.length, t: m.toolCallId };
        }
        const session: Session = {
            state: { blocks: [{ active: true, effectiveMessageIds: [...ids] }] },
            metadata: { foldAnchors: v0Anchors, foldAnchorOrder: [...ids] },
        } as unknown as Session;
        const opts: ReconcileOptions = { mode: "repair", sessionId: "bf", log: () => {} };
        const result = reconcileFoldCoverage(session, originals, opts);
        assert.equal(result.kind, "resend");
        const anchors = session.metadata!.foldAnchors as Record<string, FoldAnchor>;
        for (const m of originals) {
            assert.equal(anchors[m.id!]?.m, normalizedIdentityNoToolCallId(m), "m backfilled from live bytes");
            assert.equal(anchors[m.id!]?.n, normalizedIdentity(m));
        }
    });
});

describe("planReconciliation model-switch churn (#2636)", () => {
    // anchors must carry the turn ctx (p/p2/x) the seeding path attaches —
    // the turn-key pass is inert without it.
    const anchorMap = (msgs: CoreMessage[]): Record<string, FoldAnchor> => {
        const ctx = turnContexts(msgs);
        const out: Record<string, FoldAnchor> = {};
        for (const m of msgs) out[m.id!] = { ...anchorOf(m), ...ctx.get(m.id) } as FoldAnchor;
        return out;
    };

    test("pair→merged: cross-model inline thinking re-anchors (seamed join)", () => {
        const oldMsgs = [
            msg("u1", "user", "question 1"),
            msg("r1", "assistant", "thinking one", { contentType: "reasoning" }),
            msg("t1", "assistant", "answer one"),
            msg("u2", "user", "question 2"),
            msg("r2", "assistant", "thinking two", { contentType: "reasoning" }),
            msg("t2", "assistant", "answer two"),
        ];
        const newMsgs = [
            msg("u1", "user", "question 1"),
            msg("m1", "assistant", "thinking one\nanswer one"),
            msg("u2", "user", "question 2"),
            msg("m2", "assistant", "thinking two\nanswer two"),
        ];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["r1", "t1", "r2", "t2"]));
        assert.equal(plan.byTurn, 2);
        assert.equal(plan.unmatched.length, 0);
        assert.deepEqual(plan.claims.get("r1"), ["m1"]);
        assert.deepEqual(plan.claims.get("t1"), ["m1"]);
        assert.deepEqual(plan.claims.get("r2"), ["m2"]);
        assert.deepEqual(plan.claims.get("t2"), ["m2"]);
    });

    test("pair→merged: seamless join (pi concatenates parts with \"\")", () => {
        const oldMsgs = [
            msg("r1", "assistant", "thinking one", { contentType: "reasoning" }),
            msg("t1", "assistant", "answer one"),
        ];
        const newMsgs = [msg("m1", "assistant", "thinking oneanswer one")];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["r1", "t1"]));
        assert.equal(plan.byTurn, 1);
        assert.deepEqual(plan.claims.get("r1"), ["m1"]);
        assert.deepEqual(plan.claims.get("t1"), ["m1"]);
    });

    test("thinking-only turn: contentType text↔reasoning flip re-anchors", () => {
        const oldMsgs = [
            msg("u1", "user", "question 1"),
            msg("m1", "assistant", "pure thinking, no reply part"),
            msg("u2", "user", "question 2"),
        ];
        const newMsgs = [
            msg("u1", "user", "question 1"),
            msg("r1", "assistant", "pure thinking, no reply part", { contentType: "reasoning" }),
            msg("u2", "user", "question 2"),
        ];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["m1"]));
        assert.equal(plan.byTurn, 1);
        assert.deepEqual(plan.claims.get("m1"), ["r1"]);
        assert.equal(plan.unmatched.length, 0);
    });

    test("merged→pair: switch back onto a same-model wire splits the turn", () => {
        const oldMsgs = [
            msg("u1", "user", "question 1"),
            msg("m1", "assistant", "thinking one\nanswer one"),
            msg("u2", "user", "question 2"),
        ];
        const newMsgs = [
            msg("u1", "user", "question 1"),
            msg("r1", "assistant", "thinking one", { contentType: "reasoning" }),
            msg("t1", "assistant", "answer one"),
            msg("u2", "user", "question 2"),
        ];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["m1"]));
        assert.equal(plan.byTurn, 1);
        assert.deepEqual(plan.claims.get("m1"), ["r1", "t1"]);
        assert.equal(plan.unmatched.length, 0);
    });

    test("image-capability variant: placeholder appended on the text-only replay", () => {
        const oldMsgs = [
            msg("u1", "user", "see this diagram"),
            msg("u2", "user", "next question"),
        ];
        const newMsgs = [
            msg("p1", "user", "see this diagram\n(image omitted: model does not support images)"),
            msg("u2", "user", "next question"),
        ];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["u1"]));
        assert.equal(plan.byImage, 1);
        assert.deepEqual(plan.claims.get("u1"), ["p1"]);
        assert.equal(plan.unmatched.length, 0);
    });

    test("image-capability variant: placeholder stripped on the vision replay", () => {
        const oldMsgs = [
            msg("p1", "user", "see this diagram\n(image omitted: model does not support images)"),
            msg("u2", "user", "next question"),
        ];
        const newMsgs = [
            msg("u1", "user", "see this diagram"),
            msg("u2", "user", "next question"),
        ];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["p1"]));
        assert.equal(plan.byImage, 1);
        assert.deepEqual(plan.claims.get("p1"), ["u1"]);
        assert.equal(plan.unmatched.length, 0);
    });

    test("image family: identical texts pair k-th when counts match", () => {
        const wrap = (id: string): CoreMessage => msg(id, "user", "Attached image(s) from tool result:\n");
        const oldMsgs = [wrap("o1"), wrap("o2"), msg("u9", "user", "tail")];
        const newMsgs = [
            msg("p1", "user", "Attached image(s) from tool result:\n\n(image omitted: model does not support images)"),
            msg("p2", "user", "Attached image(s) from tool result:\n\n(image omitted: model does not support images)"),
            msg("u9", "user", "tail"),
        ];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["o1", "o2"]));
        assert.equal(plan.byImage, 2);
        assert.deepEqual(plan.claims.get("o1"), ["p1"]);
        assert.deepEqual(plan.claims.get("o2"), ["p2"]);
        assert.equal(plan.unmatched.length, 0);
    });

    test("duplicated turns stay unmatched (never fuzzy)", () => {
        const turn = (k: string): CoreMessage[] => [
            msg(`r${k}`, "assistant", "same thinking", { contentType: "reasoning" }),
            msg(`t${k}`, "assistant", "same answer"),
        ];
        const oldMsgs = [...turn("1"), ...turn("2")];
        const newMsgs = [
            msg("m1", "assistant", "same thinking\nsame answer"),
            msg("m2", "assistant", "same thinking\nsame answer"),
        ];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["r1", "t1", "r2", "t2"]));
        assert.equal(plan.byTurn, 0);
        assert.equal(plan.claims.size, 0);
        assert.equal(plan.unmatched.length, 4);
    });

    test("length guard rejects a turn-key witness of wildly different size", () => {
        const oldMsgs = [
            msg("r1", "assistant", "short thinking", { contentType: "reasoning" }),
            msg("t1", "assistant", "short answer"),
        ];
        const newMsgs = [msg("m1", "assistant", `short thinking\nshort answer${" noise".repeat(400)}`)];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["r1", "t1"]));
        assert.equal(plan.byTurn, 0);
        assert.equal(plan.unmatched.length, 2);
    });

    test("length guard rejects an image-variant witness of wildly different size", () => {
        const oldMsgs = [msg("u1", "user", "see this")];
        const newMsgs = [
            msg("p1", "user", `see this${" noise".repeat(400)}\n(image omitted: model does not support images)`),
        ];
        const plan = planReconciliation(oldMsgs.map((m) => m.id!), anchorMap(oldMsgs), newMsgs, new Set(["u1"]));
        assert.equal(plan.byImage, 0);
        assert.equal(plan.unmatched.length, 1);
    });
});

describe("reconcileFoldCoverage model-switch churn (#2636)", () => {
    function fakeSession(blocks: { effectiveMessageIds: string[]; directMessageIds?: string[] }[]): Session {
        return {
            state: { blocks: blocks.map((b) => ({ active: true, ...b })) },
            metadata: {},
        } as unknown as Session;
    }
    const opts = (): ReconcileOptions => ({ mode: "repair", sessionId: "s1", log: () => {} });

    test("pair→merged rewrite collapses the covered pair onto one id (no duplicates)", () => {
        const originals = [
            msg("u0", "user", "ctx 0"),
            msg("u1", "user", "ctx 1"),
            msg("r1", "assistant", "thinking about the problem at length", { contentType: "reasoning" }),
            msg("t1", "assistant", "the answer is 42 with details"),
            msg("u2", "user", "ctx 2"),
            msg("r2", "assistant", "more thinking here", { contentType: "reasoning" }),
            msg("t2", "assistant", "second answer"),
            msg("u3", "user", "ctx 3"),
            msg("r3", "assistant", "third thinking", { contentType: "reasoning" }),
            msg("t3", "assistant", "third answer"),
            msg("u4", "user", "ctx 4"),
        ];
        const covered = ["r1", "t1", "r2", "t2", "r3", "t3"];
        const session = fakeSession([{ effectiveMessageIds: covered, directMessageIds: covered }]);
        reconcileFoldCoverage(session, originals, opts());
        const churned = [
            msg("u0", "user", "ctx 0"),
            msg("u1", "user", "ctx 1"),
            msg("m1", "assistant", "thinking about the problem at length\nthe answer is 42 with details"),
            msg("u2", "user", "ctx 2"),
            msg("m2", "assistant", "more thinking here\nsecond answer"),
            msg("u3", "user", "ctx 3"),
            msg("m3", "assistant", "third thinking\nthird answer"),
            msg("u4", "user", "ctx 4"),
            msg("u5", "user", "ctx 5"),
            msg("u6", "user", "ctx 6"),
        ];
        const result = reconcileFoldCoverage(session, churned, opts());
        assert.equal(result.kind, "reanchored");
        assert.equal(result.byTurn, 3);
        assert.equal(result.unmatched, 0);
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, ["m1", "m2", "m3"]);
        assert.deepEqual(session.state.blocks[0].directMessageIds, ["m1", "m2", "m3"]);
        // anchors for the merged cores carry the turn ctx so the NEXT churn
        // (e.g. switching back) still matches
        const anchors = session.metadata.foldAnchors as Record<string, FoldAnchor>;
        assert.ok(anchors["m1"]?.p !== undefined, "merged anchor carries turn key");
        assert.deepEqual(
            (session.state as { lastPassIds?: string[] }).lastPassIds?.sort(),
            ["m1", "m2", "m3"],
        );
    });

    test("model-switch churn no longer escalates to substrate-destroyed while some anchors recover", () => {
        const originals = Array.from({ length: 12 }, (_, i) =>
            i % 2 === 0
                ? msg(`u${i}`, "user", `stable user text ${i}`)
                : msg(`a${i}`, "assistant", `stable assistant answer ${i}`));
        const covered = originals.map((m) => m.id!);
        const session = fakeSession([{ effectiveMessageIds: covered }]);
        const logs: { level: string; msg: string }[] = [];
        const logOpts = { mode: "repair" as const, sessionId: "s1", log: (level: string, message: string) => logs.push({ level, msg: message }) };
        reconcileFoldCoverage(session, originals, logOpts);
        // churn: model switch rewrites every covered id but ALL re-anchor
        const churned = originals.map((m, i) => msg(`n${i}`, m.role, `${m.text} `));
        const result = reconcileFoldCoverage(session, churned, logOpts);
        assert.equal(result.kind, "reanchored");
        assert.equal(result.unmatched, 0);
        // no escalation possible: drift streak requires zero claims (#2193)
        assert.equal(session.metadata.foldDriftStreak, undefined);
        assert.equal(logs.filter((l) => l.level === "error").length, 0);
    });
});
