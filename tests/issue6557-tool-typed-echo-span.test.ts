import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAcpTags, createTagEchoFilter, stripOpenaiChatText } from "../src/loop/tag-echo-filter.ts";

// #6557: a model-emitted opening whose type names a TOOL lane frames a
// FABRICATED tool result. The #1720 rule ("prose wearing tags: the tags go,
// the content stays") was written for type="text" and is wrong here: keeping
// the body commits the invention into the assistant turn, and the model then
// imitates "tag + that body" at the head of every later reply. The span dies
// whole, in the whole-text and the streaming path alike.
const LT = "\x3c";
const GT = "\x3e";
const FABRICATED =
    '{"actualContent": "acp_cache read-only: grand total in=2,874,000 cacheRead=2,753,682", "reason": "result compressed for budget", "tokens": 1000}';
const toolOpen = (type = "tool:acp_cache") => `${LT}acp tokens="2312" type="${type}" time="2026-11-13T15:52:59Z"${GT}`;
const textOpen = `${LT}acp tokens="78" type="text" time="2026-11-13T15:52:47Z"${GT}`;
const close = `${LT}/acp${GT}`;

function stream(chunks: string[]): string {
    const f = createTagEchoFilter();
    let out = "";
    for (const c of chunks) out += f.push(c);
    out += f.flush();
    return out;
}

/** Every 2-way split of s, plus byte-at-a-time — the chunk boundary must not
 *  change the verdict (the #4178/#4210 split-invariance discipline). */
function allChunkings(s: string): string[][] {
    const out: string[][] = [[s]];
    for (let i = 1; i < s.length; i++) out.push([s.slice(0, i), s.slice(i)]);
    out.push([...s]);
    return out;
}

test("#6557: whole-text drops a tool-typed echo span, prose around it survives", () => {
    const text = `before ${toolOpen()}${FABRICATED}${close} after`;
    assert.equal(stripAcpTags(text), "before  after");
});

test("#6557: whole-text drops every tool-typed span in the field", () => {
    const one = `${toolOpen()}${FABRICATED}${close}`;
    const two = `${toolOpen("tool:acp_status")}{"blocks": []}${close}`;
    assert.equal(stripAcpTags(`a ${one} b ${two} c`), "a  b  c");
});

test("#6557: an unclosed tool-typed echo owns the rest of the field", () => {
    // The imitation was never terminated: everything after the opening is its
    // payload (the wrapped-turn EOF rule, reused).
    assert.equal(stripAcpTags(`${toolOpen()}${FABRICATED}`), "");
    assert.equal(stripAcpTags(`lead ${toolOpen()}${FABRICATED}`), "lead ");
});

test("#6557: the type attribute is matched through casing drift", () => {
    assert.equal(stripAcpTags(`x ${toolOpen("TOOL:acp_cache")}${FABRICATED}${close} y`), "x  y");
    const driftedAttr = `${LT}acp tokens="2312" Type="tool:acp_cache"${GT}${FABRICATED}${close}`;
    assert.equal(stripAcpTags(`x ${driftedAttr} y`), "x  y");
});

test("#6557: streaming drops the span — and the verdict is split-invariant", () => {
    const text = `before ${toolOpen()}${FABRICATED}${close} after`;
    for (const chunks of allChunkings(text)) {
        assert.equal(stream(chunks), "before  after", `chunking ${JSON.stringify(chunks.map((c) => c.length))}`);
    }
});

test("#6557: streaming drops an unclosed span at EOF", () => {
    const text = `lead ${toolOpen()}${FABRICATED}`;
    for (const chunks of allChunkings(text)) {
        assert.equal(stream(chunks), "lead ", `chunking ${JSON.stringify(chunks.map((c) => c.length))}`);
    }
});

test("#6557: the drop is reported to the caller (visible in the log callback)", () => {
    const seen: string[] = [];
    const f = createTagEchoFilter((snippet) => seen.push(snippet));
    f.push(`before ${toolOpen()}${FABRICATED}${close} after`);
    f.flush();
    assert.equal(seen.length, 1, "one artifact, one warn");
    assert.ok(seen[0].includes('type="tool:acp_cache"'));
});

// ── recall guards: the tool-typed rule must not eat anything that is prose ──

test("#6557 guard: a type=\"text\" echo keeps its prose body (#1720 unchanged)", () => {
    const text = `see ${textOpen}the model's own sentence${close} end`;
    assert.equal(stripAcpTags(text), "see the model's own sentence end");
});

test("#6557 guard: a text echo whose body is a refs-only run still dies whole (#1720)", () => {
    assert.equal(stripAcpTags(`a ${textOpen}m00120–m00300${close} b`), "a  b");
});

test("#6557 guard: markup in a tool-call argument stays byte-exact (#1039)", () => {
    const args = JSON.stringify({ command: `echo '${toolOpen()}${FABRICATED}${close}'` });
    const payload = { choices: [{ message: { content: "", tool_calls: [{ function: { name: "bash", arguments: args } }] } }] };
    const out = stripOpenaiChatText(payload) as typeof payload;
    assert.equal(out.choices[0].message.tool_calls[0].function.arguments, args);
});

test("#6557 guard: a tool-typed echo inside a fenced code block still goes (no fence exemption elsewhere in the filter)", () => {
    // Documented behavior of the whole channel: the filter has no markdown
    // awareness (see tag-echo.test.ts), so the assertion here only pins that
    // the tool-typed branch did not invent one.
    const text = "```\n" + `${toolOpen()}${FABRICATED}${close}` + "\n```";
    assert.equal(stripAcpTags(text), "```\n\n```");
});
