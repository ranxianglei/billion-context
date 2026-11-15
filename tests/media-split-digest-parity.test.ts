import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreMessage } from "acp-kernel";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #6351: the sampled digest compared the same message in two different media
 * representations and latched drift forever.
 *
 * Rows are WRITTEN media-split (`planIngest` -> `splitMediaContent`, big
 * payloads replaced by `{"$media":hash}` CAS references) but the verifier reads
 * them back through `UnifiedStore.getMessages()`, which returns them
 * media-HYDRATED. The envelope's `lastMessages` keeps the split form, so a
 * positional digest compared a ~2 KB placeholder against a ~200 KB inlined
 * payload and reported drift on every sample: the #5677 latch, then a full
 * transform of the whole tail on every save (measured 8-9 s per save).
 *
 * The fix normalizes both legs to the split form before hashing
 * (`splitMediaContent` is idempotent on already-split input, and
 * `splitMediaContent(hydrate(x)) === x` on every media-bearing row sampled), so
 * the same message hashes equal while a real edit still diverges.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-media-parity-"));
process.env.BILI_CONFIG_FILE = path.join(root, "no-config.json");
process.env.BILI_PERSIST_ZSTD = "0";
after(() => fs.rmSync(root, { recursive: true, force: true }));

const MEDIA_PAYLOAD = "A".repeat(4096);

function mediaMessage(i: number): CoreMessage {
    return {
        id: `media-${i}`,
        role: "user",
        contentType: "image",
        imageBase64: MEDIA_PAYLOAD,
    } as unknown as CoreMessage;
}

function splitForm(message: CoreMessage): CoreMessage {
    const mediaHash = createHash("sha256").update(MEDIA_PAYLOAD).digest("hex");
    return { ...message, imageBase64: { $media: mediaHash } } as unknown as CoreMessage;
}

function view(messages: CoreMessage[], folded: boolean): LegacySessionLike {
    return {
        id: "media-session",
        createdAt: 1_700_000_000_000,
        lastSeen: 1_700_000_000_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages: messages,
        lastMessagesFolded: folded,
    } as LegacySessionLike;
}

/** Envelope = the newest N messages in SPLIT form; rows stay hydrated. */
function verifyFold(t: TestContext): void {
    const dir = fs.mkdtempSync(path.join(root, "case-"));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    let legacy = view([], false);
    const shadow = Reflect.construct(
        UnifiedShadow,
        ["shadow", store, () => legacy, undefined],
    ) as UnifiedShadow;
    t.after(async () => {
        await shadow.closeAsync();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const all = Array.from({ length: 6 }, (_, i) => mediaMessage(i));
    // Baseline: full raw tail, so the first sampled verification compares equal.
    legacy = view(all, false);
    shadow.record({ id: legacy.id });

    assert.equal(shadow.stats.verifySamples, 1, "the baseline save must be verified");
    assert.equal(shadow.stats.verifyDrift, 0, "the baseline save must not drift");

    // The bytes on disk must actually be split; otherwise this fixture proves
    // nothing about media hydration.
    const { db } = openSqliteDatabase(dbPath);
    let stored: string;
    try {
        const row = db
            .prepare(
                `SELECT c.bytes FROM messages m JOIN content c ON c.hash = m.content_hash
                 WHERE m.session_id = ? ORDER BY m.seq ASC LIMIT 1`,
            )
            .get(legacy.id) as { bytes: unknown } | undefined;
        assert.ok(row, "the ingested row must exist");
        stored = Buffer.isBuffer(row!.bytes)
            ? row!.bytes.toString("utf8")
            : new TextDecoder().decode(row!.bytes as Uint8Array);
    } finally {
        db.close();
    }
    assert.ok(stored.includes("$media"), `stored bytes must be media-split, got: ${stored.slice(0, 120)}`);

    // Now the envelope carries only the newest two messages, in SPLIT form —
    // exactly what `boundedFoldedSnapshot` leaves behind for a large session.
    legacy = view(all.slice(-2).map(splitForm), true);
    for (let i = 0; i < 20; i += 1) {
        shadow.record({ id: legacy.id });

    }

    assert.equal(shadow.stats.verifySamples, 2, "the second sample must have run (VERIFY_EVERY_INGESTS)");
    assert.equal(
        shadow.stats.verifyDrift,
        0,
        "a split envelope slot must hash equal to its hydrated row",
    );
    assert.equal(shadow.driftedSessions.size, 0, "no session may stay latched");
    assert.equal(shadow.frozenEnvelopeIds.size, 0, "the envelope must not be frozen");
}

test("split envelope slot must verify clean against its hydrated row", (t) => {
    verifyFold(t);
});

test("a real media change inside the envelope window still reports drift", (t) => {
    const dir = fs.mkdtempSync(path.join(root, "case-edit-"));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    let legacy = view([], false);
    const shadow = Reflect.construct(
        UnifiedShadow,
        ["shadow", store, () => legacy, undefined],
    ) as UnifiedShadow;
    t.after(async () => {
        await shadow.closeAsync();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const all = Array.from({ length: 6 }, (_, i) => mediaMessage(i));
    legacy = view(all.slice(-2).map(splitForm), true);
    // Corrupt the LAST tail row's stored bytes so it can no longer match the
    // envelope: the row is hydrated from CAS, so rewriting the content row is
    // what a real divergence looks like on the row leg.
    const getSessionRow = store.getSessionRow.bind(store);
    let corrupted = false;
    t.mock.method(store, "getSessionRow", (id: string) => {
        if (!corrupted) {
            corrupted = true;
            const { db } = openSqliteDatabase(dbPath);
            try {
                const last = db
                    .prepare(
                        `SELECT m.content_hash AS hash FROM messages m
                         WHERE m.session_id = ? ORDER BY m.seq DESC LIMIT 1`,
                    )
                    .get(legacy.id) as { hash: string } | undefined;
                if (last) {
                    db.prepare(`UPDATE content SET bytes = ?, byte_len = ? WHERE hash = ?`).run(
                        JSON.stringify({
                            id: "media-9",
                            role: "user",
                            contentType: "image",
                            imageBase64: "B".repeat(4096),
                        }),
                        4096,
                        last.hash,
                    );
                }
            } finally {
                db.close();
            }
        }
        return getSessionRow(id);
    });

    for (let i = 0; i < 21; i += 1) {
        shadow.record({ id: legacy.id });

    }

    assert.ok(shadow.stats.verifyDrift >= 1, "a genuine content divergence must still be reported");
    assert.equal(shadow.driftedSessions.size, 1, "the session must be latched for a genuine divergence");
});
