// dsh settings.yaml route resolution (#521): settings baseURL ?? $DEEPSEEK_BASE_URL
// ?? official deepseek default; a custom provider without any resolvable base
// yields undefined (no interception) rather than a wrong rewrite target.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDshSettings, resolveDshUpstreamOrigin, OFFICIAL_DEEPSEEK_ORIGIN } from "../src/agent/dsh-settings.ts";

const CUSTOM = `
llm-pi-ai:
  providers:
    local-vllm:
      api: openai-completions
      baseURL: http://10.0.0.5:8199/v1
      apiKeyEnv: ***
      models:
        - id: qwen-test
          contextWindow: 262144
agent-default-model:
  provider: local-vllm
  model: qwen-test
`;

test("custom provider: route fields + origin strips the path", () => {
    const route = parseDshSettings(CUSTOM);
    assert.deepEqual(route, { provider: "local-vllm", model: "qwen-test", api: "openai-completions", baseUrl: "http://10.0.0.5:8199/v1" });
    assert.equal(resolveDshUpstreamOrigin(route, {}), "http://10.0.0.5:8199");
});

test("empty settings, no env → official deepseek default", () => {
    const route = parseDshSettings("");
    assert.equal(route.provider, "deepseek-official");
    assert.equal(route.model, "deepseek-chat");
    assert.equal(resolveDshUpstreamOrigin(route, {}), OFFICIAL_DEEPSEEK_ORIGIN);
});

test("$DEEPSEEK_BASE_URL fills in when settings have no base; path stripped", () => {
    const route = parseDshSettings("");
    assert.equal(resolveDshUpstreamOrigin(route, { DEEPSEEK_BASE_URL: "https://ds.example.org:8443/api" }), "https://ds.example.org:8443");
});

test("settings base wins over env", () => {
    const route = parseDshSettings(CUSTOM);
    assert.equal(resolveDshUpstreamOrigin(route, { DEEPSEEK_BASE_URL: "https://other.example" }), "http://10.0.0.5:8199");
});

test("llm-deepseek.baseURL fallback for the official route", () => {
    const text = `
llm-deepseek:
  baseURL: "http://ds-mirror.example:1234/v1"  # mirror
`;
    const route = parseDshSettings(text);
    assert.equal(route.provider, "deepseek-official");
    assert.equal(resolveDshUpstreamOrigin(route, {}), "http://ds-mirror.example:1234");
});

test("custom provider with no resolvable base → undefined (no interception)", () => {
    const text = `
llm-pi-ai:
  providers:
    broken:
      api: openai-completions
agent-default-model:
  provider: broken
  model: whatever
`;
    const route = parseDshSettings(text);
    assert.equal(route.baseUrl, undefined);
    assert.equal(resolveDshUpstreamOrigin(route, { DEEPSEEK_BASE_URL: "not a url" }), undefined);
});

test("malformed settings base falls through to env", () => {
    const text = `
llm-pi-ai:
  providers:
    p1:
      baseURL: not a url
agent-default-model:
  provider: p1
  model: m
`;
    const route = parseDshSettings(text);
    assert.equal(resolveDshUpstreamOrigin(route, { DEEPSEEK_BASE_URL: "http://env.example:1" }), "http://env.example:1");
});
