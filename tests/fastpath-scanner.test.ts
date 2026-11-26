import assert from "node:assert/strict";
import test from "node:test";
import { scanMessagesSpans, type FastpathScanResult } from "../src/server/fastpath-scan.ts";

const slice = (body: string, r: FastpathScanResult, k: number): string =>
    body.slice(r.messageSpans[k].start, r.messageSpans[k].end);

test("minified basic body: exact element spans + scalar field spans", () => {
    const body = '{"model":"gpt-x","stream":false,"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"yo"}]}';
    const r = scanMessagesSpans(body, ["model", "stream"]);
    assert.ok(r);
    assert.equal(r.total, 2);
    assert.equal(slice(body, r, 0), '{"role":"user","content":"hi"}');
    assert.equal(slice(body, r, 1), '{"role":"assistant","content":"yo"}');
    assert.equal(body.slice(r.fieldSpans.get("model")!.start, r.fieldSpans.get("model")!.end), '"gpt-x"');
    assert.equal(body.slice(r.fieldSpans.get("stream")!.start, r.fieldSpans.get("stream")!.end), "false");
});

test("pretty-printed body with whitespace between elements", () => {
    const body = '{\n  "messages": [\n    {"role":"user","content":"a"},\n\n    {"role":"assistant","content":"b"}\n  ],\n  "model": "m"\n}';
    const r = scanMessagesSpans(body);
    assert.ok(r);
    assert.equal(r.total, 2);
    assert.equal(slice(body, r, 0), '{"role":"user","content":"a"}');
    assert.equal(slice(body, r, 1), '{"role":"assistant","content":"b"}');
});

test("strings containing brackets, braces, quotes, escapes", () => {
    const inner = "a\"b{c}[d]\\\" e/f\\g\nh\ti\u003chtml\u003e🔥}]},\"role\":\"x\",[]}";
    const enc = JSON.stringify(inner);
    const body = `{"messages":[{"role":"user","content":${enc}},{"k":1}]}`;
    const r = scanMessagesSpans(body);
    assert.ok(r);
    assert.equal(r.total, 2);
    assert.equal(slice(body, r, 0), `{"role":"user","content":${enc}}`);
    assert.equal(slice(body, r, 1), `{"k":1}`);
    // explicit \u escapes only
    const escBody = '{"messages":[{"content":"\\u003c\\ud83d\\ude00\\\\x"}]}';
    const r2 = scanMessagesSpans(escBody);
    assert.ok(r2);
    assert.equal(r2.total, 1);
    assert.equal(slice(escBody, r2, 0), '{"content":"\\u003c\\ud83d\\ude00\\\\x"}');
});

test("nested tool_calls with escaped argument JSON", () => {
    const body = '{"messages":[{"role":"assistant","tool_calls":[{"id":"call_1","function":{"name":"f","arguments":"{\\"k\\":[1,2]}"}}]},{"role":"tool","tool_call_id":"call_1","content":"ok"}]}';
    const r = scanMessagesSpans(body);
    assert.ok(r);
    assert.equal(r.total, 2);
    assert.ok(slice(body, r, 0).includes('"name":"f"'));
    assert.equal(slice(body, r, 1), '{"role":"tool","tool_call_id":"call_1","content":"ok"}');
});

test("extra scalar shapes: floats, negatives, exponents, null values", () => {
    const body = '{"temperature":0.7,"top_p":-2,"max_completion_tokens":1e5,"stop":null,"messages":[{"a":1}]}';
    const r = scanMessagesSpans(body, ["temperature", "top_p", "max_completion_tokens", "stop"]);
    assert.ok(r);
    assert.equal(slice(body, r, 0), '{"a":1}');
    assert.equal(JSON.parse(body.slice(r.fieldSpans.get("temperature")!.start, r.fieldSpans.get("temperature")!.end)), 0.7);
    assert.equal(JSON.parse(body.slice(r.fieldSpans.get("top_p")!.start, r.fieldSpans.get("top_p")!.end)), -2);
    assert.equal(JSON.parse(body.slice(r.fieldSpans.get("max_completion_tokens")!.start, r.fieldSpans.get("max_completion_tokens")!.end)), 1e5);
    assert.equal(JSON.parse(body.slice(r.fieldSpans.get("stop")!.start, r.fieldSpans.get("stop")!.end)), null);
});

test("tools array value span covers the whole nested array", () => {
    const body = '{"tools":[{"type":"function","function":{"name":"t1","parameters":{"type":"object"}}},{"type":"function","function":{"name":"t2"}}],"messages":[{"x":1}]}';
    const r = scanMessagesSpans(body, ["tools"]);
    assert.ok(r);
    const span = r.fieldSpans.get("tools")!;
    const parsedTools = JSON.parse(body.slice(span.start, span.end));
    assert.equal(parsedTools.length, 2);
    assert.equal(parsedTools[1].function.name, "t2");
});

test("empty messages array is a valid scan with total 0", () => {
    const r = scanMessagesSpans('{"messages":[]}');
    assert.ok(r);
    assert.equal(r.total, 0);
});

test("non-object element kinds are counted and spanned verbatim", () => {
    const body = '{"messages":[1,"str",true,null,{"a":1}]}';
    const r = scanMessagesSpans(body);
    assert.ok(r);
    assert.equal(r.total, 5);
    assert.equal(slice(body, r, 0), "1");
    assert.equal(slice(body, r, 1), '"str"');
    assert.equal(slice(body, r, 2), "true");
    assert.equal(slice(body, r, 3), "null");
    assert.equal(slice(body, r, 4), '{"a":1}');
});

test("surrogate pairs and CJK inside strings keep code-unit slicing intact", () => {
    const emoji = "🔥";
    const body = `{"messages":[{"role":"user","content":"🔥中文\\ud83d\\ude00 mix"},{"role":"assistant","content":"${emoji} tail"}]}`;
    const r = scanMessagesSpans(body);
    assert.ok(r);
    assert.equal(r.total, 2);
    assert.equal(slice(body, r, 0), `{"role":"user","content":"🔥中文\\ud83d\\ude00 mix"}`);
    assert.equal(slice(body, r, 1), `{"role":"assistant","content":"${emoji} tail"}`);
});

test("duplicate top-level keys: last one wins (JSON.parse semantics)", () => {
    const body = '{"messages":[{"old":1}],"messages":[{"new":1},{"new":2}],"model":"late"}';
    const r = scanMessagesSpans(body, ["model"]);
    assert.ok(r);
    assert.equal(r.total, 2);
    assert.equal(slice(body, r, 0), '{"new":1}');
    assert.equal(body.slice(r.fieldSpans.get("model")!.start, r.fieldSpans.get("model")!.end), '"late"');
});

test("messages first among keys, other keys after", () => {
    const body = '{"messages":[{"a":1}],"stream":true,"model":"m"}';
    const r = scanMessagesSpans(body, ["stream", "model"]);
    assert.ok(r);
    assert.equal(r.total, 1);
    assert.equal(body.slice(r.fieldSpans.get("stream")!.start, r.fieldSpans.get("stream")!.end), "true");
});

test("trailing whitespace/newline after the root object is fine", () => {
    const r = scanMessagesSpans('{"messages":[{"a":1}]}\n\n  ');
    assert.ok(r);
    assert.equal(r.total, 1);
});

test("rejects malformed bodies (all return null, never throw)", () => {
    const cases: Array<[string, unknown]> = [
        ["empty", ""],
        ["whitespace only", "   \n"],
        ["root array", "[1,2]"],
        ["root null", "null"],
        ["missing messages", '{"model":"m"}'],
        ["messages not array (object)", '{"messages":{"a":1}}'],
        ["messages not array (string)", '{"messages":"hi"}'],
        ["unterminated string", '{"messages":[{"content":"abc}]}'],
        ["bad escape", '{"messages":[{"content":"\\q"}]}'],
        ["bad unicode escape", '{"messages":[{"content":"\\uZZZZ"}]}'],
        ["raw control char in string", '{"messages":[{"content":"a\nb"}]}'],
        ["single quotes", "{'messages':[{'a':1}]}"],
        ["bare token key", '{messages:[1]}'],
        ["trailing comma object", '{"messages":[{"a":1,}]}'],
        ["trailing comma array", '{"messages":[{} ,]}'],
        ["leading plus number", '{"messages":[{"a":+1}]}'],
        ["dot-leading number", '{"messages":[{"a":.5}]}'],
        ["number then dot", '{"messages":[{"a":1.}]}'],
        ["Infinity", '{"messages":[{"a":Infinity}]}'],
        ["NaN", '{"messages":[{"a":NaN}]}'],
        ["truncated mid object", '{"messages":[{"role":"user"}'],
        ["truncated mid array", '{"messages":[1,2'],
        ["garbage after root", '{"messages":[]} x'],
        ["two roots", '{"messages":[]}{ }'],
        ["nested colon junk", '{"messages":{"a::":1}}'],
        ["dangling backslash at eof", '{"messages":[{"content":"ab\\'],
        [">", "{}x"],
    ];
    for (const [name, b] of cases) {
        assert.equal(scanMessagesSpans(b as string), null, name);
    }
});

test("exceeding the nesting cap returns null instead of blowing the stack", () => {
    let deep = '{"messages":[{"a":';
    for (let d = 0; d < 1500; d++) deep += "[";
    deep += "1";
    for (let d = 0; d < 1500; d++) deep += "]";
    deep += "}]}";
    assert.equal(scanMessagesSpans(deep), null);
    // Sanity: below the cap it still scans.
    let ok = '{"messages":[{"a":';
    for (let d = 0; d < 100; d++) ok += "[";
    ok += "1";
    for (let d = 0; d < 100; d++) ok += "]";
    ok += "}]}";
    assert.ok(scanMessagesSpans(ok));
});

test("scale: 50k elements (~15 MiB) scanned with correct spot-checkable spans", () => {
    const parts: string[] = [];
    const totalParts = 50_000;
    for (let m = 0; m < totalParts; m++) {
        const one = `msg-${m}-`.repeat(3);
        parts.push(`{"role":"user","content":"${one}"}`);
    }
    const body = `{"messages":[${parts.join(",")}],"model":"scale-test"}`;
    const t0 = Date.now();
    const r = scanMessagesSpans(body, ["model"]);
    const ms = Date.now() - t0;
    assert.ok(r);
    assert.equal(r.total, totalParts);
    assert.equal(slice(body, r, 0), parts[0]);
    assert.equal(slice(body, r, 25_000), parts[25_000]);
    assert.equal(slice(body, r, totalParts - 1), parts[totalParts - 1]);
    assert.equal(body.slice(r.fieldSpans.get("model")!.start, r.fieldSpans.get("model")!.end), '"scale-test"');
    assert.ok(ms < 15_000, `scan took ${ms}ms`);
});

test("fieldSpans only contains requested keys", () => {
    const body = '{"model":"m","stream":true,"messages":[{"a":1}]}';
    const r = scanMessagesSpans(body, ["model"]);
    assert.ok(r);
    assert.deepEqual([...r.fieldSpans.keys()], ["model"]);
});
