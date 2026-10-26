import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { stripEmbeddedChainCarriers } from "../src/chain-checkpoint.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

// #1542: a chain checkpoint that leaked into a client transcript comes back on
// every resend. extractChainCarriers only sees the trailing user run, so a
// carrier that sank into mid-history rides the rebuild to the model forever
// (+1 stacked user message per request). stripEmbeddedChainCarriers removes
// well-formed whole-part carriers from ANY position before kernel projection.

const OLD_TS = Date.now() - 2 * 60 * 60 * 1000;
const DIGEST_A = "sha256:" + "ab".repeat(32);
const DIGEST_B = "sha256:" + "cd".repeat(32);
const STAMP_A = `<bili-chain v="1" processor="leaked-instance" issued-at="${OLD_TS}" request-id="r-old-a" digest="${DIGEST_A}"/>`;
const STAMP_B = `<bili-chain v="1" processor="leaked-instance" issued-at="${OLD_TS + 1000}" request-id="r-old-b" digest="${DIGEST_B}"/>`;

test("openai: mid-history user carrier stripped from any position", () => {
    const body = {
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "q1" },
            { role: "assistant", content: "a1" },
            { role: "user", content: STAMP_A },
            { role: "assistant", content: "a2" },
            { role: "user", content: "q2" },
        ],
    };
    const n = stripEmbeddedChainCarriers(body, "openai");
    assert.equal(n, 1);
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system", "user", "assistant", "assistant", "user"]);
    assert.ok(!JSON.stringify(body).includes(DIGEST_A));
});

test("openai: multiple carriers incl. assistant echo all stripped", () => {
    const body = {
        messages: [
            { role: "user", content: STAMP_A },
            { role: "assistant", content: "a1" },
            { role: "assistant", content: STAMP_B },
            { role: "user", content: "q" },
        ],
    };
    const n = stripEmbeddedChainCarriers(body, "openai");
    assert.equal(n, 2);
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["assistant", "user"]);
});

test("openai: tag-shaped text embedded in prose is NOT a carrier", () => {
    const body = {
        messages: [
            { role: "assistant", content: `I notice a ${STAMP_A} tag in your message — what is it?` },
            { role: "user", content: "see <bili-chain v=\"1\" processor=x/> above" },
        ],
    };
    const n = stripEmbeddedChainCarriers(body, "openai");
    assert.equal(n, 0);
    assert.ok(JSON.stringify(body).includes(DIGEST_A));
});

test("openai: malformed tag (bad digest shape) left alone", () => {
    const body = { messages: [{ role: "user", content: `<bili-chain v="1" processor="x" issued-at="${OLD_TS}" request-id="r" digest="not-hex!"/>` }] };
    assert.equal(stripEmbeddedChainCarriers(body, "openai"), 0);
});

test("openai: parts array — carrier part removed, mixed message kept, carrier-only message dropped, tool/system untouched", () => {
    const body = {
        messages: [
            { role: "user", content: [{ type: "text", text: "real question" }, { type: "text", text: STAMP_A }] },
            { role: "user", content: [{ type: "text", text: STAMP_B }] },
            { role: "tool", tool_call_id: "c1", content: STAMP_A },
            { role: "system", content: STAMP_B },
        ],
    };
    const n = stripEmbeddedChainCarriers(body, "openai");
    assert.equal(n, 2);
    assert.equal(body.messages.length, 3);
    assert.deepEqual(body.messages[0], { role: "user", content: [{ type: "text", text: "real question" }] });
    assert.equal(body.messages[1].role, "tool");
    assert.equal(body.messages[2].role, "system");
});

test("anthropic: string carrier dropped; merged trailing carrier part removed with message kept", () => {
    const body = {
        messages: [
            { role: "user", content: STAMP_A },
            { role: "assistant", content: "a1" },
            { role: "user", content: [{ type: "text", text: "next turn" }, { type: "text", text: STAMP_B }] },
        ],
    };
    const n = stripEmbeddedChainCarriers(body, "anthropic");
    assert.equal(n, 2);
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages[1], { role: "user", content: [{ type: "text", text: "next turn" }] });
});

test("google: carrier parts removed from user/model entries; emptied entry dropped", () => {
    const body = {
        contents: [
            { role: "user", parts: [{ text: "hello" }, { text: STAMP_A }] },
            { role: "model", parts: [{ text: STAMP_B }] },
            { role: "user", parts: [{ text: "still here" }] },
        ],
    };
    const n = stripEmbeddedChainCarriers(body, "google");
    assert.equal(n, 2);
    assert.equal(body.contents.length, 2);
    assert.deepEqual(body.contents[0].parts, [{ text: "hello" }]);
    assert.equal(body.contents[1].role, "user");
});

test("responses: message items cleaned; compaction_trigger and function_call untouched", () => {
    const body = {
        input: [
            { type: "message", role: "user", content: STAMP_A },
            { type: "message", role: "assistant", content: [{ type: "input_text", text: "reply" }, { type: "input_text", text: STAMP_B }] },
            { type: "function_call", call_id: "f1", name: "bash", arguments: STAMP_A },
            { type: "compaction_trigger" },
        ],
    };
    const n = stripEmbeddedChainCarriers(body, "responses");
    assert.equal(n, 2);
    assert.equal(body.input.length, 3);
    assert.deepEqual(body.input[0], { type: "message", role: "assistant", content: [{ type: "input_text", text: "reply" }] });
    assert.equal(body.input[1].type, "function_call");
    assert.equal(body.input[2].type, "compaction_trigger");
});

test("non-object / missing arrays return 0 without throwing", () => {
    assert.equal(stripEmbeddedChainCarriers(null, "openai"), 0);
    assert.equal(stripEmbeddedChainCarriers("str", "openai"), 0);
    assert.equal(stripEmbeddedChainCarriers({ input: "just a string" }, "responses"), 0);
    assert.equal(stripEmbeddedChainCarriers({}, "google"), 0);
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const MODEL = "gpt-test";

function makeOpts(port: number, upstream: string, overrides?: Partial<ProxyOptions>): ProxyOptions {
    return {
        port,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        proxyFallback: { explicitDirect: true, globalSource: "direct" },
        auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
        autoUpdate: false,
        logFile: "off",
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        ...overrides,
    };
}

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: string };

function makeUpstream(captured: Captured[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ url: req.url ?? "", headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
}

async function runPollutedRequest(pluginMode: boolean, overrides?: Partial<ProxyOptions>): Promise<{ atLlm: Captured; logs: { level: string; msg: string }[] }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    const srv = await startServer(makeOpts(0, llmUrl, overrides));
    await listen(srv);
    const port = (srv.address() as { port: number }).port;

    try {
        // Two stale carriers sunk into mid-history (each followed by more
        // turns) — exactly the shape the client transcript re-sends in #1542.
        const body = JSON.stringify({
            model: MODEL,
            stream: false,
            messages: [
                { role: "system", content: "You are a test assistant." },
                { role: "user", content: "q1" },
                { role: "assistant", content: "a1" },
                { role: "user", content: STAMP_A },
                { role: "assistant", content: "a2" },
                { role: "user", content: STAMP_B },
                { role: "assistant", content: "a3" },
                { role: "user", content: "q2" },
            ],
        });
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(pluginMode
                    ? { "x-bili-plugin": "pi", "x-bili-plugin-conversation": `conv-1542-${randomUUID()}` }
                    : { "x-acp-session": "proxy-1542" }),
            },
            body,
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.equal(captured.length, 1, `expected exactly one LLM request, got ${captured.length}`);
        return { atLlm: captured[0]!, logs };
    } finally {
        setLogCapture(null);
        srv.closeAllConnections?.();
        await close(srv);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
}

// #1683 made egress stamping opt-in (default OFF), so a polluted body now leaves
// the LLM with ZERO <bili-chain> markers by default (stale carriers stripped, no
// fresh one added); with chainEgressStamp:true it is re-stamped with exactly one
// fresh trailing carrier. Both outcomes are pinned below (deliberate behavior change).
for (const pluginMode of [true, false]) {
    const modeLabel = pluginMode ? "plugin-mode" : "proxy-mode";
    test(`#1542 server: polluted ${modeLabel} body reaches LLM with NO carrier by default (#1683)`, async () => {
        const { atLlm, logs } = await runPollutedRequest(pluginMode);
        const out = JSON.parse(atLlm.body) as { messages: { role: string; content: string }[] };
        const stamped = out.messages.filter((m) => typeof m.content === "string" && m.content.includes("<bili-chain"));
        assert.equal(stamped.length, 0, `no carrier may reach the LLM by default, got ${stamped.length}: ${atLlm.body.slice(0, 400)}`);
        assert.ok(!atLlm.body.includes(DIGEST_A), "old carrier A must not reach the LLM");
        assert.ok(!atLlm.body.includes(DIGEST_B), "old carrier B must not reach the LLM");
        assert.ok(logs.some((l) => l.msg.includes("embedded chain checkpoint")), "strip must be logged");
    });
    test(`#1542 server: polluted ${modeLabel} body reaches LLM with only the fresh stamp (egress stamping enabled)`, async () => {
        const { atLlm, logs } = await runPollutedRequest(pluginMode, { chainEgressStamp: true });
        const out = JSON.parse(atLlm.body) as { messages: { role: string; content: string }[] };
        const stamped = out.messages.filter((m) => typeof m.content === "string" && m.content.includes("<bili-chain"));
        assert.equal(stamped.length, 1, `exactly one (fresh) carrier may reach the LLM, got ${stamped.length}: ${atLlm.body.slice(0, 400)}`);
        assert.equal(stamped[0]!.role, "user");
        assert.equal(out.messages[out.messages.length - 1], stamped[0], "the fresh carrier sits in the trailing slot");
        assert.ok(!atLlm.body.includes(DIGEST_A), "old carrier A must not reach the LLM");
        assert.ok(!atLlm.body.includes(DIGEST_B), "old carrier B must not reach the LLM");
        assert.ok(logs.some((l) => l.msg.includes("embedded chain checkpoint")), "strip must be logged");
    });
}
