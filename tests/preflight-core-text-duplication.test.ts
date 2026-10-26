import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CoreMessage } from "acp-kernel";
import { describeCoreTextDuplication, measureCoreTextDuplication } from "../src/preflight.js";

const BLOB = "x".repeat(100);

function core(n: number, text?: string): CoreMessage {
    const base: CoreMessage = { id: `m${n}`, role: "user", contentType: "text" };
    return text === undefined ? base : { ...base, text };
}

test("#4079 repeated core text collapses to one distinct entry", () => {
    const d = measureCoreTextDuplication([core(1, BLOB), core(2, BLOB), core(3, BLOB), core(4, "y".repeat(50))]);
    assert.equal(d.messageCount, 4);
    assert.equal(d.totalBytes, 350);
    assert.equal(d.uniqueBytes, 150);
    assert.equal(d.distinctTexts, 2);
});

test("#4079 empty and missing text is not counted", () => {
    const d = measureCoreTextDuplication([core(1, ""), core(2), core(3, BLOB)]);
    assert.equal(d.messageCount, 1);
    assert.equal(d.totalBytes, 100);
    assert.equal(d.uniqueBytes, 100);
    assert.equal(d.distinctTexts, 1);
});

test("#4079 describe reports the duplicate ratio of a repeated payload", () => {
    const line = describeCoreTextDuplication([core(1, BLOB), core(2, BLOB)]);
    assert.match(line, /2 message\(s\), 200B core over 1 distinct text\(s\), 100B unique, duplicateRatio=0\.500/);
});

test("#4079 describe reports 0.000 for an all-unique payload", () => {
    const line = describeCoreTextDuplication([core(1, BLOB), core(2, "y".repeat(100))]);
    assert.match(line, /duplicateRatio=0\.000/);
});

test("#4079 describe handles an empty core", () => {
    assert.equal(describeCoreTextDuplication([]), "core text is empty");
});

// Review of #4290: under the default render strategy the kernel prepends a
// UNIQUE ref tag to every message — identical content must still collapse.
const acpTag = (ref: string, body: string) => `\x3cacp tokens="25" type="user"\x3e${ref}\x3c/acp\x3e\n${body}`;

test("#4079 identical content under different rendered ACP ref tags still collapses", () => {
    const d = measureCoreTextDuplication([core(1, acpTag("m00001", BLOB)), core(2, acpTag("m00002", BLOB)), core(3, acpTag("m00003", "y".repeat(50)))]);
    assert.equal(d.messageCount, 3);
    assert.equal(d.totalBytes, 250, "the injected ref tags are excluded from the content mass");
    assert.equal(d.uniqueBytes, 150);
    assert.equal(d.distinctTexts, 2);
});

test("#4079 near-miss tag-shaped text is NOT stripped (strict shape gate)", () => {
    const fake = `\x3cacp tokens="25" type="user"\x3efake-ref\x3c/acp\x3e\n`;
    const d = measureCoreTextDuplication([core(1, fake + BLOB), core(2, fake + BLOB)]);
    assert.equal(d.distinctTexts, 1, "identical near-miss texts still group together");
    assert.equal(d.totalBytes, 2 * (fake.length + BLOB.length), "unstripped bytes stay counted");
});

// Review of #4290 (round 2): the prefix has to track the RENDERER, not one
// attr list. invariant-judge's RENDER_TAG_RE accepts a leading newline and any
// attr set — an over-strict prefix fails silently (ratio back to 0.000 with no
// signal), which is the failure mode this whole PR exists to close.
test("#4079 a leading newline before the rendered tag still collapses (renderer emits it on its own line)", () => {
    const withNl = (ref: string) => `\n${acpTag(ref, BLOB)}`;
    const d = measureCoreTextDuplication([core(1, withNl("m00001")), core(2, withNl("m00002"))]);
    assert.equal(d.distinctTexts, 1);
    assert.equal(d.uniqueBytes, 100);
});

test("#4079 an extra renderer attr still collapses (attr set belongs to the renderer)", () => {
    const withAttr = (ref: string) => `\n\x3cacp tokens="25" type="user" origin="render"\x3e${ref}\x3c/acp\x3e\n${BLOB}`;
    const d = measureCoreTextDuplication([core(1, withAttr("m00001")), core(2, withAttr("m00002"))]);
    assert.equal(d.distinctTexts, 1, "different refs under a wider attr set are still one content");
    assert.equal(d.uniqueBytes, 100);
});

test("#4079 an acp-shaped tag that is NOT refs-only is left alone", () => {
    // Prose wearing tags (#1720): the close is there, the body is not a ref.
    const prose = (n: number) => `<acp tokens="9" type="user">some prose ${n}</acp>\n${BLOB}`;
    const d = measureCoreTextDuplication([core(1, prose(1)), core(2, prose(2))]);
    assert.equal(d.distinctTexts, 2);
});
