import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAcpTags, createTagEchoFilter } from "../src/loop/tag-echo-filter.ts";

const LT = "\x3c";
const OPEN = `${LT}acp tokens="2" type="text">`;
const BARE_OPEN = `${LT}acp>`;
const CLOSE = `${LT}/acp>`;

function streamAll(input: string): string {
    const f = createTagEchoFilter();
    let out = "";
    for (const ch of input) out += f.push(ch);
    out += f.flush();
    return out;
}

function streamChunks(chunks: string[]): string {
    const f = createTagEchoFilter();
    let out = "";
    for (const c of chunks) out += f.push(c);
    out += f.flush();
    return out;
}

test("whole-text: orphan refs run + unmatched close is stripped as a unit (#2023)", () => {
    assert.equal(stripAcpTags(`done folding m01233${CLOSE} next`), `done folding  next`);
    assert.equal(stripAcpTags(`m01233${CLOSE}`), "");
});

test("whole-text: orphan unit survives case drift, typo close, junk close", () => {
    assert.equal(stripAcpTags(`m01233${LT}/ACP>`), "");
    assert.equal(stripAcpTags(`m01233${LT}/cap>`), "");
    assert.equal(stripAcpTags(`m01233${LT}/acp junk>`), "");
});

test("whole-text: multi-ref and range bodies are tag content (refs-only PAIRED)", () => {
    assert.equal(stripAcpTags(`${OPEN}m01233 m01234${CLOSE}`), "");
    assert.equal(stripAcpTags(`${BARE_OPEN}m01217\u2013m01233${CLOSE}`), "");
    assert.equal(stripAcpTags(`${BARE_OPEN}m01217\u2014m01233${CLOSE}`), "");
    assert.equal(stripAcpTags(`${BARE_OPEN}m01217-m01233${CLOSE}`), "");
    assert.equal(stripAcpTags(`${OPEN}m01095\u2013m01215, m01217\u2013m01233${CLOSE}`), "");
});

test("whole-text: #1720 prose-wearing pairs keep their content, cited refs included", () => {
    assert.equal(stripAcpTags(`${OPEN}x m01233${CLOSE}`), "x m01233");
    assert.equal(stripAcpTags(`${BARE_OPEN}x m01233${CLOSE}`), "x m01233");
    assert.equal(stripAcpTags(`see m01233 for details`), `see m01233 for details`);
    assert.equal(stripAcpTags(`xm01233${CLOSE}`), "xm01233");
    assert.equal(stripAcpTags(`m01233${LT}/kem>`), `m01233${LT}/kem>`);
});

test("whole-text: run before an empty pair is a documented residual (leaks as before)", () => {
    assert.equal(stripAcpTags(`m01233${BARE_OPEN}${CLOSE}`), "m01233");
});

test("whole-text: a ref right after a tag terminator stays lossless (#644 over-cap residue)", () => {
    assert.equal(stripAcpTags(`>m01233${CLOSE}`), ">m01233");
    assert.equal(stripAcpTags(`a>m01233${CLOSE}`), "a>m01233");
});

test("whole-text: multiple unmatched closes — only the ref-adjacent one forms a unit", () => {
    assert.equal(stripAcpTags(`m01233${CLOSE} extra${CLOSE}`), " extra");
});

test("streaming char-by-char matches whole-text on every #2023 shape", () => {
    const cases = [
        `done folding m01233${CLOSE} next`,
        `m01233${CLOSE}`,
        `m01233${LT}/ACP>`,
        `m01233${LT}/cap>`,
        `${OPEN}m01233 m01234${CLOSE}`,
        `${BARE_OPEN}m01217\u2013m01233${CLOSE}`,
        `${OPEN}x m01233${CLOSE}`,
        `${BARE_OPEN}x m01233${CLOSE}`,
        `see m01233 for details`,
        `xm01233${CLOSE}`,
        `m01233${BARE_OPEN}${CLOSE}`,
        `m01233${CLOSE} extra${CLOSE}`,
        `>m01233${CLOSE}`,
        `a>m01233${CLOSE}`,
    ];
    for (const input of cases) {
        assert.equal(streamAll(input), stripAcpTags(input), `streaming diverged for: ${JSON.stringify(input)}`);
    }
});

test("streaming: chunk boundary splits do not leak the orphan unit", () => {
    assert.equal(streamChunks(["folded m01233", `${CLOSE} tail`]), "folded  tail");
    assert.equal(streamChunks(["m012", `33${CLOSE}`]), "");
    assert.equal(streamChunks(["m0123", `3${CLOSE}`]), "");
});

test("streaming: EOF after an opening — refs-only tails drop, mixed tails release", () => {
    assert.equal(streamChunks([BARE_OPEN, "m01233"]), "");
    assert.equal(streamChunks([`${LT}acp tokens="2" type="text">`, "m01233"]), "");
    assert.equal(streamChunks([`${LT}acp tokens="2" type="text">`, "m01233 m01234"]), "");
    assert.equal(streamChunks([BARE_OPEN, "see m01233"]), "see m01233");
    assert.equal(streamChunks(["note m01233"]), "note m01233");
});

test("streaming: swallow inner decision — refs-only body drops, prose body releases", () => {
    assert.equal(streamChunks([`${LT}acp tokens="2" type="text">`, `m01233 m01234${CLOSE}`]), "");
    assert.equal(streamChunks([`${LT}acp tokens="2" type="text">`, `x m01233${CLOSE}`]), "x m01233");
});

test("streaming: over-budget refs-only tail discards, over-budget mixed tail releases", () => {
    const refsTail = Array.from({ length: 25 }, (_, i) => `m${String(10001 + i).padStart(5, "0")} `).join("");
    assert.ok(refsTail.length > 80);
    assert.equal(streamChunks([BARE_OPEN, refsTail]), "");
    const mixedTail = `see ${refsTail}`;
    assert.equal(streamChunks([BARE_OPEN, mixedTail]), mixedTail);
});
