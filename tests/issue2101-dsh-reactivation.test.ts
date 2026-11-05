// #2101: a re-activation after a HEALTHY registration must re-register the
// bili tools into the new context.
//
// #2082's fix (v0.1.184) covered the failure orderings: a registerTools
// rejection mid-teardown (dead poison), a base-less register with no respawn
// armed, and an in-flight fetch landing after a re-activation. But the
// success ordering was still open: tools registered successfully into ctx1
// stamp register.toolsReady=true, and when dsh later deactivates ctx1 and
// re-activates the plugin with ctx2 (a settings toggle, a profile switch, a
// plugin reload), apply() reset register.dead but NOT toolsReady — and every
// registerTools()/maybeRetry() early-returns on it, so ctx2 never got the
// tools until dsh restarted. Same user-visible symptom as #2082.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { apply, _resetRegisterForTest, _settleNativeForTest, _stateHeadersForTest } from "../src/agent/dsh-native.ts";
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

function mockBiliHandler(counters: { manifestRequests: number }): (req: http.IncomingMessage, res: http.ServerResponse) => void {
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
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    };
}

async function startMockProxy(): Promise<{ origin: string; close: () => void; manifestRequests: () => number }> {
    const counters = { manifestRequests: 0 };
    const server = http.createServer(mockBiliHandler(counters));
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close(), manifestRequests: () => counters.manifestRequests });
        });
    });
}

type HostCtx = Parameters<typeof apply>[0];

function mockCtx() {
    const tools: RegisteredTool[] = [];
    const commands: Array<{ name: string; handler: () => Promise<{ kind: string; text: string }> }> = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: { register: (t: RegisteredTool) => tools.push(t) },
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

test("#2101 a re-activation AFTER a healthy registration re-registers the tools into the new context", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2101-reactivation-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);

            // phase 1: a healthy boot — the fetch lands while ctx1 is still
            // active and the tool registers into ctx1 (the ordering #2082's
            // fix did not cover: nothing ever threw, register.toolsReady is
            // stamped, the plugin looks perfectly healthy).
            const ctx1 = mockCtx();
            ctx1.setInitiator({ session: { id: "dsh-2101-session-1" } });
            apply(ctx1);
            await waitFor(() => ctx1.registeredTools.length === 1, "initial registration into ctx1");
            assert.equal(ctx1.registeredTools[0].name, "compress");
            const fetchesAfterBoot = proxy.manifestRequests();

            // phase 2: much later dsh deactivates ctx1 and re-activates the
            // plugin with ctx2 (settings toggle / profile switch / reload).
            // The tools died with ctx1, but toolsReady still carries the old
            // stamp — without the #2101 clear, every registerTools()/
            // maybeRetry() early-returns and ctx2 never gets the bili tools
            // until dsh restarts.
            const ctx2 = mockCtx();
            ctx2.setInitiator({ session: { id: "dsh-2101-session-2" } });
            apply(ctx2);
            await waitFor(() => ctx2.registeredTools.length === 1, "re-registration into the re-activated context");
            assert.equal(ctx2.registeredTools[0].name, "compress");
            assert.ok(proxy.manifestRequests() > fetchesAfterBoot, "the re-activation re-fetched the manifest instead of trusting the stale stamp");
            // plugin mode is live again for the new context
            await waitFor(() => _stateHeadersForTest()?.("http://example.test/v1/messages") !== undefined, "headers stamped after re-activation");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#2101 same-context re-apply keeps the lane healthy — the stale-stamp clear is scoped to a context CHANGE", async () => {
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2101-same-ctx-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);

            const ctx1 = mockCtx();
            ctx1.setInitiator({ session: { id: "dsh-2101-same-ctx" } });
            apply(ctx1);
            await waitFor(() => ctx1.registeredTools.length === 1, "initial registration into ctx1");

            // apply() running again with the SAME context (a benign re-entry
            // — the attach verify path re-checks the proxy and may re-fetch
            // the manifest, pre-existing behavior) must not tear the lane
            // down: the tools stay live for ctx1 and headers keep stamping.
            apply(ctx1);
            await new Promise((r) => setTimeout(r, 150));
            assert.ok(ctx1.registeredTools.length >= 1, "tools stay registered for the same context");
            const tool = ctx1.registeredTools.find((t) => t.name === "compress");
            assert.ok(tool !== undefined, "the compress tool is still present after re-apply");
            assert.notEqual(_stateHeadersForTest()?.("http://example.test/v1/messages"), undefined, "headers still stamped");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});
