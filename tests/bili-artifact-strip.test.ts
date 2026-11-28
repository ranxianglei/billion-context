import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChainCheckpoint } from "../src/chain-checkpoint.ts";
import { CODEX_FORGED_HANDOFF_HEADER, FORGED_SUMMARY_HEADER, renderForgedSummary, replaceBiliCompactionItems } from "../src/codex-compact.ts";
import {
    stripAcpTags,
    stripBiliArtifacts,
    containsBiliInternalText,
    mayStartBiliInternal,
    createBiliArtifactFilter,
    type TagEchoFilter,
} from "../src/loop/tag-echo-filter.ts";

const L = "\x3c";
const R = "\x3e";
const T0 = 1_758_864_000_000;
const GOOD_DIGEST = "sha256:" + "ab".repeat(32);
const FIELDS = { v: 1 as const, processor: "bili-a", issuedAt: T0, requestId: "req-1" };
const tag = (over: Record<string, unknown> = {}): string =>
    renderChainCheckpoint({ ...FIELDS, digest: GOOD_DIGEST, ...over });
const ESC = "\\u003c";
const escapedTag = (): string => tag().replace(L, ESC);
const REORDERED = `${L}bili-chain digest="${GOOD_DIGEST}" request-id="req-1" issued-at="${T0}" processor="bili-a" v="1"/${R}`;
const NO_DIGEST = `${L}bili-chain v="1" processor="bili-a" issued-at="${T0}" request-id="req-1"/${R}`;
const TRUNCATED = tag().slice(0, 40);
const H1 = CODEX_FORGED_HANDOFF_HEADER;
const H2 = FORGED_SUMMARY_HEADER;

test("whole-text: well-formed chain carrier is stripped wherever it sits", () => {
    assert.equal(stripBiliArtifacts(`before ${tag()} after`), "before  after");
    assert.equal(stripBiliArtifacts(tag()), "");
    assert.equal(stripBiliArtifacts(`${tag()}mid${tag()}`), "mid");
});

test("whole-text: well-formedness matrix (reorder strips, missing digest / truncation keep)", () => {
    assert.equal(stripBiliArtifacts(`x ${REORDERED} y`), "x  y", "attr order is irrelevant to recognition");
    assert.ok(stripBiliArtifacts(NO_DIGEST).includes("bili-chain"), "missing digest → prose preserved");
    assert.ok(stripBiliArtifacts(TRUNCATED).includes("bili-chain"), "truncated opening → prose preserved");
    assert.ok(stripBiliArtifacts(`${L}bili-chain v="99" processor="p" issued-at="${T0}" request-id="r" digest="${GOOD_DIGEST}"${R}`).includes("bili-chain"), "wrong self-close → prose preserved");
});

test("whole-text: \\u003c-escaped chain form is stripped after unescaping", () => {
    assert.equal(stripBiliArtifacts(`pre ${escapedTag()} post`), "pre  post");
    const halfEscaped = tag().replace(L, ESC).replace(R, "\\u003e");
    assert.equal(stripBiliArtifacts(halfEscaped), "", "escaped close handled too");
});

test("whole-text: header leading the field cuts to end of text", () => {
    assert.equal(stripBiliArtifacts(`${H1}\nsummary body\nmore`), "");
    assert.equal(stripBiliArtifacts(`${H2} — topic\nbody`), "");
    assert.equal(
        stripBiliArtifacts(`\n${H1}\nsummary`),
        "\n",
        "newline before a column-0 header still leads the field",
    );
    // Column-0 anchor (same discipline as the #717 marker-line pass): an
    // indented header is prose, not a block lead.
    assert.equal(
        stripBiliArtifacts(`\n  ${H1}\nsummary`),
        `\n  ${H1}\nsummary`,
        "indented header passes through",
    );
});

test("whole-text: header after real prose drops the marker LINE only (#5900)", () => {
    // Old behavior swallowed everything after a line-start marker mid-turn,
    // truncating the answer. Only the marker line itself is provably internal.
    assert.equal(stripBiliArtifacts(`intro\n${H2} — topic\nbody`), "intro\nbody");
    assert.equal(stripBiliArtifacts(`text\n${H2} inline extra\nrest`), "text\nrest", "same-line continuation dies with the line");
    assert.equal(
        stripBiliArtifacts(`the ${H2} covers old turns`),
        `the ${H2} covers old turns`,
        "mid-line mention is prose",
    );
    assert.equal(
        stripBiliArtifacts(`See ${H1} for details.`),
        `See ${H1} for details.`,
        "mid-line mention is prose",
    );
});

test("whole-text: pure prose passes through byte-exact (incl. < tails and [b lines)", () => {
    const prose = `a ${L} b and c\n[bob] said hi\n[Compressed data export done\nend`;
    assert.equal(stripBiliArtifacts(prose), prose);
});

test("shared constants: every injector output is recognized by the stripper", () => {
    assert.equal(stripBiliArtifacts(renderForgedSummary({ summary: "body", topic: "Topic X" })), "");
    assert.equal(stripBiliArtifacts(`${H1}\n${H2} — t\nbody`), "");
    const items = replaceBiliCompactionItems([{ type: "compaction", id: "fc_bili_x", encrypted_content: "bili:acp:summary payload" }] as never[]).items as Array<{ content?: Array<{ text?: string }> }>;
    const handoff = items[0]?.content?.[0]?.text ?? "";
    assert.ok(handoff.startsWith(H1), "handoff message starts with the shared header constant");
    assert.equal(stripBiliArtifacts(handoff), "", "handoff message text is stripped as a header block");
});

test("directionality: request-side stamped carrier survives request-path normalization byte-exact", () => {
    // Output-side stripping targets carriers that come back FROM THE MODEL. The copy
    // the proxy stamps into the outbound request itself never traverses those filters;
    // pin that the request-path normalizer (responses wire, every request) leaves
    // carrier-bearing message items untouched, so the direction premise ("output side
    // only touches model output") survives future wire-shape changes.
    const inline = { type: "message", role: "user" as const, content: [{ type: "input_text" as const, text: `real question ${tag()}` }] };
    const solo = { type: "message", role: "user" as const, content: [{ type: "input_text" as const, text: tag() }] };
    const { items, replaced, dropped } = replaceBiliCompactionItems([inline, solo] as never[]);
    assert.equal(replaced, 0);
    assert.equal(dropped, 0);
    assert.equal(JSON.stringify(items), JSON.stringify([inline, solo]), "stamped request items pass through byte-exact");
});

test("stripAcpTags folds bili artifacts: render tag + marker + chain carrier together", () => {
    const mixed = `${L}acp tokens="1" type="text">m00155${R}/acp ignored\n📦 [ACP] Compressed m00876–m01100 → 1 block(s), ~54K tokens saved.\n${tag()} tail`;
    const out = stripAcpTags(mixed);
    assert.ok(!out.includes("acp tokens"), "render tag gone");
    assert.ok(!out.includes("[ACP]"), "marker line gone");
    assert.ok(!out.includes("bili-chain"), "chain carrier gone");
    assert.ok(out.trimEnd().endsWith("tail"));
});

test("pre-checks: contains/mayStart agree with the stripper on edge inputs", () => {
    assert.ok(containsBiliInternalText(tag()));
    assert.ok(containsBiliInternalText(escapedTag()));
    assert.ok(containsBiliInternalText(H1));
    assert.ok(containsBiliInternalText(H2));
    assert.ok(!containsBiliInternalText("plain prose with <brackets> and [brackets]"));
    assert.ok(mayStartBiliInternal(`ends with open ${L}`));
    assert.ok(mayStartBiliInternal(`ends mid escape ${ESC.slice(0, 4)}`));
    assert.ok(mayStartBiliInternal("\n[Co"));
    assert.ok(!mayStartBiliInternal("plain line ending in bracket ["));
    assert.ok(!mayStartBiliInternal("[Code review notes]"));
});

function streamThrough(input: string, chunkSize: number, f?: TagEchoFilter): { out: string; filter: TagEchoFilter } {
    const filter = f ?? createBiliArtifactFilter();
    let out = "";
    for (let i = 0; i < input.length; i += chunkSize) out += filter.push(input.slice(i, i + chunkSize));
    out += filter.flush();
    return { out, filter };
}

test("streaming: chain carrier stripped at every split point (literal + escaped, char-by-char)", () => {
    for (const payload of [tag(), escapedTag(), `pre ${tag()} post`, `pre ${escapedTag()} post`]) {
        for (const n of [1, 2, 3, 5, 7]) {
            const { out, filter } = streamThrough(payload, n);
            assert.ok(!out.includes("bili-chain") && !out.includes("u003c"), `chunk ${n}: carrier fully stripped, got ${JSON.stringify(out)}`);
            assert.equal(filter.dropped(), true, `chunk ${n}: drop notified`);
        }
        const expected = payload.startsWith("pre ") ? "pre  post" : "";
        assert.equal(streamThrough(payload, 1).out, expected, "char-by-char output exact");
    }
});

test("streaming: header leading the field swallows to end at every split point", () => {
    for (const payload of [`${H1}\nsummary body`, `${H2} — topic\nbody`, `\n${H2}\nbody`]) {
        for (const n of [1, 2, 4, 9]) {
            const { out, filter } = streamThrough(payload, n);
            assert.equal(out.replace(/\n/g, ""), "", `chunk ${n}: forged turn yields no visible text, got ${JSON.stringify(out)}`);
            assert.equal(filter.dropped(), true);
        }
    }
});

test("streaming: header after prose drops the marker line only, byte-exact at every split (#5900)", () => {
    // Production repro: an answer that quotes a summary marker on its own line
    // mid-turn lost everything after the marker. The rest of the turn must
    // survive, identically under EVERY chunking (determinism contract #3198).
    const payload = `PREFIX.\n${H2}\nthe rest of the answer continues here.`;
    const expected = `PREFIX.\nthe rest of the answer continues here.`;
    assert.equal(stripBiliArtifacts(payload), expected, "whole-text ground truth");
    for (const n of [1, 2, 3, 4, 5, 7, 8, 13]) {
        const { out, filter } = streamThrough(payload, n);
        assert.equal(out, expected, `chunk ${n}: tail must survive, got ${JSON.stringify(out)}`);
        assert.equal(filter.dropped(), true, `chunk ${n}: marker line drop notified`);
    }
    // Every split point, not just fixed sizes: char-by-char sweep.
    for (let k = 0; k <= payload.length; k++) {
        const f = createBiliArtifactFilter();
        const out = f.push(payload.slice(0, k)) + f.push(payload.slice(k)) + f.flush();
        assert.equal(out, expected, `split @${k}: chunk-boundary dependence, got ${JSON.stringify(out)}`);
    }
});

test("streaming: mid-line markers promoted to buffer start by chunking stay prose (#5900)", () => {
    // A chunk boundary landing right before a mid-line marker used to make it
    // start a fresh buffer → position 0 → swallow-to-end. The same generation
    // now passes through byte-exact under every chunking, matching whole-text.
    const payload = `First part.\nIt detects ${H2} and also ${H1}: here.\nThird part continues.`;
    assert.equal(stripBiliArtifacts(payload), payload, "whole-text ground truth");
    for (let k = 0; k <= payload.length; k++) {
        const f = createBiliArtifactFilter();
        const out = f.push(payload.slice(0, k)) + f.push(payload.slice(k)) + f.flush();
        assert.equal(out, payload, `split @${k}: mid-line marker must not claim a block, got ${JSON.stringify(out)}`);
        assert.equal(f.dropped(), false, `split @${k}: no drop for prose`);
    }
});

test("streaming: carrier before a header block is dropped, not emitted raw", () => {
    // Left-to-right event order: the carrier sits earlier than the header, so
    // it must be stripped (the old cut-first ordering leaked it as prose).
    const carrier = tag();
    const payload = `${carrier}\n${H1}\nbody`;
    assert.equal(stripBiliArtifacts(payload), "\n", "whole-text: carrier gone, whitespace prefix kept");
    const { out, filter } = streamThrough(payload, 1);
    assert.equal(out, "\n", `streaming must match whole-text, got ${JSON.stringify(out)}`);
    assert.ok(!out.includes("bili-chain"), "carrier never reaches the client");
    assert.equal(filter.dropped(), true);
});

test("streaming: marker line running to EOF is dropped at flush (whole-text parity)", () => {
    const f = createBiliArtifactFilter();
    let out = f.push(`text\n${H2}`);
    assert.equal(out, "text\n", "prefix settles, line held");
    assert.equal(f.pending(), true);
    out += f.push(` inline extra`);
    assert.equal(out, "text\n", "line still open, nothing visible");
    out += f.flush();
    assert.equal(out, "text\n", "EOF ends the line: marker line dropped, parity with whole-text");
    assert.equal(f.dropped(), true);
});

test("streaming: pure prose passes byte-exact including tricky boundaries", () => {
    const prose = `a ${L} b\nc ${L}/d\n[bob] hi\n[Compressed data ok\nline`;
    for (const n of [1, 2, 3]) {
        const { out, filter } = streamThrough(prose, n);
        assert.equal(out, prose, `chunk ${n}: byte-exact passthrough`);
        assert.equal(filter.dropped(), false);
    }
});

test("streaming: unterminated opening under budget is held then released as prose on flush", () => {
    const filter = createBiliArtifactFilter();
    let out = filter.push(`hello ${L}bili-chain v=`);
    out += filter.push(`1"`);
    assert.equal(out, "hello ", "open tail withheld while decidable");
    assert.equal(filter.pending(), true);
    out += filter.flush();
    assert.equal(out, `hello ${L}bili-chain v=1"`, "stream ended: truncated opening released as prose");
    assert.equal(filter.dropped(), false, "content preservation — no drop for truncated prose");
    assert.equal(filter.pending(), false);
});

test("streaming: over-cap unterminated opening releases as prose (never drops)", () => {
    // Real carriers are bounded far below CHAIN_TAIL_CAP and always terminate;
    // an over-cap unterminated tail is by definition not a carrier (truncated
    // echoes, code discussion) and must pass through byte-exact (#1039/#644).
    const filter = createBiliArtifactFilter();
    const input = `lead ${L}bili-chain ` + "x".repeat(700);
    const out = filter.push(input) + filter.flush();
    assert.equal(out, input, "over-cap tail released as prose");
    assert.equal(filter.dropped(), false);
});

test("streaming: stats account for input/output/dropped consistently", () => {
    const { filter } = streamThrough(tag(), 1);
    const s = filter.stats();
    assert.equal(s.inputChars, tag().length);
    assert.equal(s.outputChars, 0);
    assert.equal(s.dropped, true);
    const prose = "nothing to see";
    const p = streamThrough(prose, 3);
    assert.equal(p.filter.stats().outputChars, prose.length);
    assert.equal(p.filter.stats().dropped, false);
});

test("degenerate-turn gate parity: a fully forged turn yields zero visible output", () => {
    // The retry gates (plugin.ts anthropic pipe: visibleTextChars > releasedMarkupChars || sawToolUse;
    // responses pipe: visibleTextChars > 0 || heldVisibleChars > 0 || sawFunctionCall) fire when the
    // clean output of a forged-metadata turn is empty. Pin that property.
    for (const payload of [`${H1}\nsummary body`, `${H2} — t\nbody`, tag()]) {
        const { out, filter } = streamThrough(payload, 1);
        assert.equal(out.length, 0, "no visible chars survive a fully forged turn");
        assert.equal(filter.stats().outputChars, 0);
        assert.equal(filter.dropped(), true);
    }
});

test("streaming: dead carrier opening no longer shields line-start headers behind it (#5900)", () => {
    // An unterminated <bili-chain opening is prose, but while the filter held
    // the whole tail behind it, a line-start header further back leaked raw at
    // flush (short tails) or was stripped inconsistently per chunking once the
    // tail crossed the void budget (#3198 determinism). Both must match
    // whole-text now.
    const deadOpen = `${L}bili-chain v="1" processor="b"`;
    const shortPayload = `${deadOpen}\n${H2} topic\nbody survives`;
    const shortExpected = stripBiliArtifacts(shortPayload);
    assert.equal(shortExpected, `${deadOpen}\nbody survives`, "whole-text: opener prose, marker line drops");
    for (let k = 0; k <= shortPayload.length; k++) {
        const f = createBiliArtifactFilter();
        const out = f.push(shortPayload.slice(0, k)) + f.push(shortPayload.slice(k)) + f.flush();
        assert.equal(out, shortExpected, `split @${k}: header behind dead opener must match whole-text, got ${JSON.stringify(out)}`);
    }
    const longPayload = `${deadOpen}\n${"z".repeat(700)}\n${H2}\ntail`;
    const longExpected = stripBiliArtifacts(longPayload);
    assert.equal(longExpected, `${deadOpen}\n${"z".repeat(700)}\ntail`, "whole-text ground truth (over budget)");
    for (const n of [1, 2, 4, 64, 257, 700]) {
        const { out } = streamThrough(longPayload, n);
        assert.equal(out, longExpected, `chunk ${n}: over-budget void must be chunk-boundary independent, got ${JSON.stringify(out)}`);
    }
    for (let k = 0; k <= longPayload.length; k += 37) {
        const f = createBiliArtifactFilter();
        const out = f.push(longPayload.slice(0, k)) + f.push(longPayload.slice(k)) + f.flush();
        assert.equal(out, longExpected, `split @${k}: over-budget sweep, got ${JSON.stringify(out)}`);
    }
});

test("streaming: second carrier behind a dead opening keeps whole-text parity (#5900)", () => {
    // Recognition is first-opener-wins (pre-existing boundary, documented in
    // nextChainSpan): a malformed first opening blocks span validation of a
    // later well-formed carrier. Pin parity so the void path cannot silently
    // change that boundary.
    const deadOpen = `${L}bili-chain v="1" b`;
    const payload = `${deadOpen}\nmid ${tag()} end\n${H1}\nbody`;
    const expected = stripBiliArtifacts(payload);
    assert.ok(expected.includes("bili-chain"), "documented limit: later carrier stays prose");
    for (const n of [1, 3, 8, 40]) {
        const { out } = streamThrough(payload, n);
        assert.equal(out, expected, `chunk ${n}: parity with whole-text, got ${JSON.stringify(out)}`);
    }
});

test("streaming: stripped carrier does not unseat a flush-following header from the leading tier (#5900)", () => {
    // Dropped bytes are invisible to the client: a header sitting flush behind
    // a removed carrier still leads the VISIBLE field, so the degenerate-turn
    // swallow must fire exactly as in whole-text (dropped bytes must not move
    // the line-head cursor).
    const escBoth = (): string => tag().replace(L, "\\u003c").replace(R, "\\u003e");
    const payload = `${escBoth()}${H1}body`;
    assert.equal(stripBiliArtifacts(payload), "", "whole-text: forged carrier + forged block = zero visible output");
    for (const n of [1, 2, 7, 33]) {
        const { out, filter } = streamThrough(payload, n);
        assert.equal(out, "", `chunk ${n}: must converge to zero visible output, got ${JSON.stringify(out)}`);
        assert.equal(filter.dropped(), true);
    }
});
