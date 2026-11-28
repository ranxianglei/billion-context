import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialState, storeOriginal } from 'acp-kernel';
import { SessionStore } from '../src/persist.ts';
import { UnifiedShadow } from '../src/storage/shadow.ts';
import { UnifiedStore } from '../src/storage/store.ts';
import { type Session } from '../src/session.ts';
import { rmrf } from './tmp-rm.ts';

const root = mkdtempSync(join(tmpdir(), 'bili-index-resident-'));
function loadWithOriginals(store: SessionStore, original: Session): Session | null {
    const loaded = store.loadSync(original.id, original.meta);
    if (loaded) loaded.contentStore = store.loadContentStore(loaded) ?? undefined;
    return loaded;
}
process.env.BILI_CONFIG_FILE = join(root, 'no-config.json');
process.env.BILI_PERSIST_ZSTD = '0';
test.after(() => rmrf(root));

function fixture(id: string): Session {
    const original = 'opaque signed original λ\u0000';
    const hash = createHash('sha256').update(original).digest('hex');
    return { id, meta: { protocol: 'openai', upstreamOrigin: 'http://upstream' },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
            cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0,
            storeBytesSaved: 0, rangeRestores: 0 },
        state: createInitialState(), metadata: { exact: 'metadata' }, createdAt: 1, lastSeen: 2,
        inFlight: 0, persisted: false, pendingRetrievals: [],
        blockContents: new Map([['orphan', { one: null, full: { text: original, count: 3 } }]]),
        contentStore: { version: 1, byHash: { [hash]: original }, byRef: {
            m00001: { rawId: 'raw', hash, head: 'opaque', kind: 'tool', tokens: 5, chars: original.length },
        } }, contentStoreDirty: true };
}

for (const inFlight of [0, 1]) {
test(`a stale resident save preserves another SQL writer same-counter originals (inFlight=${inFlight})`, async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'foreign-originals-'));
    const first = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const a = fixture('shared');
    a.inFlight = inFlight;
    let second: SessionStore | undefined;
    try {
        await first.writeNow(a);
        second = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
        const b = loadWithOriginals(second, a);
        assert.ok(b?.contentStore);
        b.contentStore = storeOriginal(b.contentStore, { ref: 'm00002', rawId: 'foreign',
            text: 'Exact foreign original λ\u0000', kind: 'tool', tokens: 8, head: 'foreign' });
        b.contentStoreDirty = true;
        assert.equal(b.stats.requests, a.stats.requests);
        assert.equal(b.state.nextBlockId, a.state.nextBlockId);
        await second.writeNow(b);
        const expected = structuredClone(second.unifiedCcrFor(a.id));
        await first.writeNow(a);
        assert.deepEqual(first.unifiedCcrFor(a.id), expected,
            'same-counter external originals must survive a stale resident save');
    } finally { second?.closeQuietly(); first.closeQuietly(); }
});
}

for (const replacement of [false, true]) {
test(`a stale in-flight writer cannot resurrect originals after an external reset (replacement=${replacement})`, async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'foreign-reset-'));
    const first = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const a = fixture('shared-reset');
    a.inFlight = 1;
    let second: SessionStore | undefined;
    try {
        await first.writeNow(a);
        second = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
        const b = loadWithOriginals(second, a);
        assert.ok(b);
        b.contentStore = undefined;
        b.contentStoreDirty = true;
        b.revisionEpoch = (b.revisionEpoch ?? 0) + 1;
        await second.writeNow(b);
        const cleared = structuredClone(second.unifiedCcrFor(a.id));
        assert.deepEqual(cleared, { version: 1, byHash: {}, byRef: {} });
        if (replacement) {
            b.contentStore = storeOriginal({ version: 1, byHash: {}, byRef: {} }, {
                ref: 'm00001', rawId: 'replacement-generation', text: 'Replacement opaque original Ω\u0000',
                kind: 'tool', tokens: 9, head: 'replacement',
            });
            b.contentStoreDirty = true;
            b.revisionEpoch = (b.revisionEpoch ?? 0) + 1;
            await second.writeNow(b);
        }
        const winning = structuredClone(second.unifiedCcrFor(a.id));
        await assert.rejects(first.writeNow(a), /generation|conflict/i);
        assert.deepEqual(first.unifiedCcrFor(a.id), winning, 'stale originals must not resurrect after reset');
        assert.ok(a.contentStore?.byRef.m00001, 'refused writer must retain its unsaved resident evidence');
    } finally { second?.closeQuietly(); first.closeQuietly(); }
});
}

test('an outer commit failure preserves pending originals and publishes no ownership until retry', async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'foreign-commit-fault-'));
    const first = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const a = fixture('shared-commit-fault');
    a.inFlight = 1;
    let second: SessionStore | undefined;
    const exec = DatabaseSync.prototype.exec;
    try {
        await first.writeNow(a);
        second = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
        const b = loadWithOriginals(second, a);
        assert.ok(b?.contentStore);
        b.contentStore = storeOriginal(b.contentStore, { ref: 'm00002', rawId: 'foreign',
            text: 'External original λ\u0000', kind: 'tool', tokens: 8, head: 'external' });
        b.contentStoreDirty = true;
        await second.writeNow(b);
        const before = structuredClone(second.unifiedCcrFor(a.id));
        assert.ok(before);
        const added = { ref: 'm00003', rawId: 'pending-local', text: 'Pending local original Ω\u0000', kind: 'tool', tokens: 9, head: 'pending' };
        assert.ok(a.contentStore);
        a.contentStore = storeOriginal(a.contentStore, added);
        a.contentStoreDirty = true;
        let published = 0;
        first.setSessionCommitListener(() => { published++; });
        let faults = 0;
        DatabaseSync.prototype.exec = function (sql: string) {
            if (sql === 'COMMIT' && faults++ === 0) throw new Error('injected outer commit failure');
            return exec.call(this, sql);
        };
        await assert.rejects(first.writeNow(a), /injected outer commit failure/);
        DatabaseSync.prototype.exec = exec;
        assert.equal(faults, 1, 'the fault must reach the actual outer COMMIT');
        assert.equal(published, 0, 'a rolled-back transaction must not publish ownership');
        assert.deepEqual(first.unifiedCcrFor(a.id), before, 'failed commit must leave the external durable store exact');
        assert.ok(a.contentStoreDirty, 'pending originals must remain dirty after failure');
        assert.ok(a.contentStore?.byRef.m00003, 'pending local original must remain resident');
        await first.writeNow(a);
        assert.deepEqual(first.unifiedCcrFor(a.id), storeOriginal(before, added));
        assert.equal(published, 1);
        assert.equal(a.contentStoreDirty, false);
    } finally { DatabaseSync.prototype.exec = exec; second?.closeQuietly(); first.closeQuietly(); }
});

for (const kind of ['malformed', 'null', 'empty', 'binding', 'CAS', 'body']) {
test(`a fresh writer refuses an unreadable originals mirror with durable bindings (${kind})`, async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'unreadable-originals-'));
    const seed = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const pending = fixture('unreadable-originals');
    await seed.writeNow(pending);
    seed.closeQuietly();
    const db = new DatabaseSync(join(dir, 'index.db'));
    let writer: SessionStore | undefined;
    try {
        assert.equal(Number(db.prepare('SELECT count(*) AS n FROM ccr_entries WHERE session_id=?').get(pending.id)?.n), 1);
        let corrupt = db.prepare('SELECT ccr_json FROM sessions WHERE session_id=?').get(pending.id)?.ccr_json as string | null;
        if (kind === 'malformed') corrupt = 'not valid JSON';
        if (kind === 'null') corrupt = null;
        if (kind === 'empty') corrupt = JSON.stringify({ version: 1, byHash: {}, byRef: {} });
        if (kind === 'binding') {
            assert.ok(corrupt);
            const changed = JSON.parse(corrupt);
            changed.byRef.m00099 = { hash: '0000000000000000000000000000000000000000000000000000000000000000' };
            corrupt = JSON.stringify(changed);
        }
        db.prepare('UPDATE sessions SET ccr_json=? WHERE session_id=?').run(corrupt, pending.id);
        if (kind === 'CAS') db.prepare(`UPDATE content SET bytes=? WHERE hash IN
            (SELECT content_hash FROM ccr_entries WHERE session_id=?)`).run(Buffer.from('changed binding bytes'), pending.id);
        if (kind === 'body') db.prepare(`UPDATE content SET bytes=? WHERE hash IN
            (SELECT orig_hash FROM ccr_entries WHERE session_id=?)`).run(Buffer.from('changed original bytes'), pending.id);
        const bindings = db.prepare('SELECT * FROM ccr_entries WHERE session_id=?').all(pending.id);
        const bodies = db.prepare(`SELECT c.hash, c.bytes FROM content c JOIN ccr_entries e
            ON c.hash=e.content_hash WHERE e.session_id=?`).all(pending.id);
        writer = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
        assert.throws(() => writer!.loadContentStore(pending), /unreadable|missing CCR/,
            'unreadable authoritative SQL originals must not degrade to an empty or legacy read');
        assert.ok(pending.contentStore);
        pending.contentStore = storeOriginal(pending.contentStore, { ref: 'm00002', rawId: 'new-after-corruption',
            text: 'New exact pending original Ω\u0000', kind: 'tool', tokens: 7, head: 'pending' });
        pending.contentStoreDirty = true;
        await assert.rejects(writer.writeNow(pending), /unreadable|missing CCR/,
            'unreadable authoritative originals must not be replaced by a fresh writer');
        assert.equal(db.prepare('SELECT ccr_json FROM sessions WHERE session_id=?').get(pending.id)?.ccr_json, corrupt);
        assert.deepEqual(db.prepare('SELECT * FROM ccr_entries WHERE session_id=?').all(pending.id), bindings);
        assert.deepEqual(db.prepare(`SELECT c.hash, c.bytes FROM content c JOIN ccr_entries e
            ON c.hash=e.content_hash WHERE e.session_id=?`).all(pending.id), bodies);
        assert.equal(pending.contentStoreDirty, true);
    } finally { writer?.closeQuietly(); db.close(); }
});
}

test('a writer advancing after the stale check is refused at the atomic commit boundary', async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'foreign-counter-race-'));
    const first = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const a = fixture('shared-counter-race');
    a.inFlight = 1;
    let second: SessionStore | undefined;
    const record = UnifiedShadow.prototype.record;
    let competing: Promise<void> | undefined;
    try {
        await first.writeNow(a);
        second = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
        const b = loadWithOriginals(second, a);
        assert.ok(b?.contentStore);
        b.contentStore = storeOriginal(b.contentStore, { ref: 'm00002', rawId: 'advanced',
            text: 'Advanced original Ω\u0000', kind: 'tool', tokens: 9, head: 'advanced' });
        b.contentStoreDirty = true;
        b.stats.requests++;
        let injected = false;
        let published = 0;
        first.setSessionCommitListener(() => { published++; });
        const other = second;
        UnifiedShadow.prototype.record = function (...args) {
            if (!injected && args[4]) {
                injected = true;
                competing = other.writeNow(b); // writer-off executes synchronously
            }
            return record.apply(this, args);
        };
        await assert.rejects(first.writeNow(a), /session generation advanced|SQLite ownership changed/);
        UnifiedShadow.prototype.record = record;
        await competing;
        assert.ok(injected, 'competing commit must land after the host stale check');
        assert.equal(published, 0);
        assert.deepEqual(first.unifiedCcrFor(a.id), second.unifiedCcrFor(a.id));
        assert.ok(first.unifiedCcrFor(a.id)?.byRef.m00002);
    } finally { UnifiedShadow.prototype.record = record; second?.closeQuietly(); first.closeQuietly(); }
});

test('a newer request may intentionally reset block numbering and originals', async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'newer-reset-'));
    const first = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const a = fixture('newer-reset');
    a.inFlight = 1;
    a.state.nextBlockId = 2;
    try {
        await first.writeNow(a);
        a.state = createInitialState();
        a.contentStore = undefined;
        a.contentStoreDirty = true;
        a.stats.requests++;
        a.revisionEpoch = (a.revisionEpoch ?? 0) + 1;
        await first.writeNow(a);
        assert.deepEqual(first.unifiedCcrFor(a.id), { version: 1, byHash: {}, byRef: {} });
    } finally { first.closeQuietly(); }
});

test('the originals read and ingest exclude a competing SQLite writer in one transaction', async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'foreign-atomic-lock-'));
    const first = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const a = fixture('shared-atomic-lock');
    a.inFlight = 1;
    let outsider: DatabaseSync | undefined;
    const record = UnifiedShadow.prototype.record;
    const getCcr = UnifiedStore.prototype.getCcr;
    try {
        await first.writeNow(a);
        outsider = new DatabaseSync(join(dir, 'index.db'));
        outsider.exec('PRAGMA busy_timeout = 0');
        outsider.exec('UPDATE sessions SET updated_at = updated_at + 1');
        let armed = false;
        let attempted = false;
        UnifiedShadow.prototype.record = function (...args) {
            if (args[4]) armed = true;
            return record.apply(this, args);
        };
        const connection = outsider;
        UnifiedStore.prototype.getCcr = function (...args) {
            const current = getCcr.apply(this, args);
            if (armed) {
                armed = false;
                attempted = true;
                try {
                    assert.throws(() => connection.exec('BEGIN IMMEDIATE'), /locked|busy/i,
                        'a second writer must be excluded after the originals read and before ingest');
                } finally {
                    try { connection.exec('ROLLBACK'); } catch { /* no transaction when correctly locked */ }
                }
            }
            return current;
        };
        await first.writeNow(a);
        assert.ok(attempted, 'the lock control must reach the actual durable-originals read');
    } finally {
        UnifiedShadow.prototype.record = record;
        UnifiedStore.prototype.getCcr = getCcr;
        outsider?.close();
        first.closeQuietly();
    }
});

test('changed original bytes under an unchanged hash are refused', async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'invalid-original-'));
    const first = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const a = fixture('invalid-original');
    a.inFlight = 1;
    try {
        await first.writeNow(a);
        const durable = structuredClone(first.unifiedCcrFor(a.id));
        assert.ok(a.contentStore);
        const hash = a.contentStore.byRef.m00001.hash;
        a.contentStore.byHash[hash] = 'Changed bytes under an unchanged hash';
        a.contentStoreDirty = true;
        await assert.rejects(first.writeNow(a), /invalid content hash/);
        assert.deepEqual(first.unifiedCcrFor(a.id), durable);
        assert.equal(a.contentStoreDirty, true);
    } finally { first.closeQuietly(); }
});

test('ownership cannot adopt a foreign commit landing immediately after its COMMIT', async () => {
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const dir = mkdtempSync(join(root, 'owned-version-stamp-race-'));
    const first = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
    const a = fixture('owned-version-stamp-race');
    a.inFlight = 1;
    const exec = DatabaseSync.prototype.exec;
    let second: SessionStore | undefined;
    let competing: Promise<void> | undefined;
    try {
        await first.writeNow(a);
        let armed = true;
        DatabaseSync.prototype.exec = function (sql: string) {
            const result = exec.call(this, sql);
            if (sql === 'COMMIT' && armed) {
                armed = false;
                second = new SessionStore({ dir, enabled: true, debounceMs: 1, log: () => {} });
                const b = loadWithOriginals(second, a);
                assert.ok(b?.contentStore);
                b.contentStore = storeOriginal(b.contentStore, { ref: 'm00002', rawId: 'after-commit',
                    text: 'Foreign commit after lock release Ω\u0000', kind: 'tool', tokens: 9, head: 'foreign' });
                b.contentStoreDirty = true;
                competing = second.writeNow(b);
            }
            return result;
        };
        await first.writeNow(a);
        DatabaseSync.prototype.exec = exec;
        assert.ok(competing, 'the foreign commit must land inside the post-COMMIT stamping window');
        await competing;
        assert.ok(first.unifiedCcrFor(a.id)?.byRef.m00002);
        await first.writeNow(a);
        assert.ok(first.unifiedCcrFor(a.id)?.byRef.m00002, 'the next save must not erase the foreign original');
    } finally { DatabaseSync.prototype.exec = exec; second?.closeQuietly(); first.closeQuietly(); }
});
