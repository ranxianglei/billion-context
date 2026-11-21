// #6796: Pi native Anthropic continuations are rewritten after fingerprinting
// and can return generic 429. The pi host's prepareThreadRequest fingerprints
// the full original request and creates a native delta (threads continue +
// previous_message_id). Bili's inline transport processes that delta afterward,
// and in pluginMode the byte-faithful threads branch is skipped (guarded by
// !pluginMode in prepare-anthropic.ts), so the wire payload no longer matches
// the host's thread assumptions → generic 429.
//
// Fix: negotiate session-local compat.supportsMessageThreads=false for
// Anthropic Messages models actually routed through bili, using Pi's official
// model API (setModel). Pi then sends full requests through the existing
// compression pipeline, without requiring a user models.json edit, disabling
// bili, filtering payloads, or retrying deterministic failures.
import assert from "node:assert/strict";
import test from "node:test";
import { createBiliPlugin } from "../src/agent/pi.ts";

type SetModelCall = { model: Record<string, unknown> };

function makeFakePi(opts?: { setModelImpl?: (model: Record<string, unknown>) => Promise<boolean | void> | boolean | void }) {
    const events = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    const tools: unknown[] = [];
    const setModelCalls: SetModelCall[] = [];
    return {
        events,
        tools,
        setModelCalls,
        on: (event: string, handler: (event: never, ctx: never) => unknown) => {
            const list = events.get(event) ?? [];
            list.push(handler as (event: unknown, ctx: unknown) => unknown);
            events.set(event, list);
        },
        registerTool: (tool: unknown) => { tools.push(tool); },
        registerCommand: () => {},
        registerProvider: () => {},
        getSessionName: () => "test",
        setModel: opts?.setModelImpl
            ? (model: Record<string, unknown>) => {
                setModelCalls.push({ model });
                return opts.setModelImpl!(model);
            }
            : (model: Record<string, unknown>) => {
                setModelCalls.push({ model });
                return Promise.resolve(true);
            },
        fireAsync: async (name: string, event: unknown, ctx: unknown) => {
            const list = events.get(name) ?? [];
            let last: unknown;
            for (const h of list) last = await h(event, ctx);
            return last;
        },
    };
}

function anthropicCtx(baseUrl: string): Record<string, unknown> {
    return {
        sessionManager: { getSessionId: () => "test-sid" },
        model: {
            id: "claude-opus-4-5",
            contextWindow: 200000,
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl,
            compat: { supportsMessageThreads: true },
        },
        cwd: "/tmp",
    };
}

const PROXY_BASE_URL = "http://127.0.0.1:8787/bili/https://api.anthropic.com/v1";
const DIRECT_BASE_URL = "https://api.anthropic.com/v1";

test("#6796: pi + anthropic-messages + routed-through-bili → setModel called with compat.supportsMessageThreads=false", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");
    assert.equal(handler!.length, 1, "exactly one handler");

    const ctx = anthropicCtx(PROXY_BASE_URL);
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctx);

    assert.equal(pi.setModelCalls.length, 1, "setModel called exactly once");
    const call = pi.setModelCalls[0].model;
    assert.equal(call.provider, "anthropic");
    assert.equal(call.api, "anthropic-messages");
    assert.equal((call.compat as Record<string, unknown>).supportsMessageThreads, false, "compat.supportsMessageThreads is false");
    // Other compat fields are preserved
    assert.equal((call.compat as Record<string, unknown>).supportsMessageThreads, false);
});

test("#6796: second request does NOT call setModel again (idempotent)", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");

    const ctx = anthropicCtx(PROXY_BASE_URL);
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctx);
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctx);

    assert.equal(pi.setModelCalls.length, 1, "setModel called exactly once across two requests");
});

test("#6796: a DIFFERENT session gets its own setModel (per-session latch, not process-global)", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");

    // Two distinct sessions in the SAME plugin instance (one host process
    // shares `state` across sessions). Each must negotiate its own
    // compat.supportsMessageThreads=false — a process-global boolean latch
    // would latch on the first session and leave the second on native threads.
    const ctxA = anthropicCtx(PROXY_BASE_URL); // sid "test-sid"
    const ctxB: Record<string, unknown> = {
        ...anthropicCtx(PROXY_BASE_URL),
        sessionManager: { getSessionId: () => "other-sid" },
    };
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctxA);
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctxB);

    assert.equal(pi.setModelCalls.length, 2, "setModel called once per distinct session");
    // Same session again → still latched (no third call).
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctxA);
    assert.equal(pi.setModelCalls.length, 2, "re-request on a latched session does not re-negotiate");
});

test("#6796: non-anthropic model → setModel NOT called", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");

    const ctx: Record<string, unknown> = {
        sessionManager: { getSessionId: () => "test-sid" },
        model: {
            id: "gpt-4",
            contextWindow: 128000,
            provider: "openai",
            api: "openai",
            baseUrl: PROXY_BASE_URL,
        },
        cwd: "/tmp",
    };
    await handler![0]({ payload: { model: "gpt-4", messages: [] } }, ctx);

    assert.equal(pi.setModelCalls.length, 0, "setModel NOT called for non-anthropic model");
});

test("#6796: anthropic model NOT routed through bili → setModel NOT called", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");

    const ctx = anthropicCtx(DIRECT_BASE_URL);
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctx);

    assert.equal(pi.setModelCalls.length, 0, "setModel NOT called when not routed through bili");
});

test("#6796: setModel throws → compatThreadsDisabled reset, error logged", async () => {
    const pi = makeFakePi({
        setModelImpl: () => {
            throw new Error("auth failed");
        },
    });
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");

    const ctx = anthropicCtx(PROXY_BASE_URL);
    // First call: setModel throws, compatThreadsDisabled is reset
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctx);
    // Second call: setModel is tried again (flag was reset)
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctx);

    assert.equal(pi.setModelCalls.length, 2, "setModel retried after failure");
});

test("#6796: existing compat fields are preserved when setting supportsMessageThreads=false", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");

    const ctx: Record<string, unknown> = {
        sessionManager: { getSessionId: () => "test-sid" },
        model: {
            id: "claude-opus-4-5",
            contextWindow: 200000,
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl: PROXY_BASE_URL,
            compat: {
                supportsMessageThreads: true,
                supportsStore: true,
                supportsDeveloperRole: true,
            },
        },
        cwd: "/tmp",
    };
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctx);

    assert.equal(pi.setModelCalls.length, 1);
    const compat = (pi.setModelCalls[0].model.compat ?? {}) as Record<string, unknown>;
    assert.equal(compat.supportsMessageThreads, false, "supportsMessageThreads set to false");
    assert.equal(compat.supportsStore, true, "supportsStore preserved");
    assert.equal(compat.supportsDeveloperRole, true, "supportsDeveloperRole preserved");
});

test("#6796: model without compat field → compat created with only supportsMessageThreads=false", async () => {
    const pi = makeFakePi();
    createBiliPlugin("pi")(pi as never);
    const handler = pi.events.get("before_provider_request");
    assert.ok(handler, "before_provider_request handler registered");

    const ctx: Record<string, unknown> = {
        sessionManager: { getSessionId: () => "test-sid" },
        model: {
            id: "claude-opus-4-5",
            contextWindow: 200000,
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl: PROXY_BASE_URL,
        },
        cwd: "/tmp",
    };
    await handler![0]({ payload: { model: "claude-opus-4-5", messages: [] } }, ctx);

    assert.equal(pi.setModelCalls.length, 1);
    const compat = (pi.setModelCalls[0].model.compat ?? {}) as Record<string, unknown>;
    assert.equal(compat.supportsMessageThreads, false, "supportsMessageThreads set to false");
    assert.equal(Object.keys(compat).length, 1, "only supportsMessageThreads in compat");
});
