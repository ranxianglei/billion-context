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
//                BEFORE dispatching it verifies the ref's current head equals
//                the target sha and refuses otherwise (#3539): dispatching at
//                a moved head lands runs on the wrong sha where the gate could
//                never see them — previously that burned ~10 runners and then
//                timed out 60 min later (the v0.1.198 queue stomp, #3534).
//   --wait       Block until every required lane's latest run at the target
//                sha is `success`. Reuses an already-green run at one of the
//                EXTRA_MATCH_SHAS (e.g. the PR head sha HEAD^2 — exactly how
//                branch-protection required checks work). Fails fast on any
//                red lane; fails on timeout. MUST run before the publish step.
//   --probe-reuse One-shot, NON-blocking: report whether every required lane
//                already has a green run at one of the EXTRA_MATCH_SHAS,
//                ignoring runs at the publish sha deliberately (a merge push
//                auto-fires ci.yml there and would mask the reuse question).
//                Writes allLanesReused=yes|no to $GITHUB_OUTPUT when set.
//                Report-only: a normal read exits 0; an upstream API error
//                exits non-zero, which the calling step absorbs via
//                continue-on-error:true — so the output stays absent or "no"
//                and callers treat that as "run the local suite anyway"
//                (#3539: release.yml skips its local full pass only when the
//                full suite is provably green at the PR head).
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
//   RELEASE_RUN_STARTED_AT  ISO timestamp scoping stale-run cancellation to
//                        runs created AFTER this release attempt started
//                        (set from ${{ github.run_started_at }}). Absent =>
//                        cancellation disabled (manual use stays untouched).
//   WAIT_TRACK_HEAD=1    --wait mode for branches whose head may move mid-wait
//                        (one-click fallback release branches receiving late
//                        master merges): the target sha follows the branch
//                        head; on movement, stale in-flight runs at the old
//                        head are cancelled and missing lanes re-dispatched
//                        at the new head (#3539).
//   CI_FULL_DISPATCH=1   dispatch ci.yml with inputs.full=true (full matrix
//                        instead of core) so the release branch carries the
//                        COMPLETE lane set in one pass (#3539).
//
// Stale-run cancellation (best-effort hygiene, never blocks the gate): when
// RELEASE_RUN_STARTED_AT is set, in-flight queued/in_progress
// workflow_dispatch runs of the required workflows are cancelled if their
// head_sha differs from the current target AND they were created after the
// release attempt started. Scheduled, push- and PR-triggered runs and runs
// created before this attempt are never touched.
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

import { appendFileSync } from "node:fs";

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
if (mode !== "--dispatch" && mode !== "--wait" && mode !== "--probe-reuse") {
  console.error("usage: release-ci-gate.mjs --dispatch | --wait | --probe-reuse");
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

// Newest up-to-30 runs of `workflow` regardless of sha (stale-run scan).
async function listRecentRuns(workflow) {
  const res = await api(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=30`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET runs for ${workflow} (stale scan) → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const runs = (await res.json()).workflow_runs || [];
  runs.sort((a, b) => b.id - a.id);
  return runs;
}

// Current head sha of `ref`, or null (branch absent).
async function branchHead(ref) {
  const res = await api(`/repos/${repo}/branches/${encodeURIComponent(ref)}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET branch ${ref} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  return j?.commit?.sha || null;
}

// #3539: bounded stale-run cleanup. Only in-flight runs of THIS release
// attempt (created after RELEASE_RUN_STARTED_AT, workflow_dispatch event,
// head different from the current target) are cancelled. Best-effort: any
// failure here warns and moves on — the gate itself remains the safety net.
const runStartedAtMs = Date.parse((process.env.RELEASE_RUN_STARTED_AT || "").trim());

async function cancelStaleRuns(targetSha) {
  if (!Number.isFinite(runStartedAtMs)) return; // no scoping anchor → disabled
  for (const wf of required) {
    try {
      const runs = await listRecentRuns(wf);
      for (const r of runs) {
        if (r.status !== "queued" && r.status !== "in_progress") continue;
        if (r.event !== "workflow_dispatch") continue;
        if (r.head_sha === targetSha) continue;
        const createdMs = Date.parse(r.created_at || "");
        if (!Number.isFinite(createdMs) || createdMs < runStartedAtMs) continue;
        const c = await api(`/repos/${repo}/actions/runs/${r.id}/cancel`, { method: "POST" });
        if (c.ok || c.status === 404) {
          console.log(`cancelled stale run ${r.id} (${wf} @ ${String(r.head_sha).slice(0, 8)}, created ${r.created_at})`);
        } else {
          console.log(`::warning::cancel of stale run ${r.id} (${wf}) returned HTTP ${c.status} — leaving it alone`);
        }
      }
    } catch (err) {
      console.log(`::warning::stale-run cleanup failed for ${wf}: ${err.message} — continuing (cleanup is best-effort)`);
    }
  }
}

async function laneStates(targetSha) {
  const states = {};
  for (const wf of required) {
    const atTarget = await latestRunAt(wf, targetSha);
    if (atTarget) {
      const label = targetSha === publishSha ? "publish sha" : "tracked head";
      states[wf] = { run: atTarget, via: `${label} ${targetSha.slice(0, 8)}` };
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

async function dispatchMissing(states, targetSha) {
  let fired = 0;
  for (const wf of required) {
    if (classify(states[wf]) !== "missing") continue;
    if (dryRun) {
      console.log(`DRY_RUN would dispatch ${wf} at ref ${refName}`);
      fired += 1;
      continue;
    }
    // CI_FULL_DISPATCH: ci.yml's plan job defaults to CORE scope for bare
    // workflow_dispatch; release branches need the FULL matrix so the whole
    // chain pays for the full suite exactly once (#3539).
    const payload = wf === "ci.yml" && process.env.CI_FULL_DISPATCH === "1"
      ? { ref: refName, inputs: { full: true } }
      : { ref: refName };
    const res = await api(`/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status !== 204) {
      const body = await res.text().catch(() => "");
      console.error(`::error::dispatch ${wf} at ref ${refName} → HTTP ${res.status}: ${body.slice(0, 300)}`);
      console.error(`::error::${wf} has no run at ${targetSha.slice(0, 8)} and cannot be dispatched (missing workflow_dispatch trigger, or file absent from the default branch). Refusing to publish without it.`);
      process.exit(1);
    }
    console.log(`dispatched ${wf} at ref ${refName}${payload.inputs ? " (full scope)" : ""}`);
    fired += 1;
  }
  if (!fired) console.log("no missing lanes — nothing dispatched");
}

function writeOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function main() {
  console.log(`release CI gate (${mode.slice(2)}) repo=${repo} publish sha=${publishSha.slice(0, 12)} ref=${refName}`);
  console.log(`required lanes (${required.length}): ${required.join(", ")}`);
  if (extraShas.length) console.log(`extra reuse shas: ${extraShas.map((s) => s.slice(0, 8)).join(", ")}`);

  if (mode === "--probe-reuse") {
    if (!extraShas.length) {
      console.log("reuse probe: no extra match shas provided — nothing to reuse");
      writeOutput("allLanesReused", "no");
      return;
    }
    let all = true;
    for (const wf of required) {
      let greenAt = null;
      for (const sha of extraShas) {
        const r = await latestRunAt(wf, sha); // eslint-disable-line no-await-in-loop
        if (r && r.conclusion === "success") {
          greenAt = sha;
          break;
        }
      }
      if (greenAt) {
        console.log(`  reusable   ${wf.padEnd(30)} green at ${greenAt.slice(0, 8)}`);
      } else {
        console.log(`  absent     ${wf.padEnd(30)} no green run at any extra sha`);
        all = false;
      }
    }
    console.log(`reuse probe: ${all ? "ALL" : "NOT ALL"} ${required.length} lanes reusable from extra shas`);
    writeOutput("allLanesReused", all ? "yes" : "no");
    return;
  }

  if (mode === "--dispatch") {
    const head = await branchHead(refName);
    if (head !== publishSha) {
      console.error(
        `::error::ref ${refName} head is ${head ? head.slice(0, 12) : "unknown"} but the target sha is ${publishSha.slice(0, 12)} — refusing to dispatch: ` +
          `runs would land on the wrong sha where the gate could never see them. Sync the ref to the target sha (or re-cut the release at the current head) and retry.`,
      );
      process.exit(1);
    }
    await cancelStaleRuns(publishSha);
    const states = await laneStates(publishSha);
    printStates(states);
    await dispatchMissing(states, publishSha);
    return;
  }

  // --wait
  const timeoutMin = Number(process.env.CI_GATE_TIMEOUT_MIN || 60);
  const pollSec = Number(process.env.CI_GATE_POLL_SEC || 20);
  const deadline = Date.now() + timeoutMin * 60_000;
  const trackHead = process.env.WAIT_TRACK_HEAD === "1";
  let targetSha = publishSha;
  await cancelStaleRuns(targetSha);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (trackHead) {
      const head = await branchHead(refName);
      if (head && head !== targetSha) {
        console.log(
          `branch head moved: ${targetSha.slice(0, 8)} → ${head.slice(0, 8)} — re-targeting: cancelling stale runs and re-dispatching missing lanes at the new head`,
        );
        targetSha = head;
        await cancelStaleRuns(targetSha);
        await dispatchMissing(await laneStates(targetSha), targetSha);
      }
    }
    const states = await laneStates(targetSha);
    const shaLabel = targetSha === publishSha ? "the publish sha" : `the tracked head ${targetSha.slice(0, 12)}`;
    const red = required.filter((wf) => classify(states[wf]).startsWith("red"));
    if (red.length) {
      printStates(states);
      console.error(`::error::CI lane(s) RED at ${shaLabel}: ${red.join(", ")} — refusing to publish. Re-run the lane(s) or fix, then retry the release.`);
      process.exit(1);
    }
    if (required.every((wf) => classify(states[wf]) === "green")) {
      printStates(states);
      console.log(`full CI gate PASSED — all ${required.length} lanes green at ${targetSha.slice(0, 12)} (attempt ${attempt})`);
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
