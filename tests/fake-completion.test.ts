import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// The fake-completion fallback is opt-in (disabled by default to preserve
// incremental streaming); these tests exercise it, so enable it explicitly.
process.env.BILI_FAKE_COMPLETION_RETRIES = "2";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { applyCompatRoles } from "../src/compat-roles.ts";
import {
    isFakeCompletion,
    hasToolBlock,
    hasToolCallStructure,
    injectFakeCompletionHint,
} from "../src/fake-completion.ts";

// Hex escapes so no literal tag sequence appears in this file's source.
const LT = "\x3c";
const GT = "\x3e";

// First tokens of the corrective hint (FAKE_COMPLETION_HINT in src/fake-completion.ts).
const HINT_MARK = "[billion-context]";

// The #361 shape: the model echoed a tool call as TEXT — an opening invoke
// plus closing tags — with no real tool block. A distinctive marker lets the
// integration tests prove this text is discarded on retry.
const FAKE_XML = `${LT}invoke name="read_file"${GT}\n${LT}parameter name="path"${GT}/fake/completion/marker${LT}/parameter${GT}\n${LT}/invoke${GT}\n${LT}/tool_calls${GT}`;

test("hasToolBlock: anthropic detects a tool_use block", () => {
    assert.equal(hasToolBlock("anthropic", '{"type":"tool_use","name":"x"}'), true);
    assert.equal(hasToolBlock("anthropic", '{"type":"text","text":"hi"}'), false);
});

test("hasToolBlock: openai detects a non-empty tool_calls array", () => {
    assert.equal(hasToolBlock("openai", '{"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}'), true);
    assert.equal(hasToolBlock("openai", '{"choices":[{"delta":{"content":"hi"}}]}'), false);
});

test("hasToolBlock: responses detects a function_call item", () => {
    assert.equal(hasToolBlock("responses", '{"type":"function_call","name":"x"}'), true);
    assert.equal(hasToolBlock("responses", '{"type":"message"}'), false);
});

test("hasToolCallStructure: an opening tool tag is a structure", () => {
    assert.equal(hasToolCallStructure(`${LT}invoke name="x"${GT}`), true);
});

test("hasToolCallStructure: two distinct closing tags (the #361 shape) is a structure", () => {
    assert.equal(hasToolCallStructure(`${LT}/invoke${GT} ${LT}/tool_calls${GT}`), true);
});

test("hasToolCallStructure: a single closing tag is NOT a structure (legit prose)", () => {
    assert.equal(hasToolCallStructure(`the ${LT}/invoke${GT} tag closes a call`), false);
});

test("hasToolCallStructure: plain text with no tool XML is not a structure", () => {
    assert.equal(hasToolCallStructure("just plain text about tools"), false);
});

// #2348: a runaway tool-call ENUMERATION (incident B: 97KB response, 3 openers,
// 8745 closers) used to read as a structurally complete call — one opener
// short-circuits, thousands of closer pairs satisfy the >=2 rule. A genuine
// fake completion carries a handful of calls, so a scale gate distinguishes
// the two without touching any legit shape.
test("hasToolCallStructure: a runaway close flood is NOT a structure (#2348)", () => {
    const flood = `${LT}antml:invoke name="runaway"${GT}` +
        Array.from({ length: 60 }, () => `${LT}parameter x="1"${GT}${LT}/parameter${GT}${LT}/invoke${GT}${LT}invoke${GT}`).join("");
    assert.ok(flood.length > 2000, "fixture must actually be a flood");
    assert.equal(hasToolCallStructure(flood), false);
});

test("hasToolCallStructure: close-count boundary pins the scale gate at 32 (#2348)", () => {
    const pair = `${LT}/parameter${GT}${LT}/invoke${GT}`;
    assert.equal(hasToolCallStructure(pair.repeat(16)), true, "32 closers is still a structure");
    assert.equal(hasToolCallStructure(pair.repeat(17)), false, "34 closers is a flood");
    assert.equal(hasToolCallStructure(`${LT}invoke${GT}` + pair.repeat(16)), true, "opener + 32 closers still short-circuits");
    assert.equal(hasToolCallStructure(`${LT}invoke${GT}` + pair.repeat(17)), false, "opener cannot rescue a flood");
});

test("isFakeCompletion: a runaway enumeration is NOT a fake completion (#2348)", () => {
    const flood = `${LT}antml:invoke name="x"${GT}` +
        Array.from({ length: 50 }, () => `${LT}parameter${GT}${LT}/parameter${GT}${LT}/invoke${GT}${LT}invoke${GT}`).join("");
    for (const protocol of ["anthropic", "openai", "responses"] as const) {
        assert.equal(isFakeCompletion(protocol, flood), false, protocol);
    }
});

test("isFakeCompletion: anthropic tool-XML with no tool_use block is a fake completion", () => {
    assert.equal(isFakeCompletion("anthropic", FAKE_XML), true);
});

test("isFakeCompletion: openai tool-XML with no tool_calls is a fake completion", () => {
    assert.equal(isFakeCompletion("openai", FAKE_XML), true);
});

test("isFakeCompletion: responses tool-XML with no function_call is a fake completion", () => {
    assert.equal(isFakeCompletion("responses", FAKE_XML), true);
});

test("isFakeCompletion: tool-XML WITH a real tool block is NOT a fake completion", () => {
    assert.equal(isFakeCompletion("anthropic", `${FAKE_XML} {"type":"tool_use"}`), false);
    assert.equal(isFakeCompletion("openai", `${FAKE_XML} "tool_calls":[{`), false);
    assert.equal(isFakeCompletion("responses", `${FAKE_XML} {"type":"function_call"}`), false);
});

test("isFakeCompletion: legit prose with a single closing tag is NOT a fake completion", () => {
    assert.equal(isFakeCompletion("anthropic", `the ${LT}/invoke${GT} tag closes a call`), false);
});

test("isFakeCompletion: plain text is not a fake completion", () => {
    assert.equal(isFakeCompletion("anthropic", "all done, nothing to do"), false);
});

test("injectFakeCompletionHint: anthropic merges the hint into the last user message", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] });
    const out = injectFakeCompletionHint("anthropic", body);
    assert.ok(out !== null);
    const parsed = JSON.parse(out!) as { messages: Array<{ role: string; content: string }> };
    assert.equal(parsed.messages.length, 1);
    assert.ok(parsed.messages[0]!.content.includes("hello"));
    assert.ok(parsed.messages[0]!.content.includes("tool-calling mechanism"));
});

test("injectFakeCompletionHint: anthropic appends a new user message when the last is assistant", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] });
    const out = injectFakeCompletionHint("anthropic", body);
    assert.ok(out !== null);
    const parsed = JSON.parse(out!) as { messages: Array<{ role: string; content: string }> };
    assert.equal(parsed.messages.length, 3);
    assert.equal(parsed.messages[2]!.role, "user");
    assert.ok(parsed.messages[2]!.content.includes("tool-calling mechanism"));
});

test("injectFakeCompletionHint: openai appends the hint to messages", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const out = injectFakeCompletionHint("openai", body);
    assert.ok(out !== null);
    const parsed = JSON.parse(out!) as { messages: Array<{ role: string; content: string }> };
    const last = parsed.messages[parsed.messages.length - 1]!;
    assert.equal(last.role, "user");
    assert.ok(last.content.includes("tool-calling mechanism"));
});

test("injectFakeCompletionHint: responses merges an input_text part into the last user input", () => {
    const body = JSON.stringify({ model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] });
    const out = injectFakeCompletionHint("responses", body);
    assert.ok(out !== null);
    const parsed = JSON.parse(out!) as { input: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
    const last = parsed.input[parsed.input.length - 1]!;
    const texts = last.content.map((c) => c.text ?? "").join("");
    assert.ok(texts.includes("hi"));
    assert.ok(texts.includes("tool-calling mechanism"));
});

test("injectFakeCompletionHint: returns null for an unparseable body", () => {
    assert.equal(injectFakeCompletionHint("anthropic", "not json"), null);
});

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: { body: string }[];
    close(): Promise<void>;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function startHarness(scripts: string[][], extra?: Partial<ProxyOptions>): Promise<Harness> {
    const captured: { body: string }[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ body: Buffer.concat(chunks).toString() });
            res.writeHead(200, { "content-type": "text/event-stream" });
            const script = scripts[Math.min(call, scripts.length - 1)]!;
            call += 1;
            for (const line of script) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    return (async () => {
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const proxy = await startServer({
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 }, "resp-test": { context: 400_000 } } } },
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        ...extra,
    } as ProxyOptions);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        return {
            proxyPort,
            upstreamPort,
            captured,
            close: async () => {
                proxy.close();
                proxy.closeIdleConnections?.();
                await once(proxy, "close");
                upstream.close();
                upstream.closeIdleConnections?.();
                await once(upstream, "close");
            },
        };
    })();
}

async function callAnthropic(h: Harness, session: string, messages: Array<{ role: string; content: string }>): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, system: "You are a test assistant.", messages }),
    });
    assert.equal(resp.status, 200);
    let raw = "";
    for await (const chunk of resp.body!) raw += Buffer.from(chunk).toString("utf8");
    return raw;
}

// The #1900 scenarios run on the Responses wire: unlike the OpenAI chat
// adapter (whose prepare pass normalizes developer→system before the wire),
// Responses carries the client's `developer` role verbatim (codex's native
// shape) — so only here can a compat-role rewrite or a learned mid-request
// hop actually change the outbound bytes the hinted retry must preserve.
function responsesSse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function responsesFakeScript(): string[] {
    return [
        responsesSse({ type: "response.output_item.added", output_index: 0, item: { id: "msg_fc_f", type: "message", status: "in_progress", role: "assistant", content: [] } }),
        responsesSse({ type: "response.output_text.delta", item_id: "msg_fc_f", output_index: 0, content_index: 0, delta: FAKE_XML }),
        responsesSse({ type: "response.completed", response: { id: "resp_fc_f", status: "completed" } }),
    ];
}

function responsesRealScript(): string[] {
    return [
        responsesSse({ type: "response.output_item.added", output_index: 0, item: { id: "fc_call_1", type: "function_call", status: "in_progress", name: "real_tool_ok", arguments: "" } }),
        responsesSse({ type: "response.function_call_arguments.done", item_id: "fc_call_1", output_index: 0, arguments: "{}" }),
        responsesSse({ type: "response.completed", response: { id: "resp_fc_r", status: "completed" } }),
    ];
}

async function callResponses(h: Harness, session: string, input: unknown[]): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "resp-test", stream: true, input }),
    });
    assert.equal(resp.status, 200);
    let raw = "";
    for await (const chunk of resp.body!) raw += Buffer.from(chunk).toString("utf8");
    return raw;
}

function fakeCompletionScript(): string[] {
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_fc_1", role: "assistant", usage: { input_tokens: 10 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: FAKE_XML } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

function realToolUseScript(): string[] {
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_fc_2", role: "assistant", usage: { input_tokens: 10 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fc_1", name: "read_file", input: {} } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"/foo"}' } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

test("e2e #371: fake completion triggers a retry that yields a real tool call", async () => {
    const h = await startHarness([fakeCompletionScript(), realToolUseScript()]);
    try {
        const raw = await callAnthropic(h, "fc-retry", [{ role: "user", content: "read the file" }]);
        assert.equal(h.captured.length, 2, `expected exactly 2 upstream requests (original + 1 retry), got ${h.captured.length}`);
        assert.ok(raw.includes('"type":"tool_use"'), "client should receive the real tool_use block from the retry");
        assert.ok(!raw.includes("/fake/completion/marker"), "the fake-completion text must not leak to the client");
    } finally {
        await h.close();
    }
});

test("e2e #371: retry cap — always-fake upstream exhausts retries, then the session streak blocks further retries", async () => {
    const h = await startHarness([fakeCompletionScript()]);
    try {
        await callAnthropic(h, "fc-cap", [{ role: "user", content: "t1" }]);
        assert.equal(h.captured.length, 3, `turn 1: expected 3 requests (1 + 2 retries), got ${h.captured.length}`);
        await callAnthropic(h, "fc-cap", [{ role: "user", content: "t2" }]);
        assert.equal(h.captured.length, 6, `turn 2: expected 6 total (1 + 2 retries), got ${h.captured.length}`);
        await callAnthropic(h, "fc-cap", [{ role: "user", content: "t3" }]);
        assert.equal(h.captured.length, 7, `turn 3: expected 7 total (streak cap blocks the retry), got ${h.captured.length}`);
    } finally {
        await h.close();
    }
});

test("e2e #371: legit prose with a single closing tag does NOT trigger a retry", async () => {
    const legitScript = [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_legit", role: "assistant", usage: { input_tokens: 10 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `The ${LT}/invoke${GT} tag closes a tool call in the template.` } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
    const h = await startHarness([legitScript]);
    try {
        const raw = await callAnthropic(h, "fc-legit", [{ role: "user", content: "explain the template" }]);
        assert.equal(h.captured.length, 1, `legit prose must NOT trigger a retry, got ${h.captured.length} requests`);
        assert.ok(raw.includes("closes a tool call"), "legit prose must pass through to the client");
    } finally {
        await h.close();
    }
});

test("e2e #1900: hinted retry derives from wire bytes — configured compat role rewrite survives into the retry", async () => {
    const h = await startHarness([responsesFakeScript(), responsesRealScript()], {
        compat: { roles: { developer: "system" } },
    });
    try {
        const raw = await callResponses(h, "fc-1900-roles", [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "you are terse" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "read the file" }] },
        ]);
        assert.equal(h.captured.length, 2, `expected original + 1 retry, got ${h.captured.length}`);
        assert.ok(h.captured[0]!.body.includes('"role":"system"'), "compat.roles applied developer→system on the main send");
        assert.ok(!h.captured[0]!.body.includes('"role":"developer"'), "main attempt carries the rewritten role");
        assert.ok(!h.captured[1]!.body.includes('"role":"developer"'), "#1900: hinted retry must NOT re-send the pre-rewrite role");
        assert.ok(h.captured[1]!.body.includes(HINT_MARK), "hint present in the retry");
        assert.ok(raw.includes("real_tool_ok"), "client received the recovered function_call");
        assert.ok(!raw.includes("/fake/completion/marker"), "fake-completion text must not leak to the client");
    } finally {
        await h.close();
    }
});

test("e2e #1900: role learned mid-request (400 → hop) — hinted retry carries the accepted role, not the rejected one", async () => {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const bodyText = Buffer.concat(chunks).toString("utf8");
            captured.push(bodyText);
            if (bodyText.includes('"role":"developer"')) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Invalid role: developer" } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            const script = bodyText.includes(HINT_MARK) ? responsesRealScript() : responsesFakeScript();
            for (const line of script) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "resp-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "fc-1900-learn" },
            body: JSON.stringify({ model: "resp-test", stream: true, input: [
                { type: "message", role: "developer", content: [{ type: "input_text", text: "you are terse" }] },
                { type: "message", role: "user", content: [{ type: "input_text", text: "read the file" }] },
            ] }),
        });
        assert.equal(resp.status, 200);
        let raw = "";
        for await (const chunk of resp.body!) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(captured.length, 3, `expected main + role-hop + hinted retry, got ${captured.length}`);
        assert.ok(captured[0]!.includes('"role":"developer"'), "main attempt sends the client's original role");
        assert.ok(!captured[1]!.includes('"role":"developer"'), "role hop rewrote developer→system before re-sending");
        assert.ok(!captured[2]!.includes('"role":"developer"'), "#1900: hinted retry must carry the hopped (accepted) role, not the rejected one");
        assert.ok(captured[2]!.includes(HINT_MARK), "hint present in the retry");
        assert.ok(raw.includes("real_tool_ok"), "client received the recovered function_call");
        assert.ok(!raw.includes("/fake/completion/marker"), "fake-completion text must not leak to the client");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("#1900 unit: injectFakeCompletionHint works on a compat-role-rewritten openai body", () => {
    const raw = JSON.stringify({ model: "m", messages: [
        { role: "developer", content: "sys" },
        { role: "user", content: "hi" },
    ] });
    const wire = applyCompatRoles(raw, "openai", { developer: "system" });
    assert.equal(wire.rewritten, true);
    const out = injectFakeCompletionHint("openai", wire.body);
    assert.ok(out !== null, "hint injection must handle the transformed openai shape");
    const parsed = JSON.parse(out!) as { messages: Array<{ role: string; content: string }> };
    assert.equal(parsed.messages[0]!.role, "system", "rewrite must survive hint injection");
    const last = parsed.messages[parsed.messages.length - 1]!;
    assert.equal(last.role, "user");
    assert.ok(last.content.includes("tool-calling mechanism"));
});

test("#1900 unit: injectFakeCompletionHint works on a compat-role-rewritten responses body", () => {
    const raw = JSON.stringify({ model: "m", input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "sys" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ] });
    const wire = applyCompatRoles(raw, "responses", { developer: "system" });
    assert.equal(wire.rewritten, true);
    const out = injectFakeCompletionHint("responses", wire.body);
    assert.ok(out !== null, "hint injection must handle the transformed responses shape");
    const parsed = JSON.parse(out!) as { input: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
    assert.equal(parsed.input[0]!.role, "system", "rewrite must survive hint injection");
    const last = parsed.input[parsed.input.length - 1]!;
    const texts = last.content.map((c) => c.text ?? "").join("");
    assert.ok(texts.includes("tool-calling mechanism"));
});
