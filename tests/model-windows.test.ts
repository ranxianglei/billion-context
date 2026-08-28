import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    parseOmpYaml,
    parseCodexToml,
    readPiConfig,
    readOpencodeConfig,
    collectModelWindows,
    type ClientConfig,
} from "../src/client-config.ts";
import { parseLauncherModelWindows, anthropicBetaContextWindow } from "../src/server.ts";

test("parseOmpYaml: captures per-model contextWindow (models after baseUrl)", () => {
    const yml = [
        "providers:",
        "  sglang-responses:",
        "    baseUrl: http://127.0.0.1:8199/v1",
        "    auth: none",
        "    models:",
        "      - id: qwen3.8-27b",
        "        api: openai-responses",
        "        name: Qwen3.8-27B",
        "        reasoning: true",
        "        supportsTools: true",
        "        contextWindow: 262144",
        "        maxTokens: 32768",
    ].join("\n");
    const cfg = parseOmpYaml(yml);
    assert.equal(cfg.providers["sglang-responses"]?.baseUrl, "http://127.0.0.1:8199/v1");
    assert.deepEqual(cfg.providers["sglang-responses"]?.models, [{ id: "qwen3.8-27b", contextWindow: 262144 }]);
});

test("parseOmpYaml: baseUrl AFTER models: is still captured", () => {
    const yml = [
        "providers:",
        "  prov:",
        "    models:",
        "      - id: m1",
        "        contextWindow: 32768",
        "    baseUrl: http://after.example/v1",
    ].join("\n");
    const cfg = parseOmpYaml(yml);
    assert.equal(cfg.providers.prov?.baseUrl, "http://after.example/v1");
    assert.deepEqual(cfg.providers.prov?.models, [{ id: "m1", contextWindow: 32768 }]);
});

test("parseOmpYaml: multiple models + multiple providers", () => {
    const yml = [
        "providers:",
        "  a:",
        "    baseUrl: http://a/v1",
        "    models:",
        "      - id: m1",
        "        contextWindow: 1000",
        "      - id: m2",
        "        contextWindow: 2000",
        "  b:",
        "    baseUrl: http://b/v1",
        "    models:",
        "      - id: m1",
        "        contextWindow: 3000",
    ].join("\n");
    const cfg = parseOmpYaml(yml);
    assert.deepEqual(cfg.providers.a?.models, [{ id: "m1", contextWindow: 1000 }, { id: "m2", contextWindow: 2000 }]);
    assert.deepEqual(cfg.providers.b?.models, [{ id: "m1", contextWindow: 3000 }]);
});

test("readPiConfig: captures models[].contextWindow from models.json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-piw-"));
    fs.writeFileSync(
        path.join(home, "models.json"),
        JSON.stringify({
            providers: {
                lb: {
                    baseUrl: "http://127.0.0.1:18081",
                    models: [
                        { id: "glm-5.2", contextWindow: 1000000, maxTokens: 131072 },
                        { id: "broken" },
                        { id: "nan-win", contextWindow: "lots" },
                    ],
                },
            },
        }),
    );
    const cfg = readPiConfig(home);
    assert.deepEqual(cfg.providers.lb?.models, [{ id: "glm-5.2", contextWindow: 1000000 }]);
});

test("readOpencodeConfig: captures models.<id>.limit", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ocw-"));
    const file = path.join(home, "opencode.json");
    fs.writeFileSync(
        file,
        JSON.stringify({
            provider: {
                prov: {
                    options: { baseURL: "http://prov/v1" },
                    models: {
                        "glm-5.2": { name: "GLM", limit: 1000000 },
                        nolimit: { name: "no limit here" },
                    },
                },
            },
        }),
    );
    const cfg = readOpencodeConfig(file);
    assert.equal(cfg.providers.prov?.baseURL, "http://prov/v1");
    assert.deepEqual(cfg.providers.prov?.models, [{ id: "glm-5.2", contextWindow: 1000000 }]);
});

test("parseCodexToml: model + model_context_window pair captured", () => {
    const toml = [
        'model = "gpt-5.2"',
        'model_provider = "openai"',
        "model_context_window = 272000",
        "",
        "[model_providers.openai]",
        'base_url = "https://api.openai.com/v1"',
    ].join("\n");
    const cfg = parseCodexToml(toml);
    assert.equal(cfg.providers.openai?.baseUrl, "https://api.openai.com/v1");
    assert.deepEqual(cfg.modelWindows, [{ id: "gpt-5.2", contextWindow: 272000 }]);
});

test("parseCodexToml: no window without the override pair", () => {
    const cfg = parseCodexToml('model = "gpt-5.2"\n');
    assert.equal(cfg.modelWindows, undefined);
});

test("collectModelWindows: same id across providers → largest window wins", () => {
    const config: ClientConfig = {
        pi: { providers: { a: { baseUrl: "http://a", models: [{ id: "m", contextWindow: 1000 }] } } },
        omp: { providers: { b: { baseUrl: "http://b", models: [{ id: "m", contextWindow: 3000 }] } } },
        opencode: { providers: { c: { baseURL: "http://c", models: [{ id: "m", contextWindow: 2000 }] } } },
        codex: { providers: {}, modelWindows: [{ id: "codex-m", contextWindow: 272000 }] },
    };
    assert.deepEqual(collectModelWindows(config), { m: 3000, "codex-m": 272000 });
});

test("parseLauncherModelWindows: valid JSON, invalid input, non-numeric filtered", () => {
    assert.deepEqual(parseLauncherModelWindows('{"qwen3.8-27b": 262144.9, "x": 100}'), { "qwen3.8-27b": 262144, x: 100 });
    assert.deepEqual(parseLauncherModelWindows(undefined), {});
    assert.deepEqual(parseLauncherModelWindows("not json"), {});
    assert.deepEqual(parseLauncherModelWindows('["array"]'), {});
    assert.deepEqual(parseLauncherModelWindows('{"bad": "str", "neg": -5, "zero": 0}'), {});
});

// #302: an `anthropic-beta: context-1m-…` header means the client negotiated a
// 1M window with the upstream — the model table's 200K default must be
// overridden. The parser is per-request (the header may appear/disappear
// between requests of the same session).

test("anthropicBetaContextWindow: context-1m beta → 1,000,000", () => {
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "context-1m-2025-08-07" }), 1_000_000);
});

test("anthropicBetaContextWindow: no header / no context beta → undefined (model default)", () => {
    assert.equal(anthropicBetaContextWindow({}), undefined);
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "prompt-caching-2024-07-31, interleaved-thinking-2025-05-14" }), undefined);
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "" }), undefined);
});

test("anthropicBetaContextWindow: mixed beta list picks the context beta", () => {
    assert.equal(
        anthropicBetaContextWindow({ "anthropic-beta": "prompt-caching-2024-07-31, context-1m-2025-08-07, fine-grained-tool-streaming-2025-05-14" }),
        1_000_000,
    );
});

test("anthropicBetaContextWindow: array header value is joined", () => {
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": ["context-1m-2025-08-07"] }), 1_000_000);
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": ["prompt-caching-2024-07-31", "context-1m-2025-08-07"] }), 1_000_000);
});

test("anthropicBetaContextWindow: case-insensitive + surrounding whitespace", () => {
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "  Context-1M-2025-08-07  " }), 1_000_000);
});

test("anthropicBetaContextWindow: future larger-context beta generalizes (context-Nm → N×1M)", () => {
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "context-2m-2026-01-01" }), 2_000_000);
    // Largest wins when several context betas are present.
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "context-1m-2025-08-07, context-2m-2026-01-01" }), 2_000_000);
});

test("anthropicBetaContextWindow: rejects malformed / non-context tokens", () => {
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "context-m-2025-08-07" }), undefined);
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "context-1x-2025-08-07" }), undefined);
    assert.equal(anthropicBetaContextWindow({ "anthropic-beta": "my-context-1m-2025-08-07" }), undefined);
});
