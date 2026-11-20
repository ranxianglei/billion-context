import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { rmrf } from "./tmp-rm.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";

// #7335: one corrupt row must not destroy a session. Field data: 26 content
// rows of a single pi session (poisoned by an older dev build — CAS hash did
// not match the stored bytes, JSON unparseable) made the unified cold load
// throw, the legacy fallback found no file, the state was discarded and a
// 600K-token context re-folded from scratch (32 serial summary rounds,
// 67–84s each — user-visible freeze). Two structural gaps fixed here:
//   1. writer: putContent trusted caller-supplied digests without verifying
//      them against the bytes (#3133 skipped the re-hash); a mismatched pair
//      now fails the save loudly instead of persisting poison.
//   2. reader: LegacyViewBuilder addBlocks/addMessages parsed every row
//      without isolation; an unparseable row now degrades the view (recorded
//      in skippedCorruptRows, counted into tailGaps, logged) instead of
//      aborting the whole load.

function seed(id: string): LegacySessionLike {
    // No `ts`: it rides a dedicated column and never the content bytes
    // (#4313), so a stamped message would digest-drift on every verify-sample
    // and mask whether the corruption is what the drift actually came from.
    const messages = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, role: "user" as const, contentType: "text" as const, text: `original ${i}` }));
    const blocks: LegacySessionLike["state"]["blocks"] = messages.map((message, i) => ({
        blockId: `b${i}`, runId: "r1", tier: 1, summary: `summary ${i}`, directMessageIds: [message.id],
        effectiveMessageIds: [message.id], directBlockIds: [], compressedTokens: 1, createdAt: 1,
        survivedCount: 0, generation: "young", active: i % 2 === 0,
    }));
    return {
        id, createdAt: 1, lastSeen: 2, meta: {}, stats: {}, metadata: {},
        state: { blocks, nextBlockId: 5, nextRunId: 2, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(blocks.map((block, i) => [block.blockId, {
            full: { text: `full 海🌊 ${i}`, count: 1 }, one: { text: `one ${i}`, count: 1 },
        }])), lastMessages: messages, lastMessagesFolded: false,
    };
}

function fixture(t: TestContext): { store: UnifiedStore; db: ReturnType<typeof openSqliteDatabase>["db"]; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "bili-poison-row-"));
    process.env.BILI_CONFIG_FILE = join(dir, "no-config.json");
    const store = UnifiedStore.open(join(dir, "index.db"));
    const db = openSqliteDatabase(join(dir, "index.db"), "node:sqlite").db;
    // Teardown ordering: node:test runs t.after hooks in REGISTRATION order
    // (FIFO), so this hook — registered first — closes only the fixture's own
    // connections. Each test registers a later hook that closes the shadow
    // (if any) and runs rmrf; deleting the dir while the shadow's connection
    // is still open is a deterministic EBUSY on Windows (unlink of an open
    // file), not an AV flake. rmrf (tests/tmp-rm.ts) keeps the exponential
    // retry ladder for the true external AV/indexer race (#2799/#2908).
    t.after(() => { store.close(); db.close(); });
    return { store, db, dir };
}

test("writer: mismatched precomputed digest is refused, nothing persists", (t) => {
    const { store, db, dir } = fixture(t);
    t.after(() => rmrf(dir));
    const clean = planIngest(seed("target"));
    assert.equal(store.ingestSession(clean, undefined, { completeLog: true }), true);

    const poisoned = planIngest(seed("target2"));
    assert.ok(poisoned.messages.length > 0);
    poisoned.messages[0] = { ...poisoned.messages[0], contentHash: "0".repeat(64) };
    assert.throws(
        () => store.ingestSession(poisoned, undefined, { completeLog: true }),
        /content CAS digest mismatch/,
    );
    // The failed save must leave no row behind (transaction rolled back).
    const rows = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get("target2") as { n: number };
    assert.equal(rows.n, 0);
    const cas = db.prepare("SELECT COUNT(*) AS n FROM content WHERE hash = ?").get("0".repeat(64)) as { n: number };
    assert.equal(cas.n, 0);
});

test("reader: one unparseable message row degrades the view instead of aborting the load", (t) => {
    const { store, db, dir } = fixture(t);
    const plan = planIngest(seed("target"));
    assert.equal(store.ingestSession(plan, undefined, { completeLog: true }), true);

    const row = db.prepare("SELECT seq, content_hash FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get("target") as { seq: number; content_hash: string };
    db.prepare("UPDATE content SET bytes = X'7b6f6f7073' WHERE hash = ?").run(row.content_hash);

    const shadow = UnifiedShadow.maybeOpen(dir, { ...process.env, BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    t.after(() => { shadow.close(); rmrf(dir); });
    const view = shadow.viewFor("target") as LegacySessionLike & { tailGaps?: number } | null;
    assert.ok(view, "the session must still load with one corrupt row");
    // The corrupt row is skipped; everything else survives.
    assert.ok((view!.tailGaps ?? 0) >= 1, "corrupt tail row counted as a gap");
    assert.equal(view!.lastMessages!.length, 3);
    assert.equal(view!.state.blocks!.length, 4, "blocks survive a corrupt message row");
});

test("reader: one unparseable block payload degrades the view instead of aborting the load", (t) => {
    const { store, db, dir } = fixture(t);
    const plan = planIngest(seed("target"));
    assert.equal(store.ingestSession(plan, undefined, { completeLog: true }), true);

    db.prepare("UPDATE blocks SET payload_json = X'7b6f6f7073' WHERE session_id = ? AND block_id = ?").run("target", "b0");

    const shadow = UnifiedShadow.maybeOpen(dir, { ...process.env, BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    t.after(() => { shadow.close(); rmrf(dir); });
    const view = shadow.viewFor("target") as LegacySessionLike & { tailGaps?: number } | null;
    assert.ok(view, "the session must still load with one corrupt block row");
    assert.equal(view!.lastMessages!.length, 4, "messages survive a corrupt block row");
    assert.equal(view!.state.blocks!.length, 3);
    // Block summaries live in the content CAS (summary_hash/one_hash), not in
    // payload_json — they survive the payload corruption.
    assert.equal(view!.blockContents.size, 4);
});

test("reader: one unparseable block summary CAS row degrades the view instead of aborting the load", (t) => {
    const { store, db, dir } = fixture(t);
    const plan = planIngest(seed("target"));
    assert.equal(store.ingestSession(plan, undefined, { completeLog: true }), true);

    const row = db.prepare("SELECT summary_hash FROM blocks WHERE session_id = ? AND block_id = ?").get("target", "b0") as { summary_hash: string };
    db.prepare("UPDATE content SET bytes = X'7b6f6f7073' WHERE hash = ?").run(row.summary_hash);

    const shadow = UnifiedShadow.maybeOpen(dir, { ...process.env, BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    t.after(() => { shadow.close(); rmrf(dir); });
    const view = shadow.viewFor("target") as LegacySessionLike | null;
    assert.ok(view, "the session must still load with one corrupt block content row");
    assert.equal(view!.lastMessages!.length, 4, "messages survive a corrupt block content row");
    assert.equal(view!.state.blocks!.length, 4, "the block's state row survives; only its text is unreadable");
    // The poisoned block's text is missing from the raw view; the inline
    // summary in payload_json is the designed fallback (completeBlockContents),
    // and the next full ingest re-points the row at the synthesized content.
    assert.equal(view!.blockContents.has("b0"), false);
    assert.equal(view!.blockContents.size, 3);
});

test("verify-sample: one unparseable message row marks drift instead of failing every save", (t) => {
    const { store, db, dir } = fixture(t);
    const plan = planIngest(seed("target"));
    assert.equal(store.ingestSession(plan, undefined, { completeLog: true }), true);

    // Poison the tail message's CAS bytes (the incident shape: 26 message
    // content rows of one session). Message rows are INSERT OR IGNORE, so the
    // corrupt row SURVIVES the next ingest — the stored tail still points at
    // it, and the verify-sample reads it back.
    const row = db.prepare("SELECT content_hash FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get("target") as { content_hash: string };
    db.prepare("UPDATE content SET bytes = X'7b6f6f7073' WHERE hash = ?").run(row.content_hash);

    const shadow = UnifiedShadow.maybeOpen(dir, { ...process.env, BILI_STORAGE_UNIFIED: "full" }, (record) => record as LegacySessionLike);
    assert.ok(shadow);
    t.after(() => { shadow.close(); rmrf(dir); });
    // The host's LIVE record still carries the message in memory — that is
    // what record() receives, not the degraded view.
    assert.doesNotThrow(() => shadow.record(seed("target")));
    // The poisoned row surfaces as loud drift (the designed heal path:
    // watermark drop, drift latch, escalation streak), not as a verify-sample
    // throw that failed every subsequent save until the store was cleaned by
    // hand (the incident's symptom #5).
    assert.equal(shadow.stats.verifySamples, 1);
    assert.equal(shadow.stats.verifyDrift, 1);
    assert.match(shadow.stats.lastError ?? "", /digest drift/);
});

test("verify-sample: one unparseable block content row marks drift instead of failing every save", (t) => {
    const { store, db, dir } = fixture(t);
    const plan = planIngest(seed("target"));
    assert.equal(store.ingestSession(plan, undefined, { completeLog: true }), true);

    // Poison the CAS body of block b0's full summary — the sibling parse
    // site of the message row above, reached through the verifier's block
    // replay (BatchedViewVerification.addBlocks). The CAS is insert-if-absent,
    // so the poisoned row survives the re-ingest and the sampled read-back
    // is the surface that sees it.
    const row = db.prepare("SELECT summary_hash FROM blocks WHERE session_id = ? AND block_id = ?").get("target", "b0") as { summary_hash: string };
    db.prepare("UPDATE content SET bytes = X'7b6f6f7073' WHERE hash = ?").run(row.summary_hash);

    const shadow = UnifiedShadow.maybeOpen(dir, { ...process.env, BILI_STORAGE_UNIFIED: "full" }, (record) => record as LegacySessionLike);
    assert.ok(shadow);
    t.after(() => { shadow.close(); rmrf(dir); });
    assert.doesNotThrow(() => shadow.record(seed("target")));
    assert.equal(shadow.stats.verifySamples, 1);
    assert.equal(shadow.stats.verifyDrift, 1);
    assert.match(shadow.stats.lastError ?? "", /digest drift/);
});
