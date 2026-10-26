// #958: dsh /acp command plugin — the launcher-injected lane. The handler reads
// the proxy's status endpoint and renders the panel as a success outcome; an
// armed-but-idle proxy renders the idle notice instead of a raw 404.

import test from "node:test";
import assert from "node:assert/strict";
import { apply, type CommandsService, type CommandOutcome } from "../src/agent/dsh-acp.ts";

type Route = { status: number; body: unknown };
type Call = { url: string; method?: string; body?: unknown };

async function runHandler(
    env: Record<string, string | undefined>,
    routes: Record<string, Route>,
    which: "acp" | "acp-cache" = "acp",
): Promise<{ outcome: CommandOutcome; calls: Call[] }> {
    const savedFetch = globalThis.fetch;
    const calls: Call[] = [];
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
        const url = String(input);
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
        for (const [prefix, route] of Object.entries(routes)) {
            if (url.startsWith(prefix)) {
                return new Response(JSON.stringify(route.body), {
                    status: route.status,
                    headers: { "content-type": "application/json" },
                });
            }
        }
        return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        let target: (() => Promise<CommandOutcome>) | undefined;
        let names: string[] = [];
        const commands: { register: (c: { name: string; description?: string; handler: () => Promise<CommandOutcome> }) => void } = {
            register: (c) => {
                names.push(c.name);
                if (c.name === which) target = c.handler;
            },
        };
        apply({ commands: commands as unknown as CommandsService });
        assert.ok(target, `command ${which} registered`);
        const outcome = await target!();
        return { outcome, calls };
    } finally {
        globalThis.fetch = savedFetch;
    }
}

test("registers both /acp and /acp-cache (#1146)", async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    try {
        const names: string[] = [];
        apply({
            commands: {
                register: (c: { name: string }) => names.push(c.name),
            } as unknown as CommandsService,
        });
        assert.deepEqual(names, ["acp", "acp-cache"]);
    } finally {
        globalThis.fetch = saved;
    }
});

test("/acp renders the live panel", async () => {
    const { outcome } = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {
            "http://127.0.0.1:8787/__bili/plugin/status": {
                status: 200,
                body: { ok: true, panel: "ACP Context Analysis\nbillion-context@9.9.9" },
            },
        },
    );
    assert.equal(outcome.kind, "success");
    assert.match(outcome.text, /ACP Context Analysis/);
});

test("/acp on an armed-but-idle proxy renders the idle notice", async () => {
    const { outcome } = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {
            "http://127.0.0.1:8787/__bili/plugin/manifest": { status: 200, body: { version: "9.9.9" } },
        },
    );
    assert.equal(outcome.kind, "success");
    assert.match(outcome.text, /billion-context@9\.9\.9 — proxy connected via .+, compression armed/);
});

test("/acp when the proxy is unreachable reports an error", async () => {
    const { outcome } = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {},
    );
    assert.equal(outcome.kind, "error");
    assert.match(outcome.text, /proxy not reachable at http:\/\/127\.0\.0\.1:8787/);
});

test("/acp without a proxy env gives the launch hint", async () => {
    const { outcome } = await runHandler({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, {});
    assert.equal(outcome.kind, "error");
    assert.match(outcome.text, /launch dsh through `bili dsh`/);
});

// — #1146: /acp-cache — resolves the latest conversation id via the status
// endpoint (the tool endpoint has no fallback), then forwards acp_cache.

test("/acp-cache forwards acp_cache bound to the latest conversation", async () => {
    const { outcome, calls } = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {
            "http://127.0.0.1:8787/__bili/plugin/status": {
                status: 200,
                body: { ok: true, conversationId: "conv_1", panel: "PANEL" },
            },
            "http://127.0.0.1:8787/__bili/plugin/tool": { status: 200, body: { ok: true, result: "CACHE-BODY" } },
        },
        "acp-cache",
    );
    assert.equal(outcome.kind, "success");
    assert.equal(outcome.text, "CACHE-BODY");
    const toolCall = calls.find((c) => c.url.endsWith("/__bili/plugin/tool"));
    // #2072: host-native callers stamp their machine-minted id — the wire body carries the flag.
    assert.deepEqual(toolCall?.body, { conversationId: "conv_1", tool: "acp_cache", args: {}, nativeCaller: true });
});

test("/acp-cache on an armed-but-idle proxy says to send a request first", async () => {
    const { outcome } = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {
            "http://127.0.0.1:8787/__bili/plugin/manifest": { status: 200, body: { version: "9.9.9" } },
        },
        "acp-cache",
    );
    assert.equal(outcome.kind, "success");
    assert.match(outcome.text, /No model request yet; send one, then run \/acp-cache again/);
});

test("/acp-cache when the proxy is unreachable reports an error", async () => {
    const { outcome } = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {},
        "acp-cache",
    );
    assert.equal(outcome.kind, "error");
    assert.match(outcome.text, /proxy not reachable at http:\/\/127\.0\.0\.1:8787/);
});

test("/acp-cache without a proxy env gives the launch hint", async () => {
    const { outcome } = await runHandler({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, {}, "acp-cache");
    assert.equal(outcome.kind, "error");
    assert.match(outcome.text, /launch dsh through `bili dsh`/);
});

test("/acp-cache renders proxy-side failures unwrapped", async () => {
    const { outcome } = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {
            "http://127.0.0.1:8787/__bili/plugin/status": {
                status: 200,
                body: { ok: true, conversationId: "conv_1", panel: "PANEL" },
            },
            "http://127.0.0.1:8787/__bili/plugin/tool": { status: 200, body: { ok: false, error: "boom" } },
        },
        "acp-cache",
    );
    assert.equal(outcome.kind, "error");
    assert.match(outcome.text, /cache report failed/);
    assert.match(outcome.text, /boom/);
});

test("/acp-cache on an unknown conversation renders the friendly no-session notice", async () => {
    const { outcome } = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {
            "http://127.0.0.1:8787/__bili/plugin/status": {
                status: 200,
                body: { ok: true, conversationId: "conv_1", panel: "PANEL" },
            },
            "http://127.0.0.1:8787/__bili/plugin/tool": {
                status: 200,
                body: { ok: false, error: 'unknown plugin conversation id "conv_1" (no model request has arrived with this conversation id yet)' },
            },
        },
        "acp-cache",
    );
    assert.equal(outcome.kind, "success");
    assert.match(outcome.text, /no ACP session yet/);
});
