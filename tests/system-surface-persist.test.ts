import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore, relPathFor } from "../src/persist.ts";
import { captureSystemSurface, isValidSystemSurface, SYSTEM_SURFACE_SUFFIX } from "../src/system-surface.ts";
import type { SystemSurfaceRecord } from "../src/system-surface.ts";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #3201: the system-surface sidecar (outbound system prompt + tool catalog)
// must round-trip through SessionStore like the CCR content store does, and
// must degrade gracefully when corrupt — it is a derived artifact and may
// never block boot or a save.

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function sidecarPath(dir: string, id: string, protocol?: string): string {
    const base = relPathFor(id, protocol);
    return join(dir, base.slice(0, -".json".length) + SYSTEM_SURFACE_SUFFIX);
}

test("captureSystemSurface records once per distinct surface", () => {
    const s = makeSession("ss-dedup");
    captureSystemSurface(s, "you are helpful", [{ name: "bash" }]);
    assert.ok(s.systemSurface);
    assert.equal(s.systemSurfaceDirty, true);
    assert.equal(s.systemSurface!.systemText, "you are helpful");
    assert.deepEqual(s.systemSurface!.toolNames, ["bash"]);
    const first = s.systemSurface;

    s.systemSurfaceDirty = false;
    captureSystemSurface(s, "you are helpful", [{ name: "bash" }]);
    assert.equal(s.systemSurfaceDirty, false, "identical surface must not re-arm dirty");
    assert.equal(s.systemSurface, first, "record object stays stable when unchanged");

    captureSystemSurface(s, "you are helpful v2", [{ name: "bash" }]);
    assert.equal(s.systemSurfaceDirty, true);
    assert.notEqual(s.systemSurface!.hash, first.hash);
});

test("captureSystemSurface truncates oversized payloads but hashes full content", () => {
    const s = makeSession("ss-trunc");
    const big = "s".repeat(500_000);
    captureSystemSurface(s, big, null);
    assert.equal(s.systemSurface!.systemTruncated, true);
    assert.equal(s.systemSurface!.systemText.length, 400_000);

    // Hash covers the UNTRUNCATED bytes: same head, different tail → new hash.
    const s2 = makeSession("ss-trunc2");
    captureSystemSurface(s2, big.slice(0, 499_999) + "T", null);
    assert.notEqual(s2.systemSurface!.hash, s.systemSurface!.hash);

    const s3 = makeSession("ss-empty");
    captureSystemSurface(s3, "", undefined);
    assert.equal(s3.systemSurface, undefined, "empty surface is not captured");
});

test("extractToolNames handles all four wire shapes", () => {
    const cases: Array<[string, unknown[], string[]]> = [
        ["openai", [{ type: "function", function: { name: "read_file" } }], ["read_file"]],
        ["anthropic", [{ name: "str_replace_editor" }], ["str_replace_editor"]],
        ["responses", [{ type: "function", name: "apply_patch" }], ["apply_patch"]],
        ["google", [{ functionDeclarations: [{ name: "g1" }, { name: "g2" }] }], ["g1", "g2"]],
        ["mixed-junk", [null, 42, { name: "ok" }, {}], ["ok"]],
    ];
    for (const [label, tools, expected] of cases) {
        const s = makeSession(`ss-tools-${label}`);
        captureSystemSurface(s, `sys ${label}`, tools);
        assert.deepEqual(s.systemSurface!.toolNames, expected, label);
    }
});

test("isValidSystemSurface rejects malformed records", () => {
    const good: SystemSurfaceRecord = {
        v: 1, hash: "h", systemText: "t", systemTruncated: false,
        toolsJson: "[]", toolsTruncated: false, toolNames: [], updatedAt: 1,
    };
    assert.equal(isValidSystemSurface(good), true);
    assert.equal(isValidSystemSurface(null), false);
    assert.equal(isValidSystemSurface({}), false);
    assert.equal(isValidSystemSurface({ ...good, v: 2 }), false);
    assert.equal(isValidSystemSurface({ ...good, toolNames: "nope" }), false);
    assert.equal(isValidSystemSurface({ ...good, toolNames: ["ok", 5] }), false);
    assert.equal(isValidSystemSurface({ ...good, updatedAt: "yesterday" }), false);
});

test("system surface sidecar survives a save/load round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-sys-srf-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("ss-rt");
        s.meta.protocol = "openai";
        captureSystemSurface(s, "sys text", [{ name: "bash" }]);
        await store.writeNow(s);
        await store.flushAll([]);
        assert.ok(existsSync(sidecarPath(dir, "ss-rt", "openai")), "sidecar written next to the session record");

        const reloaded = new SessionStore({ dir, debounceMs: 5, enabled: true });
        // Namespaced sessions need their meta for the direct file probe —
        // production callers pass it from the index row (same as loadAll).
        const back = reloaded.loadSync("ss-rt", { protocol: "openai" });
        assert.ok(back, "session reloaded");
        assert.equal(back.systemSurface, undefined, "loadSync does not auto-hydrate the derived sidecar");
        const loaded = reloaded.loadSystemSurface(back);
        assert.ok(loaded, "explicit probe finds the sidecar");
        assert.equal(loaded.systemText, "sys text");
        assert.deepEqual(loaded.toolNames, ["bash"]);
        await reloaded.flushAll([]);
    } finally {
        rmrf(dir);
    }
});

test("malformed system surface degrades to null without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-sys-srf-bad-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("ss-bad");
        s.meta.protocol = "openai";
        captureSystemSurface(s, "sys", [{ name: "bash" }]);
        await store.writeNow(s);
        await store.flushAll([]);

        writeFileSync(sidecarPath(dir, "ss-bad", "openai"), "{not json");
        const reloaded = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const back = reloaded.loadSync("ss-bad", { protocol: "openai" });
        assert.ok(back, "boot/load still succeeds with a corrupt sidecar");
        assert.equal(reloaded.loadSystemSurface(back), null);
        await reloaded.flushAll([]);
    } finally {
        rmrf(dir);
    }
});

test("re-capturing after clear deletes the stale sidecar on next save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-sys-srf-del-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("ss-del");
        s.meta.protocol = "openai";
        captureSystemSurface(s, "sys", [{ name: "bash" }]);
        await store.writeNow(s);
        await store.flushAll([]);
        const p = sidecarPath(dir, "ss-del", "openai");
        assert.ok(existsSync(p));

        s.systemSurface = undefined;
        s.systemSurfaceDirty = true;
        await store.writeNow(s);
        await store.flushAll([]);
        assert.ok(!existsSync(p), "absent surface removes the sidecar");
    } finally {
        rmrf(dir);
    }
});
