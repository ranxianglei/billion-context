/**
 * #5614: DSH Remote — a NEW model operation must not inherit the previous
 * transport fetch's re-entry state and silently skip compression.
 *
 * The fetch chain tracks per-request dispatch depth in AsyncLocalStorage
 * (#1662) plus a one-hop descent marker (#4527). Those values persist in ANY
 * callback minted inside a `.run()` scope even after that fetch has settled,
 * so a fresh model op whose transport callbacks were created during an earlier
 * fetch inherits a stale `dispatchDepth` and its first request falls into the
 * depth-1 branch of the chain gate — skipping `dispatchBody` (the compression
 * entry) and going direct/uncompressed. On Windows + DSH Remote + a Go client
 * this turned a ~140K-token session into a 1.4M-token CONTEXT_WINDOW_EXCEEDED.
 *
 * Fix: every dsh model-op boundary (hook next(), iterator factory, next,
 * return, throw) re-enters the sid/msgIds scope INSIDE runOutsideFetchChain,
 * which clears BOTH re-entry stores for the operation's own subtree only — so
 * #1662's foreign-wrapper cutoff keeps firing inside each single-fetch descent
 * and resumes on return, while session attribution and unrelated host ALS stay
 * intact. Both directions are pinned below (dispatch-when-it-should AND
 * cutoff-when-it-should-not).
 */
import { strict as assert } from "node:assert";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Hermetic posture (same as the sibling dsh tests): nothing here may depend on
// this machine's real proxy/env wiring.
delete process.env.BILI_PROVIDER_REWRITES;
delete process.env.BILI_NATIVE_DSH;
delete process.env.BILLION_CONTEXT_PLUGIN;

import {
    apply,
    _resetRegisterForTest,
    _settleNativeForTest,
    _stateHeadersForTest,
    type PluginContext,
} from "../src/agent/dsh-native.ts";
import { __resetConversationRecallForTests } from "../src/agent/conversation-recall.ts";
import { installFetchChain, resetFetchChainForTest, runOutsideFetchChain } from "../src/agent/fetch-chain/index.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";

interface CtxHandle {
    ctx: PluginContext;
    events: Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>;
    setInitiator: (sid: string | undefined) => void;
    registered: Array<{ name: string }>;
}

function makeCtx(): CtxHandle {
    const events = new Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>();
    const registered: Array<{ name: string }> = [];
    let currentSid: string | undefined;
    const ctx = {
        inject: (deps: readonly string[], cb: (sub: unknown) => void) => {
            if (deps.includes("llm")) cb({});
        },
        on: (name: string, listener: (payload: unknown, next: () => unknown) => unknown) => {
            const list = events.get(name) ?? [];
            list.push(listener);
            events.set(name, list);
        },
        emit: () => undefined,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        tools: { register: (tool: { name: string }) => void registered.push(tool) },
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

/** Compose the registered llm/stream waterfall over a base adapter, mirroring
 *  how cordis drives it (outermost first, each gets (options, next)). */
function runWaterfall(
    events: Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>,
    options: Record<string, unknown>,
    base: () => AsyncIterable<unknown>,
): AsyncIterable<unknown> {
    const listeners = events.get("llm/stream") ?? [];
    const composed = listeners.reduceRight<(payload: unknown, next: () => unknown) => unknown>(
        (acc, listener) => (payload, next) => listener(payload, () => acc(payload, next)),
        () => base(),
    );
    return composed(options, () => base()) as AsyncIterable<unknown>;
}

interface MockProxy {
    origin: string;
    server: http.Server;
}

async function startMockProxy(): Promise<MockProxy> {
    const server = http.createServer((req, res) => {
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

async function withSetup(fn: (handle: CtxHandle) => Promise<void>): Promise<void> {
    __resetConversationRecallForTests();
    const home = mkdtempSync(join(tmpdir(), "dsh-fetch-boundary-"));
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

test("#5614 fetch-chain primitive: runOutsideFetchChain re-dispatches a stale-context fetch", async () => {
    const originalFetch = globalThis.fetch;
    const canned = (async () => new Response("ok")) as typeof fetch;
    let dispatches = 0;
    let captured: AsyncResource | undefined;
    globalThis.fetch = canned;
    resetFetchChainForTest({ anchor: canned });
    installFetchChain((send) => async (input, init) => {
        dispatches += 1;
        if (captured === undefined) captured = new AsyncResource("stale-continuation");
        return send(input, init);
    });
    try {
        await globalThis.fetch("http://example.test/a");
        assert.equal(dispatches, 1, "top-level fetch dispatches and mints the stale resource at depth 1");
        assert.ok(captured, "stale transport continuation captured");
        await captured!.runInAsyncScope(async () => {
            const before = dispatches;
            await globalThis.fetch("http://example.test/b");
            assert.equal(dispatches, before, "WITHOUT the reset a stale-context fetch is cut off (the bug)");
            await runOutsideFetchChain(() => globalThis.fetch("http://example.test/c"));
            assert.equal(dispatches, before + 1, "runOutsideFetchChain turns it back into a fresh dispatch");
            await globalThis.fetch("http://example.test/d");
            assert.equal(dispatches, before + 1, "the parent cutoff is restored after the cleared operation");
        });
    } finally {
        captured?.emitDestroy();
        resetFetchChainForTest();
        globalThis.fetch = originalFetch;
    }
});

test("#5614 dsh remote: a new model op from a stale transport context still compresses", async () => {
    await withSetup(async (handle) => {
        const headersFor = _stateHeadersForTest();
        assert.ok(headersFor, "headersFor stamp is installed after apply()");

        let modelDispatches = 0;
        let capturedStale: AsyncResource | undefined;
        let seeding = false;
        resetFetchChainForTest();
        installFetchChain((send) => async (input, init) => {
            if (String(input).includes("/v1/model-probe")) modelDispatches += 1;
            if (seeding && capturedStale === undefined) capturedStale = new AsyncResource("stale-model-op");
            return send(input, init);
        });
        try {
            const proxyOrigin = process.env.BILLION_CONTEXT_PROXY as string;
            const hostContext = new AsyncLocalStorage<{ tag?: string }>();
            const firedStages: string[] = [];
            const sids: Array<string | undefined> = [];
            const hosts: Array<unknown> = [];
            const pendingFetches: Array<Promise<Response>> = [];
            const probe = (stage: string) => {
                firedStages.push(stage);
                sids.push(headersFor?.(MODEL_URL)?.["x-bili-plugin-conversation"]);
                hosts.push(hostContext.getStore()?.tag);
                pendingFetches.push(globalThis.fetch(`${proxyOrigin}/v1/model-probe`));
            };
            const makeBase = (): (() => AsyncIterable<string>) => () => {
                probe("creation");
                return {
                    [Symbol.asyncIterator]() {
                        probe("iterator-factory");
                        let yielded = false;
                        return {
                            async next() {
                                probe("next");
                                if (yielded) return { done: true, value: undefined };
                                yielded = true;
                                return { done: false, value: "token" };
                            },
                            async return() {
                                probe("return");
                                return { done: true, value: undefined };
                            },
                            async throw(reason: unknown) {
                                probe("throw");
                                throw reason;
                            },
                        };
                    },
                };
            };

            await hostContext.run({ tag: "host-session-context" }, async () => {
                // Seed INSIDE hostContext so the captured stale continuation also
                // carries the host ALS value — proving the reset clears only the two
                // fetch-chain stores, never unrelated host state.
                seeding = true;
                await globalThis.fetch(`${proxyOrigin}/v1/seed`);
                seeding = false;
                assert.ok(capturedStale, "captured a stale transport continuation");

                await capturedStale!.runInAsyncScope(async () => {
                    // (1) ordinary re-entry straight from the stale context is STILL cut off
                    //     — the #1662 foreign-wrapper protection is not defeated by the reset.
                    const beforeReentry = modelDispatches;
                    await globalThis.fetch(`${proxyOrigin}/v1/model-probe`);
                    assert.equal(modelDispatches, beforeReentry, "ordinary stale re-entry retains the foreign-wrapper cutoff");

                    // (2) the model op: every boundary re-dispatches (compression entry runs).
                    const staleCount = modelDispatches;
                    const stream = runWaterfall(handle.events, { sessionId: "llm-session" }, makeBase());
                    const it = stream[Symbol.asyncIterator]();
                    assert.deepEqual(await it.next(), { done: false, value: "token" });
                    await it.return?.();
                    await assert.rejects(it.throw?.(new Error("iterator sentinel")) ?? Promise.resolve(), /iterator sentinel/);
                    await Promise.all(pendingFetches);
                    assert.equal(modelDispatches, staleCount + 5, "creation, iterator factory, next, return, throw each dispatch once");

                    // (3) the inherited parent cutoff is restored after the op completes.
                    const afterOps = modelDispatches;
                    await globalThis.fetch(`${proxyOrigin}/v1/model-probe`);
                    assert.equal(modelDispatches, afterOps, "inherited parent cutoff is restored after each model operation");
                });
            });

            assert.deepEqual(firedStages, ["creation", "iterator-factory", "next", "return", "throw"]);
            assert.ok(sids.every((s) => s === "llm-session"), `session attribution rides every boundary, got ${JSON.stringify(sids)}`);
            assert.ok(hosts.every((h) => h === "host-session-context"), `host AsyncLocalStorage is not cleared, got ${JSON.stringify(hosts)}`);
        } finally {
            resetFetchChainForTest();
        }
    });
});

test("#5614 dsh remote: concurrent model ops keep their own scope (no cross-talk)", async () => {
    await withSetup(async (handle) => {
        const headersFor = _stateHeadersForTest();
        assert.ok(headersFor);
        let capturedStale: AsyncResource | undefined;
        resetFetchChainForTest();
        installFetchChain((send) => async (input, init) => {
            if (capturedStale === undefined) capturedStale = new AsyncResource("stale-model-op");
            return send(input, init);
        });
        try {
            const proxyOrigin = process.env.BILLION_CONTEXT_PROXY as string;
            await globalThis.fetch(`${proxyOrigin}/v1/seed`);
            assert.ok(capturedStale);
            const seen: Array<string | undefined> = [];
            const makeBase = (value: string): (() => AsyncIterable<string>) => () => {
                seen.push(headersFor?.(MODEL_URL)?.["x-bili-plugin-conversation"]);
                return {
                    [Symbol.asyncIterator]() {
                        let yielded = false;
                        return {
                            async next() {
                                if (!yielded) {
                                    yielded = true;
                                    return { done: false, value };
                                }
                                return { done: true, value: undefined };
                            },
                            async return() {
                                return { done: true, value: undefined };
                            },
                            async throw(reason: unknown) {
                                throw reason;
                            },
                        };
                    },
                };
            };
            await capturedStale.runInAsyncScope(async () => {
                const a = runWaterfall(handle.events, { sessionId: "op-A" }, makeBase("A"));
                const b = runWaterfall(handle.events, { sessionId: "op-B" }, makeBase("B"));
                await Promise.all([
                    (async () => { const it = a[Symbol.asyncIterator](); await it.next(); await it.return?.(); })(),
                    (async () => { const it = b[Symbol.asyncIterator](); await it.next(); await it.return?.(); })(),
                ]);
            });
            assert.deepEqual([...seen].sort(), ["op-A", "op-B"], `each concurrent op sees its own sid, got ${JSON.stringify(seen)}`);
        } finally {
            resetFetchChainForTest();
        }
    });
});
