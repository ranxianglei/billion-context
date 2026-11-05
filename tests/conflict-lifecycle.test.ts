// #2102: conflict-ledger lifecycle — the ACTIVE vs historical split (7-day
// window), the additive summary fields, and the clear path that previously did
// not exist (no UI/HTTP entry could stop months-old stock from reading as a
// live alarm).
import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { CONFLICT_ACTIVE_WINDOW_MS, clearConflictEvents, conflictEventsOf, formatConflictSection, recordConflict, splitConflictEvents, summarizeConflicts, type ConflictEvent } from "../src/conflict-watch.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";

_setStoreForTest(new SessionStore({ enabled: false }));

const DAY = 24 * 60 * 60 * 1000;

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [],
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("splitConflictEvents: exactly-window-old is still active, 1ms older is historical (#2102)", () => {
    const now = Date.now();
    const events: ConflictEvent[] = [
        { at: now - CONFLICT_ACTIVE_WINDOW_MS, kind: "unannounced-rewrite", detail: "edge-active" },
        { at: now - CONFLICT_ACTIVE_WINDOW_MS - 1, kind: "unannounced-rewrite", detail: "edge-historical" },
    ];
    const { active, historical } = splitConflictEvents(events, now);
    assert.deepEqual(active.map((e) => e.detail), ["edge-active"]);
    assert.deepEqual(historical.map((e) => e.detail), ["edge-historical"]);
});

test("summarizeConflicts: additive active/historical/lastAt across sessions (#2102)", () => {
    const now = Date.now();
    const a = makeSession("sess-a");
    a.metadata.conflictEvents = [0, 1, 2].map((i) => ({ at: now - 30 * DAY - i * 60000, kind: "unannounced-rewrite" as const, detail: `old-${i}` }));
    const b = makeSession("sess-b");
    b.metadata.conflictEvents = [{ at: now - 60000, kind: "third-party-plugin" as const, detail: "pi: npm:x (settings.json)" }];
    const c = makeSession("sess-c");
    const s = summarizeConflicts([a, b, c], now);
    assert.equal(s.sessions, 2);
    assert.equal(s.events, 4);
    assert.equal(s.active, 1);
    assert.equal(s.historical, 3);
    assert.equal(s.lastAt, now - 60000);
    assert.deepEqual(s.kinds, { "unannounced-rewrite": 3, "third-party-plugin": 1 });
    assert.equal(s.latest.length, 2);
    assert.equal(s.latest[0]?.sessionId, "sess-b");
});

test("clearConflictEvents: per-session, unknown-id, and global wipe (#2102)", () => {
    const a = makeSession("a");
    a.metadata.conflictEvents = [{ at: 1, kind: "orphan-reap" as const, detail: "x" }];
    const b = makeSession("b");
    b.metadata.conflictEvents = [
        { at: 2, kind: "orphan-reap" as const, detail: "y" },
        { at: 3, kind: "orphan-reap" as const, detail: "z" },
    ];
    const c = makeSession("c");

    let r = clearConflictEvents([a, b, c], "b");
    assert.deepEqual(r, { events: 2, sessions: 1 });
    assert.equal(conflictEventsOf(b).length, 0);
    assert.ok(!("conflictEvents" in b.metadata), "cleared key is deleted so persistence stops carrying it");
    assert.equal(conflictEventsOf(a).length, 1, "other sessions untouched by a per-session clear");

    r = clearConflictEvents([a, b, c], "nope");
    assert.deepEqual(r, { events: 0, sessions: 0 });

    r = clearConflictEvents([a, b, c]);
    assert.deepEqual(r, { events: 1, sessions: 1 });
    assert.equal(conflictEventsOf(a).length, 0);

    recordConflict(a, "orphan-reap", "again");
    assert.equal(conflictEventsOf(a).length, 1, "ledger re-records cleanly after a wipe");
});

test("formatConflictSection: header age split + advice switches with liveness (#2102)", () => {
    const now = Date.now();
    const mixed: ConflictEvent[] = [
        { at: now - 30 * DAY, kind: "unannounced-rewrite", detail: "old rewrite" },
        { at: now - 60000, kind: "unannounced-rewrite", detail: "fresh rewrite" },
    ];
    const mixedText = formatConflictSection(mixed, now).join("\n");
    assert.ok(mixedText.includes("(1 active · 1 historical; active = within 7 days)"), mixedText);
    // #2545: unannounced rewrites alone are UNCONFIRMED signals — a fresh one no
    // longer escalates to the imperative one-compressor command (cause unverified).
    assert.ok(mixedText.includes("UNCONFIRMED signal"), "tiered as unconfirmed diagnosis");
    assert.ok(!mixedText.includes("Keep exactly ONE compressor"), "no imperative without confirmed evidence");

    const allOld: ConflictEvent[] = [
        { at: now - 30 * DAY, kind: "unannounced-rewrite", detail: "stock" },
        { at: now - 90 * DAY, kind: "unannounced-rewrite", detail: "stocker" },
    ];
    const oldText = formatConflictSection(allOld, now).join("\n");
    assert.ok(oldText.includes("(0 active · 2 historical; active = within 7 days)"), oldText);
    assert.ok(oldText.includes("older than 7 days"));
    assert.ok(oldText.includes("POST /__bili/conflicts/clear?session="));
    assert.ok(!oldText.includes("Keep exactly ONE compressor"), "all-historical stock must not read as a live alarm");

    const allSuspected: ConflictEvent[] = [
        { at: now - 60000, kind: "third-party-plugin", detail: "pi: npm:some-viewer (settings.json) [suspected]" },
    ];
    const susText = formatConflictSection(allSuspected, now).join("\n");
    assert.ok(susText.includes("[suspected] = name-only keyword match"));
    assert.ok(susText.includes("Every event above is [suspected]"));
    assert.ok(!susText.includes("Keep exactly ONE compressor"));
});
