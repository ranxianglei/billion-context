import { test } from "node:test";
import assert from "node:assert/strict";
import {
    stripAcpTags,
    stripAssistantProse,
    stripBareRefHead,
    containsBareRefHeadText,
    containsBareRefHeadWire,
    mayStartBareRefHead,
    createBareRefHeadFilter,
    createTagEchoFilter,
    composeStreamFilters,
    stripOpenaiChatText,
    stripAnthropicText,
    stripResponsesText,
} from "../src/loop/tag-echo-filter.ts";

// #5259: a dsh/OpenAI-lane assistant reply opened with a bare ledger ref plus
// one stray letter (`m01464b\n`) as its own first text block — no tag opener,
// no attribute text, so every shape-keyed channel (#206/#5195/#717) misses it.
// The model imitated a copyable ref literal at generation time; nothing in the
// reasoning channel planned it. Fix = position+shape guard: the WHOLE first
// line of an assistant TEXT channel equals m + 4..6 digits + ≤1 letter → drop
// that line (its \n included). Text channels only — never signed
// thinking/reasoning (#1960/KDD#10) or tool-call arguments (#1039).

const GTE = "\x3e"; // >
const LT = "\x3c";  // <

const PROSE = "懂了，你说的是这件事。";

test("#5259: stripBareRefHead drops the reported shape (whole-text)", () => {
    // reported residue alone, no newline
    assert.equal(stripBareRefHead("m01464b"), "");
    // reported shape: residue line + prose
    assert.equal(stripBareRefHead(`m01464b\n${PROSE}`), PROSE);
    // width bounds: 4-digit floor (kernel refs start m0001)…
    assert.equal(stripBareRefHead("m1234\nx"), "x");
    // …6-digit ceiling (~1M messages, past any real session)
    assert.equal(stripBareRefHead("m123456\nx"), "x");
    assert.equal(stripBareRefHead("m123456z\nx"), "x");
    // stray letter case-folds both ways
    assert.equal(stripBareRefHead("m01464B\nx"), "x");
});

test("#5259: stripBareRefHead leaves near-miss shapes byte-exact", () => {
    // two stray letters: not the shape
    assert.equal(stripBareRefHead("m01464bc\nx"), "m01464bc\nx");
    // prose on the same line
    assert.equal(stripBareRefHead("m014645 more\nx"), "m014645 more\nx");
    // trailing space on the line
    assert.equal(stripBareRefHead("m01464b \nx"), "m01464b \nx");
    // 7 digits: beyond the census bound, honest prose
    assert.equal(stripBareRefHead("m1234567\nx"), "m1234567\nx");
    // word-glued at byte 0
    assert.equal(stripBareRefHead("xm01464\nx"), "xm01464\nx");
    // leading whitespace (observed residue is byte-0)
    assert.equal(stripBareRefHead(" m01464\nx"), " m01464\nx");
    // CRLF: strict \n boundary, no tolerance
    assert.equal(stripBareRefHead("m01464b\r\nx"), "m01464b\r\nx");
    // uppercase M: refs are lowercase-m
    assert.equal(stripBareRefHead("M01464\nx"), "M01464\nx");
    // later lines are out of scope by design
    assert.equal(stripBareRefHead(`ok\nm01464b\nmore`), `ok\nm01464b\nmore`);
    // empty / blank-first-line inputs pass through
    assert.equal(stripBareRefHead(""), "");
    assert.equal(stripBareRefHead("\nx"), "\nx");
});

test("#5259: stripAssistantProse layers the head guard onto stripAcpTags", () => {
    // residue line 1, render tag line 2 → both go
    const x = `m01464b\n${LT}acp tokens="2" type="text"${GTE}m00010${LT}/acp${GTE} rest`;
    assert.equal(stripAssistantProse(x), " rest");
    // #5195 opener-less residue on line 2, bare ref on line 1 → both go
    // (#5195 semantics: whitespace flanking the unit is content, both survive)
    assert.equal(stripAssistantProse(`m01464b\n type="text"${GTE}m00106 rest`), "  rest");
    // scope boundary: a stripped tag leaves a leading BLANK line, which disarms
    // the byte-0 guard — residue on what becomes line 2 survives (documented)
    assert.equal(
        stripAssistantProse(`${LT}acp tokens="2" type="text"${GTE}m00010${LT}/acp${GTE}\nm01464b\nrest`),
        `\nm01464b\nrest`,
    );
});

test("#5259: stripAcpTags itself stays position-independent (no fold-in)", () => {
    // the bare shape has no key for the whole-text stripper — unchanged
    assert.equal(stripAcpTags(`m01464b\nrest`), `m01464b\nrest`);
    // bare refs cited mid-prose are prose, not residue (pre-existing behavior)
    assert.equal(stripAcpTags("see m00123 and m00124 done"), "see m00123 and m00124 done");
});

test("#5259: predicates (field-level, wire-level, chunk-level)", () => {
    // field-level engage
    assert.equal(containsBareRefHeadText("m01464b"), true);
    assert.equal(containsBareRefHeadText(`m01464b\nrest`), true);
    assert.equal(containsBareRefHeadText("m1234"), true);
    assert.equal(containsBareRefHeadText("m123456x"), true);
    assert.equal(containsBareRefHeadText(""), false);
    assert.equal(containsBareRefHeadText("hello"), false);
    assert.equal(containsBareRefHeadText(" m01464b"), false);
    assert.equal(containsBareRefHeadText("m01464bc\nrest"), false);
    assert.equal(containsBareRefHeadText("m01464b \nrest"), false);
    assert.equal(containsBareRefHeadText("m1234567\nrest"), false);
    // wire-level pre-check on raw JSON (escaped newline or closing quote)
    assert.equal(containsBareRefHeadWire('{"text":"m01464b\\nrest"}'), true);
    assert.equal(containsBareRefHeadWire('{"text":"m01464b"}'), true);
    assert.equal(containsBareRefHeadWire('{"content":[{"type":"output_text","text":"m123456x"}]}'), true);
    assert.equal(containsBareRefHeadWire('{"text":"m01464bc\\n"}'), false);
    assert.equal(containsBareRefHeadWire('{"text":"xm01464"}'), false);
    assert.equal(containsBareRefHeadWire('{"text":"prose"}'), false);
    // chunk-level fast-path gate: could this chunk OPEN the shape?
    assert.equal(mayStartBareRefHead("m"), true);
    assert.equal(mayStartBareRefHead("m0"), true);
    assert.equal(mayStartBareRefHead("m01464b\nx"), true);
    assert.equal(mayStartBareRefHead(""), false);
    assert.equal(mayStartBareRefHead("x"), false);
    assert.equal(mayStartBareRefHead(" m"), false);
    assert.equal(mayStartBareRefHead("M0"), false);
});

test("#5259: streaming filter drops the residue at every chunk split", () => {
    const S = `m01464b\n${PROSE}\n`;
    const EXPECTED = `${PROSE}\n`;
    // property: one split anywhere → identical output (the size=1 leak class
    // from the issue repro is covered by i=1)
    for (let i = 1; i < S.length; i++) {
        const f = createBareRefHeadFilter();
        const out = f.push(S.slice(0, i)) + f.push(S.slice(i)) + f.flush();
        assert.equal(out, EXPECTED, `split at ${i}: ${JSON.stringify(out)}`);
    }
    // single-char pushes throughout (tokenizer-sized fragments)
    const g = createBareRefHeadFilter();
    let acc = "";
    for (const ch of S) acc += g.push(ch);
    acc += g.flush();
    assert.equal(acc, EXPECTED);
});

test("#5259: streaming filter — EOF without newline, empty chunks, callbacks", () => {
    // residue is the entire field, stream ends before any newline
    const a = createBareRefHeadFilter();
    assert.equal(a.push("m01464b") + a.flush(), "");
    assert.equal(a.dropped(), true);
    assert.equal(a.stats().dropCount, 1);
    // empty leading chunk must not decide the line
    const b = createBareRefHeadFilter();
    assert.equal(b.push(""), "");
    assert.equal(b.push(`m01464b\n${PROSE}`) + b.flush(), PROSE);
    // onDrop fires once with the dropped snippet
    let seen: string | undefined;
    const c = createBareRefHeadFilter((s) => { seen = s; });
    assert.equal(c.push("m01464b\n"), "");
    assert.equal(seen, "m01464b\n");
    const mid = c.push("m01465c\n"); // disarmed: second ref-like line passes
    assert.equal(mid + c.push("tail") + c.flush(), "m01465c\ntail");
});

test("#5259: streaming filter — negative rows stay byte-exact", () => {
    // two letters break the shape at the breaking byte
    let f = createBareRefHeadFilter();
    assert.equal(f.push("m01464bc\nx") + f.flush(), "m01464bc\nx");
    // prose on the same line
    f = createBareRefHeadFilter();
    assert.equal(f.push("m014645 more") + f.flush(), "m014645 more");
    // 7-digit run releases as prose once the prefix stops matching
    f = createBareRefHeadFilter();
    assert.equal(f.push("m1234567\nx") + f.flush(), "m1234567\nx");
    // second line immune after first-line decision
    f = createBareRefHeadFilter();
    assert.equal(f.push(`ok\nm01464b\nmore`) + f.flush(), `ok\nm01464b\nmore`);
    // CRLF not matched (strict \n)
    f = createBareRefHeadFilter();
    assert.equal(f.push("m01464b\r\nx") + f.flush(), "m01464b\r\nx");
    // pending() is true only while the candidate prefix is held
    f = createBareRefHeadFilter();
    assert.equal(f.push("m01"), "");
    assert.equal(f.pending(), true);
    assert.equal(f.push("464b\n") + f.flush(), "");
    assert.equal(f.pending(), false);
});

test("#5259: composed onto the tag-echo chain, split-deterministic", () => {
    // input flows tagEcho→bareRef: residue line 1 + full tag line 2
    const S = `m01464b\n${LT}acp tokens="2" type="text"${GTE}m00010${LT}/acp${GTE} done\n`;
    const EXPECTED = " done\n";
    for (let i = 1; i < S.length; i++) {
        const f = composeStreamFilters(createTagEchoFilter(), createBareRefHeadFilter());
        const out = f.push(S.slice(0, i)) + f.push(S.slice(i)) + f.flush();
        assert.equal(out, EXPECTED, `split at ${i}: ${JSON.stringify(out)}`);
    }
    // composed stats merge the drop
    const f = composeStreamFilters(createTagEchoFilter(), createBareRefHeadFilter());
    f.push(S);
    f.flush();
    assert.equal(f.stats().dropped, true);
    assert.ok(f.stats().dropCount >= 2, `dropCount=${f.stats().dropCount}`);
});

test("#5259: wire strippers apply the head guard to assistant text fields only", () => {
    // OpenAI chat: delta.content stripped, reasoning_content byte-verbatim
    const openai = stripOpenaiChatText({
        choices: [{ delta: { content: `m01464b\n${PROSE}`, reasoning_content: "m01464b\nprivate" } }],
    });
    const ch = (openai.choices as Array<{ delta: { content: string; reasoning_content: string } }>)[0];
    assert.equal(ch.delta.content, PROSE);
    assert.equal(ch.delta.reasoning_content, "m01464b\nprivate");
    // Anthropic: text blocks stripped; thinking blocks carry no .text — untouched
    const anth = stripAnthropicText({
        content: [
            { type: "text", text: `m01464b\n${PROSE}` },
            { type: "thinking", thinking: "m01464b\nsigned channel" },
        ],
    });
    const ac = anth.content as Array<{ type?: string; text?: string; thinking?: string }>;
    assert.equal(ac[0].text, PROSE);
    assert.equal(ac[1].thinking, "m01464b\nsigned channel");
    // Responses: message output_text stripped; function_call arguments byte-exact (#1039)
    const args = '{"cmd":"echo m01464b"}';
    const resp = stripResponsesText({
        response: {
            output: [
                { type: "message", role: "assistant", content: [{ type: "output_text", text: `m01464b\n${PROSE}` }] },
                { type: "function_call", name: "bash", call_id: "call_1", arguments: args },
            ],
        },
    });
    const ro = (resp.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    const rc = ro[0].content as Array<Record<string, string>>;
    assert.equal(rc[0].text, PROSE);
    assert.equal(ro[1].arguments, args);
});

test("#5259: idempotent — re-normalizing cleaned bytes is stable", () => {
    const inputs = [
        `m01464b\n${PROSE}`,
        "m01464b",
        `m01464b\n${LT}acp tokens="2" type="text"${GTE}m00010${LT}/acp${GTE} rest`,
        `m01464bc\n${PROSE}`,
        `ok\nm01464b\nmore`,
    ];
    for (const x of inputs) {
        const once = stripAssistantProse(x);
        assert.equal(stripAssistantProse(once), once, `not idempotent for ${JSON.stringify(x)}`);
    }
});
