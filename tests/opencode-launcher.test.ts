import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// The launcher plugin reads BILLION_CONTEXT_PROXY AT IMPORT TIME (the
// `bili opencode` launcher sets it). Arm it before the dynamic import so this
// suite drives the ATTACH lane end-to-end with real local servers standing in
// for the shared proxy. node --test isolates each file in its own process, so
// the env mutation cannot leak into other suites.
const MODEL_URL = "https://api.anthropic.com/v1/messages";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function startFakeProxy(): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if ((req.url ?? "") === "/__bili/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if ((req.url ?? "") === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "9.9.9-test" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        // closeAllConnections forces instant ECONNREFUSED on the next probe —
        // a bare close() would let pooled keep-alive sockets answer once more.
        close: async () => {
            server.closeAllConnections?.();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    }));
}

interface FakeAddedTool {
    name: string;
    execute: (input: Record<string, unknown>, ctx: { sessionID: string }) => Promise<{ content: string }>;
}

function makeFakeCtx() {
    const eventQueue: Array<{ type?: unknown; data?: Record<string, unknown> }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let signal: AbortSignal | undefined;
    const addedTools: FakeAddedTool[] = [];
    let modelRequestCb: ((e: Record<string, unknown>) => void | Promise<void>) | undefined;

    const ctx = {
        session: {
            hook: async (name: string, cb: (e: Record<string, unknown>) => void | Promise<void>) => {
                assert.equal(name, "http.request");
                modelRequestCb = cb;
                return { dispose: () => { closed = true; wake?.(); } };
            },
            synthetic: async (_input: unknown) => ({}),
        },
        tool: {
            transform: async (cb: (editor: { add: (t: FakeAddedTool) => void }) => void) => {
                cb({ add: (t) => addedTools.push(t) });
                return { dispose: () => {} };
            },
        },
        command: {
            transform: async (cb: (editor: { add: (c: unknown) => void }) => void) => {
                cb({ add: () => {} });
                return { dispose: () => {} };
            },
        },
        event: {
            subscribe: (opts?: { signal?: AbortSignal }) => {
                signal = opts?.signal;
                signal?.addEventListener("abort", () => { closed = true; wake?.(); }, { once: true });
                return {
                    [Symbol.asyncIterator]: (): AsyncIterator<{ type?: unknown; data?: Record<string, unknown> }> => ({
                        next: async () => {
                            while (eventQueue.length === 0 && !closed && !signal?.aborted) {
                                await new Promise<void>((r) => (wake = r));
                            }
                            wake = undefined;
                            const v = eventQueue.shift();
                            return v === undefined ? { done: true as const, value: undefined } : { done: false as const, value: v };
                        },
                    }),
                };
            },
        },
        catalog: {
            model: {
                list: async () => ({ data: [{ providerID: "qwen", id: "m1", limit: { context: 262144 } }] }),
            },
        },
    };

    return {
        ctx,
        // The route REPLACES e.request with a new Request (host contract: the
        // host reads e.request AFTER the hook) — so observe through the event,
        // never through the pre-hook reference.
        fireModelRequest: async (sessionID: string, url: string): Promise<Request> => {
            const e: Record<string, unknown> = {
                sessionID,
                model: { providerID: "qwen", id: "m1" },
                request: new Request(url, { method: "POST" }),
            };
            await modelRequestCb!(e);
            assert.ok(e.request instanceof Request, "hook must leave a Request on the event");
            return e.request;
        },
        get addedTools() { return addedTools; },
    };
}

const proxyA = await startFakeProxy();
const proxyB = await startFakeProxy();
process.env.BILLION_CONTEXT_PROXY = proxyA.origin;

const mod = await import("../src/agent/opencode.ts");
const plugin = mod.default;
const { _setRespawnForTest, _interceptStateForTest } = mod;
const { _resetForTest } = await import("../src/agent/native-intercept.ts");

const savedFetch = globalThis.fetch;
let fake: ReturnType<typeof makeFakeCtx> | undefined;
let cleanup: (() => void | Promise<void>) | undefined;

test.after(async () => {
    await cleanup?.();
    globalThis.fetch = savedFetch;
    _resetForTest();
    _setRespawnForTest(undefined);
    await proxyA.close();
    await proxyB.close();
});

test("launcher plugin: server() returns the acp hooks and installs the v1 fetch patch", async () => {
    const hooks = await plugin.server({});
    assert.equal(typeof hooks.config, "function");
    assert.equal(typeof hooks["command.execute.before"], "function");
    assert.notEqual(globalThis.fetch, savedFetch, "fetch patch installed");
});

test("launcher plugin: steady-state model traffic routes through the attached proxy", async () => {
    fake = makeFakeCtx();
    cleanup = await plugin.setup(fake.ctx as never);
    const req = await fake.fireModelRequest("ses_1", MODEL_URL);
    assert.equal(req.url, `${proxyA.origin}/bili/${MODEL_URL}`);
});

test("launcher plugin: shared-proxy death respawns and re-bakes the overlay URL (#1135)", async () => {
    // wait out the probe-TTL cache (#928) so the next request re-probes
    await sleep(2100);
    _setRespawnForTest(async () => {
        const st = _interceptStateForTest();
        if (st !== undefined) st.origin = proxyB.origin;
        process.env.BILLION_CONTEXT_PROXY = proxyB.origin;
        return proxyB.origin;
    });
    await proxyA.close();
    const req = await fake!.fireModelRequest("ses_1", `${proxyA.origin}/bili/${MODEL_URL}`);
    assert.equal(req.url, `${proxyB.origin}/bili/${MODEL_URL}`, "baked overlay re-routed to the replacement");
    assert.equal(process.env.BILLION_CONTEXT_PROXY, proxyB.origin);
});

test("launcher plugin: failed respawn degrades to a DIRECT send, stripping the dead hop (#1135)", async () => {
    await sleep(2100);
    _setRespawnForTest(async () => undefined);
    await proxyB.close();
    const req = await fake!.fireModelRequest("ses_1", MODEL_URL);
    assert.equal(req.url, MODEL_URL, "no live proxy: request goes straight to the upstream");
    assert.equal(process.env.BILLION_CONTEXT_PROXY, undefined, "onGiveUp cleared the proxy-owned env");
});

test("launcher plugin: non-model requests are untouched across the whole lifecycle", async () => {
    const req = await fake!.fireModelRequest("ses_1", "https://example.com/api/data");
    assert.equal(req.url, "https://example.com/api/data");
});
