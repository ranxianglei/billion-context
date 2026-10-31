/** Review-driven diagnostics, not a held-out or live-agent benchmark. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { executePlanRetrievalSearch } from "./eval-plan-state-retrieval.ts";
import { PLAN_RETRIEVAL_CASES } from "../tests/fixtures/plan-state-retrieval-cases.ts";
import { PLAN_QUERY_REGRESSION_CASES } from "../tests/fixtures/plan-state-retrieval-query-regressions.ts";
import { PLAN_RETRIEVAL_CHALLENGES } from "../tests/fixtures/plan-state-retrieval-challenges.ts";
import { PLAN_QUERY_WORD_CASES, PLAN_QUERY_WORD_DIAGNOSTICS } from "../tests/fixtures/plan-query-word-cases.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface BaselineRow {
    id: string; inputSha256: string; relevantBlockIds: string[];
    outputs: Array<{ limit: number; blockIds: string[]; textSha256: string; candidateCount: number }>;
}
const baseline = JSON.parse(readFileSync(new URL("../tests/fixtures/plan-query-word-baseline.json", import.meta.url), "utf8")) as {
    sourceCommit: string; sourceSha256: string; groups: { original: BaselineRow[]; queryWords: BaselineRow[] };
};
const groups = { original28: PLAN_RETRIEVAL_CASES, reviewed4: PLAN_QUERY_REGRESSION_CASES, challenges20: PLAN_RETRIEVAL_CHALLENGES, queryWords35: PLAN_QUERY_WORD_CASES };
const results = Object.fromEntries(Object.entries(groups).map(([group, fixtures]) => {
    const rows = fixtures.map((fixture) => {
        const before = [...baseline.groups.original, ...baseline.groups.queryWords].find((row) => row.id === fixture.id);
        assert.ok(before, fixture.id);
        assert.equal(hash(JSON.stringify(fixture)), before.inputSha256, `${fixture.id}: frozen labels/inputs changed`);
        const after = [1, 3].map((limit) => executePlanRetrievalSearch(fixture, "status-aware", { limit }));
        const p1 = (ids: readonly string[]) => Number(fixture.relevantBlockIds.includes(ids[0]));
        const mrr = (ids: readonly string[]) => { const i = ids.findIndex(id => fixture.relevantBlockIds.includes(id)); return i < 0 ? 0 : 1 / (i + 1); };
        return {
            id: fixture.id, category: fixture.category, query: fixture.query, rationale: fixture.rationale,
            relevantBlockIds: fixture.relevantBlockIds,
            before: { top1: before.outputs[0].blockIds, top3: before.outputs[1].blockIds, p1: p1(before.outputs[0].blockIds), mrr3: mrr(before.outputs[1].blockIds) },
            after: { top1: after[0].blockIds, top3: after[1].blockIds, p1: p1(after[0].blockIds), mrr3: mrr(after[1].blockIds) },
            unchangedOutputs: after.filter((r, i) => hash(r.text!) === before.outputs[i].textSha256).length,
            candidateCountsPreserved: after.every((r, i) => r.candidateCount === before.outputs[i].candidateCount),
        };
    });
    const summary = {
        cases: rows.length,
        beforePassed: rows.reduce((n, r) => n + r.before.p1, 0), afterPassed: rows.reduce((n, r) => n + r.after.p1, 0),
        beforeMrr3: rows.reduce((n, r) => n + r.before.mrr3, 0) / rows.length,
        afterMrr3: rows.reduce((n, r) => n + r.after.mrr3, 0) / rows.length,
        p1Regressions: rows.filter(r => r.after.p1 < r.before.p1).map(r => r.id),
        mrr3Regressions: rows.filter(r => r.after.mrr3 < r.before.mrr3).map(r => r.id),
        unchangedOutputs: rows.reduce((n, r) => n + r.unchangedOutputs, 0),
        remainingFailures: rows.filter(r => !r.after.p1).map(r => r.id),
    };
    assert.ok(rows.every(r => r.candidateCountsPreserved), `${group}: candidate generation changed`);
    assert.equal(summary.p1Regressions.length, 0, `${group}: previously correct answers regressed`);
    assert.equal(summary.mrr3Regressions.length, 0, `${group}: reciprocal rank regressed`);
    if (group !== "queryWords35") assert.equal(summary.unchangedOutputs, fixtures.length * 2, `${group}: old tool output changed`);
    return [group, { summary, rows }];
}));
const report = {
    protocol: "Frozen pre-fix outputs from the real search path; no relabelling. Groups reported separately. Synthetic targeted diagnostics, not general production accuracy or model task success.",
    baselineCommit: baseline.sourceCommit, baselineSourceSha256: baseline.sourceSha256,
    candidateSourceSha256: hash(readFileSync(new URL("../src/decompress-shared.ts", import.meta.url), "utf8")),
    results, limitations: PLAN_QUERY_WORD_DIAGNOSTICS,
};
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, group]) => [name, group.summary])), null, 2));
const out = process.argv.indexOf("--json");
if (out !== -1) {
    assert.ok(process.argv[out + 1], "--json requires a path");
    writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 2) + "\n");
}
