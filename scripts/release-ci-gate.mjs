#!/usr/bin/env node
// Release CI gate — enforces the repo policy that EVERY release channel runs
// the COMPLETE CI lane set at the exact publish sha before npm publish.
//
// Motivation: the v0.1.192 carve-out (bugfix-release channel, #2664) shipped
// after its embedded pre-flight gate only — no e2e lane ever ran on that sha,
// because no PR existed and no e2e workflow triggers on bugfix-release/**
// pushes. Owner policy (2026-10-10): no matter the release channel, full CI
// must run before publish.
//
// Modes:
//   --dispatch   Fire (workflow_dispatch) every required lane that has no run
//                at any target sha. Idempotent: lanes with an existing run
//                (any status) are left alone. Call this EARLY in the release
//                workflow so lanes run in parallel with the local pre-flight.
//   --wait       Block until every required lane's latest run at the publish
//                sha is `success`. Reuses an already-green run at one of the
//                EXTRA_MATCH_SHAS (e.g. the PR head sha HEAD^2 — exactly how
//                branch-protection required checks work). Fails fast on any
//                red lane; fails on timeout. MUST run before the publish step.
//
// Env:
//   GITHUB_TOKEN         token with actions:read (+ actions:write for --dispatch)
//   GITHUB_REPOSITORY    owner/repo (auto-provided by Actions)
//   GITHUB_SHA           publish sha — set explicitly in the workflow to
//                        `git rev-parse HEAD` (the tree being published)
//   GITHUB_REF_NAME      ref used as dispatch target (e.g. master, or the
//                        bugfix-release branch)
//   REQUIRED_CI_WORKFLOWS  optional comma list overriding the default set
//   EXTRA_MATCH_SHAS     optional comma list of extra shas whose green runs
//                        satisfy a lane (PR head reuse; never overrides a red
//                        run at the publish sha)
//   CI_GATE_TIMEOUT_MIN  --wait deadline, default 60
//   CI_GATE_POLL_SEC     poll interval, default 20
//   DRY_RUN=1            print what would be dispatched instead of POSTing
//
// Default required set = the full every-PR lane set plus the server-lane e2e
// workflows (path-filtered on PRs but security-relevant for releases):
//   ci.yml, ci-e2e.yml, ci-e2e-fake.yml, ci-e2e-dsh.yml, ci-e2e-dsh-native.yml,
//   ci-e2e-codex-persona.yml, ci-e2e-native.yml, ci-e2e-native-opencode.yml,
//   ci-e2e-pi-ws.yml
// Deliberately excluded: ci-zcode-real.yml (real AppImage + version input),
// ci-windows-codex.yml (no dispatch trigger; windows is covered by the ci.yml
// matrix), ci-theorem.yml / ci-image.yml / ci-registry.yml (path-gated aux
// lanes). Extend via REQUIRED_CI_WORKFLOWS if policy changes.

const DEFAULT_REQUIRED = [
  "ci.yml",
  "ci-e2e.yml",
  "ci-e2e-fake.yml",
  "ci-e2e-dsh.yml",
  "ci-e2e-dsh-native.yml",
  "ci-e2e-codex-persona.yml",
  "ci-e2e-native.yml",
  "ci-e2e-native-opencode.yml",
  "ci-e2e-pi-ws.yml",
];

const RED_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "startup_failure",
  "action_required",
]);

const mode = process.argv[2];
if (mode !== "--dispatch" && mode !== "--wait") {
  console.error("usage: release-ci-gate.mjs --dispatch | --wait");
  process.exit(2);
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const publishSha = (process.env.GITHUB_SHA || "").trim();
const refName = (process.env.GITHUB_REF_NAME || "").trim();
const dryRun = process.env.DRY_RUN === "1";
if (!token || !repo || !publishSha || !refName) {
  console.error("::error::GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_REF_NAME are all required");
  process.exit(2);
}

const required = (process.env.REQUIRED_CI_WORKFLOWS || DEFAULT_REQUIRED.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!required.length) {
  console.error("::error::REQUIRED_CI_WORKFLOWS resolved to an empty set");
  process.exit(2);
}

const extraShas = (process.env.EXTRA_MATCH_SHAS || "")
  .split(",")
  .map((s) => s.trim().replace(/^refs\/heads\//, ""))
  .filter((s) => s && s !== publishSha);

const API = process.env.API_BASE || "https://api.github.com"; // API_BASE: test hook

// Read-only calls tolerate transient API noise (network blips, 5xx, secondary
// rate limits) with bounded retries — one hiccup during a long --wait poll
// must not kill an otherwise-green release. POST dispatches are NEVER retried:
// a double dispatch would burn CI on duplicate runs. Exhausted retries throw,
// which main() turns into exit 1 — the fail-safe direction is unchanged.
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1000;

function isTransientHttp(res) {
  if (res.status === 429 || res.status >= 500) return true;
  return res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
}

async function api(path, init) {
  const readOnly = !init || !init.method || init.method === "GET";
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init?.headers || {}),
        },
      });
    } catch (err) {
      lastErr = err;
      if (readOnly && attempt < RETRY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
        continue;
      }
      throw err;
    }
    if (isTransientHttp(res) && readOnly && attempt < RETRY_ATTEMPTS) {
      if (res.body) await res.body.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
      continue;
    }
    return res;
  }
  throw lastErr;
}

// Newest run of `workflow` at `sha`, or null.
async function latestRunAt(workflow, sha) {
  const res = await api(
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${encodeURIComponent(sha)}&per_page=5`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET runs for ${workflow}@${sha.slice(0, 8)} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const runs = (await res.json()).workflow_runs || [];
  if (!runs.length) return null;
  // Defensive: the API is newest-first, but sort explicitly by run id.
  runs.sort((a, b) => b.id - a.id);
  return runs[0];
}

async function laneStates() {
  const states = {};
  for (const wf of required) {
    const atPublish = await latestRunAt(wf, publishSha);
    if (atPublish) {
      states[wf] = { run: atPublish, via: `publish sha ${publishSha.slice(0, 8)}` };
      continue;
    }
    let reused = null;
    for (const sha of extraShas) {
      const r = await latestRunAt(wf, sha); // eslint-disable-line no-await-in-loop
      if (r && r.conclusion === "success") {
        reused = { run: r, via: `reused green run at ${sha.slice(0, 8)}` };
        break;
      }
    }
    states[wf] = reused || { run: null, via: "no run at any target sha" };
  }
  return states;
}

function classify(state) {
  const run = state?.run;
  if (!run) return "missing";
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") return "green";
  if (RED_CONCLUSIONS.has(run.conclusion)) return "red";
  return `red(${run.conclusion})`; // skipped/stale/neutral — strict: not success
}

function printStates(states) {
  for (const wf of required) {
    const c = classify(states[wf]);
    const r = states[wf]?.run;
    const where = states[wf]?.via || "";
    const detail = r ? `run ${r.id} [${r.event}] ${r.status}${r.conclusion ? "/" + r.conclusion : ""} (${where})` : `(${where})`;
    console.log(`  ${c.padEnd(9)} ${wf.padEnd(30)} ${detail}`);
  }
}

async function dispatchMissing(states) {
  let fired = 0;
  for (const wf of required) {
    if (classify(states[wf]) !== "missing") continue;
    if (dryRun) {
      console.log(`DRY_RUN would dispatch ${wf} at ref ${refName}`);
      fired += 1;
      continue;
    }
    const res = await api(`/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: refName }),
    });
    if (res.status !== 204) {
      const body = await res.text().catch(() => "");
      console.error(`::error::dispatch ${wf} at ref ${refName} → HTTP ${res.status}: ${body.slice(0, 300)}`);
      console.error(`::error::${wf} has no run at ${publishSha.slice(0, 8)} and cannot be dispatched (missing workflow_dispatch trigger, or file absent from the default branch). Refusing to publish without it.`);
      process.exit(1);
    }
    console.log(`dispatched ${wf} at ref ${refName}`);
    fired += 1;
  }
  if (!fired) console.log("no missing lanes — nothing dispatched");
}

async function main() {
  console.log(`release CI gate (${mode.slice(2)}) repo=${repo} publish sha=${publishSha.slice(0, 12)} ref=${refName}`);
  console.log(`required lanes (${required.length}): ${required.join(", ")}`);
  if (extraShas.length) console.log(`extra reuse shas: ${extraShas.map((s) => s.slice(0, 8)).join(", ")}`);

  if (mode === "--dispatch") {
    const states = await laneStates();
    printStates(states);
    await dispatchMissing(states);
    return;
  }

  // --wait
  const timeoutMin = Number(process.env.CI_GATE_TIMEOUT_MIN || 60);
  const pollSec = Number(process.env.CI_GATE_POLL_SEC || 20);
  const deadline = Date.now() + timeoutMin * 60_000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const states = await laneStates();
    const red = required.filter((wf) => classify(states[wf]).startsWith("red"));
    if (red.length) {
      printStates(states);
      console.error(`::error::CI lane(s) RED at the publish sha: ${red.join(", ")} — refusing to publish. Re-run the lane(s) or fix, then retry the release.`);
      process.exit(1);
    }
    if (required.every((wf) => classify(states[wf]) === "green")) {
      printStates(states);
      console.log(`full CI gate PASSED — all ${required.length} lanes green at ${publishSha.slice(0, 12)} (attempt ${attempt})`);
      return;
    }
    if (Date.now() > deadline) {
      printStates(states);
      const pending = required.filter((wf) => classify(states[wf]) !== "green");
      console.error(`::error::CI gate timed out after ${timeoutMin}min waiting for: ${pending.join(", ")} — refusing to publish.`);
      process.exit(1);
    }
    const waiting = required.filter((wf) => classify(states[wf]) === "running");
    const missing = required.filter((wf) => classify(states[wf]) === "missing");
    console.log(
      `attempt ${attempt}: running=${waiting.length} missing=${missing.length} green=${required.length - waiting.length - missing.length} (poll ${pollSec}s, ${Math.ceil((deadline - Date.now()) / 60_000)}min left)${missing.length ? ` missing=[${missing.join(",")}]` : ""}`,
    );
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
