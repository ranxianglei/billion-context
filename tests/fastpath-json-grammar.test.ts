import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import { coreToOpenai, openaiToCore } from "acp-kernel/wire";
import { scanMessagesSpans } from "../src/server/fastpath-scan.ts";
import { evaluateWatermarkFastpath, finalizeWatermarkTurn, PF_COUNT_HEADER } from "../src/server/fastpath.ts";
import { stripRawStage } from "../src/marker/engine.ts";
import { _resetStoreForTest, _setStoreForTest, type SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

for (const [name, whitespace] of Object.entries({ space: " ", tab: "\t", newline: "\n", carriageReturn: "\r", mixed: " \r\n\t" })) {
    test(`nested arrays accept JSON ${name} after commas and retain exact spans`, () => {
        const body = '{"messages":[{"role":"user","content":[{"type":"text","text":"你好🔥"},'
            + whitespace + '{"type":"text","text":"next"}]}],"stop":["end",' + whitespace + '"done"]}';
        const parsed = JSON.parse(body);
        const scan = scanMessagesSpans(body, "all");
        assert.ok(scan);
        assert.equal(scan.total, 1);
        assert.deepEqual(scan.messageSpans.map(({ start, end }) => JSON.parse(body.slice(start, end))), parsed.messages);
        assert.deepEqual(Object.fromEntries([...scan.fieldSpans].map(([key, { start, end }]) =>
            [key, JSON.parse(body.slice(start, end))])), parsed);
    });
}

for (const number of ["1e+5", "-2.5E+2", "0e+0", "1e-5", "1E5"]) {
    test(`valid JSON number ${number} remains eligible for the structural scan`, () => {
        const body = `{"messages":[{"role":"user","content":"hello","metadata":{"value":${number}}}],"max_completion_tokens":${number}}`;
        const parsed = JSON.parse(body);
        const scan = scanMessagesSpans(body, "all");
        assert.ok(scan);
        assert.deepEqual(scan.messageSpans.map(({ start, end }) => JSON.parse(body.slice(start, end))), parsed.messages);
        const span = scan.fieldSpans.get("max_completion_tokens");
        assert.ok(span);
        assert.equal(body.slice(span.start, span.end), number);
    });
}

for (const body of [
    '{"messages":[],}',
    '{"messages":[], \r\n\t}',
    '{"model":"m1","messages":[{"role":"user","content":"hello"}],"stream":false,}',
    '{"messages":[{"content":["one", ]}]}',
    '{"messages":[],"stop":["one",\n]}',
    '{"messages":[],"value":+1}',
    '{"messages":[],"value":1e+}',
    '{"messages":[],"value":1e++2}',
    '{"messages":[],"value":1+2}',
    '{"messages":[],"value":1e+02.3}',
]) {
    test(`malformed JSON cannot produce a successful scan: ${JSON.stringify(body)}`, () => {
        assert.throws(() => JSON.parse(body), SyntaxError);
        assert.equal(scanMessagesSpans(body, "all"), null);
    });
}

const prefix = [
    { role: "system", content: "You are a concise assistant." },
    { role: "user", content: "first" },
    { role: "assistant", content: "ack" },
    { role: "user", content: "second" },
];

function seededFastpath(t: test.TestContext) {
    const previousRollout = process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK;
    process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";
    const ext = new Map<string, unknown>();
    _setStoreForTest({
        closeQuietly: (): void => {},
        replicasAvailable: (): boolean => true,
        getSessionExt: (sid: string, key: string): unknown => ext.get(`${sid}\0${key}`),
        setSessionExt: (sid: string, key: string, value: unknown): void => { ext.set(`${sid}\0${key}`, value); },
    } as unknown as SessionStore);
    t.after(() => {
        _resetStoreForTest();
        if (previousRollout === undefined) delete process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK;
        else process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = previousRollout;
    });
    const session = { id: t.name } as unknown as Session;
    const evaluate = (body: string, headers: Record<string, string>) => evaluateWatermarkFastpath(
        body, { headers } as unknown as http.IncomingMessage, session,
        { pluginMode: true, titleGen: false, model: "m1" }, () => {},
    );
    const body = JSON.stringify({ model: "m1", messages: prefix });
    const first = evaluate(body, {});
    assert.equal(first.decision, "no-stamp");
    const oracle = openaiToCore(JSON.parse(body));
    finalizeWatermarkTurn(session, first, {
        model: "m1", legacyCores: oracle.msgs, rawSystemText: oracle.systemText,
        turnStripCounts: stripRawStage(JSON.parse(body), "openai"),
    });
    return (next: string) => evaluate(next, { [PF_COUNT_HEADER]: String(prefix.length) });
}

test("pretty-printed multipart and tool-schema arrays keep a seeded fastpath hit with legacy output parity", (t) => {
    const evaluate = seededFastpath(t);
    const body = JSON.stringify({
        model: "m1",
        messages: [...prefix, { role: "user", content: [{ type: "text", text: "next🔥" }, { type: "text", text: "part two" }] }],
        tools: [{ type: "function", function: { name: "choose", parameters: { type: "object", properties: {
            color: { type: "string", enum: ["red", "blue"] },
        } } } }],
    }, null, 2);
    const result = evaluate(body);
    assert.equal(result.decision, "hit");
    assert.ok(result.hit);
    const oracle = openaiToCore(JSON.parse(body));
    assert.deepEqual(coreToOpenai(result.hit.view), coreToOpenai(oracle.msgs));
    assert.equal(result.hit.systemText, oracle.systemText);
});

test("positive exponent in a valid sibling field keeps a seeded fastpath hit", (t) => {
    const evaluate = seededFastpath(t);
    const body = JSON.stringify({ model: "m1", messages: [...prefix, { role: "assistant", content: "next" }] }).slice(0, -1)
        + ',"max_completion_tokens":1e+3}';
    const result = evaluate(body);
    assert.equal(result.decision, "hit");
    assert.ok(result.hit);
    const span = result.hit.fieldSpans.get("max_completion_tokens");
    assert.ok(span);
    assert.equal(JSON.parse(body.slice(span.start, span.end)), 1000);
    assert.deepEqual(coreToOpenai(result.hit.view), coreToOpenai(openaiToCore(JSON.parse(body)).msgs));
});

test("a seeded fastpath rejects a top-level trailing comma before parsing message fragments", (t) => {
    const evaluate = seededFastpath(t);
    const valid = JSON.stringify({ model: "m1", messages: [...prefix, { role: "assistant", content: "next" }] });
    assert.equal(evaluate(valid).decision, "hit", "the same valid request must be eligible");
    const malformed = valid.slice(0, -1) + ",}";
    assert.throws(() => JSON.parse(malformed), SyntaxError);
    const result = evaluate(malformed);
    assert.equal(result.decision, "scan-broken");
    assert.equal(result.hit, null);
    assert.equal(result.creditedMiss, false);
});
