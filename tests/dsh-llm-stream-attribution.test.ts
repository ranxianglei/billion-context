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
    _stateHeadersForTest,
    _stateTakeoverGateForTest,
    type PluginContext,
    type ForkChildVerdict,
} from "../src/agent/dsh-native.ts";
import { __resetConversationRecallForTests } from "../src/agent/conversation-recall.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";

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

async function withSetup(fn: (handle: CtxHandle) => Promise<void>): Promise<void> {
    __resetConversationRecallForTests();
    const home = mkdtempSync(join(tmpdir(), "dsh-llm-stream-"));
    const saved: Record<string, string | undefined> = {};
    for (const key of ["BILLION_CONTEXT_PROXY", "DSH_HOME", "BILLION_CONTEXT_PLUGIN", "BILI_NATIVE_DSH", "BILI_PROVIDER_REWRITES"]) {
        saved[key] = process.env[key];
    }
    const proxy = await startMockProxy();
    process.env.BILLION_CONTEXT_PROXY = proxy.origin;
    process.env.DSH_HOME = home;
    _resetRegisterForTest(proxy.origin);
    const handle = makeCtx();
    try {
        await apply(handle.ctx);
        await waitFor(() => handle.registered.length === 1, "attach tool registration");
        await fn(handle);
    } finally {
        await _settleNativeForTest();
        proxy.server.close();
        proxy.server.closeIdleConnections?.();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    }
}

interface MockProxy {
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
