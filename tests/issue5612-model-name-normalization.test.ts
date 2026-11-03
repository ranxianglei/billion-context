import { test } from "node:test";
import assert from "node:assert/strict";
import {
    canonicalModelKey,
    resolveModelEntry,
    resolveModelEntryOnRoute,
    resolveConfiguredContextLimit,
    resolveConfiguredOutputLimit,
    type ProviderRoutes,
} from "../src/config.ts";

// #5612: clients like Qoder Desktop rewrite model ids (/,.→-), so EXACT-name
// lookups miss the operator's declared entry → silent default fallback. Pinned in
// both directions: a renamed id resolves, and it never over-matches, clobbers an
// exact match, or guesses between two real models.

test("canonicalModelKey treats / . _ as interchangeable and is case-insensitive", () => {
    assert.equal(canonicalModelKey("auto/deepseek-v4.1-flash"), "auto-deepseek-v4-1-flash");
    assert.equal(canonicalModelKey("Auto/DeepSeek-V4.1-Flash"), "auto-deepseek-v4-1-flash");
    assert.equal(canonicalModelKey("a.b_c/d"), "a-b-c-d");
    assert.equal(canonicalModelKey("qoder-qfmodel"), "qoder-qfmodel");
});

test("the reported repro: renamed id resolves the operator's declared window", () => {
    const routes: ProviderRoutes = {
        "https://magpie.example": { models: { "auto/deepseek-v4.1-flash": { context: 1_000_000, output: 64_000 } } },
    };
    const url = "https://magpie.example/v1/chat/completions";
    // Before the fix both of these were undefined → 200K default fallback.
    assert.equal(resolveConfiguredContextLimit(routes, url, "auto-deepseek-v4-1-flash"), 1_000_000);
    assert.equal(resolveConfiguredOutputLimit(routes, url, "auto-deepseek-v4-1-flash"), 64_000);
    const r = resolveModelEntry(routes, url, "auto-deepseek-v4-1-flash");
    assert.equal(r.viaNormalization, true);
    assert.equal(r.declaredName, "auto/deepseek-v4.1-flash");
});

test("exact match still wins and is never flagged as normalized", () => {
    const routes: ProviderRoutes = { u: { models: { "gpt-5": { context: 400_000 } } } };
    const r = resolveModelEntry(routes, "u/v", "gpt-5");
    assert.equal(r.entry?.context, 400_000);
    assert.notEqual(r.viaNormalization, true);
    assert.equal(r.declaredName, undefined);
});

test("route-shaped variant shares the exact→normalized contract", () => {
    const route = { models: { "qoder/qfmodel": { context: 1_000_000 } } };
    const r = resolveModelEntryOnRoute(route, "qoder-qfmodel");
    assert.equal(r.entry?.context, 1_000_000);
    assert.equal(r.viaNormalization, true);
    assert.equal(r.declaredName, "qoder/qfmodel");
});

test("case-only difference resolves via normalization", () => {
    const routes: ProviderRoutes = { u: { models: { "GPT-4o": { context: 128_000 } } } };
    const r = resolveModelEntry(routes, "u/x", "gpt-4o");
    assert.equal(r.entry?.context, 128_000);
    assert.equal(r.viaNormalization, true);
});

test("two declared names sharing one canonical key stay an honest miss (never guess)", () => {
    const routes: ProviderRoutes = { u: { models: { "a/b": { context: 1 }, "a_b": { context: 2 } } } };
    // "a-b" matches neither name exactly, but its canonical key collides across both → refuse.
    assert.equal(resolveModelEntry(routes, "u/x", "a-b").entry, undefined);
    assert.equal(resolveConfiguredContextLimit(routes, "u/x", "a-b"), undefined);
});

test("a genuinely different id is not over-matched by the fallback", () => {
    const routes: ProviderRoutes = { u: { models: { "auto/foo-v1.2-bar": { context: 999 } } } };
    // extra trailing char is a real difference, not a separator rename → must miss
    assert.equal(resolveConfiguredContextLimit(routes, "u/x", "auto-foo-v1-2-barr"), undefined);
    assert.equal(resolveModelEntry(routes, "u/x", "totally-other").entry, undefined);
});

test("missing model / missing models table resolve to an empty result", () => {
    const routes: ProviderRoutes = { u: { models: { "m": { context: 1 } } } };
    assert.deepEqual(resolveModelEntry(routes, "u/x", undefined), {});
    assert.deepEqual(resolveModelEntry({ u: {} }, "u/x", "m"), {});
    assert.deepEqual(resolveModelEntry({}, "u/x", "m"), {});
});
