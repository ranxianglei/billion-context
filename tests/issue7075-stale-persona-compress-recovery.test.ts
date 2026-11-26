// #7075: purpose-header transition — compress routed to stale parent.
//
// Pre-#6883 traffic minted refs in a `|sub:` fork (persona-order ladder).
// Post-#6883 compress forwards stamp the raw id and the purpose header
// routes them to the parent. The fork went stale (no model traffic for
// >10 min) so `livePersonaDescendant`'s freshness filter excludes it, but
// its ref space still holds the refs the compress cites.
//
// Fix: `stalePersonaWithRefs` — no freshness gate, refs are the
// discriminator. When `livePersonaDescendant` returns undefined (fork
// not fresh), fall through to `stalePersonaWithRefs` which finds the
// fork whose minted ref space contains the cited refs.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-7075-recovery-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

const { getSession, _resetSessionsForTest } = await import("../src/session.ts");
const { _stalePersonaWithRefsForTest } = await import("../src/plugin.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

function makeSession(id: string, refs: string[], lastSeen: number, createdAt: number): void {
    const s = getSession(id);
    for (const ref of refs) {
        s.state.messageRefs!.byRef[ref] = `raw-${ref}`;
    }
    s.lastSeen = lastSeen;
    s.createdAt = createdAt;
    s.stats.requests = refs.length > 0 ? 1 : 0;
}

test("#7075 unit: stalePersonaWithRefs finds a stale fork that holds the cited refs", () => {
    _resetSessionsForTest();
    const now = Date.now();
    const parentLastSeen = now - 11 * 60 * 1000;
    const forkCreated = now - 12 * 60 * 1000;
    const forkLastSeen = now - 11 * 60 * 1000;

    makeSession("conv-7075", ["m00001", "m00002", "m00003"], now, now - 60 * 60 * 1000);
    makeSession("conv-7075|sub:abc123", ["m00001", "m00002", "m00003", "m00004", "m00005"], forkLastSeen, forkCreated);

    const parent = getSession("conv-7075")!;
    parent.lastSeen = parentLastSeen;

    const result = _stalePersonaWithRefsForTest(parent, 5);
    assert.ok(result, "stale fork found");
    assert.equal(result.id, "conv-7075|sub:abc123");
});

test("#7075 unit: stalePersonaWithRefs returns undefined when no fork holds the refs", () => {
    _resetSessionsForTest();
    const now = Date.now();

    makeSession("conv-7075b", ["m00001", "m00002"], now, now - 60 * 60 * 1000);
    makeSession("conv-7075b|sub:def456", ["m00001"], now - 11 * 60 * 1000, now - 12 * 60 * 1000);

    const parent = getSession("conv-7075b")!;
    const result = _stalePersonaWithRefsForTest(parent, 5);
    assert.equal(result, undefined, "no fork holds m00005");
});

test("#7075 unit: stalePersonaWithRefs ignores ref-less forks", () => {
    _resetSessionsForTest();
    const now = Date.now();

    makeSession("conv-7075c", ["m00001", "m00002"], now, now - 60 * 60 * 1000);
    const s = getSession("conv-7075c|sub:ghi789");
    s.lastSeen = now - 11 * 60 * 1000;
    s.createdAt = now - 12 * 60 * 1000;
    s.stats.requests = 1;

    const parent = getSession("conv-7075c")!;
    const result = _stalePersonaWithRefsForTest(parent, 5);
    assert.equal(result, undefined, "ref-less fork is not a target");
});

test("#7075 unit: stalePersonaWithRefs returns undefined for fork parents", () => {
    _resetSessionsForTest();
    const now = Date.now();

    makeSession("conv-7075d", ["m00001"], now, now - 60 * 60 * 1000);
    makeSession("conv-7075d|sub:jkl012", ["m00001", "m00002"], now - 11 * 60 * 1000, now - 12 * 60 * 1000);

    const fork = getSession("conv-7075d|sub:jkl012")!;
    const result = _stalePersonaWithRefsForTest(fork, 5);
    assert.equal(result, undefined, "fork parents are not searched");
});

test("#7075 unit: stalePersonaWithRefs returns undefined when maxCited is 0", () => {
    _resetSessionsForTest();
    const now = Date.now();

    makeSession("conv-7075e", ["m00001"], now, now - 60 * 60 * 1000);
    makeSession("conv-7075e|sub:mno345", ["m00001", "m00002"], now - 11 * 60 * 1000, now - 12 * 60 * 1000);

    const parent = getSession("conv-7075e")!;
    const result = _stalePersonaWithRefsForTest(parent, 0);
    assert.equal(result, undefined, "no cited refs = no search");
});
