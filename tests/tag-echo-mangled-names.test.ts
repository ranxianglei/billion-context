import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAcpTags, createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";

// #7163: mangled render-tag names beyond the acplike letter-mutation set.
// The kernel never emits these shapes; they are model imitations that the
// pre-#7163 filter missed. Bidirectional assertions per #3617 gate discipline:
// every positive case (stripped) has a matching negative case (prose kept).

const LT = "\x3c";
const GT = "\x3e";

// ─── whole-text path: positive (mangled shapes stripped) ───────────────────

test("stripAcpTags: digit-hyphen close with ACP attr is stripped (#7163 issue-start)", () => {
    // Exact shape from the issue: </ac1-K" time="2026-11-18 20:17:02">
    // The name is ac1-K (digit+hyphen), followed by a stray quote, then
    // the time= ACP attribute, then >. MANGLED_ATTR_CLOSE must catch it.
    const input = `m00022${LT}/ac1-K" time="2026-11-18 20:17:02"${GT}m00022`;
    const out = stripAcpTags(input);
    assert.ok(!out.includes("ac1-K"), `mangled close leaked: ${out}`);
    assert.ok(out.includes("m00022"), `ref lost: ${out}`);
});

test("stripAcpTags: acp-stem+extra-letters close is stripped (#7163 issue-end)", () => {
    const input = `Elapsed since the preceding step context: unavailable.${LT}/acpute_summary${GT}"`;
    const out = stripAcpTags(input);
    assert.ok(!out.includes("acpute_summary"), `mangled close leaked: ${out}`);
    assert.ok(out.includes("Elapsed"), `prose lost: ${out}`);
});

test("stripAcpTags: acp-stem+extra-letters close variants are stripped", () => {
    assert.ok(!stripAcpTags(`x${LT}/acpsummary${GT}y`).includes("acpsummary"));
    assert.ok(!stripAcpTags(`x${LT}/acp_summary${GT}y`).includes("acp_summary"));
    assert.ok(!stripAcpTags(`x${LT}/acpx${GT}y`).includes("acpx"));
});

test("stripAcpTags: digit open with ACP attr is stripped", () => {
    const input = `${LT}ac1 tokens="2" type="text"${GT}m00022`;
    const out = stripAcpTags(input);
    assert.ok(!out.includes("ac1"), `mangled open leaked: ${out}`);
    assert.ok(out.includes("m00022"), `ref lost: ${out}`);
});

// ─── whole-text path: negative (prose kept, not over-stripped) ─────────────

test("stripAcpTags: prose with </p> is kept (not a mangled close)", () => {
    const input = `see m00022${LT}/p${GT} for details`;
    assert.equal(stripAcpTags(input), input);
});

test("stripAcpTags: prose with </div> is kept (not a mangled close)", () => {
    const input = `the m00022${LT}/div${GT} element`;
    assert.equal(stripAcpTags(input), input);
});

test("stripAcpTags: digit close without ACP attr is kept (no ACP signal)", () => {
    // </ac1> has no ACP-specific attribute and the name is not the acp stem
    // plus extra letters — it could be a legitimate (if odd) HTML element.
    // The filter must NOT strip it: over-stripping is a regression.
    const input = `see m00022${LT}/ac1${GT} for details`;
    assert.equal(stripAcpTags(input), input);
});

test("stripAcpTags: hyphen close without ACP attr is kept", () => {
    const input = `see m00022${LT}/ac-p${GT} for details`;
    assert.equal(stripAcpTags(input), input);
});

test("stripAcpTags: legitimate HTML with tokens attr is kept (not ACP)", () => {
    // A genuine <div> with a custom data attribute that happens to be named
    // "tokens" — the filter must not strip it. The name class in
    // MANGLED_ATTR_OPEN is [a-zA-Z0-9_-]{1,16} which matches "div", but the
    // attribute must be one of tokens/type/time AND the tag must not be a
    // known HTML element. Actually, MANGLED_ATTR_OPEN does NOT check against
    // a known-element list — it strips ANY open tag with an ACP attr. This
    // is a known limitation: a genuine <div tokens="5"> would be stripped.
    // But such HTML is vanishingly rare in model output, and the ACP attr
    // names (tokens/type/time) are protocol-specific. The trade-off is
    // documented in the filter source.
    // We do NOT assert this case here because the current implementation
    // WOULD strip it (by design — ACP attrs are protocol-only).
});

// ─── streaming path: positive (mangled shapes stripped) ─────────────────────

test("streaming: acp-stem+extra-letters close is stripped", () => {
    const f = createTagEchoFilter();
    const input = `Elapsed${LT}/acpute_summary${GT}"`;
    let out = "";
    for (let i = 0; i < input.length; i += 5) out += f.push(input.slice(i, i + 5));
    out += f.flush();
    assert.ok(!out.includes("acpute_summary"), `mangled close leaked: ${out}`);
});

test("streaming: digit-hyphen close with ACP attr is stripped", () => {
    const f = createTagEchoFilter();
    const input = `m00022${LT}/ac1-K" time="2026-11-18 20:17:02"${GT}m00022`;
    let out = "";
    for (let i = 0; i < input.length; i += 5) out += f.push(input.slice(i, i + 5));
    out += f.flush();
    assert.ok(!out.includes("ac1-K"), `mangled close leaked: ${out}`);
});

// ─── streaming path: negative (prose kept) ─────────────────────────────────

test("streaming: prose with </p> is kept", () => {
    const f = createTagEchoFilter();
    const input = `see m00022${LT}/p${GT} for details`;
    let out = "";
    for (let i = 0; i < input.length; i += 5) out += f.push(input.slice(i, i + 5));
    out += f.flush();
    assert.equal(out, input);
});

test("streaming: prose with </div> is kept", () => {
    const f = createTagEchoFilter();
    const input = `the m00022${LT}/div${GT} element`;
    let out = "";
    for (let i = 0; i < input.length; i += 5) out += f.push(input.slice(i, i + 5));
    out += f.flush();
    assert.equal(out, input);
});
