import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOptions, lookupContextLimit, resolveContextLimit, resolveConfiguredContextLimit, parseRouteEntry, parsePromptCacheRouting } from "../src/config.ts";

const TMP = (s: string) => join(tmpdir(), `test-acp-${process.pid}-${s}.json`);
const writeRoutes = (name: string, obj: unknown) => {
    const p = TMP(name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
};

test("providers map is parsed as { url: { models } }", () => {
    const opts = loadOptions({ ACP_PROVIDERS: writeRoutes("obj", {}) });
    assert.equal(typeof opts.routes, "object");
    assert.ok(opts.routes !== null);
    unlinkSync(TMP("obj"));
});

test("providers value is an object with optional models (key IS the url)", () => {
    // key = upstream URL, value = { models }
    const p = writeRoutes("obj-form", {
        "https://open.bigmodel.cn": { models: { "glm-5.2": { context: 1000000 } } },
    });
    const opts = loadOptions({ ACP_PROVIDERS: p });
    assert.ok(opts.routes["https://open.bigmodel.cn"]);
    assert.equal(opts.routes["https://open.bigmodel.cn"]?.models?.["glm-5.2"]?.context, 1000000);
    unlinkSync(p);
});

test("parseRouteEntry: object form keeps models", () => {
    const r = parseRouteEntry({ models: { "glm-5.2": { context: 1000000 } } });
    assert.deepEqual(r, { models: { "glm-5.2": { context: 1000000 } } });
});

test("parseRouteEntry: bare object (no models) is valid", () => {
    const r = parseRouteEntry({});
    assert.deepEqual(r, { models: undefined });
});

test("parseRouteEntry: null means present-but-no-overrides", () => {
    const r = parseRouteEntry(null);
    assert.deepEqual(r, {});
});

test("parseRouteEntry: invalid values return undefined", () => {
    assert.equal(parseRouteEntry(123), undefined);
    assert.equal(parseRouteEntry(undefined), undefined);
    assert.equal(parseRouteEntry("string"), undefined); // url is the KEY, not the value
});

test("legacy named-route config fails with an actionable migration error", () => {
    const p = writeRoutes("legacy-string", { openai: "https://api.openai.com/v1" });
    try {
        assert.throws(() => loadOptions({ ACP_PROVIDERS: p }), /legacy provider route.*use the upstream URL as the key/);
    } finally {
        unlinkSync(p);
    }
});

test("prompt-cache routing accepts the tri-state and defaults invalid values to auto", () => {
    assert.equal(parsePromptCacheRouting("enabled"), "enabled");
    assert.equal(parsePromptCacheRouting("disabled"), "disabled");
    assert.equal(parsePromptCacheRouting("auto"), "auto");
    assert.equal(parsePromptCacheRouting("unknown"), "auto");
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

// ── resolveContextLimit: longest-prefix matching on URL keys ──────────────
// The key is the /bili/<this> string. A request matches when its embedded
// upstream URL equals the key, or starts with key + "/". Longest key wins
// (most specific). Shallow keys match the whole host; deep keys match only
// that endpoint. This never cross-matches different hosts/paths because the
// key is a literal URL prefix.

test("exact URL key match returns context", () => {
    const routes = {
        "https://open.bigmodel.cn/api/anthropic": { models: { "glm-5.2": { context: 1000000 } } },
    };
    assert.equal(resolveContextLimit(routes, "https://open.bigmodel.cn/api/anthropic", "glm-5.2"), 1000000);
});

test("key as prefix of request (request adds /v1/messages) still matches", () => {
    const routes = {
        "https://open.bigmodel.cn/api/anthropic": { models: { "glm-5.2": { context: 1000000 } } },
    };
    assert.equal(resolveContextLimit(routes, "https://open.bigmodel.cn/api/anthropic/v1/messages", "glm-5.2"), 1000000);
});

test("shallow key (host only) matches all paths on that host", () => {
    const routes = {
        "https://open.bigmodel.cn": { models: { "glm-5.2": { context: 1000000 } } },
    };
    assert.equal(resolveContextLimit(routes, "https://open.bigmodel.cn/api/anthropic/v1/messages", "glm-5.2"), 1000000);
    assert.equal(resolveContextLimit(routes, "https://open.bigmodel.cn/anything", "glm-5.2"), 1000000);
});

test("deep key does NOT match a request to a different path (no cross-path bleed)", () => {
    const routes = {
        "https://open.bigmodel.cn/api/anthropic": { models: { "glm-5.2": { context: 1000000 } } },
    };
    // request to /api/openai path — deep anthropic key must NOT match.
    // Falls through to built-in table (glm-5 → 1000000), so we verify the
    // *route* didn't match by checking an unknown model returns undefined.
    assert.equal(resolveContextLimit(routes, "https://open.bigmodel.cn/api/openai/v1/messages", "unknown-model"), undefined);
});

test("does not match different host with similar prefix (boundary check)", () => {
    const routes = {
        "https://open.bigmodel.cn": { models: { "glm-5.2": { context: 1000000 } } },
    };
    // evil.com.evil should not match open.bigmodel.cn (no host-prefix bleed).
    // Verify with an unknown model so the built-in table doesn't mask the result.
    assert.equal(resolveContextLimit(routes, "https://open.bigmodel.cn.evil", "unknown-model"), undefined);
});

test("longest key wins (most specific)", () => {
    const routes = {
        "https://open.bigmodel.cn": { models: { "glm-5.2": { context: 200000 } } },
        "https://open.bigmodel.cn/api/anthropic": { models: { "glm-5.2": { context: 1000000 } } },
    };
    // Both keys are prefixes of the request; the deeper one wins.
    assert.equal(resolveContextLimit(routes, "https://open.bigmodel.cn/api/anthropic/v1/messages", "glm-5.2"), 1000000);
});

test("model not in route falls through to lookup table", () => {
    const routes = {
        "https://open.bigmodel.cn": { models: { "glm-5.2": { context: 1000000 } } },
    };
    // glm-5.2 not in this route's models, but in the built-in table (1000000)
    assert.equal(resolveContextLimit(routes, "https://api.deepseek.com", "deepseek-chat"), 64000);
});

test("configured context lookup stays separate from registry/built-in fallbacks", () => {
    const routes = { "https://api.openai.com": { models: {} } };
    assert.equal(resolveConfiguredContextLimit(routes, "https://api.openai.com/v1/responses", "gpt-5"), undefined);
    assert.equal(resolveContextLimit(routes, "https://api.openai.com/v1/responses", "gpt-5"), 400_000);
});

test("no matching key and unknown model returns undefined", () => {
    const routes = {
        "https://open.bigmodel.cn": { models: { "glm-5.2": { context: 1000000 } } },
    };
    assert.equal(resolveContextLimit(routes, "https://api.unknown.com", "some-future-model"), undefined);
});

// Trailing slashes on config keys are normalized away so they still match.
// A user typing "https://open.bigmodel.cn/" (trailing slash) must still get
// the override for requests to that host.
import { normalizeUrlKey } from "../src/config.ts";
test("normalizeUrlKey strips trailing slashes", () => {
    assert.equal(normalizeUrlKey("https://open.bigmodel.cn/"), "https://open.bigmodel.cn");
    assert.equal(normalizeUrlKey("https://open.bigmodel.cn///"), "https://open.bigmodel.cn");
    assert.equal(normalizeUrlKey("https://open.bigmodel.cn"), "https://open.bigmodel.cn");
    assert.equal(normalizeUrlKey(""), "");
});
