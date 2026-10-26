#!/usr/bin/env node
// lifecycle-ledger-guard.mjs — #3249: every BILI_* env var read from src/ must be
// registered in LIFECYCLE.md (§1 transition ledger or §2 permanent registry).
//
//   node scripts/lifecycle-ledger-guard.mjs          # CI mode: exit 1 on unregistered vars
//   node scripts/lifecycle-ledger-guard.mjs report   # always exit 0, print findings
//
// POSTURE (same as config-surface-guard.mjs): an env var read in src/ but ABSENT from
// LIFECYCLE.md is a FAILURE — a new switch without a lifecycle entry is exactly the
// rot this ledger exists to stop. A ledger entry with no live reader is a NOTICE
// only: dynamic names (BILI_ROLLOUT_<feature>), branches not yet on master
// (BILI_ANTHROPIC_THREADS_INJECT lives in open PR #2888) and retired-but-still-warned
// reads legitimately lag the code.
//
// Extraction covers every way src/ names an env var: direct property reads, bracket
// reads, `env.X` param reads, and quoted name literals — including helper-call sites
// like tInt("BILI_X", fileValue) in src/knobs.ts that never touch process.env on the
// same line. Names in §3 (non-env identifiers sharing the BILI_ prefix) are exempt
// from the missing/stale checks by section, not by name list.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const SRC_DIR = join(repoRoot, "src");
const LEDGER = join(repoRoot, "LIFECYCLE.md");

const DIRECT = /process\.env\.([A-Z][A-Z0-9_]*)/g;
const BRACKET = /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;
const PARAM = /\benv\.([A-Z][A-Z0-9_]*)/g;
const QUOTED = /["'](BILI_[A-Z0-9_]+)["']/g;

function stripComments(src) {
  return src
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("//");
      if (hash >= 0 && !line.slice(0, hash).match(/["'`]/)) return line.slice(0, hash);
      return line;
    })
    .join("\n");
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function extractEnvNames() {
  const names = new Set();
  for (const file of walk(SRC_DIR)) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const re of [DIRECT, BRACKET, PARAM]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m[1].startsWith("BILI_")) names.add(m[1]);
      }
    }
    QUOTED.lastIndex = 0;
    let qm;
    while ((qm = QUOTED.exec(text))) names.add(qm[1]);
  }
  return [...names].sort();
}

// Tokens in §3 are non-env identifiers: exempt from the stale notice by section.
function splitLedgerTokens(text) {
  const s3Start = text.indexOf("## 3.");
  const s3End = s3Start >= 0 ? text.indexOf("## 4.", s3Start) : -1;
  const s3Slice = s3Start >= 0 ? text.slice(s3Start, s3End > s3Start ? s3End : undefined) : "";
  const rest = s3Start >= 0 ? text.slice(0, s3Start) + (s3End > s3Start ? text.slice(s3End) : "") : text;
  const tok = (s) => [...new Set([...s.matchAll(/BILI_[A-Z0-9_]+/g)].map((m) => m[0]))];
  return { active: tok(rest), exempt: tok(s3Slice) };
}

const isPrefixToken = (t) => t.endsWith("_");
const isPlaceholder = (t) => t.includes("<");

function runChecks() {
  const ledgerText = readFileSync(LEDGER, "utf8");
  const { active, exempt } = splitLedgerTokens(ledgerText);
  const readers = extractEnvNames();

  const exemptSet = new Set(exempt);
  const missing = readers.filter((name) => {
    if (exemptSet.has(name)) return false; // §3 identifier quoted somewhere in src/
    if (active.includes(name)) return false;
    // A registered prefix token (e.g. BILI_ROLLOUT_) covers its dynamic family.
    return !active.some((t) => isPrefixToken(t) && name.startsWith(t));
  });

  const readerSet = new Set(readers);
  const stale = active.filter(
    (t) => !isPrefixToken(t) && !isPlaceholder(t) && !readerSet.has(t),
  );

  return { readers, missing, stale, exempt };
}

function main() {
  const mode = process.argv[2] ?? "check";
  const { readers, missing, stale, exempt } = runChecks();
  console.log(`lifecycle-ledger: ${readers.length} BILI_* env names read from src/, ${activeCount(readers)} ledger entries active, ${exempt.length} §3 identifiers exempt`);
  if (stale.length) {
    console.log(`notice: ${stale.length} ledger entr${stale.length === 1 ? "y has" : "ies have"} no live reader in src/ (expected for dynamic/unmerged/retired names): ${stale.join(", ")}`);
  }
  if (missing.length === 0) {
    console.log("OK: every BILI_* env var read from src/ is registered in LIFECYCLE.md");
    return;
  }
  console.error(`FAIL: ${missing.length} BILI_* env var(s) read from src/ but NOT in LIFECYCLE.md:`);
  for (const n of missing) console.error(`  - ${n}`);
  console.error("Add them to §1 (transition, with release condition) or §2 (permanent) of LIFECYCLE.md.");
  if (mode !== "report") process.exitCode = 1;
}

function activeCount(readers) {
  try {
    const { active } = splitLedgerTokens(readFileSync(LEDGER, "utf8"));
    return active.filter((t) => !isPlaceholder(t)).length;
  } catch {
    return 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
