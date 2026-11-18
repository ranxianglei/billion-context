import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface Run {
    id: number;
    status: string;
    event: string;
    head_branch: string | null;
    head_repository: { full_name: string } | null;
    created_at: string;
}

const workflow = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/ci-janitor.yml"), "utf8");
const script = workflow.slice(workflow.indexOf("          set -euo pipefail")).replace(/^ {10}/gm, "");
const available = process.platform === "linux"
    && spawnSync("bash", ["--version"]).status === 0
    && spawnSync("jq", ["--version"]).status === 0;

function run(id: number, repo: string | null, branch: string | null, age = 0): Run {
    return {
        id, status: "in_progress", event: "pull_request", head_branch: branch,
        head_repository: repo ? { full_name: repo } : null,
        created_at: new Date(Date.now() - age * 60_000).toISOString(),
    };
}

function sweep(runs: Run[], responses: Record<string, number>, dryRun = false) {
    const dir = mkdtempSync(path.join(tmpdir(), "ci-janitor-"));
    try {
        writeFileSync(path.join(dir, "data.json"), JSON.stringify({ runs, responses }));
        writeFileSync(path.join(dir, "calls.jsonl"), "");
        writeFileSync(path.join(dir, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");
const dir = process.env.JANITOR_FIXTURE;
const { runs, responses } = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
const args = process.argv.slice(2);
const endpoint = args.find(value => value.startsWith("repos/"));
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(endpoint) + "\\n");
if (endpoint.includes("/actions/runs?status=")) {
    const status = new URL("https://fixture/" + endpoint).searchParams.get("status");
    const query = args[args.indexOf("--jq") + 1];
    const result = cp.spawnSync("jq", ["-r", query], {
        input: JSON.stringify({ workflow_runs: runs.filter(run => run.status === status) }), encoding: "utf8",
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
}
const status = endpoint.endsWith("/cancel") ? 202 : (responses[endpoint] ?? 404);
if (args.includes("--include")) process.stdout.write("HTTP/2.0 " + status + "\\n\\n");
process.stdout.write("{}\\n");
process.exit(status >= 400 ? 1 : 0);
`);
        chmodSync(path.join(dir, "gh"), 0o755);
        // Keep the workflow's temporary inventory inside this fixture too.
        const result = spawnSync("bash", ["-c", script.replaceAll("/tmp/janitor-runs.tsv", path.join(dir, "runs.tsv"))], {
            encoding: "utf8",
            env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, JANITOR_FIXTURE: dir,
                REPO: "owner/project", SELF_ID: "999", QUEUE_MAX: "120", PROGRESS_MAX: "240",
                STARVED_QUEUE: "30", STARVED_QUEUE_MAX: "60", DRY_RUN: dryRun ? "1" : "", GH_TOKEN: "" },
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const calls = readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string);
        return { calls, cancelled: calls.filter(call => call.endsWith("/cancel")), output: result.stdout };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("janitor keeps a live fork head and looks it up in its owning repository", { skip: !available }, () => {
    const result = sweep([run(1, "contributor/project", "fix/a+b")], {
        "repos/contributor/project/branches/fix%2Fa%2Bb": 200,
    });
    assert.deepEqual(result.cancelled, []);
    assert.ok(result.calls.includes("repos/contributor/project/branches/fix%2Fa%2Bb"));
});

test("janitor distinguishes equal branch names in different repositories", { skip: !available }, () => {
    const result = sweep([run(1, "contributor/project", "same-name")], {
        "repos/owner/project/branches/same-name": 200,
        "repos/contributor/project": 200,
    });
    assert.deepEqual(result.cancelled, ["repos/owner/project/actions/runs/1/cancel"]);
});

test("janitor still cancels a deleted same-repository branch", { skip: !available }, () => {
    const result = sweep([run(2, "owner/project", "deleted")], { "repos/owner/project": 200 });
    assert.deepEqual(result.cancelled, ["repos/owner/project/actions/runs/2/cancel"]);
});

for (const status of [403, 429, 500]) {
    test(`janitor does not interpret HTTP ${status} as a deleted branch`, { skip: !available }, () => {
        const result = sweep([run(3, "owner/project", "live")], {
            "repos/owner/project/branches/live": status, "repos/owner/project": 200,
        });
        assert.deepEqual(result.cancelled, []);
    });
}

test("janitor does not infer deletion from an inaccessible repository or missing head metadata", { skip: !available }, () => {
    const result = sweep([run(4, "hidden/project", "live"), run(5, null, "live"), run(6, "owner/project", null)], {});
    assert.deepEqual(result.cancelled, []);
});

test("janitor retains age cleanup and protects scheduled master runs", { skip: !available }, () => {
    const result = sweep([
        run(7, "contributor/project", "live", 300),
        { ...run(8, "owner/project", "master", 300), event: "schedule" },
    ], { "repos/contributor/project/branches/live": 200 });
    assert.deepEqual(result.cancelled, ["repos/owner/project/actions/runs/7/cancel"]);
});

test("janitor dry-run reports deleted branches without cancelling", { skip: !available }, () => {
    const result = sweep([run(9, "owner/project", "deleted")], { "repos/owner/project": 200 }, true);
    assert.deepEqual(result.cancelled, []);
    assert.match(result.output, /head branch .*deleted/);
});
