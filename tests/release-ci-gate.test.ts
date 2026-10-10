// Regression tests for scripts/release-ci-gate.mjs — the publish-blocking CI
// gate shared by all four release workflows (release.yml, release-bugfix.yml,
// release-kernel.yml, release-manual.yml). Introduced with the policy that
// every release channel must run the full CI lane set at the exact publish
// sha before npm publish (follow-up to the v0.1.192 carve-out, #2664).
//
// Runs the real script as a child process against an inline mock of the
// GitHub Actions API (list-runs + dispatch endpoints) — no network, no token.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/release-ci-gate.mjs");

type Run = { id: number; head_sha: string; status: string; conclusion: string | null };
const runs = new Map<string, Run>(); // `${workflow}@${sha}` -> newest run
const dispatchLog: string[] = [];
const failDispatch = new Set<string>();
let flakyGetsLeft = 0; // first N runs-listing GETs respond 500 (transient-failure injection)

const mock = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
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
      dispatchLog.push(`${wf}@${JSON.parse(body).ref}`);
      res.writeHead(204).end();
    });
    return;
  }
  if (flakyGetsLeft > 0) {
    flakyGetsLeft -= 1;
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "internal error" }));
    return;
  }
  const run = runs.get(`${wf}@${url.searchParams.get("head_sha")}`);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ workflow_runs: run ? [run] : [] }));
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
  runs.clear();
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
  runs.clear();
  failDispatch.add("ci-e2e.yml");
  const r = await gate(["--dispatch"], { REQUIRED_CI_WORKFLOWS: "ci-e2e.yml" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /HTTP 422/);
  assert.match(r.out, /Refusing to publish/);
});

test("release-ci-gate wait: passes once every lane is green at the publish sha", async () => {
  runs.clear();
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
  runs.clear();
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
  runs.clear();
  runs.set("ci.yml@publish", { id: 1, head_sha: "publish", status: "completed", conclusion: "failure" });
  runs.set("ci.yml@prhead", { id: 2, head_sha: "prhead", status: "completed", conclusion: "success" });
  const r = await gate(["--wait"], { REQUIRED_CI_WORKFLOWS: "ci.yml", EXTRA_MATCH_SHAS: "prhead" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /RED/);
});

test("release-ci-gate: green run at extra sha counts as satisfied (PR-head reuse, no extra CI)", async () => {
  runs.clear();
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
  runs.clear();
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
  runs.clear();
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

let port = 0;
test.before(async () => {
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  port = (mock.address() as { port: number }).port;
});
test.after(async () => {
  await new Promise((done) => mock.close(done));
});
