/**
 * #5744: refs-table maintenance must cost O(changed rows) per save, not O(full history).
 *
 * The `refs` table holds one row per message the session has ever seen (the
 * byRaw ledger, verbatim). It used to be maintained by DELETE-all + one-row
 * INSERT on EVERY save, so a steady-state delta save of 2 new messages into a
 * 3k-message session executed ~3001 native SQLite statements and rewrote the
 * whole set's WAL footprint — 96.5% of self time in node:sqlite
 * StatementSync.run on a Windows instance, event-loop starvation behind it
 * (#5744). The store now diffs against one indexed read of the stored set and
 * writes only what changed (vanished raw_ids deleted, untouched survivors
 * skipped, added/moved rows emitted as multi-row upsert batches), so the
 * append-only steady state costs ~2 statements regardless of history length.
 *
 * This suite pins:
 *  1. end-state equality with the legacy byRaw map after appends and after a
 *     compaction-shaped renumber (pruned ids vanish, survivors shift to lower
 *     ords) — the replace-all contract from review #2690 must still hold;
 *  2. the statement budget: a save touching the `refs` table executes at most
 *     a handful of statements even when the stored set is large (the old
 *     code would execute H+1);
 *  3. no ghost rows survive an open/close cycle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5744-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

const refToken = (i: number): string => `m${String(i + 1).padStart(5, "0")}`;

function msg(i: number): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `hello ${i}` } as CoreMessage;
}

/** Full-history presentation: the anthropic shape where every request re-sends
 *  the whole conversation; byRaw covers exactly the presented ids in order. */
function mkLegacy(id: string, count: number, dropPrefix = 0): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const lastMessages: CoreMessage[] = [];
    for (let i = dropPrefix; i < count; i++) {
        byRaw[`h_msg${i}`] = refToken(dropPrefix === 0 ? i : i - dropPrefix);
        lastMessages.push(msg(i));
    }
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
    };
}

function openPair(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

interface StatementMeter {
    /** Statements executed since the last reset() whose SQL touches the refs table. */
    refsTouching: () => number;
    reset: () => void;
    dispose: () => void;
}

/** Counts statement executions whose SQL touches the refs table. \brefs\b
 *  matches the refs table only (never dead_refs — no word boundary before it). */
function instrument(store: UnifiedStore): StatementMeter {
    const db = (store as unknown as {
        db: { prepare(q: string): unknown } & Record<string, unknown>;
    }).db;
    const orig = (db.prepare as (q: string) => { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown }).bind(db);
    let touching = 0;
    db.prepare = ((q: string) => {
        const stmt = orig(q);
        const isRefs = /\brefs\b/.test(q);
        return {
            run: (...args: unknown[]) => {
                if (isRefs) touching += 1;
                return stmt.run(...args);
            },
            get: (...args: unknown[]) => {
                if (isRefs) touching += 1;
                return stmt.get(...args);
            },
            all: (...args: unknown[]) => {
                if (isRefs) touching += 1;
                return stmt.all(...args);
            },
        };
    }) as (q: string) => unknown;
    return {
        refsTouching: () => touching,
        reset: () => {
            touching = 0;
        },
        dispose: () => {
            db.prepare = orig as never;
        },
    };
}

test("#5744: steady-state saves touch O(new) refs rows, never the full history", () => {
    const dir = tmpdir("bili-5744-steady-");
    try {
        const { shadow, store } = openPair(dir);
        // record() writes through the shadow's OWN store instance — a second
        // connection to the same file. A meter on the standalone handle above
        // would count zero statements and make every budget below vacuous.
        const meter = instrument((shadow as unknown as { sync: UnifiedStore }).sync);
        try {
            const n0 = 100;
            let legacy = mkLegacy("steady", n0);
            meter.reset();
            shadow.record(legacy);
            assert.equal(store.getRefs("steady").length, n0, "first save materializes the full ledger once");

            // Steady state: +2 messages, everything else unchanged. The old
            // replace-all code executed n+1 refs statements here (~102 for
            // this size, ~3001 on the reporter's sessions); the diff path may
            // spend at most the old-set read + one batched upsert of the new
            // rows (and nothing else touches the table).
            for (let turn = 1; turn <= 5; turn++) {
                legacy = mkLegacy("steady", n0 + turn * 2);
                meter.reset();
                shadow.record(legacy);
                assert.equal(
                    store.getRefs("steady").length,
                    n0 + turn * 2,
                    `turn ${turn}: ledger must track the session`,
                );
                // >= 2: the old-set read plus the upsert batch must actually
                // execute — a zero count means the meter watches no writes.
                assert.ok(
                    meter.refsTouching() >= 2 && meter.refsTouching() <= 3,
                    `turn ${turn}: ${meter.refsTouching()} refs statements for +2 rows (old code: ~${n0 + turn * 2 + 1})`,
                );
            }

            // End-state parity: every stored row equals the legacy map, with
            // ord = key order and ref_num decoded from the token.
            const expected = new Map(Object.entries(legacy.state.messageRefs.byRaw).map(([rawId, ref], ord) => [rawId, { ord, ref }]));
            const actual = store.getRefs("steady").map((r) => ({ rawId: r.rawId, ord: r.ord, ref: r.ref }));
            assert.equal(actual.length, expected.size);
            for (const row of actual) {
                const want = expected.get(row.rawId);
                assert.ok(want, `unexpected ghost raw_id ${row.rawId}`);
                assert.equal(row.ord, want.ord);
                assert.equal(row.ref, want.ref);
            }
        } finally {
            meter.dispose();
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("#5744: compaction-shaped renumber reconciles in bounded statements without ghosts", () => {
    const dir = tmpdir("bili-5744-renumber-");
    try {
        const { shadow, store } = openPair(dir);
        const meter = instrument((shadow as unknown as { sync: UnifiedStore }).sync);
        try {
            const n = 120;
            const pruned = 20; // first 20 ids are "reaped": survivors shift down
            shadow.record(mkLegacy("renumber", n));
            assert.equal(store.getRefs("renumber").length, n);

            meter.reset();
            shadow.record(mkLegacy("renumber", n, pruned));
            const rows = store.getRefs("renumber");
            assert.equal(rows.length, n - pruned, "pruned ids must leave the table — no ghosts");
            // Survivors renumbered to lower ords in map order.
            rows.forEach((r, i) => assert.equal(r.ord, i, `survivor at position ${i} keeps its shifted ord`));
            for (const r of rows) assert.ok(!/^h_msg\d+$/.test(r.rawId) || Number(r.rawId.slice(5)) >= pruned, "reaped id leaked back");
            // Bounded write: 1 delete (IN-list) + the read + batched upserts
            // of the ~100 moved rows (≤ ceil(100/160) statements) — and NOT
            // the old n+1 replace storm.
            assert.ok(
                meter.refsTouching() >= 2 && meter.refsTouching() <= 6,
                `${meter.refsTouching()} refs statements for a full renumber (old code: ${n + 1})`,
            );

            // Ghost check across an open/close cycle: reload reads the table
            // straight from disk.
            shadow.close();
            store.close();
            const reopened = UnifiedStore.open(path.join(dir, "index.db"));
            try {
                assert.equal(reopened.getRefs("renumber").length, n - pruned, "reopen sees exactly the live ledger");
            } finally {
                reopened.close();
            }
        } finally {
            meter.dispose();
        }
    } finally {
        rmBestEffort(dir);
    }
});
