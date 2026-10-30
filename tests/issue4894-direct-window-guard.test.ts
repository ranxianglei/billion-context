import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// #4894: the shared oversize arm in directSendOrRefuse measured against the
// stamped x-bili-plugin-context-window header — but the header is stamped only
// by the proxy branch, so a request that finds NO live proxy (slow boot past
// the spawn budget, #4609) carried none and the arm stayed disarmed in
// exactly the state where an uncompressed egress most likely blows the window
// (prompt_too_long storm on long sessions). These cases pin the fix in the
// SHARED intercept: the lane-supplied declaredWindowForDirect arms the same
// arm when the header is absent, fails open byte-identically when the lane
// has no window, and never outranks a stamped header. Hermetic like
// issue4516-pi-direct-fallback.test.ts: XDG_STATE_HOME redirected so no event
// reaches a real log file.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4894-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
const CHAIN_LOG_FILE = path.join(STATE_ROOT, "billion-context", "bili.log");
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const UPSTREAM = "http://127.0.0.1:8199/v1/chat/completions";

function fakeFetch(sink: string[]) {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

function chatBody(textChars: number): string {
    return JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "x".repeat(textChars) }] });
}

function mediaBody(textChars: number, b64Chars: number): string {
    return JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: [
            { type: "text", text: "x".repeat(textChars) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(b64Chars)}` } },
        ] }],
    });
}

interface Ctx {
    sink: string[];
    fetch: () => typeof fetch;
    state: import("../src/agent/native-intercept.js").NativeInterceptState;
}

/** Drive requests through a freshly installed intercept with NO origin
 *  (bootstrap failed — the reported state): every model request lands in
 *  directSendOrRefuse. */
async function withNotReady<T>(fn: (ctx: Ctx) => Promise<T>): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    const state: import("../src/agent/native-intercept.js").NativeInterceptState = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        respawn: async () => undefined,
    };
    const mod = await import("../src/agent/native-intercept.js");
    mod._resetForTest();
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(mod.installNativeFetchIntercept(state), true);
        const result = await fn({ sink, fetch: () => globalThis.fetch, state });
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
}

test("#4894 not-ready + lane window + NO header → local 422, upstream never hit", async () => {
    const { sink, result } = await withNotReady(async ({ fetch, state }) => {
        state.declaredWindowForDirect = () => 1_000_000;
        const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(4_200_000) });
        const body = await res.json() as Record<string, unknown>;
        return { status: res.status, gate: res.headers.get("x-bili-gate"), body };
    });
    assert.equal(result.status, 422);
    assert.equal(result.gate, "oversize-refusal-fallback");
    assert.equal((result.body.error as { type: string }).type, "server_error");
    assert.equal((result.body.error as { code: string }).code, "bili_gate_oversize_refusal_fallback");
    assert.equal((result.body.error as { retryable: boolean }).retryable, true);
    // bootstrap-failed wording (no origin ever held) — distinguishes "proxy
    // not up yet" from "proxy died" for operators reading the message.
    assert.match(String((result.body.error as { message: string }).message), /did not come up/);
    assert.equal(sink.length, 0, "no upstream egress");
});

test("#4894 hook answers undefined → arm stays disarmed (fail-open, pre-fix behavior)", async () => {
    const { sink, result } = await withNotReady(async ({ fetch, state }) => {
        state.declaredWindowForDirect = () => undefined;
        const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(4_200_000) });
        return { status: res.status };
    });
    assert.equal(result.status, 200, "direct send proceeds");
    assert.deepEqual(sink, [UPSTREAM]);
});

test("#4894 hook window + body that fits → direct send (no false refusal)", async () => {
    const { sink, result } = await withNotReady(async ({ fetch, state }) => {
        state.declaredWindowForDirect = () => 1_000_000;
        const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(10_000) });
        return { status: res.status };
    });
    assert.equal(result.status, 200, "direct send proceeds");
    assert.deepEqual(sink, [UPSTREAM]);
});

test("#4894 media-heavy body: core text fits the hook window → direct send (#4111 two-stage math)", async () => {
    const { sink, result } = await withNotReady(async ({ fetch, state }) => {
        state.declaredWindowForDirect = () => 1_000_000;
        // raw ≈ 4.01 MB → ceil(/4) ≈ 1.0025M > 1M bar (stage 1 flags), but
        // the media-excluded core is ~2.75K tok (stage 2 clears) → fits.
        const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: mediaBody(10_000, 4_000_000) });
        return { status: res.status };
    });
    assert.equal(result.status, 200, "media must not false-refuse a small-text session");
    assert.deepEqual(sink, [UPSTREAM]);
});

test("#4894 stamped header outranks the hook (request-specific declaration wins)", async () => {
    const { sink, result } = await withNotReady(async ({ fetch, state }) => {
        // Hook says 5M (would fit); the header says 1000 (floored to the 1M
        // bar). Refusal proves the header won the precedence.
        state.declaredWindowForDirect = () => 5_000_000;
        const res = await fetch()(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "1000" },
            body: chatBody(4_200_000),
        });
        const body = await res.json() as Record<string, unknown>;
        return { status: res.status, gate: res.headers.get("x-bili-gate"), body };
    });
    assert.equal(result.status, 422);
    assert.equal(result.gate, "oversize-refusal-fallback");
    assert.match(String((result.body.error as { message: string }).message), /did not come up/);
    assert.equal(sink.length, 0, "no upstream egress");
});
