// /acp cordis plugin for dsh (deepseek-harness): the handler's three
// outcomes — live panel from the latest session, armed-but-idle info, and
// unreachable proxy — mirror the pi/opencode plugins (PR#235 semantics).

import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/agent/dsh-acp.ts";

type Outcome = { kind: "success" | "error"; text: string };

async function runHandler(env: Record<string, string | undefined>, routes: Record<string, { status: number; body: unknown }>): Promise<Outcome> {
    const prev = { ...process.env } as Record<string, string | undefined>;
    const prevFetch = globalThis.fetch;
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    let handler: (() => Promise<Outcome>) | undefined;
    const ctx = {
        commands: {
            register: (cmd: { name: string; description: string; handler: () => Promise<Outcome> }) => {
                assert.equal(cmd.name, "acp");
                handler = cmd.handler;
            },
        },
    };
    apply(ctx as never);
    assert.ok(handler, "handler registered");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        for (const [prefix, route] of Object.entries(routes)) {
            if (url.startsWith(prefix)) {
                return new Response(JSON.stringify(route.body), { status: route.status, headers: { "content-type": "application/json" } });
            }
        }
        return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const outcome = await handler();
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(env)) {
        const v = prev[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return outcome;
}

test("dsh-acp /acp: live proxy with a session returns the rendered panel", async () => {
    const out = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {
            "http://127.0.0.1:8787/__bili/plugin/status": {
                status: 200,
                body: { ok: true, panel: "ACP Context Analysis\nbillion-context@9.9.9" },
            },
        },
    );
    assert.equal(out.kind, "success");
    assert.ok(out.text.includes("ACP Context Analysis"));
});

test("dsh-acp /acp: 404 status + live manifest → armed-but-idle info", async () => {
    const out = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {
            "http://127.0.0.1:8787/__bili/plugin/status": { status: 404, body: { ok: false } },
            "http://127.0.0.1:8787/__bili/plugin/manifest": { status: 200, body: { version: "9.9.9" } },
        },
    );
    assert.equal(out.kind, "success");
    assert.match(out.text, /billion-context@9\.9\.9 — proxy connected, compression armed/);
});

test("dsh-acp /acp: unreachable proxy (HTTP-level) → error outcome", async () => {
    const out = await runHandler(
        { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787", BILLION_CONTEXT_PLUGIN: undefined },
        {},
    );
    assert.equal(out.kind, "error");
    assert.match(out.text, /proxy not reachable at http:\/\/127\.0\.0\.1:8787/);
});

test("dsh-acp /acp: network-level fetch failure (ECONNREFUSED) → error outcome, no unhandled rejection", async () => {
    const prev = { ...process.env } as Record<string, string | undefined>;
    const prevFetch = globalThis.fetch;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
    delete process.env.BILLION_CONTEXT_PLUGIN;
    let handler: (() => Promise<Outcome>) | undefined;
    const ctx = {
        commands: {
            register: (cmd: { name: string; handler: () => Promise<Outcome> }) => {
                handler = cmd.handler;
            },
        },
    };
    apply(ctx as never);
    assert.ok(handler, "handler registered");
    // fetchJson RETHROWS network errors (only HTTP-level failures soft-fail
    // to undefined) — the handler must absorb them (review M2).
    globalThis.fetch = (async () => {
        throw new TypeError("fetch failed");
    }) as typeof fetch;
    try {
        const out = await handler();
        assert.equal(out.kind, "error");
        assert.match(out.text, /proxy not reachable/);
    } finally {
        globalThis.fetch = prevFetch;
        for (const k of Object.keys(prev)) {
            const v = prev[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

test("dsh-acp /acp: no BILLION_CONTEXT_PROXY env → launch hint", async () => {
    const out = await runHandler(
        { BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined },
        {},
    );
    assert.equal(out.kind, "error");
    assert.match(out.text, /launch dsh through `bili dsh`/);
});
