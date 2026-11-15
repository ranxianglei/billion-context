// #5686: the last leak window of the #1729 doctrine — every DEGRADED direct
// send (no usable bili proxy at that moment) used to carry a dsh
// native-compaction summarize call STRAIGHT to the provider; dsh then frames
// the normal reply into a checkpoint that DURABLY SHADOWS the session's raw
// history (compression substrate destroyed → identity fork follows: the
// #5517/#5656 report cluster). "Either compress, or refuse" (#3651): on a
// no-proxy path the refusal is the only legal outcome for THIS call class.
//
// Change under test (src/agent/native-intercept.ts): inside directSendOrRefuse
// (the single choke point of all six degraded dispatches), a MARKER-DECISIVE
// compaction call (final user message starts with COMPACTION_INSTRUCTION per
// isDshCompactionCall) is refused LOCALLY with a protocol-shaped 422 instead
// of being sent direct. Everything non-decisive keeps today's semantics
// exactly (mid-body mention, unreadable/stream bodies, unknown wires), and a
// LIVE origin never enters this branch (routed /bili/ traffic stays with the
// bili instance's own #2043-lane guard).

import test from "node:test";
import assert from "node:assert/strict";
import { installNativeFetchIntercept, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";

const DSH_COMPACT_DIRECTIVE = "You are now acting as a compaction engine for this AI coding assistant. Summarize the conversation.";

/** rc.2-shaped shadowed-region replay: many messages, directive LAST user. */
function dshCompactionEnvelope(): string {
    const region = [];
    for (let i = 0; i < 12; i++) {
        region.push({ role: i % 2 === 0 ? "user" : "assistant", content: `region turn ${i} ` + "x".repeat(40) });
    }
    region.push({ role: "user", content: DSH_COMPACT_DIRECTIVE });
    return JSON.stringify({ model: "deepseek-chat", messages: region });
}

/** The directive QUOTED mid-body but NOT as the final user message: a plain
 *  coding conversation about the directive must keep direct semantics. */
function mentionOnlyBody(): string {
    return JSON.stringify({
        model: "deepseek-chat",
        messages: [
            { role: "system", content: DSH_COMPACT_DIRECTIVE }, // quoted in system context — not decisive either
            { role: "user", content: "Please review my notes about: You are now acting as a compaction engine for this AI coding assistant…" },
            { role: "assistant", content: "Noted." },
            { role: "user", content: "Now continue editing index.ts" },
        ],
    });
}

type Recorded = { url: string; init?: RequestInit };
async function withPatch<T>(state: NativeInterceptState, fn: (fetch: typeof globalThis.fetch) => Promise<T>): Promise<{ calls: Recorded[]; result: T }> {
    const saved = globalThis.fetch;
    _resetForTest();
    const calls: Recorded[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url, init });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    globalThis.fetch = fake;
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn(globalThis.fetch);
        return { calls, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

/** No usable proxy right now (origin never resolved) + marker-decisive body. */
const DEAD_PROXY: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), takeoverGate: () => false };

test("#5686: decisive dsh compaction POST with dead proxy refuses LOCALLY (no upstream fetch)", async () => {
    const state: NativeInterceptState = { ...DEAD_PROXY, onDispatch: () => {} };
    const { calls, result } = await withPatch(state, async (fetch) => {
        const res = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: dshCompactionEnvelope() });
        assert.equal(res.status, 422);
        assert.equal(res.headers.get("x-bili-gate"), "dsh-compaction-refused");
        const j = (await res.json()) as Record<string, unknown>;
        assert.equal((j.error as Record<string, unknown>).code, "bili_gate_dsh_compaction_refused");
        assert.match(String((j.error as Record<string, unknown>).message), /dsh native-compaction summarize call/);
        return res;
    });
    void result;
    assert.equal(calls.length, 0, "the upstream provider must never see this request");
});

test("#5686: anthropic /messages shape gets the /messages protocol envelope", async () => {
    const state: NativeInterceptState = { ...DEAD_PROXY };
    await withPatch(state, async (fetch) => {
        const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ max_tokens: 4096, messages: [{ role: "user", content: DSH_COMPACT_DIRECTIVE }] }) });
        assert.equal(res.status, 422);
        const j = (await res.json()) as Record<string, unknown>;
        assert.equal(j.type, "error");
        assert.equal((j.error as Record<string, unknown>).type, "invalid_request_error");
    });
});

test("#5686: directive MENTIONED mid-body is not decisive — direct send preserved", async () => {
    const state: NativeInterceptState = { ...DEAD_PROXY };
    const { calls } = await withPatch(state, async (fetch) => {
        const res = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: mentionOnlyBody() });
        assert.equal(res.status, 200); // straight through to (fake) upstream
    });
    assert.deepEqual(calls.map((c) => c.url), ["https://api.deepseek.com/chat/completions"]);
});

test("#5686: live origin never touches the choke — routed traffic unchanged (#2592 regression)", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40101", ready: Promise.resolve("http://127.0.0.1:40101"), takeoverGate: () => false };
    const { calls } = await withPatch(state, async (fetch) => {
        const res = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: dshCompactionEnvelope() });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(calls.map((c) => c.url), ["http://127.0.0.1:40101/bili/https://api.deepseek.com/chat/completions"]);
});
