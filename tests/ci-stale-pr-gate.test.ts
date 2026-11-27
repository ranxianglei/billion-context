// #7785 — stale-PR CI gate + label-trigger discipline.
//
// Two regressions this locks down:
//  (a) pushes to PRs older than 72h kept paying the full core matrix. The
//      ci.yml plan job now computes STALE from PR_CREATED_AT and skips the
//      matrix unless ci:force (or ci:full / release heuristics) outranks it.
//  (b) 2026-11-26 incident: an attempt to filter the `labeled` arm at the
//      TRIGGER level (workflow-level top-level `if:`) shipped a file that
//      GitHub's schema rejects — every workflow run on that commit died in
//      seconds with zero jobs and the PR's pull_request events created no
//      runs at all. Top-level `if:` is NOT a supported workflow key (only
//      job/step/matrix levels are), so this test guards that it never comes
//      back. Non-CI labels still create a run, but the first job of each
//      workflow skips it after ~10s (the in-job labeled gate is the only
//      supported filtering point).
//
// Part 1 is a static guard over the workflow files (always runs).
// Part 2 extracts the ci.yml plan bash script and executes it with env
// fixtures, asserting the scope decision per case (needs linux + bash + jq).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WF_DIR = path.resolve(import.meta.dirname, "../.github/workflows");
const wf = (name: string): string => readFileSync(path.join(WF_DIR, name), "utf8");

test("no workflow file carries an unsupported top-level `if:` (#7785 regression)", () => {
    const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"));
    assert.ok(files.length >= 15, `expected >= 15 workflow files, saw ${files.length}`);
    for (const f of files) {
        // A top-level `if:` is a column-0 key followed by a block scalar or a
        // plain expression — the 2026-11-26 incident shape. Job-level `if:`
        // is always indented, so a column-0 match is unambiguous.
        assert.ok(
            !/^if:\s*(\||.*)$/m.test(wf(f)),
            `${f}: top-level 'if:' is not a valid GitHub Actions workflow key — it makes every run on the file die with zero jobs`,
        );
    }
});

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
