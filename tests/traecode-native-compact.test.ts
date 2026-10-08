import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";
import { TRAE_NATIVE_COMPACT_SENTENCE, neutralizeTraeNativeCompactInstruction, stripTraeCodeNativeCompactInstruction } from "../src/server/traecode-compact.js";
import { traeCompactMode } from "../src/knobs.js";

process.env.NODE_ENV = "test";

// #2411 Phase 1: TRAE Code's native auto-compact instruction must not reach
// the model in the same request as bili's injected compression philosophy.
// Fixtures reproduce the reporter's verbatim local context (#2411 floor 4):
// bullet at char offset 1270 of the single 42,385-char role=system string,
// system sha256 prefix e477d92761e39731 stable across 4 dumps / 2 sessions.

const PREV_BULLET = "…terminal status, linter errors, and current mode. This information is provided in case it is helpful to the task.";
const SYSTEM_HEAD = `${PREV_BULLET}\n`;
const TRACKED_LINE = `  - ${TRAE_NATIVE_COMPACT_SENTENCE}`;
const SYSTEM_TAIL = `\n\n# Doing tasks\nbe decisive.`;
const TRAECODE_SYSTEM = SYSTEM_HEAD + TRACKED_LINE + SYSTEM_TAIL;
const EXPECTED_CLEAN = `${SYSTEM_HEAD}\n# Doing tasks\nbe decisive.`;

test("neutralizer: removes exactly the tracked bullet line, head/tail bytes intact", () => {
    const r = neutralizeTraeNativeCompactInstruction(TRAECODE_SYSTEM);
    assert.equal(r.removed, 1);
    assert.equal(r.shapeDrift, false);
    assert.equal(r.text, EXPECTED_CLEAN);
    assert.ok(r.text.startsWith(SYSTEM_HEAD), "head prefix byte-stable (cache-neutral)");
    assert.ok(!r.text.includes(TRAE_NATIVE_COMPACT_SENTENCE));
});

test("neutralizer: idempotent — second pass removes nothing", () => {
    const once = neutralizeTraeNativeCompactInstruction(TRAECODE_SYSTEM);
    const twice = neutralizeTraeNativeCompactInstruction(once.text);
    assert.equal(twice.removed, 0);
    assert.equal(twice.text, once.text);
});

test("neutralizer: no tracked sentence → byte-identical passthrough", () => {
    const r = neutralizeTraeNativeCompactInstruction(SYSTEM_HEAD + "# Doing tasks\ntext");
    assert.equal(r.removed, 0);
    assert.equal(r.shapeDrift, false);
    assert.equal(r.text, SYSTEM_HEAD + "# Doing tasks\ntext");
});

test("neutralizer: sentence embedded mid-line → shapeDrift, NOT modified", () => {
    const drifted = SYSTEM_HEAD + `  - ${TRAE_NATIVE_COMPACT_SENTENCE} Additionally, context may reset.\n\n# Doing tasks`;
    const r = neutralizeTraeNativeCompactInstruction(drifted);
    assert.equal(r.removed, 0);
    assert.equal(r.shapeDrift, true);
    assert.equal(r.text, drifted);
});

test("neutralizer: sentence without a bullet marker → shapeDrift, NOT modified", () => {
    const drifted = SYSTEM_HEAD + `${TRAE_NATIVE_COMPACT_SENTENCE}\n\n# Doing tasks`;
    const r = neutralizeTraeNativeCompactInstruction(drifted);
    assert.equal(r.removed, 0);
    assert.equal(r.shapeDrift, true);
    assert.equal(r.text, drifted);
});

test("neutralizer: CRLF line endings handled", () => {
    const crlf = `A\r\n  - ${TRAE_NATIVE_COMPACT_SENTENCE}\r\n\r\nB`;
    const r = neutralizeTraeNativeCompactInstruction(crlf);
    assert.equal(r.removed, 1);
    assert.equal(r.shapeDrift, false);
    assert.equal(r.text, `A\r\n\r\nB`);
});

test("strip: system string rewritten in place, other messages untouched", () => {
    const user = { role: "user", content: "hi" };
    const assistant = { role: "assistant", content: "yo" };
    const msgs = [
        { role: "system", content: TRAECODE_SYSTEM },
        user,
        assistant,
        { role: "tool", content: "result" },
    ];
    const r = stripTraeCodeNativeCompactInstruction(msgs);
    assert.equal(r.neutralized, 1);
    assert.equal(r.shapeDrift, false);
    assert.equal((msgs[0] as { content: string }).content, EXPECTED_CLEAN);
    assert.deepEqual(user.content, "hi");
    assert.deepEqual(assistant.content, "yo");
});

test("strip: parts-array system content degrades to no-op (evidence covers string form only)", () => {
    const part = { type: "text", text: TRAECODE_SYSTEM };
    const msgs = [{ role: "system", content: [part] }, { role: "user", content: "hi" }];
    const r = stripTraeCodeNativeCompactInstruction(msgs);
    assert.equal(r.neutralized, 0);
    assert.equal(r.shapeDrift, false);
    assert.equal(part.text, TRAECODE_SYSTEM);
});

test("strip: non-array input → zero", () => {
    assert.deepEqual(stripTraeCodeNativeCompactInstruction(undefined), { neutralized: 0, shapeDrift: false });
    assert.deepEqual(stripTraeCodeNativeCompactInstruction({}), { neutralized: 0, shapeDrift: false });
});

test("knob: traeCompactMode default/env/case/garbage", () => {
    const prev = process.env.BILI_TRAE_COMPACT;
    try {
        delete process.env.BILI_TRAE_COMPACT;
        assert.equal(traeCompactMode(), "intercept", "default is intercept");
        process.env.BILI_TRAE_COMPACT = "pass";
        assert.equal(traeCompactMode(), "pass");
        process.env.BILI_TRAE_COMPACT = "PASS";
        assert.equal(traeCompactMode(), "pass", "case-insensitive");
        process.env.BILI_TRAE_COMPACT = "  pass  ";
        assert.equal(traeCompactMode(), "pass", "trimmed");
        process.env.BILI_TRAE_COMPACT = "banana";
        assert.equal(traeCompactMode(), "intercept", "unknown value stays on intercept");
    } finally {
        if (prev === undefined) delete process.env.BILI_TRAE_COMPACT;
        else process.env.BILI_TRAE_COMPACT = prev;
    }
});

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function startMockUpstream(bodies: string[]): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
            res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2 } }));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

async function postChat(url: string, messages: Array<{ role: string; content: string }>): Promise<void> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream: true, max_tokens: 1024, messages }),
    });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    await res.arrayBuffer();
}

test("e2e: TraeCode-shaped chat-completions request forwards ONE compression philosophy; kill-switch restores passthrough (#2411)", async () => {
    delete process.env.BILI_TRAE_COMPACT;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const bodies: string[] = [];
    const upstream = startMockUpstream(bodies);
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {} as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    try {
        // intercept (default): the conflicting native instruction is gone, the
        // acp tool surface is present, surrounding system bytes are intact
        await postChat(url, [
            { role: "system", content: TRAECODE_SYSTEM },
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "second question" },
        ]);
        assert.equal(bodies.length, 1, "request reached upstream");
        const sent1 = JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ function?: { name?: string } }> };
        const sys1 = sent1.messages.find((m) => m.role === "system")?.content ?? "";
        assert.ok(!sys1.includes(TRAE_NATIVE_COMPACT_SENTENCE), "native auto-compact instruction stripped");
        assert.ok(sys1.startsWith(PREV_BULLET), "system head prefix intact");
        assert.ok(sys1.includes("# Doing tasks"), "system tail intact after removal");
        assert.ok(sent1.tools?.some((t) => t.function?.name === "compress"), "acp compress tool injected in the same request");

        // continuation of the same conversation stays clean
        await postChat(url, [
            { role: "system", content: TRAECODE_SYSTEM },
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "second question" },
            { role: "assistant", content: "second answer" },
            { role: "user", content: "third question" },
        ]);
        const sent2 = JSON.parse(bodies[1]) as { messages: Array<{ role: string; content: string }> };
        const sys2 = sent2.messages.find((m) => m.role === "system")?.content ?? "";
        assert.ok(!sys2.includes(TRAE_NATIVE_COMPACT_SENTENCE), "continuation request stripped too");

        // kill-switch: per-request read, no restart — native instruction passes through verbatim
        process.env.BILI_TRAE_COMPACT = "pass";
        await postChat(url, [
            { role: "system", content: TRAECODE_SYSTEM },
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "second question" },
            { role: "assistant", content: "second answer" },
            { role: "user", content: "third question" },
            { role: "assistant", content: "third answer" },
            { role: "user", content: "fourth question" },
        ]);
        const sent3 = JSON.parse(bodies[2]) as { messages: Array<{ role: string; content: string }> };
        const sys3 = sent3.messages.find((m) => m.role === "system")?.content ?? "";
        assert.ok(sys3.includes(TRAE_NATIVE_COMPACT_SENTENCE), "kill-switch off: native instruction untouched");
        delete process.env.BILI_TRAE_COMPACT;
    } finally {
        delete process.env.BILI_TRAE_COMPACT;
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
