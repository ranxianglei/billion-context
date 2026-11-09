// #4755: a runtime give-up left the dsh lane permanently direct/uncompressed
// even though a healthy replacement proxy was listening on the lane port — so
// every turn re-sent the full history, over-window bodies were refused locally
// (422), and the session became unrecoverable.
//
// A give-up lands the register in the shape {base: undefined, toolsReady: true}
// (#3380: host-context tool registrations survive a proxy death). Two defects
// left exactly that shape with NO self-heal driver:
//   A) the recovery timer's tick cleared itself on `register.toolsReady` alone
//      — the post-give-up shape — so an armed timer died on its first tick
//      without ever calling maybeRetry;
//   B) fireGiveUp never armed the timer, and degraded model traffic never
//      reaches headersFor (origin resolution fails first), so nothing else
//      re-drove the respawn loop until an /acp command or a host restart.
//
// This test drives the production give-up hook, then proves the recovery timer
// alone (zero model traffic) re-bases the register onto a replacement proxy —
// and that the timer clears itself once healthy again (no background churn).

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { apply, _resetRegisterForTest, _setSpawnForTest, _settleNativeForTest, _stateOnGiveUpForTest, _nativeStateForTest, _registerStateForTest } from "../src/agent/dsh-native.ts";
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
        tools: {
            register: (t: RegisteredTool) => { tools.push(t); },
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

test("#4755 a given-up register (base-less + tools-ready) self-heals through the recovery timer with zero model traffic", async () => {
    const proxy1 = await startMockProxy();
    const proxy2 = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-4755-giveup-"));
    try {
        await withEnv({
            DSH_HOME: home,
            BILLION_CONTEXT_PROXY: proxy1.origin,
            BILI_DSH_RECOVERY_INTERVAL_MS: "20",
            BILI_DSH_RETRY_INTERVAL_MS: "20",
            // the verifyAttachAndRecover tail waits this long for routed-traffic
            // evidence before taking its spawn fallback — keep the test snappy
            BILI_ATTACH_EVIDENCE_GRACE_MS: "20",
        }, async () => {
            _resetRegisterForTest(proxy1.origin);

            // phase 1: healthy attach — base bound, tools registered
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial tool registration");
            assert.equal(_registerStateForTest().base, proxy1.origin);
            assert.equal(_registerStateForTest().toolsReady, true);

            // phase 2: the attached proxy dies and its respawn attempt gives up.
            // The production give-up hook must land the post-give-up register
            // shape (base-less, tools ready) AND arm the recovery driver there.
            proxy1.close();
            const giveUp = _stateOnGiveUpForTest();
            assert.notEqual(giveUp, undefined, "attach mode arms the give-up hook");
            giveUp!();
            const reg = _registerStateForTest();
            assert.equal(reg.base, undefined, "give-up clears the base");
            assert.equal(reg.toolsReady, true, "#3380: tool registrations survive the give-up");

            // phase 3: a replacement comes up while the preset has proven dead
            // (field case: another launcher owns the healthy listener). Drop the
            // dead preset — spawnFallback does the same unfreeze — so
            // verifyAttachAndRecover takes its spawn-fallback tail, which honors
            // the stubbed spawn. Zero model traffic from here on: only the
            // recovery timer may heal.
            delete process.env.BILLION_CONTEXT_PROXY;
            let attempts = 0;
            _setSpawnForTest(() => {
                attempts += 1;
                return Promise.resolve(proxy2.origin);
            });
            try {
                await waitFor(() => _registerStateForTest().base === proxy2.origin, "timer-driven re-base onto the replacement");
                assert.equal(_nativeStateForTest().origin, proxy2.origin, "interceptor origin follows the healed base");
                assert.ok(attempts >= 1, "the respawn drove the stubbed spawn");
                // churn pin: once healthy again the timer must clear itself —
                // neither respawns nor re-registrations may follow
                const settledManifest = proxy2.manifestRequests();
                await new Promise((r) => setTimeout(r, 150));
                assert.equal(attempts, 1, "no background respawn churn after the heal");
                assert.equal(proxy2.manifestRequests(), settledManifest, "no background re-registration after the heal (#3380: registrations survive)");
            } finally {
                _setSpawnForTest(undefined);
            }
        });
    } finally {
        proxy1.close();
        proxy2.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});
