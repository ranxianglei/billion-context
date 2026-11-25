// #7154: on a bili-owned lane, `/compact` can only fail. The command drives
// the host's own compaction call (compaction-basic → COMPACTION_INSTRUCTION),
// the same envelope bili's wire guard refuses unconditionally (#1729), and
// dsh reports the refusal as "Compaction could not produce a useful summary"
// — a policy decision surfaced as a model failure, with no working retry.
// Both patch carriers therefore stand the command down, with the same static
// semantics as the `compaction-basic: auto:false` row that precedes them
// (a kill-switched bili-native does not bring it back either). This test pins
// BOTH carriers, because they are the only two ways the lane gets mounted:
// the persistent bundle (dsh.bundle.patch.yml) and the launcher's --patch
// overlay (writeDshAcpPatch).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDshAcpPatch } from "../src/launcher.ts";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

const AUTO_OFF_ROW = "- id: compaction-basic\n  config:\n    auto: false\n";
const COMPACT_COMMAND_ROW = "- id: command-compact\n  disabled: true\n";

test("#7154 the bundle layer stands the host-plane /compact command down", () => {
    const bundle = fs.readFileSync(path.join(TESTS_DIR, "..", "dsh.bundle.patch.yml"), "utf8").replaceAll("\r\n", "\n");
    assert.ok(bundle.includes(COMPACT_COMMAND_ROW), "dsh.bundle.patch.yml must disable command-compact");
    assert.ok(bundle.includes(AUTO_OFF_ROW), "the existing auto:false row must stay (this row follows the same static semantics)");
    // The row must be a top-level patch entry, never part of the insert list:
    // an insert would mount a SECOND command-compact beside the host's.
    const insertStart = bundle.indexOf("- insert:");
    const insertEnd = bundle.indexOf("\n- id: compaction-basic");
    assert.ok(insertStart !== -1 && insertEnd > insertStart, "insert block and the compaction-basic row must both exist");
    assert.ok(
        !bundle.slice(insertStart, insertEnd).includes("command-compact"),
        "command-compact must not be inserted (that would leave the host's own entry live)",
    );
});

test("#7154 the launcher overlay stands the same command down (both carriers agree)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cc-"));
    try {
        const file = writeDshAcpPatch(home, "billion-context");
        assert.ok(file, "overlay patch must be written");
        const overlay = fs.readFileSync(file!, "utf8").replaceAll("\r\n", "\n");
        assert.ok(overlay.includes(COMPACT_COMMAND_ROW), "the launcher overlay must disable command-compact too");
        assert.ok(overlay.includes(AUTO_OFF_ROW), "the auto:false row must stay in the overlay");
        assert.ok(
            overlay.indexOf(COMPACT_COMMAND_ROW) > overlay.indexOf(AUTO_OFF_ROW),
            "the two rows stay adjacent and ordered (auto:false first) so a reader sees them as one decision",
        );
        // The overlay must not disable the entry by inserting a second one.
        assert.ok(!/- insert:\n(?: {4}- .*\n)* {4}- id: command-compact/.test(overlay), "command-compact must not be inserted");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(`${home}-bili`, { recursive: true, force: true });
    }
});
