import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { attachConfigDriftNote } = await import("../src/launcher.js");

// #4705: re-attaching to a running helper serves its BOOT-time config — process-level
// opts are cached from loadOptions() and never re-read, so a disk edit made while the
// helper is alive stays inert until a shutdown+respawn. attachConfigDriftNote decides
// whether to surface that drift loudly at attach time. Both directions asserted (#3617):
// it warns when it must, and stays silent when it must not.

test("attachConfigDriftNote: differing epochs -> actionable stale-config warning", () => {
    const note = attachConfigDriftNote("epoch-at-boot", "edited-after-boot");
    assert.ok(note);
    assert.match(note, /STALE config/);
    assert.match(note, /__bili\/shutdown/);
});

test("attachConfigDriftNote: matching epochs -> silent (config in sync)", () => {
    assert.equal(attachConfigDriftNote("abc123", "abc123"), undefined);
});

test("attachConfigDriftNote: pre-#4705 resident (no epoch) -> unknown, silent", () => {
    assert.equal(attachConfigDriftNote(undefined, "abc123"), undefined);
});

test("attachConfigDriftNote: blank epoch sentinel on either side -> silent", () => {
    assert.equal(attachConfigDriftNote("abc123", ""), undefined);
    assert.equal(attachConfigDriftNote("", ""), undefined);
});
