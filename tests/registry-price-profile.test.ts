import test from "node:test";
import assert from "node:assert/strict";
import { peekRegistryPriceProfile, providerFromHost, _resetForTest, _setForTest } from "../src/registry.ts";
import bundledSnapshot from "../src/registry-snapshot.json" with { type: "json" };

// #1279 follow-up: registry-derived default price profiles. The lookup is
// cache-only and sync (same residency contract as peekRegistryContext); unit
// here is ABSOLUTE $/Mtok, partial rows fall back to kernel conventions
// (r = 0.1×input, q = 1.5×input), and rows without a usable input price
// never yield a profile.

test("peekRegistryPriceProfile maps a full cost row to absolute $/Mtok", () => {
    _resetForTest();
    _setForTest({}, {
        "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3 },
    });
    assert.deepEqual(peekRegistryPriceProfile("claude-sonnet-4-5"), { w: 3, r: 0.3, q: 15 });
});

test("peekRegistryPriceProfile fills partial rows with kernel conventions", () => {
    _resetForTest();
    _setForTest({}, {
        "host-a/model-no-cache-read": { input: 2, output: 8 },
        "host-b/model-no-output": { input: 4, cache_read: 0.4 },
        "host-c/model-bare-input": { input: 6 },
    });
    assert.deepEqual(peekRegistryPriceProfile("model-no-cache-read"), { w: 2, r: 0.2, q: 8 });
    assert.deepEqual(peekRegistryPriceProfile("model-no-output"), { w: 4, r: 0.4, q: 6 });
    assert.deepEqual(peekRegistryPriceProfile("model-bare-input"), { w: 6, r: 0.6, q: 9 });
});

test("peekRegistryPriceProfile rejects rows without a usable input price", () => {
    _resetForTest();
    _setForTest({}, {
        "a/empty": {},
        "b/zero": { input: 0, output: 5 },
        "c/null": { input: null, output: 5 },
        "d/string": { input: "3", output: 5 },
        "e/negative": { input: -1, output: 5 },
    });
    assert.equal(peekRegistryPriceProfile("empty"), undefined);
    assert.equal(peekRegistryPriceProfile("zero"), undefined);
    assert.equal(peekRegistryPriceProfile("null"), undefined);
    assert.equal(peekRegistryPriceProfile("string"), undefined);
    assert.equal(peekRegistryPriceProfile("negative"), undefined);
});

test("peekRegistryPriceProfile cold cache returns undefined (never fetches)", () => {
    _resetForTest();
    assert.equal(peekRegistryPriceProfile("claude-sonnet-4-5", "api.anthropic.com"), undefined);
    assert.equal(peekRegistryPriceProfile(undefined), undefined);
});

test("known-provider host resolves its own listing before any cross-host scan", () => {
    _resetForTest();
    _setForTest({}, {
        "deepinfra/claude-haiku-4-5": { input: 0.5, output: 2.5, cache_read: 0.05 },
        "anthropic/claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1 },
    });
    assert.ok(providerFromHost("api.anthropic.com") === "anthropic");
    assert.deepEqual(peekRegistryPriceProfile("claude-haiku-4-5", "api.anthropic.com"), { w: 1, r: 0.1, q: 5 });
});

test("unknown relay takes the first listing in key order (deterministic per snapshot)", () => {
    _resetForTest();
    _setForTest({}, {
        "aaa/deepseek/deepseek-v4-flash": { input: 0.15, output: 0.6, cache_read: 0.003 },
        "zzz/deepseek/deepseek-v4-flash": { input: 1.04, output: 4.16, cache_read: 0.1 },
    });
    assert.deepEqual(peekRegistryPriceProfile("deepseek/deepseek-v4-flash"), { w: 0.15, r: 0.003, q: 0.6 });
    // full-id request also matches via its bare-name root after the exact miss
    assert.deepEqual(peekRegistryPriceProfile("deepseek-v4-flash"), { w: 0.15, r: 0.003, q: 0.6 });
});

test("unlisted model yields undefined (stamp site then keeps kernel defaults)", () => {
    _resetForTest();
    _setForTest({}, { "anthropic/claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1 } });
    assert.equal(peekRegistryPriceProfile("totally-unlisted-model-xyz"), undefined);
});

test("bundled snapshot ships cost rows so the offline floor exercises pricing", () => {
    const snap = bundledSnapshot as { count?: unknown; models?: Record<string, unknown>; costs?: Record<string, { input?: unknown; output?: unknown }> };
    assert.ok(snap.costs && Object.keys(snap.costs).length > 0, "snapshot carries a costs map");
    const anthropicKeys = Object.keys(snap.costs).filter((k) => k.startsWith("anthropic/"));
    assert.ok(anthropicKeys.length >= 1, "an anthropic model carries pricing in the offline floor");
    for (const key of anthropicKeys.slice(0, 5)) {
        const row = snap.costs[key];
        assert.equal(typeof row.input, "number");
        assert.ok((row.input as number) > 0, `${key} has a usable input price`);
    }
    assert.equal(typeof snap.count, "number");
    assert.equal(Object.keys(snap.models ?? {}).length, snap.count);
});
