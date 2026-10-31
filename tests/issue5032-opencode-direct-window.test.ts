// #5032 (the #5025 family): the opencode V1 lane stamped
// x-bili-plugin-context-window only after an origin was known, and never armed
// declaredWindowForDirect — so when the proxy was down the shared guard in
// directSendOrRefuse had neither source, skipped the measurement, and let a
// history that had outgrown the window egress uncompressed into a guaranteed
// upstream 400 (repeated on every retry until restart). These cases pin the
// opencode half: the client-declared window from the V1 config is recorded
// BEFORE the no-origin return, an unknown model clears it (fail open — never a
// guessed window), the module arms the reader, and the armed pair refuses
// locally instead of egressing while a fitting body still goes direct.
// Hermetic like issue5025-pi-direct-window.test.ts: XDG_STATE_HOME redirected so
// no event reaches a real log file, proxy env cleared so no probe targets a
// live proxy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { createV1ServerHooks, opencodeDeclaredWindowForDirect, _declaredWindowHookForTest, _resetOpencodeDeclaredWindowForTest, type V1Config } from "../src/agent/opencode-native.ts";

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5032-state-"));
const PREV_ENV: Record<string, string | undefined> = {};
for (const key of ["XDG_STATE_HOME", "BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_ATTACH", "BILLION_CONTEXT_PLUGIN", "BILI_NATIVE_OPENCODE"]) {
    PREV_ENV[key] = process.env[key];
}
delete process.env.BILLION_CONTEXT_PROXY;
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PLUGIN;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    for (const [key, value] of Object.entries(PREV_ENV)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const UPSTREAM = "http://127.0.0.1:8199/v1/chat/completions";

// Minimal structural stand-in for the host zod module: the V1 hooks build the
// ACP tool schemas through it, so the header/tool branch only registers when the
// builders it touches exist (same fake as opencode-native-v1.test.ts).
const fakeZ = {
    any: () => ({ __fake: "any" }),
    string: () => ({ __fake: "string", describe: (_d: string) => ({ __fake: "string" }) }),
    number: () => ({ __fake: "number" }),
    boolean: () => ({ __fake: "boolean" }),
    array: (item: unknown) => ({ __fake: "array", item }),
    enum: (values: [string, ...string[]]) => ({ __fake: "enum", values }),
    object: (shape: unknown) => ({ __fake: "object", shape }),
    optional: () => ({ __fake: "optional" }),
} as unknown as typeof import("zod");

const CONFIG: V1Config = {
    provider: {
        openai: { options: { baseURL: "https://api.openai.com/v1" }, models: { gpt: { limit: { context: 128_000.9 } } } },
    },
};

/** Hooks wired the way the reported degradation looks: no live origin, so the
 *  header stamp returns early and only the recorded window survives. */
async function hooksWithoutProxy() {
    const hooks = createV1ServerHooks(() => undefined, {}, { z: fakeZ });
    await hooks.config?.(JSON.parse(JSON.stringify(CONFIG)) as V1Config);
    return hooks;
}

function chatBody(textChars: number): string {
    return JSON.stringify({ model: "gpt", messages: [{ role: "user", content: "x".repeat(textChars) }] });
}

beforeEach(() => {
    _resetOpencodeDeclaredWindowForTest();
    delete process.env.BILLION_CONTEXT_PROXY;
});

test("#5032 opencode records the window even when no origin resolves (the direct-send path)", async () => {
    const hooks = await hooksWithoutProxy();
    const headers: Record<string, string> = {};
    await hooks["chat.headers"]?.({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt" } }, { headers });
    assert.equal(opencodeDeclaredWindowForDirect(), 128_000, "recorded before the no-origin return, floored like the stamp");
    // The premise of the bug: in this state the header is never stamped, which is
    // why the shared guard had nothing to measure against.
    assert.equal(headers["x-bili-plugin-context-window"], undefined, "no origin → no stamped window");
    assert.equal(headers["x-bili-plugin"], undefined, "no origin → no ownership marker either");
});

test("#5032 unknown model or unknown window clears the record — the arm fails open instead of guessing", async () => {
    const hooks = await hooksWithoutProxy();
    await hooks["chat.headers"]?.({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt" } }, { headers: {} });
    assert.equal(opencodeDeclaredWindowForDirect(), 128_000);
    await hooks["chat.headers"]?.({ sessionID: "ses_5032", model: { providerID: "openai", id: "undeclared" } }, { headers: {} });
    assert.equal(opencodeDeclaredWindowForDirect(), undefined, "a model missing from the config must not inherit the previous window");
    await hooks["chat.headers"]?.({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt" } }, { headers: {} });
    assert.equal(opencodeDeclaredWindowForDirect(), 128_000);
    await hooks["chat.headers"]?.({ sessionID: "ses_5032" }, { headers: {} });
    assert.equal(opencodeDeclaredWindowForDirect(), undefined, "a request with no model must not inherit the previous window");
});

test("#5032 the module arms the shared guard with the opencode window reader", async () => {
    const hook = _declaredWindowHookForTest();
    assert.equal(typeof hook, "function", "declaredWindowForDirect armed on the opencode NativeInterceptState");
    const hooks = await hooksWithoutProxy();
    await hooks["chat.headers"]?.({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt" } }, { headers: {} });
    assert.equal(hook?.(), 128_000, "the armed reader answers the recorded window");
});

test("#5032 armed opencode reader + not-ready intercept: oversized body refused locally, nothing egresses", async () => {
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
            declaredWindowForDirect: opencodeDeclaredWindowForDirect,
        };
        assert.equal(mod.installNativeFetchIntercept(state), true);
        const hooks = await hooksWithoutProxy();
        await hooks["chat.headers"]?.({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt" } }, { headers: {} });
        // The shared arm never assumes a window below MIN_ASSUMED_WINDOW_TOKENS
        // (1M, #4079), so the body has to exceed 4MB of core text to be provably
        // over ANY window — same shape as issue5025-pi-direct-window.test.ts.
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

test("#5032 armed opencode reader + body that fits: direct send unchanged (no false refusal)", async () => {
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
            declaredWindowForDirect: opencodeDeclaredWindowForDirect,
        };
        assert.equal(mod.installNativeFetchIntercept(state), true);
        const hooks = await hooksWithoutProxy();
        await hooks["chat.headers"]?.({ sessionID: "ses_5032", model: { providerID: "openai", id: "gpt" } }, { headers: {} });
        const res = await globalThis.fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(10_000) });
        assert.equal(res.status, 200, "direct send proceeds");
        assert.deepEqual(sink, [UPSTREAM]);
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
});
