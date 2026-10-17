// #2082: the plugin-side recovery hardening.
//
// 1. apply() resets register.dead — one "inactive context" rejection during a
//    cordis deactivate/reactivate cycle used to poison the register for the
//    whole process lifetime (every later maybeRetry returned immediately; the
//    bili tools never came back until dsh restarted).
// 2. maybeRetry() arms a fallback respawn when state.respawn is undefined —
//    a base-less register with nothing armed used to return and stay dead.
// 3. A detached recovery timer keeps retrying while the tools are down even
//    with zero model traffic (the reported case: the model already gave up on
//    the missing tools, so nothing re-armed the loop).

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { apply, maybeRetryForTest, _resetRegisterForTest, _setSpawnForTest, _settleNativeForTest, _stateHeadersForTest, _stateRespawnForTest } from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

afterEach(() => { void _settleNativeForTest(); });

type MockTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};

function mockBiliHandler(counters: { manifestRequests: number }, manifestDelayMs = 0): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    const manifestTools: MockTool[] = [
        {
            name: "compress",
            description: "Compress a range of messages",
            inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
        },
    ];
    return (req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            counters.manifestRequests += 1;
            const respond = () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
            };
            // a slow manifest widens the fetch window so a re-activation can
            // land while a registration is still in flight
            if (manifestDelayMs > 0) setTimeout(respond, manifestDelayMs);
            else respond();
            return;
        }
        res.writeHead(404);
        res.end("{}");
    };
}

async function startMockProxy(manifestDelayMs = 0): Promise<{ origin: string; close: () => void; manifestRequests: () => number }> {
    const counters = { manifestRequests: 0 };
    const server = http.createServer(mockBiliHandler(counters, manifestDelayMs));
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close(), manifestRequests: () => counters.manifestRequests });
        });
    });
}

type HostCtx = Parameters<typeof apply>[0];

const INACTIVE_CONTEXT_ERROR = 'cannot get required service "tools" in inactive context';

function mockCtx(opts: { registerError?: () => Error | undefined } = {}) {
    const tools: RegisteredTool[] = [];
    const commands: Array<{ name: string; handler: () => Promise<{ kind: string; text: string }> }> = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: {
            register: (t: RegisteredTool) => {
                const err = opts.registerError?.();
                if (err !== undefined) throw err;
                tools.push(t);
            },
        },
        commands: { register: (c: { name: string; handler: () => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (_deps: readonly string[], _cb: (sub: HostCtx) => void) => {},
    };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

test("#2082 maybeRetry arms a fallback respawn when state.respawn was never armed, and the recovery timer drives retries with zero model traffic (#2082)", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2082-fallback-"));
    const savedInterval = process.env.BILI_DSH_RECOVERY_INTERVAL_MS;
    const savedRetry = process.env.BILI_DSH_RETRY_INTERVAL_MS;
    process.env.BILI_DSH_RECOVERY_INTERVAL_MS = "20";
    process.env.BILI_DSH_RETRY_INTERVAL_MS = "20";
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            _resetRegisterForTest(undefined); // base-less
            // first respawn attempt fails (proxy down); the next one lands —
            // only a RETRY can recover, and with no model traffic in this
            // test the retry can only come from the recovery timer
            let attempts = 0;
            _setSpawnForTest(() => {
                attempts += 1;
                return Promise.resolve(attempts === 1 ? undefined : proxy.origin);
            });
            try {
                assert.equal(_stateRespawnForTest(), undefined, "precondition: nothing armed");
                const ctx = mockCtx();
                maybeRetryForTest(ctx);
                // the fallback armed a respawn (first attempt already failed)
                await waitFor(() => _stateRespawnForTest() !== undefined, "fallback respawn armed");
                // the timer keeps driving maybeRetry until the second attempt
                // lands, the base binds, and the manifest registers the tool
                await waitFor(() => ctx.registeredTools.length === 1, "timer-driven registration with zero model traffic");
                assert.ok(attempts >= 2, `expected a retry, got ${attempts} attempts`);
                assert.equal(ctx.registeredTools[0].name, "compress");
            } finally {
                _setSpawnForTest(undefined);
            }
        });
    } finally {
        for (const [k, v] of [["BILI_DSH_RECOVERY_INTERVAL_MS", savedInterval], ["BILI_DSH_RETRY_INTERVAL_MS", savedRetry]] as const) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#2082 apply() clears register.dead: a re-activated context recovers after an inactive-context teardown (#2082)", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2082-dead-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            // phase 1: the context is inactive during teardown — registration
            // throws cordis's inactive-context error and the register dies
            let tearing = true;
            const ctx1 = mockCtx({ registerError: () => (tearing ? new Error(INACTIVE_CONTEXT_ERROR) : undefined) });
            apply(ctx1);
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(ctx1.registeredTools.length, 0);

            // phase 2: the host re-activates the plugin (fresh context). The
            // dead verdict must NOT survive — tools register again.
            tearing = false;
            const ctx2 = mockCtx();
            ctx2.setInitiator({ session: { id: "dsh-2082-session" } });
            apply(ctx2);
            await waitFor(() => ctx2.registeredTools.length === 1, "tool registration after re-activation");
            assert.equal(ctx2.registeredTools[0].name, "compress");
            // headers are stamped again — plugin mode is back
            await waitFor(() => _stateHeadersForTest()?.("http://example.test/v1/messages") !== undefined, "headers return after re-activation");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#2082 recovery timer retries through the LATEST context after re-activation — a stale capture would re-poison dead", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2082-staletimer-"));
    const savedInterval = process.env.BILI_DSH_RECOVERY_INTERVAL_MS;
    const savedRetry = process.env.BILI_DSH_RETRY_INTERVAL_MS;
    process.env.BILI_DSH_RECOVERY_INTERVAL_MS = "20";
    process.env.BILI_DSH_RETRY_INTERVAL_MS = "20";
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);

            // phase 1: ctx1 fails with a TRANSIENT error (not inactive-context)
            // — the register stays alive (!dead), tools stay down, and the
            // recovery timer is armed while ctx1 is still the current context.
            let mode1: "transient" | "inactive" = "transient";
            let attempts1 = 0;
            const ctx1 = mockCtx({
                registerError: () => {
                    attempts1 += 1;
                    return mode1 === "transient" ? new Error("transient manifest registration failure") : new Error(INACTIVE_CONTEXT_ERROR);
                },
            });
            apply(ctx1);
            maybeRetryForTest(ctx1);
            await waitFor(() => attempts1 >= 1, "first transient registration attempt");

            // phase 2: dsh deactivates ctx1 and re-activates the plugin with
            // ctx2. ctx2's own first attempt also fails transiently, so once
            // its back-off expires the ONLY remaining driver is the recovery
            // timer — it must retry through ctx2, not the stale ctx1 capture
            // (registering into the deactivated ctx1 throws inactive-context
            // and re-poisons dead, leaving the tools down until dsh restarts).
            mode1 = "inactive";
            let attempts2 = 0;
            const ctx2 = mockCtx({
                registerError: () => {
                    attempts2 += 1;
                    return attempts2 === 1 ? new Error("transient manifest registration failure") : undefined;
                },
            });
            apply(ctx2);
            await waitFor(() => ctx2.registeredTools.length === 1, "timer-driven registration through the LATEST context");
            assert.equal(ctx2.registeredTools[0].name, "compress");
            assert.ok(attempts2 >= 2, `expected ctx2's first attempt to fail and a retry to land (got ${attempts2} attempts)`);
            assert.equal(ctx1.registeredTools.length, 0, "nothing registered into the deactivated context");
        });
    } finally {
        for (const [k, v] of [["BILI_DSH_RECOVERY_INTERVAL_MS", savedInterval], ["BILI_DSH_RETRY_INTERVAL_MS", savedRetry]] as const) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#2082 an in-flight registration lands on the LATEST context after a mid-fetch re-activation", async () => {
    const proxy = await startMockProxy(300);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2082-inflight-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);

            // ctx1 starts a registration whose manifest fetch is still in
            // flight when dsh deactivates it and re-activates the plugin with
            // ctx2 — the single-flight landing must target ctx2, not the stale
            // ctx1 capture (which would die on inactive-context and poison
            // dead before ctx2 ever gets its tools).
            let deactivated1 = false;
            const ctx1 = mockCtx({ registerError: () => (deactivated1 ? new Error(INACTIVE_CONTEXT_ERROR) : undefined) });
            apply(ctx1);
            await waitFor(() => proxy.manifestRequests() >= 1, "manifest fetch in flight");
            deactivated1 = true;
            const ctx2 = mockCtx();
            apply(ctx2);
            await waitFor(() => ctx2.registeredTools.length === 1, "in-flight registration landing on the re-activated context");
            assert.equal(ctx2.registeredTools[0].name, "compress");
            assert.equal(ctx1.registeredTools.length, 0, "nothing registered into the deactivated context");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});
