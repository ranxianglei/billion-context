// #5219 regression gate: bounded boot must not decode the whole corpus pre-listen.
//
// The #3199 parse window stops when candidates >= maxSessions AND bytes >= maxBytes.
// When neither term binds — maxSessions=0 (the sessionWarmMax() default) or a corpus
// of many small files under a large byte budget — the old loop decoded every file
// synchronously before listen, then popped the candidates away in the savedAt-desc
// trim anyway. On a store that grows to thousands of files this exceeds the dsh
// launcher's 60s health budget and the spawn-kill loop follows (#5219). These gates
// pin the decoded-file-count cap: zero decodes when nothing survives the trim, a
// bounded multiple of the warm-set size otherwise, and unchanged behavior when the
// cap never binds.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, _setStoreForTest, relPathFor } from "../src/persist.ts";
import { createSession, _resetSessionsForTest } from "../src/session.ts";

type DecodeProbe = {
    readRawFileWithBytes(file: string): Promise<{ value: unknown; bytes: number } | null>;
};

async function fixture(run: (dir: string, store: SessionStore) => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5219-"));
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

async function withUnified(run: () => Promise<void>): Promise<void> {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try { await run(); }
    finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
    }
}

/** Count readRawFileWithBytes invocations on this instance. Only the boot parse
 *  window (and the post-listen background scan) decode through it — loadSync and
 *  the sweep paths do not. Reading the count immediately after boot() resolves
 *  measures the window total plus at most a handful of background-scan stragglers
 *  (boot's post-window awaits can admit a few fs I/O callbacks before returning),
 *  so the gates assert bounds calibrated to that: the degenerate old loop decoded
 *  the WHOLE corpus here, which no bound admits. */
function countDecodes(store: SessionStore): { count(): number; restore(): void } {
    const probe = store as unknown as DecodeProbe;
    const real = probe.readRawFileWithBytes.bind(store);
    let n = 0;
    probe.readRawFileWithBytes = async (file: string) => { n += 1; return real(file); };
    return {
        count: () => n,
        restore: () => { probe.readRawFileWithBytes = real; },
    };
}

test("#5219: default-config bounded boot (maxSessions=0) performs zero pre-listen decodes", async () => {
    await withUnified(() => fixture(async (_dir, store) => {
        for (let i = 0; i < 100; i++) {
            const s = createSession(`s5219a-${i}`);
            await store.writeNow(s);
        }
        const meter = countDecodes(store);
        try {
            const loaded = await store.boot({ maxSessions: 0, maxBytes: 64 * 1024 * 1024 });
            // The degenerate case: the old window loop decoded all 100 files here
            // (the count stop-term is vacuous at maxSessions=0), then popped them
            // all in the savedAt-desc trim. Nothing may be decoded pre-listen now —
            // the warmed set was going to be empty either way, so the work was pure
            // waste before the fix and the background scan owns bookkeeping now.
            // Bound (not equality): boot's post-window awaits can admit a handful
            // of background-scan stragglers; the old code's 100 never fits.
            assert.ok(meter.count() < 10, `pre-listen decodes=${meter.count()}`);
            assert.equal(loaded.size, 0);
        } finally { meter.restore(); }
        // Files stay lazily loadable — availability over performance.
        assert.ok(store.loadSync("s5219a-0"));
        assert.ok(store.loadSync("s5219a-99"));
    }));
});

test("#5219: bounded boot caps pre-listen decodes at a warm-set multiple", async () => {
    await withUnified(() => fixture(async (dir, store) => {
        const ids: string[] = [];
        for (let i = 0; i < 70; i++) {
            const s = createSession(`s5219b-${i}`);
            await store.writeNow(s);
            ids.push(s.id);
        }
        // Deterministic mtime-desc order: index 69 newest … 0 oldest (readdir
        // order is arbitrary on ties, so stagger explicitly).
        const base = Date.now() - 70_000;
        for (let i = 0; i < ids.length; i++) {
            const t = new Date(base + i * 1000);
            utimesSync(path.join(dir, relPathFor(ids[i])), t, t);
        }
        const meter = countDecodes(store);
        try {
            const loaded = await store.boot({ maxSessions: 4, maxBytes: 64 * 1024 * 1024 });
            // cap = max(64, 4*16) = 64: at most 64 of the 70 files may be decoded
            // in the window (plus a handful of background stragglers); the old
            // loop decoded all 70 in the window, which the upper bound rejects.
            const n = meter.count();
            assert.ok(n >= 64 && n < 70, `pre-listen decodes=${n}`);
            assert.ok(loaded.size > 0);
            assert.ok(loaded.size <= 4);
        } finally { meter.restore(); }
        // The files past the cap stay lazily loadable.
        assert.ok(store.loadSync(ids[0]));
        assert.ok(store.loadSync(ids[1]));
    }));
});

test("#5219: behavior unchanged when the cap never binds (small corpus)", async () => {
    await withUnified(() => fixture(async (_dir, store) => {
        for (let i = 0; i < 10; i++) {
            const s = createSession(`s5219c-${i}`);
            await store.writeNow(s);
        }
        const meter = countDecodes(store);
        try {
            const loaded = await store.boot({ maxSessions: 3, maxBytes: 64 * 1024 * 1024 });
            // cap = max(64, 3*16) = 64 — far above the 10-file corpus, so every
            // file is still decoded exactly as before the fix.
            assert.equal(meter.count(), 10);
            assert.ok(loaded.size > 0);
            assert.ok(loaded.size <= 3);
        } finally { meter.restore(); }
        assert.ok(store.loadSync("s5219c-0"));
        assert.ok(store.loadSync("s5219c-9"));
    }));
});
