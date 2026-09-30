import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";

// Set before the dynamic imports below: context-window.ts freezes
// LAUNCHER_MODEL_MAX_OUTPUTS at module load (mirrors LAUNCHER_MODEL_WINDOWS).
process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS = JSON.stringify({
    "headroom-launch-model": 80_000,
    "headroom-rank-model": 10_000,
});

const { collectModelMaxOutputs, parseCodebuddyModelsJson, parseCodexToml, parseOmpYaml, parseOpencodeProviders, readPiConfig } = await import("../src/client-config.ts");
const { launcherMaxOutput, parseLauncherModelMaxOutputs } = await import("../src/server/context-window.ts");

test("parseCodexToml: model_max_output_tokens rides the window entry (#971)", () => {
    const cfg = parseCodexToml([
        "model = \"gpt-5.1\"",
        "model_context_window = 272000",
        "model_max_output_tokens = 128000",
    ].join("\n"));
    assert.equal(cfg.model, "gpt-5.1");
    assert.equal(cfg.maxOutput, 128000);
    assert.deepEqual(cfg.modelWindows, [{ id: "gpt-5.1", contextWindow: 272000, maxOutput: 128000 }]);
});

test("parseCodexToml: no output key → window-only entry (unchanged)", () => {
    const cfg = parseCodexToml("model = \"gpt-5.1\"\nmodel_context_window = 272000\n");
    assert.equal(cfg.maxOutput, undefined);
    assert.deepEqual(cfg.modelWindows, [{ id: "gpt-5.1", contextWindow: 272000 }]);
});

test("readPiConfig: models[].maxTokens completes the entry (#971)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cfg-"));
    try {
        fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({
            providers: {
                sglang: {
                    baseUrl: "http://127.0.0.1:8199/v1",
                    models: [
                        { id: "qwen3.8-27b", contextWindow: 262144, maxTokens: 32768 },
                        { id: "qwen-no-out", contextWindow: 131072 },
                    ],
                },
            },
        }));
        const cfg = readPiConfig(home);
        assert.deepEqual(cfg.providers.sglang?.models, [
            { id: "qwen3.8-27b", contextWindow: 262144, maxOutput: 32768 },
            { id: "qwen-no-out", contextWindow: 131072 },
        ]);
    } finally {
        rmrf(home);
    }
});

test("parseOmpYaml: maxTokens at model-entry depth completes the entry (#971)", () => {
    const yml = [
        "providers:",
        "  sglang:",
        "    baseUrl: http://127.0.0.1:8199/v1",
        "    models:",
        "      - id: qwen3.8-27b",
        "        contextWindow: 262144",
        "        maxTokens: 32768",
        "      - id: other-model",
        "        contextWindow: 131072",
    ].join("\n");
    const cfg = parseOmpYaml(yml);
    assert.deepEqual(cfg.providers.sglang?.models, [
        { id: "qwen3.8-27b", contextWindow: 262144, maxOutput: 32768 },
        { id: "other-model", contextWindow: 131072 },
    ]);
});

test("parseOpencodeProviders: limit object shape {context, output} (#971)", () => {
    const cfg = parseOpencodeProviders({
        provider: {
            sglang: {
                options: { baseURL: "http://127.0.0.1:8199/v1" },
                models: {
                    "qwen3.8-27b": { limit: { context: 262144, output: 32768 } },
                    legacy: { limit: 131072 },
                },
            },
        },
    });
    assert.deepEqual(cfg.providers.sglang?.models, [
        { id: "qwen3.8-27b", contextWindow: 262144, maxOutput: 32768 },
        { id: "legacy", contextWindow: 131072 },
    ]);
});

test("parseCodebuddyModelsJson: maxOutputTokens completes the entry (#971)", () => {
    const parsed = parseCodebuddyModelsJson([
        { id: "m1", url: "http://127.0.0.1:8199/v1", maxInputTokens: 262144, maxOutputTokens: 32768 },
        { id: "m2", url: "http://127.0.0.1:8199/v1", maxInputTokens: 131072 },
    ]);
    assert.deepEqual(parsed.models, [
        { id: "m1", contextWindow: 262144, maxOutput: 32768 },
        { id: "m2", contextWindow: 131072 },
    ]);
});

test("collectModelMaxOutputs: reduces every source to id → maxOutput, scoped", () => {
    const config = {
        pi: { providers: { p: { models: [{ id: "pi-m", contextWindow: 1, maxOutput: 111 }] } } },
        omp: { providers: { o: { models: [{ id: "omp-m", contextWindow: 1, maxOutput: 222 }] } } },
        opencode: { providers: { oc: { models: [{ id: "oc-m", contextWindow: 1, maxOutput: 333 }] } } },
        codex: { modelWindows: [{ id: "codex-m", contextWindow: 1, maxOutput: 444 }] },
        codebuddy: { models: [{ id: "cb-m", contextWindow: 1, maxOutput: 555 }] },
    };
    assert.deepEqual(collectModelMaxOutputs(config as never), { "pi-m": 111, "omp-m": 222, "oc-m": 333, "codex-m": 444, "cb-m": 555 });
    assert.deepEqual(collectModelMaxOutputs(config as never, "pi"), { "pi-m": 111 });
    // window-only entries contribute nothing
    const windowOnly = { pi: { providers: { p: { models: [{ id: "x", contextWindow: 5 }] } } } };
    assert.deepEqual(collectModelMaxOutputs(windowOnly as never), {});
});

test("parseLauncherModelMaxOutputs: JSON shape, junk tolerated", () => {
    assert.deepEqual(parseLauncherModelMaxOutputs(JSON.stringify({ a: 100, b: 50.5, c: -1, d: "x" })), { a: 100, b: 50 });
    assert.deepEqual(parseLauncherModelMaxOutputs("not json"), {});
    assert.deepEqual(parseLauncherModelMaxOutputs(undefined), {});
    assert.equal(launcherMaxOutput("headroom-launch-model"), 80_000);
    assert.equal(launcherMaxOutput("nope"), undefined);
});
