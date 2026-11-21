import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anthropicToCore, type AnthropicRequestBody } from 'acp-kernel/wire';
import { createInitialState, prune, type CoreMessage } from 'acp-kernel';
import { normalizedIdentity, normalizedIdentityNoToolCallId, reconcileFoldCoverage } from '../src/fold-reconcile.js';
import type { Session } from '../src/session.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-anthropic-0200.json', import.meta.url), 'utf8')) as {
    body: AnthropicRequestBody;
    legacyMessages: CoreMessage[];
    coveredIds: string[];
};

function legacySession(): Session {
    // A valid legacy coverage shape with no surviving anchors for this old pair.
    // The 13-message resend clears the auxiliary-side-request guard. Persisted
    // lastMessages is empty, as in the affected legacy envelope. No private
    // messages, anchors, summaries or identifiers are included in this fixture.
    const state = createInitialState();
    state.blocks.push({
        blockId: 'b1', runId: 'synthetic-fold', tier: 1,
        summary: 'The synthetic lookup completed.',
        directMessageIds: [...fixture.coveredIds],
        effectiveMessageIds: [...fixture.coveredIds], directBlockIds: [],
        compressedTokens: 20, createdAt: 1700000000000,
        survivedCount: 0, generation: 'old', active: true,
    });
    return {
        id: 'synthetic-legacy-replay',
        state,
        metadata: { foldAnchorOrder: fixture.legacyMessages.map(message => message.id), foldAnchors: {} },
        lastMessages: [],
    } as unknown as Session;
}

test('legacy IDs still match persisted coverage without surviving anchors', () => {
    const session = legacySession();
    const messages = structuredClone(fixture.legacyMessages);
    const result = reconcileFoldCoverage(session, messages, { mode: 'repair' });
    assert.equal(result.missing, 0);
    assert.equal(result.unmatched, 0);
    assert.equal(prune(messages, session.state).filter(message => message.toolCallId === 'synthetic-call-1').length, 0);
});

test('synthetic old and current decoders preserve the same message payloads', () => {
    const current = anthropicToCore(structuredClone(fixture.body)).msgs;
    const withoutIds = (messages: CoreMessage[]) => messages.map(({ id: _id, ...payload }) => payload);
    assert.deepEqual(withoutIds(current), withoutIds(fixture.legacyMessages));
    assert.equal(current.length, 13);
    assert.equal(fixture.coveredIds.length, 2);
});

test('surviving tool anchors recover the same current replay', () => {
    const session = legacySession();
    session.metadata.foldAnchors = Object.fromEntries(fixture.legacyMessages.map(message => [message.id, {
        n: normalizedIdentity(message), r: message.role, b: message.text?.length ?? 0,
        ...(message.toolCallId ? { t: message.toolCallId, m: normalizedIdentityNoToolCallId(message) } : {}),
    }]));
    const current = anthropicToCore(structuredClone(fixture.body)).msgs;
    const result = reconcileFoldCoverage(session, current, { mode: 'repair' });
    assert.equal(result.unmatched, 0);
    assert.equal(prune(current, session.state).filter(message => message.toolCallId === 'synthetic-call-1').length, 0);
});

test('unchanged Anthropic replay keeps legacy folded tool coverage after upgrade', () => {
    const session = legacySession();
    const current = anthropicToCore(structuredClone(fixture.body)).msgs;
    const result = reconcileFoldCoverage(session, current, { mode: 'repair' });
    assert.equal(prune(current, session.state).filter(message => message.toolCallId === 'synthetic-call-1').length, 0,
        'already-folded tool messages must stay folded on unchanged replay');
    assert.equal(result.unmatched, 0,
        'unchanged tool-call/result payloads must not re-enter the wire unfolded after upgrading persisted legacy coverage');
});
