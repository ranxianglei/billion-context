import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultCountTokens,
  estimateTokensFast,
  createBpeTokenizer,
} from "../src/tokenize.js";

test("estimateTokensFast: chars/4 ratio", () => {
  assert.equal(estimateTokensFast(""), 0);
  assert.equal(estimateTokensFast("hello world!"), 3);
  assert.equal(estimateTokensFast("a".repeat(100)), 25);
  assert.equal(estimateTokensFast("你好世界测试"), 2);
});

test("defaultCountTokens: English + code via chars/4", () => {
  assert.equal(defaultCountTokens(""), 0);
  // "hello world": 11 non-CJK chars → ceil(11/4) = 3
  assert.equal(defaultCountTokens("hello world"), 3);
  // "function test_fn() {}": 21 non-CJK chars → ceil(21/4) = 6 (symbols now count)
  assert.equal(defaultCountTokens("function test_fn() {}"), 6);
  assert.equal(defaultCountTokens("camelCase snake_case kebab-case"), 8);
});

test("defaultCountTokens: CJK character counting", () => {
  assert.equal(defaultCountTokens("你好世界"), 4);
  assert.equal(defaultCountTokens("こんにちは"), 5);
  assert.equal(defaultCountTokens("안녕하세요"), 5);
});

test("defaultCountTokens: digits and symbols are counted", () => {
  // Old impl dropped digits/symbols to zero; chars/4 covers them now.
  assert.ok(defaultCountTokens("12345 67890") > 0);
  assert.ok(defaultCountTokens("{ } ( ) [ ] = + - * /") > 0);
  assert.equal(defaultCountTokens("x = 1"), 2);
});

test("createBpeTokenizer: falls back when @anthropic-ai/tokenizer not installed", () => {
  const tokenizer = createBpeTokenizer();
  assert.equal(typeof tokenizer, "function");
  const count = tokenizer("hello world");
  assert.ok(count > 0, "fallback should still return positive counts");
  assert.equal(count, defaultCountTokens("hello world"));
});

test("createBpeTokenizer: fallback handles empty text", () => {
  const tokenizer = createBpeTokenizer();
  assert.equal(tokenizer(""), 0);
});

test("createBpeTokenizer: fallback handles CJK", () => {
  const tokenizer = createBpeTokenizer();
  const count = tokenizer("你好世界");
  assert.equal(count, 4);
});

test("defaultCountTokens: mixed ASCII + CJK", () => {
  // 4 CJK chars (1 each) + 13 non-CJK chars → ceil(13/4) = 4 → 8 total
  const count = defaultCountTokens("hello 你好 world 世界");
  assert.equal(count, 8);
});

test("TokenCountFn type is compatible with createCore ports", () => {
  const tokenizer: (text: string) => number = createBpeTokenizer();
  const fast: (text: string) => number = estimateTokensFast;
  const word: (text: string) => number = defaultCountTokens;

  for (const fn of [tokenizer, fast, word]) {
    assert.equal(typeof fn, "function");
    assert.ok(fn("test") >= 0);
  }
});
