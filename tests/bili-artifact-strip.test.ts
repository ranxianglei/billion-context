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
    CODEX_FORGED_HANDOFF_REDACTION,
    FORGED_SUMMARY_REDACTION,
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
const PH1 = CODEX_FORGED_HANDOFF_REDACTION;
const PH2 = FORGED_SUMMARY_REDACTION;

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

test("whole-text: field-head header block cuts to end; other occurrences redact in place (#5587)", () => {
    assert.equal(stripBiliArtifacts(`${H1}\nsummary body\nmore`), "");
    assert.equal(stripBiliArtifacts(`${H2} — topic\nbody`), "");
    assert.equal(
        stripBiliArtifacts(`\n${H2} — topic\nbody`),
        "\n",
        "whitespace-only lead still reads as a forged field head",
    );
    assert.equal(
        stripBiliArtifacts(`intro\n${H2} — topic\nbody`),
        `intro\n${PH2} — topic\nbody`,
        "line-start mention after genuine prose keeps its tail",
    );
    assert.equal(
        stripBiliArtifacts(`the ${H2} covers old turns`),
        `the ${PH2} covers old turns`,
        "mid-line mention: literal redacted, sentence survives",
    );
    assert.equal(
        stripBiliArtifacts(`See ${H1} for details.`),
        `See ${PH1} for details.`,
        "mid-line mention: literal redacted, sentence survives",
    );
    assert.equal(
        stripBiliArtifacts(`x ${H1} y\n${H2}\ntail`),
        `x ${PH1} y\n${PH2}\ntail`,
        "every occurrence is redacted, not just the first",
    );
});

test("whole-text: redaction is a fixed point of stripAcpTags (#5587)", () => {
    for (const input of [`intro\n${H2} — topic\nbody`, `x ${H1} y\n${H2}\ntail`, `${H2} — t\nbody`]) {
        const once = stripAcpTags(input);
        assert.equal(stripAcpTags(once), once, `fixed point for ${JSON.stringify(input)}`);
    }
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
    assert.ok(mayStartBiliInternal("plain line ending in bracket ["), "trailing '[' is a header prefix now (#5587: matcher is position-independent, the gate must agree)");
    assert.ok(mayStartBiliInternal("mid line [Co"));
    assert.ok(!mayStartBiliInternal("[Code review notes]"), "'[Cod' is not a header prefix");
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

test("streaming: field-head forged block swallowed to end of field at every split point", () => {
    const cases: Array<[string, string]> = [
        [`${H2} — topic\nbody continues`, ""],
        [`\n${H1}\nsummary body`, "\n"],
    ];
    for (const [payload, expected] of cases) {
        for (const n of [1, 2, 4, 9]) {
            const { out, filter } = streamThrough(payload, n);
            assert.equal(out, expected, `chunk ${n}: field-head block-to-end semantics, got ${JSON.stringify(out)}`);
            assert.equal(filter.dropped(), true);
        }
    }
});

test("streaming: mention after genuine prose redacts the literal at every split point (#5587)", () => {
    const payload = `intro\n${H2} — topic\nbody continues`;
    const expected = `intro\n${PH2} — topic\nbody continues`;
    for (const n of [1, 2, 4, 9]) {
        const { out, filter } = streamThrough(payload, n);
        assert.equal(out, expected, `chunk ${n}: redaction semantics, got ${JSON.stringify(out)}`);
        assert.equal(filter.dropped(), true);
    }
});

test("streaming: mid-line backtick mention is split-stable and keeps the sentence (#5587)", () => {
    // The reported repro shape: the model quotes the fold header inside a
    // sentence. Char-by-char arrivals used to complete the header at buf
    // position 0 and swallow the rest of the stream; whole-chunk arrivals let
    // it through raw — output depended on where the chunk boundary fell.
    const payload = `断点正好落在 \`${H2}\` 这个标题处，后面还有内容。`;
    const expected = `断点正好落在 \`${PH2}\` 这个标题处，后面还有内容。`;
    assert.equal(streamThrough(payload, payload.length).out, expected, "whole-chunk reference");
    for (const n of [1, 2, 3, 5, 7, 13]) {
        assert.equal(streamThrough(payload, n).out, expected, `chunk ${n}: split-stable redaction`);
    }
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

test("degenerate-turn gate parity: a mixed turn keeps its visible answer (#5587)", () => {
    // Genuine prose before the header means the field is NOT a forged block:
    // the answer text survives (redaction marker included) so the empty-turn
    // retry does not fire on a turn that actually delivered an answer.
    const { out, filter } = streamThrough(`real answer\n${H2} — t\nmore answer`, 1);
    assert.equal(out, `real answer\n${PH2} — t\nmore answer`);
    assert.ok(out.trim().length > 0, "visible answer chars survive the redaction");
    assert.equal(filter.dropped(), true, "the drop is still recorded");
});
