import test from "node:test";
import assert from "node:assert/strict";
import { stampPromptCacheKey } from "../src/agent/pi.ts";

// #1579: native omp mode routes at the fetch layer — ctx.model.baseUrl keeps
// the real upstream URL, so the launcher-shaped destination checks can never
// match. The stamp gate must mirror the interceptor's routing reality:
// intercept installed AND a live proxy claimed (BILLION_CONTEXT_PROXY —
// written by bootstrap, cleared by onGiveUp; the same claim
// ownsCompaction/registerTools use) AND model-API-shaped URL (baseUrl or its
// natural chat/completions expansion — the interceptor judges the full
// request URL). Regressed on 2026-09-26 (#1403): every native omp session
// became anonymous (pfa_<hash>) at the proxy — wrong identity, panel, bills.
// Review of #1586 added the live-claim requirement: the install flag alone
// persists after the interceptor degrades to direct sends, where a stamped
// body would ride verbatim into strict upstreams (#1403's exact 400).

const INTERCEPT_FLAG = Symbol.for("billion-context.native-fetch-intercept");
const PROXY_ORIGIN = "http://127.0.0.1:36009";

function withEnv<T>(origin: string | undefined, fn: () => T): T {
    const prev = process.env.BILLION_CONTEXT_PROXY;
    if (origin === undefined) delete process.env.BILLION_CONTEXT_PROXY;
    else process.env.BILLION_CONTEXT_PROXY = origin;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
}

function withIntercept<T>(installed: boolean, fn: () => T): T {
    const g = globalThis as Record<PropertyKey, unknown>;
    const prev = g[INTERCEPT_FLAG];
    if (installed) g[INTERCEPT_FLAG] = true;
    else delete g[INTERCEPT_FLAG];
    try {
        return fn();
    } finally {
        if (prev === undefined) delete g[INTERCEPT_FLAG];
        else g[INTERCEPT_FLAG] = prev;
    }
}

function makeCtx(baseUrl: string): { model?: { baseUrl?: string }; sessionManager?: { getSessionId?: () => string } } {
    return { model: { baseUrl }, sessionManager: { getSessionId: () => "sess-1579" } };
}

function makeEvent(body: Record<string, unknown>): unknown {
    return { type: "before_provider_request", payload: { messages: [], ...body } };
}

test("#1579: native omp with bare /v1 baseUrl stamps the session identity", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("http://10.0.0.8:8199/v1"), "omp");
        assert.deepEqual(out?.prompt_cache_key, "sess-1579");
    }));
});

test("#1579: native omp with a full endpoint baseUrl stamps too", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("http://10.0.0.8:8199/v1/chat/completions"), "omp");
        assert.deepEqual(out?.prompt_cache_key, "sess-1579");
    }));
});

test("#1403 kept: no native intercept installed → never stamp (proxy cannot see it)", () => {
    withIntercept(false, () => withEnv(PROXY_ORIGIN, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("http://10.0.0.8:8199/v1"), "omp");
        assert.equal(out, undefined);
    }));
});

test("#1403 kept: intercept installed but baseUrl is not a model API target → never stamp", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("https://api.example.com/nope"), "omp");
        assert.equal(out, undefined);
    }));
});

test("#1403 kept: intercept installed but no live proxy claim (bootstrap failed / given up) → never stamp", () => {
    withIntercept(true, () => withEnv(undefined, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("http://10.0.0.8:8199/v1"), "omp");
        assert.equal(out, undefined);
    }));
});

test("launcher lane: /bili/-wrapped baseUrl stamps without any native state", () => {
    withIntercept(false, () => withEnv(undefined, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx(`${PROXY_ORIGIN}/bili/http://10.0.0.8:8199/v1/chat/completions`), "omp");
        assert.deepEqual(out?.prompt_cache_key, "sess-1579");
    }));
});

test("non-omp agents are never stamped", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("http://10.0.0.8:8199/v1"), "pi");
        assert.equal(out, undefined);
    }));
});

test("an existing prompt_cache_key is never overwritten", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => {
        const out = stampPromptCacheKey(makeEvent({ prompt_cache_key: "user-set" }), makeCtx("http://10.0.0.8:8199/v1"), "omp");
        assert.equal(out, undefined);
    }));
});

test("a body without messages array is left alone", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => {
        const out = stampPromptCacheKey({ payload: { foo: 1 } }, makeCtx("http://10.0.0.8:8199/v1"), "omp");
        assert.equal(out, undefined);
    }));
});
