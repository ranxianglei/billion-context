// #2579: the served compress surface must state the strict-JSON serialization
// contract — the kernel-default wording ("plain text … no JSON structure, no
// escaping", unquoted ref-header examples) made DeepSeek-class models stream
// invalid JSON ~4% of the time on DSH (bare unquoted values, or unescaped
// quotes/newlines inside quoted strings), failing whole turns on strict
// clients. These tests pin the host-side corrected surface (src/compress-tool.ts):
// every wire shape serves the fixed descriptions, the old misleading phrases
// are gone, the advertised examples are themselves valid strict JSON, and the
// nudge note is a byte-stable append.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BILI_ACP_TOOLS_ANTHROPIC,
    BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE,
    BILI_ACP_TOOLS_GOOGLE,
    BILI_ACP_TOOLS_GOOGLE_NO_RANGE,
    BILI_ACP_TOOLS_OPENAI,
    BILI_ACP_TOOLS_OPENAI_NO_RANGE,
    BILI_ACP_TOOLS_RESPONSES,
    BILI_ACP_TOOLS_RESPONSES_NO_RANGE,
    COMPRESS_JSON_NOTE,
    withCompressJsonNote,
} from "../src/compress-tool.ts";

const LEGACY_PHRASES = ["no JSON escaping", "no JSON structure", "lossy gateways"];
const ESC_QUOTE = '\\"';
const ESC_NEWLINE = "\\n";

function findTool(tools: unknown, name: string): any {
    const hit = (tools as any[]).find((t) => t.name === name || t.function?.name === name);
    if (!hit) throw new Error(`tool ${name} not found`);
    return hit;
}

function surfaces(): Array<{ label: string; desc: string; params: any }> {
    const out: Array<{ label: string; desc: string; params: any }> = [];
    const push = (label: string, tools: unknown) => {
        const t = findTool(tools, "compress");
        const params = t.input_schema ?? t.function?.parameters ?? t.parameters;
        out.push({ label, desc: t.description ?? t.function?.description, params });
    };
    push("anthropic", BILI_ACP_TOOLS_ANTHROPIC);
    push("openai", BILI_ACP_TOOLS_OPENAI);
    push("responses", BILI_ACP_TOOLS_RESPONSES);
    push("google", BILI_ACP_TOOLS_GOOGLE);
    push("anthropic-no-range", BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE);
    push("openai-no-range", BILI_ACP_TOOLS_OPENAI_NO_RANGE);
    push("responses-no-range", BILI_ACP_TOOLS_RESPONSES_NO_RANGE);
    push("google-no-range", BILI_ACP_TOOLS_GOOGLE_NO_RANGE);
    return out;
}

test("every served compress surface states the strict-JSON contract", () => {
    for (const s of surfaces()) {
        assert.ok(s.desc.includes("STRICT JSON") || s.desc.includes("strict JSON"), `${s.label}: tool description must state strict-JSON parsing`);
        assert.ok(s.desc.includes('{"content":[{"startId":"m00122","endId":"m00127","summary":"...","topic":"..."}]}'), `${s.label}: array-of-objects PREFERRED example missing`);
        assert.ok(s.desc.includes(ESC_QUOTE), `${s.label}: escape rule (internal quotes) missing`);
        assert.ok(s.desc.includes(ESC_NEWLINE), `${s.label}: escape rule (newlines) missing`);
        for (const phrase of LEGACY_PHRASES) {
            assert.ok(!s.desc.includes(phrase), `${s.label}: legacy phrase still present: ${phrase}`);
            assert.ok(!JSON.stringify(s.params).includes(phrase), `${s.label}: legacy phrase in schema: ${phrase}`);
        }
        const contentDesc = s.params?.properties?.["content"]?.description ?? "";
        assert.ok(contentDesc.length > 0, `${s.label}: content param description missing`);
        assert.ok(contentDesc.includes("STRICT JSON") || contentDesc.includes("strict JSON"), `${s.label}: content param must state strict-JSON rule`);
        assert.ok(contentDesc.includes(ESC_QUOTE) && contentDesc.includes(ESC_NEWLINE), `${s.label}: content param must state escaping`);
    }
});

test("line-form string items (array/string alternation) carry the quoted-value rule", () => {
    for (const label of ["anthropic", "openai", "responses"]) {
        const tools = label === "anthropic" ? BILI_ACP_TOOLS_ANTHROPIC : label === "openai" ? BILI_ACP_TOOLS_OPENAI : BILI_ACP_TOOLS_RESPONSES;
        const t = findTool(tools, "compress");
        const params = t.input_schema ?? t.function?.parameters ?? t.parameters;
        const branches = params?.properties?.["content"]?.anyOf ?? [];
        const lineForms: string[] = [];
        for (const branch of branches) {
            for (const alt of branch?.items?.anyOf ?? []) {
                if (alt.type === "string" && typeof alt.description === "string") lineForms.push(alt.description);
            }
        }
        assert.equal(lineForms.length, 1, `${label}: expected exactly one string line-form item`);
        assert.ok(lineForms[0]!.startsWith("Line form"), `${label}: line-form item description not replaced`);
        assert.ok(lineForms[0]!.includes("quoted JSON string value"), `${label}: line-form must say the entry is a quoted JSON string value`);
        assert.ok(lineForms[0]!.includes(ESC_QUOTE) && lineForms[0]!.includes(ESC_NEWLINE), `${label}: line-form must state escaping`);
        assert.ok(!lineForms[0]!.includes("no JSON escaping"), `${label}: legacy 'no JSON escaping' still present`);
    }
});

test("advertised examples are themselves valid strict JSON", () => {
    const toolExample = '{"content":[{"startId":"m00122","endId":"m00127","summary":"...","topic":"..."}]}';
    assert.deepEqual(JSON.parse(toolExample).content, [{ startId: "m00122", endId: "m00127", summary: "...", topic: "..." }]);
    const noteExample = '{"content":[{"startId":"m00122","endId":"m00127","summary":"..."}]}';
    assert.ok(COMPRESS_JSON_NOTE.includes(noteExample), "nudge note must advertise the same array skeleton");
    assert.deepEqual(JSON.parse(noteExample).content, [{ startId: "m00122", endId: "m00127", summary: "..." }]);
    // The string form as advertised (header line + markdown inside ONE quoted
    // value, escaped newline) must round-trip through strict JSON.parse.
    const stringForm = JSON.parse('{"content":"m00122–m00127 Fixed\\n## Details"}');
    assert.equal(stringForm.content, "m00122–m00127 Fixed\n## Details");
});

test("withCompressJsonNote is a byte-stable append of the constant", () => {
    assert.ok(COMPRESS_JSON_NOTE.startsWith("\n\n[JSON validity:"), "note must start on its own lines");
    assert.ok(withCompressJsonNote("x") === "x" + COMPRESS_JSON_NOTE);
    assert.equal(withCompressJsonNote("abc"), withCompressJsonNote("abc"));
    // No dynamic values: rendering twice with different inputs yields the same suffix.
    assert.equal(withCompressJsonNote("a").slice(1), withCompressJsonNote("b").slice(1));
});
