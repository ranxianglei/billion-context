import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";

process.env.NODE_ENV = "test";

const FAKE = "FAKE-MARKER \x3cinvoke name=\"example\"\x3e\x3c/invoke\x3e";
const LARGE = "begin-😀-" + "complete response ".repeat(600) + "-TAIL-MARKER";

function sse(text: string, toolArguments?: string): string {
    const base = { id: "chatcmpl-buffer", object: "chat.completion.chunk", model: "buffer-test", created: 1 };
    const tool = toolArguments === undefined ? "" : `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-preserved", type: "function", function: { name: "write_file", arguments: toolArguments } }] } }] })}\n\n`;
    return `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`
        + tool
        + `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolArguments === undefined ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`
        + "data: [DONE]\n\n";
}

function json(text: string): string {
    return JSON.stringify({ id: "chatcmpl-buffer", object: "chat.completion", model: "buffer-test", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
}

function textOf(raw: string): string {
    let text = "";
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
        const event = JSON.parse(line.slice(5));
        text += event.choices?.[0]?.delta?.content ?? "";
    }
    return text;
}

type Reply = string | ((res: http.ServerResponse) => void);

async function fixture(mode: "proxy" | "plugin", replies: Reply[], cap: number, opts: { json?: boolean; idleMs?: number; dumpSse?: string; priorStreak?: number } = {}) {
    const before = { retries: process.env.BILI_FAKE_COMPLETION_RETRIES, cap: process.env.BILI_FAKE_BUF_CAP, idle: process.env.BILI_UPSTREAM_TIMEOUT_MS, firstByte: process.env.BILI_UPSTREAM_FIRST_BYTE_MS };
    process.env.BILI_FAKE_COMPLETION_RETRIES = "1";
    process.env.BILI_FAKE_BUF_CAP = String(cap);
    if (opts.idleMs) {
        process.env.BILI_UPSTREAM_TIMEOUT_MS = String(opts.idleMs);
        process.env.BILI_UPSTREAM_FIRST_BYTE_MS = "10000";
    }
    let hits = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": opts.json ? "application/json" : "text/event-stream" });
            const reply = replies[Math.min(hits++, replies.length - 1)];
            if (typeof reply === "string") res.end(reply);
            else reply(res);
        });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${address.port}`]: { models: { "buffer-test": { context: 100_000 } } } },
        modelContextLimit: 100_000, kernelConfig: defaultConfig(100_000),
        compress: { injectTool: false, injectNudge: false }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
        ...(opts.dumpSse ? { dumpSse: opts.dumpSse } : {}),
    } as ProxyOptions);
    if (!proxy.listening) await new Promise<void>((resolve) => proxy.once("listening", resolve));
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");
    const session = "buffer-limit-" + randomUUID();
    if (opts.priorStreak !== undefined) getSession(session).metadata.fakeCompletionStreak = opts.priorStreak;
    return {
        async request(signal?: AbortSignal) {
            return fetch(`http://127.0.0.1:${proxyAddress.port}/bili/http://127.0.0.1:${address.port}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": session, ...(mode === "plugin" ? { "x-bili-plugin": "pi" } : {}) },
                body: JSON.stringify({ model: "buffer-test", stream: true, max_tokens: 4096, messages: [{ role: "user", content: "Return the complete result" }] }),
                signal,
            });
        },
        hits: () => hits,
        session: () => getSession(session),
        async close() {
            proxy.closeAllConnections();
            upstream.closeAllConnections();
            await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
            if (before.retries === undefined) delete process.env.BILI_FAKE_COMPLETION_RETRIES;
            else process.env.BILI_FAKE_COMPLETION_RETRIES = before.retries;
            if (before.cap === undefined) delete process.env.BILI_FAKE_BUF_CAP;
            else process.env.BILI_FAKE_BUF_CAP = before.cap;
            if (before.idle === undefined) delete process.env.BILI_UPSTREAM_TIMEOUT_MS;
            else process.env.BILI_UPSTREAM_TIMEOUT_MS = before.idle;
            if (before.firstByte === undefined) delete process.env.BILI_UPSTREAM_FIRST_BYTE_MS;
            else process.env.BILI_UPSTREAM_FIRST_BYTE_MS = before.firstByte;
        },
    };
}

for (const mode of ["proxy", "plugin"] as const) {
    for (const retry of [false, true]) {
        test(`${mode}: buffer cap preserves a ${retry ? "retried" : "first"} successful SSE response`, async () => {
            const rig = await fixture(mode, retry ? [sse(FAKE), sse(LARGE)] : [sse(LARGE)], 1024);
            try {
                const response = await rig.request();
                assert.equal(response.status, 200);
                const raw = await response.text();
                assert.equal(textOf(raw), LARGE);
                assert.ok(raw.includes("[DONE]"));
                assert.ok(raw.includes('"completion_tokens":20'));
                assert.equal(rig.hits(), retry ? 2 : 1);
                assert.equal(rig.session().metadata.fakeCompletionStreak, undefined);
                assert.equal(_liveUpstreamTimersForTest(), 0);
            } finally { await rig.close(); }
        });
    }

    test(`${mode}: a fake completion exactly at the buffer cap is still checked`, async () => {
        const fake = sse(FAKE);
        const rig = await fixture(mode, [fake, sse("recovered")], Buffer.byteLength(fake));
        try {
            assert.equal(textOf(await (await rig.request()).text()), "recovered");
            assert.equal(rig.hits(), 2);
        } finally { await rig.close(); }
    });
}

test("proxy: buffer cap preserves JSON returned to a streaming request", async () => {
    const rig = await fixture("proxy", [json(LARGE)], 1024, { json: true });
    try {
        const response = await rig.request();
        assert.equal(response.status, 200);
        const body = await response.json() as { choices: Array<{ message: { content: string } }> };
        assert.equal(body.choices[0].message.content, LARGE);
        assert.equal(rig.hits(), 1);
    } finally { await rig.close(); }
});

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(label)), 5_000);
        })]);
    } finally { clearTimeout(timer); }
}

async function timersCleared(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (_liveUpstreamTimersForTest() !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(_liveUpstreamTimersForTest(), 0, "upstream timers were not released");
}

for (const mode of ["proxy", "plugin"] as const) {
    test(`${mode}: a tool call beyond the inspection cap remains byte-exact without a retry`, async () => {
        const args = JSON.stringify({ contents: LARGE });
        const rig = await fixture(mode, [sse(FAKE + LARGE, args), sse("unexpected retry")], 1024);
        try {
            const raw = await (await rig.request()).text();
            const events = raw.split("\n").filter((line) => line.startsWith("data:") && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(5)));
            const calls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].id, "call-preserved");
            assert.equal(calls[0].function.arguments, args);
            assert.equal(rig.hits(), 1);
        } finally { await rig.close(); }
    });

    test(`${mode}: incomplete inspection leaves the prior fake-completion streak intact`, async () => {
        const rig = await fixture(mode, [sse(LARGE)], 1024, { priorStreak: 1 });
        try {
            assert.equal(textOf(await (await rig.request()).text()), LARGE);
            assert.equal(rig.session().metadata.fakeCompletionStreak, 1);
            assert.equal(rig.hits(), 1);
        } finally { await rig.close(); }
    });

    test(`${mode}: an over-budget retry still aborts on upstream silence`, { timeout: 15_000 }, async () => {
        const closed = Promise.withResolvers<void>();
        const prefix = sse(LARGE).split("\n\n")[0] + "\n\n";
        const rig = await fixture(mode, [sse(FAKE), (res) => {
            res.once("close", closed.resolve);
            res.write(prefix);
        }], 1024, { idleMs: 1500 });
        try {
            const response = await rig.request();
            const raw = await within(response.text(), "retry idle watchdog was detached before the body finished");
            assert.equal(textOf(raw), LARGE);
            assert.equal(rig.hits(), 2);
            await within(closed.promise, "stalled retry connection stayed open");
            await timersCleared();
        } finally { await rig.close(); }
    });

    test(`${mode}: disconnect cancels an over-budget retry and its raw-dump branch`, { timeout: 15_000 }, async () => {
        const closed = Promise.withResolvers<void>();
        const prefix = sse(LARGE).split("\n\n")[0] + "\n\n";
        const dir = await mkdtemp(join(tmpdir(), "bili-fake-buffer-dump-"));
        const rig = await fixture(mode, [sse(FAKE), (res) => {
            res.once("close", closed.resolve);
            res.write(prefix);
        }], 1024, { dumpSse: dir });
        const abort = new AbortController();
        try {
            const response = await rig.request(abort.signal);
            const reader = response.body!.getReader();
            let raw = "";
            const decoder = new TextDecoder();
            await within((async () => {
                while (!raw.includes("-TAIL-MARKER")) {
                    const next = await reader.read();
                    assert.equal(next.done, false);
                    raw += decoder.decode(next.value, { stream: true });
                }
            })(), "over-budget prefix was withheld until upstream EOF");
            assert.equal(textOf(raw), LARGE);
            abort.abort();
            await within(closed.promise, "client abort did not close the live retry");
            await timersCleared();
            reader.releaseLock();
        } finally {
            abort.abort();
            await rig.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
}
