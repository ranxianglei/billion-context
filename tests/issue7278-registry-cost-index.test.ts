import test from "node:test";
import assert from "node:assert/strict";
import { _resetForTest, _setForTest, scanRegistryCostRow, type CostsShape } from "../src/registry.ts";

// #7278: the billing path scans TWO cost tables per lookup (the overrides
// table, then the registry fallback). The single-slot index cache evicted one
// on the other, so an overrides-miss lookup rebuilt the (large) registry cost
// index on EVERY call — O(registry rows) per lookup. The fix caps the index
// cache at the two tables that flow through the path and evicts the
// least-recently-used, so the registry index is built once and reused.
//
// Counting builds without production scaffolding: buildLowerKeyIndex calls
// Object.entries(table), which invokes the table's [[OwnPropertyKeys]] (the
// Proxy `ownKeys` trap) exactly once per build. A direct `table[key]` exact-
// key hit and the suffix scan (which iterates the prebuilt index, not the
// table) do NOT touch ownKeys — so the count is index builds, not lookups.

function makeCostTable(rows: number): CostsShape {
    const t: CostsShape = {};
    for (let i = 0; i < rows; i++) t[`model-${i}`] = { input: 1 };
    return t;
}

test("#7278 registry cost index is built once across overrides-miss lookups", () => {
    _resetForTest();
    let registryBuilds = 0;
    const registry = new Proxy(makeCostTable(4000), {
        ownKeys(t) {
            registryBuilds++;
            return Reflect.ownKeys(t);
        },
    });
    const overrides = makeCostTable(10);
    _setForTest({}, registry);

    const model = "absent-model";
    for (let i = 0; i < 50; i++) {
        scanRegistryCostRow(overrides, model); // overrides-miss
        scanRegistryCostRow(registry, model); // registry fallback (miss)
    }
    // The registry table's index must be built ONCE (then reused), not rebuilt
    // on every overrides-miss lookup (50× with the old single-slot cache).
    assert.equal(registryBuilds, 1, `registry cost index rebuilt ${registryBuilds}× across 50 overrides-miss lookups (expected 1)`);
});

test("#7278 both cost tables stay cached when their identities are stable", () => {
    _resetForTest();
    let registryBuilds = 0;
    let overridesBuilds = 0;
    const registry = new Proxy(makeCostTable(4000), {
        ownKeys(t) {
            registryBuilds++;
            return Reflect.ownKeys(t);
        },
    });
    const overrides = new Proxy(makeCostTable(10), {
        ownKeys(t) {
            overridesBuilds++;
            return Reflect.ownKeys(t);
        },
    });
    _setForTest({}, registry);

    const model = "absent-model";
    for (let i = 0; i < 50; i++) {
        scanRegistryCostRow(overrides, model);
        scanRegistryCostRow(registry, model);
    }
    // With stable table identities (the #7276 shape), BOTH indexes are built
    // exactly once and reused — no thrash at all.
    assert.equal(registryBuilds, 1, `registry index rebuilt ${registryBuilds}× (expected 1)`);
    assert.equal(overridesBuilds, 1, `overrides index rebuilt ${overridesBuilds}× (expected 1)`);
});

test("#7278 registry index stays hot when the overrides table is a fresh identity per lookup (real pre-#7276 path; pins LRU over FIFO)", () => {
    _resetForTest();
    let registryBuilds = 0;
    const registry = new Proxy(makeCostTable(4000), {
        ownKeys(t) {
            registryBuilds++;
            return Reflect.ownKeys(t);
        },
    });
    _setForTest({}, registry);

    const model = "absent-model";
    for (let i = 0; i < 50; i++) {
        // overrideCosts() hands scanRegistryCostRow a brand-new table identity on
        // every lookup (the pre-#7276 path); the registry (costCache) is the same
        // object throughout. The LRU must keep the stable registry index hot and
        // evict the throwaway overrides indexes — a FIFO cache would evict the
        // registry every other lookup and rebuild it (25× here), so this pins the
        // recency-refresh the stable-identity test above cannot see.
        scanRegistryCostRow(makeCostTable(10), model); // fresh overrides, miss
        scanRegistryCostRow(registry, model); // stable registry fallback
    }
    assert.equal(registryBuilds, 1, `registry index rebuilt ${registryBuilds}× with a fresh overrides identity per lookup (expected 1 — LRU must keep the stable table hot; a FIFO cache evicts it every other lookup)`);
});

test("#7278 the cache still resolves a registry hit correctly (Proxy does not break lookup)", () => {
    _resetForTest();
    const registry: CostsShape = { "host-a/present-model": { input: 2, output: 8 } };
    const overrides = makeCostTable(10);
    _setForTest({}, registry);
    // The resolveBillingPrice path: overrides-miss, then registry-hit.
    const miss = scanRegistryCostRow(overrides, "present-model");
    assert.equal(miss, undefined, "overrides-miss for a registry-only model");
    const hit = scanRegistryCostRow(registry, "present-model");
    assert.ok(hit, "registry hit resolves");
    assert.equal(hit.key, "host-a/present-model");
    assert.equal(hit.row.input, 2);
    // A second lookup reuses the cached index and still resolves.
    const hit2 = scanRegistryCostRow(registry, "present-model");
    assert.ok(hit2 && hit2.row.input === 2, "second lookup still resolves");
});
