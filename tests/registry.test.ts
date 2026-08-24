import test from "node:test";
import assert from "node:assert/strict";
import { contextFromRegistry, peekRegistryContext, providerFromHost, _resetForTest, _setForTest } from "../src/registry.ts";

test("providerFromHost maps minimax domains", () => {
    assert.equal(providerFromHost("api.minimax.chat"), "minimax");
    assert.equal(providerFromHost("api.minimaxi.com"), "minimax");
    assert.equal(providerFromHost("api.minimax.io"), "minimax");
    assert.equal(providerFromHost("api.deepseek.com"), "deepseek");
});

test("providerFromHost boundary-safe: unrelated hosts do not match", () => {
    assert.equal(providerFromHost("api.minimax.evil.com"), undefined);
    assert.equal(providerFromHost("evil-minimax.chat"), undefined);
});

test("peekRegistryContext returns undefined with a cold cache (never fetches)", () => {
    _resetForTest();
    assert.equal(peekRegistryContext("MiniMax-M2.1", "api.minimax.chat"), undefined);
    assert.equal(peekRegistryContext("any-model"), undefined);
});

test("peekRegistryContext resolves provider-qualified keys from the warm cache", () => {
    _setForTest({
        "minimax/MiniMax-M2.1": { limit: { context: 204_800 } },
        "deepseek/deepseek-chat": { limit: { context: 1_000_000 } },
        "gpt-x": { limit: { context: 400_000 } },
    });
    assert.equal(peekRegistryContext("MiniMax-M2.1", "api.minimax.chat"), 204_800);
    assert.equal(peekRegistryContext("deepseek-chat", "api.deepseek.com"), 1_000_000);
    // Unknown host → bare model-name fallback still works.
    assert.equal(peekRegistryContext("gpt-x"), 400_000);
    // Known host but unlisted model → undefined (no bare-name hit).
    assert.equal(peekRegistryContext("deepseek-chat", "api.minimax.chat"), undefined);
});

test("contextFromRegistry resolves from the warm cache (same lookup, async)", async () => {
    _setForTest({ "minimax/MiniMax-M3": { limit: { context: 512_000 } } });
    assert.equal(await contextFromRegistry("MiniMax-M3", "api.minimax.chat"), 512_000);
});

test("registry entries without a usable context window are skipped", () => {
    _setForTest({
        "minimax/MiniMax-M0": {},
        "minimax/MiniMax-M0.5": { limit: {} },
        "minimax/MiniMax-M0.9": { limit: { context: 0 } },
    });
    assert.equal(peekRegistryContext("MiniMax-M0", "api.minimax.chat"), undefined);
    assert.equal(peekRegistryContext("MiniMax-M0.5", "api.minimax.chat"), undefined);
    assert.equal(peekRegistryContext("MiniMax-M0.9", "api.minimax.chat"), undefined);
});

test("_resetForTest clears the warm cache", () => {
    _setForTest({ "gpt-y": { limit: { context: 1 } } });
    assert.equal(peekRegistryContext("gpt-y"), 1);
    _resetForTest();
    assert.equal(peekRegistryContext("gpt-y"), undefined);
});
