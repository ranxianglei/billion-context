/**
 * Deterministic, synthetic retrieval evaluation; no network or model calls.
 * Run: node --import tsx scripts/eval-plan-state-retrieval.ts [--json path]
 * Before editing production ranking: add --assert-legacy-baseline.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { executeSearchContext, extractPlanState } from "../src/decompress-shared.ts";
import { createSession } from "../src/session.ts";
import { PLAN_RETRIEVAL_CASES, type PlanRetrievalCase } from "../tests/fixtures/plan-state-retrieval-cases.ts";
import { PLAN_QUERY_REGRESSION_CASES } from "../tests/fixtures/plan-state-retrieval-query-regressions.ts";
import { PLAN_RETRIEVAL_CHALLENGES, type PlanChallengeCase } from "../tests/fixtures/plan-state-retrieval-challenges.ts";
import { LEGACY_PLAN_COMMIT, legacyExtractPlanState, legacyFallbackMessages, legacyPlanRank, legacyRankTerms } from "../tests/fixtures/legacy-plan-aware.ts";

type RetrievalArm = "lexical" | "legacy" | "status-only" | "status-aware";
const RETRIEVAL_ARMS: readonly RetrievalArm[] = ["lexical", "legacy", "status-only", "status-aware"];
type PlanRetrievalInput = Pick<PlanRetrievalCase | PlanChallengeCase, "id" | "query" | "blocks" | "planningMessages" | "protectedPatterns">;

function messagesOf(fixture: PlanRetrievalInput): CoreMessage[] {
    return fixture.planningMessages.map((message, index) => ({
        id: `eval-plan-${index}`, role: "assistant", contentType: "tool-call", ...message,
    }));
}

export function executePlanRetrievalSearch(
    fixture: PlanRetrievalInput,
    arm: RetrievalArm,
    options: { query?: string; limit?: number; messages?: CoreMessage[] } = {},
): { blockIds: string[]; text: string | null; candidateCount: number } {
    const core = createCore();
    const session = createSession(`plan-retrieval-eval-${fixture.id}`);
    const blocks = fixture.blocks.map((block): CompressionBlock => ({
        ...block, runId: "eval", tier: 1, active: true,
        directMessageIds: [], directBlockIds: [], effectiveMessageIds: [],
        compressedTokens: 0, generation: "young", survivedCount: 0, createdAt: 0,
    }));
    session.state = { ...session.state, blocks };
    const query = options.query ?? fixture.query;
    const limit = options.limit ?? 1;
    assert.ok(Number.isInteger(limit) && limit > 0, "evaluation limits must be positive integers");
    const messages = options.messages ?? messagesOf(fixture);
    const protectedPatterns = fixture.protectedPatterns ? [...fixture.protectedPatterns] : undefined;
    const pool = core.search(query, session.state);
    if (arm === "status-only") {
        return {
            blockIds: legacyRankTerms(pool, extractPlanState(messages, protectedPatterns)?.terms ?? null, limit),
            text: null,
            candidateCount: pool.length,
        };
    }
    const legacyMessages = arm === "legacy" ? legacyFallbackMessages(messages) : messages;
    if (arm === "legacy") {
        assert.deepEqual(legacyExtractPlanState(legacyMessages, protectedPatterns), legacyExtractPlanState(messages, protectedPatterns),
            `${fixture.id}: rendering the legacy arm must preserve its exact term weights`);
        assert.deepEqual(extractPlanState(legacyMessages, protectedPatterns)?.terms ?? null, legacyExtractPlanState(messages, protectedPatterns)?.terms ?? null,
            `${fixture.id}: the runtime fallback must match the frozen legacy terms`);
    }
    const result = executeSearchContext({ query, limit }, core, session.state, undefined,
        arm === "lexical" ? undefined : { messages: legacyMessages, session, protectedPatterns, log: () => {} });
    const blockIds = [...result.text.matchAll(/^(\S+) \(T\d+\) /gm)].map((match) => match[1]);
    const expected = arm === "lexical" ? pool.slice(0, limit).map((block) => block.blockId)
        : arm === "legacy" ? legacyPlanRank(pool, messages, limit, protectedPatterns) : undefined;
    if (expected) assert.deepEqual(blockIds, expected, `${fixture.id}: ${arm} tool output must match its reference ordering`);
    assert.ok(blockIds.every((id) => pool.some((block) => block.blockId === id)), "reranking must not introduce candidates");
    return { blockIds, text: result.text, candidateCount: pool.length };
}

function metrics(top1: readonly string[], top3: readonly string[], relevant: readonly string[]) {
    const index = top3.findIndex((id) => relevant.includes(id));
    return {
        precisionAt1: top1.length > 0 && relevant.includes(top1[0]) ? 1 : 0,
        reciprocalRankAt3: index >= 0 ? 1 / (index + 1) : 0,
    };
}

function evaluatePlanRetrievalCase(fixture: PlanRetrievalCase | PlanChallengeCase) {
    const arms = Object.fromEntries(RETRIEVAL_ARMS.map((arm) => {
        const top1 = executePlanRetrievalSearch(fixture, arm, { limit: 1 });
        const top3 = executePlanRetrievalSearch(fixture, arm, { limit: 3 });
        assert.ok(top3.candidateCount > 3, `${fixture.id}: the corpus must exercise reranking at both requested limits`);
        return [arm, { top1, top3, ...metrics(top1.blockIds, top3.blockIds, fixture.relevantBlockIds) }];
    })) as Record<RetrievalArm, {
        top1: ReturnType<typeof executePlanRetrievalSearch>;
        top3: ReturnType<typeof executePlanRetrievalSearch>;
        precisionAt1: number;
        reciprocalRankAt3: number;
    }>;
    const legacyOrderPreserved = JSON.stringify(arms.legacy.top3.blockIds) === JSON.stringify(arms["status-aware"].top3.blockIds)
        && JSON.stringify(arms.legacy.top1.blockIds) === JSON.stringify(arms["status-aware"].top1.blockIds);
    return {
        fixture,
        arms,
        legacyOrderPreserved,
        compatibilityPassed: !fixture.preserveLegacyOrder || legacyOrderPreserved,
        pairedChange: {
            versusLexical: {
                precisionAt1: arms["status-aware"].precisionAt1 - arms.lexical.precisionAt1,
                reciprocalRankAt3: arms["status-aware"].reciprocalRankAt3 - arms.lexical.reciprocalRankAt3,
            },
            versusLegacy: {
                precisionAt1: arms["status-aware"].precisionAt1 - arms.legacy.precisionAt1,
                reciprocalRankAt3: arms["status-aware"].reciprocalRankAt3 - arms.legacy.reciprocalRankAt3,
            },
            versusStatusOnly: {
                precisionAt1: arms["status-aware"].precisionAt1 - arms["status-only"].precisionAt1,
                reciprocalRankAt3: arms["status-aware"].reciprocalRankAt3 - arms["status-only"].reciprocalRankAt3,
            },
        },
    };
}

type CaseResult = ReturnType<typeof evaluatePlanRetrievalCase>;

function aggregate(results: readonly CaseResult[]) {
    return Object.fromEntries(RETRIEVAL_ARMS.map((arm) => [arm, {
        cases: results.length,
        precisionAt1: results.reduce((sum, result) => sum + result.arms[arm].precisionAt1, 0) / results.length,
        mrrAt3: results.reduce((sum, result) => sum + result.arms[arm].reciprocalRankAt3, 0) / results.length,
    }]));
}

function pairedChanges(results: readonly CaseResult[]) {
    return Object.fromEntries((["lexical", "legacy", "status-only"] as const).map((baseline) => [baseline,
        Object.fromEntries((["precisionAt1", "reciprocalRankAt3"] as const).map((metric) => {
            const differences = results.map((result) => result.arms["status-aware"][metric] - result.arms[baseline][metric]);
            return [metric, {
                improved: differences.filter((value) => value > 0).length,
                unchanged: differences.filter((value) => value === 0).length,
                regressed: differences.filter((value) => value < 0).length,
                meanChange: differences.reduce((sum, value) => sum + value, 0) / differences.length,
            }];
        })),
    ]));
}

function runPlanRetrievalEvaluation() {
    const cases = PLAN_RETRIEVAL_CASES.map(evaluatePlanRetrievalCase);
    const queryRegressions = PLAN_QUERY_REGRESSION_CASES.map(evaluatePlanRetrievalCase);
    const challenges = PLAN_RETRIEVAL_CHALLENGES.map(evaluatePlanRetrievalCase);
    const challengeCategories = [...new Set(PLAN_RETRIEVAL_CHALLENGES.map((fixture) => fixture.category))];
    const categories = [...new Set(PLAN_RETRIEVAL_CASES.map((fixture) => fixture.category))];
    const corpusPath = fileURLToPath(new URL("../tests/fixtures/plan-state-retrieval-cases.ts", import.meta.url));
    return {
        protocol: "Synthetic fixed corpus; real core.search for all arms. Lexical/legacy/status-aware use executeSearchContext; status-only is rank-only ablation. No model calls or autonomous-agent success claims.",
        legacyCommit: LEGACY_PLAN_COMMIT,
        legacyRenderingMethod: "Append a tokenizer-ignored ! to known snapshot tools to exercise the actual raw-text fallback; assert its terms and returned ranks against the frozen pre-change implementation.",
        statusOnlyMethod: "Production extractPlanState terms with the frozen overlap score/order and the same candidate-count gate; query coverage disabled. text=null because this diagnostic does not render tool output and is not a production mode.",
        corpusSha256: createHash("sha256").update(readFileSync(corpusPath)).digest("hex"),
        corpusContentSha256: createHash("sha256").update(JSON.stringify(PLAN_RETRIEVAL_CASES)).digest("hex"),
        metricDefinition: "P@1 at limit=1; MRR@3 at limit=3, using separate tool calls (rank-only for status-only). Either accepted label counts for multi-relevant cases.",
        overall: aggregate(cases),
        byCategory: Object.fromEntries(categories.map((category) => [category, aggregate(cases.filter((result) => result.fixture.category === category))])),
        pairedChanges: {
            overall: pairedChanges(cases),
            byCategory: Object.fromEntries(categories.map((category) => [category, pairedChanges(cases.filter((result) => result.fixture.category === category))])),
        },
        compatibility: { cases: cases.filter((result) => result.fixture.preserveLegacyOrder).length, failedIds: cases.filter((result) => !result.compatibilityPassed).map((result) => result.fixture.id) },
        queryRegressionSupplement: {
            protocol: "Four adversarial cases discovered during review after the initial corpus evaluation; these are regression evidence, not held-out quality estimates. Kept separate from the frozen 28-case totals.",
            initialGuardPrecisionAt1: PLAN_QUERY_REGRESSION_CASES.filter((fixture) => fixture.relevantBlockIds.includes(fixture.initialStatusAwareTop1)).length / PLAN_QUERY_REGRESSION_CASES.length,
            overall: aggregate(queryRegressions),
            pairedChanges: pairedChanges(queryRegressions),
            cases: queryRegressions,
        },
        challengeSupplement: {
            protocol: "Twenty review-time diagnostic cases across four domains and six behavior categories, authored after implementation with labels recorded before execution. Includes compatibility-contract oracles; not held-out task-quality evidence and not pooled into the original 28 cases.",
            corpusContentSha256: createHash("sha256").update(JSON.stringify(PLAN_RETRIEVAL_CHALLENGES)).digest("hex"),
            overall: aggregate(challenges),
            byCategory: Object.fromEntries(challengeCategories.map((category) => [category, aggregate(challenges.filter((result) => result.fixture.category === category))])),
            pairedChanges: pairedChanges(challenges),
            compatibility: { cases: challenges.filter((result) => result.fixture.preserveLegacyOrder).length, failedIds: challenges.filter((result) => !result.compatibilityPassed).map((result) => result.fixture.id) },
            cases: challenges,
        },
        cases,
    };
}

function main() {
    const args = process.argv.slice(2);
    const allowedFlags = new Set(["--json", "--assert-legacy-baseline"]);
    for (let i = 0; i < args.length; i++) {
        assert.ok(allowedFlags.has(args[i]), `unknown argument: ${args[i]}`);
        if (args[i] === "--json") { assert.ok(args[i + 1] && !args[i + 1].startsWith("--"), "--json requires a path"); i++; }
    }
    const report = runPlanRetrievalEvaluation();
    if (args.includes("--assert-legacy-baseline")) {
        assert.ok(report.cases.every((result) => result.legacyOrderPreserved), "the frozen legacy ordering must match the unmodified runtime for every case");
    }
    console.log(report.protocol);
    console.log(`Corpus: ${report.cases.length} cases, sha256 ${report.corpusSha256}`);
    console.table(report.overall);
    for (const [category, values] of Object.entries(report.byCategory)) { console.log(category); console.table(values); }
    console.log("Review-time query regression supplement (separate from frozen corpus)");
    console.table(report.queryRegressionSupplement.overall);
    console.log("Review-time diversity challenge supplement (separate diagnostic corpus)");
    console.table(report.challengeSupplement.overall);
    console.table(report.cases.map((result) => ({
        id: result.fixture.id, expected: result.fixture.relevantBlockIds.join("|"),
        lexical: result.arms.lexical.top1.blockIds.join(","), legacy: result.arms.legacy.top1.blockIds.join(","),
        statusOnly: result.arms["status-only"].top1.blockIds.join(","),
        current: result.arms["status-aware"].top1.blockIds.join(","),
        deltaP1: result.pairedChange.versusLegacy.precisionAt1,
        deltaMRR3: Number(result.pairedChange.versusLegacy.reciprocalRankAt3.toFixed(3)),
    })));
    const outputIndex = args.indexOf("--json");
    if (outputIndex >= 0) {
        const output = resolve(args[outputIndex + 1]);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`Wrote ${output}`);
    }
    assert.deepEqual(report.compatibility.failedIds, [], "unsupported-input compatibility controls must pass");
    assert.deepEqual(report.challengeSupplement.compatibility.failedIds, [], "challenge compatibility controls must pass");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
