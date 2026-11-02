// #5154: a node.exe carrying an inherited NTFS Low mandatory-integrity label
// makes every write to Medium-labeled files fail EPERM while all ACLs look
// correct — the field repro of the whole #5096 crash-loop class. The fix has
// three parts and this file pins each:
//   1. the icacls stdout parser finds the label line (incl. all-caps output)
//      and stays silent when there is no label ("(no label)" files);
//   2. the startup-failure hint puts the integrity-label check FIRST, ahead
//      of the antivirus-exclusion advice (#5154: the label was the real
//      switch in the field repro; the AV detour cost the most hours);
//   3. the startup self-check is observability, not a gate: on non-Windows it
//      does nothing at all, and nothing here ever throws or blocks startup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcaclsMandatoryLabel, startupFailureHints, warnIfLowIntegrityRuntime } from "../src/integrity-label.ts";
import { setLogCapture } from "../src/logger.ts";

const ICACLS_LOW = [
    "C:\\Program Files\\nodejs\\node.exe",
    "BUILTIN\\Administrators:(F)",
    "NT AUTHORITY\\SYSTEM:(F)",
    "BUILTIN\\Users:(RX)",
    "Mandatory Label\\Low Mandatory Level:(NW)",
    "",
    "Successfully processed 1 files; Failed processing 0 files",
].join("\r\n");

const ICACLS_ALL_CAPS = [
    "C:\\NODE\\NODE.EXE",
    "BUILTIN\\ADMINISTRATORS:(I)(F)",
    "MANDATORY LABEL\\LOW MANDATORY LEVEL:(I)(NW)",
].join("\r\n");

const ICACLS_MEDIUM = "C:\\Program Files\\nodejs\\node.exe\r\nBUILTIN\\Administrators:(F)\r\nMandatory Label\\Medium Mandatory Level:(NW)\r\n";

const ICACLS_NO_LABEL = "C:\\Program Files\\nodejs\\node.exe\r\nBUILTIN\\Administrators:(F)\r\nBUILTIN\\Users:(RX)\r\n";

test("#5154 parser: reads Low label from icacls stdout", () => {
    assert.equal(parseIcaclsMandatoryLabel(ICACLS_LOW), "low");
});

test("#5154 parser: case-insensitive (all-caps output of older Windows)", () => {
    assert.equal(parseIcaclsMandatoryLabel(ICACLS_ALL_CAPS), "low");
});

test("#5154 parser: Medium label is reported, not warned on", () => {
    assert.equal(parseIcaclsMandatoryLabel(ICACLS_MEDIUM), "medium");
});

test("#5154 parser: no Mandatory Label line means (no label) — undefined, not a guess", () => {
    assert.equal(parseIcaclsMandatoryLabel(ICACLS_NO_LABEL), undefined);
});

test("#5154 parser: empty stdout (probe failed) stays undefined", () => {
    assert.equal(parseIcaclsMandatoryLabel(""), undefined);
});

test("#5154 hints: EPERM hints name the integrity-label check with its fix command", () => {
    const hints = startupFailureHints(Object.assign(new Error("EACCES: permission denied, open 'ca.pem'"), { code: "EPERM" }));
    assert.ok(hints !== undefined);
    assert.match(hints, /integrity label FIRST/);
    assert.match(hints, /icacls "<path-to-node\.exe>" \/setintegritylevel Medium/);
    assert.match(hints, /#5154/);
});

test("#5154 hints: integrity-label advice comes BEFORE the antivirus detour", () => {
    const hints = startupFailureHints(Object.assign(new Error("refused"), { code: "EPERM" })) ?? "";
    const integrity = hints.indexOf("integrity label");
    const antivirus = hints.indexOf("antivirus");
    assert.ok(integrity >= 0, "integrity advice present");
    assert.ok(antivirus >= 0, "antivirus advice present");
    assert.ok(integrity < antivirus, "#5154: the label check is the FIRST suspect, AV second");
});

test("#5154 hints: EACCES gets the same class of advice", () => {
    assert.ok(startupFailureHints(Object.assign(new Error("x"), { code: "EACCES" })) !== undefined);
});

test("#5154 hints: unrelated errno codes stay silent", () => {
    assert.equal(startupFailureHints(Object.assign(new Error("no such file"), { code: "ENOENT" })), undefined);
    assert.equal(startupFailureHints(new Error("plain")), undefined);
    assert.equal(startupFailureHints("not an error"), undefined);
});

test("#5154 self-check: non-Windows is a no-op — no spawn, no log, no throw", async () => {
    const captured: Array<{ level: string; msg: string }> = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    try {
        warnIfLowIntegrityRuntime(); // returns synchronously on non-win32
        await new Promise((r) => setTimeout(r, 50)); // nothing async may appear either
        if (process.platform !== "win32") {
            assert.equal(captured.length, 0, "self-check must stay silent off win32");
        }
    } finally {
        setLogCapture(null);
    }
});
