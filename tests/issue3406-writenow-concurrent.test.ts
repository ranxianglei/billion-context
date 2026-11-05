import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, type CoreMessage } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #3406 item 5: concurrent writeNow on ONE session must never lose an update
// (later writer overwriting newer state with older state). The defense is the
// kernel store's per-id write chains (kernel/src/persist/store.ts writeNow →
// writeChains) combined with DEFERRED builders: guardedBuild runs
// buildRecord(session) at chain-run time against the LIVE session, so every
// committed snapshot is at least as fresh as anything mutated before its turn
// started. These tests pin that property — if serialization or builder
// deferral ever regresses (e.g. a caller starts snapshotting at enqueue time),
// they fail with a half-written history on disk.

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

const msg = (id: string, text: string): CoreMessage => ({ id, role: "user", contentType: "text", text });

async function reload(dir: string, id: string): Promise<Session> {
    const reloaded = new SessionStore({ dir, debounceMs: 60000, enabled: true });
    const back = reloaded.loadSync(id);
    await reloaded.flushAll([]);
    assert.ok(back, `session ${id} reloaded`);
    return back;
}

test("writeNow: concurrent immediate writes on one session both land (no lost update, #3406 item 5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-3406-wn-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 60000, enabled: true });
        const s = makeSession("concurrent-writenow");
        // Update 1 lands (e.g. a completed compression persists immediately)…
        s.lastMessages = [msg("m1", "UPDATE-ONE")];
        const p1 = store.writeNow(s);
        // …and while that write chain is in flight, update 2 lands (a user
        // message triggers another immediate persist). No await between.
        s.lastMessages = [...s.lastMessages, msg("m2", "UPDATE-TWO")];
        const p2 = store.writeNow(s);
        await Promise.all([p1, p2]);
        await store.flushAll([]);

        const back = await reload(dir, "concurrent-writenow");
        const texts = (back.lastMessages ?? []).map((m) => m.text).join("\n");
        assert.ok(texts.includes("UPDATE-ONE"), `first update missing from disk: got ${JSON.stringify(texts)}`);
        assert.ok(texts.includes("UPDATE-TWO"), `second update missing from disk (lost update): got ${JSON.stringify(texts)}`);
    } finally {
        rmrf(dir);
    }
});

test("writeNow: a write issued after an earlier one fully settled still supersedes it (folded-tail re-armed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-3406-wn2-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 60000, enabled: true });
        const s = makeSession("sequential-writenow");
        s.lastMessages = [msg("m1", "UPDATE-ONE")];
        await store.writeNow(s);
        // writeNow folded the resident tail (lastMessagesFolded) — the next
        // mutation appends to the FOLDED resident view, and the next write
        // must still persist the appended message from that view.
        s.lastMessages = [...(s.lastMessages ?? []), msg("m2", "UPDATE-TWO")];
        await store.writeNow(s);
        await store.flushAll([]);

        const back = await reload(dir, "sequential-writenow");
        const texts = (back.lastMessages ?? []).map((m) => m.text).join("\n");
        assert.ok(texts.includes("UPDATE-ONE"), `first update missing from disk: got ${JSON.stringify(texts)}`);
        assert.ok(texts.includes("UPDATE-TWO"), `second update missing from disk (lost update): got ${JSON.stringify(texts)}`);
    } finally {
        rmrf(dir);
    }
});
