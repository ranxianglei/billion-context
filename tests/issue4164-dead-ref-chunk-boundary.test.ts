// #4164: a dead ref-close unit (m\d{4,} + unterminated close head) settled
// ahead of an ambiguous tail was released as body BEFORE the tail's fate was
// known — whole-push strips it attested when the tail completes into an
// acplike tag, but a chunk boundary landing inside the tail released the unit
// first, so the same logical output persisted differently by chunking (#3198
// contract violation → byte drift on retry → prefix-cache seam).
//
// The fix holds such units in pendingSettle until the tail resolves:
// completing acplike tag / broken open → attested → dropped; prose or EOF →
// re-emitted verbatim (#1760 content preservation). Gate discipline #3617:
// both directions asserted — dies when it should, stays when it must not.
import test from "node:test";
import assert from "node:assert/strict";
import { createTagEchoFilter, stripAcpTags } from "../src/loop/tag-echo-filter.ts";

function runWhole(text: string): string {
    const f = createTagEchoFilter();
    return f.push(text) + f.flush();
}

/** Every single split point (plus the whole push) must byte-match the whole-push run. */
function assertAllSplitsMatch(text: string, label: string): string {
    const reference = runWhole(text);
    for (let k = 0; k <= text.length; k++) {
        const f = createTagEchoFilter();
        let out = "";
        if (k > 0) out += f.push(text.slice(0, k));
        if (k < text.length) out += f.push(text.slice(k));
        out += f.flush();
        assert.equal(out, reference, `${label}: split at ${k} diverges from whole-push`);
    }
    return reference;
}

test("#4164 positive: dead unit + completing acplike open dies in every chunking", () => {
    // Whole-push: LONE_OPEN wins → the settle is stripped attested → only the
    // gap space survives. Pre-fix, splits 11..14 leaked ` m1234</ap`.
    const out = assertAllSplitsMatch(" m1234\x3c/ap\x3cacp\x3e", "issue repro");
    assert.equal(out, " ", "the dead unit must not survive as body");
});

test("#4164 positive: drift-name and case-drift opens attest too", () => {
    assert.equal(assertAllSplitsMatch(" m1234\x3c/ap\x3caccessp\x3e", "drift name"), " ");
    assert.equal(assertAllSplitsMatch(" m1234\x3c/ap\x3cACP\x3e", "case drift"), " ");
});

test("#4164 positive: multiple units all die when the tail completes", () => {
    // Two captures accumulate before the verdict — the pair bookkeeping must
    // keep both units odd-positioned regardless of how many settles occurred.
    assert.equal(assertAllSplitsMatch("m1111\x3c/ap x m2222\x3c/ap\x3cacp\x3e", "multi unit"), " x ");
});

test("#4164 positive: drop accounting follows the verdict", () => {
    const f = createTagEchoFilter();
    f.push(" m1234\x3c/ap<");
    assert.equal(f.dropped(), false, "no drop may be recorded before the tail resolves");
    f.push("acp>");
    f.flush();
    assert.equal(f.dropped(), true, "the attested unit counts as a dropped artifact");
});

test("#4164 negative: dead unit + non-acplike tag stays content in every chunking", () => {
    const text = " m1234\x3c/ap\x3cdiv\x3emore";
    assert.equal(assertAllSplitsMatch(text, "prose follow"), text);
});

test("#4164 negative: dead unit + EOF dangling lt stays content", () => {
    const text = " m1234\x3c/ap\x3c";
    assert.equal(assertAllSplitsMatch(text, "eof dangling"), text);
});

test("#4164 negative: word-glued run is not a unit in any chunking", () => {
    const out = assertAllSplitsMatch("xm1234\x3c/ap\x3cacp\x3e", "word-glued");
    assert.ok(out.includes("m1234\x3c/ap"), "the glued run survives as content");
});

test("#4164 negative: head-boundary glue across a push boundary", () => {
    // "q" emitted first makes the unit look word-glued at the next buffer head.
    const f = createTagEchoFilter();
    const out = f.push("q") + f.push("m1234\x3c/ap\x3cacp\x3e") + f.flush();
    assert.equal(out, runWhole("qm1234\x3c/ap\x3cacp\x3e"));
    assert.ok(out.includes("m1234\x3c/ap"), "the glued run survives as content");
});

test("#4164: streaming whole-push agrees with whole-text stripAcpTags", () => {
    for (const text of [
        " m1234\x3c/ap\x3cacp\x3e",
        " m1234\x3c/ap\x3caccessp\x3e",
        "m1111\x3c/ap x m2222\x3c/ap\x3cacp\x3e",
        " m1234\x3c/ap\x3cdiv\x3emore",
        " m1234\x3c/ap\x3c",
        " m1234\x3c/ap\x3c/div\x3e",
    ]) {
        assert.equal(runWhole(text), stripAcpTags(text), `parity for ${JSON.stringify(text)}`);
    }
});
