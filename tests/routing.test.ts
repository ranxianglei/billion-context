import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { loadOptions, lookupContextLimit } from "../src/config.ts";
import { resolveUpstream } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";

const TMP = (s: string) => `/tmp/test-acp-${s}.json`;
const writeRoutes = (name: string, obj: unknown) => {
    const p = TMP(name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
};
const OPTS = (routes: Record<string, string>): ProxyOptions => ({ ...loadOptions({}), routes: Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, { url: v }])) });

test("routes are parsed as an object map { provider: url }", () => {
    const opts = loadOptions({ ACP_PROVIDERS: writeRoutes("obj", {}) });
    assert.equal(typeof opts.routes, "object");
    assert.ok(opts.routes !== null);
    unlinkSync(TMP("obj"));
});

test("routes object strips trailing slashes from baseURLs", () => {
    const p = writeRoutes("slash", { glm: "https://bigmodel.cn/", anthropic: "https://api.anthropic.com/" });
    const opts = loadOptions({ ACP_PROVIDERS: p });
    assert.equal(opts.routes.glm?.url, "https://bigmodel.cn");
    assert.equal(opts.routes.anthropic?.url, "https://api.anthropic.com");
    unlinkSync(p);
});

test("routes accept object form { url, models }", () => {
    const p = writeRoutes("obj-form", { glm: { url: "https://bigmodel.cn", models: { "glm-5.2": { context: 1000000 } } } });
    const opts = loadOptions({ ACP_PROVIDERS: p });
    assert.equal(opts.routes.glm?.url, "https://bigmodel.cn");
    assert.equal(opts.routes.glm?.models?.["glm-5.2"]?.context, 1000000);
    unlinkSync(p);
});

test("routes ignore invalid entries (defensive)", () => {
    const p = writeRoutes("defensive", { glm: "https://ok", bad: 123, also: null, obj: { url: "https://obj" } });
    const opts = loadOptions({ ACP_PROVIDERS: p });
    assert.equal(opts.routes.glm?.url, "https://ok");
    assert.equal(opts.routes.obj?.url, "https://obj");
    assert.ok(!("bad" in opts.routes));
    assert.ok(!("also" in opts.routes));
    unlinkSync(p);
});

test("lookupContextLimit returns known windows", () => {
    assert.equal(lookupContextLimit("claude-sonnet-4-20250514"), 200_000);
    assert.equal(lookupContextLimit("gpt-4o"), 128_000);
    assert.equal(lookupContextLimit("gpt-5"), 400_000);
    assert.equal(lookupContextLimit("o1-preview"), 200_000);
    assert.equal(lookupContextLimit("gemini-2.5-pro"), 1_000_000);
    assert.equal(lookupContextLimit("glm-4.6"), 128_000);
    assert.equal(lookupContextLimit("glm-4.5-air"), 128_000);
    assert.equal(lookupContextLimit("deepseek-chat"), 64_000);
    assert.equal(lookupContextLimit("qwen-max"), 128_000);
    assert.equal(lookupContextLimit("kimi-k2"), 128_000);
});

test("lookupContextLimit returns undefined for unknown models", () => {
    assert.equal(lookupContextLimit("some-future-model"), undefined);
    assert.equal(lookupContextLimit(""), undefined);
    assert.equal(lookupContextLimit(undefined), undefined);
});

test("path-based routing does not require apiKey in route config", () => {
    const p = writeRoutes("nokey", { glm: "https://bigmodel.cn" });
    const opts = loadOptions({ ACP_PROVIDERS: p });
    assert.equal(opts.routes.glm?.url, "https://bigmodel.cn");
    assert.ok(!("apiKey" in opts));
    assert.ok(!("apiKey" in opts.routes));
    unlinkSync(p);
});

// ── resolveUpstream: URL path rewriting contract ───────────────────────────
// The core invariant: the proxy drops ONLY the provider-name segment from the
// request path and splices the real baseURL in front. The request's own /v1
// (or /v4, etc.) prefix is preserved. So route baseURL should be the provider
// ROOT (no /v1), and the agent's SDK naturally carries /v1 in its path.

test("OpenAI SDK: /v1/glm/chat/completions → <root>/v1/chat/completions", () => {
    // Agent sets baseURL=http://localhost:8788/v1/glm, SDK posts to /v1/glm/chat/completions.
    // Route.glm = provider root (no /v1). Result: clean single /v1.
    const o = OPTS({ glm: "https://bigmodel.cn" });
    const r = resolveUpstream(o, "/v1/glm/chat/completions");
    assert.ok(r);
    assert.equal(r.provider, "glm");
    assert.equal(r.upstream, "https://bigmodel.cn");
    assert.equal(r.rewrittenUrl, "https://bigmodel.cn/v1/chat/completions");
});

test("Anthropic SDK: /anthropic/v1/messages → <root>/v1/messages", () => {
    // Agent sets baseURL=http://localhost:8788/anthropic, SDK posts to /anthropic/v1/messages.
    // Route.anthropic = provider root. Result preserves /v1.
    const o = OPTS({ anthropic: "https://api.anthropic.com" });
    const r = resolveUpstream(o, "/anthropic/v1/messages");
    assert.ok(r);
    assert.equal(r.provider, "anthropic");
    assert.equal(r.rewrittenUrl, "https://api.anthropic.com/v1/messages");
});

test("provider segment at a non-standard position still matches", () => {
    // Some agents may place the provider elsewhere in the path.
    const o = OPTS({ glm: "https://bigmodel.cn" });
    const r = resolveUpstream(o, "/some/prefix/glm/v1/chat/completions");
    assert.ok(r);
    assert.equal(r.rewrittenUrl, "https://bigmodel.cn/some/prefix/v1/chat/completions");
});

test("returns undefined when no provider segment is present", () => {
    const o = OPTS({ glm: "https://bigmodel.cn" });
    assert.equal(resolveUpstream(o, "/v1/chat/completions"), undefined);
    assert.equal(resolveUpstream(o, "/chat/completions"), undefined);
});

test("ignores provider names that look like API path segments", () => {
    // Names must start with a letter and be alnum/-/_ so they can't collide
    // with normal API segments like v1, chat, completions, messages.
    const o = OPTS({ v1: "https://example.com", glm: "https://ok" });
    assert.equal(resolveUpstream(o, "/v1/chat/completions"), undefined);
});

test("picks the longest matching name (no prefix shadowing)", () => {
    const o = OPTS({ openai: "https://api.openai.com", oai: "https://other" });
    const r = resolveUpstream(o, "/openai/chat/completions");
    assert.ok(r);
    assert.equal(r.provider, "openai");
});
