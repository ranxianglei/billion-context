/**
 * #4082: dsh llm/stream attribution — session identity rides the request
 * object, not the async chain.
 *
 * dsh's LlmRuntime stamps options.sessionId on every dispatch (main loop
 * buildRequest, compaction, session-title) and documents the llm/stream
 * waterfall as the interception point. The plugin wraps each stream's
 * iteration in an AsyncLocalStorage keyed by that sid, so adapter fetches
 * stay attributed through exactly the shapes the ambient initiator reading
 * loses: retry chains, agentless side-calls, disposed initiator scopes.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

// Same hermetic posture as the sibling dsh tests: nothing in this file
// should depend on this machine's real proxy/env wiring.
delete process.env.BILI_PROVIDER_REWRITES;
delete process.env.BILI_NATIVE_DSH;
delete process.env.BILLION_CONTEXT_PLUGIN;

import {
    apply,
    forkChildVerdict,
    _resetRegisterForTest,
    _settleNativeForTest,
    _stateBeforeSendForTest,
    _nativeStateForTest,
    _resetRoutedForTest,
    _stateHeadersForTest,
    _stateTakeoverGateForTest,
    type PluginContext,
    type ForkChildVerdict,
} from "../src/agent/dsh-native.ts";
import { __resetConversationRecallForTests } from "../src/agent/conversation-recall.ts";
import { installNativeWebSocketIntercept, _resetForTest as resetWsIntercept } from "../src/agent/native-ws-intercept.ts";
import { WebSocket, WebSocketServer } from "ws";
import { apply as applyNativePolicy, configureNativeCompaction, nativeModel } from "../src/agent/dsh-native-compaction.ts";
import { installNativeFetchIntercept, _resetForTest as resetFetchIntercept } from "../src/agent/native-intercept.ts";

test("DSH dispatch switches native/bili/native with unchanged native wire and a new bili generation", async () => {
    await withSetup(async (handle, proxy) => {
        const savedFetch = globalThis.fetch;
        resetFetchIntercept();
        installNativeFetchIntercept(_nativeStateForTest());
        const { createServer } = await import("node:http");
        const direct: Array<{ headers: import("node:http").IncomingHttpHeaders; body: string }> = [];
        const routed: Array<{ url: string; conversation: string | string[] | undefined }> = [];
        proxy.server.on("request", req => {
            if (req.url?.startsWith("/bili/")) routed.push({ url: req.url, conversation: req.headers["x-bili-plugin-conversation"] });
        });
        const upstream = createServer(async (req, res) => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            direct.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
            res.end("native");
        });
        await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
        const address = upstream.address();
        assert.ok(address && typeof address === "object");
        const url = `http://127.0.0.1:${address.port}/v1/responses`;
        let model = "codex/gpt-test";
        const agent = { model: { current: () => ({ provider: "test", model }) }, session: { id: "native-switch-http", surface: { replaceGeneration: 0 } } };
        handle.ctx.agents.get = sid => sid === agent.session.id ? agent : undefined;
        configureNativeCompaction([{ model: "codex/gpt-*" }]);
        applyNativePolicy({
            on: (_event, callback) => callback({ agent }, () => undefined),
        } as Parameters<typeof applyNativePolicy>[0], { noBackend: true });
        const send = async (body: string) => {
            const stream = runWaterfall(handle.events, { sessionId: agent.session.id, provider: "test", model }, async function* () {
                await Promise.resolve();
                await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-test-signed": "verbatim" }, body });
                yield 1;
            });
            for await (const _ of stream) { /* Drain the adapter inside its dispatch scope. */ }
        };
        try {
            await send('{"model":"codex/gpt-test","input":"native one"}');
            assert.equal(direct.length, 1);
            assert.equal(routed.length, 0);
            assert.equal(direct[0].headers["x-bili-plugin"], undefined);
            assert.equal(direct[0].headers["x-test-signed"], "verbatim");
            assert.equal(direct[0].body, '{"model":"codex/gpt-test","input":"native one"}');
            agent.session.surface.replaceGeneration = 2;
            model = "kimi";
            await send('{"model":"kimi","input":"checkpoint plus tail"}');
            assert.equal(routed.length, 1);
            assert.equal(routed[0].conversation, "native-switch-http|dsh-generation:2");
            model = "codex/gpt-test";
            await send('{"model":"codex/gpt-test","input":"native two"}');
            assert.equal(direct.length, 2);
            assert.equal(routed.length, 1);
            assert.equal(direct[1].headers["x-bili-plugin"], undefined);
        } finally {
            configureNativeCompaction([]);
            resetFetchIntercept({ anchor: savedFetch });
            globalThis.fetch = savedFetch;
            upstream.close();
            upstream.closeAllConnections();
        }
    });
});

const MODEL_URL = "https://api.anthropic.com/v1/messages";

// The kernel stamps wall-clock `yyyy-mm-dd hh:mm:ss` timestamps into the
// payload in two places: the ACP tag's time="…" attribute (local time of
// occurrence) and the compress tool-result's block time range "[start – end]".
// The arms below fork separate proxies that run at different wall-clock times,
// so those values legitimately differ across arms even when the payload is
// otherwise byte-identical. Mask every wall-clock timestamp before the
// cross-arm deepEqual so the comparison tests payload fidelity, not the clock
// (same sanctioned normalization as issue5403-watermark-fastpath.test.ts). All
// message content here is test-controlled, so no user timestamp can be masked.
function maskWallClockTime(value: unknown): unknown {
    if (typeof value === "string") return value.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "T");
    if (Array.isArray(value)) return value.map(maskWallClockTime);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskWallClockTime(v)]));
    }
    return value;
}

test("bili-only and model-routed bili have identical real proxy folds and forwarded requests", { timeout: 30_000 }, async () => {
    const { createServer } = await import("node:http");
    const { fork } = await import("node:child_process");
    const forwards: unknown[] = [];
    const upstream = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        forwards.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "fixed-response", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ACK" }, finish_reason: "stop" }], usage: { prompt_tokens: 30000, completion_tokens: 3, total_tokens: 30003 } }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const outcomes: unknown[] = [];
    try {
        for (const mode of ["bili-only", "routed-bili", "routed-after-native-checkpoint"]) {
            let child: import("node:child_process").ChildProcess;
            let diagnostics = "";
            type Snapshot = { sessions: Array<{ id: string; refs: Record<string, string>; blocks: import("acp-kernel").CompressionBlock[] }> };
            const snapshot = () => new Promise<Snapshot>(resolve => { child.once("message", data => resolve(data as Snapshot)); child.send("snapshot"); });
            forwards.length = 0;
            await withSetup(async (handle, proxy) => {
                configureNativeCompaction(mode === "bili-only" ? undefined : [{ model: "gpt-*" }]);
                assert.equal(nativeModel({ model: "gpt-test" }), mode !== "bili-only");
                assert.equal(nativeModel({ model: "glm-test" }), false);
                const savedFetch = globalThis.fetch;
                const agent = { model: { current: () => ({ provider: "test", model: "glm-test" }) }, session: { id: "bili-parity", surface: { replaceGeneration: mode === "routed-after-native-checkpoint" ? 2 : 0 } } };
                handle.ctx.agents.get = sid => sid === agent.session.id ? agent : undefined;
                const manifest = await (await fetch(proxy.origin + "/__bili/plugin/manifest")).json() as { tools: { openai: unknown[] } };
                const messages: Array<{ id: string; role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }> = Array.from({ length: 24 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? "assistant" : "user", content: `Archive ${i}: keep ROUTE-811 and never modify production. `.repeat(240) }));
                resetFetchIntercept(); installNativeFetchIntercept(_nativeStateForTest());
                const send = async () => {
                    const body = JSON.stringify({ model: "glm-test", max_tokens: 64000, messages: messages.map(({ id, ...m }) => m), tools: [{ type: "function", function: { name: "read", description: "Read a test fixture", parameters: { type: "object", properties: {} } } }, ...manifest.tools.openai] });
                    const stream = runWaterfall(handle.events, { sessionId: agent.session.id, provider: "test", model: "glm-test", messages }, async function* () {
                        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
                        assert.equal(response.status, 200, await response.text());
                        yield 1;
                    });
                    for await (const _ of stream) { /* Drain the actual attributed request. */ }
                };
                try {
                    await send();
                    const sessions = (await snapshot()).sessions; assert.equal(sessions.length, 1);
                    const session = sessions[0];
                    assert.equal(session.id, mode === "routed-after-native-checkpoint" ? "bili-parity|dsh-generation:2" : "bili-parity");
                    const refs = session.refs;
                    assert.equal(Object.keys(refs).length, 24);
                    const startId = Object.values(refs)[0], endId = Object.values(refs)[9];
                    const tool = handle.registered.find(t => t.name === "compress") as RegisteredToolLike & { execute: (args: unknown, context: unknown) => Promise<unknown> };
                    assert.ok(tool);
                    const args = { content: [{ startId, endId, summary: "ROUTE-811; never modify production; archive rows 0-9 received." }] };
                    const result = await tool.execute(args, { agent });
                    const compressed = (await snapshot()).sessions[0];
                    assert.equal(compressed.blocks.length, 1, JSON.stringify(result));
                    messages.push({ id: "compression-call", role: "assistant", content: null, tool_calls: [{ id: "compress-1", type: "function", function: { name: "compress", arguments: JSON.stringify(args) } }] }, { id: "compression-result", role: "tool", tool_call_id: "compress-1", content: String(result) }, { id: "current-task", role: "user", content: "Continue with the retained facts." });
                    await send();
                    const after = (await snapshot()).sessions[0];
                    assert.equal(after.blocks.length, 1);
                    assert.equal(after.blocks[0].active, true);
                    assert.ok(JSON.stringify(forwards[1]).includes(args.content[0].summary));
                    assert.ok(JSON.stringify(forwards[1]).length < JSON.stringify(forwards[0]).length);
                    outcomes.push({ forwards: structuredClone(forwards).map(maskWallClockTime), blocks: after.blocks.map(({ createdAt, compressCallId, durationMs, ...b }) => b), tools: handle.registered.map(t => t.name) });
                } finally { resetFetchIntercept({ anchor: savedFetch }); globalThis.fetch = savedFetch; }
            }, async () => {
                child = fork(new URL("./fixtures/dsh-compaction-parity-proxy.mjs", import.meta.url), [`http://127.0.0.1:${address.port}`], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, BILI_PERSIST: "0" } });
                child.stderr?.on("data", data => { diagnostics += String(data); });
                child.stdout?.on("data", data => { diagnostics += String(data); });
                const origin = await new Promise<string>((resolve, reject) => {
                    child.once("message", data => resolve((data as { origin: string }).origin));
                    child.once("error", reject);
                    child.once("exit", code => reject(new Error(`proxy child exited ${code}: ${diagnostics}`)));
                });
                return { server: createServer(), origin, dispose: async () => {
                    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
                    child.disconnect(); await exited;
                } };
            });
        }
        assert.deepEqual(outcomes[1], outcomes[0], "routing must not change bili's tool surface, folding or provider payloads");
        assert.deepEqual(outcomes[2], outcomes[0], "a fresh generation must use the same bili algorithm on the same visible history");
    } finally {
        configureNativeCompaction(undefined);
        upstream.closeAllConnections();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
});

interface RegisteredToolLike {
    name: string;
}

interface CtxHandle {
    ctx: PluginContext;
    events: Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>;
    setInitiator: (sid: string | undefined) => void;
    registered: RegisteredToolLike[];
}

function makeCtx(): CtxHandle {
    const events = new Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>();
    const registered: RegisteredToolLike[] = [];
    let currentSid: string | undefined;
    const ctx = {
        inject: (deps: readonly string[], cb: (sub: unknown) => void) => {
            // Only the llm service matters here; other inject targets
            // (webServer, agentDefaultModel, …) stay cold like the sibling
            // test harness.
            if (deps.includes("llm")) cb({});
        },
        on: (name: string, listener: (payload: unknown, next: () => unknown) => unknown) => {
            const list = events.get(name) ?? [];
            list.push(listener);
            events.set(name, list);
        },
        emit: () => undefined,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        tools: { register: (tool: RegisteredToolLike) => void registered.push(tool) },
        commands: { register: () => undefined },
        agents: {
            currentInitiator: () =>
                currentSid === undefined ? undefined : { session: { id: currentSid } },
        },
        setInitiator: (sid: string | undefined) => {
            currentSid = sid;
        },
    } as unknown as PluginContext & { setInitiator: (sid: string | undefined) => void };
    return { ctx, events, setInitiator: (sid) => ctx.setInitiator(sid), registered };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/**
 * Runs the registered llm/stream waterfall over a base adapter (the role
 * dsh's real LlmRuntime plays): composes the listeners like cordis does —
 * outermost first, each receives (options, next) — and returns the final
 * iterable so tests can advance it and assert scope retention across
 * yields (the shape of an adapter retry loop).
 */
function runWaterfall(
    events: Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>,
    options: Record<string, unknown>,
    base: () => AsyncIterable<number>,
): AsyncIterable<number> {
    const listeners = events.get("llm/stream") ?? [];
    const composed = listeners.reduceRight<(payload: unknown, next: () => unknown) => unknown>(
        (acc, listener) => (payload, next) => listener(payload, () => acc(payload, next)),
        () => base(),
    );
    return composed(options, () => base()) as AsyncIterable<number>;
}

async function withSetup(fn: (handle: CtxHandle, proxy: MockProxy) => Promise<void>, factory = startMockProxy): Promise<void> {
    __resetConversationRecallForTests();
    const home = mkdtempSync(join(tmpdir(), "dsh-llm-stream-"));
    const saved: Record<string, string | undefined> = {};
    for (const key of ["BILLION_CONTEXT_PROXY", "DSH_HOME", "BILLION_CONTEXT_PLUGIN", "BILI_NATIVE_DSH", "BILI_PROVIDER_REWRITES"]) {
        saved[key] = process.env[key];
    }
    const proxy = await factory();
    process.env.BILLION_CONTEXT_PROXY = proxy.origin;
    process.env.DSH_HOME = home;
    _resetRegisterForTest(proxy.origin);
    const handle = makeCtx();
    try {
        await apply(handle.ctx);
        await waitFor(() => handle.registered.length >= 1, "attach tool registration");
        await fn(handle, proxy);
    } finally {
        await _settleNativeForTest();
        proxy.server.close();
        proxy.server.closeIdleConnections?.();
        await proxy.dispose?.();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    }
}

interface MockProxy {
    dispose?: () => Promise<void>;
    origin: string;
    server: import("node:http").Server;
}

async function startMockProxy(): Promise<MockProxy> {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                version: "0.1.119",
                tools: { anthropic: [{ name: "compress", description: "Compress a range of messages", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } }] },
            }));
            return;
        }
        if (url === "/__bili/plugin/session-name") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({}));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "object" && !("port" in address)) throw new Error("no port");
    const port = typeof address === "object" && "port" in address ? address.port : 0;
    return { origin: `http://127.0.0.1:${port}`, server };
}

test("DSH Codex WS receives scoped plugin identity and reuses the attributed socket", { timeout: 15_000 }, async () => {
    await withSetup(async (handle, proxy) => {
        const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
        const wss = new WebSocketServer({ noServer: true });
        const upgrades: import("node:http").IncomingMessage[] = [];
        const frames: string[] = [];
        proxy.server.on("upgrade", (req, socket, head) => {
            upgrades.push(req);
            wss.handleUpgrade(req, socket, head, peer => {
                peer.on("message", data => { frames.push(String(data)); peer.send("ack"); });
            });
        });
        let socket: WebSocket | undefined;
        try {
            Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: WebSocket });
            installNativeWebSocketIntercept(_nativeStateForTest());
            const Ctor = globalThis.WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
            handle.setInitiator(undefined);
            for (let turn = 0; turn < 2; turn++) {
                const iterator = runWaterfall(handle.events, { sessionId: "ws-scoped-session" }, async function* () {
                    if (socket === undefined) {
                        socket = new Ctor("wss://chatgpt.com/backend-api/codex/responses", { headers: { "session-id": "provider-session" } });
                        await new Promise<void>((resolve, reject) => {
                            socket!.addEventListener("open", () => resolve(), { once: true });
                            socket!.addEventListener("error", reject, { once: true });
                        });
                    }
                    const ack = new Promise<void>((resolve, reject) => {
                        socket!.addEventListener("message", () => resolve(), { once: true });
                        socket!.addEventListener("error", reject, { once: true });
                    });
                    socket.send(JSON.stringify({ type: "response.create", model: "test-model", input: [{ role: "user", content: `test turn ${turn}` }] }));
                    await ack;
                    yield turn;
                });
                for await (const value of iterator) assert.equal(value, turn);
            }
            assert.equal(upgrades.length, 1);
            assert.equal(upgrades[0].url, "/bili/https://chatgpt.com/backend-api/codex/responses");
            assert.equal(upgrades[0].headers["x-bili-plugin"], "dsh");
            assert.equal(upgrades[0].headers["x-bili-plugin-conversation"], "ws-scoped-session");
            assert.equal(upgrades[0].headers["session-id"], "provider-session");
            assert.equal(frames.length, 2);
        } finally {
            socket?.close();
            for (const peer of wss.clients) peer.terminate();
            await new Promise<void>(resolve => wss.close(() => resolve()));
            resetWsIntercept();
            _resetRoutedForTest();
            if (original !== undefined) Object.defineProperty(globalThis, "WebSocket", original);
            else Reflect.deleteProperty(globalThis, "WebSocket");
        }
    });
});

function headersOf(init: { headers?: unknown }): Record<string, string> {
    const raw = init.headers;
    if (raw instanceof Headers) {
        const out: Record<string, string> = {};
        for (const [k, v] of raw.entries()) out[k] = v;
        return out;
    }
    if (Array.isArray(raw)) return Object.fromEntries(raw as [string, string][]);
    if (raw && typeof raw === "object") return { ...(raw as Record<string, string>) };
    return {};
}

test("llm/stream sid survives a lost ambient initiator (retry shape)", async (t) => {
    await withSetup(async (handle) => {
        const gate = _stateTakeoverGateForTest();
        const beforeSend = _stateBeforeSendForTest();
        const headersFor = _stateHeadersForTest();
        assert.ok(gate, "takeover gate is installed after apply()");
        assert.ok(beforeSend, "beforeSend hook is installed after apply()");
        assert.ok(headersFor, "headersFor stamp is installed after apply()");
        const verdicts: Array<boolean | string | { action: string } | undefined> = [];
        const stamps: Array<Record<string, string>> = [];
        // The "adapter": performs its work (fetch-shaped gate+beforeSend
        // calls) before the first yield AND after resuming from it — the
        // shape of an adapter-internal retry loop.
        const base = async function* (): AsyncIterable<number> {
            const init: { headers?: Record<string, string> } = {
                headers: { "content-type": "application/json" },
            };
            verdicts.push(await gate(MODEL_URL, { bytes: 120 }, init));
            await beforeSend(MODEL_URL, init);
            stamps.push({ ...(headersFor?.(MODEL_URL) ?? {}), ...headersOf(init) });
            yield 1;
            // Post-yield resumption: the scope must re-enter on advance.
            const init2: { headers?: Record<string, string> } = {
                headers: { "content-type": "application/json" },
            };
            verdicts.push(await gate(MODEL_URL, { bytes: 120 }, init2));
            await beforeSend(MODEL_URL, init2);
            stamps.push({ ...(headersFor?.(MODEL_URL) ?? {}), ...headersOf(init2) });
            return;
        };
        // No ambient initiator — the exact retry shape where the ambient
        // reading lost attribution (#4082/#3918).
        handle.setInitiator(undefined);
        const stream = runWaterfall(handle.events, { sessionId: "sess-gamma", model: "deepseek-chat" }, base);
        const it = stream[Symbol.asyncIterator]();
        const first = await it.next();
        assert.deepEqual(first, { done: false, value: 1 });
        const second = await it.next();
        assert.ok(second.done, "generator completes");
        assert.equal(verdicts.length, 2);
        assert.ok(verdicts[0] !== false && verdicts[0] !== undefined, "pre-yield gate accepts the scoped dispatch");
        assert.ok(verdicts[1] !== false && verdicts[1] !== undefined, "post-yield advance stays in scope");
        assert.equal(stamps[0]["x-bili-plugin-conversation"], "sess-gamma");
        assert.equal(stamps[1]["x-bili-plugin-conversation"], "sess-gamma");
    });
});

test("agentless dispatch without sessionId passes through unattributed", async (t) => {
    await withSetup(async (handle) => {
        const gate = _stateTakeoverGateForTest();
        assert.ok(gate);
        let gateCalls = 0;
        const base = async function* (): AsyncIterable<number> {
            gateCalls++;
            yield 7;
        };
        handle.setInitiator(undefined);
        const stream = runWaterfall(handle.events, { model: "deepseek-chat" }, base);
        const results: number[] = [];
        for await (const chunk of stream) results.push(chunk);
        assert.deepEqual(results, [7], "values pass through untouched");
        // The generator never called the gate; nothing is stamped.
        assert.equal(gateCalls, 1);
    });
});

test("request-object sid outranks the ambient initiator", async (t) => {
    await withSetup(async (handle) => {
        const gate = _stateTakeoverGateForTest();
        const beforeSend = _stateBeforeSendForTest();
        const headersFor = _stateHeadersForTest();
        assert.ok(gate);
        assert.ok(beforeSend);
        assert.ok(headersFor);
        let stamped: Record<string, string> = {};
        const base = async function* (): AsyncIterable<number> {
            const init: { headers?: Record<string, string> } = { headers: {} };
            await gate(MODEL_URL, { bytes: 80 }, init);
            await beforeSend(MODEL_URL, init);
            stamped = { ...(headersFor?.(MODEL_URL) ?? {}), ...headersOf(init) };
            yield 1;
        };
        handle.setInitiator("sess-ambient");
        const stream = runWaterfall(handle.events, { sessionId: "sess-dispatch" }, base);
        const it = stream[Symbol.asyncIterator]();
        await it.next();
        // The dispatch's own sessionId is the truth (the loop stamped the
        // session it is driving); the ambient initiator is the fallback.
        assert.equal(stamped["x-bili-plugin-conversation"], "sess-dispatch");
    });
});

test("fork discovery resolves only the exact request-scoped seeded child", async () => {
    await withSetup(async (handle) => {
        const lookups: string[] = [];
        const child = { session: { id: "child", header: { isSeeded: true, parentSession: "parent" } } };
        const agents = new Map<string, typeof child>([["child", child]]);
        handle.ctx.agents.get = (sid) => { lookups.push(sid); return agents.get(sid); };
        async function discover(sid?: string): Promise<ForkChildVerdict | undefined> {
            let result: ForkChildVerdict | undefined;
            const base = async function* (): AsyncIterable<number> {
                result = forkChildVerdict(handle.ctx);
                yield 1;
                await Promise.resolve();
                assert.deepEqual(forkChildVerdict(handle.ctx), result, "lookup survives stream continuation");
            };
            for await (const _ of runWaterfall(handle.events, { sessionId: sid }, base)) { /* drain */ }
            return result;
        }
        assert.deepEqual(await discover("child"), { ok: true, sid: "child", parent: "parent" });
        assert.deepEqual(lookups, ["child", "child"]);
        assert.equal((await discover("unknown"))?.ok, false);
        const beforeUnscoped = lookups.length;
        assert.equal((await discover())?.ok, false);
        assert.equal(lookups.length, beforeUnscoped, "no guessing a recently active child");
        agents.set("child", { session: { id: "different", header: child.session.header } });
        assert.equal((await discover("child"))?.ok, false, "lookup must return the requested session");
        for (const header of [
            { isSeeded: false, parentSession: "parent" },
            { isSeeded: true, parentSession: "" },
            { isSeeded: true, parentSession: "child" },
        ]) {
            agents.set("child", { session: { id: "child", header } });
            assert.equal((await discover("child"))?.ok, false);
        }
        agents.set("child", child);
        handle.ctx.agents.currentInitiator = () => child;
        handle.ctx.agents.get = () => { throw new Error("ambient path must not look up"); };
        assert.deepEqual(await discover(), { ok: true, sid: "child", parent: "parent" });
        handle.ctx.agents.currentInitiator = () => undefined;
        assert.equal((await discover("child"))?.ok, false, "lookup errors fail closed");
        handle.ctx.agents.get = undefined;
        assert.equal((await discover("child"))?.ok, false, "older hosts remain supported");
        handle.ctx.agents.currentInitiator = () => { throw new Error("disposed scope"); };
        assert.equal((await discover("child"))?.ok, false);
    });
});

test("agentless compaction dispatch (sessionId, no initiator) is attributed", async (t) => {
    await withSetup(async (handle) => {
        const gate = _stateTakeoverGateForTest();
        const beforeSend = _stateBeforeSendForTest();
        const headersFor = _stateHeadersForTest();
        assert.ok(gate);
        assert.ok(beforeSend);
        assert.ok(headersFor);
        let verdict: boolean | string | { action: string } | undefined;
        let stamped: Record<string, string> = {};
        const base = async function* (): AsyncIterable<number> {
            const init: { headers?: Record<string, string> } = { headers: {} };
            verdict = await gate(MODEL_URL, { bytes: 200 }, init);
            await beforeSend(MODEL_URL, init);
            stamped = { ...(headersFor?.(MODEL_URL) ?? {}), ...headersOf(init) };
            yield 1;
        };
        // dsh-compaction-basic runMaintenance: no initiator, sessionId +
        // purpose stamped on the dispatch.
        handle.setInitiator(undefined);
        const stream = runWaterfall(handle.events, { sessionId: "sess-compaction", purpose: "compaction" }, base);
        const it = stream[Symbol.asyncIterator]();
        await it.next();
        assert.ok(verdict !== false && verdict !== undefined, "compaction lane is attributed via the request sid");
        assert.equal(stamped["x-bili-plugin-conversation"], "sess-compaction");
    });
});
