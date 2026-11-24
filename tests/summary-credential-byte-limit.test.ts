import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SummaryCredentialStore } from "../src/external-summary-credentials.js";

function withStore(run: (store: SummaryCredentialStore, file: string, dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "summary-credential-bytes-"));
    const file = join(dir, "credentials.json");
    try { run(new SummaryCredentialStore(file), file, dir); }
    finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a JSON-escaped key rotation cannot make all existing credentials unreadable", () => {
    withStore((store, file, dir) => {
        const escaped = "\\".repeat(8192);
        for (let i = 0; i < 15; i++) store.set(`key${i}`, escaped);
        store.set("rotating", "x".repeat(8192));
        const before = readFileSync(file);
        assert.ok(before.byteLength < 256 * 1024);

        assert.throws(() => store.set("rotating", escaped), /store is full/);
        assert.deepEqual(readFileSync(file), before);
        assert.deepEqual(readdirSync(dir), ["credentials.json"]);
        assert.equal(store.status("secret:key0"), "configured");
        assert.equal(store.resolve("secret:rotating"), "x".repeat(8192));

        store.set("key0", null);
        store.set("rotating", escaped);
        assert.equal(store.resolve("secret:rotating"), escaped);
    });
});

test("the write ceiling counts UTF-8 bytes rather than JavaScript string length", () => {
    withStore((store, file, dir) => {
        const unicode = "界".repeat(8192);
        for (let i = 0; i < 10; i++) store.set(`key${i}`, unicode);
        const before = readFileSync(file);
        assert.ok(before.byteLength < 256 * 1024);
        assert.throws(() => store.set("newkey", unicode), /store is full/);
        assert.deepEqual(readFileSync(file), before);
        assert.equal(store.resolve("secret:key9"), unicode);
        assert.equal(store.status("secret:newkey"), "missing");
        assert.deepEqual(readdirSync(dir), ["credentials.json"]);
    });
});

test("sixteen maximum-length ASCII credentials remain valid below the byte ceiling", () => {
    withStore((store, file) => {
        const key = "x".repeat(8192);
        for (let i = 0; i < 16; i++) store.set(`key${i}`, key);
        assert.ok(statSync(file).size < 256 * 1024);
        const reopened = new SummaryCredentialStore(file);
        for (let i = 0; i < 16; i++) assert.equal(reopened.resolve(`secret:key${i}`), key);
    });
});
