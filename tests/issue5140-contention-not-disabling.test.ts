/**
 * #5140/#5188 (strike-side half of the fix): the unified sidecar's 3-strike
 * disable latch used to count every ingest error equally. Under machine load
 * (CI shards: many test processes sharing one disk) sqlite surfaces
 * resource-class errors at write time — a lock held past the 5s busy_timeout,
 * a momentary disk-full, fd spikes ("briefly unavailable" signals that settle
 * on their own), NOT storage breakage. Counting them alongside corruption
 * turned ordinary load spikes into whole-process legacy-only degradations —
 * in the #5140 failure every CI red ended with exactly that state
 * (in-process probe evidence: "gateB-replicasUnavailable ... disj=disabled:
 * lastError=SQLITE_BUSY: database is busy"), and the fork raw-tail rebuild
 * fails closed at replicasAvailable() with HTTP 409 SNAPSHOT_UNAVAILABLE.
 *
 * Two gates ship here, both directions pinned (#3617 discipline):
 *  - isTransientContentionError: classification truth table;
 *  - noteIngestFailure through the REAL record() machinery: contention-class
 *    evidence never latches, structural evidence latches once and warns once,
 *    one healthy save resets the streak.
 *
 * The open-side half of #5188 (a first synchronous open that dies transiently
 * is retried from the save path) has its own suite:
 * tests/issue5188-sidecar-recoverable-open.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnifiedShadow, isTransientContentionError } from "../src/storage/shadow.ts";
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

test("isTransientContentionError: truth table (#5140/#5188)", () => {
    // resource class: real CI/engine strings — must NOT count toward the latch
    assert.equal(isTransientContentionError(new Error(BUSY)), true);
    assert.equal(isTransientContentionError(new Error("database is busy")), true, "wording alone");
    assert.equal(isTransientContentionError(new Error("SQLITE_LOCKED: database table is locked")), true);
    assert.equal(isTransientContentionError(new Error("table sessions is locked")), true);
    assert.equal(isTransientContentionError(new Error("EBUSY: resource busy or owner died")), true, "Node errno toString shape");
    assert.equal(isTransientContentionError(new Error("ENOSPC: no space left or device")), true);
    assert.equal(isTransientContentionError(new Error("database or disk is full")), true);
    assert.equal(isTransientContentionError(new Error("SQLITE_FULL: database or disk is full")), true);
    assert.equal(isTransientContentionError(new Error("EMFILE: too many open files")), true);
    assert.equal(isTransientContentionError(new Error("too many open files")), true, "fd-exhaustion wording alone");
    assert.equal(isTransientContentionError(new Error("EFILE: file table overflow")), true);
    assert.equal(
        isTransientContentionError(new Error("unable to open database file")),
        true,
        "#3823 field signature: AV/OneDrive/MAX_PATH/sandbox lock-out at CANTOPEN",
    );
    assert.equal(isTransientContentionError(new Error("SQLITE_IOERR: disk I/O error")), true);
    // structural / operator-evidence class: must keep counting toward the latch
    assert.equal(isTransientContentionError(new Error("SQLITE_CORRUPT: database disk image is malformed")), false);
    assert.equal(isTransientContentionError(new Error("database disk image is malformed")), false, "corruption wording alone");
    assert.equal(isTransientContentionError(new Error(NOTADB)), false);
    assert.equal(isTransientContentionError(new Error("file is not a database")), false, "NOTADB wording alone");
    assert.equal(isTransientContentionError(new Error("attempt to write a readonly database")), false, "#4614 readonly evidence stays loud");
    assert.equal(isTransientContentionError(new Error("session row missing after ingest: s1")), false, "internal invariant breach");
});

test("contention-class failures through record() never latch, then recover", () => {
    const shadow = mkShadow();
    try {
        const off = installFault(shadow, BUSY);
        for (let i = 0; i < 6; i++) shadow.record(fix());
        off();
        assert.equal(shadow.stats.disabled, false, "six contention-class failures stay non-latching");
        assert.match(String(shadow.stats.lastError), /SQLITE_BUSY/, "evidence still observable in lastError");
        const before = shadow.stats.ingests;
        shadow.record(fix());
        assert.equal(shadow.stats.disabled, false, "healthy save after the noise still works");
        assert.ok(shadow.stats.ingests > before, "ingest pipeline resumes cleanly");
    } finally {
        shadow.close();
    }
});

test("structural failures latch exactly once with one warn line", () => {
    const shadow = mkShadow();
    const lines: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") lines.push(msg); });
    try {
        const off = installFault(shadow, NOTADB);
        for (let i = 0; i < 4; i++) shadow.record(fix());
        off();
        assert.equal(shadow.stats.disabled, true, "three structural strikes latch the sidecar");
        assert.match(String(shadow.stats.lastError), /NOTADB|file is not a database/);
        const disables = lines.filter((l) => /disabled after 3 consecutive failures/.test(l));
        assert.equal(disables.length, 1, "latch warn fires exactly once (no per-save spam after)");
        assert.equal(lines.filter((l) => /failed to ingest/.test(l)).length, 1, "first-failure warn also fires exactly once");
        shadow.record(fix());
        assert.equal(lines.filter((l) => /disabled after/.test(l)).length, 1, "still one after a later save");
    } finally {
        setLogCapture(null);
        shadow.close();
    }
});

test("mixed contention + structural converges to the latch", () => {
    const shadow = mkShadow();
    try {
        let off = installFault(shadow, NOTADB);
        shadow.record(fix()); // strike 1
        off();
        off = installFault(shadow, BUSY);
        shadow.record(fix()); // ignored — contention
        off();
        off = installFault(shadow, NOTADB);
        shadow.record(fix()); // strike 2
        off();
        off = installFault(shadow, NOTADB);
        shadow.record(fix()); // strike 3 -> latch
        off();
        assert.equal(shadow.stats.disabled, true, "interleaved contention does not dilute structural evidence");
    } finally {
        shadow.close();
    }
});

test("one healthy save resets the structural streak", () => {
    const shadow = mkShadow();
    try {
        let off = installFault(shadow, NOTADB);
        shadow.record(fix()); // 1
        off();
        off = installFault(shadow, NOTADB);
        shadow.record(fix()); // 2
        off();
        shadow.record(fix()); // healthy -> counter back to 0
        off = installFault(shadow, NOTADB);
        shadow.record(fix()); // 1 again
        off();
        off = installFault(shadow, NOTADB);
        shadow.record(fix()); // 2 again — two, not four
        off();
        assert.equal(shadow.stats.disabled, false, "streak reset by the healthy save (no latch)");
    } finally {
        shadow.close();
    }
});
