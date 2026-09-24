// #1234: the opencode lane has no drivable upgrade channel (opencode never
// re-resolves an installed npm plugin; bili must not write its tree, #991),
// so a stale copy must at least be VISIBLE. warnOpencodeStaleCopy logs once
// per version pair (dedupe pattern from #806), clears the key when the copy
// catches up (so a later release warns again), and swallows registry errors
// without spamming or breaking the check loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { warnOpencodeStaleCopy, _resetOpencodeStaleWarnForTest } from "../src/update.ts";

function makeInstall(version: string): string {
    const root = mkdtempSync(path.join(tmpdir(), "bc-oc-stale-"));
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "billion-context", version }));
    return root;
}

function registryFetch(version: string | undefined): typeof fetch {
    return (() => Promise.resolve(new Response(JSON.stringify(version ? { version } : {})))) as unknown as typeof fetch;
}

const opts = { packageName: "billion-context", currentVersion: "1.2.3" };
const channel = "remove <XDG_CACHE_HOME>/opencode/packages/billion-context@* and restart opencode";

test("warns once per stale pair, dedupes repeats, re-warns after catching up", async () => {
    _resetOpencodeStaleWarnForTest();
    const installDir = makeInstall("1.2.3");
    const logs: string[] = [];
    const log = (level: string, msg: string): void => { logs.push(`${level}:${msg}`); };
    const original = globalThis.fetch;
    try {
        globalThis.fetch = registryFetch("2.0.0");
        await warnOpencodeStaleCopy(installDir, opts, channel, log);
        await warnOpencodeStaleCopy(installDir, opts, channel, log);
        assert.equal(logs.length, 1, "second call with the same pair must be deduped");
        assert.match(logs[0], /^warn:/);
        assert.match(logs[0], /stale \(1\.2\.3 \u2192 2\.0\.0\)/);
        assert.match(logs[0], /restart opencode/);

        globalThis.fetch = registryFetch("1.2.3");
        await warnOpencodeStaleCopy(installDir, opts, channel, log);
        assert.equal(logs.length, 1, "up-to-date copy must not log");

        globalThis.fetch = registryFetch("2.1.0");
        await warnOpencodeStaleCopy(installDir, opts, channel, log);
        assert.equal(logs.length, 2, "a new stale pair must warn again after the key cleared");
        assert.match(logs[1], /2\.1\.0/);
    } finally {
        globalThis.fetch = original;
        rmSync(installDir, { recursive: true, force: true });
    }
});

test("falls back to the running version when disk package.json is unreadable", async () => {
    _resetOpencodeStaleWarnForTest();
    const installDir = makeInstall("1.2.3");
    rmSync(path.join(installDir, "package.json"));
    const logs: string[] = [];
    const original = globalThis.fetch;
    try {
        globalThis.fetch = registryFetch("2.0.0");
        await warnOpencodeStaleCopy(installDir, opts, channel, (l, m) => logs.push(`${l}:${m}`));
        assert.equal(logs.length, 1);
        assert.match(logs[0], /stale \(1\.2\.3 \u2192 2\.0\.0\)/);
    } finally {
        globalThis.fetch = original;
        rmSync(installDir, { recursive: true, force: true });
    }
});

test("swallows registry failures silently — no spam, no throw", async () => {
    _resetOpencodeStaleWarnForTest();
    const installDir = makeInstall("1.2.3");
    const logs: string[] = [];
    const original = globalThis.fetch;
    try {
        globalThis.fetch = (() => Promise.reject(new Error("registry down"))) as unknown as typeof fetch;
        await warnOpencodeStaleCopy(installDir, opts, channel, (l, m) => logs.push(`${l}:${m}`));
        globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 500 }))) as unknown as typeof fetch;
        await warnOpencodeStaleCopy(installDir, opts, channel, (l, m) => logs.push(`${l}:${m}`));
        assert.deepEqual(logs, []);
    } finally {
        globalThis.fetch = original;
        rmSync(installDir, { recursive: true, force: true });
    }
});
