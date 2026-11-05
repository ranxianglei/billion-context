// Regression tests for scripts/release-ci-gate.mjs — the publish-blocking CI
// gate shared by all four release workflows (release.yml, release-bugfix.yml,
// release-kernel.yml, release-manual.yml). Introduced with the policy that
// every release channel must run the full CI lane set at the exact publish
// sha before npm publish (follow-up to the v0.1.192 carve-out, #2664).
//
// Runs the real script as a child process against an inline mock of the
// GitHub Actions API (list-runs + dispatch + branches + cancel endpoints) —
// no network, no token. #3539 additions: head-match refusal before dispatch,
// scoped stale-run cancellation, track-head waiting, --probe-reuse, and
// CI_FULL_DISPATCH payloads.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/release-ci-gate.mjs");

type Run = {
  id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  event?: string;
  created_at?: string;
};
const runs = new Map<string, Run>(); // `${workflow}@${sha}` -> run
const dispatchLog: string[] = [];
const dispatchBodies: unknown[] = [];
const cancelLog: number[] = [];
const branchHeads = new Map<string, string>(); // ref -> head sha (default "publish")
const failDispatch = new Set<string>();
let flakyGetsLeft = 0; // first N runs-listing GETs respond 500 (transient-failure injection)

function resetState() {
  runs.clear();
  dispatchLog.length = 0;
  dispatchBodies.length = 0;
  cancelLog.length = 0;
  branchHeads.clear();
}

const mock = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const br = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/branches\/([^/]+)$/);
  if (br) {
    const ref = decodeURIComponent(br[1]);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ commit: { sha: branchHeads.get(ref) ?? "publish" } }),
    );
    return;
  }
  const cx = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/cancel$/);
  if (cx) {
    cancelLog.push(Number(cx[1]));
    res.writeHead(204).end();
    return;
  }
  const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/(runs|dispatches)$/);
  if (!m) {
    res.writeHead(404).end("{}");
    return;
  }
  const wf = decodeURIComponent(m[2]);
  if (m[3] === "dispatches") {
    if (failDispatch.has(wf)) {
      res.writeHead(422).end(JSON.stringify({ message: "Workflow does not have 'workflow_dispatch' trigger" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      dispatchLog.push(`${wf}@${parsed.ref}`);
      dispatchBodies.push(parsed);
      res.writeHead(204).end();
    });
    return;
  }
  if (flakyGetsLeft > 0) {
    flakyGetsLeft -= 1;
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "internal error" }));
    return;
  }
  // With a head_sha filter: only that sha's runs; without: every run of the
  // workflow (the stale-run scan shape).
  const headSha = url.searchParams.get("head_sha");
  const list = [...runs.entries()]
    .filter(([k, r]) => k.startsWith(`${wf}@`) && (!headSha || r.head_sha === headSha))
    .map(([, r]) => r);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ workflow_runs: list }));
});

function gate(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: "acme/expr",
        GITHUB_SHA: "publish",
        GITHUB_REF_NAME: "master",
        API_BASE: `http://127.0.0.1:${port}`,
        GITHUB_OUTPUT: "",
        ...env,
      },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
}

test("release-ci-gate dispatch: dry-run reports missing lanes only", async (t) => {
  await t.diagnostic("seed: ci.yml completed/green at publish, ci-e2e-fake in_progress, ci-e2e-dsh absent");
  resetState();
  runs.set("ci.yml@publish", { id: 1, head_sha: "publish", status: "completed", conclusion: "success" });
  runs.set("ci-e2e-fake.yml@publish", { id: 2, head_sha: "publish", status: "in_progress", conclusion: null });
  const r = await gate(["--dispatch"], {
    REQUIRED_CI_WORKFLOWS: "ci.yml,ci-e2e-fake.yml,ci-e2e-dsh.yml",
    DRY_RUN: "1",
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would dispatch ci-e2e-dsh\.yml/);
  assert.doesNotMatch(r.out, /would dispatch ci\.yml/); // has a run — never re-dispatched
  assert.match(r.out, /running\s+ci-e2e-fake\.yml/);
  assert.deepEqual(dispatchLog, []);
});

test("release-ci-gate dispatch: fires missing lanes, idempotent on rerun", async () => {
  resetState();
  runs.set("ci.yml@publish", { id: 1, head_sha: "publish", status: "completed", conclusion: "success" });
  const env = { REQUIRED_CI_WORKFLOWS: "ci.yml,ci-e2e.yml" };
  const r1 = await gate(["--dispatch"], env);
  assert.equal(r1.code, 0, r1.out);
  assert.match(r1.out, /dispatched ci-e2e\.yml at ref master/);
  assert.deepEqual(dispatchLog, ["ci-e2e.yml@master"]);
  // real GitHub would now have a run for the dispatched lane
  runs.set("ci-e2e.yml@publish", { id: 3, head_sha: "publish", status: "queued", conclusion: null });
  const r2 = await gate(["--dispatch"], env);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /no missing lanes/);
  assert.equal(dispatchLog.length, 1); // not fired twice
});

test("release-ci-gate dispatch: un-dispatchable missing lane is a hard failure", async () => {
  resetState();
  failDispatch.add("ci-e2e.yml");
  const r = await gate(["--dispatch"], { REQUIRED_CI_WORKFLOWS: "ci-e2e.yml" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /HTTP 422/);
  assert.match(r.out, /Refusing to publish/);
  failDispatch.delete("ci-e2e.yml");
});

test("release-ci-gate wait: passes once every lane is green at the publish sha", async () => {
  resetState();
  runs.set("ci.yml@publish", { id: 1, head_sha: "publish", status: "completed", conclusion: "success" });
  runs.set("ci-e2e-fake.yml@publish", { id: 2, head_sha: "publish", status: "in_progress", conclusion: null });
  setTimeout(() => runs.set("ci-e2e-fake.yml@publish", { id: 2, head_sha: "publish", status: "completed", conclusion: "success" }), 1500);
  const r = await gate(["--wait"], {
    REQUIRED_CI_WORKFLOWS: "ci.yml,ci-e2e-fake.yml",
    CI_GATE_POLL_SEC: "1",
    CI_GATE_TIMEOUT_MIN: "1",
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /full CI gate PASSED — all 2 lanes green/);
});

test("release-ci-gate wait: red lane fails fast and blocks publish", async () => {
  resetState();
  runs.set("ci.yml@publish", { id: 1, head_sha: "publish", status: "completed", conclusion: "success" });
  runs.set("ci-e2e-fake.yml@publish", { id: 2, head_sha: "publish", status: "completed", conclusion: "failure" });
  const r = await gate(["--wait"], {
    REQUIRED_CI_WORKFLOWS: "ci.yml,ci-e2e-fake.yml",
    CI_GATE_POLL_SEC: "1",
    CI_GATE_TIMEOUT_MIN: "1",
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /RED at the publish sha: ci-e2e-fake\.yml/);
  assert.match(r.out, /refusing to publish/);
});

test("release-ci-gate wait: red at publish sha is never overridden by a green extra (PR-head) sha", async () => {
  resetState();
  runs.set("ci.yml@publish", { id: 1, head_sha: "publish", status: "completed", conclusion: "failure" });
  runs.set("ci.yml@prhead", { id: 2, head_sha: "prhead", status: "completed", conclusion: "success" });
  const r = await gate(["--wait"], { REQUIRED_CI_WORKFLOWS: "ci.yml", EXTRA_MATCH_SHAS: "prhead" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /RED/);
});

test("release-ci-gate: green run at extra sha counts as satisfied (PR-head reuse, no extra CI)", async () => {
  resetState();
  runs.set("ci.yml@prhead", { id: 2, head_sha: "prhead", status: "completed", conclusion: "success" });
  const r = await gate(["--dispatch"], {
    REQUIRED_CI_WORKFLOWS: "ci.yml",
    EXTRA_MATCH_SHAS: "prhead",
    DRY_RUN: "1",
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no missing lanes/);
  assert.match(r.out, /reused green run at prhead/);
});

test("release-ci-gate wait: timeout with a lane still missing blocks publish", async () => {
  resetState();
  const r = await gate(["--wait"], {
    REQUIRED_CI_WORKFLOWS: "ci-e2e.yml",
    CI_GATE_POLL_SEC: "1",
    CI_GATE_TIMEOUT_MIN: "0.05",
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /timed out/);
  assert.match(r.out, /ci-e2e\.yml/);
});

test("release-ci-gate dispatch: transient API errors on read-only calls are retried, not fatal", async () => {
  resetState();
  runs.set("ci.yml@prhead", { id: 2, head_sha: "prhead", status: "completed", conclusion: "success" });
  // First two runs-listing GETs get HTTP 500; the retried third succeeds.
  flakyGetsLeft = 2;
  const r = await gate(["--dispatch"], {
    REQUIRED_CI_WORKFLOWS: "ci.yml",
    EXTRA_MATCH_SHAS: "prhead",
    DRY_RUN: "1",
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /reused green run at prhead/);
});

test("release-ci-gate dispatch: refuses when ref head != target sha (nothing dispatched)", async () => {
  resetState();
  branchHeads.set("master", "moved-head");
  const r = await gate(["--dispatch"], { REQUIRED_CI_WORKFLOWS: "ci-e2e.yml" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ref master head is moved-head/);
  assert.match(r.out, /refusing to dispatch/);
  assert.deepEqual(dispatchLog, []); // the whole point: no runners burned on the wrong sha
});

test("release-ci-gate dispatch: cancels only stale in-flight runs from this attempt", async () => {
  resetState();
  const t0 = Date.now();
  const nowIso = new Date(t0).toISOString();
  const soonIso = new Date(t0 + 60_000).toISOString();
  const oldIso = new Date(t0 - 3_600_000).toISOString();
  runs.set("ci-e2e.yml@stale-dispatch", { id: 101, head_sha: "stale-dispatch", status: "in_progress", conclusion: null, event: "workflow_dispatch", created_at: soonIso });
  runs.set("ci-e2e.yml@push-triggered", { id: 102, head_sha: "push-triggered", status: "in_progress", conclusion: null, event: "push", created_at: soonIso });
  runs.set("ci-e2e.yml@publish", { id: 103, head_sha: "publish", status: "in_progress", conclusion: null, event: "workflow_dispatch", created_at: soonIso });
  runs.set("ci-e2e.yml@pre-attempt", { id: 104, head_sha: "pre-attempt", status: "in_progress", conclusion: null, event: "workflow_dispatch", created_at: oldIso });
  const r = await gate(["--dispatch"], {
    REQUIRED_CI_WORKFLOWS: "ci-e2e.yml",
    RELEASE_RUN_STARTED_AT: nowIso,
  });
  assert.equal(r.code, 0, r.out);
  // 101 alone: 102 is push-triggered, 103 sits at the target sha, 104 predates the attempt.
  assert.deepEqual(cancelLog, [101], r.out);
  assert.match(r.out, /cancelled stale run 101/);
  assert.match(r.out, /no missing lanes/);
});

test("release-ci-gate dispatch: stale cancellation disabled without RELEASE_RUN_STARTED_AT", async () => {
  resetState();
  runs.set("ci-e2e.yml@stale-dispatch", { id: 101, head_sha: "stale-dispatch", status: "in_progress", conclusion: null, event: "workflow_dispatch", created_at: new Date().toISOString() });
  runs.set("ci-e2e.yml@publish", { id: 103, head_sha: "publish", status: "completed", conclusion: "success" });
  const r = await gate(["--dispatch"], { REQUIRED_CI_WORKFLOWS: "ci-e2e.yml" });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(cancelLog, []);
});

test("release-ci-gate wait: track-head follows branch movement, cancels stale, re-targets to green", async () => {
  resetState();
  const t0 = Date.now();
  const startIso = new Date(t0).toISOString();
  const mk = (sha: string, status: string, conclusion: string | null, id: number): Run => ({
    id,
    head_sha: sha,
    status,
    conclusion,
    event: "workflow_dispatch",
    created_at: new Date().toISOString(),
  });
  branchHeads.set("master", "h1");
  runs.set("ci.yml@h1", mk("h1", "completed", "success", 200));
  runs.set("ci-e2e.yml@h1", mk("h1", "in_progress", null, 201));
  // The v0.1.198 queue stomp (#3534): master merged into the release branch
  // mid-release moves the head; the old-head run KEEPS RUNNING (GitHub does
  // not delete superseded runs) until something cancels it.
  setTimeout(() => {
    branchHeads.set("master", "h2");
    runs.set("ci.yml@h2", mk("h2", "completed", "success", 202));
    runs.set("ci-e2e.yml@h2", mk("h2", "in_progress", null, 203));
  }, 2500);
  setTimeout(() => runs.set("ci-e2e.yml@h2", mk("h2", "completed", "success", 203)), 5000);
  const r = await gate(["--wait"], {
    REQUIRED_CI_WORKFLOWS: "ci.yml,ci-e2e.yml",
    GITHUB_SHA: "h1",
    WAIT_TRACK_HEAD: "1",
    RELEASE_RUN_STARTED_AT: startIso,
    CI_GATE_POLL_SEC: "1",
    CI_GATE_TIMEOUT_MIN: "2",
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /branch head moved: h1 → h2/);
  assert.deepEqual(cancelLog, [201], r.out);
  assert.match(r.out, /full CI gate PASSED — all 2 lanes green/);
});

test("release-ci-gate probe-reuse: all lanes green at extra sha → allLanesReused=yes", async () => {
  resetState();
  runs.set("ci.yml@prhead", { id: 1, head_sha: "prhead", status: "completed", conclusion: "success" });
  runs.set("ci-e2e-fake.yml@prhead", { id: 2, head_sha: "prhead", status: "completed", conclusion: "success" });
  // A red run at the publish sha must NOT mask reuse (the merge push auto-fires ci.yml there).
  runs.set("ci.yml@publish", { id: 3, head_sha: "publish", status: "completed", conclusion: "failure" });
  const outFile = path.join(import.meta.dirname, "probe-output.txt");
  try {
    const r = await gate(["--probe-reuse"], {
      REQUIRED_CI_WORKFLOWS: "ci.yml,ci-e2e-fake.yml",
      EXTRA_MATCH_SHAS: "prhead",
      GITHUB_OUTPUT: outFile,
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /reuse probe: ALL 2 lanes reusable/);
    assert.ok(readFileSync(outFile, "utf8").includes("allLanesReused=yes"));
  } finally {
    rmSync(outFile, { force: true });
  }
});

test("release-ci-gate probe-reuse: a lane without a green extra-sha run → allLanesReused=no", async () => {
  resetState();
  runs.set("ci.yml@prhead", { id: 1, head_sha: "prhead", status: "completed", conclusion: "success" });
  runs.set("ci-e2e-fake.yml@prhead", { id: 2, head_sha: "prhead", status: "completed", conclusion: "failure" });
  const outFile = path.join(import.meta.dirname, "probe-output.txt");
  try {
    const r = await gate(["--probe-reuse"], {
      REQUIRED_CI_WORKFLOWS: "ci.yml,ci-e2e-fake.yml",
      EXTRA_MATCH_SHAS: "prhead",
      GITHUB_OUTPUT: outFile,
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /reuse probe: NOT ALL 2 lanes reusable/);
    assert.ok(readFileSync(outFile, "utf8").includes("allLanesReused=no"));
  } finally {
    rmSync(outFile, { force: true });
  }
});

test("release-ci-gate dispatch: CI_FULL_DISPATCH sends inputs.full for ci.yml only", async () => {
  resetState();
  runs.set("ci-e2e.yml@publish", { id: 1, head_sha: "publish", status: "completed", conclusion: "success" });
  const r = await gate(["--dispatch"], {
    REQUIRED_CI_WORKFLOWS: "ci.yml,ci-e2e.yml",
    CI_FULL_DISPATCH: "1",
  });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(dispatchBodies, [{ ref: "master", inputs: { full: true } }]);
  assert.match(r.out, /dispatched ci\.yml at ref master \(full scope\)/);
});

let port = 0;
test.before(async () => {
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  port = (mock.address() as { port: number }).port;
});
test.after(async () => {
  await new Promise((done) => mock.close(done));
});
