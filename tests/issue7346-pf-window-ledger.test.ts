/**
 * #7346: a watermark-HIT window save must not retire the verified prefix.
 *
 * On a fastpath HIT the server pins only this turn's ~2-row window
 * (snapshotMessages(session, wpHit.windowCores)). snapshotMessages stamps the
 * pin raw (lastMessagesFolded=false), so the save presents the window as the
 * complete raw log and the #3285 authoritative-set sweep retires every ledger
 * row the window omits — a 100k-session prefix drained to the ~2-row window
 * each turn. The fix marks the pin non-raw on HIT turns
 * (lastMessagesFolded=true), so persist.ts stops passing the raw tail and the
 * sweep never fires.
 *
 * Pinned here (the sweep only runs on the FULL path, so the watermark is
 * cleared to force it):
 *  - a non-raw window save (rawTail omitted, the fix) appends the window and
 *    keeps the verified prefix — no sweep;
 *  - a raw window save (rawTail = the window, the pre-fix shape) still sweeps
 *    the prefix away — a genuine truncation is NOT masked.
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
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7346-hermetic-"));
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

function msg(i: number, text = `hello ${i}`): CoreMessage {
    return { id: `h_msg${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text } as CoreMessage;
}

function mkLegacy(id: string, lastMessages: LegacySessionLike["lastMessages"]): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        // Key order matters: loadLegacyView rebuilds state in MERGE_STATE_FIELDS
        // order and the shadow digest is JSON.stringify-based (order-sensitive).
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
    };
}

function openShadow(dir: string): { shadow: UnifiedShadow; store: UnifiedStore } {
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow, "shadow mode sidecar must open");
    return { shadow, store };
}

function liveRows(store: UnifiedStore, id: string): number {
    return store.getMessages(id).length;
}

test("a non-raw window save (the fix) appends the window and keeps the verified prefix", () => {
    const dir = tmpdir("bili-7346-fix-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const id = "pf-window-fix";
            // Establish a 100-row verified prefix (a 100k-session ledger, scaled).
            const prefix = Array.from({ length: 100 }, (_, i) => msg(i));
            shadow.record(mkLegacy(id, prefix), { lastMessages: prefix });
            assert.equal(liveRows(store, id), 100, "prefix ingested");

            // The watermark-HIT turn pins only the ~2-row window. The fix marks
            // it non-raw, so persist.ts omits the raw tail — shadow.record sees
            // rawTail=undefined and the #3285 sweep never fires. Force the full
            // path (the sweep's only home) by clearing the watermark.
            const window = [msg(100), msg(101)];
            store.clearIngestWatermark(id);
            shadow.record(mkLegacy(id, window), undefined);

            assert.equal(liveRows(store, id), 102, "prefix retained + window appended — no sweep on a HIT window save");
            // The verified head row is still live (not retired by the sweep).
            const head = store.getMessages(id).find((r) => r.msgId === "h_msg0");
            assert.ok(head, "the verified head row survived");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("a raw window save (the pre-fix shape) still sweeps the prefix — genuine truncation is not masked", () => {
    const dir = tmpdir("bili-7346-raw-");
    try {
        const { shadow, store } = openShadow(dir);
        try {
            const id = "pf-window-raw";
            const prefix = Array.from({ length: 100 }, (_, i) => msg(i));
            shadow.record(mkLegacy(id, prefix), { lastMessages: prefix });
            assert.equal(liveRows(store, id), 100, "prefix ingested");

            // The pre-fix shape: the window is pinned raw (folded=false), so
            // persist.ts passes it as the raw tail. The full path treats it as
            // the complete log and the #3285 sweep retires every prefix row the
            // window omits. This is the genuine-truncation path the fix must
            // NOT mask.
            const window = [msg(100), msg(101)];
            store.clearIngestWatermark(id);
            shadow.record(mkLegacy(id, window), { lastMessages: window, lastMessagesFolded: false });

            assert.equal(liveRows(store, id), 2, "the raw window save sweeps the verified prefix away (the bug, still reachable on genuine truncation)");
        } finally {
            shadow.close();
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
