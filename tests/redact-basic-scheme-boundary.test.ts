// #redact-basic: the sink-level credential scrubber (`redactSecretsInText`)
// treats "bearer|basic <token>" as an auth scheme. The old pattern used `\b`,
// which also matches after a hyphen — so the boot-time alarm
//   the host-plane compaction-basic override is GONE
// was logged as
//   the host-plane compaction-basic <masked 8 chars> is GONE
// (the word an operator needs to grep for was the one masked). A scheme has to
// START a token; a hyphen/word character before it means it is the tail of an
// identifier. Real headers are unaffected — they keep a space or colon before
// the scheme.
import assert from "node:assert/strict";
import test from "node:test";
import { redactSecretsInText } from "../src/log-mask.js";

test("prose after a hyphenated identifier is not treated as an auth scheme", () => {
    const prose = "bili: the host-plane compaction-basic override is GONE (entry \"compaction-basic\")";
    const out = redactSecretsInText(prose);
    assert.equal(out.includes("<masked"), false, `prose was masked: ${out}`);
    assert.ok(out.includes("override is GONE"), out);
});

test("a real basic header still masks", () => {
    const out = redactSecretsInText("Authorization: Basic dXNlcjpwYXNz");
    assert.equal(out, "Authorization: Basic <masked 12 chars>");
});

test("a real bearer header still masks", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.abc.def";
    const out = redactSecretsInText(`authorization: bearer ${token}`);
    assert.equal(out, `authorization: bearer <masked ${token.length} chars>`);
});

test("a scheme at string start still masks", () => {
    const out = redactSecretsInText("Basic dXNlcjpwYXNz");
    assert.equal(out, "Basic <masked 12 chars>");
});
