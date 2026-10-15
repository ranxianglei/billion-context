import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import WebSocket, { WebSocketServer } from "ws";

const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-async-compress-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { listSessions, _resetSessionsForTest, flushAllSessions } = await import("../src/session.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const ac = await import("../src/async-compress.ts");
const { recordUpstreamCircuitFailure, _resetUpstreamCircuitsForTest } = await import("../src/upstream-alerts.ts");
type ProxyOptions = import("../src/config.ts").ProxyOptions;

after(() => {
    ac.configureAsyncCompress(false);
    for (const k of ["XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[k];
});

const FILLER = "the build log line explains which module failed and why the retry loop kept spinning. ";
const SUMMARY = "Summary of the early build investigation: module A failed on a missing env var, the retry loop spun because the error was classified as transient; fixed by marking ConfigError non-retryable. ".repeat(2);
const FORK_MARK = "Background compression pass (job ";

function history(n: number, tag = ""): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i++) {
        out.push({ role: "user", content: `${tag}user turn ${i}: ${FILLER.repeat(12)}` });
        out.push({ role: "assistant", content: `${tag}assistant reply ${i}: ${FILLER.repeat(12)}` });
    }
    return out;
}

function refsOf(body: string): string[] {
    const ids: string[] = [];
    const re = /\x3cacp[^\x3e]*\x3e\s*(m\d+)\s*\x3c\/acp\x3e/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) if (!ids.includes(m[1]!)) ids.push(m[1]!);
    return ids;
}

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function openaiText(res: http.ServerResponse, text: string): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
    res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } }));
    res.end("data: [DONE]\n\n");
}

function openaiCalls(res: http.ServerResponse, calls: Array<{ name: string; args: unknown }>): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    calls.forEach((c, index) => {
        res.write(sse({ id: "c2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index, id: `call_${c.name}_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, finish_reason: null }] }));
    });
    res.write(sse({ id: "c2", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }));
    res.end("data: [DONE]\n\n");
}

type Seen = { body: string; parsed: Record<string, unknown>; fork: boolean; headers: http.IncomingHttpHeaders; url: string };
type Handler = (seen: Seen, res: http.ServerResponse) => void | Promise<void>;

interface Rig {
    proxy: http.Server;
    upstream: http.Server;
    base: string;
    wireBase: string;
    seen: Seen[];
    setHandler(h: Handler): void;
}

function lastUserText(parsed: Record<string, unknown>): string {
    const msgs = Array.isArray(parsed.messages) ? parsed.messages as Array<Record<string, unknown>> : [];
    const last = msgs[msgs.length - 1];
    return last ? JSON.stringify(last.content ?? "") : "";
}

/** Default model behavior: the fork answers one compress call over the first third of the refs; TRIGGER asks for compress([]). */
function defaultHandler(forkGate?: Promise<void>, forkCalls?: (refs: string[]) => Array<{ name: string; args: unknown }>): Handler {
    return async (seen, res) => {
        if (seen.fork) {
            if (forkGate) await forkGate;
            const refs = refsOf(seen.body);
            const owner = /([AB]?)user turn 0:/.exec(seen.body)?.[1] ?? "";
            const calls = forkCalls ? forkCalls(refs) : [{ name: "compress", args: { content: [{ startId: refs[1], endId: refs[Math.floor(refs.length / 3)], summary: `${SUMMARY} [owner:${owner}]` }] } }];
            openaiCalls(res, calls);
            return;
        }
        const lastText = lastUserText(seen.parsed);
        const msgs = seen.parsed.messages as Array<Record<string, unknown>>;
        const last = msgs[msgs.length - 1]!;
        if (last.role === "user" && lastText.includes("TRIGGER")) {
            openaiCalls(res, [{ name: "compress", args: { content: [] } }]);
            return;
        }
        openaiText(res, "ok");
    };
}

async function startRig(): Promise<Rig> {
    const seen: Seen[] = [];
    let handler: Handler = defaultHandler();
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const items = (parsed.messages ?? parsed.input ?? parsed.contents ?? []) as unknown[];
            const s: Seen = { body, parsed, fork: JSON.stringify(items.slice(-1)).includes(FORK_MARK), headers: req.headers, url: req.url ?? "" };
            seen.push(s);
            void Promise.resolve(handler(s, res)).catch(() => res.destroy());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false, compat: { roles: {} }, streamErrorShape: "protocol",
        passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    if (!proxy.listening) await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxy, upstream, seen,
        base: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        wireBase: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1`,
        setHandler(h) { handler = h; },
    };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.closeAllConnections?.();
    rig.proxy.close();
    rig.upstream.closeAllConnections?.();
    rig.upstream.close();
    await Promise.all([once(rig.proxy, "close"), once(rig.upstream, "close")]);
}

async function chat(rig: Rig, sid: string, messages: unknown[], plugin: boolean, tools?: unknown[], signal?: AbortSignal): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": sid, authorization: "Bearer test-secret-key" };
    if (plugin) headers["x-bili-plugin"] = "test-agent";
    const res = await fetch(rig.base, { method: "POST", headers, signal, body: JSON.stringify({ model: "test-model", max_tokens: 64_000, stream: true, messages, ...(tools ? { tools } : {}) }) });
    return { status: res.status, text: await res.text() };
}

async function pluginTool(rig: Rig, sid: string, tool: string, args: unknown): Promise<{ ok: boolean; result?: string }> {
    const origin = new URL(rig.base).origin;
    const res = await fetch(`${origin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: sid, tool, args }) });
    return await res.json() as { ok: boolean; result?: string };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 10));
    }
}

function gate(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    return { promise, release };
}

function sessionFor(sid: string) {
    return listSessions().find((s) => s.id === sid || s.id.startsWith(sid));
}

const PLUGIN_TOOLS = [
    { type: "function", function: { name: "compress", description: "compress", parameters: { type: "object", properties: { content: {} } } } },
    { type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } } },
];

function restoredText(result: string): string {
    const file = /written to: (\S+?\.txt)/.exec(result)?.[1];
    return file ? readFileSync(file, "utf8") : result;
}

function freshStore(dir?: string): void {
    _setStoreForTest(dir ? new SessionStore({ dir, debounceMs: 0, enabled: true }) : new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetPluginStateForTest();
}

test("trigger shape: only an exact empty content array", () => {
    assert.equal(ac.isAsyncCompressTrigger({ content: [] }), true);
    assert.equal(ac.isAsyncCompressTrigger('{"content":[]}'), true);
    assert.equal(ac.isAsyncCompressTrigger({ content: "[]" }), true);
    assert.equal(ac.isAsyncCompressTrigger({}), false);
    assert.equal(ac.isAsyncCompressTrigger(""), false);
    assert.equal(ac.isAsyncCompressTrigger({ content: [{ startId: "m1", endId: "m2", summary: "x" }] }), false);
    assert.equal(ac.isAsyncCompressTrigger({ content: [], startId: "m1" }), false);
});

test("capture declines forced tool_choice, server state, signed bodies and missing compress", () => {
    const tools = [{ type: "function", function: { name: "compress" } }];
    const url = "http://127.0.0.1:1/v1/chat/completions";
    assert.equal(ac.declineReason("openai", { messages: [], tools }, url, false), null);
    assert.equal(ac.declineReason("openai", { messages: [], tools, tool_choice: "auto" }, url, false), null);
    assert.match(ac.declineReason("openai", { messages: [], tools, tool_choice: "required" }, url, false) ?? "", /tool_choice/);
    assert.match(ac.declineReason("openai", { messages: [], tools, tool_choice: { type: "function", function: { name: "bash" } } }, url, false) ?? "", /tool_choice/);
    assert.match(ac.declineReason("anthropic", { messages: [], tools: [{ name: "compress" }], tool_choice: { type: "any" } }, url, false) ?? "", /tool_choice/);
    assert.match(ac.declineReason("responses", { input: [], tools: [{ type: "function", name: "compress" }], previous_response_id: "r1" }, url, false) ?? "", /server-side/);
    assert.match(ac.declineReason("anthropic", { messages: [], tools: [{ name: "compress" }], thread: { type: "continue" } }, url, false) ?? "", /server-side/);
    assert.match(ac.declineReason("openai", { messages: [], tools }, url, true) ?? "", /signed/);
    assert.match(ac.declineReason("openai", { messages: [], tools: [] }, url, false) ?? "", /not declared/);
    assert.match(ac.declineReason("google", { contents: [], tools: [{ functionDeclarations: [{ name: "compress" }] }], toolConfig: { functionCallingConfig: { mode: "ANY" } } }, url, false) ?? "", /mode ANY/);
});

test("fork reply: exactly one fully valid compress call, otherwise rejected whole", () => {
    const ok = { name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00005", summary: SUMMARY }] }) };
    assert.equal(typeof ac.rangesFromForkCalls([ok]), "object");
    assert.match(String(ac.rangesFromForkCalls([])), /no compress call/);
    assert.match(String(ac.rangesFromForkCalls([ok, { name: "bash", arguments: "{}" }])), /non-compress tool/);
    assert.match(String(ac.rangesFromForkCalls([ok, ok])), /more than one/);
    assert.match(String(ac.rangesFromForkCalls([{ name: "compress", arguments: JSON.stringify({ content: [] }) }])), /no valid range/);
    const mixed = { name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00005", summary: SUMMARY }, { bogus: 1 }] }) };
    assert.match(String(ac.rangesFromForkCalls([mixed])), /invalid entries/);
});

test("fork body keeps every existing part byte-for-byte and appends exactly one user item per wire", () => {
    const signedThinking = { type: "thinking", thinking: "plan: check the logs", signature: "EqQBCkYIBRgCKkBsig==" };
    const toolUse = { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "grep -rn \"\\x3cacp\" src | head" } };
    const anthropic = {
        model: "m", system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], tools: [{ name: "compress", input_schema: {} }],
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [signedThinking, toolUse] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }] }],
    };
    const forked = ac.appendUserText("anthropic", structuredClone(anthropic), "directive");
    const { messages: fm, ...frest } = forked as { messages: unknown[] };
    const { messages: om, ...orest } = anthropic;
    assert.deepEqual(frest, orest);
    assert.equal(fm.length, om.length + 1);
    assert.deepEqual(fm.slice(0, om.length), om);
    assert.equal(JSON.stringify(fm[1]), JSON.stringify(om[1]), "signed thinking + tool args identical bytes");
    assert.deepEqual(fm[om.length], { role: "user", content: [{ type: "text", text: "directive" }] });
    const responses = { model: "gpt", store: false, include: ["reasoning.encrypted_content"], prompt_cache_key: "k", input: [{ type: "reasoning", encrypted_content: "gAAA==" }, { type: "function_call", call_id: "c1", name: "compress", arguments: "{\"content\":[]}" }, { type: "function_call_output", call_id: "c1", output: "queued" }] };
    const rf = ac.appendUserText("responses", structuredClone(responses), "d") as { input: unknown[] };
    assert.deepEqual(rf.input.slice(0, 3), responses.input);
    assert.equal(rf.input.length, 4);
    const google = { contents: [{ role: "model", parts: [{ functionCall: { name: "compress", args: { content: [] } }, thoughtSignature: "sig==" }] }, { role: "user", parts: [{ functionResponse: { name: "compress", response: { result: "queued" } } }] }] };
    const gf = ac.appendUserText("google", structuredClone(google), "d") as { contents: Array<{ role: string; parts: unknown[] }> };
    assert.equal(gf.contents.length, 2, "no consecutive user turn on Gemini");
    assert.deepEqual(gf.contents[0], google.contents[0]);
    assert.deepEqual(gf.contents[1]!.parts.slice(0, 1), google.contents[1]!.parts);
    assert.deepEqual(gf.contents[1]!.parts[1], { text: "d" });
});

test("async note: enabled appends only the clarification to compress (all declaration shapes); disabled is byte-identical", () => {
    const base = "Replace consumed conversation ranges. REQUIRED — compress without content or flat range fields is invalid.";
    const params = { type: "object", properties: { content: {} } };
    const shapes: Array<Record<string, unknown>> = [
        { name: "compress", description: base, input_schema: params },
        { type: "function", function: { name: "compress", description: base, parameters: params } },
        { type: "function", name: "compress", description: base, parameters: params },
        { name: "decompress", description: "d", input_schema: params },
    ];
    ac.configureAsyncCompress(false);
    const off = ac.withAsyncCompressTools(shapes);
    assert.equal(JSON.stringify(off), JSON.stringify(shapes), "default-off: byte-identical");
    ac.configureAsyncCompress({});
    try {
        const on = ac.withAsyncCompressTools(shapes);
        assert.ok(ac.ASYNC_COMPRESS_TOOL_NOTE.includes("Background compression is enabled for this session"));
        assert.match(ac.ASYNC_COMPRESS_TOOL_NOTE, /compress\(\{ content: \[\] \}\) — an empty content array and no other fields — is a valid call here/);
        for (let i = 0; i < 3; i++) {
            const decl = (i === 1 ? (on[i] as { function: Record<string, unknown> }).function : on[i]) as Record<string, unknown>;
            const orig = (i === 1 ? (shapes[i] as { function: Record<string, unknown> }).function : shapes[i]) as Record<string, unknown>;
            assert.equal(decl.description, base + ac.ASYNC_COMPRESS_TOOL_NOTE, `shape ${i}: original text kept as prefix, note appended`);
            assert.deepEqual({ ...decl, description: undefined }, { ...orig, description: undefined }, `shape ${i}: nothing else changed`);
        }
        assert.equal(on[3], shapes[3], "non-compress tools untouched (same reference)");
        assert.equal(JSON.stringify(shapes[0]), JSON.stringify({ name: "compress", description: base, input_schema: params }), "input not mutated");
    } finally {
        ac.configureAsyncCompress(false);
    }
});

test("unconfigured: hook is inert — compress([]) keeps the existing empty-call refusal and tools stay unchanged", async () => {
    ac.configureAsyncCompress(false);
    freshStore();
    const rig = await startRig();
    try {
        const tools = [{ name: "compress", description: "d" }];
        assert.deepEqual(ac.withAsyncCompressTools(tools), tools);
        await chat(rig, "inert-1", [...history(3), { role: "user", content: "TRIGGER" }], false);
        const round2 = rig.seen.find((s, i) => i > 0 && !s.fork);
        assert.ok(round2, "proxy loop re-requested after executing compress");
        assert.match(round2.body, /Compression FAILED/, "existing refusal reached the model");
        assert.ok(!rig.seen.some((s) => s.fork), "no fork without configuration");
        assert.ok(!rig.seen.some((s) => s.body.includes("Background compression")), "no async text on the wire");
        assert.equal(ac._asyncCompressStateForTest().jobs.size, 0);
    } finally {
        await closeRig(rig);
    }
});

test("proxy mode: main request completes while the fork is blocked; next request applies; decompress restores; restart keeps the carrier", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bc-async-sessions-"));
    ac.configureAsyncCompress({});
    freshStore(dir);
    const rig = await startRig();
    const forkGate = gate();
    rig.setHandler(defaultHandler(forkGate.promise));
    const sid = "proxy-async-1";
    try {
        const h = history(20);
        const t1 = await chat(rig, sid, [...h, { role: "user", content: "TRIGGER" }], false);
        assert.equal(t1.status, 200);
        assert.match(t1.text, /"ok"/, "main turn finished with the model's continuation");
        await waitFor(() => rig.seen.some((s) => s.fork));
        const job = [...ac._asyncCompressStateForTest().jobs.values()][0];
        assert.equal(job?.phase, "running", "fork in flight after the main request completed");
        const round2 = rig.seen.find((s) => !s.fork && s.body.includes("Background compression queued"));
        assert.ok(round2, "round-2 carried the queued tool result");
        const fork = rig.seen.find((s) => s.fork)!;
        assert.equal(fork.headers.authorization, "Bearer test-secret-key", "same credential as the captured send");
        const r2msgs = round2.parsed.messages as unknown[];
        const fmsgs = fork.parsed.messages as unknown[];
        assert.deepEqual(fmsgs.slice(0, r2msgs.length), r2msgs, "fork replays the captured messages unchanged");
        assert.equal(fmsgs.length, r2msgs.length + 1);
        assert.deepEqual(fork.parsed.tools, round2.parsed.tools);

        const h2 = [...h, { role: "user", content: "next step please" }];
        const t2 = await chat(rig, sid, h2, false);
        assert.equal(t2.status, 200, "a second main request also proceeds while the fork is blocked");
        assert.equal(sessionFor(sid)?.state.blocks.length ?? 0, 0);

        forkGate.release();
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const before = rig.seen.length;
        const h3 = [...h2, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }];
        await chat(rig, sid, h3, false);
        const applied = rig.seen[before]!;
        assert.ok(applied.body.includes(SUMMARY.slice(0, 60)), "summary carrier rides the next request");
        assert.ok(!applied.body.includes("user turn 2:"), "folded originals left the wire");
        const session = sessionFor(sid)!;
        const block = session.state.blocks.find((b) => b.active);
        assert.ok(block?.compressCallId?.startsWith(ac.ASYNC_COMPRESS_CALL_ID_PREFIX));
        assert.equal(ac._asyncCompressStateForTest().jobs.size, 0);

        await flushAllSessions();
        _resetSessionsForTest();
        _setStoreForTest(new SessionStore({ dir, debounceMs: 0, enabled: true }));
        const after = rig.seen.length;
        await chat(rig, sid, [...h3, { role: "assistant", content: "ok" }, { role: "user", content: "after restart" }], false);
        const reloaded = rig.seen[after]!;
        assert.ok(reloaded.body.includes(SUMMARY.slice(0, 60)), "carrier survives restart");
        assert.ok(!reloaded.body.includes("user turn 2:"), "fold survives restart");

        rig.setHandler(async (seen, res) => {
            const msgs = seen.parsed.messages as Array<Record<string, unknown>>;
            if (msgs[msgs.length - 1]?.role === "user" && lastUserText(seen.parsed).includes("RESTORE")) openaiCalls(res, [{ name: "decompress", args: { blockId: block!.blockId, full: true } }]);
            else openaiText(res, "ok");
        });
        const d0 = rig.seen.length;
        await chat(rig, sid, [...h3, { role: "assistant", content: "ok" }, { role: "user", content: "RESTORE it" }], false);
        const receipt = rig.seen.slice(d0).find((s) => s.body.includes(`[Block ${block!.blockId} content`));
        assert.ok(receipt, "decompress executed in the proxy loop");
        assert.match(restoredText(receipt.body.replace(/\\n/g, "\n")), /user turn 2:/, "decompress restored the folded originals");
    } finally {
        forkGate.release();
        await closeRig(rig);
    }
});

test("plugin mode: tool endpoint queues, next request is captured, main proceeds, later request applies, decompress + restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bc-async-sessions-"));
    ac.configureAsyncCompress({});
    freshStore(dir);
    const rig = await startRig();
    const forkGate = gate();
    rig.setHandler(defaultHandler(forkGate.promise));
    const sid = "plugin-async-1";
    try {
        const h = history(20);
        await chat(rig, sid, [...h, { role: "user", content: "go on" }], true, PLUGIN_TOOLS);
        const queued = await pluginTool(rig, sid, "compress", { content: [] });
        assert.equal(queued.ok, true);
        assert.match(queued.result ?? "", /Background compression queued \(job (bg-[0-9a-f]+)\)/);
        const tag = /job (bg-[0-9a-f]+)/.exec(queued.result!)![1]!;
        const again = await pluginTool(rig, sid, "compress", { content: [] });
        assert.match(again.result ?? "", /already queued/, "one job per session");

        const withResult = [...h, { role: "user", content: "go on" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_c", type: "function", function: { name: "compress", arguments: "{\"content\":[]}" } }] },
            { role: "tool", tool_call_id: "call_c", content: queued.result }];
        const t2 = await chat(rig, sid, withResult, true, PLUGIN_TOOLS);
        assert.equal(t2.status, 200);
        await waitFor(() => rig.seen.some((s) => s.fork));
        const captured = rig.seen.find((s) => !s.fork && s.body.includes(tag))!;
        const fork = rig.seen.find((s) => s.fork)!;
        const cm = captured.parsed.messages as unknown[];
        assert.deepEqual((fork.parsed.messages as unknown[]).slice(0, cm.length), cm);
        assert.deepEqual(fork.parsed.tools, captured.parsed.tools, "host tools kept for the prefix; fork executes none");

        const t3 = await chat(rig, sid, [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "more" }], true, PLUGIN_TOOLS);
        assert.equal(t3.status, 200, "main continues while the fork is held");

        forkGate.release();
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const before = rig.seen.length;
        const h4 = [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "more" }, { role: "assistant", content: "ok" }, { role: "user", content: "and more" }];
        await chat(rig, sid, h4, true, PLUGIN_TOOLS);
        const applied = rig.seen[before]!;
        assert.ok(applied.body.includes(SUMMARY.slice(0, 60)), "plugin mode renders the acp_summary carrier (call id never in host history)");
        assert.ok(!applied.body.includes("user turn 2:"));
        const block = sessionFor(sid)!.state.blocks.find((b) => b.active)!;
        assert.ok(block.compressCallId?.startsWith(ac.ASYNC_COMPRESS_CALL_ID_PREFIX));

        const restored = await pluginTool(rig, sid, "decompress", { blockId: block.blockId, full: true });
        assert.match(restoredText(restored.result ?? ""), /user turn 2:/, "decompress returns the originals");

        await flushAllSessions();
        _resetSessionsForTest();
        _setStoreForTest(new SessionStore({ dir, debounceMs: 0, enabled: true }));
        const after = rig.seen.length;
        await chat(rig, sid, [...h4, { role: "assistant", content: "ok" }, { role: "user", content: "after restart" }], true, PLUGIN_TOOLS);
        assert.ok(rig.seen[after]!.body.includes(SUMMARY.slice(0, 60)), "carrier survives restart in plugin mode");
    } finally {
        forkGate.release();
        await closeRig(rig);
    }
});

async function queueAndCapture(rig: Rig, sid: string, h: unknown[]): Promise<{ tag: string; withResult: unknown[] }> {
    await chat(rig, sid, [...h, { role: "user", content: "go on" }], true, PLUGIN_TOOLS);
    const queued = await pluginTool(rig, sid, "compress", { content: [] });
    const tag = /job (bg-[0-9a-f]+)/.exec(queued.result ?? "")?.[1];
    assert.ok(tag, `queued: ${queued.result}`);
    const withResult = [...h, { role: "user", content: "go on" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_c", type: "function", function: { name: "compress", arguments: "{\"content\":[]}" } }] },
        { role: "tool", tool_call_id: "call_c", content: queued.result }];
    await chat(rig, sid, withResult, true, PLUGIN_TOOLS);
    return { tag, withResult };
}

test("#3148 merge: an open upstream circuit fails fast before capture — the queued job is neither captured nor left running, and captures once the circuit closes", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    _resetUpstreamCircuitsForTest();
    const rig = await startRig();
    try {
        const sid = "circuit-open";
        const h = history(12);
        await chat(rig, sid, [...h, { role: "user", content: "go on" }], true, PLUGIN_TOOLS);
        const queued = await pluginTool(rig, sid, "compress", { content: [] });
        assert.match(queued.result ?? "", /job bg-[0-9a-f]+/);
        const withResult = [...h, { role: "user", content: "go on" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_c", type: "function", function: { name: "compress", arguments: "{\"content\":[]}" } }] },
            { role: "tool", tool_call_id: "call_c", content: queued.result }];
        const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
        for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(rig.base.slice(rig.base.indexOf("/bili/") + 6), refused, false);
        const before = rig.seen.length;
        const blocked = await chat(rig, sid, withResult, true, PLUGIN_TOOLS);
        assert.ok(blocked.status >= 500 || /upstream circuit open/.test(blocked.text), `fails fast: ${blocked.status} ${blocked.text.slice(0, 200)}`);
        assert.equal(rig.seen.length, before, "upstream not contacted: no main send, no background pass");
        const job = [...ac._asyncCompressStateForTest().jobs.values()].find((j) => j.sessionId === sessionFor(sid)!.id);
        assert.equal(job?.phase, "awaiting-capture", "not captured, not running");

        _resetUpstreamCircuitsForTest();
        await chat(rig, sid, withResult, true, PLUGIN_TOOLS);
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()].some((j) => j.sessionId === sessionFor(sid)!.id && j.phase === "ready"));
        assert.equal(rig.seen.filter((s) => s.fork).length, 1, "exactly one background pass after the circuit closes");
    } finally {
        _resetUpstreamCircuitsForTest();
        await closeRig(rig);
    }
});

function notesIn(rig: Rig, from: number, tag: string): number {
    return rig.seen.slice(from).filter((s) => !s.fork && s.body.includes(`job ${tag} did not apply`)).length;
}

test("failures owe exactly one note at the next request: fork HTTP error, extra tool call", async () => {
    ac.configureAsyncCompress({ failureBackoffMs: 60_000 });
    freshStore();
    const rig = await startRig();
    try {
        rig.setHandler(async (seen, res) => {
            if (seen.fork) { res.writeHead(500, { "content-type": "application/json" }); res.end("{\"error\":{\"message\":\"boom\"}}"); return; }
            openaiText(res, "ok");
        });
        const h = history(12);
        const { tag, withResult } = await queueAndCapture(rig, "fail-500", h);
        await waitFor(() => ac._asyncCompressStateForTest().notes.has(sessionFor("fail-500")!.id));
        const from = rig.seen.length;
        await chat(rig, "fail-500", [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }], true, PLUGIN_TOOLS);
        await chat(rig, "fail-500", [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }, { role: "assistant", content: "ok" }, { role: "user", content: "b" }], true, PLUGIN_TOOLS);
        assert.equal(notesIn(rig, from, tag), 1, "note delivered exactly once");
        assert.match(rig.seen[from]!.body, /HTTP 500/);
        const backoff = await pluginTool(rig, "fail-500", "compress", { content: [] });
        assert.match(backoff.result ?? "", /unavailable right now/, "trigger answers with sync guidance during backoff");
        const refs = refsOf(rig.seen[rig.seen.length - 1]!.body);
        const direct = await pluginTool(rig, "fail-500", "compress", { content: [{ startId: refs[1], endId: refs[6], summary: SUMMARY }] });
        assert.match(direct.result ?? "", /Compressed|block/i, "backoff never blocks a direct compress");

        rig.setHandler(defaultHandler(undefined, (refs) => [
            { name: "compress", args: { content: [{ startId: refs[1], endId: refs[4], summary: SUMMARY }] } },
            { name: "bash", args: { command: "rm -rf /tmp/x" } },
        ]));
        const second = await queueAndCapture(rig, "fail-extra", history(12, "x"));
        await waitFor(() => ac._asyncCompressStateForTest().notes.has(sessionFor("fail-extra")!.id));
        const f2 = rig.seen.length;
        await chat(rig, "fail-extra", [...second.withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }], true, PLUGIN_TOOLS);
        assert.match(rig.seen[f2]!.body, /non-compress tool/);
        assert.equal(sessionFor("fail-extra")!.state.blocks.length, 0, "nothing applied from an ambiguous fork reply");
    } finally {
        await closeRig(rig);
    }
});

test("bounded: an uncaptured job times out with a note; main HTTP failure before 2xx settles the job", async () => {
    ac.configureAsyncCompress({ captureTimeoutMs: 100 });
    freshStore();
    const rig = await startRig();
    try {
        const h = history(10);
        await chat(rig, "never-captured", [...h, { role: "user", content: "go on" }], true, PLUGIN_TOOLS);
        const queued = await pluginTool(rig, "never-captured", "compress", { content: [] });
        const tag = /job (bg-[0-9a-f]+)/.exec(queued.result ?? "")![1]!;
        await waitFor(() => ac._asyncCompressStateForTest().jobs.size === 0, 2000);
        const from = rig.seen.length;
        await chat(rig, "never-captured", [...h, { role: "user", content: "unrelated" }], true, PLUGIN_TOOLS);
        assert.equal(notesIn(rig, from, tag), 1);
        assert.match(rig.seen[from]!.body, /no follow-up request captured/);

        ac.configureAsyncCompress({});
        rig.setHandler(async (seen, res) => {
            if (seen.body.includes("Background compression queued")) { res.writeHead(500, { "content-type": "application/json" }); res.end("{}"); return; }
            openaiText(res, "ok");
        });
        const { tag: t2, withResult } = await queueAndCapture(rig, "main-500", history(10, "y"));
        assert.ok(!rig.seen.some((s) => s.fork), "no fork after a failed main send");
        const f2 = rig.seen.length;
        rig.setHandler(defaultHandler());
        await chat(rig, "main-500", [...withResult.slice(0, -2), { role: "user", content: "retry" }], true, PLUGIN_TOOLS);
        assert.equal(notesIn(rig, f2, t2), 1);
        assert.match(rig.seen[f2]!.body, /HTTP 500/);
    } finally {
        await closeRig(rig);
    }
});

test("stale: a direct compress supersedes; an edited cited span is discarded with a note", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    const g = gate();
    rig.setHandler(defaultHandler(g.promise));
    try {
        const h = history(16);
        const { tag, withResult } = await queueAndCapture(rig, "supersede", h);
        await waitFor(() => rig.seen.some((s) => s.fork));
        const refs = refsOf(rig.seen.find((s) => s.fork)!.body);
        await pluginTool(rig, "supersede", "compress", { content: [{ startId: refs[1], endId: refs[6], summary: SUMMARY }] });
        g.release();
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(ac._asyncCompressStateForTest().jobs.size, 0, "pending job dropped by the direct fold");
        const from = rig.seen.length;
        await chat(rig, "supersede", [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }], true, PLUGIN_TOOLS);
        assert.equal(notesIn(rig, from, tag), 1);
        assert.match(rig.seen[from]!.body, /superseded/);
        assert.equal(sessionFor("supersede")!.state.blocks.filter((b) => b.active).length, 1, "only the direct fold");

        rig.setHandler(defaultHandler());
        const e = await queueAndCapture(rig, "edited", history(16, "e"));
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const edited = structuredClone(e.withResult) as Array<Record<string, unknown>>;
        edited[3] = { role: "assistant", content: "rewritten by the host" };
        const f2 = rig.seen.length;
        await chat(rig, "edited", [...edited, { role: "assistant", content: "ok" }, { role: "user", content: "a" }], true, PLUGIN_TOOLS);
        assert.match(rig.seen[f2]!.body, /discarded/);
        assert.equal(sessionFor("edited")!.state.blocks.length, 0);
    } finally {
        g.release();
        await closeRig(rig);
    }
});

test("sessions stay independent and append-only turns keep each snapshot valid", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    const g = gate();
    rig.setHandler(defaultHandler(g.promise));
    try {
        const a = await queueAndCapture(rig, "multi-a", history(16, "A"));
        const b = await queueAndCapture(rig, "multi-b", history(16, "B"));
        await waitFor(() => rig.seen.filter((s) => s.fork).length === 2);
        g.release();
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()].filter((j) => j.phase === "ready").length === 2);
        const longer = [...a.withResult, { role: "assistant", content: "ok" }, { role: "user", content: "x" }, { role: "assistant", content: "ok" }, { role: "user", content: "y" }];
        await chat(rig, "multi-a", longer, true, PLUGIN_TOOLS);
        const sa = sessionFor("multi-a")!;
        const sb = sessionFor("multi-b")!;
        assert.equal(sa.state.blocks.filter((x) => x.active).length, 1, "applied after append-only turns");
        assert.equal(sb.state.blocks.length, 0, "other session untouched until its own next request");
        await chat(rig, "multi-b", [...b.withResult, { role: "assistant", content: "ok" }, { role: "user", content: "z" }], true, PLUGIN_TOOLS);
        assert.match(sa.state.blocks.find((x) => x.active)!.summary, /\[owner:A\]/);
        assert.match(sb.state.blocks.find((x) => x.active)!.summary, /\[owner:B\]/);
    } finally {
        g.release();
        await closeRig(rig);
    }
});

test("policy: client abort of the captured request after the fork launched does not cancel the fork", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    const mainHold = gate();
    rig.setHandler(async (seen, res) => {
        if (seen.fork) { openaiCalls(res, [{ name: "compress", args: { content: [{ startId: refsOf(seen.body)[1], endId: refsOf(seen.body)[5], summary: SUMMARY }] } }]); return; }
        if (seen.body.includes("Background compression queued")) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "par" }, finish_reason: null }] }));
            await mainHold.promise;
            res.end();
            return;
        }
        openaiText(res, "ok");
    });
    try {
        const h = history(16);
        await chat(rig, "abort-1", [...h, { role: "user", content: "go on" }], true, PLUGIN_TOOLS);
        const queued = await pluginTool(rig, "abort-1", "compress", { content: [] });
        const withResult = [...h, { role: "user", content: "go on" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_c", type: "function", function: { name: "compress", arguments: "{\"content\":[]}" } }] },
            { role: "tool", tool_call_id: "call_c", content: queued.result }];
        const ctl = new AbortController();
        const main = chat(rig, "abort-1", withResult, true, PLUGIN_TOOLS, ctl.signal).catch((e: unknown) => e);
        await waitFor(() => rig.seen.some((s) => s.fork));
        ctl.abort();
        await main;
        mainHold.release();
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        await chat(rig, "abort-1", [...h, { role: "user", content: "retry after abort" }], true, PLUGIN_TOOLS);
        assert.equal(sessionFor("abort-1")!.state.blocks.filter((b) => b.active).length, 1, "fork result applied despite the client abort");
    } finally {
        mainHold.release();
        await closeRig(rig);
    }
});

test("bounded: a fork that never answers times out with a note and releases the job", async () => {
    ac.configureAsyncCompress({ forkTimeoutMs: 150 });
    freshStore();
    const rig = await startRig();
    const never = gate();
    rig.setHandler(defaultHandler(never.promise));
    try {
        const { tag, withResult } = await queueAndCapture(rig, "fork-timeout", history(12));
        await waitFor(() => rig.seen.some((s) => s.fork));
        await waitFor(() => ac._asyncCompressStateForTest().jobs.size === 0, 3000);
        rig.setHandler(defaultHandler());
        const from = rig.seen.length;
        await chat(rig, "fork-timeout", [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }], true, PLUGIN_TOOLS);
        assert.equal(notesIn(rig, from, tag), 1);
        assert.match(rig.seen[from]!.body, /timed out|cancelled/);
    } finally {
        never.release();
        await closeRig(rig);
    }
});

function anthropicSse(res: http.ServerResponse, block: { text?: string; tool?: { name: string; input: unknown } }): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    ev("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 100 } } });
    if (block.tool) {
        const json = JSON.stringify(block.tool.input);
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_f", name: block.tool.name, input: {} } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 15) } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(15) } });
        ev("content_block_stop", { type: "content_block_stop", index: 0 });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
    } else {
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text ?? "ok" } });
        ev("content_block_stop", { type: "content_block_stop", index: 0 });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    }
    ev("message_stop", { type: "message_stop" });
    res.end();
}

test("anthropic plugin wire: fork replays signed thinking, tool_use input, system and tools unchanged; result applies", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    rig.setHandler((seen, res) => {
        if (seen.fork) {
            const refs = refsOf(seen.body);
            anthropicSse(res, { tool: { name: "compress", input: { content: [{ startId: refs[1], endId: refs[5], summary: SUMMARY }] } } });
        } else anthropicSse(res, { text: "ok" });
    });
    const tools = [{ name: "compress", description: "c", input_schema: { type: "object", properties: { content: {} } } }, { name: "bash", description: "b", input_schema: { type: "object", properties: { command: { type: "string" } } } }];
    const system = [{ type: "text", text: "You are a careful agent.", cache_control: { type: "ephemeral" } }];
    const post = async (messages: unknown[]) => {
        const r = await fetch(`${rig.wireBase}/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "anth-1", "x-bili-plugin": "test-agent", "x-api-key": "test-secret-key", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 64_000, stream: true, system, tools, thinking: { type: "enabled", budget_tokens: 2048 }, messages }) });
        await r.text();
    };
    try {
        const h = history(14);
        await post([...h, { role: "user", content: "go on" }]);
        const queued = await pluginTool(rig, "anth-1", "compress", { content: [] });
        const thinking = { type: "thinking", thinking: "I should queue background compression first.", signature: "EqQBCkYIBRgCKkB+sig/==" };
        const toolUse = { type: "tool_use", id: "toolu_c", name: "compress", input: { content: [] } };
        const bashUse = { type: "tool_use", id: "toolu_b", name: "bash", input: { command: "grep -rn \"\\x3cacp\" src | head -n 3 && echo 'done'" } };
        const withResult = [...h, { role: "user", content: "go on" },
            { role: "assistant", content: [thinking, bashUse, toolUse] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", content: "src/x.ts:1" }, { type: "tool_result", tool_use_id: "toolu_c", content: queued.result }] }];
        await post(withResult);
        await waitFor(() => rig.seen.some((s) => s.fork));
        const captured = rig.seen.find((s) => !s.fork && s.body.includes("Background compression queued"))!;
        const fork = rig.seen.find((s) => s.fork)!;
        const cm = captured.parsed.messages as unknown[];
        const fm = fork.parsed.messages as unknown[];
        assert.deepEqual(fm.slice(0, cm.length), cm);
        assert.equal(fm.length, cm.length + 1);
        assert.deepEqual(fork.parsed.system, captured.parsed.system);
        assert.deepEqual(fork.parsed.tools, captured.parsed.tools);
        assert.deepEqual(fork.parsed.thinking, captured.parsed.thinking);
        const sentAssistant = JSON.stringify(cm[cm.length - 2]);
        assert.ok(sentAssistant.includes(JSON.stringify(thinking.signature)) && sentAssistant.includes(JSON.stringify(bashUse.input.command)), "signed thinking + tool args forwarded verbatim");
        assert.equal(JSON.stringify(fm[cm.length - 2]), sentAssistant);
        assert.equal(fork.headers["x-api-key"], "test-secret-key");
        assert.equal(fork.headers["content-length"], String(Buffer.byteLength(fork.body)), "fresh content-length for the new body");
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const from = rig.seen.length;
        await post([...withResult, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: "next" }]);
        assert.ok(rig.seen[from]!.body.includes(SUMMARY.slice(0, 60)), "carrier on the anthropic wire");
        assert.equal(sessionFor("anth-1")!.state.blocks.filter((b) => b.active).length, 1);
    } finally {
        await closeRig(rig);
    }
});

function responsesSse(res: http.ServerResponse, out: { text?: string; call?: { name: string; args: string } }, idx: number): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const blk = (type: string, data: Record<string, unknown>): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
    blk("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } });
    if (out.call) {
        const item = { type: "function_call", id: `fc_${idx}`, call_id: `call_${idx}`, name: out.call.name, arguments: out.call.args, status: "completed" };
        blk("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
        blk("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: out.call.args });
        blk("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: out.call.args });
        blk("response.output_item.done", { output_index: 0, item });
        blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } });
    } else {
        const text = out.text ?? "ok";
        const item = { type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
        blk("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        blk("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text });
        blk("response.output_text.done", { item_id: item.id, output_index: 0, text });
        blk("response.output_item.done", { output_index: 0, item });
        blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } } });
    }
    res.end();
}

test("Codex-shaped Responses over HTTP (proxy mode, not a real codex binary): queued, captured round 2, applied next turn", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    let idx = 0;
    rig.setHandler((seen, res) => {
        idx++;
        const input = seen.parsed.input as Array<Record<string, unknown>>;
        const last = input[input.length - 1]!;
        if (seen.fork) {
            const refs = refsOf(seen.body);
            responsesSse(res, { call: { name: "compress", args: JSON.stringify({ content: [{ startId: refs[1], endId: refs[5], summary: SUMMARY }] }) } }, idx);
        } else if (last.role === "user" && JSON.stringify(last).includes("TRIGGER")) responsesSse(res, { call: { name: "compress", args: "{\"content\":[]}" } }, idx);
        else responsesSse(res, { text: "ok" }, idx);
    });
    const items: unknown[] = [];
    for (let i = 0; i < 14; i++) {
        items.push({ type: "message", role: "user", content: [{ type: "input_text", text: `user turn ${i}: ${FILLER.repeat(12)}` }] });
        items.push({ type: "reasoning", id: `rs_${i}`, summary: [], encrypted_content: `gAAAAAenc${i}==` });
        items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `assistant reply ${i}: ${FILLER.repeat(12)}` }] });
    }
    const post = async (input: unknown[]) => {
        const r = await fetch(`${rig.wireBase}/responses`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "codex-1", authorization: "Bearer test-secret-key", "user-agent": "codex_cli_rs/0.150.0", originator: "codex_cli_rs" },
            body: JSON.stringify({ model: "gpt-test", instructions: "You are Codex.", store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: "codex-1", parallel_tool_calls: false, tool_choice: "auto", reasoning: { effort: "medium" }, max_output_tokens: 64_000,
                tools: [{ type: "function", name: "shell", description: "run", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } } } }], input }) });
        return { status: r.status, text: await r.text() };
    };
    try {
        const t1 = await post([...items, { type: "message", role: "user", content: [{ type: "input_text", text: "TRIGGER" }] }]);
        assert.equal(t1.status, 200);
        await waitFor(() => rig.seen.some((s) => s.fork));
        const round2 = rig.seen.find((s) => !s.fork && s.body.includes("Background compression queued"))!;
        const fork = rig.seen.find((s) => s.fork)!;
        const r2 = round2.parsed.input as unknown[];
        assert.deepEqual((fork.parsed.input as unknown[]).slice(0, r2.length), r2, "encrypted reasoning items replayed unchanged");
        assert.equal(fork.parsed.prompt_cache_key, round2.parsed.prompt_cache_key);
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const from = rig.seen.length;
        await post([...items, { type: "message", role: "user", content: [{ type: "input_text", text: "TRIGGER" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }]);
        assert.ok(rig.seen[from]!.body.includes(SUMMARY.slice(0, 60)), "carrier on the Responses wire");
        assert.ok(!rig.seen[from]!.body.includes("user turn 2:"));
    } finally {
        await closeRig(rig);
    }
});

test("model switch between capture and apply discards with a note", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    try {
        const { tag, withResult } = await queueAndCapture(rig, "switch", history(16));
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const from = rig.seen.length;
        const res = await fetch(rig.base, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "switch", "x-bili-plugin": "test-agent" },
            body: JSON.stringify({ model: "other-model", max_tokens: 64_000, stream: true, tools: PLUGIN_TOOLS, messages: [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }] }) });
        await res.text();
        assert.equal(notesIn(rig, from, tag), 1);
        assert.match(rig.seen[from]!.body, /model changed/);
        assert.equal(sessionFor("switch")!.state.blocks.length, 0);
    } finally {
        await closeRig(rig);
    }
});

test("capture eligibility is deny-by-default: provider-hosted tools and capability keys decline, plain functions pass", () => {
    const url = "http://127.0.0.1:1/v1";
    const fn = { type: "function", function: { name: "compress", parameters: {} } };
    assert.equal(ac.declineReason("openai", { messages: [], tools: [fn, { type: "custom", custom: { name: "patch" } }] }, url, false), null);
    assert.match(ac.declineReason("openai", { messages: [], tools: [fn], web_search_options: {} }, url, false) ?? "", /hosted.*web_search_options/);
    assert.match(ac.declineReason("openai", { messages: [], tools: [fn], plugins: [{ id: "web" }] }, url, false) ?? "", /hosted.*plugins/);
    assert.match(ac.declineReason("openai", { messages: [], tools: [fn, { type: "web_search" }] }, url, false) ?? "", /hosted.*web_search/);
    const rfn = { type: "function", name: "compress", parameters: {} };
    assert.equal(ac.declineReason("responses", { input: [], tools: [rfn, { type: "custom", name: "apply_patch" }] }, url, false), null);
    for (const type of ["web_search", "web_search_preview", "file_search", "code_interpreter", "mcp", "image_generation", "computer_use_preview", "local_shell", "something_new"]) {
        assert.match(ac.declineReason("responses", { input: [], tools: [rfn, { type }] }, url, false) ?? "", new RegExp(`hosted.*${type}`), type);
    }
    assert.match(ac.declineReason("responses", { input: [], tools: [rfn], background: true }, url, false) ?? "", /hosted.*background/);
    const afn = { name: "compress", input_schema: {} };
    assert.equal(ac.declineReason("anthropic", { messages: [], tools: [afn, { type: "custom", name: "bash", input_schema: {} }] }, url, false), null);
    for (const type of ["web_search_20250305", "web_fetch_20250910", "code_execution_20250825", "bash_20250124", "text_editor_20250728", "computer_20250124"]) {
        assert.match(ac.declineReason("anthropic", { messages: [], tools: [afn, { type, name: "x" }] }, url, false) ?? "", /hosted/, type);
    }
    assert.match(ac.declineReason("anthropic", { messages: [], tools: [afn], mcp_servers: [{ type: "url", url: "https://x" }] }, url, false) ?? "", /hosted.*mcp_servers/);
    assert.match(ac.declineReason("anthropic", { messages: [], tools: [afn], container: "c1" }, url, false) ?? "", /hosted.*container/);
    const gfn = { functionDeclarations: [{ name: "compress" }] };
    assert.equal(ac.declineReason("google", { contents: [], tools: [gfn] }, url, false), null);
    for (const tool of [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: {} }, { googleSearchRetrieval: {} }, { functionDeclarations: [{ name: "compress" }], googleSearch: {} }]) {
        assert.match(ac.declineReason("google", { contents: [], tools: [gfn, tool] }, url, false) ?? "", /hosted/, JSON.stringify(tool));
    }
    assert.match(ac.declineReason("google", { contents: [], tools: [gfn], cachedContent: "cachedContents/1" }, url, false) ?? "", /hosted.*cachedContent/);
});

test("fork reply guard: provider-run items reject; prose, thinking and the compress call pass", () => {
    assert.equal(ac.hostedOutput("responses", { type: "response.output_item.added", item: { type: "reasoning" } }), null);
    assert.equal(ac.hostedOutput("responses", { output: [{ type: "reasoning" }, { type: "message" }, { type: "function_call" }] }), null);
    assert.match(ac.hostedOutput("responses", { type: "response.output_item.added", item: { type: "web_search_call" } }) ?? "", /web_search_call/);
    assert.match(ac.hostedOutput("responses", { type: "response.completed", response: { output: [{ type: "message" }, { type: "mcp_call" }] } }) ?? "", /mcp_call/);
    assert.equal(ac.hostedOutput("anthropic", { type: "content_block_start", content_block: { type: "thinking" } }), null);
    assert.equal(ac.hostedOutput("anthropic", { content: [{ type: "text" }, { type: "redacted_thinking" }, { type: "tool_use" }] }), null);
    assert.match(ac.hostedOutput("anthropic", { type: "content_block_start", content_block: { type: "server_tool_use" } }) ?? "", /server_tool_use/);
    assert.match(ac.hostedOutput("anthropic", { content: [{ type: "web_search_tool_result" }] }) ?? "", /web_search_tool_result/);
    assert.equal(ac.hostedOutput("google", { candidates: [{ content: { parts: [{ text: "x", thought: true, thoughtSignature: "s" }, { functionCall: { name: "compress" } }] } }] }), null);
    assert.match(ac.hostedOutput("google", { candidates: [{ content: { parts: [{ executableCode: {} }] } }] }) ?? "", /executableCode/);
    assert.match(ac.hostedOutput("google", { candidates: [{ content: { parts: [{ text: "x" }] }, groundingMetadata: {} }] }) ?? "", /groundingMetadata/);
});

function countingStream(chunk: number, opts: { endless?: boolean; chunks?: number } = {}) {
    const stats = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!opts.endless && stats.pulled >= (opts.chunks ?? 0)) { controller.close(); return; }
            stats.pulled++;
            controller.enqueue(new Uint8Array(chunk).fill(0x61));
        },
        cancel() { stats.cancelled = true; },
    }, { highWaterMark: 0 });
    return { stream, stats };
}

test("fork reply read is bounded: an endless stream is cancelled at the limit, not drained", async () => {
    const { stream, stats } = countingStream(1024, { endless: true });
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    assert.equal(await ac.readForkCalls("responses", { input: [] }, response, 4096), "fork reply too large");
    assert.ok(stats.cancelled, "the upstream stream is cancelled");
    assert.ok(stats.pulled <= 6, `pulled ${stats.pulled} chunks past a 4-chunk limit`);
    assert.equal(stream.locked, false, "the reader lock is released");
    const exact = countingStream(1024, { chunks: 4 });
    const bytes = await ac.readBounded(exact.stream, 4096);
    assert.equal(bytes?.byteLength, 4096);
    assert.ok(bytes!.every((b) => b === 0x61));
    assert.equal(exact.stats.cancelled, false);
    assert.equal(exact.stream.locked, false);
});

test("fork reply read honours an abort mid-stream and releases the reader", async () => {
    const controller = new AbortController();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(c) {
            pulls++;
            if (pulls === 3) { controller.abort(); c.error(new DOMException("aborted", "AbortError")); return; }
            c.enqueue(new Uint8Array(16));
        },
    }, { highWaterMark: 0 });
    await assert.rejects(ac.readBounded(stream, 1 << 20), (err: unknown) => err instanceof DOMException && err.name === "AbortError");
    assert.equal(pulls, 3);
    assert.equal(stream.locked, false);
});

function responsesSseText(items: Array<Record<string, unknown>>): string {
    const blk = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    let out = blk("response.created", { response: { id: "resp_t", status: "in_progress" } });
    items.forEach((item, output_index) => {
        out += blk("response.output_item.added", { output_index, item });
        if (item.type === "function_call") out += blk("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.arguments });
        out += blk("response.output_item.done", { output_index, item });
    });
    return out + blk("response.completed", { response: { id: "resp_t", status: "completed", output: items, usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } });
}

function fragmentedResponse(text: string, sizes: number[], headers: Record<string, string>): Response {
    const bytes = new TextEncoder().encode(text);
    const parts: Uint8Array[] = [];
    let at = 0;
    for (const n of sizes) { parts.push(bytes.slice(at, at + n)); at += n; }
    if (at < bytes.length) parts.push(bytes.slice(at));
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (i < parts.length) c.enqueue(parts[i++]!); else c.close(); } }, { highWaterMark: 0 }), { headers });
}

const FORK_CALL = { type: "function_call", id: "fc_t", call_id: "call_t", name: "compress", status: "completed", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "S" }] }) };

test("fork reply framing: a stream is read as a stream whatever its content-type says", async () => {
    const body = responsesSseText([{ type: "reasoning", id: "rs_t", summary: [] }, FORK_CALL]);
    const cases: Array<[string, Record<string, string>, string, number[]]> = [
        ["application/json", { "content-type": "application/json" }, body, []],
        ["missing", {}, body, []],
        ["mixed case + params", { "content-type": "Text/Event-Stream; Charset=UTF-8" }, body, []],
        ["BOM + leading comment + blank lines, first line fragmented", { "content-type": "application/json" }, `\uFEFF: keepalive\n\n\r\n${body}`, [1, 2, 1, 3, 5, 2]],
        ["text/plain, data line split mid-field", { "content-type": "text/plain" }, body.replace(/^event: [^\n]*\n/, ""), [2, 1, 1]],
    ];
    for (const [label, headers, text, sizes] of cases) {
        const calls = await ac.readForkCalls("responses", { input: [] }, fragmentedResponse(text, sizes, headers));
        assert.ok(Array.isArray(calls), `${label}: ${String(calls)}`);
        assert.deepEqual(calls, [{ name: "compress", arguments: FORK_CALL.arguments }], label);
    }
});

test("fork reply framing: JSON fallback is kept and the hosted-item guard holds on the sniffed path", async () => {
    const json = JSON.stringify({ id: "resp_j", status: "completed", output: [{ type: "message", role: "assistant", content: [] }, FORK_CALL] });
    for (const type of ["text/plain", "application/json", "other/thing"]) {
        assert.deepEqual(await ac.readForkCalls("responses", { input: [] }, new Response(json, { headers: { "content-type": type } })), [{ name: "compress", arguments: FORK_CALL.arguments }], type);
    }
    const hostedJson = JSON.stringify({ output: [{ type: "web_search_call" }, FORK_CALL] });
    assert.match(String(await ac.readForkCalls("responses", { input: [] }, new Response(hostedJson, { headers: { "content-type": "text/plain" } }))), /provider-hosted item/);
    const hostedSse = responsesSseText([{ type: "web_search_call", id: "ws_t", status: "completed" }, FORK_CALL]);
    for (const headers of [{ "content-type": "application/json" }, {}] as Array<Record<string, string>>) {
        assert.match(String(await ac.readForkCalls("responses", { input: [] }, fragmentedResponse(`: ping\n\n${hostedSse}`, [3, 4], headers))), /provider-hosted item \(.*web_search_call\)/);
    }
});

test("fork reply framing: an unreadable reply is dropped with enum labels only, never body or header text", async () => {
    const CANARY = "CANARY-c7e1-SECRET";
    const html = `<!doctype html><html><body>${CANARY}</body></html>`;
    const cases: Array<[Record<string, string>, string, string]> = [
        [{ "content-type": "text/html; charset=utf-8" }, html, "type=text/html framing=html"],
        [{ "content-type": `application/vnd.${CANARY}+json` }, `${CANARY} plain`, "type=other framing=other"],
        [{ "content-type": `text/${CANARY}` }, `{"broken": "${CANARY}`, "type=other framing=json"],
        [{}, "", "type=none framing=empty"],
        [{ "content-type": "application/json" }, " \n\r\n ", "type=application/json framing=empty"],
    ];
    for (const [headers, text, labels] of cases) {
        const reason = await ac.readForkCalls("responses", { input: [] }, new Response(new TextEncoder().encode(text), { headers }));
        assert.equal(reason, `fork reply was neither a stream nor JSON (${labels} bytes=${Buffer.byteLength(text)})`);
        assert.ok(!String(reason).includes(CANARY));
    }
    assert.equal(ac.mediaTypeClass(null), "none");
    assert.equal(ac.mediaTypeClass("Application/Problem+JSON ; x=1"), "application/problem+json");
    assert.equal(ac.mediaTypeClass("application/json-seq"), "other");
});

test("Codex-shaped HTTP fork answered as a stream labelled application/json: summary applies and decompress restores (mock; no cache evidence)", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    try {
        let idx = 0;
        rig.setHandler((seen, res) => {
            idx++;
            const input = seen.parsed.input as Array<Record<string, unknown>>;
            const last = input[input.length - 1]!;
            if (seen.fork) {
                const refs = refsOf(seen.body);
                res.writeHead(200, { "content-type": "application/json" });
                res.write(": keepalive\n\n");
                res.end(responsesSseText([{ ...FORK_CALL, arguments: JSON.stringify({ content: [{ startId: refs[1], endId: refs[5], summary: SUMMARY }] }) }]));
            } else if (last.role === "user" && JSON.stringify(last).includes("TRIGGER")) responsesItemsSse(res, [{ type: "function_call", id: `fc_${idx}`, call_id: `call_${idx}`, name: "compress", arguments: "{\"content\":[]}", status: "completed" }], idx);
            else responsesItemsSse(res, [{ type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }], idx);
        });
        const items = codexItems();
        await postResponses(rig, "ct-json", [...items, { type: "message", role: "user", content: [{ type: "input_text", text: "TRIGGER" }] }]);
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const fork = rig.seen.find((s) => s.fork)!;
        const trigger = rig.seen.find((s) => !s.fork && s.body.includes("TRIGGER"))!;
        assert.deepEqual(fork.parsed.tool_choice, { type: "function", name: "compress" }, "the background request names compress");
        assert.equal(trigger.parsed.tool_choice, "auto", "the main request keeps its own tool_choice");
        assert.equal(JSON.stringify(fork.parsed.tools), JSON.stringify(trigger.parsed.tools), "the tools list is replayed byte-identical");
        const from = rig.seen.length;
        await postResponses(rig, "ct-json", [...items, { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }]);
        const session = sessionFor("ct-json")!;
        const block = session.state.blocks.find((b) => b.active);
        assert.ok(block, "the fork summary was applied");
        assert.ok(block!.compressCallId?.startsWith(ac.ASYNC_COMPRESS_CALL_ID_PREFIX));
        assert.ok(rig.seen[from]!.body.includes(SUMMARY.slice(0, 60)), "the applied request carries the summary");
        assert.ok(!rig.seen[from]!.body.includes("user turn 2:"), "the folded span left the wire");
        const restored = await pluginTool(rig, "ct-json", "decompress", { blockId: block!.blockId, full: true });
        assert.match(restoredText(restored.result ?? ""), /user turn 2:/, "decompress restores the folded originals");
    } finally {
        await closeRig(rig);
    }
});

function responsesCapture(compressDecl: Record<string, unknown>): Record<string, unknown> {
    return {
        model: "gpt-test", instructions: "You are Codex.", store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: "pck-1",
        tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: "medium", summary: "auto" },
        tools: [
            { type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" }, nested: { type: "object", properties: { a: { type: "array", items: { type: "string" } } } } } }, strict: null },
            compressDecl,
            { type: "custom", name: "apply", description: "free-form" },
        ],
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "task m00001" }] },
            { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAB-opaque==" },
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{\"path\":\"a\\\"b\",\"nested\":{\"a\":[\"x\"]}}", status: "completed" },
            { type: "function_call_output", call_id: "call_1", output: "file body" },
        ],
    };
}

test("Responses background request names compress in tool_choice; every other byte is the captured body plus the directive", () => {
    for (const [decl, choice] of [
        [{ type: "function", name: "compress", description: "fold", parameters: { type: "object", properties: { content: { type: "array" } } } }, { type: "function", name: "compress" }],
        [{ type: "custom", name: "compress", description: "fold" }, { type: "custom", name: "compress" }],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
        const body = responsesCapture(decl);
        const before = JSON.stringify(body);
        const fork = ac.forkRequestBody("responses", body, "DIRECTIVE");
        assert.equal(JSON.stringify(body), before, "the captured body is not mutated");
        assert.deepEqual(Object.keys(fork), Object.keys(body), "same keys, same order");
        for (const key of Object.keys(body)) {
            if (key === "input" || key === "tool_choice") continue;
            assert.equal(JSON.stringify(fork[key]), JSON.stringify(body[key]), `${key} is byte-identical`);
        }
        assert.deepEqual(fork.tool_choice, choice);
        const input = fork.input as unknown[];
        assert.equal(JSON.stringify(input.slice(0, -1)), JSON.stringify(body.input), "input prefix (signed/encrypted items, tool args) is byte-identical");
        assert.deepEqual(input[input.length - 1], { type: "message", role: "user", content: [{ type: "input_text", text: "DIRECTIVE" }] });
        assert.equal(ac.declineReason("responses", body, "http://up/v1/responses", false), null);
    }
});

test("non-Responses wires get exactly the appended directive and no tool_choice change", () => {
    const cases: Array<["anthropic" | "openai" | "google", Record<string, unknown>]> = [
        ["anthropic", { model: "m", tools: [{ name: "compress", input_schema: { type: "object" } }], messages: [{ role: "user", content: [{ type: "text", text: "t" }] }, { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "sig==" }, { type: "tool_use", id: "tu1", name: "read", input: { path: "a" } }] }] }],
        ["openai", { model: "m", tool_choice: "auto", tools: [{ type: "function", function: { name: "compress", parameters: {} } }], messages: [{ role: "user", content: "t" }] }],
        ["google", { tools: [{ functionDeclarations: [{ name: "compress" }] }], contents: [{ role: "model", parts: [{ text: "a", thoughtSignature: "ts==" }] }] }],
    ];
    for (const [protocol, body] of cases) {
        const before = JSON.stringify(body);
        const fork = ac.forkRequestBody(protocol, body, "DIRECTIVE");
        assert.equal(JSON.stringify(body), before, `${protocol}: captured body not mutated`);
        assert.equal(JSON.stringify(fork), JSON.stringify(ac.appendUserText(protocol, body, "DIRECTIVE")), `${protocol}: only the directive is appended`);
        assert.equal(ac.forcedCompressChoice(protocol, body), undefined);
    }
});

test("Responses capture is declined when compress cannot be named, and a client-forced tool_choice stays declined", () => {
    const url = "http://up/v1/responses";
    const nested = responsesCapture({ type: "function", function: { name: "compress" } });
    assert.match(ac.declineReason("responses", nested, url, false) ?? "", /cannot be named in tool_choice/);
    const flat = responsesCapture({ type: "function", name: "compress" });
    assert.match(ac.declineReason("responses", { ...flat, tool_choice: "required" }, url, false) ?? "", /tool_choice required/);
    assert.match(ac.declineReason("responses", { ...flat, tool_choice: { type: "function", name: "read" } }, url, false) ?? "", /tool_choice function/);
    assert.match(ac.declineReason("responses", { ...flat, tool_choice: { type: "function", name: "compress" } }, url, false) ?? "", /tool_choice function/);
    assert.match(ac.declineReason("responses", { ...flat, tools: [{ type: "function", name: "read" }] }, url, false) ?? "", /not declared/);
});

test("the named tool_choice does not relax the exactly-one-compress rule", () => {
    const names = ["read", "compress"];
    const ok = { name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "S" }] }) };
    assert.match(String(ac.rangesFromForkCalls([ok, { name: "read", arguments: "{}" }], names)), /non-compress tool \(names=read; compress calls=1\)/);
    assert.match(String(ac.rangesFromForkCalls([{ name: "read", arguments: "{}" }], names)), /non-compress tool \(names=read; compress calls=0\)/);
    assert.match(String(ac.rangesFromForkCalls([ok, ok], names)), /compress/);
    assert.ok(typeof ac.rangesFromForkCalls([ok], names) !== "string");
});

test("fork headers drop idempotency keys case-insensitively and keep credentials", () => {
    const out = ac.forkHeaders({ "Idempotency-Key": "a", "X-Idempotency-Key": "b", "idempotency-key": "c", Authorization: "Bearer k", "Content-Length": "9", "x-api-key": "k2" });
    assert.deepEqual(out, { Authorization: "Bearer k", "x-api-key": "k2" });
});

test("capture correlates the exact trigger result with its own compress call on every wire", () => {
    const job = { resultText: "Background compression queued (job bg-1234abcd): rest." };
    const trig = "{\"content\":[]}";
    const openai = (callId: string, resultId: string, args = trig) => ({ messages: [{ role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "compress", arguments: args } }] },
        { role: "tool", tool_call_id: resultId, content: `${job.resultText} \x3cacp tokens="5" type="tool"\x3em00009\x3c/acp\x3e` }] });
    assert.equal(ac.carriesTriggerResult("openai", openai("c1", "c1"), job), true);
    assert.equal(ac.carriesTriggerResult("openai", openai("c1", "c1"), { ...job, callId: "c1" }), true);
    assert.equal(ac.carriesTriggerResult("openai", openai("c1", "c1"), { ...job, callId: "c2" }), false, "known call id must match");
    assert.equal(ac.carriesTriggerResult("openai", openai("c1", "c2"), job), false, "result answers a different call");
    assert.equal(ac.carriesTriggerResult("openai", openai("c1", "c1", "{\"content\":[{\"startId\":\"m1\",\"endId\":\"m2\",\"summary\":\"s\"}]}"), job), false, "paired call is not a trigger");
    const plain = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: `pasted: ${job.resultText}` }] };
    assert.equal(ac.carriesTriggerResult("openai", plain, job), false, "plain user text never captures");
    const anthropic = { messages: [{ role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "tool_use", id: "tu1", name: "compress", input: { content: [] } }] },
        { role: "user", content: [{ type: "text", text: job.resultText }, { type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: job.resultText }] }] }] };
    assert.equal(ac.carriesTriggerResult("anthropic", anthropic, { ...job, callId: "tu1" }), true);
    const anthropicTextOnly = structuredClone(anthropic);
    (anthropicTextOnly.messages[2]!.content as unknown[]).splice(1, 1);
    assert.equal(ac.carriesTriggerResult("anthropic", anthropicTextOnly, job), false, "a text block beside the tool results is not a result");
    const responses = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "reasoning", encrypted_content: "e" },
        { type: "function_call", call_id: "fc1", name: "compress", arguments: trig }, { type: "function_call_output", call_id: "fc1", output: job.resultText }] };
    assert.equal(ac.carriesTriggerResult("responses", responses, { ...job, callId: "fc1" }), true);
    assert.equal(ac.carriesTriggerResult("responses", responses, { ...job, callId: "fc9" }), false);
    const google = (fcId?: string, frId?: string, name = "compress") => ({ contents: [{ role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ functionCall: { ...(fcId ? { id: fcId } : {}), name: "compress", args: { content: [] } } }] },
        { role: "user", parts: [{ functionResponse: { ...(frId ? { id: frId } : {}), name, response: { result: job.resultText } } }] }] });
    assert.equal(ac.carriesTriggerResult("google", google("g1", "g1"), { ...job, callId: "g1" }), true);
    assert.equal(ac.carriesTriggerResult("google", google(), job), true, "id-less Gemini pairs by name within the answered turn");
    assert.equal(ac.carriesTriggerResult("google", google(undefined, undefined, "bash"), job), false);
    assert.equal(ac.carriesTriggerResult("google", google("g1", "g2"), job), false);
});

test("plugin mode: the result text pasted as user text or answering another call id is never captured", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    try {
        const h = history(12);
        await chat(rig, "loose-1", [...h, { role: "user", content: "go on" }], true, PLUGIN_TOOLS);
        const queued = await pluginTool(rig, "loose-1", "compress", { content: [] });
        assert.match(queued.result ?? "", /queued/);
        await chat(rig, "loose-1", [...h, { role: "user", content: "go on" }, { role: "assistant", content: "ok" }, { role: "user", content: `look: ${queued.result}` }], true, PLUGIN_TOOLS);
        await chat(rig, "loose-1", [...h, { role: "user", content: "go on" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_c", type: "function", function: { name: "compress", arguments: "{\"content\":[]}" } }] },
            { role: "tool", tool_call_id: "call_other", content: queued.result }], true, PLUGIN_TOOLS);
        await new Promise((r) => setTimeout(r, 30));
        assert.ok(!rig.seen.some((s) => s.fork), "no fork from loose matches");
        assert.equal([...ac._asyncCompressStateForTest().jobs.values()][0]?.phase, "awaiting-capture");
    } finally {
        await closeRig(rig);
    }
});

function responsesItemsSse(res: http.ServerResponse, items: Array<Record<string, unknown>>, idx: number): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const blk = (type: string, data: Record<string, unknown>): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
    blk("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } });
    items.forEach((item, output_index) => {
        blk("response.output_item.added", { output_index, item });
        if (item.type === "function_call") blk("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.arguments });
        if (item.type === "message") blk("response.output_text.done", { item_id: item.id, output_index, content_index: 0, text: "noted" });
        blk("response.output_item.done", { output_index, item });
    });
    blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", output: items, usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } });
    res.end();
}

function codexItems(): unknown[] {
    const items: unknown[] = [];
    for (let i = 0; i < 14; i++) {
        items.push({ type: "message", role: "user", content: [{ type: "input_text", text: `user turn ${i}: ${FILLER.repeat(12)}` }] });
        items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `assistant reply ${i}: ${FILLER.repeat(12)}` }] });
    }
    return items;
}

async function postResponses(rig: Rig, sid: string, input: unknown[], extraTools: unknown[] = []): Promise<number> {
    const r = await fetch(`${rig.wireBase}/responses`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sid, authorization: "Bearer test-secret-key" },
        body: JSON.stringify({ model: "gpt-test", store: false, stream: true, tool_choice: "auto", max_output_tokens: 64_000,
            tools: [{ type: "function", name: "shell", description: "run", parameters: { type: "object", properties: {} } }, ...extraTools], input }) });
    await r.text();
    return r.status;
}

function responsesRig(rig: Rig, forkItems: (refs: string[]) => Array<Record<string, unknown>>): void {
    let idx = 0;
    rig.setHandler((seen, res) => {
        idx++;
        const input = seen.parsed.input as Array<Record<string, unknown>>;
        const last = input[input.length - 1]!;
        if (seen.fork) responsesItemsSse(res, forkItems(refsOf(seen.body)), idx);
        else if (last.role === "user" && JSON.stringify(last).includes("TRIGGER")) responsesItemsSse(res, [{ type: "function_call", id: `fc_${idx}`, call_id: `call_${idx}`, name: "compress", arguments: "{\"content\":[]}", status: "completed" }], idx);
        else responsesItemsSse(res, [{ type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }], idx);
    });
}

test("hosted tool on the captured request: declined before any fork request; main proceeds; note owed once (Responses proxy + Anthropic plugin)", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    try {
        responsesRig(rig, () => []);
        const items = codexItems();
        assert.equal(await postResponses(rig, "hosted-r", [...items, { type: "message", role: "user", content: [{ type: "input_text", text: "TRIGGER" }] }], [{ type: "web_search" }]), 200);
        const round2 = rig.seen.find((s) => s.body.includes("Background compression queued"));
        assert.ok(round2, "main round 2 reached the upstream");
        assert.ok(!rig.seen.some((s) => s.fork), "no fork request was ever sent");
        assert.equal(ac._asyncCompressStateForTest().jobs.size, 0);
        const from = rig.seen.length;
        await postResponses(rig, "hosted-r", [...items, { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }], [{ type: "web_search" }]);
        assert.match(rig.seen[from]!.body, /provider-hosted capability \(tool type web_search\)/);
        assert.ok(!rig.seen.some((s) => s.fork));

        rig.setHandler((seen, res) => anthropicSse(res, { text: "ok" }));
        const tools = [{ name: "compress", description: "c", input_schema: { type: "object", properties: { content: {} } } }, { type: "web_search_20250305", name: "web_search", max_uses: 1 }];
        const post = async (messages: unknown[]) => {
            const r = await fetch(`${rig.wireBase}/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "hosted-a", "x-bili-plugin": "test-agent", "x-api-key": "k", "anthropic-version": "2023-06-01" },
                body: JSON.stringify({ model: "claude-test", max_tokens: 64_000, stream: true, tools, messages }) });
            await r.text();
            return r.status;
        };
        const h = history(12);
        await post([...h, { role: "user", content: "go on" }]);
        const queued = await pluginTool(rig, "hosted-a", "compress", { content: [] });
        const before = rig.seen.length;
        assert.equal(await post([...h, { role: "user", content: "go on" }, { role: "assistant", content: [{ type: "tool_use", id: "toolu_c", name: "compress", input: { content: [] } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_c", content: queued.result }] }]), 200);
        assert.equal(rig.seen.length, before + 1, "only the main request went upstream");
        assert.ok(!rig.seen.some((s) => s.fork));
        assert.ok(ac._asyncCompressStateForTest().notes.has(sessionFor("hosted-a")!.id));
    } finally {
        await closeRig(rig);
    }
});

test("fork reply with a provider-run item is rejected whole; prose + reasoning + compress applies", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    const call = (refs: string[]) => ({ type: "function_call", id: "fc_f", call_id: "call_f", name: "compress", status: "completed", arguments: JSON.stringify({ content: [{ startId: refs[1], endId: refs[5], summary: SUMMARY }] }) });
    try {
        responsesRig(rig, (refs) => [{ type: "reasoning", id: "rs_f", summary: [] }, { type: "web_search_call", id: "ws_f", status: "completed" }, call(refs)]);
        const items = codexItems();
        await postResponses(rig, "reply-hosted", [...items, { type: "message", role: "user", content: [{ type: "input_text", text: "TRIGGER" }] }]);
        await waitFor(() => ac._asyncCompressStateForTest().notes.has(sessionFor("reply-hosted")!.id));
        const from = rig.seen.length;
        await postResponses(rig, "reply-hosted", [...items, { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }]);
        assert.match(rig.seen[from]!.body, /provider-hosted item \(output web_search_call\)/);
        assert.equal(sessionFor("reply-hosted")!.state.blocks.length, 0);

        responsesRig(rig, (refs) => [{ type: "reasoning", id: "rs_f", summary: [] }, { type: "message", id: "m_f", role: "assistant", status: "completed", content: [{ type: "output_text", text: "noted" }] }, call(refs)]);
        await postResponses(rig, "reply-ok", [...items, { type: "message", role: "user", content: [{ type: "input_text", text: "TRIGGER" }] }]);
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        await postResponses(rig, "reply-ok", [...items, { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }]);
        assert.equal(sessionFor("reply-ok")!.state.blocks.filter((b) => b.active).length, 1);
    } finally {
        await closeRig(rig);
    }
});

function geminiSse(res: http.ServerResponse, parts: unknown[]): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 5, totalTokenCount: 1005 };
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, index: 0 }], usageMetadata })}\n\n`);
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }], usageMetadata })}\n\n`);
    res.end();
}

test("Gemini wire mock (proxy mode): model from the URL path; captured, applied; a path-only model switch discards", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    rig.setHandler((seen, res) => {
        const contents = seen.parsed.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
        const last = contents[contents.length - 1]!;
        if (seen.fork) {
            const refs = refsOf(seen.body);
            geminiSse(res, [{ functionCall: { id: "g_f", name: "compress", args: { content: [{ startId: refs[1], endId: refs[5], summary: SUMMARY }] } } }]);
        } else if (last.role === "user" && last.parts.some((p) => typeof p.text === "string" && p.text.includes("TRIGGER"))) {
            geminiSse(res, [{ functionCall: { id: "g_c", name: "compress", args: { content: [] } } }]);
        } else geminiSse(res, [{ text: "ok" }]);
    });
    const contents = (): unknown[] => {
        const out: unknown[] = [];
        for (let i = 0; i < 14; i++) {
            out.push({ role: "user", parts: [{ text: `user turn ${i}: ${FILLER.repeat(12)}` }] });
            out.push({ role: "model", parts: [{ text: `assistant reply ${i}: ${FILLER.repeat(12)}` }] });
        }
        return out;
    };
    const post = async (sid: string, model: string, c: unknown[]) => {
        const r = await fetch(`${rig.wireBase.replace(/\/v1$/, "")}/v1beta/models/${model}:streamGenerateContent?alt=sse`, { method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sid, "x-goog-api-key": "k" },
            body: JSON.stringify({ contents: c, tools: [{ functionDeclarations: [{ name: "shell", description: "run", parameters: { type: "object", properties: {} } }] }] }) });
        await r.text();
        return r.status;
    };
    try {
        const base = contents();
        const trigger = { role: "user", parts: [{ text: "TRIGGER" }] };
        assert.equal(await post("gem-1", "gemini-a", [...base, trigger]), 200);
        await waitFor(() => rig.seen.some((s) => s.fork));
        const fork = rig.seen.find((s) => s.fork)!;
        assert.match(fork.url, /models\/gemini-a:streamGenerateContent/);
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const from = rig.seen.length;
        await post("gem-1", "gemini-a", [...base, trigger, { role: "model", parts: [{ text: "ok" }] }, { role: "user", parts: [{ text: "continue" }] }]);
        assert.ok(rig.seen[from]!.body.includes(SUMMARY.slice(0, 60)), "carrier on the Gemini wire");
        assert.equal(sessionFor("gem-1")!.state.blocks.filter((b) => b.active).length, 1);

        assert.equal(await post("gem-2", "gemini-a", [...base, trigger]), 200);
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const f2 = rig.seen.length;
        await post("gem-2", "gemini-b", [...base, trigger, { role: "model", parts: [{ text: "ok" }] }, { role: "user", parts: [{ text: "continue" }] }]);
        assert.match(rig.seen[f2]!.body, /model changed/);
        assert.equal(sessionFor("gem-2")!.state.blocks.length, 0);
    } finally {
        await closeRig(rig);
    }
});

const CC_CONTEXT_MANAGEMENT = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };

test("context_management: only Claude Code's exact keep-all thinking edit is replayable on Anthropic; every other shape declines", () => {
    const url = "http://127.0.0.1:1/v1/messages";
    const tools = [{ name: "compress" }];
    const anth = (cm: unknown) => ac.declineReason("anthropic", { messages: [], tools, context_management: cm }, url, false);
    assert.equal(anth(CC_CONTEXT_MANAGEMENT), null);
    assert.equal(anth({ edits: [CC_CONTEXT_MANAGEMENT.edits[0], { type: "clear_thinking_20251015", keep: "all" }] }), null, "a repeated identical no-op edit");
    for (const bad of [
        { edits: [{ type: "clear_thinking_20251015" }] },
        { edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } }] },
        { edits: [{ type: "clear_thinking_20251015", keep: "none" }] },
        { edits: [{ type: "clear_thinking_20260101", keep: "all" }] },
        { edits: [{ type: "clear_thinking_20251015", keep: "all", extra: true }] },
        { edits: [{ type: "clear_thinking_20251015", keep: "all" }], other: 1 },
        { edits: [{ type: "clear_thinking_20251015", keep: "all" }, { type: "clear_tool_uses_20250919" }] },
        { edits: [{ type: "clear_tool_uses_20250919" }] },
        { edits: [] },
        {},
        null,
        "keep-all",
    ]) assert.match(anth(bad) ?? "", /server-side state \(context_management\)/, JSON.stringify(bad));
    assert.match(ac.declineReason("responses", { input: [], tools: [{ type: "function", name: "compress" }], context_management: CC_CONTEXT_MANAGEMENT }, url, false) ?? "", /server-side state \(context_management\)/, "Responses context_management always declines");
});

function anthropicThinkingSse(res: http.ServerResponse, thinking: { text: string; signature: string }, block: { text?: string; tool?: { id: string; name: string; input: unknown } }): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    ev("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 1 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thinking.text } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thinking.signature } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    if (block.tool) {
        ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: block.tool.id, name: block.tool.name, input: {} } });
        ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.tool.input) } });
        ev("content_block_stop", { type: "content_block_stop", index: 1 });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } });
    } else {
        ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: block.text ?? "ok" } });
        ev("content_block_stop", { type: "content_block_stop", index: 1 });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    }
    ev("message_stop", { type: "message_stop" });
    res.end();
}

test("Claude Code-shaped proxy loop with keep-all context_management: signed thinking byte-equal in client stream, loop rebuild and fork; applies; decompress restores", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    const forkGate = gate();
    const SIG = "EpYDCkYIBhgCKkCcc+signed/thinking==";
    const THINK = "I will queue background compression and keep reading.";
    const sid = "cc-proxy-1";
    rig.setHandler(async (seen, res) => {
        const msgs = seen.parsed.messages as Array<Record<string, unknown>>;
        const last = msgs[msgs.length - 1]!;
        if (seen.fork) {
            await forkGate.promise;
            const refs = refsOf(seen.body);
            anthropicSse(res, { tool: { name: "compress", input: { content: [{ startId: refs[1], endId: refs[5], summary: SUMMARY }] } } });
        } else if (last.role === "user" && JSON.stringify(last.content).includes("TRIGGER")) anthropicThinkingSse(res, { text: THINK, signature: SIG }, { tool: { id: "toolu_cc_c", name: "compress", input: { content: [] } } });
        else if (last.role === "user" && JSON.stringify(last.content).includes("RESTORE")) {
            const block = sessionFor(sid)!.state.blocks.find((b) => b.active)!;
            anthropicSse(res, { tool: { name: "decompress", input: { blockId: block.blockId, full: true } } });
        } else anthropicSse(res, { text: "ok" });
    });
    const tools = [{ name: "Read", description: "read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }];
    const post = async (messages: unknown[]) => {
        const r = await fetch(`${rig.wireBase}/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sid, "x-api-key": "sk-ant-test-dummy", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 32_000, stream: true, system: [{ type: "text", text: "You are Claude Code." }], tools, thinking: { type: "enabled", budget_tokens: 31_999 }, context_management: CC_CONTEXT_MANAGEMENT, messages }) });
        return { status: r.status, text: await r.text() };
    };
    try {
        const h = history(16);
        const t1 = await post([...h, { role: "user", content: "TRIGGER" }]);
        assert.equal(t1.status, 200);
        assert.ok(t1.text.includes(JSON.stringify(SIG)) && t1.text.includes(JSON.stringify(THINK)), "client stream carries the signed thinking verbatim");
        await waitFor(() => rig.seen.some((s) => s.fork));
        const round2 = rig.seen.find((s) => !s.fork && s.body.includes("Background compression queued"))!;
        const fork = rig.seen.find((s) => s.fork)!;
        const cm = round2.parsed.messages as Array<Record<string, unknown>>;
        const fm = fork.parsed.messages as unknown[];
        const signed = cm.find((m) => m.role === "assistant" && JSON.stringify(m.content).includes(SIG))!;
        assert.deepEqual(signed.content, [{ type: "thinking", thinking: THINK, signature: SIG }, { type: "tool_use", id: "toolu_cc_c", name: "compress", input: { content: [] } }], "loop rebuild keeps thinking bytes and block order");
        assert.equal(JSON.stringify(fm.slice(0, cm.length)), JSON.stringify(cm), "fork replays every captured message byte-for-byte");
        assert.equal(fm.length, cm.length + 1);
        for (const k of ["system", "tools", "thinking", "context_management", "model", "max_tokens"]) assert.equal(JSON.stringify(fork.parsed[k]), JSON.stringify(round2.parsed[k]), k);
        assert.deepEqual(fork.parsed.context_management, CC_CONTEXT_MANAGEMENT);

        const h2 = [...h, { role: "user", content: "TRIGGER" }, { role: "assistant", content: "ok" }, { role: "user", content: "next step" }];
        assert.equal((await post(h2)).status, 200, "main proceeds while the fork is held");
        assert.equal(ac._asyncCompressStateForTest().jobs.size, 1);
        forkGate.release();
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const before = rig.seen.length;
        const h3 = [...h2, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }];
        await post(h3);
        assert.ok(rig.seen[before]!.body.includes(SUMMARY.slice(0, 60)), "carrier applied on a later request");
        assert.ok(!rig.seen[before]!.body.includes("user turn 2:"));
        const d0 = rig.seen.length;
        await post([...h3, { role: "assistant", content: "ok" }, { role: "user", content: "RESTORE" }]);
        const receipt = rig.seen.slice(d0).find((s) => /\[Block b\d+ content/.test(s.body));
        assert.ok(receipt, "decompress executed in the proxy loop");
        assert.match(restoredText(receipt.body.replace(/\\n/g, "\n")), /user turn 2:/);
    } finally {
        forkGate.release();
        await closeRig(rig);
    }
});

test("withoutFetchTransport hides only the fetch transport; other async context survives", async () => {
    const { withFetchTransport, withoutFetchTransport, currentFetchTransport } = await import("../src/fetch-transport.ts");
    const other = new AsyncLocalStorage<string>();
    const transport = async () => new Response("x");
    await other.run("session-ctx", () => withFetchTransport(transport, async () => {
        assert.equal(currentFetchTransport(), transport);
        await withoutFetchTransport(async () => {
            await new Promise((r) => setTimeout(r, 1));
            assert.equal(currentFetchTransport(), undefined);
            assert.equal(other.getStore(), "session-ctx");
        });
        assert.equal(currentFetchTransport(), transport, "the caller keeps its transport");
    }));
});

test("plugin mode over a real WebSocket turn: fork goes out as HTTP/SSE while the main WS continues; applies; decompress restores", { timeout: 30000 }, async () => {
    ac.configureAsyncCompress({});
    freshStore();
    setRegistryForTest({});
    const forkGate = gate();
    const wsFrames: Array<Record<string, unknown>> = [];
    const httpPosts: Seen[] = [];
    let serial = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const s: Seen = { body, parsed, fork: JSON.stringify((parsed.input as unknown[]).slice(-1)).includes(FORK_MARK), headers: req.headers, url: req.url ?? "" };
            httpPosts.push(s);
            void (async () => {
                if (!s.fork) { responsesSse(res, { text: "unexpected-http" }, ++serial); return; }
                await forkGate.promise;
                const refs = refsOf(body);
                responsesSse(res, { call: { name: "compress", args: JSON.stringify({ content: [{ startId: refs[1], endId: refs[5], summary: SUMMARY }] }) } }, ++serial);
            })();
        });
    });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (peer) => peer.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as Record<string, unknown>;
        wsFrames.push(request);
        const id = `resp_ws_${++serial}`;
        const send = (type: string, fields: Record<string, unknown>): void => peer.send(JSON.stringify({ type, ...fields }));
        const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `ws-ok-${serial}` }] };
        send("response.created", { response: { id, status: "in_progress", output: [] } });
        send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: `ws-ok-${serial}` });
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } } });
    }));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1", routes: {}, modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false, autoRestartOnUpdate: false, mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    if (!proxy.listening) await once(proxy, "listening");
    const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const sid = "ws-plugin-1";
    const client = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/${upstreamOrigin}/v1/responses`, { headers: { authorization: "Bearer test-secret-key", "session-id": sid, "x-bili-plugin": "test-agent", "openai-beta": "responses_websockets=2026-02-06" } });
    client.on("error", () => {});
    const tools = [{ type: "function", name: "compress", description: "c", parameters: { type: "object", properties: { content: {} } } }, { type: "function", name: "read", description: "r", parameters: { type: "object", properties: { path: { type: "string" } } } }];
    const turn = (input: unknown[]): Promise<Array<Record<string, unknown>>> => new Promise((resolve, reject) => {
        const events: Array<Record<string, unknown>> = [];
        const timer = setTimeout(() => { client.off("message", on); reject(new Error("WS turn timed out")); }, 10000);
        const on = (raw: WebSocket.RawData): void => {
            const e = JSON.parse(raw.toString()) as Record<string, unknown>;
            events.push(e);
            if (["response.completed", "response.failed", "error"].includes(String(e.type))) { clearTimeout(timer); client.off("message", on); resolve(events); }
        };
        client.on("message", on);
        client.send(JSON.stringify({ type: "response.create", model: "gpt-ws", instructions: "You are Codex", store: false, stream: true, prompt_cache_key: sid, tools, input }));
    });
    const msg = (role: string, text: string) => ({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
    try {
        await once(client, "open");
        const items: unknown[] = [];
        for (let i = 0; i < 16; i++) items.push(msg("user", `user turn ${i}: ${FILLER.repeat(12)}`), msg("assistant", `assistant reply ${i}: ${FILLER.repeat(12)}`));
        const e1 = await turn([...items, msg("user", "go on")]);
        assert.equal(e1[e1.length - 1]!.type, "response.completed");
        const queued = await pluginTool({ base: `${proxyOrigin}/x` } as Rig, sid, "compress", { content: [] });
        assert.match(queued.result ?? "", /Background compression queued/);
        const withResult = [...items, msg("user", "go on"), { type: "function_call", call_id: "call_c", name: "compress", arguments: "{\"content\":[]}" }, { type: "function_call_output", call_id: "call_c", output: queued.result }];
        const e2 = await turn(withResult);
        assert.equal(e2[e2.length - 1]!.type, "response.completed", "captured WS turn completed");
        await waitFor(() => httpPosts.some((s) => s.fork));
        assert.equal(httpPosts.length, 1, "exactly one HTTP request upstream: the fork");
        const fork = httpPosts[0]!;
        assert.match(fork.url, /\/v1\/responses$/);
        assert.equal(fork.headers.authorization, "Bearer test-secret-key");
        assert.equal(fork.parsed.stream, true);
        assert.equal([...ac._asyncCompressStateForTest().jobs.values()][0]?.phase, "running");
        const framesBefore = wsFrames.length;
        const e3 = await turn([...withResult, msg("assistant", "ok"), msg("user", "next while fork held")]);
        assert.equal(e3[e3.length - 1]!.type, "response.completed", "main WS turn proceeds while the fork is held");
        assert.equal(wsFrames.length, framesBefore + 1, "main traffic stayed on the WebSocket");
        assert.equal(httpPosts.length, 1, "no main request leaked to HTTP");
        forkGate.release();
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const e4 = await turn([...withResult, msg("assistant", "ok"), msg("user", "next while fork held"), msg("assistant", "ok"), msg("user", "continue")]);
        assert.equal(e4[e4.length - 1]!.type, "response.completed");
        const applied = JSON.stringify(wsFrames[wsFrames.length - 1]);
        assert.ok(applied.includes(SUMMARY.slice(0, 60)), "carrier applied on the next WS turn");
        assert.ok(!applied.includes("user turn 2:"));
        assert.equal(httpPosts.length, 1);
        const block = sessionFor(sid)!.state.blocks.find((b) => b.active)!;
        assert.ok(block.compressCallId?.startsWith(ac.ASYNC_COMPRESS_CALL_ID_PREFIX));
        const restored = await pluginTool({ base: `${proxyOrigin}/x` } as Rig, sid, "decompress", { blockId: block.blockId, full: true });
        assert.match(restoredText(restored.result ?? ""), /user turn 2:/, "decompress restores the folded originals");
    } finally {
        forkGate.release();
        client.terminate();
        for (const c of wss.clients) c.terminate();
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        await Promise.all([new Promise<void>((r) => proxy.close(() => r())), new Promise<void>((r) => upstream.close(() => r()))]);
        wss.close();
    }
});

const kernel = await import("acp-kernel");
type KMsg = import("acp-kernel").CoreMessage;

function toolHeavyMessages(rounds: number): KMsg[] {
    const msgs: KMsg[] = [{ id: "task", role: "user", contentType: "text", text: "Read the fixture files one by one and report their nonces." }];
    for (let i = 0; i < rounds; i++) {
        if (i > 0) msgs.push({ id: `u${i}`, role: "user", contentType: "text", text: `next file please (${i})` });
        msgs.push({ id: `tc${i}`, role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: `call_${i}`, text: JSON.stringify({ path: `fx/f${i}.txt` }) });
        msgs.push({ id: `tr${i}`, role: "tool", contentType: "tool-result", toolCallId: `call_${i}`, text: `NONCE-${i} ${FILLER.repeat(30)}` });
    }
    msgs.push({ id: "a-last", role: "assistant", contentType: "text", text: "Reading the next file now." });
    msgs.push({ id: "u-last", role: "user", contentType: "text", text: "continue" });
    return msgs;
}

function offerTurn(msgs: KMsg[], state = kernel.createInitialState(), config = kernel.defaultConfig(200_000)) {
    const core = kernel.createCore();
    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 150_000, renderTags: "text-only" });
    return { core, turn, config };
}

test("F-A suggestion: read from the kernel offer; untagged tool results count, the capture config minimum applies, pairs stay whole", () => {
    const msgs = toolHeavyMessages(14);
    const { core, turn, config } = offerTurn(msgs);
    const rendered = JSON.stringify(turn.messages.filter((m) => m.role === "tool"));
    assert.ok(!rendered.includes("\x3cacp"), "fixture mirrors the live finding: tool results are untagged");
    const s = ac.suggestFromOffer(turn.nudge, config, turn.state);
    assert.ok(s.hint, `a suggestion exists (${s.reason})`);
    const byRef = turn.state.messageRefs.byRef;
    assert.ok(byRef[s.hint!.startRef] !== undefined && byRef[s.hint!.endRef] !== undefined, "real assigned refs, nothing invented");
    const followed = foldEnd(core, config, msgs, turn.state, s.hint!.startRef, s.hint!.endRef);
    assert.deepEqual(followed.errors, []);
    assert.ok(followed.chars >= config.compress.minCompressRange);
    assert.ok([...followed.covered].some((id) => id.startsWith("tr")), "untagged tool results are folded");
    for (const m of msgs) if (m.toolCallId && followed.covered.has(m.id)) assert.ok(msgs.filter((x) => x.toolCallId === m.toolCallId).every((x) => followed.covered.has(x.id)), `pair ${m.toolCallId} kept whole`);
    assert.ok(!followed.covered.has("u-last") && !followed.covered.has("a-last"), "protected tail stays out");
    const offered = turn.nudge!.compressibleRanges.filter((r) => (r.chars ?? r.tokens * 4) >= 9000);
    const strict = ac.suggestFromOffer(turn.nudge, { ...config, compress: { ...config.compress, minCompressRange: 9000 } }, turn.state);
    assert.equal(strict.hint !== undefined, offered.length > 0, "capture-effective config minimum, not the global default");
    assert.deepEqual(ac.suggestFromOffer(turn.nudge, { ...config, compress: { ...config.compress, minCompressRange: 10_000_000 } }, turn.state), { reason: "none-offered" });
});

function readTurn(i: number, size: number, withAnswer = true): KMsg[] {
    const out: KMsg[] = [
        { id: `u${i}`, role: "user", contentType: "text", text: `read file ${i}` },
        { id: `tc${i}`, role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: `call_${i}`, text: JSON.stringify({ path: `fx/f${i}.txt` }) },
        { id: `tr${i}`, role: "tool", contentType: "tool-result", toolCallId: `call_${i}`, text: `NONCE-${i} ${FILLER.repeat(size)}` },
    ];
    if (withAnswer) out.push({ id: `a${i}`, role: "assistant", contentType: "text", text: `File ${i} read.` });
    return out;
}

function bigTail(): KMsg[] {
    return [...readTurn(9, 260), { id: "u-last", role: "user", contentType: "text", text: "continue" }];
}

function foldEnd(core: ReturnType<typeof kernel.createCore>, config: ReturnType<typeof kernel.defaultConfig>, msgs: KMsg[], state: import("acp-kernel").CompressionState, startRef: string, endRef: string) {
    const r = core.applyCompression({ ranges: [{ startRef, endRef, summary: SUMMARY }], messages: msgs, state: structuredClone(state), config });
    const before = new Set(state.blocks.map((b) => b.blockId));
    const block = r.state.blocks.find((b) => b.active && !before.has(b.blockId));
    const covered = new Set(block?.effectiveMessageIds ?? []);
    return { errors: r.result.errors, block, covered, chars: msgs.filter((m) => covered.has(m.id)).reduce((s, m) => s + (m.text ?? "").length, 0) };
}

test("F-A suggestion regression (fix7): an unfolded span BELOW an existing block is valid, so it must not be declined", () => {
    const msgs: KMsg[] = [{ id: "task", role: "user", contentType: "text", text: "Investigate the failing build." }, ...readTurn(0, 80), ...readTurn(1, 80), ...bigTail()];
    const config = kernel.defaultConfig(200_000);
    const core = kernel.createCore();
    const turn = core.processTurn({ messages: msgs, state: kernel.createInitialState(), config, tokenCount: 150_000, renderTags: "text-only" });
    const ref = (id: string) => turn.state.messageRefs.byRaw[id]!;
    const later = core.applyCompression({ ranges: [{ startRef: ref("u1"), endRef: ref("a1"), summary: SUMMARY }], messages: msgs, state: structuredClone(turn.state), config });
    assert.deepEqual(later.result.errors, [], "setup: the LATER span is folded first");
    const direct = foldEnd(core, config, msgs, later.state, ref("task"), ref("a0"));
    assert.deepEqual(direct.errors, [], "the kernel accepts the older unfolded span directly");
    assert.ok(direct.chars >= config.compress.minCompressRange, `direct fold clears the minimum (${direct.chars} chars)`);
    const reoffer = core.processTurn({ messages: msgs, state: structuredClone(later.state), config, tokenCount: 150_000, renderTags: "text-only" });
    const hint = ac.suggestFromOffer(reoffer.nudge, config, reoffer.state).hint;
    assert.ok(hint, "a suggestion exists when the kernel itself accepts a range");
    const followed = foldEnd(core, config, msgs, later.state, hint!.startRef, hint!.endRef);
    assert.deepEqual(followed.errors, []);
    assert.ok(followed.chars >= config.compress.minCompressRange);
});

test("F-A suggestion regression (fix7): the suggested end is what the kernel actually folds, never a protected-tail ref it silently clamps", () => {
    const head: KMsg[] = [{ id: "task", role: "user", contentType: "text", text: "Investigate the failing build." }];
    for (let i = 1; i <= 5; i++) head.push({ id: `h${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `short note ${i}` });
    const msgs: KMsg[] = [...head, ...readTurn(0, 70).slice(1), ...bigTail()];
    const config = kernel.defaultConfig(200_000);
    const core = kernel.createCore();
    const turn = core.processTurn({ messages: msgs, state: kernel.createInitialState(), config, tokenCount: 150_000, renderTags: "text-only" });
    const ref = (id: string) => turn.state.messageRefs.byRaw[id]!;
    const atCall = foldEnd(core, config, msgs, turn.state, ref("task"), ref("tc0"));
    assert.equal(atCall.block, undefined, "early prefix ending at the tool call is under the minimum (call withdrawn)");
    const atResult = foldEnd(core, config, msgs, turn.state, ref("task"), ref("tr0"));
    assert.deepEqual(atResult.errors, [], "ending at the matching result, outside the protected tail, is accepted");
    assert.ok(atResult.chars >= config.compress.minCompressRange);
    const hint = ac.suggestFromOffer(turn.nudge, config, turn.state).hint;
    assert.ok(hint, "a suggestion exists");
    const followed = foldEnd(core, config, msgs, turn.state, hint!.startRef, hint!.endRef);
    assert.deepEqual(followed.errors, []);
    const endId = Object.entries(turn.state.messageRefs.byRaw).find(([, r]) => r === hint!.endRef)?.[0];
    assert.ok(endId !== undefined && followed.covered.has(endId), `suggested end ${hint!.endRef} (${endId}) is inside the fold the kernel makes, not clamped away`);
    assert.ok(!followed.covered.has("u-last") && !followed.covered.has("tr9"), "protected tail stays out");
});

test("F-A suggestion: offer must belong to the captured snapshot; stale or missing offer gives none; no kernel work and no mutation", () => {
    const msgs = toolHeavyMessages(150);
    const { core, turn, config } = offerTurn(msgs);
    const stateBefore = JSON.stringify(turn.state);
    const offerBefore = JSON.stringify(turn.nudge);
    const s = ac.suggestFromOffer(turn.nudge, config, turn.state);
    assert.ok(s.hint);
    assert.equal(JSON.stringify(turn.state), stateBefore, "refs, blocks, run ids and journal unchanged");
    assert.equal(JSON.stringify(turn.nudge), offerBefore);
    assert.deepEqual(ac.suggestFromOffer(undefined, config, turn.state), { reason: "no-offer" });
    const folded = core.applyCompression({ ranges: [{ startRef: s.hint!.startRef, endRef: s.hint!.endRef, summary: SUMMARY }], messages: msgs, state: structuredClone(turn.state), config });
    assert.deepEqual(folded.result.errors, []);
    assert.deepEqual(ac.suggestFromOffer(turn.nudge, config, folded.state), { reason: "stale-offer" }, "offer from before a fold is not reused against the folded state");
    assert.deepEqual(ac.suggestFromOffer({ ...turn.nudge!, activeBlockSpans: undefined }, config, turn.state), { reason: "stale-offer" }, "offer without span identity is not trusted");
    const src = readFileSync(new URL("../src/async-compress.ts", import.meta.url), "utf8");
    assert.equal((src.match(/\.applyCompression\(/g) ?? []).length, 1, "the only kernel apply call is the atomic apply-time validation");
    assert.ok(!/\.processTurn\(|recommendFoldRange|hintDryRun/.test(src), "no capture/settle-time kernel turn or dry-run search");
});

test("F-C: mixed or foreign calls stay refused; the reason names only declared tools and never echoes arguments", () => {
    const ok = { name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00004", summary: SUMMARY }] }) };
    const canary = "CANARY-ARG-9f3";
    const declared = ["read", "bash", "compress", "write", "edit", "grep"];
    assert.equal(ac.rangesFromForkCalls([ok, { name: "bash", arguments: JSON.stringify({ command: canary }) }], declared), "fork called a non-compress tool (names=bash; compress calls=1)");
    assert.equal(ac.rangesFromForkCalls([{ name: "read", arguments: "{}" }], declared), "fork called a non-compress tool (names=read; compress calls=0)");
    assert.equal(ac.rangesFromForkCalls([{ name: `x-${canary}`, arguments: "{}" }, { name: "evil\nname", arguments: "{}" }, { name: "a".repeat(65), arguments: "{}" }], [...declared, `x-${canary}`.replace("x", "y")]), "fork called a non-compress tool (names=other; compress calls=0)");
    assert.equal(ac.rangesFromForkCalls([{ name: "read", arguments: "{}" }, { name: "bash", arguments: "{}" }, { name: "write", arguments: "{}" }, { name: "edit", arguments: "{}" }, { name: "grep", arguments: "{}" }], declared), "fork called a non-compress tool (names=read,bash,write,edit,...; compress calls=0)");
    assert.equal(ac.rangesFromForkCalls([ok, ok], declared), "fork made more than one compress call (2)");
    assert.equal(ac.rangesFromForkCalls([{ name: "bash", arguments: "{}" }]), "fork called a non-compress tool (names=other; compress calls=0)", "nothing declared -> other");
    for (const r of [ac.rangesFromForkCalls([ok, { name: "bash", arguments: canary }], declared)]) assert.ok(!String(r).includes(canary));
});

test("F-A capture: no kernel-offered range still launches the fork with no suggestion and an unchanged prefix (no decline)", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    let directive = "";
    try {
        rig.setHandler(async (seen, res) => {
            if (seen.fork) {
                const msgs = seen.parsed.messages as Array<Record<string, unknown>>;
                directive = String(msgs[msgs.length - 1]!.content);
                openaiText(res, "nothing to fold");
                return;
            }
            if (lastUserText(seen.parsed).includes("TRIGGER")) { openaiCalls(res, [{ name: "compress", args: { content: [] } }]); return; }
            openaiText(res, "ok");
        });
        const small = [{ role: "user", content: "short task" }, { role: "assistant", content: "short reply" }];
        await queueAndCapture(rig, "no-offer", small);
        await waitFor(() => rig.seen.some((s) => s.fork));
        const fork = rig.seen.find((s) => s.fork)!;
        const captured = rig.seen.filter((s) => !s.fork).at(-1)!;
        const capMsgs = captured.parsed.messages as unknown[];
        const forkMsgs = fork.parsed.messages as unknown[];
        assert.equal(forkMsgs.length, capMsgs.length + 1, "only the directive item is added");
        assert.deepEqual(forkMsgs.slice(0, capMsgs.length), capMsgs, "captured messages replayed unchanged");
        assert.match(directive, /at least 5000 characters/);
        assert.ok(!/Kernel-offered suggestion|Suggested range|passes validation/.test(directive), "no suggestion line when none is offered");
    } finally {
        await closeRig(rig);
    }
});

test("F-A/F-B directive: suggested range, size floor and untagged-results rule; a fork that follows the suggestion applies (mock plumbing only)", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    let directive = "";
    try {
        rig.setHandler(async (seen, res) => {
            if (seen.fork) {
                const msgs = seen.parsed.messages as Array<Record<string, unknown>>;
                directive = String(msgs[msgs.length - 1]!.content);
                const m = /startId (m\d+), endId (m\d+)\.$/.exec(directive);
                openaiCalls(res, [{ name: "compress", args: { content: [{ startId: m?.[1], endId: m?.[2], summary: SUMMARY }] } }]);
                return;
            }
            if (lastUserText(seen.parsed).includes("TRIGGER")) { openaiCalls(res, [{ name: "compress", args: { content: [] } }]); return; }
            openaiText(res, "ok");
        });
        const h = history(16);
        const { withResult } = await queueAndCapture(rig, "suggest", h);
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()].some((j) => j.sessionId === "suggest" && j.phase === "ready"));
        assert.match(directive, /any call other than `compress` voids the whole pass/);
        assert.match(directive, /show no id tag/);
        assert.match(directive, /at least 5000 characters/);
        assert.match(directive, /Kernel-offered suggestion \(optional guidance, not a guarantee; final validation still happens when the fold is applied\): startId m\d{5}, endId m\d{5}\.$/);
        assert.ok(!/passes validation/.test(directive));
        assert.ok(!/Retry NOW/.test(directive), "no sync-retry wording");
        await chat(rig, "suggest", [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "next" }], true, PLUGIN_TOOLS);
        assert.ok(sessionFor("suggest")!.state.blocks.some((b) => b.active), "the suggested range applied");
    } finally {
        await closeRig(rig);
    }
});

const { anthropicToCore } = await import("acp-kernel/wire");
const BRIDGED_READ = "mcp__custom-tools__read";

function claudeShapedCapture(queued: string): Array<Record<string, unknown>> {
    const parts = ["<system-reminder>context</system-reminder>", "<system-reminder>skills</system-reminder>", "env: darwin", "cwd: /proj", "Read fx/f1.txt and fx/f2.txt, then call compress with an empty content array."]
        .map((text) => ({ type: "text", text }));
    const read = (i: number) => [
        { role: "assistant", content: [{ type: "tool_use", id: `toolu_r${i}`, name: BRIDGED_READ, input: { path: `fx/f${i}.txt` } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_r${i}`, content: `fixture f${i} NONCE-F${i} ${FILLER.repeat(220)}` }] },
    ];
    return [{ role: "user", content: parts }, ...read(1), ...read(2),
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_c", name: "compress", input: { content: [] } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_c", content: queued }] }];
}

async function noOfferClaudeCase(sid: string, pick: (ctx: { forkMessages: string; refOf: (needle: string) => string }) => { startId: string; endId: string }) {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    let directive = "";
    const tools = [{ name: "compress", description: "c", input_schema: { type: "object", properties: { content: {} } } }, { name: BRIDGED_READ, description: "r", input_schema: { type: "object", properties: { path: { type: "string" } } } }];
    const post = async (messages: unknown[]) => {
        const r = await fetch(`${rig.wireBase}/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sid, "x-bili-plugin": "test-agent", "x-api-key": "test-secret-key", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 64_000, stream: true, tools, messages }) });
        await r.text();
    };
    let captureMessages: unknown[] = [];
    const refOf = (needle: string): string => {
        const msgs = (anthropicToCore({ model: "claude-test", messages: captureMessages } as Parameters<typeof anthropicToCore>[0]) as { msgs: KMsg[] }).msgs;
        const hit = msgs.find((m) => (m.text ?? "").includes(needle));
        assert.ok(hit, `fixture message ${needle}`);
        const ref = sessionFor(sid)!.state.messageRefs.byRaw[hit!.id];
        assert.ok(ref && ref !== "BLOCKED", `kernel ref for ${needle}`);
        return ref!;
    };
    rig.setHandler((seen, res) => {
        if (seen.fork) {
            const msgs = seen.parsed.messages as Array<{ content: Array<{ text?: string }> }>;
            directive = msgs[msgs.length - 1]!.content[0]!.text ?? "";
            const range = pick({ forkMessages: JSON.stringify(seen.parsed.messages), refOf });
            anthropicSse(res, { tool: { name: "compress", input: { content: [{ ...range, summary: SUMMARY }] } } });
        } else anthropicSse(res, { text: "ok" });
    });
    try {
        const head = claudeShapedCapture("placeholder").slice(0, 5);
        await post(head);
        const queued = await pluginTool(rig, sid, "compress", { content: [] });
        captureMessages = claudeShapedCapture(queued.result ?? "");
        await post(captureMessages);
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()].some((j) => j.sessionId === sessionFor(sid)!.id && j.phase === "ready")
            || ac._asyncCompressStateForTest().notes.has(sessionFor(sid)!.id));
        const later = [...captureMessages,
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_r3", name: BRIDGED_READ, input: { path: "fx/f34.txt" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_r3", content: `fixture f34 NONCE-F3 ${FILLER.repeat(440)}` }] },
            { role: "assistant", content: [{ type: "text", text: "Read all files." }] },
            { role: "user", content: "next" }];
        const from = rig.seen.length;
        await post(later);
        return { rig, directive, from, blocks: sessionFor(sid)!.state.blocks.filter((b) => b.active), close: () => closeRig(rig) };
    } catch (e) {
        await closeRig(rig);
        throw e;
    }
}

test("no kernel offer (Claude bridge shape) + a valid scripted range from fixture ground truth: applies on the later request", async () => {
    const r = await noOfferClaudeCase("no-offer-valid", ({ refOf }) => ({ startId: refOf("context</system-reminder>"), endId: refOf("NONCE-F2") }));
    try {
        assert.ok(!/Kernel-offered suggestion/.test(r.directive), "the kernel offered no range at capture for this shape");
        assert.equal(r.blocks.length, 1, "a valid range applies without any suggestion");
        assert.ok(r.rig.seen[r.from]!.body.includes(SUMMARY.slice(0, 60)), "carrier on the later request");
        assert.ok(!r.rig.seen[r.from]!.body.includes("NONCE-F1"), "folded f1 result left the wire");
    } finally {
        await r.close();
    }
});

test("no kernel offer (Claude bridge shape) + a range limited to visibly tagged messages: rejected as too small, owed note, nothing folded", async () => {
    let tagged: string[] = [];
    const r = await noOfferClaudeCase("no-offer-tagged", ({ forkMessages }) => {
        tagged = [...new Set(refsOf(forkMessages))].sort();
        return { startId: tagged[0]!, endId: tagged[tagged.length - 1]! };
    });
    try {
        assert.ok(!/Kernel-offered suggestion/.test(r.directive));
        assert.deepEqual(tagged, ["m00001", "m00002", "m00003", "m00004", "m00005"], "only the task text parts carry visible ids in the conversation for this shape");
        assert.equal(r.blocks.length, 0, "nothing applied");
        assert.match(r.rig.seen[r.from]!.body, /did not apply/);
        assert.match(r.rig.seen[r.from]!.body, /too small/i);
    } finally {
        await r.close();
    }
});

test("#2748 net-benefit: a fork summary that passes validation but would grow the context is refused at commit and owes one note", async () => {
    ac.configureAsyncCompress({});
    freshStore();
    const rig = await startRig();
    const bloated = `${SUMMARY} `.repeat(30);
    rig.setHandler(defaultHandler(undefined, (refs) => [{ name: "compress", args: { content: [{ startId: refs[1], endId: refs[6], summary: bloated } ] } }]));
    try {
        assert.ok(bloated.length < defaultConfig(200_000).compress.maxSummaryLength, "summary stays under the kernel length limit, so only the net-benefit gate can refuse it");
        const { tag, withResult } = await queueAndCapture(rig, "netgrow", history(16));
        await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
        const before = structuredClone(sessionFor("netgrow")!.state);
        const from = rig.seen.length;
        await chat(rig, "netgrow", [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }], true, PLUGIN_TOOLS);
        const session = sessionFor("netgrow")!;
        assert.equal(session.state.blocks.length, 0, "no block committed");
        for (const [ref, raw] of Object.entries(before.messageRefs.byRef)) assert.equal(session.state.messageRefs.byRef[ref], raw, `ref ${ref} unchanged`);
        assert.equal(ac._asyncCompressStateForTest().jobs.size, 0, "job consumed");
        const why = /did not apply \(([^)]*)\)/.exec(rig.seen[from]!.body)?.[1];
        assert.equal(why, "discarded: the fold was refused at commit", `the refusal note rides the same request (got ${why ?? "none"})`);
        assert.ok(!rig.seen[from]!.body.includes(bloated.slice(0, 200)), "the bloated summary never reaches the wire");
        assert.equal(notesIn(rig, from, tag), 1, "note delivered once");
        await chat(rig, "netgrow", [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }, { role: "assistant", content: "ok" }, { role: "user", content: "b" }], true, PLUGIN_TOOLS);
        await chat(rig, "netgrow", [...withResult, { role: "assistant", content: "ok" }, { role: "user", content: "a" }, { role: "assistant", content: "ok" }, { role: "user", content: "b" }, { role: "assistant", content: "ok" }, { role: "user", content: "c" }], true, PLUGIN_TOOLS);
        assert.equal(notesIn(rig, from, tag), 1, "and not again");
    } finally {
        await closeRig(rig);
    }
});

test("proxy-mode reconcile between capture and apply: repair of an earlier block keeps the job valid; churn inside the captured span discards it", async () => {
    ac.configureAsyncCompress({});
    try {
        freshStore();
        const rig = await startRig();
        try {
            const EARLY = "EARLY-BLOCK: user turns 0 to 2 walked through the failing module and the retry loop. ".repeat(3);
            const refNum = (r: string): number => Number(r.slice(1));
            let earlyEnd = 0;
            let sysRef = "";
            let chosen: { startId: string; endId: string } | undefined;
            const base = defaultHandler(undefined, (refs) => {
                const later = refs.filter((r) => r !== sysRef && refNum(r) > earlyEnd);
                chosen = { startId: later[0]!, endId: later[6]! };
                return [{ name: "compress", args: { content: [{ ...chosen, summary: SUMMARY }] } }];
            });
            rig.setHandler(async (seen, res) => {
                if (!seen.fork && lastUserText(seen.parsed).includes("FOLD EARLY")) {
                    const refs = refsOf(seen.body);
                    sysRef = refs[0]!;
                    earlyEnd = refNum(refs[6]!);
                    openaiCalls(res, [{ name: "compress", args: { content: [{ startId: refs[1], endId: refs[6], summary: EARLY }] } }]);
                    return;
                }
                await base(seen, res);
            });
            const churn = (m: Record<string, unknown>): Record<string, unknown> => ({ ...m, content: `${String(m.content).replace(": ", ":   ")}\r\n` });
            // A real earlier proxy fold, then a queued job captured and ready over a later span.
            const setup = async (sid: string) => {
                const h = history(20);
                await chat(rig, sid, [...h, { role: "user", content: "FOLD EARLY" }], false);
                const session = sessionFor(sid)!;
                const early = session.state.blocks.find((b) => b.active);
                assert.ok(early, `${sid}: earlier block committed`);
                const earlyIds = [...(early!.effectiveMessageIds ?? [])];
                const h1 = [...h, { role: "user", content: "FOLD EARLY" }, { role: "assistant", content: "ok" }];
                await chat(rig, sid, [...h1, { role: "user", content: "TRIGGER" }], false);
                await waitFor(() => [...ac._asyncCompressStateForTest().jobs.values()][0]?.phase === "ready");
                assert.ok(chosen, `${sid}: the fork chose a span after the earlier block`);
                return { session, early: early!, earlyIds, h2: [...h1, { role: "user", content: "TRIGGER" }, { role: "assistant", content: "ok" }] };
            };

            // (a) whitespace churn of messages covered by the earlier block: reconcile repair re-anchors
            // them onto the churned bytes; block identity is unchanged, so the job still applies.
            {
                const { early: early0, earlyIds, h2 } = await setup("recon-a");
                const churned = h2.map((m, i) => (i === 2 || i === 4 ? churn(m) : m));
                const from = rig.seen.length;
                await chat(rig, "recon-a", [...churned, { role: "user", content: "continue" }], false);
                const session = sessionFor("recon-a")!;
                const early = session.state.blocks.find((b) => b.blockId === early0.blockId && b.runId === early0.runId);
                assert.ok(early?.active, "earlier block still active under the same identity");
                const ids = early!.effectiveMessageIds ?? [];
                assert.equal(ids.length, earlyIds.length, "no covered message was lost");
                assert.ok(earlyIds.some((id) => !ids.includes(id)), "a churned original id left the block");
                assert.ok(ids.some((id) => !earlyIds.includes(id)), "its churned replacement was claimed by the block");
                const active = session.state.blocks.filter((b) => b.active);
                assert.equal(active.length, 2, `the job applied on the same request (note=${/did not apply \(([^)]*)\)/.exec(rig.seen[from]!.body)?.[1] ?? "none"})`);
                assert.ok(active.some((b) => b.compressCallId?.startsWith(ac.ASYNC_COMPRESS_CALL_ID_PREFIX)), "the new block is the async one");
                assert.equal(ac._asyncCompressStateForTest().jobs.size, 0, "job consumed");
                const wire = rig.seen[from]!.body;
                assert.ok(wire.includes(SUMMARY.slice(0, 60)) && wire.includes(EARLY.slice(0, 40)), "both carriers ride the request");
                assert.ok(!wire.includes("user turn 1:"), "the churned covered message stays folded");
            }

            // (b) churn inside the captured span: reconcile does not claim uncovered messages, so the
            // captured view no longer matches and the job is discarded with a note.
            {
                chosen = undefined;
                const { h2 } = await setup("recon-b");
                const session = sessionFor("recon-b")!;
                const start = Number(chosen!.startId.slice(1)), end = Number(chosen!.endId.slice(1));
                const blocks0 = session.state.blocks.filter((b) => b.active).map((b) => b.blockId);
                const churned = h2.map((m, i) => (i >= 6 && i < 40 && m.role === "user" ? churn(m) : m));
                const from = rig.seen.length;
                await chat(rig, "recon-b", [...churned, { role: "user", content: "continue" }], false);
                assert.ok(end > start);
                assert.deepEqual(session.state.blocks.filter((b) => b.active).map((b) => b.blockId), blocks0, "no block committed");
                assert.equal(ac._asyncCompressStateForTest().jobs.size, 0, "job consumed");
                const why = /did not apply \(([^)]*)\)/.exec(rig.seen[from]!.body)?.[1];
                assert.match(why ?? "", /^discarded as stale: range m\d+-m\d+ changed in the current view$/, `stale via the current view (got ${why ?? "none"})`);
                assert.ok(!rig.seen[from]!.body.includes(SUMMARY.slice(0, 60)), "the fork summary never reaches the wire");
            }
        } finally {
            await closeRig(rig);
        }
    } finally {
        ac.configureAsyncCompress(false);
        ac.disposeAsyncCompress("test end");
    }
});
