import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { noteKnownAttachmentIds, resetPhantomLedgersForTest, scanModelOutputForPhantomAttachments } from "../src/phantom-attachment.ts";
import { setLogCapture } from "../src/logger.ts";

const CAP = 8192;
let warnings: string[];

function ids(start: number, count: number): string {
    return Array.from({ length: count }, (_, i) => `file-api-${String(start + i).padStart(8, "0")}`).join(" ");
}

beforeEach(() => {
    resetPhantomLedgersForTest();
    warnings = [];
    setLogCapture((_level, message) => {
        if (message.includes("[phantom-attachment]")) warnings.push(message);
    });
});

afterEach(() => {
    setLogCapture(null);
    resetPhantomLedgersForTest();
});

test("a request-filled ledger stops admitting model-output ids (#7885)", () => {
    noteKnownAttachmentIds("full", ids(0, CAP));
    scanModelOutputForPhantomAttachments("full", ids(CAP, 2));
    assert.deepEqual(warnings, []);
});

test("one oversized output admits at most the session budget (#7885)", () => {
    scanModelOutputForPhantomAttachments("large", ids(0, CAP + 2));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /references 8192 attachment id\(s\)/);
    scanModelOutputForPhantomAttachments("large", ids(CAP, 3));
    assert.equal(warnings.length, 1);
});

test("an output uses only the remaining slots and preserves deduplication (#7885)", () => {
    noteKnownAttachmentIds("partial", ids(0, CAP - 2));
    scanModelOutputForPhantomAttachments("partial", ids(CAP - 3, 5));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /references 2 attachment id\(s\)/);
    assert.match(warnings[0], /file-api-00008190, file-api-00008191/);
    scanModelOutputForPhantomAttachments("partial", ids(CAP - 3, 6));
    assert.equal(warnings.length, 1);
});

test("successive model turns share one bounded ledger (#7885)", () => {
    for (let turn = 0; turn < 10; turn++) {
        scanModelOutputForPhantomAttachments("turns", ids(turn * 1024, 1024));
    }
    assert.equal(warnings.length, 8);
    for (const warning of warnings) assert.match(warning, /references 1024 attachment id\(s\)/);
});

test("request and response admission consume the same budget (#7885)", () => {
    scanModelOutputForPhantomAttachments("mixed", ids(0, CAP / 2));
    noteKnownAttachmentIds("mixed", ids(CAP / 2, CAP / 2));
    scanModelOutputForPhantomAttachments("mixed", ids(0, CAP + 1));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /references 4096 attachment id\(s\)/);
});

test("saturating one session does not suppress another session (#7885)", () => {
    noteKnownAttachmentIds("full", ids(0, CAP));
    scanModelOutputForPhantomAttachments("fresh", ids(CAP, 1));
    scanModelOutputForPhantomAttachments("fresh", ids(CAP, 1));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[fresh\]/);
});

test("an evicted saturated session starts with a fresh budget (#7885)", () => {
    noteKnownAttachmentIds("old", ids(0, CAP));
    for (let i = 0; i < 2048; i++) noteKnownAttachmentIds(`session-${i}`, ids(i, 1));
    scanModelOutputForPhantomAttachments("old", ids(0, 1));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[old\]/);
});
