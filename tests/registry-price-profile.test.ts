import test from "node:test";
import assert from "node:assert/strict";
import { peekRegistryCostRow, peekRegistryPriceProfile, providerFromHost, _resetForTest, _setForTest } from "../src/registry.ts";
import bundledSnapshot from "../src/registry-snapshot.json" with { type: "json" };

// #1279 follow-up: registry-derived default price profiles. The lookup is
// cache-only and sync (same residency contract as peekRegistryContext); unit
// here is ABSOLUTE $/Mtok, partial rows fall back to kernel conventions
// (r = 0.1×w, q = 4×w — kernel default ratios), and rows without a usable input price
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
    assert.deepEqual(peekRegistryPriceProfile("model-no-output"), { w: 4, r: 0.4, q: 16 });
    assert.deepEqual(peekRegistryPriceProfile("model-bare-input"), { w: 6, r: 0.6, q: 24 });
});

test("peekRegistryPriceProfile prices w from cache_write when the provider charges a write premium", () => {
    _resetForTest();
    _setForTest({}, {
        // Kernel contract: (w−r)·T prices the cache-WRITE re-upload — Anthropic
        // carries cache_write ≈ 1.25× input; dropping it understates fold cost.
        "anthropic/claude-sonnet-4-5": { input: 3, cache_write: 3.75, cache_read: 0.3, output: 15 },
        // No premium → w falls back to input.
        "host-x/model-no-write-premium": { input: 3, cache_read: 0.3, output: 15 },
        // Unusable cache_write (zero/negative/non-finite) → input, never garbage.
        "host-y/model-broken-write": { input: 3, cache_write: 0, cache_read: 0.3, output: 15 },
    });
    assert.deepEqual(peekRegistryPriceProfile("claude-sonnet-4-5"), { w: 3.75, r: 0.3, q: 15 });
    assert.deepEqual(peekRegistryPriceProfile("model-no-write-premium"), { w: 3, r: 0.3, q: 15 });
    assert.deepEqual(peekRegistryPriceProfile("model-broken-write"), { w: 3, r: 0.3, q: 15 });
});

test("peekRegistryPriceProfile rejects rows without a usable input price", () => {
    _resetForTest();
    const badRows = {
        "a/empty": {},
        "b/zero": { input: 0, output: 5 },
        "c/null": { input: null, output: 5 },
        "d/string": { input: "3", output: 5 },
        "e/negative": { input: -1, output: 5 },
    };
    _setForTest({}, badRows as unknown as Parameters<typeof _setForTest>[1]);
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

test("peekRegistryCostRow returns the raw $/Mtok row with the winning catalog key (#2478)", () => {
    _resetForTest();
    _setForTest({}, {
        "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        "host-b/model-no-output": { input: 4, cache_read: 0.4 },
        "host-c/model-bare-input": { input: 6 },
    });
    assert.deepEqual(peekRegistryCostRow("claude-sonnet-4-5"), {
        key: "anthropic/claude-sonnet-4-5",
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
    });
    // Optional price parts are omitted (not zero) when models.dev lists none.
    assert.deepEqual(peekRegistryCostRow("model-no-output"), { key: "host-b/model-no-output", input: 4, cacheRead: 0.4 });
    assert.deepEqual(peekRegistryCostRow("model-bare-input"), { key: "host-c/model-bare-input", input: 6 });
});

test("peekRegistryCostRow shares name resolution with the profile lookup (#2478)", () => {
    _resetForTest();
    _setForTest({}, {
        "deepinfra/claude-haiku-4-5": { input: 0.5, output: 2.5 },
        "anthropic/claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1 },
        "aaa/dual/model-x": { input: 0.15, output: 0.6 },
        "zzz/dual/model-x": { input: 1.04, output: 4.16 },
    });
    // Known-provider host wins its own listing — same row as the profile path.
    const own = peekRegistryCostRow("claude-haiku-4-5", "api.anthropic.com")!;
    assert.equal(own.key, "anthropic/claude-haiku-4-5");
    assert.equal(own.input, 1);
    // Unknown relay → first listing in key order; key + input stay consistent
    // with the profile stamped from the very same row.
    const relay = peekRegistryCostRow("dual/model-x")!;
    assert.equal(relay.key, "aaa/dual/model-x");
    assert.equal(relay.input, 0.15);
    assert.deepEqual(peekRegistryPriceProfile("dual/model-x"), { w: 0.15, r: 0.015, q: 0.6 });
    // Unresolvable model and cold cache → undefined on both lanes.
    assert.equal(peekRegistryCostRow("totally-unlisted-model-xyz"), undefined);
    _resetForTest();
    assert.equal(peekRegistryCostRow("claude-sonnet-4-5"), undefined);
});

test("price lookup is case-insensitive like the window lookup (same mechanism, #2074)", () => {
    _resetForTest();
    _setForTest({}, {
        "minimax/MiniMax-M3": { input: 3, output: 12 },
        "tencent/HY3": { input: 0.4, output: 1.6 },
    });
    // Exact-key branch (known-provider host): probe case differs from the roster key.
    assert.deepEqual(peekRegistryPriceProfile("minimax-m3", "api.minimax.chat"), { w: 3, r: 0.3, q: 12 });
    // Relay scan branch: same folding.
    assert.deepEqual(peekRegistryPriceProfile("hy3"), { w: 0.4, r: 0.04, q: 1.6 });
    // Byte-exact keys still resolve identically (no precedence shift).
    assert.deepEqual(peekRegistryPriceProfile("MiniMax-M3", "api.minimax.chat"), { w: 3, r: 0.3, q: 12 });
});

test("bundled snapshot ships cost rows so the offline floor exercises pricing", () => {
    const snap = bundledSnapshot as { count?: unknown; models?: Record<string, unknown>; costs?: Record<string, { input?: unknown; output?: unknown }> };
    assert.ok(snap.costs && Object.keys(snap.costs).length > 0, "snapshot carries a costs map");
    const anthropicKeys = Object.keys(snap.costs).filter((k) => k.startsWith("anthropic/"));
    assert.ok(anthropicKeys.length >= 1, "an anthropic model carries pricing in the offline floor");
    for (const key of anthropicKeys.slice(0, 5)) {
        const row = snap.costs[key] as { input?: unknown; output?: unknown };
        assert.equal(typeof row.input, "number");
        assert.ok((row.input as number) > 0, `${key} has a usable input price`);
    }
    assert.equal(typeof snap.count, "number");
    assert.equal(Object.keys(snap.models ?? {}).length, snap.count);
});
