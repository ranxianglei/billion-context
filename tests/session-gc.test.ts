import { test, beforeEach, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { imageTokensInParsedBody } from "../src/image-tokens.js";
import { estimateRawBodyTokens } from "../src/preflight.js";
import type { ProxyOptions } from "../src/config.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { createStorageCodec, parseEncryptionKey } from "../src/encrypt.js";
import { _resetSessionsForTest, getSession, markDirty, peekSession } from "../src/session.js";
import type { Session } from "../src/session.js";
import { contentStoreTokens, gcConfigFromEnv, gcSessionFiles, isGcEligible, viewFromParsed } from "../src/session-gc.js";
import { restoreExportDirName } from "../src/image-restore.js";

const DAY = 86_400_000;

function tmpDir(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        await fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function envelope(id: string, savedAt: number, extra?: Record<string, unknown>): Record<string, unknown> {
    return {
        version: 3,
        savedAt,
        id,
        payload: {
            version: 3,
            savedAt,
            id,
            meta: { protocol: "anthropic", upstreamOrigin: "https://api.example.com" },
            stats: { requests: 3, contextTokens: 8000 },
            createdAt: savedAt - DAY,
            state: { blocks: [] },
            blockContents: {},
            ...extra,
        },
    };
}

function flatLegacy(id: string, savedAt: number, blocks: unknown[], contextTokens: number): Record<string, unknown> {
    return {
        version: 1,
        savedAt,
        id,
        protocol: "anthropic",
        requests: 3,
        contextTokens,
        state: { blocks },
    };
}

function contentStoreFile(dir: string, rel: string, chars: number, ageDays: number): string {
    const text = "y".repeat(chars);
    const store = { version: 1, byHash: { h1: text }, byRef: { m00001: { hash: "h1", rawId: "raw-1", kind: "tool output", chars, head: "y", tokens: Math.ceil(chars / 4) } } };
    return writeFile(dir, rel, JSON.stringify(store), ageDays);
}

function writeFile(dir: string, rel: string, content: string | Buffer, ageDays: number): string {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    const t = new Date(Date.now() - ageDays * DAY);
    utimesSync(full, t, t);
    return full;
}

function isDir(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function findSessionFile(dir: string, id: string): string | null {
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue;
        const sub = path.join(dir, entry);
        if (!isDir(sub)) continue;
        for (const name of readdirSync(sub)) {
            if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
            const full = path.join(sub, name);
            try {
                const parsed = JSON.parse(readFileSync(full, "utf8")) as { id?: string; payload?: { id?: string } };
                if (parsed.id === id || parsed.payload?.id === id) return full;
            } catch {
                continue;
            }
        }
    }
    return null;
}

async function closeServer(srv: http.Server): Promise<void> {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
}

beforeEach(() => {
    _resetSessionsForTest();
});

// #1995: the GC's stale image-spill pass reads <stateDir>/retrieve/img when no
// imgRoot is passed — isolate XDG_STATE_HOME for the whole file so sweeps under
// test never touch (or delete) a developer machine's real spill tree.
let gcStateRoot: string | undefined;
let prevStateHome: string | undefined;
before(() => {
    prevStateHome = process.env.XDG_STATE_HOME;
    gcStateRoot = mkdtempSync(path.join(os.tmpdir(), "bili-gc-state-"));
    process.env.XDG_STATE_HOME = gcStateRoot;
});

after(() => {
    if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevStateHome;
    if (gcStateRoot) rmSync(gcStateRoot, { recursive: true, force: true });
    _setStoreForTest(new SessionStore({ enabled: false }));
});

    test("isGcEligible: age + never-compressed + size gates all required", () => {
        const cfg = { maxAgeMs: 7 * DAY, maxTokens: 1_000_000 };
        const now = Date.parse("2026-09-21T00:00:00Z");
        const oldSavedAt = now - 10 * DAY;
        assert.equal(isGcEligible({ id: "a", savedAt: oldSavedAt, contextTokens: 999_999_999, everCompressed: false, rawInputTokens: 5_000 }, now, cfg), true, "old + never compressed + small raw → eligible");
        assert.equal(isGcEligible({ id: "b", savedAt: oldSavedAt, contextTokens: 0, everCompressed: false, rawInputTokens: 2_000_000 }, now, cfg), false, "raw above threshold keeps");
        assert.equal(isGcEligible({ id: "c", savedAt: oldSavedAt, contextTokens: 0, everCompressed: true, rawInputTokens: 5_000 }, now, cfg), false, "compressed session keeps even when small");
        assert.equal(isGcEligible({ id: "d", savedAt: now - 3 * DAY, contextTokens: 0, everCompressed: false, rawInputTokens: 5_000 }, now, cfg), false, "recent keeps");
    });

    test("isGcEligible: contextTokens fallback for unrecorded files", () => {
        const cfg = { maxAgeMs: 7 * DAY, maxTokens: 1_000_000 };
        const now = Date.parse("2026-09-21T00:00:00Z");
        const oldSavedAt = now - 10 * DAY;
        assert.equal(isGcEligible({ id: "a", savedAt: oldSavedAt, contextTokens: 8_000, everCompressed: false, rawInputTokens: null }, now, cfg), true);
        assert.equal(isGcEligible({ id: "b", savedAt: oldSavedAt, contextTokens: 2_000_000, everCompressed: false, rawInputTokens: null }, now, cfg), false);
        assert.equal(isGcEligible({ id: "c", savedAt: oldSavedAt, contextTokens: 8_000, everCompressed: true, rawInputTokens: null }, now, cfg), false, "compressed session keeps even when small");
    });

    test("isGcEligible: companion store footprint folds into the size gate (#1180)", () => {
        const cfg = { maxAgeMs: 7 * DAY, maxTokens: 1_000_000 };
        const now = Date.parse("2026-09-21T00:00:00Z");
        const oldSavedAt = now - 10 * DAY;
        const base = { id: "a", savedAt: oldSavedAt, contextTokens: 0, everCompressed: false, rawInputTokens: 900_000 };
        assert.equal(isGcEligible(base, now, cfg), true, "900K alone fits under 1M");
        assert.equal(isGcEligible({ ...base, storedTokens: 200_000 }, now, cfg), false, "+200K store pushes over the gate");
        assert.equal(isGcEligible({ ...base, storedTokens: 0 }, now, cfg), true, "zero footprint changes nothing");
    });

    test("contentStoreTokens: unique-content via CJK-aware estimator; null for anything that is not a store envelope (#1180)", () => {
        assert.equal(contentStoreTokens({ version: 1, byHash: { h1: "aaaa", h2: "bbbb" }, byRef: { m00001: {} } }), 2, "sums byHash values via the CJK-aware estimator");
        assert.equal(contentStoreTokens({ version: 1, byHash: { h1: "测试测试测试" }, byRef: { m00001: {} } }), 6, "CJK content counts per character (not chars÷4)");
        assert.equal(contentStoreTokens({ version: 1, byHash: {}, byRef: {} }), 0, "valid empty envelope → 0");
        assert.equal(contentStoreTokens({ version: 1, byHash: { h1: "x" } }), null, "missing byRef → not an envelope");
        assert.equal(contentStoreTokens(envelope("s1", 1234)), null, "session record (version 3) is not a store envelope");
        assert.equal(contentStoreTokens(null), null);
        assert.equal(contentStoreTokens("garbage"), null);
    });

test("viewFromParsed: envelope v3, legacy flat, corrupt input", () => {
    const rec = viewFromParsed(envelope("s1", 1234, { metadata: { rawInputTokens: 4242 } }));
    assert.ok(rec);
    assert.deepEqual(rec, { id: "s1", savedAt: 1234, contextTokens: 8000, everCompressed: false, rawInputTokens: 4242 });

    const legacy = viewFromParsed(flatLegacy("s2", 999, [{ id: "b1", active: true }], 77));
    assert.ok(legacy);
    assert.deepEqual(legacy, { id: "s2", savedAt: 999, contextTokens: 77, everCompressed: true, rawInputTokens: null });

    const inact = viewFromParsed(envelope("s4", 1234, { state: { blocks: [{ id: "b9", active: false }] } }));
    assert.ok(inact && inact.everCompressed === true, "inactive-only blocks still count as compressed");

    const folded = viewFromParsed(envelope("s5", 1234, { state: { blocks: [] }, blockContents: { b1: { source: "x" } } }));
    assert.ok(folded && folded.everCompressed === true, "stored fold content counts as compressed");

    assert.equal(viewFromParsed(null), null);
    assert.equal(viewFromParsed("garbage"), null);
    assert.equal(viewFromParsed({}), null);
    assert.equal(viewFromParsed({ savedAt: -5 }), null);
});

test("gcConfigFromEnv: disabled by default, opt-in only", async () => {
    await withEnv(
        { BILI_SESSION_GC: undefined, BILI_SESSION_GC_MAX_AGE_DAYS: undefined, BILI_SESSION_GC_MAX_TOKENS: undefined, BILI_SESSION_GC_INTERVAL_MS: undefined },
        async () => {
            const def = gcConfigFromEnv();
            assert.deepEqual(def, { enabled: false, maxAgeMs: 7 * DAY, maxTokens: 1_000_000, intervalMs: 3_600_000 });
            for (const on of ["1", "true", "ON"]) {
                await withEnv({ BILI_SESSION_GC: on }, async () => {
                    assert.equal(gcConfigFromEnv().enabled, true, `${on} enables`);
                });
            }
            for (const off of ["0", "false", "off", "garbage"]) {
                await withEnv({ BILI_SESSION_GC: off }, async () => {
                    assert.equal(gcConfigFromEnv().enabled, false, `${off} does not enable`);
                });
            }
            await withEnv({ BILI_SESSION_GC_MAX_AGE_DAYS: "30", BILI_SESSION_GC_MAX_TOKENS: "abc", BILI_SESSION_GC_INTERVAL_MS: "60000" }, async () => {
                const c = gcConfigFromEnv();
                assert.equal(c.maxAgeMs, 30 * DAY);
                assert.equal(c.maxTokens, 1_000_000, "invalid tokens falls back to default");
                assert.equal(c.intervalMs, 60_000);
            });
        },
    );
});

test("gcSessionFiles: deletes old small files, keeps recent/large/compressed/corrupt, ignores temps", async () => {
    const dir = tmpDir("bili-gc-sweep-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        const oldSavedAt = Date.now() - 10 * DAY;
        const fDel = writeFile(dir, "anthropic/host_del.json", JSON.stringify(envelope("gc-del", oldSavedAt, { metadata: { rawInputTokens: 5000 } })), 10);
        const fBigRaw = writeFile(dir, "anthropic/host_big.json", JSON.stringify(envelope("gc-big", oldSavedAt, { metadata: { rawInputTokens: 2_000_000 } })), 10);
        const fRecent = writeFile(dir, "anthropic/host_recent.json", JSON.stringify(envelope("gc-recent", Date.now() - DAY, { metadata: { rawInputTokens: 5000 } })), 1);
        const fLegacyNoBlocks = writeFile(dir, "openai/host_legacy.json", JSON.stringify(flatLegacy("gc-legacy", oldSavedAt, [], 4000)), 10);
        const fLegacyBlocks = writeFile(dir, "openai/host_legacy_blocks.json", JSON.stringify(flatLegacy("gc-legacy-blocks", oldSavedAt, [{ id: "b1", active: true }], 4000)), 10);
        const fKeepInact = writeFile(dir, "openai/host_inact.json", JSON.stringify(envelope("gc-inact", oldSavedAt, { metadata: { rawInputTokens: 5000 }, state: { blocks: [{ id: "b9", active: false }] } })), 10);
        const fCorrupt = writeFile(dir, "openai/host_corrupt.json", "{not json", 10);
        writeFile(dir, "openai/.hidden.json", "{}", 10);
        writeFile(dir, "openai/x.tmp-enc-1-2.json", "{}", 10);
        const onlySub = "solo";
        const fSolo = writeFile(dir, `${onlySub}/host_solo.json`, JSON.stringify(envelope("gc-solo", oldSavedAt, { metadata: { rawInputTokens: 100 } })), 10);

        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 3, `expected 3 removed, got ${JSON.stringify(res)}`);
        assert.equal(res.unreadable, 1);
        assert.ok(!existsSync(fDel));
        assert.ok(!existsSync(fLegacyNoBlocks));
        assert.ok(!existsSync(fSolo));
        assert.ok(!existsSync(path.join(dir, onlySub)), "emptied protocol subdir removed");
        assert.ok(existsSync(fBigRaw));
        assert.ok(existsSync(fRecent));
        assert.ok(existsSync(fLegacyBlocks));
        assert.ok(existsSync(fKeepInact), "once-compressed session kept even when small (inactive-only blocks)");
        assert.ok(existsSync(fCorrupt));
        assert.ok(res.bytesFreed > 0);
    });
});

test("gcSessionFiles: disabled unless explicitly enabled (opt-in)", async () => {
    const dir = tmpDir("bili-gc-off-");
    const store = new SessionStore({ dir, debounceMs: 500 });
    const oldSavedAt = Date.now() - 10 * DAY;
    const fDel = writeFile(dir, "anthropic/host_off.json", JSON.stringify(envelope("gc-off", oldSavedAt, { metadata: { rawInputTokens: 5000 } })), 10);
    await withEnv({ BILI_SESSION_GC: undefined }, async () => {
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 0, "unset env → disabled by default");
        assert.ok(existsSync(fDel));
    });
    await withEnv({ BILI_SESSION_GC: "off" }, async () => {
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 0, "explicit off → disabled");
        assert.ok(existsSync(fDel));
    });
});

test("gcSessionFiles: decodes encrypted (BILIENC1) files before judging eligibility", async () => {
    const keyHex = "ab".repeat(32);
    await withEnv({ BILI_ENCRYPTION_KEY: keyHex, BILI_SESSION_GC: "1" }, async () => {
        const dir = tmpDir("bili-gc-enc-");
        const store = new SessionStore({ dir, debounceMs: 500 });
        const codec = createStorageCodec({ key: parseEncryptionKey(keyHex) })!;
        const oldSavedAt = Date.now() - 10 * DAY;
        const fEnc = writeFile(dir, "anthropic/host_enc.json", codec.encode(JSON.stringify(envelope("gc-enc", oldSavedAt, { metadata: { rawInputTokens: 1234 } }))), 10);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 1, JSON.stringify(res));
        assert.ok(!existsSync(fEnc));
    });
});

test("readRawFile: format-agnostic — plain JSON parses, codec frames decode, garbage is null (GC keeps)", async () => {
    const keyHex = "cd".repeat(32);
    await withEnv({ BILI_ENCRYPTION_KEY: keyHex, BILI_SESSION_GC: "1" }, async () => {
        const dir = tmpDir("bili-gc-raw-");
        const store = new SessionStore({ dir, debounceMs: 500 });
        const codec = createStorageCodec({ key: parseEncryptionKey(keyHex) })!;

        const plain = writeFile(dir, "anthropic/host_plain.json", JSON.stringify(envelope("gc-raw-plain", 1, {})), 10);
        const framed = writeFile(dir, "anthropic/host_framed.json", codec.encode(JSON.stringify(envelope("gc-raw-framed", 1, {}))), 10);
        const garbage = writeFile(dir, "anthropic/host_garbage.json", "BILIZSTD1\u0000not-really-zstd", 10);

        const a = await store.readRawFile(plain);
        assert.ok(a && typeof a === "object", "plain JSON reads without codec framing");
        const b = await store.readRawFile(framed);
        assert.ok(b && typeof b === "object", "codec-framed file decodes via fallback (any future frame, not just BILIENC1)");
        const c = await store.readRawFile(garbage);
        assert.equal(c, null, "unknown frame that the codec cannot decode → null, never a wrong parse");

        // GC side: the garbage file must be counted unreadable and left in place.
        utimesSync(garbage, new Date(Date.now() - 10 * DAY), new Date(Date.now() - 10 * DAY));
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 2, JSON.stringify(res));
        assert.ok(!existsSync(plain) && !existsSync(framed));
        assert.ok(existsSync(garbage), "unreadable unknown-frame file never deleted");
    });
});

test("gcSessionFiles: resident fresh sessions are kept; idle residents are dropped and deleted", async () => {
    const dir = tmpDir("bili-gc-res-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        _setStoreForTest(store);
        const oldSavedAt = Date.now() - 10 * DAY;
        const fFresh = writeFile(dir, "anthropic/host_fresh.json", JSON.stringify(envelope("gc-res-fresh", oldSavedAt, { metadata: { rawInputTokens: 5000 } })), 10);
        const fIdle = writeFile(dir, "anthropic/host_idle.json", JSON.stringify(envelope("gc-res-idle", oldSavedAt, { metadata: { rawInputTokens: 5000 } })), 10);
        getSession("gc-res-fresh", { protocol: "openai", upstreamOrigin: "https://x.example" });
        getSession("gc-res-idle", { protocol: "openai", upstreamOrigin: "https://x.example" });
        peekSession("gc-res-idle")!.lastSeen = oldSavedAt;

        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 1, JSON.stringify(res));
        assert.ok(existsSync(fFresh), "fresh resident kept on disk");
        assert.ok(peekSession("gc-res-fresh"), "fresh resident stays in memory");
        assert.ok(!existsSync(fIdle), "idle resident deleted");
        assert.equal(peekSession("gc-res-idle"), undefined, "idle resident dropped from map");
    });
});

test("gcSessionFiles: pending in-memory saves are not deleted before they land", async () => {
    const dir = tmpDir("bili-gc-pend-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 60_000 });
        _setStoreForTest(store);
        const oldSavedAt = Date.now() - 10 * DAY;
        const fPend = writeFile(dir, "anthropic/host_pend.json", JSON.stringify(envelope("gc-pend", oldSavedAt, { metadata: { rawInputTokens: 5000 } })), 10);
        const s = getSession("gc-pend", { protocol: "openai", upstreamOrigin: "https://x.example" });
        s.lastSeen = oldSavedAt;
        markDirty(s);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 0, JSON.stringify(res));
        assert.ok(existsSync(fPend));
        store.cancelAll();
    });
});

test("gcSessionFiles: stale CCR session co-deletes its content-store companion (#1180)", async () => {
    const dir = tmpDir("bili-gc-crs-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        const oldSavedAt = Date.now() - 10 * DAY;
        const fSess = writeFile(dir, "anthropic/host_crs.json", JSON.stringify(envelope("gc-crs", oldSavedAt, { metadata: { rawInputTokens: 5000 } })), 10);
        const fCmp = contentStoreFile(dir, "anthropic/host_crs.content-store.json", 8000, 10);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 1, JSON.stringify(res));
        assert.equal(res.companionsRemoved, 1, JSON.stringify(res));
        assert.ok(!existsSync(fSess));
        assert.ok(!existsSync(fCmp), "companion co-deleted — no orphan left behind");
    });
});

test("gcSessionFiles: live session keeps its companion even when the companion is old (#1180)", async () => {
    const dir = tmpDir("bili-gc-live-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        const fSess = writeFile(dir, "anthropic/host_live.json", JSON.stringify(envelope("gc-live", Date.now() - DAY, { metadata: { rawInputTokens: 5000 } })), 1);
        // Companion last written 10 days ago (long idle tail) but still referenced.
        const fCmp = contentStoreFile(dir, "anthropic/host_live.content-store.json", 8000, 10);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 0, JSON.stringify(res));
        assert.equal(res.companionsRemoved, 0, JSON.stringify(res));
        assert.ok(existsSync(fSess));
        assert.ok(existsSync(fCmp), "referenced companion never orphan-swept");
    });
});

test("gcSessionFiles: companion in another namespace than its session is still referenced (#1180)", async () => {
    const dir = tmpDir("bili-gc-xns-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        // Session re-homed to the namespaced layout (meta fill-once) while a
        // store copy from before the move sits in _unknown/, aged out.
        const stem = "deadbeefcafe1234";
        const fSess = writeFile(dir, `anthropic/api.example.com_${stem}.json`, JSON.stringify(envelope(`gc-xns-${stem}`, Date.now() - DAY, { metadata: { rawInputTokens: 5000 } })), 1);
        const fCmp = contentStoreFile(dir, `_unknown/${stem}.content-store.json`, 8000, 10);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 0, JSON.stringify(res));
        assert.equal(res.companionsRemoved, 0, JSON.stringify(res));
        assert.ok(existsSync(fSess));
        assert.ok(existsSync(fCmp), "hash-stem match across namespaces prevents false-orphan deletion of live store bytes");
    });
});

test("gcSessionFiles: stale duplicate keeps its companion while a namespaced twin still relies on it (#1180)", async () => {
    const dir = tmpDir("bili-gc-twin-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        // Meta fill-once migrated the session _unknown/ -> namespaced without
        // cleaning the old path; the store was never re-saved since the move
        // (saveContentStore only writes when dirty), so the _unknown/ sibling
        // is still the LIVE store — loadContentStore falls back to it when
        // the namespaced one is absent.
        const stem = "twinbeefcafe1234";
        const fDup = writeFile(dir, `_unknown/${stem}.json`, JSON.stringify(envelope(`gc-twin-${stem}`, Date.now() - 10 * DAY, { metadata: { rawInputTokens: 5000 } })), 10);
        const fTwin = writeFile(dir, `anthropic/api.example.com_${stem}.json`, JSON.stringify(envelope(`gc-twin-${stem}`, Date.now() - DAY, { metadata: { rawInputTokens: 5000 } })), 1);
        const fCmp = contentStoreFile(dir, `_unknown/${stem}.content-store.json`, 8000, 10);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 1, JSON.stringify(res));
        assert.equal(res.companionsRemoved, 0, JSON.stringify(res));
        assert.ok(!existsSync(fDup), "stale duplicate deleted");
        assert.ok(existsSync(fTwin), "live twin untouched");
        assert.ok(existsSync(fCmp), "live fallback store of the surviving twin is never co-deleted");
    });
});

test("gcSessionFiles: stale duplicate's companion IS co-deleted once the twin owns its own store (#1180)", async () => {
    const dir = tmpDir("bili-gc-twinown-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        // The store was re-saved after the namespace move: the namespaced copy
        // shadows the flat one (loadContentStore stops at the first existing
        // candidate), so the flat sibling is dead bytes and co-deletion is safe.
        const stem = "twincafedeadbeef";
        const fDup = writeFile(dir, `_unknown/${stem}.json`, JSON.stringify(envelope(`gc-twinown-${stem}`, Date.now() - 10 * DAY, { metadata: { rawInputTokens: 5000 } })), 10);
        const fTwin = writeFile(dir, `anthropic/api.example.com_${stem}.json`, JSON.stringify(envelope(`gc-twinown-${stem}`, Date.now() - DAY, { metadata: { rawInputTokens: 5000 } })), 1);
        const fDead = contentStoreFile(dir, `_unknown/${stem}.content-store.json`, 8000, 10);
        const fLive = contentStoreFile(dir, `anthropic/api.example.com_${stem}.content-store.json`, 8000, 1);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 1, JSON.stringify(res));
        assert.equal(res.companionsRemoved, 1, JSON.stringify(res));
        assert.ok(!existsSync(fDup));
        assert.ok(existsSync(fTwin));
        assert.ok(!existsSync(fDead), "shadowed dead copy co-deleted with its duplicate");
        assert.ok(existsSync(fLive), "the live namespaced store stays referenced");
    });
});

test("gcSessionFiles: both copies eligible → whole session incl. its lone store is swept (#1180)", async () => {
    const dir = tmpDir("bili-gc-twogone-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        // Both copies aged out; the lone store sits next to the flat duplicate.
        // Whichever copy is processed first, the sweep ends with everything
        // gone: if the duplicate goes first the guard keeps the store, then
        // the twin deletion leaves it an unreferenced orphan swept in the
        // same pass; if the twin goes first the duplicate's sibling has no
        // surviving reference-holder left and is co-deleted directly.
        const stem = "twogonecafe1234";
        const fDup = writeFile(dir, `_unknown/${stem}.json`, JSON.stringify(envelope(`gc-twogone-${stem}`, Date.now() - 10 * DAY, { metadata: { rawInputTokens: 5000 } })), 10);
        const fTwin = writeFile(dir, `anthropic/api.example.com_${stem}.json`, JSON.stringify(envelope(`gc-twogone-${stem}`, Date.now() - 10 * DAY, { metadata: { rawInputTokens: 5000 } })), 10);
        const fCmp = contentStoreFile(dir, `_unknown/${stem}.content-store.json`, 8000, 10);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 2, JSON.stringify(res));
        assert.equal(res.companionsRemoved, 1, JSON.stringify(res));
        assert.ok(!existsSync(fDup) && !existsSync(fTwin) && !existsSync(fCmp));
    });
});

test("gcSessionFiles: orphaned content stores are swept once old, fresh ones kept (#1180)", async () => {
    const dir = tmpDir("bili-gc-orph-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        const fOld = contentStoreFile(dir, "anthropic/host_orph_old.content-store.json", 8000, 10);
        const fFresh = contentStoreFile(dir, "anthropic/host_orph_fresh.content-store.json", 8000, 1);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 0, "no session files were removed");
        assert.equal(res.companionsRemoved, 1, JSON.stringify(res));
        assert.ok(!existsSync(fOld), "aged orphan swept");
        assert.ok(existsSync(fFresh), "fresh orphan kept (still inside any resume window)");
    });
});

test("gcSessionFiles: tiny session with a huge store does not slip under the token gate (#1180)", async () => {
    const dir = tmpDir("bili-gc-hugestore-");
    await withEnv({ BILI_SESSION_GC: "1", BILI_SESSION_GC_MAX_TOKENS: "1000" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        const oldSavedAt = Date.now() - 10 * DAY;
        const fSmall = writeFile(dir, "anthropic/host_small.json", JSON.stringify(envelope("gc-small", oldSavedAt, { metadata: { rawInputTokens: 500 } })), 10);
        const fBigStore = writeFile(dir, "anthropic/host_bigstore.json", JSON.stringify(envelope("gc-bigstore", oldSavedAt, { metadata: { rawInputTokens: 500 } })), 10);
        const fCmp = contentStoreFile(dir, "anthropic/host_bigstore.content-store.json", 8000, 10);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 1, JSON.stringify(res));
        assert.equal(res.companionsRemoved, 0, JSON.stringify(res));
        assert.ok(!existsSync(fSmall), "same-size session without a store is deleted");
        assert.ok(existsSync(fBigStore), "store footprint (2000tok) + 500tok exceeds the 1000tok gate");
        assert.ok(existsSync(fCmp));
    });
});

test("gcSessionFiles: unreadable companion next to an eligible session keeps both (#1180)", async () => {
    const dir = tmpDir("bili-gc-badcmp-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        const oldSavedAt = Date.now() - 10 * DAY;
        const fSess = writeFile(dir, "anthropic/host_badcmp.json", JSON.stringify(envelope("gc-badcmp", oldSavedAt, { metadata: { rawInputTokens: 5000 } })), 10);
        const fCmp = writeFile(dir, "anthropic/host_badcmp.content-store.json", "{not json", 10);
        const res = await gcSessionFiles({ dir, store, now: Date.now() });
        assert.equal(res.removed, 0, JSON.stringify(res));
        assert.equal(res.unreadable, 0, "the session file itself parsed fine");
        assert.ok(existsSync(fSess), "never guess at an unreadable companion — keep the session too");
        assert.ok(existsSync(fCmp));
    });
});

test("records rawInputTokens per turn and persists it (#1082)", async () => {
    const dir = tmpDir("bili-gc-rec-");
    await withEnv({ BILI_SESSIONS_DIR: dir, BILI_SESSION_GC: "0" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 10 });
        _setStoreForTest(store);
        setRegistryForTest({});
        const upstream = http.createServer((req, res) => {
            req.resume();
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "r1",
                    object: "chat.completion",
                    created: 1,
                    model: "gpt-test",
                    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
                }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;
        const opts: ProxyOptions = {
            port: 0,
            proxy: "",
            proxyFallback: { explicitDirect: true, globalSource: "direct" },
            auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
            modelContextLimit: 400_000,
            kernelConfig: defaultConfig(400_000),
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            compat: { roles: {} },
            passthroughSource: null,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            streamErrorShape: "protocol",
            advisoryCheck: false,
            releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        const proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        try {
            const big = "x".repeat(5000);
            const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "gc-rec-integration" },
                body: JSON.stringify({ model: "gpt-test", messages: [{ role: "system", content: "sys" }, { role: "user", content: big }] }),
            });
            assert.equal(resp.status, 200);
            await resp.arrayBuffer();
            const sess = peekSession("gc-rec-integration");
            assert.ok(sess, "session present after request");
            const raw = sess!.metadata.rawInputTokens;
            assert.ok(typeof raw === "number" && raw > 1000, `rawInputTokens recorded, got ${String(raw)}`);

            // Image-bearing turn: the GC signal must include image tokens —
            // image bytes ride every re-send, so an image-heavy idle session
            // must not look cheap to the sweep.
            const png = "iVBORw0KGgo=" + "A".repeat(4000);
            const imgBody = { model: "gpt-test", messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64," + png } }] }] };
            const resp2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "gc-rec-integration" },
                body: JSON.stringify(imgBody),
            });
            assert.equal(resp2.status, 200);
            await resp2.arrayBuffer();
            const expected = estimateRawBodyTokens(imgBody) + imageTokensInParsedBody("openai", imgBody);
            const raw2 = sess!.metadata.rawInputTokens;
            assert.ok(typeof raw2 === "number" && raw2 >= expected, `image turn records text+image (want >= ${expected}, got ${String(raw2)})`);
            // #1208: a debounced save from an earlier turn can still be in flight
            // here; drain it so its stale rename cannot land after this read.
            await store.flushAll([]);
            assert.ok(store.flushSync(sess as Session), "flush lands the session file");
            const file = findSessionFile(dir, "gc-rec-integration");
            assert.ok(file, "session file written to disk");
            const parsed = JSON.parse(readFileSync(file, "utf8")) as { payload?: { metadata?: Record<string, unknown> } };
            assert.equal(parsed.payload?.metadata?.rawInputTokens, raw2, "recorded value survives persistence round-trip");
        } finally {
            await closeServer(proxy);
            await closeServer(upstream);
            _setStoreForTest(new SessionStore({ enabled: false }));
        }
    });
});

test("gcSessionFiles: session deletion co-deletes its image spill dir; stale spill dirs swept by mtime (#1995)", async () => {
    const dir = tmpDir("bili-gc-img-");
    const imgRoot = tmpDir("bili-gc-imgroot-");
    await withEnv({ BILI_SESSION_GC: "1" }, async () => {
        const store = new SessionStore({ dir, debounceMs: 500 });
        const oldSavedAt = Date.now() - 10 * DAY;
        const fDel = writeFile(dir, "anthropic/host_del.json", JSON.stringify(envelope("gc-img-1", oldSavedAt, { metadata: { rawInputTokens: 5000 } })), 10);
        // Spill dir for the deleted session, FRESH mtime — the deterministic
        // co-delete (session id → dir name) must take it despite the age gate.
        const spill = path.join(imgRoot, restoreExportDirName("gc-img-1"));
        mkdirSync(spill, { recursive: true });
        writeFileSync(path.join(spill, "m00002.png"), "x");
        // Orphaned stale dir (no session at all), backdated past the age gate.
        const orphan = path.join(imgRoot, "old-lane");
        mkdirSync(orphan, { recursive: true });
        writeFileSync(path.join(orphan, "m00001.png"), "x");
        const old = new Date(Date.now() - 30 * DAY);
        utimesSync(orphan, old, old);
        // Fresh orphan (recent mtime) — kept; live sessions keep their spills.
        const fresh = path.join(imgRoot, "fresh-lane");
        mkdirSync(fresh, { recursive: true });
        writeFileSync(path.join(fresh, "m00001.png"), "x");

        const res = await gcSessionFiles({ dir, store, now: Date.now(), imgRoot });
        assert.equal(res.removed, 1);
        assert.equal(res.imgDirsRemoved, 2, `co-delete + stale orphan, got ${JSON.stringify(res)}`);
        assert.ok(!existsSync(fDel));
        assert.ok(!existsSync(spill), "spill dir co-deleted with its session despite fresh mtime");
        assert.ok(!existsSync(orphan), "stale orphan swept");
        assert.ok(existsSync(fresh), "fresh spill dir kept");
    });
});
