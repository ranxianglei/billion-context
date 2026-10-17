#!/usr/bin/env node
// release-notes guard — PR-time validation for release-notes/package.json.
// Zero-dep: plain node, no npm install (same posture as config-surface-guard.mjs).
//
// Why this exists: the 400-char summary cap in the Publish Release Notes
// workflow was only enforced AFTER merge (push to master + paths filter) — it
// can never hold a PR, so over-cap entries failed one step too late:
//   - run 38040163381 (2026-10-10): 0.1.191 summary 401 chars
//   - run 38152721758 (2026-10-11): 0.1.192 summary 520 chars (f24e3e8d backfill)
// both fixed in #2818. This script holds the SAME contract at PR time via
// ci.yml's release-notes-guard job; release-notes.yml calls it too, so there
// is exactly one copy of the rules. Messages are kept verbatim from the
// original inline validator for greppability.
//
// Contract (schema 1):
//   releases: newest-first, 1..20 entries; fields per entry:
//   version (valid semver, unique), date (YYYY-MM-DD, optional),
//   tier (routine | recommended | critical), summary (non-empty, <=400 chars).
//
// Usage:
//   node scripts/release-notes-guard.mjs [path]   # default release-notes/package.json

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SUMMARY_CAP = 400;
const TIERS = new Set(["routine", "recommended", "critical"]);
// Practical zero-dep semver core (X.Y.Z with optional prerelease/build) — the
// payload only ever carries plain release tags.
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function validateReleaseNotesPayload(payload) {
    const errors = [];
    const p = payload;
    if (!p || typeof p !== "object" || p.schema !== 1 || !Array.isArray(p.releases)) {
        return ["invalid billionContextReleaseNotes payload (need schema:1 + releases array)"];
    }
    if (p.releases.length === 0 || p.releases.length > 20) {
        errors.push(`releases must hold 1..20 entries (got ${p.releases.length})`);
    }
    const seen = new Set();
    for (const e of p.releases) {
        if (!SEMVER.test(String(e.version))) {
            errors.push(`invalid version: ${JSON.stringify(e.version)}`);
        } else if (seen.has(e.version)) {
            errors.push(`duplicate entry for ${e.version}`);
        }
        seen.add(e.version);
        if (!TIERS.has(e.tier)) {
            errors.push(`${e.version} : tier must be routine|recommended|critical, got ${JSON.stringify(e.tier)}`);
        }
        if (typeof e.summary !== "string" || !e.summary.trim()) {
            errors.push(`${e.version} : summary must be a non-empty string`);
        } else if (e.summary.length > SUMMARY_CAP) {
            errors.push(`${e.version} : summary too long (${e.summary.length} chars, cap ${SUMMARY_CAP})`);
        }
        if (e.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
            errors.push(`${e.version} : date must be YYYY-MM-DD, got ${JSON.stringify(e.date)}`);
        }
    }
    return errors;
}

function main() {
    const target = process.argv[2] ?? "release-notes/package.json";
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const file = path.resolve(repoRoot, target);
    let payload;
    try {
        payload = JSON.parse(readFileSync(file, "utf8")).billionContextReleaseNotes;
    } catch (err) {
        console.error(`release-notes-guard: cannot read payload: ${err.message}`);
        process.exit(1);
    }
    const errors = validateReleaseNotesPayload(payload);
    if (errors.length > 0) {
        for (const e of errors) console.error(e);
        process.exit(1);
    }
    console.log(`release-notes-guard: ${payload.releases.length} entries ok (summary cap ${SUMMARY_CAP})`);
}

// Only run as a CLI when invoked directly — importing validateReleaseNotesPayload in tests must not fire main().
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main();
}
