import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileFoldCoverage, positionalFingerprint } from '../src/fold-reconcile.js';
import { SessionStore, _setStoreForTest } from '../src/persist.js';
import type { Session } from '../src/session.js';
import type { CoreMessage } from 'acp-kernel';

test('reaping a partially surviving fold preserves position fingerprint associations', () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const message = (id: string): CoreMessage => ({ id, role: 'user', contentType: 'text', text: `Unique invented payload ${id}` });
    const covered = ['a','b','c'].map(message);
    const tail = Array.from({ length: 12 }, (_, index) => message(`tail-${index}`));
    const session = {
        id: 'synthetic-reap-position-integrity',
        state: { blocks: [{ active: true, blockId: 'synthetic-fold', effectiveMessageIds: ['a','b','c'] }], messageRefs: { byRaw: {}, byRef: {} } },
        metadata: {},
    } as unknown as Session;
    reconcileFoldCoverage(session, [...covered,...tail], { mode: 'repair' });
    const before = session.metadata.foldPositions as { ids: string[]; canon: string[] };
    assert.deepEqual(before.canon, [...covered,...tail].map(positionalFingerprint));
    const surviving = [covered[0],...tail];
    for (let pass = 0; pass < 3; pass++) reconcileFoldCoverage(session, surviving, { mode: 'repair' });
    assert.equal(session.state.blocks.length, 0, 'fixture must actually reap the majority-missing fold');
    const after = session.metadata.foldPositions as { ids: string[]; canon: string[] };
    assert.equal(after.ids.length, after.canon.length, 'reaping must remove each position ID together with its fingerprint');
    const actual = new Map(surviving.map(item => [item.id,positionalFingerprint(item)]));
    after.ids.forEach((id,index) => assert.equal(after.canon[index], actual.get(id), 'each surviving fingerprint must belong to its recorded ID'));
    reconcileFoldCoverage(session, surviving, { mode: 'repair' });
    const next = session.metadata.foldPositions as { ids: string[]; canon: string[] };
    assert.deepEqual(next.canon, next.ids.map(id => actual.get(id)),
        'the next pass must not cache a shifted fingerprint under the wrong ID');
});
