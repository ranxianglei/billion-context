import assert from "node:assert/strict";
import test from "node:test";
import { simhashHex, normalizeArabicForSimhash } from "../src/affinity-simhash.ts";

// #7706: vocalized Arabic (Tashkeel) must not split word tokens or diverge the
// SimHash sketch from the unvocalized form. The canonical string is already
// NFC-normalized upstream (normalizeMessageText), but NFC composes — it does
// not remove — the marks, so the simhash layer strips them here.

test("vocalized and unvocalized Arabic yield identical simhash sketches", () => {
    assert.equal(
        simhashHex("مَرْحَباً بِكُمْ فِي النِّظَامِ ١٢٣"),
        simhashHex("مرحبا بكم في النظام 123"),
    );
    assert.equal(simhashHex("مَرْحَباً"), simhashHex("مرحبا"));
});

test("normalizeArabicForSimhash strips Tashkeel/Tatweel and folds variants", () => {
    assert.equal(normalizeArabicForSimhash("مَرْحَباً بِكُمْ"), "مرحبا بكم");
    assert.equal(normalizeArabicForSimhash("أإآٱ"), "اااا");
    assert.equal(normalizeArabicForSimhash("مدرسة"), "مدرسه");
    assert.equal(normalizeArabicForSimhash("على"), "علي");
});

test("normalizeArabicForSimhash maps Eastern-Arabic and Extended digits to ASCII", () => {
    assert.equal(normalizeArabicForSimhash("٠١٢٣٤٥٦٧٨٩"), "0123456789");
    assert.equal(normalizeArabicForSimhash("۰۱۲۳۴۵۶۷۸۹"), "0123456789");
});

test("normalizeArabicForSimhash is a no-op for ASCII/CJK and drops BiDi/ZW controls", () => {
    assert.equal(normalizeArabicForSimhash("hello world 123"), "hello world 123");
    assert.equal(normalizeArabicForSimhash("唯一 部署"), "唯一 部署");
    assert.equal(normalizeArabicForSimhash("\u200B\u200C\u200D"), "");
});
