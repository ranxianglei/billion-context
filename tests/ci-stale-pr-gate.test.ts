// #7785 — stale-PR CI gate + label-trigger discipline.
//
// Two regressions this locks down:
//  (a) every `labeled` event (ANY label) used to create a run in all 14
//      pull_request workflows — each paying one gate/plan job on a runner
//      before being skipped inside it. The fix is a workflow-level `if:`
//      that lets only the CI labels (ci:full / ci:force) create a run.
//  (b) pushes to PRs older than 72h kept paying the full core matrix. The
//      ci.yml plan job now computes STALE from PR_CREATED_AT and skips the
//      matrix unless ci:force (or ci:full / release heuristics) outranks it.
//
// Part 1 is a static guard over the workflow files (always runs).
// Part 2 extracts the ci.yml plan bash script and executes it with env
// fixtures, asserting the scope decision per case (needs linux + bash + jq).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const wf = (name: string): string =>
    readFileSync(path.resolve(import.meta.dirname, "../.github/workflows", name), "utf8");

// All workflows whose pull_request trigger carries a `labeled` arm (the
// guard set for (a)). Keep in sync with .github/workflows/*.yml.
const LABELED_WORKFLOWS = [
    "ci.yml",
    "ci-e2e.yml",
    "ci-e2e-codex-persona.yml",
    "ci-e2e-dsh.yml",
    "ci-e2e-dsh-native.yml",
    "ci-e2e-fake.yml",
    "ci-e2e-native.yml",
    "ci-e2e-native-opencode.yml",
    "ci-e2e-pi-ws.yml",
    "ci-image.yml",
    "ci-registry.yml",
    "ci-theorem.yml",
    "ci-windows-codex.yml",
    "ci-zcode-real.yml",
    "announcements-lint.yml",
];

for (const name of LABELED_WORKFLOWS) {
    test(`${name}: labeled arm is filtered at the trigger level`, () => {
        const text = wf(name);
        // The guard lives at the WORKFLOW level (top-level `if:`), i.e. in
        // the document outside any job — check it appears before `jobs:`.
        const head = text.split("\njobs:")[0];
        assert.ok(
            head.includes("github.event.action != 'labeled'"),
            `${name}: missing workflow-level labeled filter`,
        );
        assert.ok(
            head.includes("github.event.label.name == 'ci:full'"),
            `${name}: labeled filter must allow ci:full`,
        );
        assert.ok(
            head.includes("github.event.label.name == 'ci:force'"),
            `${name}: labeled filter must allow ci:force (stale-PR re-arm)`,
        );
    });
}

test("ci.yml: plan job carries the 72h stale gate", () => {
    const text = wf("ci.yml");
    assert.ok(
        text.includes("PR_CREATED_AT: ${{ github.event.pull_request.created_at }}"),
        "plan env must pass the PR creation timestamp",
    );
    assert.ok(text.includes("STALE_HOURS=72"), "plan must define the 72h threshold");
    assert.ok(
        text.includes('[ "$STALE" = "1" ] && ! grep -qw ci:force'),
        "stale skip must be re-armable via the ci:force label",
    );
});

// ---------------------------------------------------------------------------
// Part 2 — execute the extracted plan script with env fixtures.
// ---------------------------------------------------------------------------

const bashOk = spawnSync("bash", ["--version"]).status === 0;
const jqOk = spawnSync("jq", ["--version"]).status === 0;
const available = process.platform === "linux" && bashOk && jqOk;

function extractPlanScript(): string {
    const text = wf("ci.yml");
    const stepStart = text.indexOf("id: scope");
    assert.ok(stepStart !== -1, "plan job 'scope' step not found");
    const runStart = text.indexOf("set -euo pipefail", stepStart);
    assert.ok(runStart !== -1, "plan run block start not found");
    const endMarker = 'echo "plan scope: $scope"';
    const end = text.indexOf(endMarker, runStart);
    assert.ok(end !== -1, "plan run block end marker not found");
    return text.slice(runStart, end + endMarker.length).replace(/^ {10}/gm, "");
}

interface ScopeCase {
    name: string;
    env: Record<string, string>;
    expect: string;
}

function hoursAgo(h: number): string {
    return new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
}

const baseEnv: Record<string, string> = {
    GH_TOKEN: "unused",
    EVENT: "pull_request",
    PR_LABELS: "",
    LABEL_EVENT: "",
    PR_AUTHOR: "some-contributor",
    PR_HEAD_REF: "feature-branch",
    PR_BASE_REF: "master",
    PR_TITLE: "some ordinary change",
    PR_CREATED_AT: hoursAgo(1),
    HEAD_SHA: "cafebabe",
    FULL_INPUT: "false",
};

const CASES: ScopeCase[] = [
    { name: "fresh PR push -> core", env: {}, expect: "core" },
    { name: "71h PR push -> core (below the gate)", env: { PR_CREATED_AT: hoursAgo(71) }, expect: "core" },
    { name: "73h PR push -> skip (stale gate)", env: { PR_CREATED_AT: hoursAgo(73) }, expect: "skip" },
    { name: "73h PR push + ci:force label -> core (re-armed)", env: { PR_CREATED_AT: hoursAgo(73), PR_LABELS: "ci:force" }, expect: "core" },
    { name: "73h PR push + ci:full label -> full (label outranks stale)", env: { PR_CREATED_AT: hoursAgo(73), PR_LABELS: "ci:full" }, expect: "full" },
    { name: "labeled event with a random label -> skip (defense in depth)", env: { LABEL_EVENT: "documentation", PR_LABELS: "documentation" }, expect: "skip" },
    { name: "labeled event with ci:full -> full", env: { LABEL_EVENT: "ci:full", PR_LABELS: "ci:full" }, expect: "full" },
    { name: "labeled event with ci:force on a 73h PR -> core", env: { LABEL_EVENT: "ci:force", PR_LABELS: "ci:force", PR_CREATED_AT: hoursAgo(73) }, expect: "core" },
    { name: "push event (release branch) is unaffected by the stale gate", env: { EVENT: "push", PR_CREATED_AT: "" }, expect: "core" },
    {
        name: "stale release-bot PR -> full (release heuristics outrank stale)",
        env: { PR_CREATED_AT: hoursAgo(96), PR_AUTHOR: "github-actions", PR_HEAD_REF: "2026-11-01_release-v0.1.999" },
        expect: "full",
    },
    { name: "workflow_dispatch default -> core", env: { EVENT: "workflow_dispatch" }, expect: "core" },
    { name: "workflow_dispatch full=true -> full", env: { EVENT: "workflow_dispatch", FULL_INPUT: "true" }, expect: "full" },
];

for (const c of CASES) {
    test(`ci.yml plan scope: ${c.name}`, { skip: available ? false : "needs linux + bash + jq" }, () => {
        const script = extractPlanScript();
        const dir = mkdtempSync(path.join(tmpdir(), "ci-stale-gate-"));
        const output = path.join(dir, "github_output");
        writeFileSync(output, "");
        const res = spawnSync("bash", ["-c", script], {
            env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "ranxianglei/billion-context", ...baseEnv, ...c.env },
            encoding: "utf8",
        });
        assert.equal(res.status, 0, `plan script failed: ${res.stderr ?? res.stdout}`);
        const lines = readFileSync(output, "utf8").split("\n");
        const scope = lines.find((l) => l.startsWith("scope="))?.slice(6);
        assert.equal(scope, c.expect, `outputs: ${lines.filter(Boolean).join(" | ")}`);
    });
}
