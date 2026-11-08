import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedStore } from '../src/storage/store.js';
import { SessionStore } from '../src/persist.js';
import { createSession, snapshotMessages } from '../src/session.js';
import { FIRST_SEEN_KEY, markFirstSeenRequest, isFirstSeenRequest, rememberFirstSeen, recoveredFirstSeen, forgetSettledFirstSeen, type StampStore } from "../src/incremental-first-seen.js";

function fixture() {
    const values = new Map<string, unknown>();
    let fail = false;
    const store: StampStore = {
        getSessionExt: (id, key) => structuredClone(values.get(`${id}:${key}`)),
        setSessionExt(id, key, value) {
            if (fail) throw new Error("injected journal commit failure");
            values.set(`${id}:${key}`, structuredClone(value));
        },
    };
    return { store, values, fail: (next: boolean) => { fail = next; } };
}

test('settled failed-request retry entries are released without another successful request', () => {
    const { store, fail } = fixture();
    for (let index = 0; index < 128; index++) {
        const id = `evicted-${index}`;
        fail(true);
        assert.throws(() => rememberFirstSeen(store, id, [{ id: 'a' }, { id: 'b' }], { a: 10, b: 20 }), /injected/);
        fail(false);
        forgetSettledFirstSeen(store, id, [{ id: 'a', ts: 10 }]);
        rememberFirstSeen(store, id, [], undefined);
        assert.deepEqual(recoveredFirstSeen(store, id, undefined), { b: 20 }, 'unconfirmed retry remains; confirmed retry cannot reappear');
        forgetSettledFirstSeen(store, id, [{ id: 'b', ts: 20 }]);
        rememberFirstSeen(store, id, [], undefined);
        assert.deepEqual(recoveredFirstSeen(store, id, undefined), {});
    }
});

test('two SQLite connections preserve intervening publications during merge and prune', () => {
    const root = mkdtempSync(join(tmpdir(), 'first-seen-writers-'));
    const first = UnifiedStore.open(join(root, 'index.db'));
    const second = UnifiedStore.open(join(root, 'index.db'));
    try {
        rememberFirstSeen(first, 's', [{ id: 'a' }], { a: 10 });
        const transaction = first.withSessionExtTransaction.bind(first);
        let intervene: (() => void) | undefined;
        first.withSessionExtTransaction = action => {
            const publish = intervene;
            intervene = undefined;
            publish?.();
            return transaction(action);
        };
        intervene = () => rememberFirstSeen(second, 's', [{ id: 'b' }], { b: 20 });
        rememberFirstSeen(first, 's', [{ id: 'c' }], { c: 30 });
        assert.deepEqual(recoveredFirstSeen(first, 's', undefined), { a: 10, b: 20, c: 30 });
        intervene = () => rememberFirstSeen(second, 's', [{ id: 'd' }], { d: 40 });
        forgetSettledFirstSeen(first, 's', [{ id: 'a', ts: 10 }]);
        assert.deepEqual(recoveredFirstSeen(second, 's', undefined), { b: 20, c: 30, d: 40 });
    } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test('SQLite rolls back failed publication and recovery reclaims abandoned chunks', () => {
    const root = mkdtempSync(join(tmpdir(), 'first-seen-gc-'));
    let store = UnifiedStore.open(join(root, 'index.db'));
    try {
        rememberFirstSeen(store, 's', [{ id: 'a' }], { a: 10 });
        const before = store.listSessionExt('s');
        const original = store.setSessionExt.bind(store);
        store.setSessionExt = (id, key, value) => {
            if (key === FIRST_SEEN_KEY) throw new Error('injected manifest failure');
            original(id, key, value);
        };
        assert.throws(() => rememberFirstSeen(store, 's', [{ id: 'b' }], { b: 20 }), /injected manifest/);
        assert.deepEqual(store.listSessionExt('s'), before, 'failed chunks must roll back with their manifest');
        store.setSessionExt = original;
        rememberFirstSeen(store, 's', [{ id: 'c' }], { c: 30 });
        // Emulate a chunk abandoned by the prior non-transactional prototype.
        const orphan = `inc:first-seen:${'0'.repeat(64)}`;
        store.setSessionExt('s', orphan, 'abandoned unpublished data');
        store.close();
        store = UnifiedStore.open(join(root, 'index.db'));
        assert.deepEqual(recoveredFirstSeen(store, 's', undefined), { a: 10, b: 20, c: 30 });
        assert.equal(store.getSessionExt('s', orphan), undefined);
        const manifest = store.getSessionExt('s', FIRST_SEEN_KEY);
        assert.ok(manifest && typeof manifest === 'object');
        const keys: unknown = Reflect.get(manifest, 'chunks');
        assert.ok(Array.isArray(keys));
        assert.equal(store.listSessionExt('s').filter(row => row.key.startsWith('inc:first-seen:')).length, keys.length);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("only a marked request object carries process-local hydration authority", () => {
    const request = { headers: { "x-bili-plugin": "opencode", "x-bili-first-seen": "1" } };
    assert.equal(isFirstSeenRequest(request), false);
    markFirstSeenRequest(request);
    assert.equal(isFirstSeenRequest(request), true);
    assert.equal(isFirstSeenRequest(structuredClone(request)), false);
});

test("identity dictionary preserves literal property names", () => {
    const f = fixture();
    const stamps = JSON.parse('{"__proto__":100,"constructor":200}');
    rememberFirstSeen(f.store, "s", [{ id: "__proto__" }, { id: "constructor" }], stamps);
    assert.equal(Object.hasOwn(recoveredFirstSeen(f.store, "s", undefined), "__proto__"), true);
    assert.deepEqual(recoveredFirstSeen(f.store, "s", undefined), stamps);
});

test("pending stamps survive restart without rewriting messages or existing stamps", () => {
    const { store } = fixture();
    const messages = [{ id: "m1", text: "opaque exact bytes", thinkingSignature: "unchanged" }, { id: "m2" }];
    const before = structuredClone(messages);
    rememberFirstSeen(store, "conversation", messages, { m1: 100, m2: 200 });
    assert.deepEqual(recoveredFirstSeen(store, "conversation", { existing: 1 }), { m1: 100, m2: 200, existing: 1 });
    assert.deepEqual(recoveredFirstSeen(store, "other", undefined), {});
    assert.deepEqual(recoveredFirstSeen(store, "conversation", { m1: 99 }), { m1: 99, m2: 200 });
    assert.deepEqual(messages, before);
});

test("failed write cannot return success; retry retains the earlier pending prefix", () => {
    const f = fixture();
    rememberFirstSeen(f.store, "s", [{ id: "a" }], { a: 100 });
    f.fail(true);
    assert.throws(() => rememberFirstSeen(f.store, "s", [{ id: "b" }], { b: 200 }), /injected/);
    assert.deepEqual(recoveredFirstSeen(f.store, "s", undefined), { a: 100 });
    f.fail(false);
    rememberFirstSeen(f.store, "s", [{ id: "b" }], { b: 200 });
    assert.deepEqual(recoveredFirstSeen(f.store, "s", undefined), { a: 100, b: 200 });
});

test("only independently confirmed exact row timestamps permit pruning", () => {
    const f = fixture();
    rememberFirstSeen(f.store, "s", [{ id: "a" }, { id: "b" }], { a: 100, b: 200 });
    forgetSettledFirstSeen(f.store, "s", [{ id: "a", ts: 101 }, { id: "b" }]);
    assert.deepEqual(recoveredFirstSeen(f.store, "s", undefined), { a: 100, b: 200 });
    f.fail(true);
    assert.throws(() => forgetSettledFirstSeen(f.store, "s", [{ id: "a", ts: 100 }]), /injected/);
    f.fail(false);
    assert.deepEqual(recoveredFirstSeen(f.store, "s", undefined), { a: 100, b: 200 });
    forgetSettledFirstSeen(f.store, "s", [{ id: "a", ts: 100 }]);
    assert.deepEqual(recoveredFirstSeen(f.store, "s", undefined), { b: 200 });
});

test("invalid or conflicting journal values fail before changing stored state", () => {
    const f = fixture();
    rememberFirstSeen(f.store, "s", [{ id: "a" }], { a: 100 });
    assert.throws(() => rememberFirstSeen(f.store, "s", [{ id: "a" }], { a: 200 }), /Conflicting/);
    assert.deepEqual(recoveredFirstSeen(f.store, "s", undefined), { a: 100 });
    f.values.set(`s:${FIRST_SEEN_KEY}`, { version: 1, stamps: { a: 100, corrupt: "bad" } });
    assert.throws(() => recoveredFirstSeen(f.store, "s", { durable: 1 }), /Invalid/);
});

test('a failed new suffix is retried even when the warm kernel no longer calls it new', () => {
    const f = fixture();
    f.fail(true);
    assert.throws(() => rememberFirstSeen(f.store, 's', [{ id: 'kernel-id' }], { 'kernel-id': 123 }), /injected/);
    f.fail(false);
    rememberFirstSeen(f.store, 's', [], {});
    assert.deepEqual(recoveredFirstSeen(f.store, 's', undefined), { 'kernel-id': 123 });
});

test('failed multi-chunk publication retains the prior manifest and retries the entire pending suffix', () => {
    const f = fixture();
    rememberFirstSeen(f.store, 's', [{ id: 'earlier' }], { earlier: 1 });
    const set = f.store.setSessionExt.bind(f.store);
    let chunks = 0;
    f.store.setSessionExt = (id, key, value) => {
        if (key.startsWith('inc:first-seen:') && ++chunks === 2) throw new Error('injected second chunk failure');
        set(id, key, value);
    };
    const stamps = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`${i}${'x'.repeat(510)}`, 100 + i]));
    assert.throws(() => rememberFirstSeen(f.store, 's', Object.keys(stamps).map(id => ({ id })), stamps), /second chunk failure/);
    assert.deepEqual(recoveredFirstSeen(f.store, 's', undefined), { earlier: 1 });
    f.store.setSessionExt = set;
    rememberFirstSeen(f.store, 's', [], {});
    const recovered = recoveredFirstSeen(f.store, 's', undefined);
    assert.equal(Object.keys(recovered).length, 1501);
    for (const [id, ts] of Object.entries(stamps)) assert.equal(recovered[id], ts);
});

test('actual SQLite extension budget permits large seeds and exact full-resync recovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'first-seen-chunks-'));
    let store = UnifiedStore.open(join(dir, 'index.db'));
    try {
        const stamps = Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [`${String(i).padStart(6, '0')}${'x'.repeat(506)}`, 1700000000000 + i]));
        assert.throws(() => store.setSessionExt('s', 'inc:oversized-control', { version: 1, stamps }), /exceeds/);
        const messages = Object.keys(stamps).map(id => ({ id }));
        rememberFirstSeen(store, 's', messages, stamps);
        store.close();
        store = UnifiedStore.open(join(dir, 'index.db'));
        assert.deepEqual(recoveredFirstSeen(store, 's', undefined), stamps);
        // A complete resync must not require one oversized extension value.
        rememberFirstSeen(store, 's', messages, stamps);
        forgetSettledFirstSeen(store, 's', messages.map(message => ({ ...message, ts: stamps[message.id] })));
        assert.deepEqual(recoveredFirstSeen(store, 's', undefined), {});
        assert.equal(store.listSessionExt('s').filter(row => row.key.startsWith('inc:first-seen:')).length, 0);
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('normal raw snapshots retain intake time through a later SQLite save and settle the journal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'first-seen-save-'));
    const before = { unified: process.env.BILI_STORAGE_UNIFIED, writer: process.env.BILI_STORAGE_JSON_WRITER };
    process.env.BILI_STORAGE_UNIFIED = 'full';
    process.env.BILI_STORAGE_JSON_WRITER = 'off';
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60000 });
    try {
        const session = createSession('first-seen-intake');
        const intake = 1700000000000;
        session.state.tsStamps = { 'kernel-derived': intake };
        session.state.messageRefs.byRaw['kernel-derived'] = 'm00001';
        session.state.messageRefs.byRef.m00001 = 'kernel-derived';
        const messages = [{ id: 'kernel-derived', role: 'user' as const, contentType: 'text' as const, text: 'opaque protected bytes' }];
        const protectedBefore = JSON.stringify(messages);
        snapshotMessages(session, messages);
        rememberFirstSeen(store, session.id, messages, session.state.tsStamps);
        assert.ok(Date.now() > intake);
        await store.writeNow(session);
        const rows = store.unifiedRawMessages(session.id);
        assert.ok(rows);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.ts, intake);
        const persisted: unknown = JSON.parse(rows[0]!.content);
        assert.ok(persisted && typeof persisted === 'object');
        assert.equal(Reflect.get(persisted, 'text'), 'opaque protected bytes');
        forgetSettledFirstSeen(store, session.id, [{ id: 'kernel-derived', ts: rows[0]!.ts ?? undefined }]);
        assert.deepEqual(recoveredFirstSeen(store, session.id, undefined), {});
        assert.equal(JSON.stringify(messages.map(({ id, role, contentType, text }) => ({ id, role, contentType, text }))), protectedBefore);
    } finally {
        store.cancelAll();
        store.closeQuietly();
        for (const [key, value] of [['BILI_STORAGE_UNIFIED', before.unified], ['BILI_STORAGE_JSON_WRITER', before.writer]] as const) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        rmSync(dir, { recursive: true, force: true });
    }
});
