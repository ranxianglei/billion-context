#!/usr/bin/env node
// patch-gate.mjs — runtime shims for scripts/release-gate-local.mjs so the gate
// works against KEYED public model APIs, not just keyless local sglang.
//
// Every patch is GUARDED: applied only when the exact upstream pattern is found
// exactly once; otherwise it prints SKIPPED (upstream already has the feature,
// or the script changed shape — fail loudly in the summary, never silently).
//
// Upstream PR (to make these shims unnecessary) should add:
//   GATE_PRIMARY_KEY (default "gate-local") fed into BILI_GATE_KEY, and
//   reachability-based probes (any HTTP response counts — 401/404 still proves
//   the endpoint is alive; only network errors mean "service down").
import fs from "node:fs";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("patch-gate: no target file: " + file);
  process.exit(2);
}
let src = fs.readFileSync(file, "utf8");
let fail = 0;

function patchOnce(name, find, replace) {
  const n = src.split(find).length - 1;
  if (n === 0) {
    console.log(`patch-gate: SKIP ${name} (pattern not present — already patched upstream?)`);
    return;
  }
  if (n > 1) {
    console.log(`patch-gate: FAIL ${name} (pattern found ${n}x, expected 1)`);
    fail++;
    return;
  }
  src = src.replace(find, replace);
  console.log(`patch-gate: applied ${name}`);
}

// 1) Let the primary-lane credential come from the environment instead of the
//    hardcoded "gate-local" bearer (dsh sends it as Authorization; bili
//    forwards client credentials to the upstream).
patchOnce(
  "GATE_PRIMARY_KEY credential",
  'BILI_GATE_KEY: "gate-local",',
  'BILI_GATE_KEY: env("GATE_PRIMARY_KEY", "gate-local"),',
);

// 2) Reachability probes: treat ANY HTTP response as "service up". Keyed APIs
//    answer 401 without a bearer; some gateways 404 on /v1/models — neither
//    means the model lane is unusable, and the old res.ok-only probe would
//    hard-abort Lane A on every keyed public API.
patchOnce(
  "probe helper",
  "async function httpOk(url, ms = 5000) {",
  `async function probeUp(url, ms, key) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms ?? 4000);
    const res = await fetch(url, { signal: ac.signal, headers: key ? { authorization: "Bearer " + key } : {} });
    clearTimeout(t);
    return res.status > 0; // any HTTP response = endpoint alive (401/404 included)
  } catch {
    return false;
  }
}

async function httpOk(url, ms = 5000) {`,
);
patchOnce(
  "sglang probe",
  "const sglangOk = await httpOk(`${G.sglangUrl}/v1/models`, 4000);",
  "const sglangOk = await probeUp(`${G.sglangUrl}/v1/models`, 4000, env(\"GATE_PRIMARY_KEY\", \"gate-local\"));",
);
// Relay lane: try /v1/models first (standard OpenAI-compatible), fall back to /.
patchOnce(
  "relay probe",
  "const relayOk = await httpOk(`${G.relayUrl}/`, 3000);",
  "const relayOk = await probeUp(`${G.relayUrl}/v1/models`, 3000, G.relayKey) || await probeUp(`${G.relayUrl}/`, 3000, G.relayKey);",
);

fs.writeFileSync(file, src);
process.exit(fail ? 1 : 0);
