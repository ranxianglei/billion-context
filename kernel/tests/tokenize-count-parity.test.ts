import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCountTokens } from "../src/tokenize.js";

// Expected counts come from the shipped CJK character class:
// \u4e00-\u9fff, \u3040-\u30ff, \uac00-\ud7af. The range data lives in the
// token counter; this test pins observable counts instead of duplicating it.
// Each unit is repeated 8 times because one BMP unit counts as 1 whether or
// not it is CJK; 8 units count as 8 when CJK and 2 when not.
const BOUNDARY_COUNTS: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 2],
  [0x0041, 2],
  [0x00e9, 2],
  [0x2000, 2],
  [0x2fff, 2],
  [0x3000, 2],
  [0x303f, 2],
  [0x3040, 8],
  [0x30ff, 8],
  [0x3100, 2],
  [0x4dff, 2],
  [0x4e00, 8],
  [0x9fff, 8],
  [0xa000, 2],
  [0xabff, 2],
  [0xac00, 8],
  [0xd7af, 8],
  [0xd7b0, 2],
  [0xe000, 2],
  [0xfffd, 2],
  [0x1f600, 4],
];

test("defaultCountTokens: CJK class boundaries", () => {
  for (const [code, expected] of BOUNDARY_COUNTS) {
    const text = String.fromCodePoint(code).repeat(8);
    assert.equal(defaultCountTokens(text), expected, `U+${code.toString(16)}`);
  }
});

const MIXED_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ["", 0],
  ["hello world", 3],
  ["你好世界", 4],
  ["こんにちは", 5],
  ["안녕하세요", 5],
  ["hello 你好 world 世界", 8],
  ["emoji 😀 中文 and \u{20000} astral", 8],
  ["a\nb\tc\r\n 你好 ", 5],
  ["한글 mixed 汉字 and カタカナ", 11],
  ["x".repeat(97) + "中".repeat(31) + "😀".repeat(11), 61],
];

test("defaultCountTokens: mixed text with surrogate pairs", () => {
  for (const [text, expected] of MIXED_COUNTS) {
    assert.equal(
      defaultCountTokens(text),
      expected,
      JSON.stringify(text.slice(0, 32)),
    );
  }
});
