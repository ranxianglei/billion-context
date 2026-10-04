// #2048 display-only advisor: config parsing, locale resolution, per-protocol
// visible-text extraction (thinking/reasoning excluded), the per-session store
// (seq/dedupe/TTL), and fireAdvisor against a hermetic mock upstream
// (success, HTTP error, timeout, minChars gate, dedupe, separate-route auth).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { CoreMessage } from "acp-kernel";
import { advisorEntryFor, advisorFail, advisorMarkFiring, advisorResetForTests, advisorSettle, buildAdvisorInput, buildAdvisorSystemPrompt, createAssistantTextTapper, extractAssistantTextFromJson, fireAdvisor, lastUserText, recordUpstreamAuth, resolveAdvisorLocale } from "../src/advisor.ts";
import { parseAdvisorSettings } from "../src/config.ts";
import type { AdvisorSettings } from "../src/config.ts";

const LOG = () => {};
const settings = (over: Partial<AdvisorSettings> = {}): AdvisorSettings => ({ enabled: true, model: "cheap-model", locale: "auto", minChars: 1, ...over });
const LONG_TEXT = `The bug is in the retry loop: the cursor is advanced BEFORE the write, so a failed write loses its row forever. Fix: advance after commit. Also see src/cache-ledger.ts:120.`;

test("parseAdvisorSettings: absent/disabled → undefined", () => {
    assert.equal(parseAdvisorSettings(undefined), undefined);
    assert.equal(parseAdvisorSettings(null), undefined);
    assert.equal(parseAdvisorSettings({ enabled: false }), undefined);
});

test("parseAdvisorSettings: loud on malformed input", () => {
    assert.throws(() => parseAdvisorSettings("on"), /advisor must be an object/);
    assert.throws(() => parseAdvisorSettings([1]), /advisor must be an object/);
    assert.throws(() => parseAdvisorSettings({ enabled: true }), /requires advisor\.model/);
    assert.throws(() => parseAdvisorSettings({ enabled: true, model: "  " }), /requires advisor\.model/);
    assert.throws(() => parseAdvisorSettings({ enabled: true, model: "m", route: "" }), /route must be a non-empty string/);
    assert.throws(() => parseAdvisorSettings({ enabled: true, model: "m", locale: 5 }), /locale must be a non-empty string/);
    assert.throws(() => parseAdvisorSettings({ enabled: true, model: "m", minChars: -1 }), /minChars must be a non-negative integer/);
    assert.throws(() => parseAdvisorSettings({ enabled: true, model: "m", minChars: 2.5 }), /minChars must be a non-negative integer/);
});

test("parseAdvisorSettings: defaults + passthrough + unknown fields warn not throw", () => {
    const d = parseAdvisorSettings({ enabled: true, model: "m" });
    assert.deepEqual(d, { enabled: true, model: "m", locale: "auto", minChars: 80 });
    const f = parseAdvisorSettings({ enabled: true, model: " m ", route: " https://x/v1 ", locale: "ja-JP", minChars: 0, bogus: 1 });
    assert.deepEqual(f, { enabled: true, route: "https://x/v1", model: "m", locale: "ja-JP", minChars: 0 });
});

test("resolveAdvisorLocale: auto CJK heuristic + explicit passthrough", () => {
    assert.equal(resolveAdvisorLocale("auto", "请帮我看看这个 bug 为什么报错"), "zh-CN");
    assert.equal(resolveAdvisorLocale("auto", "please explain this error to me"), "en");
    assert.equal(resolveAdvisorLocale("auto", "ab中"), "zh-CN"); // 1/3 ≥ 0.3
    assert.equal(resolveAdvisorLocale("auto", "abc中"), "en");   // 1/4 < 0.3
    assert.equal(resolveAdvisorLocale("auto", undefined), "zh-CN");
    assert.equal(resolveAdvisorLocale("fr-FR", "anything"), "fr-FR");
});

test("buildAdvisorInput: caps long inputs, keeps short ones byte-exact", () => {
    assert.equal(buildAdvisorInput("q", LONG_TEXT), `Question:\nq\n\nAnswer:\n${LONG_TEXT}`);
    assert.equal(buildAdvisorInput(undefined, LONG_TEXT), `Answer:\n${LONG_TEXT}`);
    const bigUser = "u".repeat(5000);
    const bigAns = "a".repeat(30000);
    const out = buildAdvisorInput(bigUser, bigAns);
    assert.ok(out.includes("[truncated]"));
    assert.ok(!out.includes(bigUser));
    assert.ok(!out.includes(bigAns.slice(0, 29999) + "a"));
});

test("buildAdvisorSystemPrompt carries the #1039 byte-exact discipline", () => {
    const zh = buildAdvisorSystemPrompt("zh-CN");
    assert.ok(zh.includes("BYTE-EXACT"));
    assert.ok(zh.includes("中文"));
    assert.ok(buildAdvisorSystemPrompt("de-DE").includes("de-DE"));
});

test("lastUserText: newest user text message only", () => {
    const msgs: CoreMessage[] = [
        { id: "m00001", role: "user", contentType: "text", text: "first question" },
        { id: "m00002", role: "assistant", contentType: "text", text: "answer" },
        { id: "m00003", role: "user", contentType: "tool-result", text: "tool output" },
        { id: "m00004", role: "user", contentType: "text", text: "  " },
        { id: "m00005", role: "user", contentType: "text", text: "latest real question" },
    ];
    assert.equal(lastUserText(msgs), "latest real question");
    assert.equal(lastUserText(msgs.slice(0, 1)), "first question");
    assert.equal(lastUserText([]), undefined);
});

function sse(obj: unknown): string { return `data: ${JSON.stringify(obj)}\n\n`; }

test("tapper openai: accumulates delta content, ignores [DONE]/non-JSON, survives split frames", async () => {
    const t = createAssistantTextTapper("openai");
    t.feed(sse({ choices: [{ delta: { content: "Hel" } }] }) + ": keep-alive\n\n");
    t.feed(sse({ choices: [{ delta: { content: "lo" } }] }).slice(0, 20));
    t.feed(sse({ choices: [{ delta: { content: "lo" } }] }).slice(20) + "data: [DONE]\n\n");
    t.end();
    await t.settle();
    assert.equal(t.text(), "Hello");
});

test("tapper anthropic: text_delta only — thinking_delta excluded", async () => {
    const t = createAssistantTextTapper("anthropic");
    t.feed(sse({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
    t.feed(sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "SECRET REASONING" } }));
    t.feed(sse({ type: "content_block_start", index: 1, content_block: { type: "text" } }));
    t.feed(sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Visible" } }));
    t.feed(sse({ type: "message_stop" }));
    t.end();
    await t.settle();
    assert.equal(t.text(), "Visible");
    assert.ok(!t.text().includes("SECRET"));
});

test("tapper responses: output_text.delta only", async () => {
    const t = createAssistantTextTapper("responses");
    t.feed(sse({ type: "response.output_item.added", item: { type: "message" } }));
    t.feed(sse({ type: "response.output_text.delta", delta: "Part " }));
    t.feed(sse({ type: "response.output_text.delta", delta: "one" }));
    t.feed(sse({ type: "response.completed", response: {} }));
    t.end();
    await t.settle();
    assert.equal(t.text(), "Part one");
});

test("tapper google: non-thought parts only", async () => {
    const t = createAssistantTextTapper("google");
    t.feed(sse({ candidates: [{ content: { parts: [{ text: "THINK", thought: true }, { text: "Real" }] } }] }));
    t.end();
    await t.settle();
    assert.equal(t.text(), "Real");
});

test("tapper attach mode: pumps a tee'd stream copy", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "A" } }] })));
            c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "B" } }] })));
            c.close();
        },
    });
    const t = createAssistantTextTapper("openai");
    t.attach(stream);
    await t.settle();
    assert.equal(t.text(), "AB");
});

test("extractAssistantTextFromJson: all four protocols, thinking excluded", () => {
    assert.equal(extractAssistantTextFromJson("openai", { choices: [{ message: { content: "hi" } }] }), "hi");
    assert.equal(extractAssistantTextFromJson("openai", { choices: [{ message: { content: [{ type: "text", text: "x" }, { type: "image_url", image_url: {} }] } }] }), "x");
    assert.equal(extractAssistantTextFromJson("anthropic", { content: [{ type: "thinking", thinking: "S" }, { type: "text", text: "T" }] }), "T");
    assert.equal(extractAssistantTextFromJson("responses", { output: [{ type: "function_call" }, { type: "message", content: [{ type: "output_text", text: "R" }, { type: "refusal", refusal: "" }] }] }), "R");
    assert.equal(extractAssistantTextFromJson("google", { candidates: [{ content: { parts: [{ text: "G", thought: false }, { text: "H", thought: true }] } }] }), "G");
    assert.equal(extractAssistantTextFromJson("openai", null), "");
});

test("store: seq monotonic, hash dedupe, stale settle no-op, failed reads none", () => {
    advisorResetForTests();
    assert.deepEqual(advisorEntryFor("s1"), { status: "none" });
    assert.equal(advisorMarkFiring("s1", "h1"), 1);
    assert.deepEqual(advisorEntryFor("s1"), { status: "pending" });
    assert.equal(advisorMarkFiring("s1", "h1"), 0); // identical pending text → skip
    assert.equal(advisorMarkFiring("s1", "h2"), 2);
    advisorSettle("s1", 1, ["stale"]); // stale generation must not land
    assert.deepEqual(advisorEntryFor("s1"), { status: "pending" });
    advisorSettle("s1", 2, ["line-a", "line-b"]);
    assert.deepEqual(advisorEntryFor("s1"), { status: "ready", seq: 2, lines: ["line-a", "line-b"] });
    advisorFail("s1", 2);
    assert.deepEqual(advisorEntryFor("s1"), { status: "none" });
    assert.equal(advisorMarkFiring("s1", "h2"), 3); // failed state re-fires even same hash
    advisorResetForTests();
});

test("store: TTL expiry reads none and prunes", () => {
    advisorResetForTests();
    const realNow = Date.now;
    try {
        advisorMarkFiring("ttl", "hx");
        Date.now = () => realNow() + 31 * 60_000;
        assert.deepEqual(advisorEntryFor("ttl"), { status: "none" });
        Date.now = () => realNow();
        assert.deepEqual(advisorEntryFor("ttl"), { status: "none" }); // pruned, not resurrected
    } finally {
        Date.now = realNow;
        advisorResetForTests();
    }
});

type MockRequest = { url: string; headers: http.IncomingHttpHeaders; body?: unknown };

interface MockUpstream {
    base: string;
    requests: MockRequest[];
    close(): Promise<void>;
}

function startMock(responder: (req: MockRequest, res: http.ServerResponse) => void): Promise<{ mock: MockUpstream }> {
    const requests: MockRequest[] = [];
    const server = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            const r: MockRequest = { url: req.url ?? "", headers: req.headers, body: b ? JSON.parse(b) : undefined };
            requests.push(r);
            responder(r, res);
        });
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        mock: {
            base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            get requests() { return requests; },
            close: () => new Promise<void>((resolve) => server.close(() => resolve())),
        },
    }));
}

function okOpenai(res: http.ServerResponse, text: string): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
}

test("fireAdvisor: same-endpoint success swaps model, rides captured client auth", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock((_r, res) => okOpenai(res, "简单说：游标在写入前就前进了，失败的那行就丢了。修复：提交后再前进。"));
    await fireAdvisor({
        sessionId: "f1",
        protocol: "openai",
        assistantText: LONG_TEXT,
        lastUserText: "为什么重试会丢数据？",
        settings: settings(),
        routes: {},
        mainUpstreamUrl: `${mock.base}/v1/chat/completions`,
        mainHeaders: { authorization: "Bearer MAIN-KEY", "content-type": "application/json" },
        log: LOG,
    });
    const entry = advisorEntryFor("f1");
    assert.equal(entry.status, "ready");
    if (entry.status !== "ready") throw new Error("unreachable");
    assert.equal(entry.lines.length, 1);
    assert.match(entry.lines[0], /游标/);
    assert.equal(mock.requests.length, 1);
    const r = mock.requests[0];
    assert.equal(r.url, "/v1/chat/completions");
    assert.equal(r.headers.authorization, "Bearer MAIN-KEY");
    const body = r.body as Record<string, any>;
    assert.equal(body.model, "cheap-model");
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 1500);
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /BYTE-EXACT/);
    assert.match(body.messages[1].content, /Question:\n为什么重试会丢数据？/);
    await mock.close();
});

test("fireAdvisor: minChars gate skips trivial replies without any request", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock(() => {});
    await fireAdvisor({
        sessionId: "f2", protocol: "openai", assistantText: "ok.", lastUserText: "q",
        settings: settings({ minChars: 80 }), routes: {},
        mainUpstreamUrl: `${mock.base}/v1/chat/completions`, mainHeaders: {}, log: LOG,
    });
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(advisorEntryFor("f2"), { status: "none" });
    await mock.close();
});

test("fireAdvisor: identical text dedupes to one call", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock((_r, res) => okOpenai(res, "rendered"));
    const ctx = {
        sessionId: "f3", protocol: "openai" as const, assistantText: LONG_TEXT, lastUserText: "q",
        settings: settings(), routes: {},
        mainUpstreamUrl: `${mock.base}/v1/chat/completions`, mainHeaders: {}, log: LOG,
    };
    await fireAdvisor(ctx);
    await fireAdvisor(ctx);
    assert.equal(mock.requests.length, 1);
    await mock.close();
});

test("fireAdvisor: HTTP 500 fails open (no throw, entry none)", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock((_r, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end("{}");
    });
    await fireAdvisor({
        sessionId: "f4", protocol: "openai", assistantText: LONG_TEXT,
        settings: settings(), routes: {},
        mainUpstreamUrl: `${mock.base}/v1/chat/completions`, mainHeaders: {}, log: LOG,
    });
    assert.deepEqual(advisorEntryFor("f4"), { status: "none" });
    await mock.close();
});

test("fireAdvisor: hung upstream times out and fails open", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock(() => { /* never respond */ });
    await fireAdvisor({
        sessionId: "f5", protocol: "openai", assistantText: LONG_TEXT,
        settings: settings(), routes: {},
        mainUpstreamUrl: `${mock.base}/v1/chat/completions`, mainHeaders: {}, log: LOG,
        timeoutMs: 150,
    });
    assert.deepEqual(advisorEntryFor("f5"), { status: "none" });
    await mock.close();
});

test("fireAdvisor: separate route without observed credentials → no call, fail-open", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock(() => {});
    const route = `${mock.base}/cheap`;
    const logs: string[] = [];
    await fireAdvisor({
        sessionId: "f6", protocol: "openai", assistantText: LONG_TEXT,
        settings: settings({ route }), routes: { [route]: {} },
        mainUpstreamUrl: `${mock.base}/main/chat`, mainHeaders: { authorization: "Bearer OTHER" },
        log: (_l, m) => logs.push(m),
    });
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(advisorEntryFor("f6"), { status: "none" });
    assert.match(logs.join("\n"), /no credentials observed yet/);
    await mock.close();
});

test("fireAdvisor: separate route with captured credentials retargets path + header", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock((_r, res) => okOpenai(res, "rendered via cheap"));
    const route = `${mock.base}/cheap`;
    recordUpstreamAuth(`${route}/seen-before`, { "x-api-key": "CHEAP-KEY" });
    await fireAdvisor({
        sessionId: "f7", protocol: "openai", assistantText: LONG_TEXT,
        settings: settings({ route }), routes: { [route]: {} },
        mainUpstreamUrl: `${mock.base}/main/chat/completions`, mainHeaders: { authorization: "Bearer MAIN" },
        log: LOG,
    });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].url, "/cheap/main/chat/completions");
    assert.equal(mock.requests[0].headers["x-api-key"], "CHEAP-KEY");
    assert.notEqual(mock.requests[0].headers.authorization, "Bearer MAIN");
    const entry = advisorEntryFor("f7");
    assert.equal(entry.status, "ready");
    await mock.close();
});

test("fireAdvisor: route declaring a different protocol → suppressed, no call", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock(() => {});
    const route = `${mock.base}/anthro`;
    recordUpstreamAuth(`${route}/x`, { authorization: "Bearer X" });
    const logs: string[] = [];
    await fireAdvisor({
        sessionId: "f8", protocol: "openai", assistantText: LONG_TEXT,
        settings: settings({ route }), routes: { [route]: { protocol: "anthropic" } },
        mainUpstreamUrl: `${mock.base}/main/chat`, mainHeaders: {},
        log: (_l, m) => logs.push(m),
    });
    assert.equal(mock.requests.length, 0);
    assert.match(logs.join("\n"), /declares protocol/);
    await mock.close();
});

test("fireAdvisor: empty rendered response fails open", async (t) => {
    t.after(() => advisorResetForTests());
    const { mock } = await startMock((_r, res) => okOpenai(res, "   "));
    await fireAdvisor({
        sessionId: "f9", protocol: "openai", assistantText: LONG_TEXT,
        settings: settings(), routes: {},
        mainUpstreamUrl: `${mock.base}/v1/chat/completions`, mainHeaders: {}, log: LOG,
    });
    assert.deepEqual(advisorEntryFor("f9"), { status: "none" });
    await mock.close();
});

test("recordUpstreamAuth: cap evicts oldest, refresh re-anchors, prefix lookup matches", async (t) => {
    t.after(() => advisorResetForTests());
    // 40 distinct upstream bases + one keyless capture: the cap (32) must have
    // evicted h0..h7 by now. Refreshing h0 re-anchors it as newest; h1 stays evicted.
    recordUpstreamAuth("https://a.example/v1/x", {});
    for (let i = 0; i < 40; i++) recordUpstreamAuth(`https://h${i}.example/v1/chat`, { authorization: `B ${i}` });
    recordUpstreamAuth("https://h0.example/v1/chat", { authorization: "REFRESHED" });
    const mkLogs = () => { const out: string[] = []; return { push: (m: string) => out.push(m), join: (s: string) => out.join(s) }; };
    // h1 (evicted): no credentials observed → panel suppressed BEFORE any fetch.
    const logs1 = mkLogs();
    await fireAdvisor({
        sessionId: "cap1", protocol: "openai", assistantText: LONG_TEXT,
        settings: settings({ route: "https://h1.example/v1" }), routes: { "https://h1.example/v1": {} },
        mainUpstreamUrl: "https://h1.example/v1/chat/completions", mainHeaders: {}, log: (_l, m) => logs1.push(m),
    });
    assert.match(logs1.join("\n"), /no credentials observed yet/);
    // h0 (refreshed): credentials found → proceeds to fetch (DNS fails here,
    // which is fine — the point is the lookup SUCCEEDED).
    const logs0 = mkLogs();
    await fireAdvisor({
        sessionId: "cap2", protocol: "openai", assistantText: LONG_TEXT,
        settings: settings({ route: "https://h0.example/v1" }), routes: { "https://h0.example/v1": {} },
        mainUpstreamUrl: "https://h0.example/v1/chat/completions", mainHeaders: {}, log: (_l, m) => logs0.push(m),
    });
    assert.ok(!logs0.join("\n").includes("no credentials observed yet"));
    assert.match(logs0.join("\n"), /advisor call failed/);
});
