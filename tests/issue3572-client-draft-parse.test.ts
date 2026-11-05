import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT, parseConfigDraft, stripJsoncComments, stripJsoncTrailingCommas } from "../src/web/client.ts";

// #3572 (client half): the server accepts JSONC config files (comments + trailing
// commas), but the web editor used to strict-parse the draft text in five places
// (quick-config hydrate, freshDraft, summary hydrate read(), save-quick, save-file),
// so a JSONC config made the quick panel vanish (#3488) and blocked saves. The
// helpers live in the TS module and are inlined into the browser IIFE via
// toString() — one implementation, exercised directly here plus a syntax check on
// the assembled client string.

test("parseConfigDraft: strict JSON takes the fast path unchanged", () => {
    assert.deepEqual(parseConfigDraft('{"providers":{}}'), { providers: {} });
    assert.deepEqual(parseConfigDraft("[]"), []);
    assert.equal(parseConfigDraft("null"), null);
});

test("parseConfigDraft: comments and trailing commas are tolerated", () => {
    const draft = `{
        // upstream relay
        "compress": { "targets": ["a", "b",], },
        /* block note */
        "upstreamProxy": null,
    }`;
    const parsed = parseConfigDraft(draft) as Record<string, unknown>;
    assert.deepEqual(parsed.compress, { targets: ["a", "b"] });
    assert.equal(parsed.upstreamProxy, null);
    assert.equal(parsed["/* block note */"], undefined);
});

test("parseConfigDraft: string literals containing //, */, commas and brackets survive", () => {
    const draft = '{"a": "x // not a comment", "b": "y /* nope */,]", "c": "esc\\\\"}';
    const parsed = parseConfigDraft(draft) as Record<string, unknown>;
    assert.equal(parsed.a, "x // not a comment");
    assert.equal(parsed.b, "y /* nope */,]");
    assert.equal(parsed.c, "esc\\");
});

test("parseConfigDraft: genuinely malformed text still throws", () => {
    assert.throws(() => parseConfigDraft("{"));
    assert.throws(() => parseConfigDraft('{"a": '));
    assert.throws(() => parseConfigDraft("// only a comment"));
    assert.throws(() => parseConfigDraft('{"a":1,,}'));
    // Documented tolerance beyond jsonc-parser: a lone stray comma before a
    // closer ({,} / [x,]) is dropped too. Harmless — the server's parseBiliConfig
    // stays authoritative on save and rejects the original text.
    assert.deepEqual(parseConfigDraft("{,}"), {});
});

test("stripJsoncComments: comments become spaces, newlines preserved for error offsets", () => {
    const stripped = stripJsoncComments('{\n  // line\n  /* block */ "a": 1\n}');
    assert.equal(stripped, '{\n  ' + ' '.repeat(7) + '\n  ' + ' '.repeat(11) + ' "a": 1\n}');
    assert.equal(stripped.length, '{\n  // line\n  /* block */ "a": 1\n}'.length, "comment stripping must be length-preserving");
    assert.equal(stripJsoncComments('{"a":"s//b"}'), '{"a":"s//b"}');
});

test("stripJsoncTrailingCommas: drops only real trailing commas", () => {
    assert.equal(stripJsoncTrailingCommas('{"a":1,}'), '{"a":1}');
    assert.equal(stripJsoncTrailingCommas('[1, 2 , ]'), '[1, 2  ]');
    assert.equal(stripJsoncTrailingCommas('{"a": "keep, me"}'), '{"a": "keep, me"}');
    // comma inside a string before a bracket must NOT be treated as trailing
    assert.equal(stripJsoncTrailingCommas('{"a": "x,]"}'), '{"a": "x,]"}');
});

test("WEB_CLIENT embeds the tolerant parser and stays valid JS", () => {
    assert.ok(WEB_CLIENT.includes("parseConfigDraft"), "client IIFE must embed parseConfigDraft");
    assert.ok(WEB_CLIENT.includes("stripJsoncComments"), "client IIFE must embed stripJsoncComments");
    // web-routing.test.ts already compiles the whole string with new Function();
    // here we additionally execute the embedded copy and prove it behaves the same.
    const grab = WEB_CLIENT.replace(/^[\s\S]*?(?=const stripJsoncComments)/, "");
    const start = grab.indexOf("const stripJsoncComments");
    const fn = new Function(`${grab.slice(start, grab.indexOf("const MESSAGES"))}; return parseConfigDraft;`)();
    assert.deepEqual(fn('{"a":1,}'), { a: 1 });
    assert.throws(() => fn("{oops"));
});
