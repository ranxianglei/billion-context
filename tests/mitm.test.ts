import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { isMitmHost, readMitmUpstream, MITM_UPSTREAM_KEY } from "../src/mitm.js";
import { ensureRootCA, rootCaPath, getSecureContext, _resetForTest } from "../src/ca.js";

// Isolate the CA directory to a per-test tmp dir so we never touch the real
// ~/.local/share/billion-context/ca. caDir() = dataDir()/ca =
// XDG_DATA_HOME/billion-context/ca.
function withTmpCa<T>(fn: () => Promise<T> | T): Promise<T> | T {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mitm-"));
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmp;
    _resetForTest();
    try {
        return fn();
    } finally {
        process.env.XDG_DATA_HOME = prev;
        _resetForTest();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

test("isMitmHost: matches the built-in whitelist exactly", () => {
    assert.equal(isMitmHost("open.bigmodel.cn"), true);
    assert.equal(isMitmHost("api.anthropic.com"), true);
    assert.equal(isMitmHost("api.openai.com"), true);
    assert.equal(isMitmHost("chatgpt.com"), true);
});

test("isMitmHost: matches subdomains via suffix", () => {
    // A subdomain of a whitelisted apex should also be MITM'd (providers shard
    // traffic across subdomains, e.g. edge.chatgpt.com).
    assert.equal(isMitmHost("edge.chatgpt.com"), true);
    assert.equal(isMitmHost("coding.api.anthropic.com"), true);
});

test("isMitmHost: rejects unknown hosts and suffix-spoofing", () => {
    assert.equal(isMitmHost("evil.com"), false);
    assert.equal(isMitmHost("example.com"), false);
    // Critical: "open.bigmodel.cn.evil.com" must NOT match — it ends with the
    // apex but is a distinct host. The suffix check is "." + domain, which
    // prevents this attack.
    assert.equal(isMitmHost("open.bigmodel.cn.evil.com"), false);
    assert.equal(isMitmHost("notchatgpt.com"), false);
});

test("isMitmHost: honors extra domains from config", () => {
    assert.equal(isMitmHost("foo.com", ["foo.com"]), true);
    assert.equal(isMitmHost("sub.foo.com", ["foo.com"]), true);
    assert.equal(isMitmHost("bar.com", ["foo.com"]), false);
    // Case-insensitive
    assert.equal(isMitmHost("FOO.COM", ["foo.com"]), true);
});

test("isMitmHost: is case-insensitive on the host", () => {
    assert.equal(isMitmHost("OPEN.BIGMODEL.CN"), true);
    assert.equal(isMitmHost("Api.Anthropic.Com"), true);
});

await test("ensureRootCA: generates a PEM cert + key on first call", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const p = rootCaPath();
        assert.ok(fs.existsSync(p), "root CA cert file should exist");
        const pem = fs.readFileSync(p, "utf8");
        assert.ok(pem.includes("BEGIN CERTIFICATE"), "should be a PEM certificate");
        // Private key file lives next to it (0600 perms for secrecy).
        const keyPath = path.join(path.dirname(p), "root-ca-key.pem");
        assert.ok(fs.existsSync(keyPath), "root CA key file should exist");
        const keyPem = fs.readFileSync(keyPath, "utf8");
        assert.ok(keyPem.includes("BEGIN PRIVATE KEY") || keyPem.includes("BEGIN RSA PRIVATE KEY"));
        // Key must NOT be world-readable.
        const mode = (fs.statSync(keyPath).mode & 0o777);
        assert.equal(mode & 0o077, 0, `key file mode ${mode.toString(8)} leaks group/other bits`);
    });
});

await test("ensureRootCA: is idempotent across calls (reuses existing CA)", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const first = fs.readFileSync(rootCaPath(), "utf8");
        // Second call must NOT regenerate — the same cert keeps already-trusted
        // installs valid across restarts.
        ensureRootCA();
        const second = fs.readFileSync(rootCaPath(), "utf8");
        assert.equal(first, second, "root CA cert must be stable across ensureRootCA calls");
    });
});

await test("getSecureContext: returns a usable SecureContext", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const ctx = getSecureContext("open.bigmodel.cn");
        assert.ok(ctx, "should return a SecureContext");
    });
});

await test("getSecureContext: caches per host (same object on repeat)", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const a = getSecureContext("api.openai.com");
        const b = getSecureContext("api.openai.com");
        assert.equal(a, b, "same host must return the cached SecureContext");
        const c = getSecureContext("api.anthropic.com");
        assert.notEqual(a, c, "different host must get a distinct context");
    });
});

test("readMitmUpstream: reads the socket marker when set", () => {
    const fakeSocket = {} as unknown as import("node:net").Socket;
    (fakeSocket as unknown as Record<string, unknown>)[MITM_UPSTREAM_KEY] = "https://open.bigmodel.cn";
    assert.equal(readMitmUpstream(fakeSocket), "https://open.bigmodel.cn");
});

test("readMitmUpstream: returns undefined when no marker (direct /bili/ request)", () => {
    const fakeSocket = {} as unknown as import("node:net").Socket;
    assert.equal(readMitmUpstream(fakeSocket), undefined);
    assert.equal(readMitmUpstream(undefined), undefined);
});
