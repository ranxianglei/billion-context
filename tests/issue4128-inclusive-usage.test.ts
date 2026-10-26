import { test } from "node:test";
import assert from "node:assert/strict";
import { usageTotals, promptInputTotal, declaredInclusiveFromUsage } from "../src/util.ts";
import { usageFromSseEvent, mergeUsageSample, type UsageSample } from "../src/plugin.ts";

// #4128: an anthropic-WIRE relay forwarding to an OpenAI-chat backend reports
// input_tokens INCLUSIVE (it already contains cache_read) instead of Anthropic's
// SPLIT semantics (input_tokens = fresh-only). The old code treated every
// anthropic-lane report as split (total = input + read + creation) and
// double-counted the cache, halving the reported cache-hit rate and inflating
// lastInputTokens / context estimates / nudge meter / fold economics.
//
// The fix keys off ONE authoritative signal: usage.billing_usage.semantic ===
// "openai" (the relay declares its own semantics). We deliberately do NOT infer
// inclusiveness from the token numbers: per-object, `input >= cached` cannot
// distinguish an inclusive relay from a genuine Anthropic turn whose fresh input
// happens to exceed the cached prefix, so a numeric heuristic would silently
// under-count real Anthropic traffic (the #793 suite pins exactly that shape).
// Without an explicit stamp the anthropic lane keeps split semantics — identical
// to pre-fix behavior for everyone who does not stamp.

test("usageTotals: anthropic lane + billing_usage.semantic=openai → inclusive (no double count)", () => {
    const { total, cached } = usageTotals("anthropic", {
        input_tokens: 115756,
        cache_read_input_tokens: 109764,
        cache_creation_input_tokens: 0,
        billing_usage: { source: "oai_chat", semantic: "openai", openai_usage: { prompt_tokens: 115756 } },
    });
    assert.equal(cached, 109764);
    assert.equal(total, 115756); // NOT 225520 — relay's input already includes the cache
});

test("usageTotals: anthropic lane + billing_usage.semantic=anthropic → explicit stamp keeps split", () => {
    const { total, cached } = usageTotals("anthropic", {
        input_tokens: 55,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 3,
        billing_usage: { semantic: "anthropic" },
    });
    assert.equal(cached, 11);
    assert.equal(total, 55 + 11 + 3); // 69
});

test("usageTotals: anthropic lane UNstamped keeps split even when input >= cached (no numeric inference)", () => {
    // A genuine Anthropic turn can legitimately report fresh input larger than the
    // cached prefix with no cache write — this is indistinguishable from an
    // inclusive relay by the numbers alone, so we must NOT infer inclusiveness here.
    const { total, cached } = usageTotals("anthropic", {
        input_tokens: 83335,
        cache_read_input_tokens: 83200,
        cache_creation_input_tokens: 0,
    });
    assert.equal(cached, 83200);
    assert.equal(total, 83335 + 83200); // split — no stamp, so fresh + prefix
});

test("usageTotals: anthropic lane UNstamped, input<cached → split", () => {
    const { total, cached } = usageTotals("anthropic", {
        input_tokens: 6,
        cache_read_input_tokens: 26278,
        cache_creation_input_tokens: 0,
    });
    assert.equal(cached, 26278);
    assert.equal(total, 6 + 26278); // 26284
});

test("usageTotals: anthropic lane UNstamped with cache-write → split", () => {
    const { total, cached } = usageTotals("anthropic", {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 7,
    });
    assert.equal(cached, 50);
    assert.equal(total, 100 + 50 + 7); // 157
});

test("promptInputTotal: declaredInclusive=true forces inclusive on the anthropic protocol", () => {
    assert.equal(promptInputTotal("anthropic", 115756, 109764, 0, true), 115756);
});

test("promptInputTotal: declaredInclusive false / undefined both keep split on the anthropic protocol", () => {
    assert.equal(promptInputTotal("anthropic", 83335, 83200, 0, false), 83335 + 83200);
    assert.equal(promptInputTotal("anthropic", 83335, 83200, 0), 83335 + 83200);
    assert.equal(promptInputTotal("anthropic", 6, 26278, 0), 6 + 26278);
});

test("promptInputTotal: openai/responses lanes are unaffected by the declaration param", () => {
    // Already-inclusive wires stay inclusive whether or not a declaration is passed.
    assert.equal(promptInputTotal("openai", 1000, 900), 1000);
    assert.equal(promptInputTotal("openai", 1000, 900, undefined, true), 1000);
    assert.equal(promptInputTotal("responses", 1000, 900, undefined, false), 1000);
});

test("declaredInclusiveFromUsage: only recognises a well-formed relay stamp", () => {
    assert.equal(declaredInclusiveFromUsage({ billing_usage: { semantic: "openai" } }), true);
    assert.equal(declaredInclusiveFromUsage({ billing_usage: { semantic: "anthropic" } }), false);
    assert.equal(declaredInclusiveFromUsage({ billing_usage: { openai_usage: { prompt_tokens: 115756 } } }), true);
    assert.equal(declaredInclusiveFromUsage({ billing_usage: {} }), undefined);
    assert.equal(declaredInclusiveFromUsage({ billing_usage: null }), undefined);
    assert.equal(declaredInclusiveFromUsage({}), undefined);
});

test("usageFromSseEvent: message_start carries the relay's billing_usage declaration", () => {
    const s = usageFromSseEvent({
        type: "message_start",
        message: {
            usage: {
                input_tokens: 128904,
                cache_read_input_tokens: 109764,
                cache_creation_input_tokens: 0,
                billing_usage: { source: "oai_chat", semantic: "openai", openai_usage: { prompt_tokens: 128904 } },
            },
        },
    });
    assert.equal(s?.inputTokens, 128904);
    assert.equal(s?.cachedTokens, 109764);
    assert.equal(s?.declaredInclusive, true);
});

test("usageFromSseEvent: message_delta carries the declaration too; unstamped frames leave it undefined", () => {
    const d = usageFromSseEvent({
        type: "message_delta",
        usage: { input_tokens: 63513, cache_read_input_tokens: 109764, output_tokens: 512, billing_usage: { semantic: "openai" } },
    });
    assert.equal(d?.declaredInclusive, true);
    assert.equal(d?.inputTokens, 63513); // captured verbatim; frame-preference happens in merge

    const p = usageFromSseEvent({
        type: "message_start",
        message: { usage: { input_tokens: 55, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 } },
    });
    assert.equal(p?.declaredInclusive, undefined);
});

test("mergeUsageSample: keeps the larger authoritative input against an undersized relay echo", () => {
    // message_start reported the true total; a later delta echoes a smaller partial
    // input after the cache was established → do not shrink lastInputTokens.
    const acc: UsageSample = { inputTokens: 128904, cachedTokens: 109764 };
    mergeUsageSample(acc, { inputTokens: 63513, cachedTokens: 109764 });
    assert.equal(acc.inputTokens, 128904);
    assert.equal(acc.cachedTokens, 109764);
});

test("mergeUsageSample: overwrite proceeds normally when no cache is established yet", () => {
    const a: UsageSample = { inputTokens: 100, cachedTokens: 0 };
    mergeUsageSample(a, { inputTokens: 500 });
    assert.equal(a.inputTokens, 500);
});

test("mergeUsageSample: shrink guard is gated on a positive cache (no cache → plain overwrite)", () => {
    const b: UsageSample = { inputTokens: 1000 }; // no cachedTokens
    mergeUsageSample(b, { inputTokens: 400 });
    assert.equal(b.inputTokens, 400);
});

test("mergeUsageSample: a carried declaration persists across later non-declaring frames", () => {
    const c: UsageSample = {};
    mergeUsageSample(c, { declaredInclusive: true, inputTokens: 10 });
    assert.equal(c.declaredInclusive, true);
    mergeUsageSample(c, { inputTokens: 20 });
    assert.equal(c.declaredInclusive, true);
    assert.equal(c.inputTokens, 20);
});
