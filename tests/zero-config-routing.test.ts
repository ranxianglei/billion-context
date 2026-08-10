import test from "node:test";
import assert from "node:assert/strict";
import { resolveUpstream } from "../src/server.js";
import type { ProxyOptions } from "../src/config.js";

const BASE_OPTS: ProxyOptions = {
    port: 8787,
    host: "127.0.0.1",
    upstream: "https://api.anthropic.com",
    routes: {},
    modelContextLimit: 200000,
    kernelConfig: { blocks: [], messageRefs: [], nudge: {}, stats: {}, nextBlockId: 0, nextRunId: 0 } as never,
    compress: { injectTool: true, injectNudge: true },
    promptCache: { routing: "auto" },
    sessionHeader: "",
    log: false,
    debug: false,
    passthrough: false,
    autoUpdate: false,
    updateMode: "auto",
    mitm: { enabled: false, domains: [] },
};

test("zero-config /bili/ route: strips prefix, uses embedded URL verbatim", () => {
    const r = resolveUpstream(BASE_OPTS, "/bili/https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.ok(r, "should resolve");
    assert.equal(r!.rewrittenUrl, "https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.equal(r!.upstream, "https://open.bigmodel.cn");
});

test("zero-config /bili/ route: works with trailing path segments", () => {
    const r = resolveUpstream(BASE_OPTS, "/bili/https://api.openai.com/v1/chat/completions");
    assert.ok(r);
    assert.equal(r!.rewrittenUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(r!.upstream, "https://api.openai.com");
});

test("zero-config /bili/ ignores malformed embedded URL", () => {
    assert.equal(resolveUpstream(BASE_OPTS, "/bili/not-a-url"), undefined);
});

test("non-/bili/ requests return undefined (no named routing anymore)", () => {
    // The old /<name>/... named-routing is gone. Anything without /bili/ is
    // either a control endpoint (__bili) handled elsewhere, or unrouteable.
    assert.equal(resolveUpstream(BASE_OPTS, "/zhipu/api/coding/paas/v4/chat/completions"), undefined);
    assert.equal(resolveUpstream(BASE_OPTS, "/v1/chat/completions"), undefined);
    assert.equal(resolveUpstream(BASE_OPTS, "/anthropic/v1/messages"), undefined);
});

test("routes config is now only for context overrides (URL keys), not routing", () => {
    // routes exist but routing only happens via /bili/. These keys are matched
    // against the embedded URL for context resolution, not for path rewriting.
    const opts: ProxyOptions = {
        ...BASE_OPTS,
        routes: {
            "https://open.bigmodel.cn/api/anthropic": { models: { "glm-5.2": { context: 1000000 } } },
        },
    };
    // A /bili/ request resolves to the embedded URL...
    const r = resolveUpstream(opts, "/bili/https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.ok(r);
    assert.equal(r!.rewrittenUrl, "https://open.bigmodel.cn/api/anthropic/v1/messages");
    // ...and a non-/bili/ request to the same host still doesn't route.
    assert.equal(resolveUpstream(opts, "/open.bigmodel.cn/api/anthropic/v1/messages"), undefined);
});
