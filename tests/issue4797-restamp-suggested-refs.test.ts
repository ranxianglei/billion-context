import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #4797 cold-load leg: after the one-time ledger re-stamp on cold load, every
 * range the engine advertises must survive the compress submit gate — the
 * production deadlock was acp_status suggesting refs the gate then refused
 * forever.
 *
 * Production shape: legacy counter refs drift ahead of the ledger (BLOCKED
 * protected rows occupy seq slots without counter refs), so the restamp
 * vacates old numbers AND re-grants some of them to DIFFERENT messages in
 * the same sweep (the collision band). The pre-fix span-scanning guard
 * refused any cited superseded number — including the re-granted ones the
 * status surface advertised — dead-looping the session. Current contract:
 * the guard resolves endpoints against the LIVE map first (identity-
 * preserving translation second), so advertised ranges pass. This test pins
 * that invariant over the REAL cold-load path (persist wiring included), not
 * just an in-process restamped session (the sibling
 * tests/issue4797-superseded-deadlock.test.ts covers the guard unit contract).
 */
process.env.NODE_ENV = "test";
process.env.BILI_STORAGE_UNIFIED = "full";
const testRoot = mkdtempSync(join(tmpdir(), "bili-4797-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { supersededRefRejection } from "../src/stream.ts";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import type { LegacySessionLike } from "../src/storage/ingest.ts";

function msg(id: string, text = `${id}: ${"x".repeat(40_000)}`): CoreMessage {
    return { id, role: "user", contentType: "text", text };
}

function legacyLike(id: string, messages: CoreMessage[]): LegacySessionLike {
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: {},
        stats: {},
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages: messages,
    } as unknown as LegacySessionLike;
}

test("cold-load restamp keeps every advertised range submittable (production deadlock shape)", async () => {
    const dir = join(testRoot, `se-${Math.random().toString(36).slice(2)}`);
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        // Two BLOCKED protected rows make the counter refs drift ahead of
        // seq+1 — the exact production precondition (kept/restamped split).
        const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
        const messages = ids.map((id) => msg(id));
        const legacy = legacyLike("i4797-se", messages);
        legacy.state.messageRefs = {
            byRaw: { a: "m00001", b: "m00002", c: "BLOCKED", d: "m00003", e: "m00004", f: "BLOCKED", g: "m00005", h: "m00006" },
            byRef: { m00001: "a", m00002: "b", m00003: "d", m00004: "e", m00005: "g", m00006: "h" },
        };
        const seedSession = {
            id: "i4797-se",
            createdAt: Date.now(),
            lastSeen: Date.now(),
            meta: { protocol: "anthropic" },
            stats: {},
            metadata: {},
            state: legacy.state,
            blockContents: new Map(),
            lastMessages: messages,
        } as never;
        assert.ok(store.flushSync(seedSession), "seed save committed");
        store.closeQuietly();

        // Cold load in a fresh instance fires the one-time alignment.
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store2);
        const reloaded = store2.loadSync("i4797-se");
        assert.ok(reloaded, "session loads");
        const st = reloaded.state;
        assert.equal(st.messageRefs.byRaw.d, "m00004", "d re-stamped to seq3+1");
        assert.equal(st.messageRefs.byRaw.h, "m00008", "h re-stamped to seq7+1");
        assert.equal(reloaded.restampSuperseded?.get("m00003"), "d");
        assert.equal(reloaded.restampSuperseded?.get("m00006"), "h");

        // The collision band must actually be present for this test to mean
        // anything: at least one superseded number is simultaneously the LIVE
        // ref of a different message (the exact shape the pre-fix guard
        // dead-looped on).
        const byRefNow = st.messageRefs.byRef;
        const liveSuperseded = [...(reloaded.restampSuperseded?.keys() ?? [])].filter((k) => byRefNow[k] !== undefined);
        assert.ok(liveSuperseded.length > 0, "fixture must contain re-granted superseded numbers (collision band)");

        // The suggestion side, exactly as acp-status computes it: the resent
        // view carries the six non-BLOCKED messages (protected rows absent).
        const core = createCore();
        const config = defaultConfig(200_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
        const view = () => messages.filter((m) => !["c", "f"].includes(m.id)).map((m) => ({ ...m }));
        const raw = core.processTurn({ messages: view(), state: st, config, tokenCount: 190_000, renderTags: "none" }).nudge?.compressibleRanges ?? [];
        assert.ok(raw.length > 0, "nudge advertises ranges after the restart");

        // THE INVARIANT: every range the engine offers passes the submit gate.
        // Pre-fix, the offered spans crossed vacated holes and EVERY one died
        // at the span-scanning guard — the production deadlock.
        const crossesVacatedHole = (r: { startRef: string; endRef: string }): boolean => {
            const s = Number(r.startRef.replace(/\D/g, ""));
            const e = Number(r.endRef.replace(/\D/g, ""));
            const holes = [...(reloaded.restampSuperseded?.keys() ?? [])]
                .filter((k) => byRefNow[k] === undefined)
                .map((k) => Number(k.replace(/\D/g, "")));
            return holes.some((n) => n > s && n < e);
        };
        assert.ok(raw.some(crossesVacatedHole), "advertised spans must cross the vacated holes (deadlock shape exercised)");
        for (const r of raw) {
            const res: { rejection: string | null } = supersededRefRejection([{ startRef: r.startRef, endRef: r.endRef }], reloaded);
            assert.equal(res.rejection, null, `advertised range ${r.startRef}-${r.endRef} must be submittable`);
        }
        store2.closeQuietly();
    } finally {
        _setStoreForTest({} as never);
        rmSync(dir, { recursive: true, force: true });
    }
});
