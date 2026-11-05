import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #3901 / #3762 — media-level content addressing.
 *
 * The same image posted into two conversations (or twice into one) is stored
 * once: ingest splits media sidecars (imageBase64) out of the message JSON
 * into content-CAS media rows; the stored message content keeps the key
 * POSITION and carries a media reference value; getMessages() hydrates the
 * bytes back so every reader sees the ORIGINAL verbatim JSON (byte-identical
 * round-trip). Deleting the last referencing session releases the media row.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-media-cas-")),
    "no-config.json",
);

const IMG_B64 = "a".repeat(4096); // stand-in for base64 image bytes

interface CoreMsg { id: string; role: string; contentType: string; text: string; imageBase64?: string; imageMediaType?: string }

const mkMsg = (id: string, text: string, image?: string): CoreMsg => ({
    id,
    role: "user",
    contentType: image !== undefined ? "image" : "text",
    text,
    ...(image !== undefined ? { imageBase64: image, imageMediaType: "image/png" } : {}),
});

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai" },
    stats: {},
    metadata: {},
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

test("media CAS: same image in two sessions stored once; round-trip verbatim; release on delete", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const mA = mkMsg("m-a", "look at this in session A", IMG_B64);
        const mB = mkMsg("m-b", "same screenshot in session B", IMG_B64);
        const mC = mkMsg("m-c", "plain text message");
        store.ingestSession(planIngest(mkSession("sess-A", [mA, mC])));
        store.ingestSession(planIngest(mkSession("sess-B", [mB])));

        // (1) Media bytes exist exactly once, referenced by both messages.
        assert.equal(store.mediaRefCount(IMG_B64), 2, "one media row, two references");

        // (2) STORED (pre-hydration) message content does NOT inline the
        // base64 — query the table directly; getMessages always hydrates.
        const rawStore = store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): { content_hash: string }[] } }; getContent?(h: string): string | null };
        const rawRows = (sid: string): { content_hash: string }[] =>
            rawStore.db.prepare("SELECT content_hash FROM messages WHERE session_id = ?").all(sid);
        for (const sid of ["sess-A", "sess-B"]) {
            for (const row of rawRows(sid)) {
                const body = (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { bytes: Uint8Array } | undefined } } })
                    .db.prepare("SELECT bytes FROM content WHERE hash = ?").get(row.content_hash);
                assert.ok(body, `content row for ${sid}`);
                assert.ok(!Buffer.from(body.bytes).toString("utf8").includes(IMG_B64), `stored content must not inline media bytes (${sid})`);
            }
        }
        // (3) …and getMessages hydrates back to the ORIGINAL verbatim JSON.
        const rowsA = store.getMessages("sess-A");
        assert.equal(JSON.parse(rowsA[0].content).imageBase64, IMG_B64);
        assert.equal(rowsA[0].content, JSON.stringify(mA), "byte-identical round-trip");

        // (4) Deleting one session keeps the shared media row; deleting both releases it.
        store.deleteSession("sess-A");
        assert.equal(store.mediaRefCount(IMG_B64), 1, "shared media survives one deletion");
        store.deleteSession("sess-B");
        assert.equal(store.mediaRefCount(IMG_B64), 0, "last reference gone → media row released");

        // (5) Legacy rows (inline bytes, pre-split) still read back verbatim.
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("media CAS: viewFor round-trip through loadLegacyView carries hydrated messages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-2-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const m = mkMsg("m-img", "image turn", IMG_B64);
        store.ingestSession(planIngest(mkSession("sess-img", [m])));
        const view = loadLegacyView({
            session: store.getSessionRow("sess-img")!,
            messages: store.getMessages("sess-img"),
            blocks: store.getBlocks("sess-img"),
            deadRefs: store.getDeadRefs("sess-img"),
            refs: store.getRefs("sess-img"),
        }) as LegacySessionLike & { lastMessages?: CoreMsg[] };
        const tail = (view.lastMessages ?? []) as CoreMsg[];
        assert.equal(tail.length, 1);
        assert.equal(tail[0].imageBase64, IMG_B64, "view path hydrates media bytes");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("media CAS: stale-row sweep releases media refs and mappings (full re-ingest drops the image)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-3-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const mImg = mkMsg("m-img", "image turn", IMG_B64);
        const mTxt = mkMsg("m-txt", "plain turn");
        store.ingestSession(planIngest(mkSession("sess-sweep", [mImg, mTxt])), undefined, { completeLog: true });
        assert.equal(store.mediaRefCount(IMG_B64), 1, "one media reference before re-ingest");

        // The session's raw tail no longer contains the image message: the
        // full path sweeps the stale row into a #4390 historian tombstone —
        // its media mapping and CAS refcount must still go with it, or the
        // bulky image bytes leak until archive (#3762 review, #3901, #4506).
        // The TEXT row itself stays retired (retired_at set), never deleted.
        store.ingestSession(planIngest(mkSession("sess-sweep", [mTxt])), undefined, { completeLog: true });

        assert.equal(store.mediaRefCount(IMG_B64), 0, "swept message released its media ref");
        const mappings = (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): { n: number }[] } } })
            .db.prepare("SELECT COUNT(*) AS n FROM message_media WHERE session_id = ?").all("sess-sweep");
        assert.equal(mappings[0].n, 0, "swept media mappings deleted");
        const rows = (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): { n: number; retired: number }[] } } })
            .db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN retired_at IS NULL THEN 1 ELSE 0 END) AS retired FROM messages WHERE session_id = ?").all("sess-sweep");
        assert.equal(rows[0].n, 2, "historian keeps both rows (one live, one tombstoned)");
        assert.equal(rows[0].retired, 1, "only the surviving message is live");

        // #4506 rewind-redo: the SAME image message comes back (undo of the
        // undo). The tombstone reactivates in place AND its media mapping +
        // refcount are re-established by the re-ingest — no manual repair.
        store.ingestSession(planIngest(mkSession("sess-sweep", [mImg, mTxt])), undefined, { completeLog: true });
        assert.equal(store.mediaRefCount(IMG_B64), 1, "reactivated message re-owns its media ref");
        const live = (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): { n: number }[] } } })
            .db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND retired_at IS NULL").all("sess-sweep");
        assert.equal(live[0].n, 2, "both rows live again after rewind-redo");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});
