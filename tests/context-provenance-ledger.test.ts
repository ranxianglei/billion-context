import assert from "node:assert/strict";
import test from "node:test";
import { currentContextObservation, noteForwardedBody, recordContextObservation } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

function lightweightSession(): Session {
    return { id: "lightweight-context", stats: {} } as unknown as Session;
}

test("context observations initialize metadata for lightweight pipeline sessions", () => {
    const session = lightweightSession();
    assert.equal(currentContextObservation(session), undefined);
    recordContextObservation(session, 123, "usage");
    const observation = currentContextObservation(session);
    assert.equal(observation?.sessionId, session.id);
    assert.equal(observation?.tokens, 123);
    assert.equal(observation?.source, "usage");
    assert.ok(observation && observation.at > 0 && observation.generation.length > 0);
});

test("unmeasured forwards and invalid observations do not require metadata", () => {
    const session = lightweightSession();
    assert.doesNotThrow(() => noteForwardedBody(session, "unmeasured"));
    assert.doesNotThrow(() => recordContextObservation(session, NaN, "estimate"));
    assert.equal(currentContextObservation(session), undefined);
});