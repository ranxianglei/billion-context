import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProviderRoutes, ProxyOptions } from "../src/config.ts";
import { resolveStrictReasoningEcho } from "../src/config.ts";
import { isStrictReasoningEcho } from "../src/strict-echo.ts";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { rmrf } from "./tmp-rm.ts";

// #5257: the static /deepseek/ MODEL-ID rule injected the blank
// reasoning_content echo for a Mistral-hosted deepseek-named model; Mistral
// rejects the field with 422 and its error never names the field, so the
// learned self-heal flag (which needs a 400 mentioning reasoning) could
// never rescue. Fix: providers.<url>.strictReasoningEcho /
// providers.<url>.models.<m>.strictReasoningEcho (model > provider) beat the
// static detection; the learned flag still outranks everything.

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const CLIENT_MESSAGES = [
    { role: "user", content: "what is the weather" },
    { role: "assistant", content: "let me check", reasoning_content: "thinking about it" },
    { role: "user", content: "and tomorrow?" },
    { role: "assistant", content: "", tool_calls: [{ id: "tc-c1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tc-c1", content: "sunny" },
    { role: "user", content: "great" },
];

const session = (): Session => ({ metadata: {}, stats: {} }) as unknown as Session;

test("#5257 unit: resolver precedence (model > provider > unset; route miss)", () => {
    const routes: ProviderRoutes = {
        "https://a.example.com": {
            strictReasoningEcho: true,
            models: { "opt-out-model": { strictReasoningEcho: false } },
        },
        "https://b.example.com": { strictReasoningEcho: false },
        "https://c.example.com": { models: { "deepseek-x": {} } },
    };
    // model-level beats provider-level (the #5257 shape: provider auto, one model opts out)
    assert.equal(resolveStrictReasoningEcho(routes, "https://a.example.com", "opt-out-model"), false);
    // provider-level applies to other models on the same route
    assert.equal(resolveStrictReasoningEcho(routes, "https://a.example.com", "other-model"), true);
    // provider-level only
    assert.equal(resolveStrictReasoningEcho(routes, "https://b.example.com", "anything"), false);
    // unset at both levels -> undefined (static detection unchanged)
    assert.equal(resolveStrictReasoningEcho(routes, "https://c.example.com", "deepseek-x"), undefined);
    // no matching route -> undefined
    assert.equal(resolveStrictReasoningEcho(routes, "https://unknown.example.com", "deepseek-x"), undefined);
    // missing model -> provider-level verdict still applies
    assert.equal(resolveStrictReasoningEcho(routes, "https://b.example.com"), false);
});

test("#5257 unit: verdict beats static detection, learned flag outranks verdict", () => {
    // static origin match — explicit false suppresses
    assert.equal(isStrictReasoningEcho(session(), "https://deepseek.com/v1", undefined, false), false);
    // static model-id match — explicit false suppresses (the #5257 culprit path)
    assert.equal(isStrictReasoningEcho(session(), "https://mistral.example.com", "deepseek-v4-1-flash", false), false);
    // explicit true forces the echo for a non-matching host+model
    assert.equal(isStrictReasoningEcho(session(), "https://example.com", "moonshot-v1", true), true);
    // undefined verdict = old behavior byte-identical
    assert.equal(isStrictReasoningEcho(session(), "https://deepseek.com/v1"), true);
    assert.equal(isStrictReasoningEcho(session(), "https://example.com", "deepseek-x"), true);
    assert.equal(isStrictReasoningEcho(session(), "https://example.com", "moonshot-v1"), false);
    // learned flag (real upstream 400 evidence) outranks an explicit false
    const learned = session();
    learned.metadata.strictReasoningEcho = true;
    assert.equal(isStrictReasoningEcho(learned, "https://mistral.example.com", "deepseek-v4-1-flash", false), true);
});

function makeUpstream(seenBodies: string[]): http.Server {
    return http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            seenBodies.push(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "cmpl-1",
                object: "chat.completion",
                created: 1,
                model: "deepseek-mistral-x",
                choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 2 },
            }));
        });
    });
}

async function startProxy(upstreamPort: number, models: Record<string, Record<string, unknown>> | undefined): Promise<{ proxy: http.Server; proxyPort: number }> {
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: models ? { [`http://127.0.0.1:${upstreamPort}`]: { models } } : {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        streamErrorShape: "protocol",
        passthroughSource: null,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await new Promise<void>((r) => proxy.on("listening", r));
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, proxyPort };
}

function tcC1(bodyText: string): Record<string, unknown> | undefined {
    const body = JSON.parse(bodyText) as { messages: Record<string, unknown>[] };
    return body.messages.find((m) => Array.isArray(m.tool_calls) && (m.tool_calls as Record<string, unknown>[])[0]?.id === "tc-c1");
}

async function postChat(proxyPort: number, upstreamPort: number, sessionName: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionName },
        body: JSON.stringify({ model: "deepseek-mistral-x", messages: CLIENT_MESSAGES }),
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text().catch(() => "")}`);
}

test("#5257 e2e: per-model strictReasoningEcho:false suppresses the injected echo", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5257-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    const seenBodies: string[] = [];
    const upstream = makeUpstream(seenBodies);
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { proxy, proxyPort } = await startProxy(upstreamPort, { "deepseek-mistral-x": { context: 400_000, strictReasoningEcho: false } });
    try {
        await postChat(proxyPort, upstreamPort, "5257-optout");
        const forwarded = seenBodies.filter((b) => b.includes("tc-c1"));
        assert.ok(forwarded.length >= 1, "the chat completion must be forwarded");
        for (const bodyText of forwarded) {
            const msg = tcC1(bodyText);
            assert.ok(msg, "tc-c1 assistant message must reach the upstream");
            // #5257: the injected blank reasoning_content must NOT be present —
            // the model id matches /deepseek/i, so WITHOUT the opt-out the
            // static rule would have injected it (control below).
            assert.equal("reasoning_content" in msg, false, `forwarded tc-c1 must not carry an injected reasoning_content: ${bodyText.slice(0, 200)}`);
        }
    } finally {
        await close(proxy);
        await close(upstream);
        _resetStoreForTest();
        process.env.XDG_STATE_HOME = undefined;
        rmrf(stateDir);
    }
});

test("#5257 e2e: without the opt-out the static /deepseek/ rule still injects (default pin)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5257-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    const seenBodies: string[] = [];
    const upstream = makeUpstream(seenBodies);
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    // Same model id, NO strictReasoningEcho entry — the #1027 static
    // model-id rule must keep injecting the blank echo.
    const { proxy, proxyPort } = await startProxy(upstreamPort, { "deepseek-mistral-x": { context: 400_000 } });
    try {
        await postChat(proxyPort, upstreamPort, "5257-default");
        const forwarded = seenBodies.filter((b) => b.includes("tc-c1"));
        assert.ok(forwarded.length >= 1, "the chat completion must be forwarded");
        const msg = tcC1(forwarded[forwarded.length - 1]);
        assert.ok(msg, "tc-c1 assistant message must reach the upstream");
        assert.equal(msg.reasoning_content, "", "the static rule must inject the blank echo when unconfigured");
    } finally {
        await close(proxy);
        await close(upstream);
        _resetStoreForTest();
        process.env.XDG_STATE_HOME = undefined;
        rmrf(stateDir);
    }
});

// #5257 (responses lane): the same operator verdict must reach the Responses
// wire's three isStrictReasoningEcho call sites too — otherwise a route opted
// out on the chat lane would still get the blank reasoning item injected on
// the codex/Responses lane. INPUT below carries one reasoning item (arms the
// gate) plus a tool-call run WITHOUT its reasoning item (the orphan run the
// static /deepseek/ rule repairs by injecting a blank item at the run start).
type RespItem = Record<string, unknown>;

const RESPONSES_INPUT: RespItem[] = [
    { type: "message", role: "user", content: "what is the weather" },
    { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "thinking about it" }] },
    { type: "message", role: "assistant", content: "let me check" },
    { type: "message", role: "user", content: "and tomorrow?" },
    { type: "function_call", call_id: "call-c1", name: "get_weather", arguments: "{}" },
    { type: "function_call_output", call_id: "call-c1", output: "sunny" },
    { type: "message", role: "assistant", content: "sunny tomorrow too" },
];

function sse(type: string, obj: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

function makeResponsesUpstream(seenBodies: string[]): http.Server {
    return http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            seenBodies.push(b);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(sse("response.created", { type: "response.created", response: { id: "resp-1", status: "in_progress", output: [] } }));
            const itemId = "msg-final";
            res.write(sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, role: "assistant", content: [] } }));
            res.write(sse("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, part: { type: "output_text", text: "" } }));
            res.write(sse("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, delta: "done" }));
            res.write(sse("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, text: "done" }));
            res.write(sse("response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 0, part: { type: "output_text", text: "done" } }));
            res.write(sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text: "done" }] } }));
            res.write(sse("response.completed", { type: "response.completed", response: { id: "resp-1", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 2 } } }));
            res.end();
        });
    });
}

function countReasoning(items: RespItem[]): number {
    return items.filter((it) => it.type === "reasoning").length;
}

async function postResponses(proxyPort: number, upstreamPort: number, sessionName: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionName },
        body: JSON.stringify({ model: "deepseek-mistral-x", input: RESPONSES_INPUT, stream: true }),
    });
    const text = await res.text().catch(() => "");
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text.slice(0, 300)}`);
}

test("#5257 e2e (responses lane): per-model strictReasoningEcho:false suppresses the injected blank item", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5257-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    const seenBodies: string[] = [];
    const upstream = makeResponsesUpstream(seenBodies);
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { proxy, proxyPort } = await startProxy(upstreamPort, { "deepseek-mistral-x": { context: 400_000, strictReasoningEcho: false } });
    try {
        await postResponses(proxyPort, upstreamPort, "5257-resp-optout");
        const forwarded = seenBodies.filter((b) => b.includes("call-c1"));
        assert.ok(forwarded.length >= 1, "the responses request must be forwarded");
        const input = (JSON.parse(forwarded[forwarded.length - 1]!) as { input: RespItem[] }).input;
        // The model id matches /deepseek/i, so WITHOUT the opt-out the static
        // rule would inject a blank reasoning item at the orphan run start
        // (control below). With the opt-out the input keeps exactly its one
        // original reasoning item and the orphan run stays un-repaired.
        assert.equal(countReasoning(input), 1, `opt-out must not inject a blank reasoning item: ${forwarded[forwarded.length - 1]!.slice(0, 300)}`);
    } finally {
        await close(proxy);
        await close(upstream);
        _resetStoreForTest();
        process.env.XDG_STATE_HOME = undefined;
        rmrf(stateDir);
    }
});

test("#5257 e2e (responses lane): without the opt-out the static /deepseek/ rule still injects (default pin)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5257-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    const seenBodies: string[] = [];
    const upstream = makeResponsesUpstream(seenBodies);
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    // Same model id, NO strictReasoningEcho entry — the #1027/#1479 static
    // rule must keep injecting the blank reasoning item on the Responses lane.
    const { proxy, proxyPort } = await startProxy(upstreamPort, { "deepseek-mistral-x": { context: 400_000 } });
    try {
        await postResponses(proxyPort, upstreamPort, "5257-resp-default");
        const forwarded = seenBodies.filter((b) => b.includes("call-c1"));
        assert.ok(forwarded.length >= 1, "the responses request must be forwarded");
        const input = (JSON.parse(forwarded[forwarded.length - 1]!) as { input: RespItem[] }).input;
        assert.equal(countReasoning(input), 2, `the static rule must inject the blank reasoning item when unconfigured: ${forwarded[forwarded.length - 1]!.slice(0, 300)}`);
    } finally {
        await close(proxy);
        await close(upstream);
        _resetStoreForTest();
        process.env.XDG_STATE_HOME = undefined;
        rmrf(stateDir);
    }
});
