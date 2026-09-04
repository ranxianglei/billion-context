import test from "node:test";
import assert from "node:assert/strict";
import { contextFromRegistry, peekRegistryContext, providerFromHost, newerFallback, bundledSnapshotLookup, bundledRegistryForTestsOnly, _resetForTest, _setForTest } from "../src/registry.ts";

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

test("unknown relay host falls back to provider-prefixed registry keys", () => {
    _setForTest({
        "deepseek/deepseek-v4-flash": { limit: { context: 1_000_000 } },
        "minimax/MiniMax-M2.1": { limit: { context: 204_800 } },
        "gpt-x": { limit: { context: 400_000 } },
    });
    // Relay host absent from HOST_TO_PROVIDER: bare name misses, but the
    // provider-prefixed key still resolves (issue #282).
    assert.equal(peekRegistryContext("deepseek-v4-flash", "freeinference.org"), 1_000_000);
    assert.equal(peekRegistryContext("MiniMax-M2.1", "some-relay.example"), 204_800);
    // No host at all triggers the same fallback scan.
    assert.equal(peekRegistryContext("deepseek-v4-flash"), 1_000_000);
    // A bare key, when present, still wins without scanning.
    assert.equal(peekRegistryContext("gpt-x", "freeinference.org"), 400_000);
});

test("conflicting provider-prefixed matches take the max window (no silent static fallback)", () => {
    _setForTest({
        "prov-a/ambig": { limit: { context: 100_000 } },
        "prov-b/ambig": { limit: { context: 200_000 } },
    });
    assert.equal(peekRegistryContext("ambig", "relay.example"), 200_000);
});

test("variant conflict takes max before falling through to the base name", () => {
    _setForTest({
        "prov-a/v-ambig-thinking": { limit: { context: 100_000 } },
        "prov-b/v-ambig-thinking": { limit: { context: 300_000 } },
        "prov-c/v-ambig": { limit: { context: 200_000 } },
    });
    assert.equal(peekRegistryContext("v-ambig-thinking", "relay.example"), 300_000);
});

test("relay fallback scan is slash-bounded (no partial-name matches)", () => {
    _setForTest({ "deepseek/deepseek-v4-flash": { limit: { context: 1_000_000 } } });
    assert.equal(peekRegistryContext("v4-flash", "relay.example"), undefined);
    assert.equal(peekRegistryContext("flash", "relay.example"), undefined);
});

test("known-provider host does not cross-provider scan on a miss", () => {
    _setForTest({ "deepseek/deepseek-chat": { limit: { context: 1_000_000 } } });
    assert.equal(peekRegistryContext("deepseek-chat", "api.minimax.chat"), undefined);
});

test("bundled snapshot resolves relay-style bare names via provider-prefixed keys", () => {
    // The exact #282 scenario: freeinference.org serving "deepseek-v4-flash",
    // which the registry stores only as "deepseek/deepseek-v4-flash" (1M).
    assert.equal(bundledSnapshotLookup("deepseek-v4-flash", "freeinference.org"), 1_000_000);
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

test("bundled snapshot ships real data and resolves known models", () => {
    // The committed snapshot must not be empty — it is the offline floor.
    const deepseek = bundledSnapshotLookup("deepseek-chat", "api.deepseek.com");
    assert.ok(typeof deepseek === "number" && deepseek >= 128_000, `deepseek-chat expected >=128k, got ${deepseek}`);
    const minimax = bundledSnapshotLookup("MiniMax-M2.1", "api.minimax.chat");
    assert.ok(typeof minimax === "number" && minimax >= 200_000, `MiniMax-M2.1 expected >=200k, got ${minimax}`);
    // Unknown model must miss (no bogus 200k-style guessing).
    assert.equal(bundledSnapshotLookup("totally-custom-model-x", "api.deepseek.com"), undefined);
});

test("bundled snapshot carries the FULL models.dev entry, not just context", () => {
    // The snapshot is the entire registry: future features (pricing,
    // modality checks, reasoning/tool_call flags) get the offline floor for
    // free. Guard against accidentally slimming it back down to numbers.
    const snap = (bundledRegistryForTestsOnly() ?? {}) as Record<string, { family?: unknown; reasoning?: unknown; tool_call?: unknown; limit?: { context?: unknown; output?: unknown } }>;
    const keys = Object.keys(snap);
    assert.ok(keys.length >= 350, `expected the full registry (>=350), got ${keys.length}`);
    let withFamily = 0;
    let withOutput = 0;
    let withBoolFlags = 0;
    for (const k of keys) {
        const e = snap[k];
        if (typeof e.family === "string") withFamily++;
        if (typeof e.limit?.output === "number") withOutput++;
        if (typeof e.reasoning === "boolean" && typeof e.tool_call === "boolean") withBoolFlags++;
    }
    assert.ok(withFamily >= 300, `family field missing on most entries (${withFamily}/${keys.length}) — snapshot slimmed?`);
    assert.ok(withOutput >= 300, `limit.output missing on most entries (${withOutput}/${keys.length}) — snapshot slimmed?`);
    assert.ok(withBoolFlags >= 300, `reasoning/tool_call booleans missing on most entries (${withBoolFlags}/${keys.length}) — snapshot slimmed?`);
});

test("newerFallback picks the newer source, tolerating missing sides", () => {
    const now = Date.now();
    assert.equal(newerFallback(now, now - 1000), "disk");
    assert.equal(newerFallback(now - 1000, now), "snapshot");
    assert.equal(newerFallback(now, now), "disk"); // tie → disk (already resident)
    assert.equal(newerFallback(undefined, now), "snapshot");
    assert.equal(newerFallback(now, 0), "disk");
    assert.equal(newerFallback(undefined, 0), "none");
});
