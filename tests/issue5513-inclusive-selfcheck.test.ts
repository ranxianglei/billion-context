import { test } from "node:test";
import assert from "node:assert/strict";
import { promptInputTotal, usageTotals } from "../src/util.ts";

// #5513: refines the #4128 inclusive-declaration decision with a self-consistency
// guard. #4128 trusts an explicit `billing_usage.semantic="openai"` stamp on the
// anthropic lane (input INCLUSIVE of cache_read) and deliberately does NOT infer
// inclusiveness from the numbers. But it trusted the stamp unconditionally — and a
// DeepSeek-backed anthropic-WIRE relay reports Anthropic-split numbers (fresh-only
// input_tokens + separate cache_read) while STILL stamping semantic="openai". With
// input < cached the inclusive claim is self-refuting (an inclusive input contains
// its cache-read subset, so it can never be smaller than it); trusting it there
// under-counted the total and divided the cached segment out of it, producing
// 1796–6991% "cache hit" rates (and an under-counted nudge meter). The guard
// distrusts the flip exactly when input < cached; a genuine inclusive relay always
// has input >= cached, so correct traffic is untouched (#4128 cases stay green).

test("#5513: self-contradictory inclusive stamp (input<cached) reverts to split", () => {
    // The exact shape from the field log: input_tokens=1062 (fresh-only),
    // cache_read_input_tokens=74240, stamped semantic="openai". Pre-fix total=1062
    // → hit rate 74240/1062 ≈ 6991%. Post-fix the cached segment is added back.
    assert.equal(promptInputTotal("anthropic", 1062, 74240, undefined, true), 1062 + 74240);
    // A normalized total can never sit below its own cached subset.
    const t = promptInputTotal("anthropic", 1062, 74240, undefined, true);
    assert.ok(t >= 74240);
});

test("#5513: self-contradictory inclusive stamp with a cache-write piece stays fully split", () => {
    // Under the reverted split semantics the Anthropic cache-write segment is also
    // additive (total = input + read + creation).
    assert.equal(promptInputTotal("anthropic", 1062, 74240, 5, true), 1062 + 74240 + 5);
});

test("#5513: legitimate inclusive relay (input>=cached) is unchanged", () => {
    // Strictly greater — the #4128 canonical case: no add-back.
    assert.equal(promptInputTotal("anthropic", 115756, 109764, 0, true), 115756);
    // Boundary: an inclusive input may EQUAL its cached subset; still inclusive.
    assert.equal(promptInputTotal("anthropic", 300, 300, 0, true), 300);
});

test("#5513: unstamped anthropic lane keeps split regardless of the guard", () => {
    // No declaration → split via baseSplit, exactly as before the change.
    assert.equal(promptInputTotal("anthropic", 1062, 74240), 1062 + 74240);
    assert.equal(promptInputTotal("anthropic", 83335, 83200, 0), 83335 + 83200);
});

test("#5513: non-anthropic lanes ignore the guard (already numeric-checked)", () => {
    // OpenAI-wire split-shape reports (prompt_tokens fresh-only, cached separate):
    // baseSplit already adds the cached back whether or not a declaration rides along.
    assert.equal(promptInputTotal("openai", 1062, 74240, undefined, true), 1062 + 74240);
    assert.equal(promptInputTotal("responses", 1062, 74240, undefined, true), 1062 + 74240);
});

test("#5513: usageTotals end-to-end — DeepSeek-shaped anthropic wire no longer under-counts", () => {
    const { total, cached } = usageTotals("anthropic", {
        input_tokens: 1062,
        cache_read_input_tokens: 74240,
        cache_creation_input_tokens: 0,
        billing_usage: { source: "oai_chat", semantic: "openai" },
    });
    assert.equal(cached, 74240);
    assert.equal(total, 1062 + 74240); // 75302, NOT 1062
});

test("#5513: usageTotals end-to-end — genuine inclusive relay unaffected", () => {
    const { total, cached } = usageTotals("anthropic", {
        input_tokens: 115756,
        cache_read_input_tokens: 109764,
        cache_creation_input_tokens: 0,
        billing_usage: { source: "oai_chat", semantic: "openai", openai_usage: { prompt_tokens: 115756 } },
    });
    assert.equal(cached, 109764);
    assert.equal(total, 115756); // inclusive: input already includes the cache
});
