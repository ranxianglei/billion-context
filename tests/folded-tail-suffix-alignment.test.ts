import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompressionBlock, CoreMessage } from "acp-kernel";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * Regression: the sampled read-back verifier must align the ENVELOPE leg to the
 * ROW tail by SUFFIX, not by index 0.
 *
 * The two legs intentionally hold different slices of the same log:
 *   - the rows hold the raw tail interned at save time (`tailSeqs`, oldest-first,
 *     the whole resident window), and
 *   - the envelope holds `boundedFoldedSnapshot`, which prunes from the FRONT and
 *     keeps the NEWEST messages under `persist.tailTokens` (#2960 (5), caveat 2a).
 *
 * Measured on live sessions, envelope `payload.messages` is an EXACT element-wise
 * suffix of `tail_json.tailSeqs` — session A tail=1146/envelope=24 and session B
 * tail=832/envelope=38, with zero id mismatches and zero content mismatches inside
 * the overlap, stable across a six-sample sweep.
 *
 * `compareMessages` used to walk both legs from index 0, so every row slot outside
 * the envelope window produced `want === undefined` -> `changed(key)`. The sampled
 * digest therefore never converged: the streak latched (#5677), the delta fast path
 * was disabled for the session, and each save paid a FULL ingest. Measured on
 * session B: 44 full ingests, avg 4522 ms, max 9363 ms, 170.8 s of stalled event
 * loop in one episode.
 *
 * The fix compares only the overlap at its suffix offset. This test pins both
 * halves of that contract:
 *   1. a row tail LONGER than the envelope with a matching overlap verifies clean;
 *   2. a content divergence INSIDE the overlap still reports drift.
 *
 * Sampling cadence matters here: `VERIFY_EVERY_INGESTS = 20`, so the second sampled
 * save is ingest #21, not #2.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-tail-suffix-"));
process.env.BILI_CONFIG_FILE = path.join(root, "no-config.json");
process.env.BILI_PERSIST_ZSTD = "0";
after(() => {
    try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* a leaked temp dir on a Windows runner is harmless */
    }
});

const TAIL_LEN = 40;
const ENVELOPE_LEN = 8;

function message(i: number): CoreMessage {
    return { id: `raw-${i}`, role: "user", contentType: "text", text: `message ${i}` };
}

function view(opts: { tail?: CoreMessage[]; folded?: boolean } = {}): LegacySessionLike {
    const blocks: CompressionBlock[] = [];
    const messages = Array.from({ length: TAIL_LEN }, (_, i) => message(i));
    return {
        id: "suffix-session",
        createdAt: 1_700_000_000_000,
        lastSeen: 1_700_000_000_500,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks,
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages: opts.tail ?? messages,
        lastMessagesFolded: opts.folded === true,
    } as LegacySessionLike;
}

function shadowOf(shadow: UnifiedShadow) {
    return shadow as unknown as {
        stats: { verifySamples: number; verifyOk: number; verifyDrift: number; lastError?: string | null };
        driftedSessions: Set<string>;
        frozenEnvelopeIds: Set<string>;
    };
}

/**
 * Save a long tail (the row now claims TAIL_LEN slots), then keep saving folded
 * envelopes while the session row still advertises the long `tailSeqs`. That is
 * exactly the production shape: `tailSeqs` length > `payload.messages` length.
 */
function verifyFoldAfterLongTail(t: TestContext, opts: { corruptOverlap?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(root, "case-"));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    let legacy: LegacySessionLike = view();
    const shadow = Reflect.construct(UnifiedShadow, ["shadow", store, (record: unknown) => {
        void record;
        return legacy;
    }, undefined]) as UnifiedShadow;
    t.after(async () => {
        await shadow.closeAsync();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const stats = shadowOf(shadow);

    shadow.record(legacy, { lastMessages: legacy.lastMessages ?? [], lastMessagesFolded: false });
    assert.equal(stats.stats.verifySamples, 1, "first ingest samples the read-back verify");
    assert.equal(stats.stats.verifyDrift, 0, `baseline save must be clean: ${stats.stats.lastError ?? ""}`);

    const longRow = store.getSessionRow(legacy.id);
    assert.ok(longRow, "session row must exist after the long save");
    const longTail = JSON.parse(longRow.tailJson) as { tailSeqs: number[] };
    assert.equal(longTail.tailSeqs.length, TAIL_LEN, "row tail must intern the whole resident window");

    // Keep the row's `tailSeqs` long while each envelope carries only the newest
    // slice, and (for the corrupt variant) rewrite one overlap slot's stored bytes
    // at the exact seam the verifier uses, i.e. AFTER the ingest transaction has
    // committed. Rewriting `messages.content_hash` instead would break the content
    // FK/refcount bookkeeping and abort the ingest before any sample runs.
    const targetSeq = longTail.tailSeqs[longTail.tailSeqs.length - 1]!;
    const donorSeq = longTail.tailSeqs[longTail.tailSeqs.length - ENVELOPE_LEN]!;
    const getSessionRow = store.getSessionRow.bind(store);
    let served = 0;
    let corrupted = false;
    t.mock.method(store, "getSessionRow", (id: string) => {
        const row = getSessionRow(id) as { tailJson: string } | undefined;
        if (!row) return row;
        served++;
        if (opts.corruptOverlap === true && !corrupted) {
            corrupted = true;
            const { db } = openSqliteDatabase(dbPath);
            try {
                const pick = db.prepare("SELECT content_hash FROM messages WHERE session_id = ? AND seq = ?");
                const target = pick.get(legacy.id, targetSeq) as { content_hash: string } | undefined;
                const donor = pick.get(legacy.id, donorSeq) as { content_hash: string } | undefined;
                assert.ok(target && donor, "both overlap slots must have rows");
                const donorBody = db.prepare("SELECT bytes, byte_len, algo FROM content WHERE hash = ?").get(donor.content_hash) as
                    | { bytes: unknown; byte_len: number; algo: string }
                    | undefined;
                assert.ok(donorBody, "donor content row must exist");
                db.prepare("UPDATE content SET bytes = ?, byte_len = ?, algo = ? WHERE hash = ?").run(
                    donorBody.bytes,
                    donorBody.byte_len,
                    donorBody.algo,
                    target.content_hash,
                );
            } finally {
                db.close();
            }
        }
        const tail = JSON.parse(row.tailJson) as Record<string, unknown>;
        return { ...row, tailJson: JSON.stringify({ ...tail, tailSeqs: longTail.tailSeqs }) };
    });

    const base = view();
    const suffix = (base.lastMessages ?? []).slice(-ENVELOPE_LEN);
    for (let i = 0; i < 20; i++) {
        legacy = view({ tail: suffix, folded: true });
        shadow.record(legacy, undefined);
    }

    assert.ok(served > 0, "the verifier must read the session row (test seam actually engaged)");
    assert.equal(stats.stats.verifySamples, 2, "ingest #21 is the second sampled verify");
    return stats;
}

test("folded envelope that is a suffix of the row tail must verify clean", (t) => {
    const stats = verifyFoldAfterLongTail(t);
    assert.equal(
        stats.stats.verifyDrift,
        0,
        `envelope is a suffix of the row tail: comparing from index 0 flags every slot outside the window (${stats.stats.lastError ?? ""})`,
    );
    assert.equal(stats.driftedSessions.size, 0, "no session may latch as drift-latched");
    assert.equal(stats.frozenEnvelopeIds.size, 0, "envelope writes must not be frozen");
});

test("content divergence inside the overlap still reports drift", (t) => {
    const stats = verifyFoldAfterLongTail(t, { corruptOverlap: true });
    assert.equal(stats.stats.verifyDrift, 1, "a real content change inside the envelope window must still be caught");
    assert.equal(stats.driftedSessions.size, 1);
});
