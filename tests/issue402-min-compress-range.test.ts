import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, type Config } from "acp-kernel";
import { applyCompressSettings, mergeCompress, resolveCompress } from "../src/compress-settings.ts";
import { parseCompressSettings, type ProviderRoutes } from "../src/config.ts";
import { _resetForTest, _setForTest, peekRegistryContext } from "../src/registry.ts";

// #2514 flipped the canonical name back to minCompressRange (unit: tokens);
// minCompressRangeChars survives as the deprecated alias. These tests pin the
// alias-resolution ordering under that arrangement.

test("mergeCompress: same level, both keys set — canonical minCompressRange wins", () => {
    const merged = mergeCompress(undefined, undefined, { minCompressRange: 1111, minCompressRangeChars: 2222 });
    assert.equal(merged.minCompressRange, 1111);
});

test("mergeCompress: deprecated alias at a deeper level beats canonical name at a shallower level", () => {
    const merged = mergeCompress({ minCompressRange: 9999 }, undefined, { minCompressRangeChars: 3333 });
    assert.equal(merged.minCompressRange, 3333);
});

test("mergeCompress: output is normalized — deprecated key never appears in the merged result", () => {
    const merged = mergeCompress({ minCompressRangeChars: 777 }, undefined, undefined);
    assert.equal(merged.minCompressRange, 777);
    assert.equal(merged.minCompressRangeChars, undefined);
});

test("applyCompressSettings: minCompressRange maps onto kernel compress.minCompressRange; alias still accepted", () => {
    const out = applyCompressSettings((defaultConfig as (limit?: number) => Config)(), 200000, { minCompressRange: 20000 });
    assert.equal(out.compress.minCompressRange, 20000);
    const alias = applyCompressSettings((defaultConfig as (limit?: number) => Config)(), 200000, { minCompressRangeChars: 7000 });
    assert.equal(alias.compress.minCompressRange, 7000);
});

test("parseCompressSettings: both keys validate and round-trip independently", () => {
    const parsed = parseCompressSettings({ minCompressRange: 1000, minCompressRangeChars: 2000 });
    assert.ok(parsed);
    assert.equal(parsed.minCompressRange, 1000);
    assert.equal(parsed.minCompressRangeChars, 2000);
    assert.equal(parseCompressSettings({ minCompressRangeChars: "x" }), undefined);
});

test("resolveCompress: model-level canonical key overrides global deprecated alias", () => {
    const routes: ProviderRoutes = {
        "https://api.example.com": {
            models: { "big-model": { compress: { minCompressRange: 12345 } } },
        },
    };
    const merged = resolveCompress(routes, "https://api.example.com/v1/chat", "big-model", { minCompressRangeChars: 99 });
    assert.equal(merged.minCompressRange, 12345);
});

test("registry relay-suffix conflict: max window wins instead of silent undefined", () => {
    _resetForTest();
    _setForTest({
        "deepseek/clash": { limit: { context: 64000 } },
        "moonshot/clash": { limit: { context: 131072 } },
        "unrelated": { limit: { context: 999999 } },
    });
    assert.equal(peekRegistryContext("clash"), 131072);
    _setForTest({
        "deepseek/agreed": { limit: { context: 64000 } },
        "moonshot/agreed": { limit: { context: 64000 } },
    });
    assert.equal(peekRegistryContext("agreed"), 64000);
    _setForTest({ "deepseek/none": { limit: { context: -1 } } });
    assert.equal(peekRegistryContext("none"), undefined);
    _resetForTest();
});
