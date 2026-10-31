import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createCore, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { executeSearchContext } from "../src/decompress-shared.ts";
import { createSession } from "../src/session.ts";
import { executePlanRetrievalSearch } from "../scripts/eval-plan-state-retrieval.ts";
import { legacyPlanRank } from "./fixtures/legacy-plan-aware.ts";
import { PLAN_RETRIEVAL_CASES } from "./fixtures/plan-state-retrieval-cases.ts";
import { PLAN_QUERY_REGRESSION_CASES } from "./fixtures/plan-state-retrieval-query-regressions.ts";
import { PLAN_RETRIEVAL_CHALLENGES } from "./fixtures/plan-state-retrieval-challenges.ts";
import { PLAN_QUERY_WORD_CASES } from "./fixtures/plan-query-word-cases.ts";

process.env.BILI_PERSIST = "0";

interface FrozenOutput { limit: number; blockIds: string[]; textSha256: string; candidateCount: number }
interface FrozenCase { id: string; inputSha256: string; relevantBlockIds: string[]; outputs: FrozenOutput[] }
const baseline = JSON.parse(readFileSync(new URL("./fixtures/plan-query-word-baseline.json", import.meta.url), "utf8")) as {
    sourceCommit: string; groups: { original: FrozenCase[]; queryWords: FrozenCase[] };
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const reciprocalRank = (ids: readonly string[], relevant: readonly string[]) => {
    const index = ids.findIndex((id) => relevant.includes(id));
    return index < 0 ? 0 : 1 / (index + 1);
};

test("frozen pre-fix original corpus retains all 104 complete tool outputs", () => {
    const fixtures = [...PLAN_RETRIEVAL_CASES, ...PLAN_QUERY_REGRESSION_CASES, ...PLAN_RETRIEVAL_CHALLENGES];
    assert.equal(baseline.sourceCommit, "434daf1e958f1d1db6e832f4c8fa841bdeaffce9");
    assert.equal(fixtures.length, 52);
    assert.equal(baseline.groups.original.length, fixtures.length);
    let comparisons = 0;
    for (const fixture of fixtures) {
        const frozen = baseline.groups.original.find((entry) => entry.id === fixture.id);
        assert.ok(frozen, fixture.id);
        assert.equal(digest(JSON.stringify(fixture)), frozen.inputSha256, `${fixture.id}: frozen inputs and labels`);
        for (const output of frozen.outputs) {
            const result = executePlanRetrievalSearch(fixture, "status-aware", { limit: output.limit });
            assert.deepEqual(result.blockIds, output.blockIds, fixture.id);
            assert.equal(result.candidateCount, output.candidateCount, fixture.id);
            assert.equal(digest(result.text ?? ""), output.textSha256, `${fixture.id}: complete output at limit ${output.limit}`);
            comparisons++;
        }
    }
    assert.equal(comparisons, 104);
});

test("new corpus labels remain frozen and no previously correct case loses P@1 or MRR@3", () => {
    assert.equal(PLAN_QUERY_WORD_CASES.length, 35);
    assert.equal(baseline.groups.queryWords.length, 35);
    let previouslyCorrect = 0;
    for (const fixture of PLAN_QUERY_WORD_CASES) {
        const frozen = baseline.groups.queryWords.find((entry) => entry.id === fixture.id);
        assert.ok(frozen, fixture.id);
        assert.equal(digest(JSON.stringify(fixture)), frozen.inputSha256, `${fixture.id}: labels must not track implementation`);
        const oldTop1 = frozen.outputs.find((entry) => entry.limit === 1)!;
        const oldTop3 = frozen.outputs.find((entry) => entry.limit === 3)!;
        const current1 = executePlanRetrievalSearch(fixture, "status-aware", { limit: 1 });
        const current3 = executePlanRetrievalSearch(fixture, "status-aware", { limit: 3 });
        assert.equal(current1.candidateCount, oldTop1.candidateCount, `${fixture.id}: ranking cannot change the candidate pool`);
        assert.ok(reciprocalRank(current3.blockIds, fixture.relevantBlockIds) >= reciprocalRank(oldTop3.blockIds, fixture.relevantBlockIds),
            `${fixture.id}: MRR@3 regression`);
        if (fixture.relevantBlockIds.includes(oldTop1.blockIds[0])) {
            previouslyCorrect++;
            assert.ok(fixture.relevantBlockIds.includes(current1.blockIds[0]), `${fixture.id}: P@1 regression`);
        }
    }
    assert.equal(previouslyCorrect, 18);
});

test("all nine natural-language diagnostics recover their declared answer", () => {
    const cases = PLAN_QUERY_WORD_CASES.filter((fixture) => fixture.category === "natural-language");
    assert.equal(cases.length, 9);
    for (const fixture of cases) {
        for (const limit of [1, 3]) {
            const result = executePlanRetrievalSearch(fixture, "status-aware", { limit });
            assert.ok(fixture.relevantBlockIds.includes(result.blockIds[0]), fixture.id);
        }
    }
});

test("supported literal, identifier and multilingual diagnostics also retain their declared answers", () => {
    const existingSubstringFailures = new Set(["variable-a", "plain-stopword-query", "all-function-word-literals"]);
    const cases = PLAN_QUERY_WORD_CASES.filter((fixture) => fixture.category !== "natural-language" && !existingSubstringFailures.has(fixture.id));
    assert.equal(cases.length, 23);
    for (const fixture of cases) {
        for (const limit of [1, 3]) {
            const result = executePlanRetrievalSearch(fixture, "status-aware", { limit });
            assert.ok(fixture.relevantBlockIds.includes(result.blockIds[0]), fixture.id);
        }
    }
});

test("known substring failures retain old ordering without relabelling them as successes", () => {
    for (const id of ["variable-a", "plain-stopword-query", "all-function-word-literals"]) {
        const fixture = PLAN_QUERY_WORD_CASES.find((entry) => entry.id === id)!;
        const frozen = baseline.groups.queryWords.find((entry) => entry.id === id)!;
        assert.ok(!fixture.relevantBlockIds.includes(frozen.outputs[0].blockIds[0]), `${id}: a recorded pre-existing failure`);
        for (const output of frozen.outputs) {
            assert.deepEqual(executePlanRetrievalSearch(fixture, "status-aware", { limit: output.limit }).blockIds, output.blockIds, id);
        }
    }
});

function snapshot(text = "budget"): CoreMessage[] {
    return [{ id: "plan", role: "assistant", contentType: "tool-call", toolName: "TodoWrite",
        text: JSON.stringify({ todos: [{ content: text, status: "in_progress" }] }) }];
}

function search(query: string, summaries: readonly string[], options: {
    messages?: CoreMessage[]; disabled?: boolean; foreign?: boolean; limit?: number;
} = {}) {
    const core = createCore();
    const session = createSession("query-words-contract");
    session.state = { ...session.state, blocks: summaries.map((summary, index): CompressionBlock => ({
        blockId: `b${index + 1}`, topic: `b${index + 1}`, summary, runId: "query-words", tier: 1,
        active: true, directMessageIds: [], directBlockIds: [], effectiveMessageIds: [], compressedTokens: 0,
        generation: "young", survivedCount: 0, createdAt: 0,
    })) };
    const messages = options.messages ?? snapshot();
    const before = structuredClone({ state: session.state, messages, metadata: session.metadata });
    const logs: string[] = [];
    const pool = core.search(query, session.state);
    const text = executeSearchContext({ query, limit: options.limit ?? 1 }, core, session.state, options.foreign ? "foreign" : undefined,
        options.disabled ? undefined : { messages, session, log: (line) => logs.push(line) }).text;
    assert.deepEqual({ state: session.state, messages, metadata: session.metadata }, before, "search must remain read-only");
    const blockIds = [...text.matchAll(/^(\S+) \(T\d+\) /gm)].map((match) => match[1]);
    return { text, blockIds, logs, pool, messages };
}

test("raw coverage remains a tie-breaker for SQL operators, single-letter variables and all-grammar queries", () => {
    for (const [query, target, distractor] of [
        ["IS NULL", "IS NULL", "NULL budget"],
        ["slot a", "slot a", "slot x budget"],
        ["is", "is", "budget"],
        ["the is a", "the is a", "the budget"],
        ["`a` slot", "`a` slot", "slot budget"],
        ['"is" operator', '"is" operator', "operator budget"],
    ]) {
        const result = search(query, [distractor, target]);
        assert.equal(result.blockIds[0], "b2", query);
    }
});

test("semantic coverage survives grammar count, case, repetition and candidate-order perturbations", () => {
    const pairs = ["jwt issuer", "refund ledger", "embedding dimension", "checkpoint resume", "rollback artifact", "deadlock trace"];
    const framing = ["the", "what is the", "where is a", "how are the", "THE IS A", "the the the is is a",
        "what, is the", "who which where when why how", "a an the is are was were be been being what who which where when why how"];
    let comparisons = 0;
    for (const terms of pairs) for (const grammar of framing) for (const reverse of [false, true]) {
        const target = terms;
        const distractor = `${grammar} ${terms.split(" ")[0]} budget`;
        const result = search(`${grammar}\t${terms}`, reverse ? [target, distractor] : [distractor, target]);
        assert.equal(result.pool.length, 2, "both candidates must participate in reranking");
        assert.equal(result.blockIds[0], reverse ? "b1" : "b2", `${grammar} ${terms}, reversed=${reverse}`);
        comparisons++;
    }
    assert.equal(comparisons, 108);
});

test("disabled, foreign, absent-plan, invalid-plan and small-pool paths retain their established policy", () => {
    const summaries = ["JWT issuer", "what is the jwt budget", "the budget", "what the budget"];
    for (const query of ["what is the jwt issuer", "THE IS A jwt issuer", "jwt issuer"]) {
        const plain = search(query, summaries, { disabled: true });
        for (const options of [{ disabled: true }, { messages: [] }, { limit: summaries.length }]) {
            const result = search(query, summaries, options);
            const comparison = search(query, summaries, { ...options, disabled: true });
            assert.equal(result.text, comparison.text, `${query}: bypass output`);
            assert.equal(result.logs.length, 0);
        }
        const foreign = search(query, summaries, { foreign: true });
        assert.equal(foreign.text, search(query, summaries, { foreign: true, disabled: true }).text);
        assert.deepEqual(foreign.blockIds, plain.blockIds);
        assert.equal(foreign.logs.length, 0);
        const invalid = snapshot();
        invalid[0].text += "!";
        const legacy = search(query, summaries, { messages: invalid });
        assert.deepEqual(legacy.blockIds, legacyPlanRank(legacy.pool, legacy.messages, 1));
        assert.ok(legacy.logs.every((line) => !line.includes("content=")), "unrecognized schemas keep legacy diagnostics");
    }
});

test("narrowing hints ignore grammar but retain useful missing evidence and the original minimum query length", () => {
    const cleaned = search("what is the jwt issuer", ["JWT issuer", "what is the budget"]);
    assert.equal(cleaned.blockIds[0], "b1");
    assert.ok(!cleaned.text.includes('try searching "what"'));
    assert.ok(!cleaned.text.includes("[tip:"));
    const useful = search("the jwt issuer", ["jwt budget", "issuer"]);
    assert.match(useful.text, /try searching "issuer" alone/);
    const short = search("jwt issuer", ["jwt budget", "issuer"]);
    assert.ok(!short.text.includes("[tip:"), "two raw query terms still do not trigger a narrowing hint");
    const legacy = search("what is the jwt issuer", ["JWT issuer", "what is the budget"], { disabled: true });
    assert.match(legacy.text, /try searching "what" alone/, "the default-off path remains unchanged");
});

test("diagnostics distinguish substantive coverage and retain the old format for keyword queries", () => {
    const result = search("what is the jwt issuer", ["JWT issuer", "what is the budget"]);
    assert.match(result.logs.join("\n"), /b1\(content=2\/2,query=\d\/5,plan=/);
    const plain = search("jwt issuer", ["JWT issuer", "jwt budget"]);
    assert.ok(!plain.logs.join("\n").includes("content="));
    assert.match(plain.logs.join("\n"), /b1\(query=2\/2,plan=/);
});
