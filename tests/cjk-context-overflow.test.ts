import test from "node:test";
import assert from "node:assert/strict";
import { inspectContextOverflow } from "../src/util.ts";

// #3787 taught the overflow detector to read the 上下文 family of Chinese
// rejections. Two gaps survive it, and both leave the same failure mode in
// place: `armOverflowShrink` never runs, so no emergency shrink is armed, and
// the identical oversized payload is re-forwarded on every retry while the
// local meter stays frozen at its last reading — the client sees the same error
// forever (field repro: #3240's relay loop, three 400s over four minutes on a
// 5.0 MiB body with zero `armed emergency shrink` lines in the log).
//
//   1. A rejection that names the INPUT side rather than 上下文
//      ("输入过长，请减少对话轮次") matches no marker at all.
//   2. `parseOverflowWindow` is English-only, so even a recognized CJK body
//      yields no window: the arm falls into the "window not parseable" branch
//      and sizes at the rejected payload's own estimate instead of the limit
//      the relay just stated.
//
// Each gate ships both directions (#3617): a false positive arms a shrink
// against a payload that fits, so the shared vocabulary (throttle, balance,
// output-length) must stay dark.

test("CJK: field repro '请求上下文超限：本次请求约 N tokens，超过单次上限 W tokens' → overflow + window W", () => {
    // Verbatim body from a live 400 loop. The payload number precedes the limit
    // number, so the window parse must take the number attached to 上限, never
    // the first number in the sentence.
    const body =
        "请求上下文超限：本次请求约 1748713 tokens，超过单次上限 1500000 tokens。请缩短对话历史或开启上下文压缩后重试（请求未发送到上游，未计费）。";
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 1500000);
});

test("CJK: input-side phrasing '输入过长' / '提示词太长' → overflow (#3787 leaves these dark)", () => {
    assert.equal(inspectContextOverflow(400, "输入过长：请减少对话轮次").isOverflow, true);
    assert.equal(inspectContextOverflow(400, "提示词太长，请精简后重试").isOverflow, true);
});

test("CJK: '请求/对话/消息' + length predicate → overflow", () => {
    assert.equal(inspectContextOverflow(400, "本次请求过长，已被拒绝").isOverflow, true);
    assert.equal(inspectContextOverflow(400, "对话太长，请开启新会话").isOverflow, true);
    assert.equal(inspectContextOverflow(400, "消息超长，无法提交").isOverflow, true);
});

test("CJK: token-side phrasing '输入 token 数量超出允许范围' → overflow", () => {
    const info = inspectContextOverflow(400, "输入 token 数量超出允许范围");
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, undefined, "no window number stated → no window (a wrong guess is worse than none)");
});

test("CJK: '本次请求超过模型上限 N tokens' → overflow + window N", () => {
    const info = inspectContextOverflow(400, "本次请求超过模型上限 128000 tokens");
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 128000);
});

test("CJK: 'N tokens 的上限' (limit word trails the number) → window N", () => {
    // The reversed word order: relays that quote the limit first and the
    // comparison after it. Only the number bound to the limit word counts —
    // the payload size quoted elsewhere in the body must not be taken.
    const info = inspectContextOverflow(400, "上下文超限：已突破 200000 tokens 的上限，本次请求约 240000 tokens");
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 200000);
});

test("CJK: '上下文窗口已满' inside a JSON error envelope → overflow, no window", () => {
    const body = JSON.stringify({ error: { message: "上下文窗口已满，无法继续对话", type: "invalid_request_error" } });
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, undefined);
});

test("CJK: 5xx gateway relay of a CJK overflow body → overflow (#2484 lane)", () => {
    // Some gateways relay the provider's rejection under 502/503 instead of 400.
    const info = inspectContextOverflow(502, "上游返回：上下文超限");
    assert.equal(info.isOverflow, true);
});

test("CJK: 413 with a CJK overflow body → overflow", () => {
    const info = inspectContextOverflow(413, "请求体过大，超出上下文限制");
    assert.equal(info.isOverflow, true);
});

// ── negative direction: shared vocabulary, NOT a context overflow ────────────

test("CJK negative: '请求频率超限' (throttle) → not an overflow", () => {
    const info = inspectContextOverflow(429, "请求频率超限，请稍后重试");
    assert.equal(info.isOverflow, false);
});

test("CJK negative: '触发限流' → not an overflow", () => {
    assert.equal(inspectContextOverflow(400, "触发限流，请降低并发").isOverflow, false);
});

test("CJK negative: '请求过于频繁' → not an overflow", () => {
    // 请求 + a frequency predicate is throttle phrasing; only a LENGTH predicate
    // on an input subject means the window.
    assert.equal(inspectContextOverflow(429, "请求过于频繁，请稍后重试").isOverflow, false);
});

test("CJK negative: '账户余额不足' → not an overflow", () => {
    assert.equal(inspectContextOverflow(400, "账户余额不足，请充值").isOverflow, false);
});

test("CJK negative: '参数错误：messages 不能为空' → not an overflow", () => {
    assert.equal(inspectContextOverflow(400, "参数错误：messages 不能为空").isOverflow, false);
});

test("CJK negative: '服务暂时不可用' (5xx, no input subject) → not an overflow", () => {
    assert.equal(inspectContextOverflow(503, "服务暂时不可用，请稍后重试").isOverflow, false);
});

test("CJK negative: '输出内容过长，已被截断' (output cap, not input window) → not an overflow", () => {
    // 内容过长 without an input/request/context subject is the OUTPUT-length
    // notice; shrinking the input would not fix it.
    assert.equal(inspectContextOverflow(400, "输出内容过长，已被截断").isOverflow, false);
});

test("CJK negative: status 200 never counts, whatever the body says", () => {
    assert.equal(inspectContextOverflow(200, "上下文超限").isOverflow, false);
});

test("CJK negative: '上限 3 次' (rate cap, no token unit) yields no window", () => {
    // The window parser requires a token unit; a bare numeric cap is a quota,
    // not a context window.
    const info = inspectContextOverflow(400, "本分钟调用上限 3 次，上下文超限请重试");
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, undefined);
});

// ── requestedTotal (parseOverflowCounts) — the rejected payload's own size ───

test("CJK counts: field repro → requestedTotal is the payload size N, never the limit W", () => {
    // Both parsers run on the same body and must each take their half: the
    // window reader the number bound to 上限, the counts reader the one bound
    // to the overflow predicate. A rejection bills input only (the request was
    // never forwarded), so total and messages carry the same number (#3450).
    const body =
        "请求上下文超限：本次请求约 1748713 tokens，超过单次上限 1500000 tokens。请缩短对话历史或开启上下文压缩后重试（请求未发送到上游，未计费）。";
    const info = inspectContextOverflow(400, body);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 1500000);
    assert.equal(info.requestedTotal, 1748713);
    assert.equal(info.requestedMessages, 1748713);
});

test("CJK counts: '…请求上限为 N tokens，超出部分将被截断' states a CEILING → no requestedTotal", () => {
    // Limit vocabulary between the subject and the number vetoes the guess:
    // this body names the supported maximum, not the measured payload. The
    // window parser still reads it correctly — the ceiling IS the window here.
    const info = inspectContextOverflow(400, "上下文超限：您的请求上限为 1500000 tokens，超出部分将被截断");
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, 1500000);
    assert.equal(info.requestedTotal, undefined);
});

// ── consolidated from #3246 (b-c-pi#639 field phrasings) ─────────────────────

test("CJK: #3240 field phrasings (consolidated via #3246) → overflow, no window learned", () => {
    const zhBodies = [
        JSON.stringify({ error: { message: "上下文长度超出限制" } }),
        JSON.stringify({ message: "输入长度超过模型支持的最大上下文长度" }),
        JSON.stringify({ error: { message: "请求的输入 token 数超出限制" } }),
        JSON.stringify({ error: { message: "输入 tokens 超过模型最大上下文长度" } }),
        JSON.stringify({ error: { message: "超出模型的上下文窗口限制" } }),
        JSON.stringify({ error: { message: "prompt 过长，请缩短输入后重试" } }),
    ];
    for (const body of zhBodies) {
        const info = inspectContextOverflow(400, body);
        assert.equal(info.isOverflow, true, `should match: ${body}`);
        assert.equal(info.window, undefined, `no number to learn from: ${body}`);
    }
});

test("CJK: errors merely mentioning 上下文/token stay dark (consolidated via #3246)", () => {
    assert.equal(inspectContextOverflow(400, '{"message":"无效的 API key"}').isOverflow, false);
    assert.equal(inspectContextOverflow(400, '{"message":"请求过于频繁，请稍后再试"}').isOverflow, false);
    assert.equal(inspectContextOverflow(400, '{"message":"token 已过期，请重新登录"}').isOverflow, false);
    assert.equal(inspectContextOverflow(400, '{"message":"输入格式错误：content 不能为空"}').isOverflow, false);
    assert.equal(inspectContextOverflow(400, '{"message":"当前上下文窗口配置不正确"}').isOverflow, false);
});
