import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesNoProxy, resolveProxyDecision } from "../src/upstream-proxy.ts";

const cases: Array<[string, string, boolean]> = [
    ["*int*", "https://internet/", true],
    ["*int*", "https://painter/", true],
    ["*int*", "https://api.external.example/", false],
    ["*internal", "https://build.internal/", true],
    ["*internal", "https://internal.example/", false],
    ["*.corp.*", "https://api.corp.example/", true],
    ["*.corp.*", "https://apiXcorpYexample/", false],
    ["*example.com", "https://sub.example.com/", true],
    ["*example.com", "https://example.com.evil/", false],
    ["*INTERNAL", "https://build.internal/", true],
    ["*int*:8443", "https://painter:8443/", true],
    ["*int*:8443", "https://painter/", false],
    ["*.example.com", "https://example.com/", true],
    ["*.example.com", "https://sub.example.com/", true],
];

for (const [pattern, url, expected] of cases) {
    test(`Windows bypass ${pattern} matches ${url}: ${expected}`, () => {
        assert.equal(matchesNoProxy(new URL(url), pattern, { windowsBypass: true }), expected);
    });
}

test("Windows leading wildcards do not widen conventional NO_PROXY matching", () => {
    for (const [pattern, url] of cases.filter(([pattern, , expected]) => expected && pattern !== "*.example.com")) {
        assert.equal(matchesNoProxy(new URL(url), pattern), false);
    }
    assert.equal(matchesNoProxy(new URL("https://api.example.com"), "*.example.com"), true);
    assert.equal(matchesNoProxy(new URL("https://example.com"), "*.example.com"), true);
});

test("documented WinINet leading globs select direct routing only for matching upstreams", () => {
    const systemProxy = { enabled: true, https: "http://system-proxy.example:8080", bypass: "*int*" };
    assert.deepEqual(resolveProxyDecision({}, undefined, "https://painter/v1", { systemProxy }), { source: "windows-bypass" });
    assert.deepEqual(resolveProxyDecision({}, undefined, "https://api.external.example/v1", { systemProxy }), {
        source: "windows-system", proxy: "http://system-proxy.example:8080/",
    });
    assert.deepEqual(resolveProxyDecision({}, undefined, "https://painter/v1", {
        systemProxy, httpsProxy: "http://environment-proxy.example:8080",
    }), { source: "HTTPS_PROXY", proxy: "http://environment-proxy.example:8080/" });
    assert.deepEqual(resolveProxyDecision({}, "http://explicit-proxy.example:8080", "https://painter/v1", {
        systemProxy,
    }), { source: "global", proxy: "http://explicit-proxy.example:8080/" });
});
