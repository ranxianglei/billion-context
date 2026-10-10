import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { canonicalize, sha256 } from "./golden-canonical.ts";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { setPreferredSqliteEngineForTests, type SqliteEngineName } from "../src/storage/driver.ts";

/**
 * Unified-storage acceptance (Phase 1, #2671).
 *
 * The legacy corpus (tests/golden/storage-corpus, pinned by
 * tests/storage-corpus.test.ts) is driven through the full migration path:
 *
 *   legacy files → loadSync → planIngest → UnifiedStore.ingest
 *               → getRows → loadLegacyView → canonical digest
 *
 * and the digest must equal the manifest byte-for-byte on BOTH engines.
 * Any mismatch means the unified layer loses or reshapes information —
 * exactly what the migration may never do.
 */

process.env.BILI_PERSIST_ZSTD = "0";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

interface CaseResult { description: string; files: string[]; digest: string; notes?: Record<string, unknown> }
const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, "manifest.json"), "utf8")) as Record<string, CaseResult>;

const CASE_META: Record<string, { protocol: string; id: string }> = {
    "folded": { protocol: "anthropic", id: "corpus-folded" },
    "tier2": { protocol: "chat", id: "corpus-tier2" },
    "deadrefs": { protocol: "anthropic", id: "corpus-deadrefs" },
    "fork-receipt": { protocol: "chat", id: "corpus-fork-receipt" },
    "fork-retained": { protocol: "chat", id: "corpus-fork-retained" },
    "image": { protocol: "anthropic", id: "corpus-image" },
    "ccr": { protocol: "responses", id: "corpus-ccr" },
    "twinfile": { protocol: "openai", id: "corpus-twin" },
    "zstd": { protocol: "anthropic", id: "corpus-folded" },
};

function loadCase(name: string): Session {
    const meta = CASE_META[name]!;
    const prevZstd = process.env.BILI_PERSIST_ZSTD;
    if (name === "zstd") process.env.BILI_PERSIST_ZSTD = "1";
    try {
        const store = new SessionStore({ dir: path.join(CORPUS_ROOT, name), debounceMs: 1, enabled: true });
        const loaded = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(loaded, `${name}: loadSync returned null`);
        return loaded;
    } finally {
        if (prevZstd === undefined) delete process.env.BILI_PERSIST_ZSTD;
        else process.env.BILI_PERSIST_ZSTD = prevZstd;
    }
}

/** Same digest shape as the corpus manifest (see scripts/update-storage-corpus.ts). */
function sessionDigest(view: ReturnType<typeof loadLegacyView>): string {
    return sha256(JSON.stringify(canonicalize({
        id: view.id,
        meta: view.meta,
        stats: view.stats,
        metadata: view.metadata,
        state: view.state,
        blockContents: [...view.blockContents.entries()],
        lastMessages: view.lastMessages,
        lastMessagesFolded: view.lastMessagesFolded,
        pluginSnapshot: view.pluginSnapshot,
        contentStore: view.contentStore,
    })));
}

function runCase(engine: SqliteEngineName, name: string): void {
    const loaded = loadCase(name);
    const legacy: LegacySessionLike = {
        id: loaded.id,
        createdAt: loaded.createdAt,
        lastSeen: loaded.lastSeen,
        meta: loaded.meta,
        stats: loaded.stats,
        metadata: loaded.metadata,
        state: loaded.state as unknown as LegacySessionLike["state"],
        blockContents: loaded.blockContents,
        lastMessages: loaded.lastMessages,
        lastMessagesFolded: loaded.lastMessagesFolded,
        pluginSnapshot: loaded.pluginSnapshot,
        contentStore: loaded.contentStore,
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-unified-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"), engine);
        try {
            const plan = planIngest(legacy);
            store.ingestSession(plan);

            const verify = store.verifyProjections(name === "zstd" ? CASE_META[name]!.id : loaded.id);
            assert.ok(verify.ok, `${engine}/${name}: projection check failed: ${verify.ok ? "" : verify.error}`);

            const rows = {
                session: (() => {
                    const s = store.getSessionRow(loaded.id)!;
                    assert.ok(s, `${engine}/${name}: session row missing`);
                    return s;
                })(),
                messages: store.getMessages(loaded.id),
                blocks: store.getBlocks(loaded.id),
                deadRefs: store.getDeadRefs(loaded.id),
                refs: store.getRefs(loaded.id),
            };
            const view = loadLegacyView(rows);
            assert.equal(sessionDigest(view), manifest[name]!.digest, `${engine}/${name}: unified round-trip digest drift`);
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const ENGINES: SqliteEngineName[] = ["better-sqlite3", "node:sqlite"];

test("storage unified: corpus round-trip digests equal the legacy manifest (better-sqlite3)", () => {
    for (const name of Object.keys(CASE_META)) runCase("better-sqlite3", name);
});

test("storage unified: corpus round-trip digests equal the legacy manifest (node:sqlite)", () => {
    for (const name of Object.keys(CASE_META)) runCase("node:sqlite", name);
});

test("storage unified: re-ingest is idempotent (digest stable, no duplicate rows)", () => {
    const loaded = loadCase("folded");
    const legacy: LegacySessionLike = {
        id: loaded.id,
        createdAt: loaded.createdAt,
        lastSeen: loaded.lastSeen,
        meta: loaded.meta,
        stats: loaded.stats,
        metadata: loaded.metadata,
        state: loaded.state as unknown as LegacySessionLike["state"],
        blockContents: loaded.blockContents,
        lastMessages: loaded.lastMessages,
        lastMessagesFolded: loaded.lastMessagesFolded,
        pluginSnapshot: loaded.pluginSnapshot,
        contentStore: loaded.contentStore,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-unified-"));
    try {
        setPreferredSqliteEngineForTests(null);
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const before = store.counts();
            store.ingestSession(planIngest(legacy));
            const first = store.counts();
            store.ingestSession(planIngest(legacy));
            const second = store.counts();
            assert.equal(second.sessions, first.sessions);
            assert.equal(second.messages, first.messages);
            assert.equal(second.blocks, first.blocks);
            assert.equal(second.refs, first.refs);
            assert.equal(second.content, first.content); // dedup held across re-ingest
            assert.ok(first.messages > 0, "sanity: corpus folded case has messages");
            assert.ok(before.messages === 0, "sanity: started from an empty db");

            const rows = {
                session: store.getSessionRow(loaded.id)!,
                messages: store.getMessages(loaded.id),
                blocks: store.getBlocks(loaded.id),
                deadRefs: store.getDeadRefs(loaded.id),
                refs: store.getRefs(loaded.id),
            };
            assert.equal(sessionDigest(loadLegacyView(rows)), manifest["folded"]!.digest);
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
