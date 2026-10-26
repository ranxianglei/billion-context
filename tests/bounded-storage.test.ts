import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest, relPathFor } from "../src/persist.ts";
import { createSession, getSession, acquireInFlight, releaseInFlight, markDirty, listSessions, _resetSessionsForTest } from "../src/session.ts";

async function fixture(run: (dir: string, store: SessionStore) => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "bili-bounded-"));
    const dir = path.join(root, "sessions");
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _resetSessionsForTest(256, 512 * 1024 * 1024);
    _setStoreForTest(store);
    try { await run(dir, store); }
    finally {
        store.closeQuietly();
        _resetSessionsForTest(256, 512 * 1024 * 1024);
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmSync(root, { recursive: true, force: true });
    }
}

test("bounded boot retains a small warm cache and reloads older exact originals", async () => fixture(async (_dir, store) => {
    for (let i = 0; i < 30; i++) {
        const session = createSession(`bounded-${i}`, { label: `bounded-${i}` });
        session.blockContents.set("b1", { one: null, full: { text: `original-${i}-` + "x".repeat(10000), count: 1 } });
        await store.writeNow(session);
    }
    const loaded = await store.boot({ maxSessions: 3, maxBytes: 40000 });
    assert.ok(loaded.size <= 3);
    assert.equal(store.loadSync("bounded-0")?.blockContents.get("b1")?.full?.text, "original-0-" + "x".repeat(10000));
}));

test("first migration adopts legacy labels lazily while preserving historical bytes", async () => fixture(async (dir, store) => {
    const session = createSession("old-derived-id", { label: "ses_native_id" });
    session.state.messageRefs.byRaw["old-message"] = "m00001";
    session.state.messageRefs.byRef["m00001"] = "old-message";
    session.blockContents.set("b1", { one: null, full: { text: "legacy original\r\n", count: 1 } });
    await store.writeNow(session);
    const file = path.join(dir, relPathFor(session.id));
    const before = readFileSync(file);
    await store.boot({ maxSessions: 1, maxBytes: 40000 });
    const adopted = store.loadSync("ses_native_id");
    assert.equal(adopted?.id, "ses_native_id");
    assert.deepEqual(adopted?.state.messageRefs, session.state.messageRefs);
    assert.deepEqual(adopted?.blockContents.get("b1"), session.blockContents.get("b1"));
    assert.deepEqual(readFileSync(file), before);
}));

test("cold state resumes transparently; corrupt state no longer fails closed (#3157)", async () => fixture(async (dir, store) => {
    const session = createSession("ses_cold", { label: "ses_cold" });
    session.stats.requests = 42;
    await store.writeNow(session);
    const rel = relPathFor(session.id);
    const cold = `${dir}-cold`;
    mkdirSync(path.dirname(path.join(cold, rel)), { recursive: true });
    renameSync(path.join(dir, rel), path.join(cold, rel));
    await store.boot({ maxSessions: 1, maxBytes: 40000 });
    assert.equal(store.loadSync(session.id)?.stats.requests, 42);
    writeFileSync(path.join(cold, rel), "{broken");
    // #3157: a corrupt state file must not make loadSync fail closed forever.
    assert.doesNotThrow(() => store.loadSync(session.id));
}));

test("failed CCR save blocks state flush and retains dirty originals", async () => fixture(async (dir, store) => {
    const session = createSession("failed-originals", { label: "failed-originals" });
    session.stats.requests = 1;
    await store.writeNow(session);
    const rel = relPathFor(session.id);
    const before = readFileSync(path.join(dir, rel));
    mkdirSync(path.join(dir, rel.replace(/\.json$/, ".content-store.json")));
    session.stats.requests = 2;
    session.contentStoreDirty = true;
    assert.equal(store.flushSync(session), false);
    assert.equal(session.contentStoreDirty, true);
    assert.deepEqual(readFileSync(path.join(dir, rel)), before);
}));

test("bounded server reads refuse corrupt originals without replacing them", async () => fixture(async (dir, store) => {
    const session = createSession("corrupt-originals", { label: "corrupt-originals" });
    await store.writeNow(session);
    await store.boot({ maxSessions: 0, maxBytes: 0 });
    const file = path.join(dir, relPathFor(session.id).replace(/\.json$/, ".content-store.json"));
    const broken = "{truncated historical original";
    writeFileSync(file, broken);
    assert.throws(() => store.loadContentStore(session), /refusing to replace its originals/);
    assert.equal(readFileSync(file, "utf8"), broken);
}));

test("corrupt newly written live state is quarantined and yields a fresh start (#3157)", async () => fixture(async (dir, store) => {
    const session = createSession("ses_live_corrupt", { label: "ses_live_corrupt" });
    await store.writeNow(session);
    const rel = relPathFor(session.id);
    const cold = `${dir}-cold`;
    mkdirSync(path.dirname(path.join(cold, rel)), { recursive: true });
    renameSync(path.join(dir, rel), path.join(cold, rel));
    await store.boot({ maxSessions: 0, maxBytes: 0 });
    writeFileSync(path.join(dir, rel), "{broken new live state");
    // #3157: a corrupt live state used to throw on every load (a permanent 502
    // until a human deleted the file). loadSync must not throw now — the lane
    // recovers (the unified index may still serve the session, or the corrupt
    // file is quarantined and the session starts fresh). The quarantine detail
    // is pinned in tests/issue3157-persist-durability.test.ts.
    assert.doesNotThrow(() => store.loadSync(session.id));
}));

test("already-persisted sessions are retained when saving newer mutations fails", async () => fixture(async (_dir, store) => {
    _resetSessionsForTest(1);
    const session = getSession("saved-before");
    session.persisted = true;
    session.metadata.newer = "unsaved work";
    store.flushSync = () => false;
    assert.throws(() => getSession("another-session"), /pool exhausted/);
    assert.equal(getSession("saved-before"), session);
    assert.equal(session.metadata.newer, "unsaved work");
}));

test("byte budget pins active state, admits concurrent requests, and releases idle state to disk", async () => fixture(async (_dir, store) => {
    _resetSessionsForTest(256, 32000);
    const session = getSession("large-active");
    acquireInFlight(session);
    session.metadata.original = "x".repeat(20000);
    markDirty(session);
    const concurrent = getSession("concurrent-request");
    acquireInFlight(concurrent);
    assert.equal(getSession("large-active"), session);
    assert.equal(getSession("concurrent-request"), concurrent);
    assert.ok(listSessions().includes(session));
    releaseInFlight(session);
    assert.ok(!listSessions().includes(session));
    assert.equal(store.loadSync(session.id)?.metadata.original, "x".repeat(20000));
    releaseInFlight(concurrent);
}));

test("bounded boot preserves unified-first reads when the JSON copy is older", async () => {
    const previous = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        await fixture(async (dir, store) => {
            const session = createSession("ses_unified_bounded", { label: "ses_unified_bounded" });
            session.stats.requests = 9;
            session.metadata.original = "unified original\r\n";
            await store.writeNow(session);
            const file = path.join(dir, relPathFor(session.id));
            const envelope = JSON.parse(readFileSync(file, "utf8"));
            envelope.payload.stats.requests = 1;
            envelope.payload.savedAt = 1;
            writeFileSync(file, JSON.stringify(envelope));
            const warm = await store.boot({ maxSessions: 1, maxBytes: 40000 });
            assert.equal(warm.get(session.id)?.stats.requests, 9, "bounded warmup must retain the newer index record");
            await store.boot({ maxSessions: 0, maxBytes: 0 });
            const resumed = store.loadSync(session.id);
            assert.equal(resumed?.stats.requests, 9, "lazy reload still prefers the unified index");
            assert.equal(resumed?.metadata.original, "unified original\r\n");
        });
    } finally {
        if (previous === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = previous;
    }
});

test("warm budget counts decoded bytes, not compressed disk size (#2803 zstd)", async () => {
    const previous = process.env.BILI_PERSIST_ZSTD;
    process.env.BILI_PERSIST_ZSTD = "1";
    try {
        await fixture(async (_dir, store) => {
            for (let i = 0; i < 2; i++) {
                const session = createSession(`zstd-warm-${i}`, { label: `zstd-warm-${i}` });
                session.blockContents.set("b1", { one: null, full: { text: "z".repeat(60_000), count: 1 } });
                await store.writeNow(session);
            }
            // ~60 KB+ decoded per session but far less on compressed disk: a
            // budget that would fit both on disk fits at most one decoded.
            const loaded = await store.boot({ maxSessions: 8, maxBytes: 80_000 });
            assert.ok(loaded.size <= 1, `expected <=1 warmed under the decoded-byte budget, got ${loaded.size}`);
        });
    } finally {
        if (previous === undefined) delete process.env.BILI_PERSIST_ZSTD;
        else process.env.BILI_PERSIST_ZSTD = previous;
    }
});

test("legacy adoption keeps the historical file; canonical copy written beside it (#2803)", async () => fixture(async (dir, store) => {
    const session = createSession("dup-derived-id", { label: "ses_dup_label" });
    session.stats.requests = 7;
    await store.writeNow(session);
    const derived = path.join(dir, relPathFor(session.id));
    const derivedBefore = readFileSync(derived);
    await store.boot({ maxSessions: 1, maxBytes: 40000 });
    const adopted = store.loadSync("ses_dup_label");
    assert.equal(adopted?.id, "ses_dup_label");
    adopted!.stats.requests = 8;
    await store.writeNow(adopted!);
    const canonical = path.join(dir, relPathFor("ses_dup_label"));
    assert.notEqual(canonical, derived);
    assert.ok(existsSync(canonical));
    assert.deepEqual(readFileSync(derived), derivedBefore);
}));
