/**
 * #5874 P1 supplement — the steady-state fast path nail. Every other P1
 * test saves through planIngest(full) only, so snapFastAppendEvents never
 * ran in CI. These drive the REAL watermark/delta machinery
 * (UnifiedShadow.record, #3133): a steady-state append must ride the fast
 * path (snap_log kind 'append', exactly n events), and any doubt must fall
 * back to the final-state diff and still converge byte-for-byte. The
 * rewind case also pins a GC/S4 regression: host-side row retirement
 * releases the flipped rows physically, and that removal must re-anchor
 * the plane in the same transaction — otherwise the next readSnapView
 * trips R1 on a healthy plane and the sticky dead latch kills it forever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type LegacySessionLike } from "../src/storage/ingest.ts";
import { readSnapView, _resetSnapPlaneDeadForTests } from "../src/storage/snap.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5874-fp-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function coreOf(msgs: Array<{ id: string; text: string }>): CoreMessage[] {
    return msgs.map((m, i) => ({
        id: m.id,
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        contentType: "text" as const,
        text: m.text,
    })) as CoreMessage[];
}

/** One full-message turn of a legacy session (same shape as the P1 suite). */
function session(id: string, msgs: Array<{ id: string; text: string }>): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(),
        lastMessages: coreOf(msgs),
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

/** Shadow with the plane armed on its OWN store (the production wiring:
 *  persist.ts passes fileSnapBase into maybeOpen); plus a plain assertion
 *  connection onto the same index.db for reading what the shadow wrote. */
function openArmed(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike, undefined, undefined, undefined, { enabled: true, shadowWrite: true });
    assert.ok(shadow, "plane-armed shadow must open");
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    return { shadow, store };
}

function stats(shadow: UnifiedShadow): { deltaIngests: number } {
    return (shadow as unknown as { stats: { deltaIngests: number } }).stats;
}

function logKinds(store: UnifiedStore, sid: string): string[] {
    const db = (store as unknown as { db: Parameters<typeof readSnapView>[0] }).db;
    return (db.prepare("SELECT kind FROM snap_log WHERE sid = ? ORDER BY seq").all(sid) as Array<{ kind: string }>).map((r) => r.kind);
}

function assertAbEqual(store: UnifiedStore, sid: string): void {
    const db = (store as unknown as { db: Parameters<typeof readSnapView>[0] }).db;
    const view = readSnapView(db, sid);
    assert.ok(view, "plane must be initialized");
    assert.ok(view.verified, "plane checksum must verify");
    const live = (db.prepare("SELECT m.seq, c.bytes AS bytes FROM messages m JOIN content c ON c.hash = m.content_hash WHERE m.session_id = ? AND m.retired_at IS NULL ORDER BY m.seq").all(sid)) as Array<{ seq: number; bytes: Buffer | Uint8Array }>;
    const active = view.rows.filter((r) => r.active === 1);
    assert.equal(active.length, live.length, `active plane rows (${active.length}) must equal live legacy rows (${live.length})`);
    for (const l of live) {
        const row = active.find((r) => r.pos === l.seq);
        assert.ok(row, `plane row for pos ${l.seq} missing`);
        assert.equal(row.postJson, Buffer.from(l.bytes).toString("utf8"), `pos ${l.seq}: plane post_json must be byte-equal to the legacy content`);
    }
}

test("#5874 fast path: a steady-state delta append rides snapFastAppendEvents, not the diff", () => {
    _resetSnapPlaneDeadForTests();
    const dir = tmpDir("bili-5874-fp-steady-");
    try {
        const { shadow, store } = openArmed(dir);
        try {
            // Save 1: five messages — no watermark yet, so the FULL path
            // seeds the plane through the final-state diff ('cast').
            shadow.record(session("sess-fp", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }, { id: "m5", text: "five" }]));
            assert.equal(stats(shadow).deltaIngests, 0, "first save has no watermark — full ingest");
            assert.deepEqual(logKinds(store, "sess-fp"), ["cast", "cast", "cast", "cast", "cast"], "seed round must derive casts, one per position");
            assertAbEqual(store, "sess-fp");

            // Save 2: the classic B1 re-send + two new messages. The
            // watermark names the old tail, so this rides the DELTA path —
            // and with the plane aligned, the fast path must take it:
            // exactly two 'append' events, nothing re-derived for the
            // unchanged head (a silent diff fallback would log 'cast' here).
            shadow.record(session("sess-fp", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }, { id: "m5", text: "five" }, { id: "m6", text: "six" }, { id: "m7", text: "seven" }]));
            assert.equal(stats(shadow).deltaIngests, 1, "second save must take the delta path");
            assert.deepEqual(logKinds(store, "sess-fp"), ["cast", "cast", "cast", "cast", "cast", "append", "append"], "the append round must ride the fast path — 'append', not a diff re-cast");
            assertAbEqual(store, "sess-fp");

            // Save 3: one more append — the fast path is the STEADY state,
            // so it must keep holding turn after turn.
            shadow.record(session("sess-fp", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }, { id: "m5", text: "five" }, { id: "m6", text: "six" }, { id: "m7", text: "seven" }, { id: "m8", text: "eight" }]));
            assert.equal(stats(shadow).deltaIngests, 2, "third save stays on the delta path");
            assert.deepEqual(logKinds(store, "sess-fp"), ["cast", "cast", "cast", "cast", "cast", "append", "append", "append"], "steady state keeps riding the fast path");
            assertAbEqual(store, "sess-fp");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("#5874 fast path fallback: a rewound tail voids the delta, the diff re-derives deletes", () => {
    _resetSnapPlaneDeadForTests();
    const dir = tmpDir("bili-5874-fp-rewind-");
    try {
        const { shadow, store } = openArmed(dir);
        try {
            shadow.record(session("sess-fw", [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }, { id: "m5", text: "five" }, { id: "m6", text: "six" }]));
            assertAbEqual(store, "sess-fw");

            // The host rewound (a shorter tail than the trusted watermark).
            // The raw tail makes the plan the COMPLETE log (#3285), so the
            // historian sweep tombstones the two dropped rows (#4390); the
            // delta guard rejects the shorter tail and the plane's
            // final-state diff must flip them inactive — the fast path's
            // predicate cannot hold here, so a wrong 'append' would mean it
            // ignored the retirement.
            const rewound = [{ id: "m1", text: "one" }, { id: "m2", text: "two" }, { id: "m3", text: "three" }, { id: "m4", text: "four" }];
            shadow.record(session("sess-fw", rewound), { lastMessages: coreOf(rewound), lastMessagesFolded: false });
            assert.equal(stats(shadow).deltaIngests, 0, "a shorter tail cannot ride the delta");
            // The plane must be ALIVE and byte-converged on the rewound set:
            // the diff flips the two retired positions inactive, GC releases
            // them physically (invariant iv's valve), and the removal must
            // re-anchor S4 — before that re-anchor existed, exactly this
            // read threw SnapPlaneDeadError (R1) on a healthy plane.
            assertAbEqual(store, "sess-fw");
            const db = (store as unknown as { db: Parameters<typeof readSnapView>[0] }).db;
            const rowCount = (db.prepare("SELECT COUNT(*) AS n FROM snap_rows WHERE sid = ?").get("sess-fw") as { n: number }).n;
            assert.equal(rowCount, 4, "the two released positions are physically gone; the four live ones remain");
            // One more steady turn after the rewind: the plane keeps serving
            // (no sticky dead latch from the release round).
            shadow.record(session("sess-fw", [...rewound, { id: "m9", text: "nine" }]));
            assertAbEqual(store, "sess-fw");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
