import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// #2582: plugin tool-lane timeout — BILI_TOOL_TIMEOUT_MS > plugin.toolTimeoutMs > 600000.
// One compression round can legitimately run minutes (external-summary budget
// 300s total / 120s per target), so the historical hardcoded 60s killed
// slow-but-healthy folds client-side while the proxy kept executing.
// Env tier keeps the pre-migration envMillis parsing byte-exact: a SET env var
// (even empty/garbage) wins and finite positive values floor; anything else
// falls back to the default WITHOUT consulting the file tier.

const root = mkdtempSync(path.join(tmpdir(), "tool-timeout-"));
const cfgFile = path.join(root, "billion-context.json");

function setConfig(obj: unknown): void {
    writeFileSync(cfgFile, JSON.stringify(obj, null, 2), "utf8");
    process.env.BILI_CONFIG_FILE = cfgFile;
}
function clearConfig(): void {
    process.env.BILI_CONFIG_FILE = "/nonexistent/bili-tool-timeout-test-config.json";
}
function withEnv(vars: Record<string, string>, fn: () => void): void {
    const saved: [string, string | undefined][] = [];
    for (const [k, v] of Object.entries(vars)) { saved.push([k, process.env[k]]); process.env[k] = v; }
    try { fn(); } finally {
        for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

process.env.BILI_CONFIG_FILE = cfgFile;
const { toolTimeoutMs } = await import("../src/knobs.js");

test("tool timeout default is 600s — one compression round can legitimately run minutes", () => {
    clearConfig();
    assert.equal(toolTimeoutMs(), 600_000);
});

test("tool timeout: a finite positive env value wins (fractional floors)", () => {
    clearConfig();
    withEnv({ BILI_TOOL_TIMEOUT_MS: "120000" }, () => assert.equal(toolTimeoutMs(), 120_000));
    withEnv({ BILI_TOOL_TIMEOUT_MS: "60000" }, () => assert.equal(toolTimeoutMs(), 60_000));
    withEnv({ BILI_TOOL_TIMEOUT_MS: "30000.9" }, () => assert.equal(toolTimeoutMs(), 30_000));
});

test("tool timeout: blank/garbage/non-positive env falls back to the default, never the file tier", () => {
    setConfig({ plugin: { toolTimeoutMs: 123456 } });
    for (const bad of ["", "   ", "abc", "0", "-5", "NaN", "Infinity"]) {
        withEnv({ BILI_TOOL_TIMEOUT_MS: bad }, () =>
            assert.equal(toolTimeoutMs(), 600_000, `value ${JSON.stringify(bad)}`));
    }
});

test("tool timeout: file tier applies when no env var is set", () => {
    setConfig({ plugin: { toolTimeoutMs: 120000 } });
    assert.equal(toolTimeoutMs(), 120_000);
    setConfig({ plugin: { toolTimeoutMs: 30000.5 } });
    assert.equal(toolTimeoutMs(), 30_000);
});

test("tool timeout: garbage file values fall back to the default, never throw", () => {
    for (const bad of ["soon", -1, 0, null]) {
        setConfig({ plugin: { toolTimeoutMs: bad } });
        assert.equal(toolTimeoutMs(), 600_000, `value ${JSON.stringify(bad)}`);
    }
});

test("tool timeout: a valid env value beats the file tier", () => {
    setConfig({ plugin: { toolTimeoutMs: 120000 } });
    withEnv({ BILI_TOOL_TIMEOUT_MS: "45000" }, () => assert.equal(toolTimeoutMs(), 45_000));
});

test("cleanup", () => {
    delete process.env.BILI_CONFIG_FILE;
    rmSync(root, { recursive: true, force: true });
});
