/**
 * #5140/#5188 strike-side — re-pinned to the FINAL owner policy (2026-10-30):
 * there is NO circuit breaker at all. The old 3-strike latch (and #5188's
 * transient-vs-structural classification, isTransientContentionError) was
 * removed because "refusing to write" risks data loss in situations nobody
 * can enumerate ("real life has a hundred causes; you only handle three") —
 * so every ingest failure, whatever its shape, is recorded loudly (one warn
 * per DISTINCT error message — no per-save spam for a stuck failure mode)
 * and the NEXT save retries the index write unconditionally; recovery is
 * instant once the cause clears. The JSON envelope keeps serving meanwhile
 * either way, so no turn ever lands somewhere unsafe.
 *
 * Pinned both directions (#3617 discipline): resource-class evidence AND
 * structural-class evidence both stay non-latching through the REAL
 * record() machinery, lastError stays observable, healing is immediate, and
 * the source itself contains no breaker machinery left behind.
 *
 * The open-side half of #5188 (demand-driven reopen from the save/read
 * paths) is tested in tests/issue5188-sidecar-recoverable-open.test.ts; note
 * it now only applies mid-process — a first open failure at boot refuses to
 * start instead (round 3), and a proven-corrupt index is alarm-only with an
 * operator hand-fix, never auto-retried (hadIntegrityQuickCheckFailure).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { setLogCapture } from "../src/logger.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";

const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5140-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;
delete process.env.BILI_ENCRYPTION_KEY;

function mkShadow(): UnifiedShadow {
    const dir = fs.mkdtempSync(path.join(HERMETIC, "sh-"));
    // Passthrough loader: record() round-trips the fixture straight into the
    // ingest pipeline (the production seam loads the JSON envelope first).
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, (r) => r as LegacySessionLike);
    assert.ok(shadow !== null, "hermetic shadow must open (real sqlite engine present)");
    return shadow;
}

let seq = 0;
function fix(): LegacySessionLike {
    // Fresh id per record: the sampled read-back verify (the fault seam's
    // site) runs on a session's FIRST ingest only (VERIFY_EVERY_INGESTS), so
    // a fixed id would let records 2–19 skip past the seam entirely.
    seq++;
    return {
        id: `cont-s${seq}`,
        createdAt: 1_000,
        lastSeen: 2_000 + seq,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 1, nextRunId: 1 },
        blockContents: new Map<string, string>(),
        lastMessages: [],
        lastMessagesFolded: false,
    } as unknown as LegacySessionLike;
}

/** Fault seam on the verify leg's read-back: record()'s ingest runs for real
 *  (the row lands), then getBlocks throws the exact engine error text — so
 *  the throw travels the same catch as a genuine sqlite write/read failure
 *  and reaches noteIngestFailure without stubbing the store itself. The seam
 *  sits on getBlocks (not getMessages) because the #5198 batched verifier
 *  only fetches messages for the tail seqs it needs — this fixture carries
 *  none, while getBlocks is the verify leg's unconditional first read-back. */
type SyncLike = { getBlocks: (id: string, opts?: { limit: number; offset?: number }) => unknown[] };
function installFault(shadow: UnifiedShadow, message: string): () => void {
    const sync = (shadow as unknown as { sync: SyncLike }).sync;
    const orig = sync.getBlocks;
    sync.getBlocks = () => { throw new Error(message); };
    return () => { sync.getBlocks = orig; };
}

const BUSY = "SQLITE_BUSY: database is busy";
const NOTADB = "SQLITE_NOTADB: file is not a database";

test("resource-class failures never latch — retries continue, then recover (#5140 final policy)", () => {
    const shadow = mkShadow();
    try {
        const off = installFault(shadow, BUSY);
        for (let i = 0; i < 6; i++) shadow.record(fix());
        off();
        assert.equal(shadow.stats.disabled, false, "six load-spike failures change nothing");
        assert.match(String(shadow.stats.lastError), /SQLITE_BUSY/, "evidence still observable in lastError");
        const before = shadow.stats.ingests;
        shadow.record(fix());
        assert.equal(shadow.stats.disabled, false, "healthy save after the noise still works");
        assert.ok(shadow.stats.ingests > before, "ingest pipeline resumes cleanly");
    } finally {
        shadow.close();
    }
});

test("structural failures ALSO never latch — one warn, every save retries, instant heal (#5140 final policy)", () => {
    const shadow = mkShadow();
    const lines: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") lines.push(msg); });
    try {
        const off = installFault(shadow, NOTADB);
        for (let i = 0; i < 4; i++) shadow.record(fix());
        off();
        assert.equal(shadow.stats.disabled, false, "structural evidence must NOT disable anything any more");
        assert.match(String(shadow.stats.lastError), /NOTADB|file is not a database/, "evidence stays observable");
        assert.equal(lines.filter((l) => /failed to ingest/.test(l)).length, 1, "same message warns exactly once (no per-save spam)");
        const before = shadow.stats.ingests;
        shadow.record(fix());
        assert.equal(shadow.stats.disabled, false);
        assert.ok(shadow.stats.ingests > before, "healing is immediate once the cause clears — no probe/cooldown wait");
    } finally {
        setLogCapture(null);
        shadow.close();
    }
});

test("no breaker machinery remains in the source (#5188 classifier withdrawn)", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname ?? ".", "..", "src", "storage", "shadow.ts"), "utf8");
    assert.doesNotMatch(src, /isTransientContentionError/, "transient/structural classifier is gone");
    assert.doesNotMatch(src, /MAX_CONSECUTIVE_FAILURES/, "strike count is gone");
    assert.doesNotMatch(src, /nextReenableProbeAt|REENABLE_PROBE_COOLDOWN_MS/, "re-enable probe is gone");
    assert.match(src, /NEVER gives up on index writes/, "final policy is documented where it lives");
});
