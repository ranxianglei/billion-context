import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { countMessageTokens, defaultConfig, type CoreMessage } from "acp-kernel";
import { openaiToCore, responsesToCore } from "acp-kernel/wire";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { clearEstimateCoreMessagesMemoForTests, estimateCoreMessages } from "../src/preflight.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";

type Protocol = "openai" | "responses";

function escapedJson(value: unknown): string {
    return JSON.stringify(value).replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function argumentPair(characters = "漢你好世界", path = "/tmp/"): [string, string] {
    const value = { path: `${path}${characters[0]}.txt`, content: characters.slice(1), mode: "overwrite", encoding: "utf8" };
    const pair: [string, string] = [escapedJson(value), JSON.stringify(value, null, 4)];
    assert.equal(pair[0].length, pair[1].length);
    assert.deepEqual(JSON.parse(pair[0]), JSON.parse(pair[1]));
    return pair;
}

function project(protocol: Protocol, args: string): CoreMessage[] {
    if (protocol === "responses") return responsesToCore({ input: [
        { type: "function_call", call_id: "call_1", name: "write_file", arguments: args },
    ] }).msgs;
    return openaiToCore({ messages: [{ role: "assistant", tool_calls: [
        { id: "call_1", type: "function", function: { name: "write_file", arguments: args } },
    ] }] }).msgs;
}

const count = (messages: CoreMessage[]): number => messages.reduce((sum, message) => sum + countMessageTokens(message), 0);

for (const protocol of ["openai", "responses"] as const) {
    for (const characters of ["漢你好世界", "語にほんご", "한가나다라"]) {
        for (const reverse of [false, true]) {
            test(`${protocol}: ${characters} counts follow exact arguments in ${reverse ? "literal-first" : "escaped-first"} order`, () => {
                clearEstimateCoreMessagesMemoForTests();
                const pair = argumentPair(characters).map(args => project(protocol, args));
                assert.equal(pair[0][0].id, pair[1][0].id, "real codec canonical identity is shared");
                assert.notEqual(count(pair[0]), count(pair[1]));
                for (const messages of reverse ? pair.reverse() : pair) {
                    assert.equal(estimateCoreMessages(messages), count(messages));
                }
            });
        }
    }
}

test("an in-place text rewrite cannot reuse the previous same-length count", () => {
    clearEstimateCoreMessagesMemoForTests();
    const [escaped, literal] = argumentPair();
    const messages = project("openai", escaped);
    assert.equal(estimateCoreMessages(messages), count(messages));
    messages[0].text = literal;
    assert.equal(estimateCoreMessages(messages), count(messages));
    messages[0].text = escaped;
    assert.equal(estimateCoreMessages(messages), count(messages));
});

test("alternating freshly projected twins remain correct while both owners stay live", () => {
    clearEstimateCoreMessagesMemoForTests();
    const pair = argumentPair();
    const owners: CoreMessage[][] = [];
    for (let index = 0; index < 8; index++) {
        const messages = project("openai", pair[index % 2]);
        owners.push(messages);
        assert.equal(estimateCoreMessages(messages), count(messages));
    }
    for (const messages of owners) assert.equal(estimateCoreMessages(messages), count(messages));
});

test("unchanged clones and thinking-mass changes retain the kernel's count", () => {
    clearEstimateCoreMessagesMemoForTests();
    const messages = project("openai", argumentPair()[1]);
    for (let index = 0; index < 4; index++) {
        const clone = messages.map(message => ({ ...message }));
        assert.equal(estimateCoreMessages(clone), count(clone));
    }
    for (const thinkingTokens of [100, 0, 1000, undefined]) {
        messages[0].thinkingTokens = thinkingTokens;
        assert.equal(estimateCoreMessages(messages), count(messages));
    }
});

test("length changes, non-kernel IDs, and cache resets preserve count semantics", () => {
    const [escaped, literal] = argumentPair();
    for (const id of [project("openai", escaped)[0].id, "fixture-id"]) {
        clearEstimateCoreMessagesMemoForTests();
        const message: CoreMessage = { id, role: "assistant", contentType: "tool-call", text: escaped };
        for (const text of [escaped, literal + " ", undefined, "", literal]) {
            message.text = text;
            assert.equal(estimateCoreMessages([message]), countMessageTokens(message));
            clearEstimateCoreMessagesMemoForTests();
            assert.equal(estimateCoreMessages([message]), countMessageTokens(message));
        }
    }
});

test("actual HTTP output budget is independent of a different serialization warming the memo", { timeout: 20000 }, async () => {
    const previousPrompt = process.env.ACP_NO_COMPRESS_PROMPT;
    process.env.ACP_NO_COMPRESS_PROMPT = "1";
    const pairs = Array.from({ length: 800 }, (_, index) => argumentPair("漢你好世界", `/tmp/${String(index).padStart(4, "0")}`));
    const history = (literal: boolean) => [
        { role: "user", content: "Write the requested files and report." },
        { role: "assistant", tool_calls: pairs.map((pair, index) => ({ id: `call_${index}`, type: "function", function: { name: "write_file", arguments: pair[literal ? 1 : 0] } })) },
        ...pairs.map((_, index) => ({ role: "tool", tool_call_id: `call_${index}`, content: "written" })),
        { role: "user", content: "Summarize the completed changes." },
    ];
    type Forwarded = { max_tokens: number; messages: Array<{ tool_calls?: Array<{ function: { arguments: string } }> }> };
    const requests: Forwarded[] = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Forwarded);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "fixture-response", object: "chat.completion", model: "memo-fixture",
            choices: [{ index: 0, message: { role: "assistant", content: "Files are ready." }, finish_reason: "stop" }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const origin = `http://127.0.0.1:${upstreamAddress.port}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: origin,
        routes: { [origin]: { models: { "memo-fixture": { context: 80000 } } } },
        proxy: "", proxyMode: "direct", proxySource: "direct", modelContextLimit: 80000,
        kernelConfig: defaultConfig(80000), compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false,
        passthrough: false, chainContentDetection: false, autoUpdate: false, mitm: { enabled: false, domains: [] },
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const address = proxy.address();
        assert.ok(address && typeof address !== "string");
        clearEstimateCoreMessagesMemoForTests();
        for (const mode of ["seed", "warm", "cold"]) {
            if (mode === "cold") clearEstimateCoreMessagesMemoForTests();
            const before = requests.length;
            const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
                method: "POST", headers: { "content-type": "application/json", "x-acp-session": `memo-http-${mode}` },
                body: JSON.stringify({ model: "memo-fixture", max_tokens: 70000, stream: false, messages: history(mode !== "seed"),
                    tools: [{ type: "function", function: { name: "write_file", description: "Write a file.", parameters: {
                        type: "object", properties: Object.fromEntries(["path", "content", "mode", "encoding"].map(key => [key, { type: "string" }])),
                        required: ["path", "content", "mode", "encoding"],
                    } } }],
                }),
            });
            assert.equal(response.status, 200);
            assert.ok((await response.text()).includes("Files are ready."));
            assert.equal(requests.length, before + 1);
            assert.deepEqual(requests.at(-1)!.messages.flatMap(message => message.tool_calls ?? []).map(call => call.function.arguments),
                pairs.map(pair => pair[mode === "seed" ? 0 : 1]), "wire arguments remain byte-exact");
        }
        assert.ok(requests[1].max_tokens < requests[0].max_tokens, "literal CJK history receives its own budget");
        assert.equal(requests[1].max_tokens, requests[2].max_tokens, "prior traffic cannot alter an identical request's output budget");
    } finally {
        for (const server of [proxy, upstream]) if (server) {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
        if (previousPrompt === undefined) delete process.env.ACP_NO_COMPRESS_PROMPT;
        else process.env.ACP_NO_COMPRESS_PROMPT = previousPrompt;
    }
});
