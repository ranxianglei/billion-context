import { test } from "node:test";
import assert from "node:assert/strict";
import { usageTotals } from "../src/util.ts";

// Regression guard for the cross-protocol cache-accounting bug: the previous
// code computed `prompt + cached` uniformly, which is only correct for
// Anthropic (where cached is reported separately). For OpenAI/Responses the
// reported input total ALREADY includes the cached subset, so adding it again
// double-counted the cached tokens — inflating the context size (→ premature
// compression) and deflating the reported cache-hit rate.

test("usageTotals: Anthropic — input_tokens is NEW-only; total = new + read + creation", () => {
    const { total, cached } = usageTotals("anthropic", {
        input_tokens: 55,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 3,
    });
    assert.equal(cached, 11);
    assert.equal(total, 55 + 11 + 3); // 69
});

test("usageTotals: Anthropic — no cache fields, total = input_tokens", () => {
    const { total, cached } = usageTotals("anthropic", { input_tokens: 40 });
    assert.equal(cached, undefined);
    assert.equal(total, 40);
});

test("usageTotals: OpenAI — prompt_tokens is the TOTAL (already includes cached)", () => {
    const { total, cached } = usageTotals("openai", {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 900 },
    });
    assert.equal(cached, 900);
    assert.equal(total, 1000); // NOT 1900 — no double count
});

test("usageTotals: Responses — input_tokens is the TOTAL (already includes cached)", () => {
    const { total, cached } = usageTotals("responses", {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 900 },
    });
    assert.equal(cached, 900);
    assert.equal(total, 1000); // NOT 1900 — no double count
});

test("usageTotals: empty usage → undefined total", () => {
    assert.equal(usageTotals("openai", {}).total, undefined);
    assert.equal(usageTotals("anthropic", {}).total, undefined);
});
