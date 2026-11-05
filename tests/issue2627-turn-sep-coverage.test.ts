// #2627 regression: bili-synthesized Responses turn separators
// (repairResponsesAssistantOrdering, src/server.ts) are OUTBOUND-ONLY ordering
// markers — no client's resent history ever contains them. When a
// separator-bearing view reached applyCompression (the plugin lane handed its
// processed view straight in), their ids were registered into new blocks'
// direct/effectiveMessageIds and inherited by higher folds via child merge —
// permanently "missing" on every reconcile pass: false [acp-drift]/fold-
// reconcile warns against an UNCHANGED history. These pin: producer ids share
// the prefix constant, compression coverage stays real-history-only, persisted
// polluted states heal on load, genuine drift still fires.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, refForRaw, coveredMessageIds } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { RESPONSES_TURN_SEPARATOR_ID_PREFIX, coveredRealHistoryIds, foldCoverage, isResponsesTurnSeparatorId, scrubTurnSeparatorIds } from "../src/session.ts";
import { repairResponsesAssistantOrdering } from "../src/server.ts";
import { METADATA_FOLD_COVERAGE, reconcileFoldCoverage, type FoldBlockCoverage, type ReconcileOptions } from "../src/fold-reconcile.ts";
import { SessionStore } from "../src/persist.ts";

function msg(id: string, role: "user" | "assistant", text: string, contentType: CoreMessage["contentType"] = "text"): CoreMessage {
    return { id, role, contentType, text };
}

const SEP_TEXT = "[The exchange between these two assistant turns was compressed.]";

function history(n: number): CoreMessage[] {
    return Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, role: i % 3 === 0 ? "user" : "assistant", contentType: "text", text: `message number ${i + 1} with distinct payload ${"x".repeat(680)}` }));
}
const config: Config = { ...defaultConfig(200000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
const SUMMARY = "folded early working session; decisions and tool results summarized".repeat(2);

describe("#2627 primitives (session.ts)", () => {
    test("prefix discrimination: only turn separators match — acp_summary_* and m-refs never do", () => {
        assert.equal(isResponsesTurnSeparatorId("acp_turn_sep_1"), true);
        assert.equal(isResponsesTurnSeparatorId("acp_turn_sep_99"), true);
        assert.equal(isResponsesTurnSeparatorId("acp_summary_abc"), false);
        assert.equal(isResponsesTurnSeparatorId("m00001"), false);
        assert.equal(isResponsesTurnSeparatorId("turn_sep_1"), false);
    });

    test("scrubTurnSeparatorIds strips from BOTH arrays in place, returns removed count, idempotent", () => {
        const blocks = [
            { directMessageIds: ["r1", "acp_turn_sep_1", "r2"], effectiveMessageIds: ["r1", "acp_turn_sep_1", "r2", "acp_turn_sep_2"] },
            { directMessageIds: ["r3"], effectiveMessageIds: ["r3"] },
            {},
        ];
        assert.equal(scrubTurnSeparatorIds(blocks), 3);
        assert.deepEqual(blocks[0].directMessageIds, ["r1", "r2"]);
        assert.deepEqual(blocks[0].effectiveMessageIds, ["r1", "r2"]);
        assert.deepEqual(blocks[1].effectiveMessageIds, ["r3"]);
        assert.equal(scrubTurnSeparatorIds(blocks), 0);
    });

    test("coveredRealHistoryIds: active blocks only, separators excluded", () => {
        const blocks = [
            { active: true, effectiveMessageIds: ["r1", "acp_turn_sep_1", "r2"] },
            { active: false, effectiveMessageIds: ["rX", "acp_turn_sep_9"] },
            { active: true, effectiveMessageIds: ["r3", "acp_summary_zz"] },
        ];
        // acp_summary_* keeps passing through — the filter is separator-scoped,
        // never a generic acp_* drop (issue #2627 scope discipline).
        assert.deepEqual([...coveredRealHistoryIds(blocks)].sort(), ["acp_summary_zz", "r1", "r2", "r3"]);
    });
});

describe("#2627 producer coupling (server.ts)", () => {
    test("inserted separators carry the shared prefix constant and the fixed text", () => {
        const A = msg("a1", "assistant", "first answer");
        const U = msg("u2", "user", "next question");
        const R = msg("r2", "assistant", "thinking about the next question", "reasoning");
        // original: run1=[A], user break, run2=[R]; folded drops U -> A and R
        // become adjacent across runs with a body before reasoning: separator.
        const out = repairResponsesAssistantOrdering([A, R], [A, U, R]);
        assert.equal(out.length, 3);
        assert.equal(out[0], A);
        assert.equal(out[2], R);
        assert.ok(out[1].id.startsWith(RESPONSES_TURN_SEPARATOR_ID_PREFIX), `separator id ${out[1].id}`);
        assert.equal(out[1].id, `${RESPONSES_TURN_SEPARATOR_ID_PREFIX}1`);
        assert.equal(out[1].role, "user");
        assert.equal(out[1].text, SEP_TEXT);
    });

    test("no separator when ordering is already legal", () => {
        const A = msg("a1", "assistant", "answer");
        const out = repairResponsesAssistantOrdering([A], [A]);
        assert.equal(out.length, 1);
        assert.equal(out[0], A);
    });
});

describe("#2627 kernel coverage mechanics", () => {

    test("compressing a separator-bearing view pollutes coverage (documents the mechanism)", () => {
        const raw = history(14);
        const core = createCore();
        const turn = core.processTurn({ messages: raw, state: createInitialState(), config, tokenCount: 9999, renderTags: "text-only" });
        const refOf = (id: string): string => refForRaw(turn.state.messageRefs, id)!;
        const sep = msg(`${RESPONSES_TURN_SEPARATOR_ID_PREFIX}1`, "user", SEP_TEXT);
        const view = [...raw.slice(0, 6), sep, ...raw.slice(6)];
        const res = core.applyCompression({ ranges: [{ startRef: refOf("t2"), endRef: refOf("t9"), summary: SUMMARY }], state: turn.state, config, messages: view });
        assert.equal(res.result.errors.length, 0, res.result.errors.join("; "));
        const block = res.state.blocks.at(-1)!;
        assert.ok(block.effectiveMessageIds.some(isResponsesTurnSeparatorId), "old plugin-lane behavior: separator id entered effective coverage");
        assert.ok(block.directMessageIds.some(isResponsesTurnSeparatorId), "separator id entered direct coverage too");
    });

    test("compressing the RAW view (new host behavior) keeps coverage real-history-only", () => {
        const raw = history(14);
        const core = createCore();
        const turn = core.processTurn({ messages: raw, state: createInitialState(), config, tokenCount: 9999, renderTags: "text-only" });
        const refOf = (id: string): string => refForRaw(turn.state.messageRefs, id)!;
        const res = core.applyCompression({ ranges: [{ startRef: refOf("t2"), endRef: refOf("t9"), summary: SUMMARY }], state: turn.state, config, messages: raw });
        assert.equal(res.result.errors.length, 0, res.result.errors.join("; "));
        const covered = coveredMessageIds(res.state);
        assert.ok(covered.has("t5"), "real mid-span message still folded");
        for (const block of res.state.blocks) {
            assert.ok(!block.directMessageIds.some(isResponsesTurnSeparatorId), "no separator in direct coverage");
            assert.ok(!block.effectiveMessageIds.some(isResponsesTurnSeparatorId), "no separator in effective coverage");
        }
    });

    test("higher folds inherit separators from polluted children; the post-commit scrub backstop removes them", () => {
        const raw = history(14);
        const core = createCore();
        const turn = core.processTurn({ messages: raw, state: createInitialState(), config, tokenCount: 9999, renderTags: "text-only" });
        const sep = msg(`${RESPONSES_TURN_SEPARATOR_ID_PREFIX}1`, "user", SEP_TEXT);
        const view = [...raw.slice(0, 6), sep, ...raw.slice(6)];
        const dirty = core.applyCompression({ ranges: [{ startRef: refForRaw(turn.state.messageRefs, "t2")!, endRef: refForRaw(turn.state.messageRefs, "t9")!, summary: SUMMARY }], state: turn.state, config, messages: view });
        assert.equal(dirty.result.errors.length, 0, dirty.result.errors.join("; "));
        const parent = core.applyCompression({ ranges: [{ startRef: refForRaw(dirty.state.messageRefs, "t1")!, endRef: refForRaw(dirty.state.messageRefs, "t14")!, summary: SUMMARY }], state: dirty.state, config, messages: view });
        assert.equal(parent.result.errors.length, 0, parent.result.errors.join("; "));
        const topBlock = parent.state.blocks.at(-1)!;
        assert.ok(topBlock.effectiveMessageIds.some(isResponsesTurnSeparatorId), "parent inherited the child's separator id via effective merge");
        const removed = scrubTurnSeparatorIds(parent.state.blocks);
        assert.ok(removed >= 1, `scrub removed ${removed}`);
        for (const block of parent.state.blocks) {
            assert.ok(!block.directMessageIds.some(isResponsesTurnSeparatorId));
            assert.ok(!block.effectiveMessageIds.some(isResponsesTurnSeparatorId));
        }
    });
});

describe("#2627 drift consumers (fold-reconcile / acp-drift semantics)", () => {
    const REAL = Array.from({ length: 12 }, (_, i) => `r${i + 1}`);
    const SEPS = ["acp_turn_sep_1", "acp_turn_sep_2"];
    const fullPass = (): CoreMessage[] => REAL.map((id) => msg(id, "user", `body of ${id} ${"y".repeat(48)}`));
    const opts = (sessionId: string): ReconcileOptions & { mode?: "off" | "warn" | "repair" } => ({ mode: "warn", sessionId, log: () => {} });
    function pollutedSession(): Session {
        return {
            state: { blocks: [{ active: true, blockId: "blk1", summaryMessageId: "sum-blk1", directMessageIds: [...REAL, ...SEPS], effectiveMessageIds: [...REAL, ...SEPS] }] },
            metadata: {},
        } as unknown as Session;
    }

    test("unchanged history: old unfiltered set false-alarms, coveredRealHistoryIds is silent", () => {
        const session = pollutedSession();
        const pass = fullPass();
        const passIds = pass.map((m) => m.id);
        const oldCovered = new Set<string>(session.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        const oldGap = foldCoverage(oldCovered, passIds);
        assert.ok(oldGap !== null, "pre-fix semantics reproduce the false alarm");
        assert.equal(oldGap!.expected - oldGap!.matched, SEPS.length);
        assert.equal(foldCoverage(coveredRealHistoryIds(session.state.blocks), passIds), null, "post-fix: separator-only gap is invisible");
    });

    test("reconcileFoldCoverage reports zero unmatched on a clean pass and records honest ledger evidence", () => {
        const session = pollutedSession();
        const result = reconcileFoldCoverage(session, fullPass(), opts("s2627-clean"));
        assert.equal(result.unmatched, 0, `unmatched=${result.unmatched} kind=${result.kind}`);
        const cov = session.metadata[METADATA_FOLD_COVERAGE] as Record<string, FoldBlockCoverage>;
        const rec = cov["blk1"];
        assert.ok(rec, "per-block coverage evidence recorded");
        assert.equal(rec.t, REAL.length, "evidence total counts real history only");
        assert.equal(rec.p + rec.r, rec.t, "every covered id accounted for (present or reclaimed)");
    });

    test("genuine drift is STILL detected — the filter must not mask real loss", () => {
        const session = pollutedSession();
        const pass = fullPass().filter((m) => m.id !== "r7");
        assert.notEqual(foldCoverage(coveredRealHistoryIds(session.state.blocks), pass.map((m) => m.id)), null, "real missing id still gaps");
        const result = reconcileFoldCoverage(session, pass, opts("s2627-real"));
        assert.ok(result.unmatched >= 1, `real loss reported (unmatched=${result.unmatched})`);
    });
});

describe("#2627 persisted-state heal (persist.ts hydration)", () => {
    test("polluted blocks heal on load; valid blocks, summaries and archives survive", () => {
        const raw = history(14);
        const core = createCore();
        const turn = core.processTurn({ messages: raw, state: createInitialState(), config, tokenCount: 9999, renderTags: "text-only" });
        const res = core.applyCompression({ ranges: [{ startRef: refForRaw(turn.state.messageRefs, "t2")!, endRef: refForRaw(turn.state.messageRefs, "t9")!, summary: "folded early session".repeat(3) }], state: turn.state, config, messages: raw });
        assert.equal(res.result.errors.length, 0, res.result.errors.join("; "));
        const block = res.state.blocks.at(-1)!;
        const realBefore = [...block.effectiveMessageIds];
        assert.ok(realBefore.length > 0);
        // Simulate a pre-fix persisted record: separator ids inside coverage.
        block.directMessageIds.push("acp_turn_sep_1");
        block.effectiveMessageIds.push("acp_turn_sep_1", "acp_turn_sep_2");

        const dir = mkdtempSync(join(tmpdir(), "bili-2627-"));
        const session: Session = {
            id: "issue2627-persist",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100, contextTokens: 100, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            pendingRetrievals: [],
            metadata: {},
            state: res.state,
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        } as unknown as Session;
        const store = new SessionStore({ dir, debounceMs: 0, log: () => {} });
        store.scheduleSave(session);
        assert.ok(store.flushSync(session), "flush wrote the envelope");
        const reloaded = new SessionStore({ dir, debounceMs: 0, log: () => {} }).loadSync(session.id);
        assert.ok(reloaded, "session reloads");
        assert.equal(reloaded!.state.blocks.length, res.state.blocks.length, "no valid block cleared");
        const healed = reloaded!.state.blocks.find((b) => b.blockId === block.blockId)!;
        assert.equal(healed.active, true, "block stays active");
        assert.equal(healed.summary, block.summary, "summary text preserved");
        assert.ok(!healed.directMessageIds.some(isResponsesTurnSeparatorId), "direct coverage healed");
        assert.ok(!healed.effectiveMessageIds.some(isResponsesTurnSeparatorId), "effective coverage healed");
        for (const id of realBefore) assert.ok(healed.effectiveMessageIds.includes(id), `real id ${id} kept`);
    });
});
