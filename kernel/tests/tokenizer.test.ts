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

// #4315: every Han ideograph bills 1 token per CHARACTER (code point), in every
// extension block, and the chars/4 remainder is computed on CODE UNITS so a
// supplementary-plane match (2 UTF-16 units) is never double-counted.
test("defaultCountTokens: Han coverage across extension blocks (#4315)", () => {
  const cases: Array<[number, string]> = [
    [0x4e00, "basic block U+4E00"],
    [0x9fff, "basic block tail U+9FFF"],
    [0x3400, "extension A U+3400"],
    [0x4dbf, "extension A tail U+4DBF"],
    [0xf900, "compatibility ideographs U+F900"],
    // U+FA6D is the LAST ASSIGNED compatibility ideograph; the block tail
    // (U+FA6E–U+FAFF) is unassigned and must NOT match.
    [0xfa6d, "compatibility ideographs tail U+FA6D"],
    [0x2f800, "compatibility supplement U+2F800"],
    [0x20000, "extension B U+20000"],
    [0x2a700, "extension C U+2A700"],
    [0x30000, "extension G U+30000"],
  ];
  for (const [cp, label] of cases) {
    const text = String.fromCodePoint(cp).repeat(100);
    assert.equal(
      defaultCountTokens(text),
      100,
      `${label}: 100 chars must bill 100 tokens`,
    );
  }
});

test("defaultCountTokens: supplementary-plane matches do not leak into the /4 remainder (#4315)", () => {
  // 50 basic + 50 supplementary-plane chars = 150 UTF-16 units. Old code counted
  // 50 matched chars and left 100 units in the remainder → 50 + 25 = 75.
  const text = "\u4e00".repeat(50) + String.fromCodePoint(0x20000).repeat(50);
  assert.equal(defaultCountTokens(text), 100);
});

test("defaultCountTokens: ASCII behavior unchanged by the Han widening (#4315)", () => {
  // 50 ASCII (ceil(50/4) = 13) + 50 basic Han (50) → 63, same as before the fix.
  assert.equal(defaultCountTokens("a".repeat(50) + "\u4e00".repeat(50)), 63);
  assert.equal(defaultCountTokens("a".repeat(100)), 25);
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
