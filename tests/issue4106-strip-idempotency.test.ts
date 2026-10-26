/**
 * #4106 — tag cleanup must be idempotent.
 *
 * The old DEAD_REF_CLOSE gate (`out !== text`, evaluated mid-pipeline) only
 * saw deletions made EARLIER in the same call, so a marker line stripped at
 * the end of call 1 never attested; call 2 then shrank the text via the
 * end-anchored TRUNC passes. The verdict depended on prior cleanup state, not
 * on content — retry/rebuild paths re-normalizing already-cleaned messages
 * shipped different bytes each pass (#3837 family).
 *
 * Fixed by (a) input-side gate attestation — later channels' shapes (truncated
 * open at EOF, forged marker line, bili chain carrier / header block) count as
 * evidence computed once on the original text, while close-side channels still
 * never self-attest (#1760/#644) — and (b) a bounded fixed-point walk, so one
 * call does everything repeat calls would.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEchoArtifacts, stripAcpTags } from "../src/loop/tag-echo-filter.ts";

const ISSUE_TEXT = "angle < not a tag\nm7385</CpA\nm3117</cPa\n\u{1F4E6} [ACP] Compressed m00120\u2013m0300 \u2192 1 block(s)";

test("#4106: the issue repro is stable after ONE call", () => {
    const s1 = stripAcpTags(ISSUE_TEXT);
    const s2 = stripAcpTags(s1);
    assert.equal(s2, s1, "second call removed content — idempotency broken");
    assert.equal(stripAcpTags(s2), s2, "third call removed content — no fixed point");
});

test("#4106: the forged marker line attests — trailing dead-ref closes die in the SAME call", () => {
    const s1 = stripAcpTags(ISSUE_TEXT);
    assert.ok(!s1.includes("</CpA") && !s1.includes("</cPa"), `dead-ref closes survived an attested cleanup: ${JSON.stringify(s1)}`);
    assert.ok(s1.includes("angle < not a tag"), "prose lost");
});

test("#4106: close-only shapes without other echo evidence stay content-preserved (#1760/#644)", () => {
    // unattested EOF: the close goes (it is a truncated imitation), the bare
    // ref stays — exactly the pre-fix bytes, unchanged by the fix.
    assert.equal(stripAcpTags("ref m00001 </acp"), "ref m00001 ");
    // unattested mid-text: byte-identical passthrough.
    const mid = "x m00992</ap more";
    assert.equal(stripAcpTags(mid), mid);
    const clean = "a < b and </abcd> and see m01234 for details";
    assert.equal(stripAcpTags(clean), clean);
});

test("#4106: attested EOF dead-ref unit still dies whole, not as a bare ref (#2862)", () => {
    const t = "\x3cacp tokens=\"1\" type=\"text\"\x3em05712\x3c/acp\x3e tail m01233\x3c/acp";
    const s1 = stripAcpTags(t);
    assert.equal(s1, " tail ");
    assert.equal(stripAcpTags(s1), s1);
});

test("#4106: cascades exposed by a later channel converge within one call", () => {
    // T2 strips the trailing close, exposing a truncated open at the new EOF.
    const a = "a <acp tok</acp";
    // T2 strips the trailing close, exposing the forged marker line.
    const b = "x\n\u{1F4E6} [ACP] hi</acp";
    for (const t of [a, b]) {
        const s1 = stripAcpTags(t);
        assert.equal(stripAcpTags(s1), s1, `not a fixed point: ${JSON.stringify(t)} -> ${JSON.stringify(s1)}`);
        assert.equal(normalizeEchoArtifacts(stripAcpTags(t)), s1, "normalize diverges from strip on cleaned text");
    }
});

// Deterministic fragment soup over the exact shape families of the incident:
// dead-ref-close heads, forged marker lines, tag fragments, refs, prose.
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test("#4106: fixed-point property holds over generated fragment soup (seeded)", () => {
    const rnd = mulberry32(0x4106c0de);
    const ri = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    const FRAGS = [
        "m7385</CpA",
        "m3117</cPa",
        "\u{1F4E6} [ACP] Compressed m00120\u2013m0300 \u2192 1 block(s)",
        "\x3cacp tokens=\"1\" type=\"text\"\x3em00042\x3c/acp\x3e",
        "</acp",
        "<acp tok",
        "</apc",
        "see < b and </abcd> and",
        "prose 日本語 ✓",
        "m01000",
        "<cap/>",
        "done folding m01233</acp",
        "",
    ] as const;
    const JOINS = [" ", "\n", "", "  ", "\n\n"] as const;
    for (let i = 0; i < 300; i++) {
        const n = ri(1, 6);
        let t = "";
        for (let j = 0; j < n; j++) t += FRAGS[ri(0, FRAGS.length - 1)]! + JOINS[ri(0, JOINS.length - 1)]!;
        const s1 = stripAcpTags(t);
        const s2 = stripAcpTags(s1);
        assert.equal(s2, s1, `strip not idempotent: ${JSON.stringify(t)} -> ${JSON.stringify(s1)} -> ${JSON.stringify(s2)}`);
        const n1 = normalizeEchoArtifacts(t);
        assert.equal(normalizeEchoArtifacts(n1), n1, `normalize not idempotent: ${JSON.stringify(t)} -> ${JSON.stringify(n1)}`);
        assert.ok(s1.length <= t.length, "strip lengthened the text");
    }
});

test("#4106: beyond STRIP_PASS_CAP the walk keeps residue (CPU bound) — pinned corner", () => {
    // Nine stacked $-anchored truncated closes peel exactly ONE per pass and
    // never attest (close-only shapes deliberately do not self-attest,
    // #1760/#644), so the ninth layer sits past the cap: the walk terminates
    // at STRIP_PASS_CAP=8 keeping its residue instead of burning CPU on
    // attacker-shaped input, and a further call peels the last layer. Pinning
    // both facts keeps the docstring's bounded guarantee honest in either
    // direction (cap change or peel-rate change fails this test loudly).
    const t = "A" + "</acpa\n".repeat(9);
    const s1 = stripAcpTags(t);
    assert.equal(s1, "A</acpa\n", "cap behavior drifted");
    assert.notEqual(stripAcpTags(s1), s1, "documented corner: one more call peels the final layer");
});
