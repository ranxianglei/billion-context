// /acp cordis plugin for dsh (deepseek-harness): proxy bootstrap outcomes
// (env proxy / spawned daemon / failure), the latest-session panel, the
// fetch-interceptor arming (#521), and the bootstrap-race gate (a first LLM
// fetch firing before the daemon spawn finishes must wait, not leak direct).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as dshAcp from "../src/agent/dsh-acp.ts";

type Outcome = { kind: "success" | "error"; text: string };

type Hooks = {
    env: Record<string, string | undefined>;
    routes: Record<string, { status: number; body: unknown }>;
    spawn?: (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
    readSettings?: () => { text: string; exists: boolean };
    /** Collect every URL handed to the (intercepted) fetch. */
    record?: string[];
    /** Skip teardown: leave the interceptor armed for post-checks. */
    keep?: boolean;
};

async function runHandler(hooks: Hooks): Promise<Outcome> {
    dshAcp._resetTestHooks();
    const injected: Parameters<typeof dshAcp._setTestHooks>[0] = {};
    if (hooks.spawn !== undefined) injected.spawn = hooks.spawn;
    if (hooks.readSettings !== undefined) injected.readSettings = hooks.readSettings;
    if (Object.keys(injected).length > 0) dshAcp._setTestHooks(injected);

    const prev = { ...process.env } as Record<string, string | undefined>;
    const prevFetch = globalThis.fetch;
    for (const [k, v] of Object.entries(hooks.env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        hooks.record?.push(url);
        for (const [prefix, route] of Object.entries(hooks.routes)) {
            if (url.startsWith(prefix)) {
                return new Response(JSON.stringify(route.body), { status: route.status, headers: { "content-type": "application/json" } });
            }
        }
        return new Response("{}", { status: 404 });
    }) as typeof fetch;

    let handler: (() => Promise<Outcome>) | undefined;
    const ctx = {
        commands: {
            register: (cmd: { name: string; description: string; handler: () => Promise<Outcome> }) => {
                assert.equal(cmd.name, "acp");
                handler = cmd.handler;
            },
        },
    };
    try {
        dshAcp.apply(ctx as never);
        assert.ok(handler, "handler registered");
        return await handler();
    } finally {
        if (!hooks.keep) {
            dshAcp._resetTestHooks();
            globalThis.fetch = prevFetch;
            for (const k of Object.keys(hooks.env)) {
                const v = prev[k];
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    }
}

const SETTINGS_CUSTOM = `llm-pi-ai:\n  providers:\n    local-vllm:\n      api: openai-completions\n      baseURL: http://10.0.0.5:8199/v1\n      models:\n        - id: qwen-test\n          contextWindow: 262144\nagent-default-model:\n  provider: local-vllm\n  model: qwen-test\n`;

test("dsh-acp /acp: env proxy + live session → panel, interceptor rewrites upstream traffic", async () => {
    const record: string[] = [];
    const out = await runHandler({
        env: { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        routes: {
            "http://127.0.0.1:8787/__bili/health": { status: 200, body: { ok: true } },
            "http://127.0.0.1:8787/__bili/plugin/status": {
                status: 200,
                body: { ok: true, panel: "ACP Context Analysis\nbillion-context@9.9.9" },
            },
        },
        readSettings: () => ({ text: SETTINGS_CUSTOM, exists: true }),
        record,
        keep: true,
    });
    assert.equal(out.kind, "success");
    assert.ok(out.text.startsWith("billion-context: http://10.0.0.5:8199 → http://127.0.0.1:8787"), out.text);
    assert.ok(out.text.includes("ACP Context Analysis"));
    // Interceptor armed: upstream-origin requests are rewritten through /bili/.
    await globalThis.fetch("http://10.0.0.5:8199/v1/chat/completions");
    assert.deepEqual(record.at(-1), "http://127.0.0.1:8787/bili/http://10.0.0.5:8199/v1/chat/completions");
    // Other origins pass through untouched.
    await globalThis.fetch("http://other.example.com/x");
    assert.deepEqual(record.at(-1), "http://other.example.com/x");
    dshAcp._resetTestHooks();
});

test("dsh-acp /acp: 404 status + live manifest → armed-but-idle info", async () => {
    const out = await runHandler({
        env: { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        routes: {
            "http://127.0.0.1:8787/__bili/health": { status: 200, body: { ok: true } },
            "http://127.0.0.1:8787/__bili/plugin/status": { status: 404, body: { ok: false } },
            "http://127.0.0.1:8787/__bili/plugin/manifest": { status: 200, body: { version: "9.9.9" } },
        },
        readSettings: () => ({ text: "", exists: false }),
    });
    assert.equal(out.kind, "success");
    assert.match(out.text, /^billion-context@9\.9\.9 — proxy connected, compression armed/);
});

test("dsh-acp /acp: unreachable proxy → error outcome", async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    try {
        const out = await runHandler({
            env: { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
            routes: {},
        });
        assert.equal(out.kind, "error");
        assert.match(out.text, /proxy at http:\/\/127\.0\.0\.1:8787 is not reachable/);
    } finally {
        dshAcp._resetTestHooks();
        globalThis.fetch = prevFetch;
    }
});

test("dsh-acp /acp: no env → spawns bili daemon, uses reported origin", async () => {
    const spawnArgs: string[][] = [];
    const out = await runHandler({
        env: { BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined },
        routes: {
            "http://127.0.0.1:41999/__bili/health": { status: 200, body: { ok: true } },
            "http://127.0.0.1:41999/__bili/plugin/manifest": { status: 200, body: { version: "9.9.9" } },
        },
        spawn: async (args) => {
            spawnArgs.push(args);
            return { stdout: `\nsome log noise\n${JSON.stringify({ origin: "http://127.0.0.1:41999", pid: 4242, logPath: "/tmp/x.log" })}\n`, stderr: "" };
        },
        readSettings: () => ({ text: "", exists: false }),
    });
    assert.equal(out.kind, "success");
    assert.match(out.text, /billion-context@9\.9\.9 — proxy connected, compression armed/);
    assert.equal(spawnArgs.length, 1);
    const args = spawnArgs[0]!;
    assert.deepEqual(args.slice(1), ["daemon", "--fresh", "--json", "--parent-pid", String(process.pid)]);
});

test("dsh-acp /acp: daemon spawn fails → actionable error", async () => {
    const out = await runHandler({
        env: { BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined },
        routes: {},
        spawn: async () => { throw new Error("exit 1: no profiles found"); },
        readSettings: () => ({ text: "", exists: false }),
    });
    assert.equal(out.kind, "error");
    assert.match(out.text, /could not start the bili proxy .*no profiles found/);
    assert.match(out.text, /bili plugin install dsh/);
});

test("dsh-acp race gate: first LLM fetch before daemon spawn finishes waits, then rewrites", async () => {
    const record: string[] = [];
    const prevEnv = { ...process.env } as Record<string, string | undefined>;
    const prevFetch = globalThis.fetch;
    let releaseSpawn!: () => void;
    const spawned = new Promise<void>((r) => {
        releaseSpawn = r;
    });
    dshAcp._resetTestHooks();
    dshAcp._setTestHooks({
        spawn: async () => {
            await spawned;
            return { stdout: JSON.stringify({ origin: "http://127.0.0.1:41999", pid: 4242, logPath: "/tmp/x.log" }) + "\n", stderr: "" };
        },
        readSettings: () => ({ text: SETTINGS_CUSTOM, exists: true }),
    });
    delete process.env.BILLION_CONTEXT_PROXY;
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        record.push(url);
        if (url.startsWith("http://127.0.0.1:41999/__bili/health")) {
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.startsWith("http://127.0.0.1:41999/__bili/plugin/manifest")) {
            return new Response(JSON.stringify({ version: "9.9.9" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        let handler: (() => Promise<Outcome>) | undefined;
        dshAcp.apply({
            commands: {
                register: (cmd: { name: string; description: string; handler: () => Promise<Outcome> }) => {
                    handler = cmd.handler;
                },
            },
        } as never);
        const inflight = globalThis.fetch("http://10.0.0.5:8199/v1/chat/completions");
        // Gate still closed (spawn pending): nothing may have reached the network.
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(record.length, 0, `expected no network calls while bootstrap is pending, got ${JSON.stringify(record)}`);
        releaseSpawn();
        await inflight;
        assert.ok(handler, "handler registered");
        // After bootstrap: exactly the health probe and the rewritten LLM
        // call — nothing direct. Their relative order is scheduling-dependent.
        assert.equal(record.length, 2);
        assert.deepEqual([...record].sort(), [
            "http://127.0.0.1:41999/__bili/health",
            "http://127.0.0.1:41999/bili/http://10.0.0.5:8199/v1/chat/completions",
        ].sort());
        const out = await handler();
        assert.equal(out.kind, "success");
    } finally {
        dshAcp._resetTestHooks();
        globalThis.fetch = prevFetch;
        for (const k of Object.keys(process.env)) {
            if (!(k in prevEnv)) delete process.env[k];
        }
        Object.assign(process.env, prevEnv);
    }
});
