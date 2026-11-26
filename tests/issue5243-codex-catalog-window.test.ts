import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexAlignedWindow, readCodexLiveModelWindow } from "../src/codex-models.ts";
import { mergeCodexViews, readCodexConfig, type CodexConfig } from "../src/client-config.ts";

process.env.NODE_ENV = "test";

// #5243: the codex-cli catalog install writes ONLY `model_catalog_json`
// (a file named by config.toml) — `models_cache.json` is absent entirely —
// so bili clamped the window to the flat 272K unknown-model fallback and
// nudge bands fired EMERGENCY at ~35% real usage. The alignment must honor
// the catalog path, then fall back to models_cache.json, then to
// config.toml model_context_window (warned, named in the clamp log).

const model = "gpt-6.1-sol";
const codex = { "user-agent": "codex_cli_rs/0.53.0 (linux 6.8.0; x86_64) cli" };

function fixture(t: { after(fn: () => void): void }): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-5243-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    return home;
}

function writeCatalog(home: string, models: unknown[], filename = "model-catalog.json", raw = false): string {
    const file = path.join(home, filename);
    fs.writeFileSync(file, JSON.stringify({ models: models.map((m) => !raw && m && typeof m === "object" ? { effective_context_window_percent: 100, ...m } : m) }));
    return file;
}

function useHome(t: { after(fn: () => void): void }, home: string): void {
    const previous = process.env.CODEX_HOME;
    t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
    process.env.CODEX_HOME = home;
}

test("catalog-only install: model_catalog_json replaces missing models_cache.json (the issue repro)", (t) => {
    const home = fixture(t);
    // raw: no effective_context_window_percent key in the file → codex/bili's
    // own default of 95 applies, exactly like the reporter's catalog install.
    const file = writeCatalog(home, [{ slug: model, context_window: 272_000, max_context_window: 872_000 }], "model-catalog.json", true);
    fs.writeFileSync(path.join(home, "config.toml"), `model_catalog_json = "${file}"\nmodel_context_window = 1050000\n`);
    assert.equal(readCodexConfig(home).modelCatalogJson, file, "config.toml parses the catalog pointer");
    // min(configured 1050000, max 872000) * 95% default percent = 828400
    assert.deepEqual(readCodexLiveModelWindow(model, home), { window: 828_400, source: "codex-catalog" });
    useHome(t, home);
    // Pre-fix this asserted { limit: 272_000, clamped: true } (flat fallback).
    assert.deepEqual(codexAlignedWindow(1_050_000, model, codex), { limit: 828_400, clamped: true, source: "codex-catalog" });
});

test("legacy install without model_catalog_json still reads models_cache.json", (t) => {
    const home = fixture(t);
    writeCatalog(home, [{ slug: model, max_context_window: 800_000 }], "models_cache.json");
    useHome(t, home);
    assert.deepEqual(codexAlignedWindow(1_050_000, model, codex), { limit: 800_000, clamped: true, source: "codex-models-cache" });
});

test("no readable table at all: config.toml model_context_window sizes the window instead of the 272K flat fallback", (t) => {
    const home = fixture(t);
    fs.writeFileSync(path.join(home, "config.toml"), "model_context_window = 1050000\n");
    assert.deepEqual(readCodexLiveModelWindow(model, home), { window: 1_050_000, source: "codex-config-window" });
    useHome(t, home);
    // Pre-fix both lines clamped to 272_000 via the unknown-model fallback.
    assert.deepEqual(codexAlignedWindow(1_050_000, model, codex), { limit: 1_050_000, clamped: false, source: "codex-config-window" });
    assert.deepEqual(codexAlignedWindow(2_000_000, model, codex), { limit: 1_050_000, clamped: true, source: "codex-config-window" });
});

test("unreadable catalog path falls through to models_cache.json", (t) => {
    const home = fixture(t);
    writeCatalog(home, [{ slug: model, max_context_window: 800_000 }], "models_cache.json");
    fs.writeFileSync(path.join(home, "config.toml"), `model_catalog_json = "${path.join(home, "absent-catalog.json")}"\n`);
    useHome(t, home);
    assert.deepEqual(codexAlignedWindow(1_050_000, model, codex), { limit: 800_000, clamped: true, source: "codex-models-cache" });
});

test("a readable catalog is authority even when the model is absent from it — no fall-through to models_cache.json", (t) => {
    const home = fixture(t);
    writeCatalog(home, [{ slug: "some-other-model", max_context_window: 900_000 }], "model-catalog.json");
    writeCatalog(home, [{ slug: model, max_context_window: 800_000 }], "models_cache.json");
    fs.writeFileSync(path.join(home, "config.toml"), `model_catalog_json = "${path.join(home, "model-catalog.json")}"\n`);
    assert.equal(readCodexLiveModelWindow(model, home), undefined, "no table lists the model and no config window → unperceived");
    useHome(t, home);
    // gpt-6.1-sol is not in the shipped snapshot either → 272K fallback, NOT the 800K sitting in models_cache.json.
    assert.deepEqual(codexAlignedWindow(1_000_000, model, codex), { limit: 272_000, clamped: true, source: "codex-fallback" });
});

test("relative model_catalog_json resolves against $CODEX_HOME", (t) => {
    const home = fixture(t);
    writeCatalog(home, [{ slug: model, max_context_window: 800_000 }]);
    fs.writeFileSync(path.join(home, "config.toml"), `model_catalog_json = "model-catalog.json"\n`);
    assert.deepEqual(readCodexLiveModelWindow(model, home), { window: 800_000, source: "codex-catalog" });
});

test("explicit client metadata still outranks every file-backed source", (t) => {
    const home = fixture(t);
    const file = writeCatalog(home, [{ slug: model, context_window: 272_000, max_context_window: 872_000 }]);
    fs.writeFileSync(path.join(home, "config.toml"), `model_catalog_json = "${file}"\n`);
    useHome(t, home);
    assert.deepEqual(codexAlignedWindow(1_050_000, model, codex, 900_000), { limit: 900_000, clamped: true, source: "client-metadata" });
});

test("non-codex clients never gain a source field or a clamp", () => {
    assert.deepEqual(codexAlignedWindow(1_050_000, model, { "user-agent": "node-fetch/3.1" }), { limit: 1_050_000, clamped: false });
});

test("effective-view plumbing carries model_catalog_json (base wins per key, overlay beats base)", () => {
    const base: CodexConfig = { providers: {}, modelCatalogJson: "/base/catalog.json" };
    assert.equal(mergeCodexViews(base, { providers: {} }).modelCatalogJson, "/base/catalog.json");
    assert.equal(mergeCodexViews(base, { providers: {}, modelCatalogJson: "/overlay/catalog.json" }).modelCatalogJson, "/overlay/catalog.json");
    assert.equal(readCodexConfig(fixture({ after: () => {} })).modelCatalogJson, undefined, "no config.toml → field stays unset");
});
