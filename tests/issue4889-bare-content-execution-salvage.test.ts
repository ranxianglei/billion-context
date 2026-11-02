import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompressInput } from "../src/compress-tool.ts";
import { salvageCompressArgs } from "../src/plugin-compress-salvage.ts";
import { repairCompressArgs } from "../src/salvage.ts";
import { parseCompressArgs } from "acp-kernel";

process.env.NODE_ENV = "test";

// #4889 incident C shape: `{"content": <bare line-form text>` — NO opening
// quote, real newlines, bare double quotes inside, balanced closing `}` (the
// stream was NOT truncated). Built from pieces so the source stays greppable.
const INCIDENT_C = [
    '{"content": m00186\u2013m00289 正式程序编写与构建（阶段二）',
    "TASK AS OF THIS BLOCK（历史）：探针全部结论已定，正在写正式程序并首次编译。",
    '关键决策：用户说 "先跑通再说"；构建走 npm run build。',
    "⑤端到端验证（待做）⑥打包分发（待做）。",
    "}",
].join("\n");

test("#4889 parseCompressInput: execution layer rescues bare-content bad shape A", () => {
    const { ranges, diagnostics } = parseCompressInput(INCIDENT_C, "call_4889");
    assert.equal(diagnostics.ok, true);
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00186");
    assert.equal(ranges[0].endRef, "m00289");
    assert.ok(ranges[0].summary.includes("探针全部结论已定"));
});

test("#4889 parseCompressInput: valid JSON object-array input is untouched", () => {
    const input = JSON.stringify({ content: [{ startId: "m00150", endId: "m00220", summary: "s" }] });
    const { ranges, diagnostics } = parseCompressInput(input, "call_neg1");
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].startRef, "m00150");
});

test("#4889 parseCompressInput: valid line-form string input is untouched", () => {
    const input = JSON.stringify({ content: "m00150\u2013m00220 topic\nsummary body" });
    const { ranges, diagnostics } = parseCompressInput(input, "call_neg2");
    assert.equal(diagnostics.kind, "ok");
    assert.equal(ranges.length, 1);
});

test("#4889 parseCompressInput: bare content without ref tokens stays rejected", () => {
    const { ranges, diagnostics } = parseCompressInput('{"content": hello world, no refs at all\n}', "call_neg3");
    assert.equal(ranges.length, 0);
    assert.notEqual(diagnostics.kind, "ok");
});

test("#4889 salvageCompressArgs: wrapped action unchanged after helper extraction", () => {
    const s = salvageCompressArgs(INCIDENT_C, "call_4889");
    assert.equal(s.action, "wrapped");
    const obj = JSON.parse(s.out) as { content: unknown };
    assert.equal(typeof obj.content, "string");
    assert.ok(parseCompressArgs(s.out, { callId: "verify" }).ranges.length >= 1);
});

test("#4889 salvageCompressArgs: strict JSON still verbatim byte-identical (#1039)", () => {
    const valid = JSON.stringify({ content: [{ startId: "m00150", endId: "m00220", summary: "s" }] });
    const s = salvageCompressArgs(valid, "call_1039");
    assert.equal(s.action, "verbatim");
    assert.equal(s.out, valid);
});

test("#4889 repairCompressArgs: wraps bad shape A into strict JSON with range count", () => {
    const out = repairCompressArgs(INCIDENT_C, "call_ext");
    assert.ok(out !== null);
    assert.equal(out!.ranges, 1);
    const obj = JSON.parse(out!.json) as { content: unknown };
    assert.equal(typeof obj.content, "string");
    assert.ok(parseCompressArgs(out!.json, { callId: "verify" }).ranges.length >= 1);
});

test("#4889 repairCompressArgs: reports every recovered range (N > 1)", () => {
    const multi = [
        '{"content": m00001\u2013m00010 第一段',
        "摘要一",
        'm00020\u2013m00030 第二段',
        "摘要二",
        "}",
    ].join("\n");
    const out = repairCompressArgs(multi, "call_ext_multi");
    assert.ok(out !== null);
    assert.equal(out!.ranges, 2);
});

test("#4889 repairCompressArgs: strict JSON passes through as null", () => {
    const valid = JSON.stringify({ content: [{ startId: "m00150", endId: "m00220", summary: "s" }] });
    assert.equal(repairCompressArgs(valid), null);
});

test("#4889 repairCompressArgs: unrecoverable garbage passes through as null", () => {
    assert.equal(repairCompressArgs('{"content": hello world no refs'), null);
});
