// #5025: without a live proxy the pi lane sent the raw history straight to the
// provider — a multi-million-token body came back as "input exceeds the context
// window" on every retry, unrecoverable while the proxy stayed down. The shared
// oversize arm in directSendOrRefuse needed a window to measure against, and
// both its sources were empty on exactly that path: the
// x-bili-plugin-context-window header is stamped only on the proxy branch (the
// handler returns at `proxyBase === undefined` before stamping), and the pi lane
// never armed declaredWindowForDirect (#4894 armed dsh only). These cases pin
// the pi half: the window is recorded BEFORE the readiness return, an unknown
// window clears it (fail open — never a guessed window), pi-native arms the
// reader, and the armed pair refuses locally instead of egressing. Hermetic like
// issue4894-direct-window-guard.test.ts: XDG_STATE_HOME redirected so no event
// reaches a real log file, proxy env cleared so no probe targets a live proxy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { createBiliPlugin, piDeclaredWindowForDirect, _resetPiDeclaredWindowForTest } from "../src/agent/pi.ts";
import { _declaredWindowHookForTest } from "../src/agent/pi-native.ts";

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5025-state-"));
const PREV_ENV: Record<string, string | undefined> = {};
for (const key of ["XDG_STATE_HOME", "BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_ATTACH", "BILLION_CONTEXT_PLUGIN", "BILI_NATIVE_PI"]) {
    PREV_ENV[key] = process.env[key];
}
// The native entry arms at import time; a dev shell's live proxy must not be
// probed from inside this suite (same guard as pi-native.test.ts).
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

const UPSTREAM = "http://127.0.0.1:8199/v1/chat/completions";

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

/** A pi ctx with NO proxy in the model baseUrl — the reported degraded state:
 *  proxyBaseForCtx resolves undefined, so the header branch returns early. */
function piCtx(contextWindow: number | undefined, sid = "pi-5025") {
    return {
        sessionManager: { getSessionId: () => sid },
        model: { id: "gpt-test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", ...(contextWindow !== undefined ? { contextWindow } : {}) },
        cwd: "/tmp",
    };
}

function headersHandler(): (event: unknown, ctx: unknown) => unknown {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_headers");
    assert.ok(handler, "before_provider_headers handler registered");
    return handler;
}

function chatBody(textChars: number): string {
    return JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "x".repeat(textChars) }] });
}

beforeEach(() => {
    _resetPiDeclaredWindowForTest();
    delete process.env.BILLION_CONTEXT_PROXY;
});

test("#5025 pi records the window even when no proxy base resolves (the direct-send path)", async () => {
    const handler = headersHandler();
    const headers: Record<string, string> = {};
    await handler({ headers }, piCtx(500_000));
    assert.equal(piDeclaredWindowForDirect(), 500_000, "recorded before the proxy-readiness return");
    // The premise of the bug: in this state the header is never stamped, which
    // is why the shared guard had nothing to measure against.
    assert.equal(headers["x-bili-plugin-context-window"], undefined, "no proxy base → no stamped window");
    assert.equal(headers["x-bili-plugin"], undefined, "no proxy base → no ownership marker either");
});

test("#5025 unknown window clears the record — the arm fails open instead of guessing", async () => {
    const handler = headersHandler();
    await handler({ headers: {} }, piCtx(500_000));
    assert.equal(piDeclaredWindowForDirect(), 500_000);
    await handler({ headers: {} }, piCtx(undefined));
    assert.equal(piDeclaredWindowForDirect(), undefined, "a model with no declared window must not inherit the previous one");
});

test("#5025 pi-native arms the shared guard with the pi window reader", async () => {
    const hook = _declaredWindowHookForTest();
    assert.equal(typeof hook, "function", "declaredWindowForDirect armed on the pi NativeInterceptState");
    await headersHandler()({ headers: {} }, piCtx(272_000));
    assert.equal(hook?.(), 272_000, "the armed reader answers the recorded window");
});

test("#5025 armed pi reader + not-ready intercept: oversized body refused locally, nothing egresses", async () => {
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
        await headersHandler()({ headers: {} }, piCtx(500_000));
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

test("#5025 armed pi reader + body that fits: direct send unchanged (no false refusal)", async () => {
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
        await headersHandler()({ headers: {} }, piCtx(500_000));
        const res = await globalThis.fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(10_000) });
        assert.equal(res.status, 200, "direct send proceeds");
        assert.deepEqual(sink, [UPSTREAM]);
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
});
