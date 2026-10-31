import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy"; // hermetic tier baseline; tests drive UnifiedStore directly

/**
 * #4801 review (P1 storage): fork cloning must take ONE content ref PER
 * CLONED ROW. The pre-fix clone bumped the blob refcount exactly once per
 * (session, hash) pair — a fork whose parent rows share one blob (the very
 * common case: one image attached to several messages, or #3762 media
 * mappings under multiple rows) walked out with a SINGLE ref while acquiring
 * N referencing rows. Every later session delete then released N and drove
 * the refcount NEGATIVE, and delete-on-zero GC (#4800) swept the blob out
 * from under sessions that still referenced it — a fork could eat bytes it
 * never owned.
 *
 * Mirrors the #4730 fork-live-seq fixture shape (seed → fork → delete).
 */

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

function imgMsg(id: string, role: "user" | "assistant", bytes: string): CoreMessage {
    // Top-level imageBase64 rides the stored JSON — #3762 splitMediaContent
    // pulls it into the media CAS (content row + message_media mapping),
    // which is exactly the shared-blob shape the fork clone must count.
    return { id, role, contentType: "text", text: `body ${id}`, imageBase64: bytes } as unknown as CoreMessage;
}

function session(id: string, tail: CoreMessage[]): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    tail.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
    });
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: {},
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(),
        lastMessages: tail,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

interface Handle {
    dir: string;
    store: UnifiedStore;
    refcount(hash: string): number;
    rawAddRow(sessionId: string, seq: number, msgId: string, hash: string): void;
    rawExec(sql: string, ...args: unknown[]): void;
    close(): void;
}

function open(label: string): Handle {
    const dir = mkdtempSync(path.join(tmpdir(), `bili-clone-ref-${label}-`));
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    const raw = openSqliteDatabase(dbPath, "node:sqlite");
    const q = raw.db as unknown as { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown }; close?(): void };
    return {
        dir,
        store,
        refcount(hash) {
            const row = q.prepare("SELECT refcount FROM content WHERE hash = ?").get(hash) as { refcount: number } | undefined;
            return row?.refcount ?? 0;
        },
        rawAddRow(sessionId, seq, msgId, hash) {
            q.prepare("INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at) VALUES (?, ?, ?, NULL, 2, 'user', 'text', ?, '', NULL)").run(sessionId, seq, msgId, hash);
            q.prepare("UPDATE content SET refcount = refcount + 1 WHERE hash = ?").run(hash);
        },
        rawExec(sql, ...args) {
            q.prepare(sql).run(...args);
        },
        close() {
            try { store.close(); } catch { /* already closed */ }
            try { q.close?.(); } catch { /* no-op */ }
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

test("fork clone: N rows referencing one blob acquire N refs — shared bytes survive every delete", () => {
    const h = open("media");
    try {
        // Parent: two messages carrying the SAME image bytes → one media
        // blob, TWO message_media mappings (content refcount 2 pre-fork).
        const IMG = "aG9sZGVyLWltYWdlLWJ5dGVz";
        const parent = ["p_a", "p_b"].map((id, i) => imgMsg(id, i % 2 ? "assistant" : "user", IMG));
        h.store.ingestSession(planIngest(session("sess-clone-parent", parent)));

        // A THIRD session holds one more reference to the same blob: the
        // bystander whose bytes the buggy clone could eat.
        h.store.ingestSession(planIngest(session("sess-clone-holder", [imgMsg("h_x", "user", IMG)])));

        const mediaHash = sha256Hex(IMG);
        assert.equal(h.refcount(mediaHash), 3, "fixture sanity: 2 parent mappings + 1 holder = 3 refs");

        // Fork the parent (through its last live seq, the #4730 contract).
        h.store.cloneSessionRows("sess-clone-parent", "sess-clone-child", h.store.lastLiveSeq("sess-clone-parent")!);
        assert.equal(h.refcount(mediaHash), 5, "clone acquires one ref PER cloned mapping (2), not one per (session, hash)");

        // Delete the fork and then the parent: every clone/parent ref is
        // released, the holder's single ref keeps the blob alive.
        h.store.deleteSession("sess-clone-child");
        assert.equal(h.refcount(mediaHash), 3, "deleting the fork releases exactly what the clone took");
        h.store.deleteSession("sess-clone-parent");
        assert.equal(h.refcount(mediaHash), 1, "deleting the parent leaves the holder's ref intact");

        const holderRows = h.store.getMessages("sess-clone-holder");
        assert.equal(holderRows.length, 1, "holder row survives");
        const hydrated = JSON.parse(holderRows[0].content) as { imageBase64?: unknown };
        assert.equal(hydrated.imageBase64, IMG, "blob still resolvable — getMessages hydrates the original bytes, not swept by GC");
    } finally {
        h.close();
    }
});

test("fork clone: identical TEXT bytes under two rows count too (content CAS, not just media)", () => {
    // Ids are baked into serialized message bytes, so two DIFFERENT messages
    // never share the text CAS. The realistic shape for shared text bytes is
    // #3762's sibling: splitMediaContent rewrites TWO payloads (top-level + a
    // base64 data-URL sidecar) of one message onto hashes — plus the raw
    // row-level shape a repair or clone leaves behind. Drive that directly:
    // seed one session, raw-insert a second row pointing at the SAME content
    // hash, then fork and count.
    const h = open("text");
    try {
        h.store.ingestSession(planIngest(session("sess-text-parent", [{ id: "t_a", role: "user", contentType: "text", text: "same bytes twice" } as unknown as CoreMessage])));
        const seeded = h.store.getMessages("sess-text-parent");
        assert.equal(seeded.length, 1, "fixture sanity: one seeded row");
        const dupHash = seeded[0].contentHash;
        assert.equal(h.refcount(dupHash), 1, "fixture sanity: seeded row refs the blob once");
        h.rawAddRow("sess-text-parent", 1, "t_b", dupHash);
        assert.equal(h.refcount(dupHash), 2, "fixture sanity: both parent rows ref the shared text blob");

        h.store.cloneSessionRows("sess-text-parent", "sess-text-child", h.store.lastLiveSeq("sess-text-parent")!);
        assert.equal(h.refcount(dupHash), 4, "clone bumps per cloned row (2), not per (session, hash)");

        h.store.deleteSession("sess-text-child");
        h.store.deleteSession("sess-text-parent");
        assert.equal(h.refcount(dupHash), 0, "no refs left behind once both owners are gone");
    } finally {
        h.close();
    }
});

test("fork clone: a cloned row whose content row is gone fails LOUDLY, not a silent under-count", () => {
    // putContentRef is an UPDATE ... WHERE hash = ? — pre-fix, a missing
    // content row was a silent no-op: the clone walked out with rows
    // referencing a blob it never counted, and every later delete released a
    // ref nobody took (negative refcount → delete-on-zero GC swept bytes
    // other sessions still referenced). Accounting bugs (this file's fix
    // family) or a tampered DB leave dangling refs; the clone must refuse so
    // the fork FAILS instead of corrupting the ledger.
    const h = open("missing");
    try {
        h.store.ingestSession(planIngest(session("sess-missing-parent", [{ id: "x_a", role: "user", contentType: "text", text: "orphaned blob" } as unknown as CoreMessage])));
        const seeded = h.store.getMessages("sess-missing-parent");
        assert.equal(seeded.length, 1, "fixture sanity: one seeded row");
        const hash = seeded[0].contentHash;
        assert.equal(h.refcount(hash), 1, "fixture sanity: seeded row refs the blob once");
        // The FK would refuse the delete — a corrupted/tampered DB bypassed it.
        h.rawExec("PRAGMA foreign_keys = OFF");
        h.rawExec("DELETE FROM content WHERE hash = ?", hash);
        assert.equal(h.refcount(hash), 0, "fixture sanity: content row removed — the dangling-ref shape");

        // On sqlite the DDL foreign key fires first (messages.content_hash
        // REFERENCES content(hash)); the mysql DDL declares NO foreign keys,
        // where the putContentRef guard below is the only loud failure.
        // Contract pinned either way: the clone refuses, nothing partial lands.
        assert.throws(
            () => h.store.cloneSessionRows("sess-missing-parent", "sess-missing-child", h.store.lastLiveSeq("sess-missing-parent")!),
            /FOREIGN KEY|content/i,
            "clone must throw on the missing content row instead of silently skipping the ref bump",
        );
        assert.equal(h.store.getMessages("sess-missing-child").length, 0, "rolled-back clone left no child rows behind");
    } finally {
        h.close();
    }
});
