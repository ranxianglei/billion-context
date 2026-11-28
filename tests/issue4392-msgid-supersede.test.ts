/**
 * #4392 facet C: a genuine content rewrite under a STABLE client id must retire
 * the prior generation, not accumulate a second live row. identity is
 * content-derived (identity.ts strips only id/wireIndex/ledgerSeq), so an edited
 * message takes a NEW identity → remapPlanToAbsolute mints a fresh seq and leaves
 * the old byte-row resident. The #3285 sweep retires such stale generations only
 * when opts.completeLog === true; envelope renders (completeLog-less) skip it, so
 * the stale row rode every unified replay forever (permanent DIGEST DRIFT +
 * unbounded growth; #4769 subagent-id-sharing is the common trigger). This pins
 * the targeted retirement: exactly one LIVE row per msg_id after a non-completeLog
 * re-ingest, and no churn on an unchanged re-ingest.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnifiedStore, type IngestSessionInput, type SessionRow } from "../src/storage/store.ts";
import { identityOfStoredContent } from "../src/storage/identity.ts";

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pins as the other storage suites: a developer machine with
// storage config in its real env must not leak into these tests.
process.env.BILI_STORAGE_UNIFIED = "legacy"; // hermetic tier baseline; tests drive UnifiedStore directly
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-4392-cfg-")), "no-config.json");

const M0 = "h_msg0"; // stable client id reused across generations (the #4769 shape)
const M1 = "h_msg1";

function mkSessionRow(id: string): SessionRow {
    return {
        sessionId: id,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000,
        nextBlockId: 0,
        nextRunId: 0,
        metaJson: "{}",
        statsJson: "{}",
        metadataJson: "{}",
        kstateJson: "{}",
        tailJson: "{}",
        ccrJson: "null",
    };
}

function msg(seq: number, msgId: string, text: string, role: string) {
    const content = JSON.stringify({ id: msgId, role, contentType: "text", text });
    return {
        seq,
        msgId,
        ref: null,
        refNum: seq + 1,
        role,
        kind: "text" as const,
        content,
        contentHash: sha256Hex(content),
        identity: identityOfStoredContent(content),
    };
}

function fullInput(id: string, messages: ReturnType<typeof msg>[], tailSeqs: number[]): IngestSessionInput {
    return {
        session: mkSessionRow(id),
        messages,
        blocks: [],
        deadRefs: [],
        refs: [],
        ccrEntries: [],
        pluginSnapshotSeqs: [],
        tailSeqs,
    };
}

test("facet C: rewriting a stable client id retires the stale generation (one live row, latest content)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-4392-c-rewrite-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        // save 1: M0 long generation + M1 — a completeLog-less save (no opts).
        store.ingestSession(fullInput("c4392", [msg(0, M0, "LONG-A".repeat(40), "assistant"), msg(1, M1, "keep", "user")], [0, 1]));
        assert.equal(store.getMessages("c4392").length, 2, "two live rows after save 1");

        // save 2: M0 REWRITTEN to a shorter body (same client id, NEW identity), M1
        // unchanged — still completeLog-less, the exact path where the stale row used
        // to survive and ride every replay.
        store.ingestSession(fullInput("c4392", [msg(0, M0, "short-B", "assistant"), msg(1, M1, "keep", "user")], [0, 1]));
        const rows = store.getMessages("c4392");
        assert.equal(rows.length, 2, "exactly one LIVE row per msg_id — the stale long-A generation must be retired");
        assert.equal(rows.filter((r) => r.msgId === M0).length, 1, "single live row for the rewritten client id");
        const shortBHash = sha256Hex(JSON.stringify({ id: M0, role: "assistant", contentType: "text", text: "short-B" }));
        assert.equal(rows.find((r) => r.msgId === M0)?.contentHash, shortBHash, "the surviving row carries the LATEST content");
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("facet C: an unchanged re-ingest does not churn the surviving rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-4392-c-stable-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        store.ingestSession(fullInput("c4392b", [msg(0, M0, "body", "assistant"), msg(1, M1, "keep", "user")], [0, 1]));
        const before = store.getMessages("c4392b").map((r) => `${r.msgId}@${r.contentHash}@${r.seq}`).sort();
        store.ingestSession(fullInput("c4392b", [msg(0, M0, "body", "assistant"), msg(1, M1, "keep", "user")], [0, 1]));
        const after = store.getMessages("c4392b").map((r) => `${r.msgId}@${r.contentHash}@${r.seq}`).sort();
        assert.deepEqual(after, before, "unchanged identities keep their rows and seqs (no spurious retire/remint)");
        assert.equal(after.length, 2);
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
