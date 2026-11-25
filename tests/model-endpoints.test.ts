import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    MODEL_ENDPOINT_WIRES,
    matchModelEndpoint,
    parseModelEndpointPatterns,
    loadDeclaredModelEndpoints,
    _resetLoadWarningForTest,
} from "../src/model-endpoints.ts";

test("parseModelEndpointPatterns: absent input is an empty declaration", () => {
    assert.deepEqual(parseModelEndpointPatterns(undefined), []);
    assert.deepEqual(parseModelEndpointPatterns(null), []);
});

test("parseModelEndpointPatterns: normalizes matches (trailing slash stripped)", () => {
    const out = parseModelEndpointPatterns([
        { match: "https://api.commandcode.ai/alpha/generate/", wire: "commandcode" },
    ]);
    assert.deepEqual(out, [{ match: "https://api.commandcode.ai/alpha/generate", wire: "commandcode" }]);
});

test("parseModelEndpointPatterns: rejects malformed entries with index-specific errors", () => {
    assert.throws(() => parseModelEndpointPatterns("nope"), /must be an array/);
    assert.throws(() => parseModelEndpointPatterns([42]), /modelEndpointPatterns\[0\] must be an object/);
    assert.throws(() => parseModelEndpointPatterns([{ wire: "openai" }]), /modelEndpointPatterns\[0\]\.match/);
    assert.throws(() => parseModelEndpointPatterns([{ match: "not a url", wire: "openai" }]), /\.match must be an absolute http\(s\) URL prefix/);
    assert.throws(() => parseModelEndpointPatterns([{ match: "ftp://x.io/a", wire: "openai" }]), /\.match must be an absolute http\(s\) URL prefix/);
    assert.throws(() => parseModelEndpointPatterns([{ match: "https://x.io/a?b=1", wire: "openai" }]), /\.match must be an absolute http\(s\) URL prefix/);
    assert.throws(() => parseModelEndpointPatterns([{ match: "https://x.io/a", wire: "gpt" }]), /must be one of/);
    assert.throws(() => parseModelEndpointPatterns([{ match: "https://a.io/x", wire: "openai" }, null]), /modelEndpointPatterns\[1\] must be an object/);
});

test("parseModelEndpointPatterns: accepts every declared wire family", () => {
    for (const wire of MODEL_ENDPOINT_WIRES) {
        const out = parseModelEndpointPatterns([{ match: `https://h.io/${wire}`, wire }]);
        assert.equal(out[0].wire, wire);
    }
});

test("matchModelEndpoint: exact and sub-path claims on the same origin", () => {
    const patterns = parseModelEndpointPatterns([
        { match: "https://api.commandcode.ai/alpha/generate", wire: "commandcode" },
        { match: "http://127.0.0.1:8787", wire: "openai" },
    ]);
    assert.equal(matchModelEndpoint(patterns, "https://api.commandcode.ai/alpha/generate")?.wire, "commandcode");
    assert.equal(matchModelEndpoint(patterns, "https://api.commandcode.ai/alpha/generate?x=1")?.wire, "commandcode");
    assert.equal(matchModelEndpoint(patterns, "https://api.commandcode.ai/alpha/generate/")?.wire, "commandcode");
    assert.equal(matchModelEndpoint(patterns, "http://127.0.0.1:8787/v1/chat/completions")?.wire, "openai");
    // exact-origin + segment boundary: no false claims
    assert.equal(matchModelEndpoint(patterns, "https://api.commandcode.ai/alpha/generate2"), undefined);
    assert.equal(matchModelEndpoint(patterns, "https://evil-api.commandcode.ai/alpha/generate"), undefined);
    assert.equal(matchModelEndpoint(patterns, "http://api.commandcode.ai/alpha/generate"), undefined);
    assert.equal(matchModelEndpoint(patterns, "https://other.example/alpha/generate"), undefined);
    assert.equal(matchModelEndpoint([], "https://api.commandcode.ai/alpha/generate"), undefined);
    assert.equal(matchModelEndpoint(patterns, "not a url"), undefined);
});

test("matchModelEndpoint: longest declared prefix wins", () => {
    const patterns = parseModelEndpointPatterns([
        { match: "https://h.io/api", wire: "openai" },
        { match: "https://h.io/api/custom", wire: "commandcode" },
    ]);
    assert.equal(matchModelEndpoint(patterns, "https://h.io/api/custom/run")?.wire, "commandcode");
    assert.equal(matchModelEndpoint(patterns, "https://h.io/api/other")?.wire, "openai");
});

test("matchModelEndpoint: root-path pattern claims the whole origin", () => {
    const patterns = parseModelEndpointPatterns([{ match: "https://h.io/", wire: "anthropic" }]);
    assert.equal(matchModelEndpoint(patterns, "https://h.io/v1/messages")?.wire, "anthropic");
    assert.equal(matchModelEndpoint(patterns, "https://h.io")?.wire, "anthropic");
});

test("loadDeclaredModelEndpoints: reads the global config file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-model-ep-"));
    const file = path.join(dir, "billion-context.json");
    fs.writeFileSync(file, JSON.stringify({ modelEndpointPatterns: [{ match: "https://api.commandcode.ai/alpha/generate", wire: "commandcode" }] }));
    const saved = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        const out = await loadDeclaredModelEndpoints();
        assert.deepEqual(out, [{ match: "https://api.commandcode.ai/alpha/generate", wire: "commandcode" }]);
    } finally {
        if (saved === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = saved;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** Collect console.error lines emitted while `fn` runs. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map((a) => String(a)).join(" ")); };
    try {
        const result = await fn();
        return { result, lines };
    } finally {
        console.error = original;
    }
}

test("loadDeclaredModelEndpoints: a host with no config file is the default state and stays silent", async () => {
    const saved = process.env.BILI_CONFIG_FILE;
    _resetLoadWarningForTest();
    try {
        process.env.BILI_CONFIG_FILE = path.join(os.tmpdir(), `bili-model-ep-absent-${process.pid}-${Date.now()}.json`);
        const { result, lines } = await captureStderr(() => loadDeclaredModelEndpoints());
        assert.deepEqual(result, []);
        assert.deepEqual(lines, [], "a never-configured host must not look broken on first boot");
    } finally {
        if (saved === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = saved;
        _resetLoadWarningForTest();
    }
});

test("loadDeclaredModelEndpoints: a present but unusable config warns once, naming the reason", async () => {
    const saved = process.env.BILI_CONFIG_FILE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-model-ep-"));
    _resetLoadWarningForTest();
    try {
        const bad = path.join(dir, "billion-context.json");
        fs.writeFileSync(bad, "{ not json");
        process.env.BILI_CONFIG_FILE = bad;
        const first = await captureStderr(() => loadDeclaredModelEndpoints());
        assert.deepEqual(first.result, []);
        assert.equal(first.lines.length, 1, "a malformed config is worth exactly one line");
        assert.match(first.lines[0]!, /is not a usable billion-context config/);
        assert.match(first.lines[0]!, /billion-context\.json/, "the line must point at the file");

        // Still one-shot: a second load in the same process adds nothing.
        const second = await captureStderr(() => loadDeclaredModelEndpoints());
        assert.deepEqual(second.result, []);
        assert.deepEqual(second.lines, []);

        const badEntry = path.join(dir, "bad-entry.json");
        fs.writeFileSync(badEntry, JSON.stringify({ modelEndpointPatterns: [{ wire: "openai" }] }));
        process.env.BILI_CONFIG_FILE = badEntry;
        _resetLoadWarningForTest();
        const third = await captureStderr(() => loadDeclaredModelEndpoints());
        assert.deepEqual(third.result, []);
        assert.equal(third.lines.length, 1, "structurally invalid declarations are the same class of problem");
        assert.match(third.lines[0]!, /modelEndpointPatterns\[0\]/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        if (saved === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = saved;
        _resetLoadWarningForTest();
    }
});
