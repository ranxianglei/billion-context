// #2187: a boot-time spawn failure must self-heal within the process. Before
// this fix the retry machinery was unreachable after a bootstrap failure —
// every production caller of maybeRetry sat behind a bound origin, so one
// failed spawn meant permanent direct-send and /bili/origin stuck at null.
// apply() now arms the retry at plan time; these tests pin that the recovery
// timer drives retries with ZERO model traffic until a proxy lands.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { apply, _resetRegisterForTest, _setSpawnForTest, _settleNativeForTest, _stateHeadersForTest } from "../src/agent/dsh-native.ts";
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

function mockBiliHandler(manifestDelayMs = 0): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    const manifestTools: MockTool[] = [
        {
            name: "compress",
            description: "Compress a range of messages",
            inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
        },
    ];
    return (_req, res) => {
        if ((_req.url ?? "") === "/__bili/plugin/manifest") {
            const respond = () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
            };
            if (manifestDelayMs > 0) setTimeout(respond, manifestDelayMs);
            else respond();
            return;
        }
        res.writeHead(404);
        res.end("{}");
    };
}

async function startMockProxy(): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer(mockBiliHandler());
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

type HostCtx = Parameters<typeof apply>[0];

function mockCtx() {
    const tools: RegisteredTool[] = [];
    const commands: Array<{ name: string; handler: () => Promise<{ kind: string; text: string }> }> = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: { register: (t: RegisteredTool) => { tools.push(t); } },
        commands: { register: (c: { name: string; handler: () => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (_deps: readonly string[], _cb: (sub: HostCtx) => void) => {},
    };
}

// #2260(F): ambient proxy env must never leak into this suite — a BILI_PROVIDER_REWRITES
// inherited from the runner's shell flips planNativeDsh to "off" (src/agent/dsh-native.ts),
// so the spawn would be skipped and the timeouts below would test nothing.
const SEALED_PROXY_ENV = ["BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "NODE_EXTRA_CA_CERTS"];

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of SEALED_PROXY_ENV) {
        if (!(k in env)) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    }
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

test("#2187 boot-time spawn failure self-heals with zero model traffic — timer-driven retries land the proxy and register the tools", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2187-spawn-"));
    try {
        await withEnv(
            { DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_DSH_RECOVERY_INTERVAL_MS: "20", BILI_DSH_RETRY_INTERVAL_MS: "20" },
            async () => {
                _resetRegisterForTest(undefined); // base-less spawn plan
                let attempts = 0;
                _setSpawnForTest(() => {
                    attempts += 1;
                    return Promise.resolve(attempts <= 2 ? undefined : proxy.origin);
                });
                try {
                    const ctx = mockCtx();
                    ctx.setInitiator({ session: { id: "dsh-2187-session" } });
                    apply(ctx);
                    // two consecutive boot failures — before the fix nothing
                    // would ever retry after this point
                    await waitFor(() => attempts >= 3, "a third attempt fires after two failed boots");
                    await waitFor(() => ctx.registeredTools.length === 1, "timer-driven registration with zero model traffic");
                    assert.equal(ctx.registeredTools[0].name, "compress");
                    await waitFor(
                        () => _stateHeadersForTest()?.("http://example.test/v1/messages") !== undefined,
                        "headers stamped after the heal",
                    );
                } finally {
                    _setSpawnForTest(undefined);
                }
            },
        );
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#2187 persistent spawn failure keeps retrying instead of degrading permanently", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2187-persist-"));
    try {
        await withEnv(
            { DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_DSH_RECOVERY_INTERVAL_MS: "20", BILI_DSH_RETRY_INTERVAL_MS: "20" },
            async () => {
                _resetRegisterForTest(undefined);
                let attempts = 0;
                _setSpawnForTest(() => {
                    attempts += 1;
                    return Promise.resolve(undefined);
                });
                try {
                    apply(mockCtx());
                    // the old behavior was exactly ONE attempt for the whole
                    // process lifetime; the recovery timer must keep firing
                    await waitFor(() => attempts >= 4, "retries keep firing while every attempt fails");
                } finally {
                    _setSpawnForTest(undefined);
                }
            },
        );
    } finally {
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});
