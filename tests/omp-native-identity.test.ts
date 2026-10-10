import test from "node:test";
import assert from "node:assert/strict";
import { ompCoworkTransportBypassesFetch, stampPromptCacheKey } from "../src/agent/pi.ts";

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
// #2583 adds the transport carve-out: OMP's Cowork transport sends default
// anthropic/anthropic-messages traffic over node:https DIRECTLY (no proxy
// env) — the fetch-layer rewrite can never fire for those bytes, so the gate
// must mirror OMP's own per-model egress selection exactly.

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

function withProxyEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const keys = Object.keys(vars);
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) {
        prev[k] = process.env[k];
        const v = vars[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return fn();
    } finally {
        for (const k of keys) {
            const v = prev[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function makeCtx(baseUrl: string, extra?: Record<string, unknown>): { model?: { baseUrl?: string } & Record<string, unknown>; sessionManager?: { getSessionId?: () => string } } {
    return { model: { baseUrl, ...extra }, sessionManager: { getSessionId: () => "sess-1579" } };
}

const COWORK_MODEL = { provider: "anthropic", api: "anthropic-messages" };
const NO_PROXY_ENV = { PI_PROXY: undefined, PI_PROXY_ANTHROPIC: undefined };

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

test("#2583: native omp anthropic-messages with no proxy env → NOT stamped (Cowork node:https path bypasses the fetch patch)", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => withProxyEnv(NO_PROXY_ENV, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("https://api.anthropic.com/v1", { ...COWORK_MODEL, id: "claude-haiku-5-5" }), "omp");
        assert.equal(out, undefined);
    })));
});

test("#2583: same model with PI_PROXY set → stamped (the proxied push-off lands on globalThis.fetch)", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => withProxyEnv({ ...NO_PROXY_ENV, PI_PROXY: "http://127.0.0.1:9999" }, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("https://api.anthropic.com/v1", COWORK_MODEL), "omp");
        assert.deepEqual(out?.prompt_cache_key, "sess-1579");
    })));
});

test("#2583: same model with PI_PROXY_ANTHROPIC set → stamped (per-provider proxy wins)", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => withProxyEnv({ ...NO_PROXY_ENV, PI_PROXY_ANTHROPIC: "http://127.0.0.1:9999" }, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("https://api.anthropic.com/v1", COWORK_MODEL), "omp");
        assert.deepEqual(out?.prompt_cache_key, "sess-1579");
    })));
});

test("#2583: third-party relay speaking anthropic-messages → stamped (Cowork selection is provider-scoped)", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => withProxyEnv(NO_PROXY_ENV, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("https://openrouter.ai/api/v1", { provider: "openrouter", api: "anthropic-messages" }), "omp");
        assert.deepEqual(out?.prompt_cache_key, "sess-1579");
    })));
});

test("#2583: provider anthropic on a non-anthropic-messages api → stamped", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => withProxyEnv(NO_PROXY_ENV, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("http://10.0.0.8:8199/v1", { provider: "anthropic", api: "responses" }), "omp");
        assert.deepEqual(out?.prompt_cache_key, "sess-1579");
    })));
});

test("#2583: missing provider/api fields keep the optimistic stamp (fail-safe toward #1579 for older hosts)", () => {
    withIntercept(true, () => withEnv(PROXY_ORIGIN, () => withProxyEnv(NO_PROXY_ENV, () => {
        const out = stampPromptCacheKey(makeEvent({}), makeCtx("https://api.anthropic.com/v1"), "omp");
        assert.deepEqual(out?.prompt_cache_key, "sess-1579");
    })));
});

test("#2583: ompCoworkTransportBypassesFetch mirrors OMP's own egress selection predicate", () => {
    assert.equal(ompCoworkTransportBypassesFetch(undefined), false);
    assert.equal(ompCoworkTransportBypassesFetch({ provider: "anthropic" }), false);
    assert.equal(ompCoworkTransportBypassesFetch({ api: "anthropic-messages" }), false);
    assert.equal(ompCoworkTransportBypassesFetch({ provider: "openai", api: "anthropic-messages" }), false);
    assert.equal(ompCoworkTransportBypassesFetch(COWORK_MODEL, {}), true);
    assert.equal(ompCoworkTransportBypassesFetch(COWORK_MODEL, { PI_PROXY: "" }), true);
    assert.equal(ompCoworkTransportBypassesFetch(COWORK_MODEL, { PI_PROXY: "   " }), true);
    assert.equal(ompCoworkTransportBypassesFetch(COWORK_MODEL, { PI_PROXY: "http://127.0.0.1:9999" }), false);
    assert.equal(ompCoworkTransportBypassesFetch(COWORK_MODEL, { PI_PROXY_ANTHROPIC: "" }), true);
    assert.equal(ompCoworkTransportBypassesFetch(COWORK_MODEL, { PI_PROXY_ANTHROPIC: "http://127.0.0.1:9999" }), false);
});
