import test from "node:test";
import assert from "node:assert/strict";
import { createOmpDirectSendGuard, stampPromptCacheKey } from "../src/agent/pi.ts";

// The omp plugin stamps the session id as a top-level prompt_cache_key while a
// proxy is claimed (BILLION_CONTEXT_PROXY). The proxy strips it before it
// forwards. When one request then degrades to a direct send (proxy not ready,
// or its respawn failed) the claim is still set, so the body was stamped, but
// no proxy strips it: a strict upstream (Anthropic Messages) answers 400
// "prompt_cache_key: Extra inputs are not permitted". The omp direct-send
// guard must drop the stamp it added — and only that.

const INTERCEPT_FLAG = Symbol.for("billion-context.native-fetch-intercept");
const PROXY_ORIGIN = "http://127.0.0.1:36011";
const URL_MESSAGES = "http://127.0.0.1:8199/v1/messages";

function withNativeClaim<T>(fn: () => T): T {
    const g = globalThis as Record<PropertyKey, unknown>;
    const prevFlag = g[INTERCEPT_FLAG];
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    g[INTERCEPT_FLAG] = true;
    process.env.BILLION_CONTEXT_PROXY = PROXY_ORIGIN;
    try {
        return fn();
    } finally {
        if (prevFlag === undefined) delete g[INTERCEPT_FLAG];
        else g[INTERCEPT_FLAG] = prevFlag;
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
}

function stampedBody(sessionId: string): Record<string, unknown> {
    const ctx = { model: { baseUrl: "http://127.0.0.1:8199/v1" }, sessionManager: { getSessionId: () => sessionId } };
    const event = { type: "before_provider_request", payload: { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] } };
    const out = withNativeClaim(() => stampPromptCacheKey(event, ctx, "omp"));
    assert.equal(out?.prompt_cache_key, sessionId, "fixture: the plugin stamps the session id");
    return out!;
}

test("direct send drops the prompt_cache_key the plugin stamped", async () => {
    const body = stampedBody("sess-direct-1");
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, { method: "POST", body: JSON.stringify(body) });
    assert.equal(prep.outcome, "restored");
    const sent = JSON.parse((prep as { body: string }).body) as Record<string, unknown>;
    assert.equal("prompt_cache_key" in sent, false);
    assert.deepEqual(sent, { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
});

test("direct send keeps a prompt_cache_key the plugin did not stamp", async () => {
    stampedBody("sess-direct-2");
    const own = { model: "m", messages: [{ role: "user", content: "hi" }], prompt_cache_key: "host-own-key" };
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, { method: "POST", body: JSON.stringify(own) });
    assert.equal(prep.outcome, "as-is");
});

test("direct send leaves a body without prompt_cache_key untouched", async () => {
    const plain = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, { method: "POST", body: plain });
    assert.equal(prep.outcome, "as-is");
});

test("a non-JSON body stays as-is", async () => {
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, { method: "POST", body: "not json" });
    assert.equal(prep.outcome, "as-is");
});
