import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAcpTags, containsEchoResidue } from "../src/loop/tag-echo-filter.ts";

// #5195: the model echoes a render tag but drops the <name head, leaving an
// opener-less residue `[attrs] > <ref-run>` (optionally + a close) that reaches
// client-visible assistant text. stripAcpTags (whole-text / prepare-layer path)
// recognizes the high-confidence signature — an anchor attr (type="text" /
// tokens=N) plus a kernel ref glued to the tag terminator — and removes it.
//
// Scope note: this pins the WHOLE-TEXT path. The live streaming filter
// (createTagEchoFilter) deliberately does NOT strip this shape yet: the residue
// has no < head to latch onto, so a chunk boundary splitting inside the attr is
// indistinguishable from prose, and a streaming fix would either miss those
// splits (chunk-split nondeterminism) or hold ordinary words like "type"/
// "token"/"to" (prose latency) — an owner decision, tracked on the issue.

const GTE = "\x3e"; // >
const LT = "\x3c";  // <

const RESIDUE = /(?:type="text"|tokens="\d+")\s*\x3e\s*m\d{4,}/;

test("#5195: stripAcpTags removes opener-less render-tag residue", () => {
    // reported shape: suffix through the ref, no opening <name
    assert.equal(stripAcpTags(` type="text"${GTE}m00106`), " ");
    // with the trailing close (LONE_CLOSE peels it, then the residue goes)
    assert.equal(stripAcpTags(` type="text"${GTE}m00106${LT}/acp${GTE}`), " ");
    // mid-text: surrounding prose survives, whitespace around the unit is content
    assert.equal(stripAcpTags(`Done. type="text"${GTE}m00106 tail`), "Done.  tail");
    // tokens-only anchor
    assert.equal(stripAcpTags(` tokens="5"${GTE}m00106`), " ");
    // multi-attr run before the anchor
    assert.equal(stripAcpTags(` tokens="5" type="text"${GTE}m00106${LT}/acp${GTE}`), " ");
});

test("#5195: multi-ref runs leave no residue signature (joiner may survive)", () => {
    // A dash-joined run fully stripped when it has no trailing close…
    assert.equal(stripAcpTags(` type="text"${GTE}m00106\u2013m00110`), " ");
    // …with a trailing close the pre-existing orphan-close decomposition can
    // take the last ref first, leaving only a bare joiner — but the residue
    // SIGNATURE (anchor attr + ref against the terminator) must be gone either way.
    for (const x of [
        ` type="text"${GTE}m00106\u2013m00110${LT}/acp${GTE}`,
        ` type="text"${GTE}m00106,m00110${LT}/acp${GTE}`,
        ` type="text"${GTE}m00106-m00110${LT}/acp${GTE}`,
    ]) {
        const out = stripAcpTags(x);
        assert.equal(RESIDUE.test(out), false, `residue survived for ${JSON.stringify(x)} -> ${JSON.stringify(out)}`);
    }
});

test("#5195: idempotent — re-normalizing already-cleaned bytes is stable", () => {
    const inputs = [
        ` type="text"${GTE}m00106`,
        ` type="text"${GTE}m00106${LT}/acp${GTE}`,
        `Done. type="text"${GTE}m00106 tail`,
        ` tokens="5" type="text"${GTE}m00106${LT}/acp${GTE}`,
    ];
    for (const x of inputs) {
        const once = stripAcpTags(x);
        assert.equal(stripAcpTags(once), once, `not idempotent for ${JSON.stringify(x)}`);
    }
});

test("#5195: controls are NOT over-stripped (signature is narrow)", () => {
    // wrong attr value: not the render-tag anchor
    assert.equal(stripAcpTags(` type="video"${GTE}m00106`), ` type="video"${GTE}m00106`);
    // anchor attr present but no kernel ref after the terminator
    assert.equal(stripAcpTags(` type="text"${GTE}hello world`), ` type="text"${GTE}hello world`);
    // real HTML element carrying the same attr name
    assert.equal(stripAcpTags(`use the ${LT}ai-video${GTE} element here`), `use the ${LT}ai-video${GTE} element here`);
    // bare ref cited among words is prose, not residue
    assert.equal(stripAcpTags(`see m00123 and m00124 done`), `see m00123 and m00124 done`);
    // a full well-formed render tag still strips whole (existing behavior intact)
    assert.equal(stripAcpTags(`${LT}acp tokens="5" type="text"${GTE}m00106${LT}/acp${GTE}`), "");
});

test("#5195: audit predicate detects the opener-less residue at release points", () => {
    assert.equal(containsEchoResidue(` type="text"${GTE}m00106`), true);
    assert.equal(containsEchoResidue(` tokens="5"${GTE}m00106`), true);
    // pre-existing dead-ref-close shape still detected
    assert.equal(containsEchoResidue(`m00106${LT}/acp`), true);
    // clean prose is not flagged
    assert.equal(containsEchoResidue(`all good here`), false);
});
