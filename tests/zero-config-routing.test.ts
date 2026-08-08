import test from "node:test";
import assert from "node:assert/strict";
import { resolveUpstream } from "../src/server.js";
import type { ProxyOptions } from "../src/config.js";

const BASE_OPTS: ProxyOptions = {
    port: 8787,
    host: "127.0.0.1",
    upstream: "https://api.anthropic.com",
    routes: { zhipu: { url: "https://open.bigmodel.cn" } },
    modelContextLimit: 200000,
    kernelConfig: { blocks: [], messageRefs: [], nudge: {}, stats: {}, nextBlockId: 0, nextRunId: 0 } as never,
    compress: { injectTool: true, injectNudge: true },
    sessionHeader: "",
    log: false,
    debug: false,
    passthrough: false,
    autoUpdate: false,
};

test("zero-config /p/ route: strips prefix, uses embedded URL verbatim", () => {
    const r = resolveUpstream(BASE_OPTS, "/p/https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.ok(r, "should resolve");
    assert.equal(r!.provider, "p");
    assert.equal(r!.rewrittenUrl, "https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.equal(r!.upstream, "https://open.bigmodel.cn");
});

test("zero-config /p/ route: works with trailing path segments", () => {
    const r = resolveUpstream(BASE_OPTS, "/p/https://api.openai.com/v1/chat/completions");
    assert.ok(r);
    assert.equal(r!.rewrittenUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(r!.upstream, "https://api.openai.com");
});

test("zero-config /p/ takes precedence over named route (no name shadowing)", () => {
    // A provider literally named 'p' must not shadow the zero-config prefix.
    const opts: ProxyOptions = { ...BASE_OPTS, routes: { p: { url: "https://example.com" } } };
    const r = resolveUpstream(opts, "/p/https://api.openai.com/v1/responses");
    assert.ok(r);
    assert.equal(r!.provider, "p");
    assert.equal(r!.rewrittenUrl, "https://api.openai.com/v1/responses");
});

test("zero-config /p/ ignores malformed embedded URL, falls through", () => {
    const r = resolveUpstream(BASE_OPTS, "/p/not-a-url");
    // falls through to named matching, which misses → undefined
    assert.equal(r, undefined);
});

test("named route still works alongside zero-config", () => {
    const r = resolveUpstream(BASE_OPTS, "/zhipu/api/coding/paas/v4/chat/completions");
    assert.ok(r);
    assert.equal(r!.provider, "zhipu");
    assert.equal(r!.rewrittenUrl, "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
});
