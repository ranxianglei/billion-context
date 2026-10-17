import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseNotesPayload } from "../scripts/release-notes-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Pins the release-notes payload contract at PR time. The Publish Release
// Notes workflow only validates AFTER merge (push to master + paths filter),
// so an over-cap entry could only fail one step too late — runs 38040163381
// (0.1.191: 401 chars) and 38152721758 (0.1.192: 520 chars), fixed in #2818.
// These tests give the guard teeth: a planted violation must turn it red
// rather than passing vacuously.

const realPayload = JSON.parse(
    readFileSync(path.join(root, "release-notes/package.json"), "utf8"),
).billionContextReleaseNotes;

const clone = () => structuredClone(realPayload);

test("the real payload passes (golden anchor)", () => {
    assert.deepEqual(validateReleaseNotesPayload(realPayload), []);
    assert.ok(realPayload.releases.length >= 1, "payload unexpectedly empty");
});

test("summary over the 400-char cap is the exact original error", () => {
    const p = clone();
    p.releases[0].summary = "x".repeat(401);
    assert.deepEqual(validateReleaseNotesPayload(p), [
        `${p.releases[0].version} : summary too long (401 chars, cap 400)`,
    ]);
});

test("the cap is inclusive at 400", () => {
    const p = clone();
    p.releases[0].summary = "x".repeat(400);
    assert.deepEqual(validateReleaseNotesPayload(p), []);
});

test("bilingual backfill shape stays under the cap (the 0.1.192 lesson)", () => {
    // EN paragraph + " | " + Chinese paragraph is the format that broke 401/520.
    const p = clone();
    p.releases[0].summary =
        "x".repeat(197) + " 丨 " + "y".repeat(200); // 400 exactly, bilingual-shaped
    assert.deepEqual(validateReleaseNotesPayload(p), []);
});

test("tier must be one of the three", () => {
    const p = clone();
    p.releases[0].tier = "optional";
    assert.deepEqual(validateReleaseNotesPayload(p), [
        `${p.releases[0].version} : tier must be routine|recommended|critical, got "optional"`,
    ]);
});

test("duplicate versions are rejected", () => {
    const p = clone();
    p.releases[1] = structuredClone(p.releases[0]);
    assert.ok(
        validateReleaseNotesPayload(p).some((e) => e === `duplicate entry for ${p.releases[0].version}`),
    );
});

test("invalid semver version is rejected", () => {
    const p = clone();
    p.releases[0].version = "0.1";
    assert.ok(validateReleaseNotesPayload(p).some((e) => e.startsWith("invalid version:")));
});

test("bad date format is rejected", () => {
    const p = clone();
    p.releases[0].date = "2026/10/12";
    assert.deepEqual(validateReleaseNotesPayload(p), [
        `${p.releases[0].version} : date must be YYYY-MM-DD, got "2026/10/12"`,
    ]);
});

test("entry count is capped at 20 (the consumer cap)", () => {
    const p = clone();
    for (let i = 0; p.releases.length <= 21; i++) {
        p.releases.push({ ...p.releases[0], version: `9.9.${i}` });
    }
    assert.ok(validateReleaseNotesPayload(p).some((e) => e.startsWith("releases must hold 1..20 entries")));
});

test("schema shape is checked first", () => {
    assert.deepEqual(validateReleaseNotesPayload(null), [
        "invalid billionContextReleaseNotes payload (need schema:1 + releases array)",
    ]);
    assert.deepEqual(validateReleaseNotesPayload({ schema: 2, releases: [] }), [
        "invalid billionContextReleaseNotes payload (need schema:1 + releases array)",
    ]);
});
