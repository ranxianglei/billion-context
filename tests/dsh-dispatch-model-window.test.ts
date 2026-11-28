/**
 * dsh llm/stream dispatches are sized against the model THEY stream to, and a
 * model's first dispatch carries its window: the window header used to come
 * from the session header's model (wrong for auxiliary calls on another
 * model) and from a fire-and-forget resolve (absent on a model's first fetch).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

delete process.env.BILI_PROVIDER_REWRITES;
delete process.env.BILI_NATIVE_DSH;
delete process.env.BILLION_CONTEXT_PLUGIN;

import { apply, _resetRegisterForTest, _settleNativeForTest, _stateHeadersForTest, type PluginContext } from "../src/agent/dsh-native.ts";
import { __resetConversationRecallForTests } from "../src/agent/conversation-recall.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";
type Listener = (payload: unknown, next: () => unknown) => unknown;
type Resolve = (provider: string, model: string) => Promise<{ context?: { contextWindow?: number } } | undefined>;

async function startMockProxy(): Promise<{ origin: string; server: Server }> {
    const server = createServer((req, res) => {
        res.writeHead(req.url === "/__bili/plugin/manifest" || req.url === "/__bili/plugin/session-name" ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url === "/__bili/plugin/manifest"
            ? { version: "0.1.119", tools: { anthropic: [{ name: "compress", description: "c", input_schema: { type: "object", properties: {} } }] } }
            : {}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("no port");
    return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function withDsh(resolve: Resolve, sessionModel: string, fn: (dispatch: (options: Record<string, unknown>) => Promise<Record<string, string>>) => Promise<void>): Promise<void> {
    __resetConversationRecallForTests();
    const home = mkdtempSync(join(tmpdir(), "dsh-dispatch-model-"));
    const saved = { BILLION_CONTEXT_PROXY: process.env.BILLION_CONTEXT_PROXY, DSH_HOME: process.env.DSH_HOME };
    const proxy = await startMockProxy();
    process.env.BILLION_CONTEXT_PROXY = proxy.origin;
    process.env.DSH_HOME = home;
    _resetRegisterForTest(proxy.origin);
    const listeners: Listener[] = [];
    const registered: unknown[] = [];
    const services = { llm: { resolveModelInfo: resolve }, agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "main-model" }) } };
    const ctx = {
        inject: (deps: readonly string[], cb: (sub: unknown) => void) => { if (deps.includes("llm")) cb(services); },
        on: (name: string, listener: Listener) => { if (name === "llm/stream") listeners.push(listener); },
        emit: () => undefined,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        tools: { register: (tool: unknown) => void registered.push(tool) },
        commands: { register: () => undefined },
        agents: { currentInitiator: () => ({ session: { id: "ambient", requestHeader: () => ({ config: { provider: "deepseek", model: sessionModel } }) } }) },
    } as unknown as PluginContext;
    // One adapter fetch per dispatch: the headers stamped on its FIRST request.
    const dispatch = async (options: Record<string, unknown>): Promise<Record<string, string>> => {
        let stamped: Record<string, string> = {};
        const base = async function* (): AsyncIterable<number> {
            stamped = _stateHeadersForTest()?.(MODEL_URL) ?? {};
            yield 1;
        };
        const composed = listeners.reduceRight<Listener>((acc, l) => (p, n) => l(p, () => acc(p, n)), () => base());
        for await (const _ of composed(options, () => base()) as AsyncIterable<number>) { /* drain */ }
        return stamped;
    };
    try {
        await apply(ctx);
        const deadline = Date.now() + 15_000;
        while (registered.length === 0) {
            if (Date.now() > deadline) throw new Error("timeout waiting for tool registration");
            await new Promise((r) => setTimeout(r, 20));
        }
        await fn(dispatch);
    } finally {
        await _settleNativeForTest();
        proxy.server.close();
        proxy.server.closeIdleConnections?.();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
        _resetRegisterForTest(undefined);
    }
}

const WINDOWS: Record<string, number> = { "main-model": 1_000_000, "aux-model": 65_536, "fresh-model": 131_072 };
// The session's own model resolves at boot; every other model resolves late.
const slowResolve: Resolve = (_provider, model) => model === "main-model"
    ? Promise.resolve({ context: { contextWindow: WINDOWS[model] } })
    : new Promise((r) => setTimeout(() => r({ context: { contextWindow: WINDOWS[model] } }), 100));

test("auxiliary dispatch on another model stamps THAT model's window on its first request", async () => {
    await withDsh(slowResolve, "main-model", async (dispatch) => {
        const deadline = Date.now() + 15_000;
        while (_stateHeadersForTest()?.(MODEL_URL)?.["x-bili-plugin-context-window"] !== "1000000") {
            if (Date.now() > deadline) throw new Error("timeout waiting for the session model's window");
            await new Promise((r) => setTimeout(r, 20));
        }
        const headers = await dispatch({ sessionId: "sess-aux", purpose: "compaction", provider: "deepseek", model: "aux-model" });
        assert.equal(headers["x-bili-plugin-conversation"], "sess-aux");
        assert.equal(headers["x-bili-plugin-model"], "aux-model");
        assert.equal(headers["x-bili-plugin-context-window"], "65536");
        // A dispatch on the session's own model keeps that model's window.
        const main = await dispatch({ sessionId: "sess-aux", provider: "deepseek", model: "main-model" });
        assert.equal(main["x-bili-plugin-model"], "main-model");
        assert.equal(main["x-bili-plugin-context-window"], "1000000");
    });
});

test("a model's first dispatch waits for its window instead of going out without it", async () => {
    await withDsh(slowResolve, "fresh-model", async (dispatch) => {
        const headers = await dispatch({ sessionId: "sess-fresh" });
        assert.equal(headers["x-bili-plugin-model"], "fresh-model");
        assert.equal(headers["x-bili-plugin-context-window"], "131072");
    });
});

test("a hung resolver delays only a model's first dispatch, and only by the bound", async () => {
    const hung: Resolve = (_provider, model) => model === "aux-model" ? new Promise(() => {}) : Promise.resolve({ context: { contextWindow: WINDOWS[model] } });
    await withDsh(hung, "main-model", async (dispatch) => {
        let t0 = Date.now();
        const first = await dispatch({ sessionId: "sess-hung", provider: "deepseek", model: "aux-model" });
        const firstMs = Date.now() - t0;
        assert.equal(first["x-bili-plugin-context-window"], undefined);
        assert.ok(firstMs >= 1_500 && firstMs < 5_000, `first dispatch waited ${firstMs}ms`);
        t0 = Date.now();
        await dispatch({ sessionId: "sess-hung", provider: "deepseek", model: "aux-model" });
        assert.ok(Date.now() - t0 < 500, "a later dispatch does not wait on the hung resolve again");
    });
});
