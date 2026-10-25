import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(root, ".github", "workflows", "lane-leak-guard.yml");
const LANE_BRANCH = "bugfix-v1.0.0";
const GITHUB_REF_NAME = `refs/heads/${LANE_BRANCH}`;

// Regression for #4695: the per-merge leak test was an `A && B && C` chain, so a
// NON-leak merge left `git merge-base --is-ancestor` (exit 1) as the loop body's
// final status. Under `set -euo pipefail` that poisoned the pipeline and killed
// the job at the LEAKS=$(...) assignment with ZERO output — red-flagging every
// clean lane merge, and (worse) swallowing a real leak's evidence line whenever
// a clean merge was processed after it. This suite executes the guard's ACTUAL
// run block (single source of truth, not a copy) against throwaway lane repos so
// the fix is pinned where it ships.

// Extract the literal-block `run: |` script straight from the YAML. No yaml parser
// is a dependency, so replicate the block-scalar rule: collect the indented body,
// stop at the first line dedented back to the `run:` key, strip the common indent.
function extractRunBlock(yamlText: string): string {
    const lines = yamlText.split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*run:\s*\|/.test(l));
    if (start === -1) throw new Error("lane-leak-guard.yml: 'run: |' block not found");
    const keyIndent = lines[start].length - lines[start].trimStart().length;
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === "") { body.push(""); continue; }
        const indent = l.length - l.trimStart().length;
        if (indent <= keyIndent) break; // back to a sibling/parent key -> block ended
        body.push(l);
    }
    const first = body.find((l) => l.trim() !== "");
    if (!first) throw new Error("lane-leak-guard.yml: empty run block");
    const contentIndent = first.length - first.trimStart().length;
    return body.map((l) => (l.trim() === "" ? "" : l.slice(contentIndent))).join("\n") + "\n";
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).replace(/\n+$/, "");
}

// Build a throwaway lane: a released base tag, linear unshipped master work, and a
// lane cut from the tag carrying a legit side-carry merge whose second parent is
// NOT a master ancestor. kind="leaked" additionally merges master into the lane
// (newest), whose second parent IS a master ancestor — the leak the guard exists
// to catch. master stays merge-free so its commits never pollute `--merges`.
function makeLaneRepo(parent: string, kind: "clean" | "leaked"): { workDir: string; headSha: string } {
    const dir = path.join(parent, kind);
    const originDir = path.join(dir, "origin.git");
    const workDir = path.join(dir, "work");
    fs.mkdirSync(workDir, { recursive: true }); // also materializes the per-kind dir
    execFileSync("git", ["init", "--bare", "-q", originDir], { cwd: dir });
    git(workDir, "init", "-q", "-b", "master");
    git(workDir, "config", "user.email", "t@t.local");
    git(workDir, "config", "user.name", "t");
    const commit = (msg: string, file: string) => {
        fs.writeFileSync(path.join(workDir, file), file + "\n");
        git(workDir, "add", "-A");
        git(workDir, "commit", "-q", "-m", msg);
    };
    commit("base", "base.txt");
    git(workDir, "tag", "v1.0.0");
    commit("master m1", "m1.txt");
    commit("master m2", "m2.txt");
    git(workDir, "remote", "add", "origin", originDir);
    git(workDir, "push", "-q", "origin", "master", "--tags");
    git(workDir, "fetch", "-q", "origin", "master", "--tags");
    git(workDir, "checkout", "-q", "-b", LANE_BRANCH, "v1.0.0");
    // legit side carry: a merge whose P2 is not a master ancestor (never a leak)
    git(workDir, "checkout", "-q", "-b", "sidefix", "v1.0.0");
    commit("side fix", "side.txt");
    git(workDir, "checkout", "-q", LANE_BRANCH);
    git(workDir, "merge", "-q", "--no-ff", "sidefix", "-m", "clean side carry");
    if (kind === "leaked") {
        git(workDir, "merge", "-q", "--no-ff", "origin/master", "-m", "BAD merge master into lane");
    }
    return { workDir, headSha: git(workDir, "rev-parse", "HEAD") };
}

function runGuard(workDir: string, scriptPath: string): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync("bash", [scriptPath], {
        cwd: workDir,
        encoding: "utf8",
        env: { ...process.env, GITHUB_REF_NAME },
    });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("lane-leak-guard probe: clean lane passes, a real leak fails loudly (#4695)", (t) => {
    // The guard runs under POSIX bash (runs-on: ubuntu-latest) and the defect is
    // specifically bash's pipefail/set -e semantics — skip honestly where no
    // usable bash exists (Windows CI legs) rather than papering over it.
    const probe = spawnSync("bash", ["--version"]);
    if (process.platform === "win32" || probe.error || probe.status !== 0) {
        t.skip("lane-leak-guard runs under POSIX bash; no usable bash on this platform");
        return;
    }

    const script = extractRunBlock(fs.readFileSync(WORKFLOW, "utf8"));
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bili-laneleak-"));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const scriptPath = path.join(base, "guard.sh");
    fs.writeFileSync(scriptPath, script);

    const clean = makeLaneRepo(base, "clean");
    const cleanRes = runGuard(clean.workDir, scriptPath);
    assert.equal(cleanRes.status, 0, `clean lane must PASS (exit 0), got ${cleanRes.status}:\n${cleanRes.stdout}\n${cleanRes.stderr}`);
    assert.match(cleanRes.stdout, /no lane leaks/, "clean lane must print the pass line");
    assert.doesNotMatch(cleanRes.stdout, /::error::/, "clean lane must raise no error annotation");

    const leaked = makeLaneRepo(base, "leaked");
    const leakedRes = runGuard(leaked.workDir, scriptPath);
    assert.equal(leakedRes.status, 1, `leaked lane must FAIL (exit 1), got ${leakedRes.status}:\n${leakedRes.stdout}\n${leakedRes.stderr}`);
    assert.match(leakedRes.stdout, /::error::lane leak detected/, "real leak must raise the error annotation");
    assert.ok(
        leakedRes.stdout.includes(leaked.headSha),
        `leak evidence must name the offending merge sha ${leaked.headSha} (the swallowed-leak half of #4695):\n${leakedRes.stdout}`,
    );
});
