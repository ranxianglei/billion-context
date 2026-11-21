import test from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { extractPlanState } from "../src/decompress-shared.ts";
import { executePlanRetrievalSearch } from "../scripts/eval-plan-state-retrieval.ts";
import { legacyExtractPlanState, legacyFallbackMessages } from "./fixtures/legacy-plan-aware.ts";
import { PLAN_RETRIEVAL_CASES } from "./fixtures/plan-state-retrieval-cases.ts";
import { PLAN_QUERY_REGRESSION_CASES } from "./fixtures/plan-state-retrieval-query-regressions.ts";
import { PLAN_RETRIEVAL_CHALLENGES } from "./fixtures/plan-state-retrieval-challenges.ts";

test("legacy evaluation adapter preserves frozen terms at both sides of the inspection cap", () => {
    const snapshot = { todos: [{ content: "JWT authentication", status: "completed" }, { content: "token ratelimit", status: "in_progress" }], padding: "" };
    const baseLength = JSON.stringify(snapshot).length;
    const tag = '\x3cacp tokens="1K" type="TodoWrite"\x3em00003\x3c/acp\x3e\n';
    for (const length of [3999, 4000, 4001]) {
        const text = JSON.stringify({ ...snapshot, padding: "x".repeat(length - baseLength) });
        assert.equal(text.length, length);
        for (const prefix of ["", tag]) {
            const messages: CoreMessage[] = [{ id: "plan", role: "assistant", contentType: "tool-call", toolName: "TodoWrite", text: prefix + text }];
            const before = structuredClone(messages);
            const legacy = legacyExtractPlanState(messages);
            const transformed = legacyFallbackMessages(messages);
            assert.equal(transformed[0].text, `${messages[0].text}!`);
            assert.deepEqual(extractPlanState(transformed)?.terms, legacy?.terms);
            assert.ok(!extractPlanState(transformed)?.statusAware);
            assert.deepEqual(messages, before, "the adapter must not mutate the original model inputs");
        }
    }
});

test("frozen status-switch pairs change only status and each has a reachable retrieval label", () => {
    assert.equal(PLAN_RETRIEVAL_CASES.length, 28);
    assert.equal(new Set(PLAN_RETRIEVAL_CASES.map((fixture) => fixture.id)).size, 28);
    for (const fixture of PLAN_RETRIEVAL_CASES) {
        assert.ok(fixture.relevantBlockIds.length > 0, fixture.id);
        assert.ok(fixture.relevantBlockIds.every((id) => fixture.blocks.some((block) => block.blockId === id)), fixture.id);
    }
    const pairs = PLAN_RETRIEVAL_CASES.filter((fixture) => fixture.category === "status-switch");
    assert.equal(pairs.length, 8);
    for (let i = 0; i < pairs.length; i += 2) {
        const [first, second] = [pairs[i], pairs[i + 1]];
        assert.equal(first.query, second.query);
        assert.deepEqual(first.blocks, second.blocks);
        assert.equal(first.planningMessages[0].toolName, second.planningMessages[0].toolName);
        const firstTodos = (JSON.parse(first.planningMessages[0].text) as { todos: Array<{ content: string; status: string }> }).todos;
        const secondTodos = (JSON.parse(second.planningMessages[0].text) as { todos: Array<{ content: string; status: string }> }).todos;
        assert.deepEqual(firstTodos.map((todo) => todo.content), secondTodos.map((todo) => todo.content));
        assert.deepEqual(firstTodos.map((todo) => todo.status), ["completed", "in_progress"]);
        assert.deepEqual(secondTodos.map((todo) => todo.status), ["in_progress", "completed"]);
        for (const fixture of [first, second]) {
            const result = executePlanRetrievalSearch(fixture, "status-aware");
            assert.ok(fixture.relevantBlockIds.includes(result.blockIds[0]), fixture.id);
        }
    }
});

test("real retrieval evaluation preserves candidate membership and declared legacy controls", () => {
    for (const fixture of PLAN_RETRIEVAL_CASES) {
        for (const limit of [1, 3]) {
            const lexical = executePlanRetrievalSearch(fixture, "lexical", { limit });
            const legacy = executePlanRetrievalSearch(fixture, "legacy", { limit });
            const current = executePlanRetrievalSearch(fixture, "status-aware", { limit });
            assert.ok(lexical.candidateCount > limit, `${fixture.id}: reranking must be exercised`);
            assert.equal(current.candidateCount, lexical.candidateCount, fixture.id);
            assert.equal(legacy.candidateCount, lexical.candidateCount, fixture.id);
            if (fixture.preserveLegacyOrder) assert.deepEqual(current.blockIds, legacy.blockIds, fixture.id);
        }
    }
});

test("reviewed query-regression supplement preserves explicit historical intent", () => {
    for (const fixture of PLAN_QUERY_REGRESSION_CASES) {
        assert.ok(!fixture.relevantBlockIds.includes(fixture.initialStatusAwareTop1), `${fixture.id}: record the failed initial guard`);
        const result = executePlanRetrievalSearch(fixture, "status-aware");
        assert.ok(fixture.relevantBlockIds.includes(result.blockIds[0]), fixture.id);
    }
});

test("status-only ablation isolates extraction gains from explicit-query protection", () => {
    for (const fixture of PLAN_RETRIEVAL_CASES.filter((entry) => entry.category === "status-switch")) {
        const ablation = executePlanRetrievalSearch(fixture, "status-only");
        assert.ok(fixture.relevantBlockIds.includes(ablation.blockIds[0]), fixture.id);
        assert.equal(ablation.text, null, "rank-only ablation must not claim rendered tool evidence");
    }
    for (const fixture of PLAN_QUERY_REGRESSION_CASES) {
        const ablation = executePlanRetrievalSearch(fixture, "status-only");
        const current = executePlanRetrievalSearch(fixture, "status-aware");
        assert.ok(!fixture.relevantBlockIds.includes(ablation.blockIds[0]), fixture.id);
        assert.ok(fixture.relevantBlockIds.includes(current.blockIds[0]), fixture.id);
        assert.equal(ablation.candidateCount, current.candidateCount, fixture.id);
    }
});

test("status-only ablation preserves legacy controls and the no-reranking gates", () => {
    for (const fixture of PLAN_RETRIEVAL_CASES) {
        for (const limit of [1, 3]) {
            if (fixture.preserveLegacyOrder) {
                assert.deepEqual(executePlanRetrievalSearch(fixture, "status-only", { limit }).blockIds,
                    executePlanRetrievalSearch(fixture, "legacy", { limit }).blockIds, fixture.id);
            }
        }
        for (const options of [{ limit: fixture.blocks.length }, { messages: [] }, { query: "no_matching_fixture_term" }]) {
            assert.deepEqual(executePlanRetrievalSearch(fixture, "status-only", options).blockIds,
                executePlanRetrievalSearch(fixture, "lexical", options).blockIds, fixture.id);
        }
    }
});

for (const fixture of PLAN_RETRIEVAL_CHALLENGES) {
    test(`diversity challenge: ${fixture.id}`, () => {
        const before = structuredClone(fixture);
        for (const limit of [1, 3]) {
            const current = executePlanRetrievalSearch(fixture, "status-aware", { limit });
            assert.ok(current.candidateCount > limit, "the fixture must exercise reranking");
            assert.ok(fixture.relevantBlockIds.includes(current.blockIds[0]), fixture.rationale);
            assert.equal(new Set(current.blockIds).size, limit);
            if (fixture.preserveLegacyOrder) {
                assert.deepEqual(current.blockIds, executePlanRetrievalSearch(fixture, "legacy", { limit }).blockIds);
            }
        }
        assert.deepEqual(fixture, before, "search and evaluation must not modify the fixture");
    });
}
