// #5032: same failure as #5025 on the omp lane — without a live proxy the raw
// history went straight to the provider, and the shared oversize arm in
// directSendOrRefuse had no window to measure against: omp never stamps a
// context-window header (it never fires before_provider_headers, only
// before_provider_request per model request), and the lane never armed
// declaredWindowForDirect (#4894 armed dsh; PR #5027 armed pi). The window
// source is the SAME client-declared number reportOmpRuntimeInfo already ships
// server-side as "client-config" (#955/#1531): ctx.model.contextWindow on the
// per-request event. These cases pin the omp half: the window is recorded
// BEFORE any await in the handler, an unknown window clears it (fail open —
// never a guessed window), omp-native arms the reader, and the armed pair
// refuses locally instead of egressing. Hermetic like
// issue5025-pi-direct-window.test.ts: XDG_STATE_HOME redirected so no event
// reaches a real log file, proxy env cleared so no probe targets a live proxy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { createBiliPlugin, piDeclaredWindowForDirect, _resetPiDeclaredWindowForTest } from "../src/agent/pi.ts";
import { _declaredWindowHookForTest } from "../src/agent/omp-native.ts";

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5032-omp-state-"));
const PREV_ENV: Record<string, string | undefined> = {};
for (const key of ["XDG_STATE_HOME", "BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_ATTACH", "BILLION_CONTEXT_PLUGIN", "BILI_NATIVE_OMP"]) {
    PREV_ENV[key] = process.env[key];
}
// The native entry arms at import time; a dev shell's live proxy must not be
// probed from inside this suite (same guard as omp-native-identity.test.ts).
delete process.env.BILLION_CONTEXT_PROXY;
delete process.env.BILLION_CONTEXT_ATTACH;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    for (const [key, value] of Object.entries(PREV_ENV)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const UPSTREAM = "http://127.0.0.1:8203/v1/chat/completions";

type FakePi = {
    events: Map<string, (event: unknown, ctx: unknown) => unknown>;
    tools: Array<{ name: string }>;
    on: (event: string, handler: (event: never, ctx: never) => unknown) => void;
    registerTool: (tool: { name: string }) => void;
};

function makeFakePi(): FakePi {
    const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools: Array<{ name: string }> = [];
    return {
        events,
        tools,
        on: (event, handler) => {
            const h = handler as (event: unknown, ctx: unknown) => unknown;
            const prev = events.get(event);
            events.set(event, prev ? ((e, c) => { prev(e, c); return h(e, c); }) : h);
        },
        registerTool: (tool) => {
            const i = tools.findIndex((t) => t.name === tool.name);
            if (i >= 0) tools[i] = tool;
            else tools.push(tool);
        },
    };
}

/** An omp ctx with NO proxy in the model baseUrl — the reported degraded
 *  state: proxyBaseForCtx resolves undefined, every readiness await below the
 *  recording point degrades to wire mode. */
function ompCtx(contextWindow: number | undefined) {
    return {
        model: { id: "gpt-test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", ...(contextWindow !== undefined ? { contextWindow } : {}) },
        cwd: "/tmp",
    };
}

function requestHandler(): (event: unknown, ctx: unknown) => unknown {
    const pi = makeFakePi();
    createBiliPlugin("omp")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");
    return handler;
}

function chatBody(textChars: number): string {
    return JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "x".repeat(textChars) }] });
}

beforeEach(() => {
    _resetPiDeclaredWindowForTest();
    delete process.env.BILLION_CONTEXT_PROXY;
});

test("#5032 omp records the window even when no proxy base resolves (the direct-send path)", async () => {
    const handler = requestHandler();
    await handler({ payload: { messages: [{ role: "user", content: "hi" }] } }, ompCtx(500_000));
    assert.equal(piDeclaredWindowForDirect(), 500_000, "recorded before any readiness await in the handler");
});

test("#5032 unknown window clears the record — the arm fails open instead of guessing", async () => {
    const handler = requestHandler();
    await handler({ payload: {} }, ompCtx(500_000));
    assert.equal(piDeclaredWindowForDirect(), 500_000);
    await handler({ payload: {} }, ompCtx(undefined));
    assert.equal(piDeclaredWindowForDirect(), undefined, "a model with no declared window must not inherit the previous one");
});

test("#5032 omp-native arms the shared guard with the client-declared window reader", async () => {
    const hook = _declaredWindowHookForTest();
    assert.equal(typeof hook, "function", "declaredWindowForDirect armed on the omp NativeInterceptState");
    await requestHandler()({ payload: {} }, ompCtx(272_000));
    assert.equal(hook?.(), 272_000, "the armed reader answers the recorded window");
});

test("#5032 armed omp reader + not-ready intercept: oversized body refused locally, nothing egresses", async () => {
    const saved = globalThis.fetch;
    const mod = await import("../src/agent/native-intercept.ts");
    const sink: string[] = [];
    mod._resetForTest();
    globalThis.fetch = (async (input: string | URL | Request) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: import("../src/agent/native-intercept.ts").NativeInterceptState = {
            origin: undefined,
            ready: Promise.resolve(undefined),
            respawn: async () => undefined,
            declaredWindowForDirect: piDeclaredWindowForDirect,
        };
        assert.equal(mod.installNativeFetchIntercept(state), true);
        await requestHandler()({ payload: {} }, ompCtx(500_000));
        const res = await globalThis.fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(4_200_000) });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 422);
        assert.equal(res.headers.get("x-bili-gate"), "oversize-refusal-fallback");
        assert.equal((body.error as { code: string }).code, "bili_gate_oversize_refusal_fallback");
        assert.deepEqual(sink, [], "no upstream egress");
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
});

test("#5032 armed omp reader + body that fits: direct send unchanged (no false refusal)", async () => {
    const saved = globalThis.fetch;
    const mod = await import("../src/agent/native-intercept.ts");
    const sink: string[] = [];
    mod._resetForTest();
    globalThis.fetch = (async (input: string | URL | Request) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: import("../src/agent/native-intercept.ts").NativeInterceptState = {
            origin: undefined,
            ready: Promise.resolve(undefined),
            respawn: async () => undefined,
            declaredWindowForDirect: piDeclaredWindowForDirect,
        };
        assert.equal(mod.installNativeFetchIntercept(state), true);
        await requestHandler()({ payload: {} }, ompCtx(500_000));
        const res = await globalThis.fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(10_000) });
        assert.equal(res.status, 200, "direct send proceeds");
        assert.deepEqual(sink, [UPSTREAM]);
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
});
