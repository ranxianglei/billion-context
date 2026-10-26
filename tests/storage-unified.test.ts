import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import type { CoreMessage, CompressionBlock } from "acp-kernel";
import { canonicalize, sha256 } from "./golden-canonical.ts";
import { planIngest, loadLegacyView, toLegacyLike, type LegacySessionLike } from "../src/storage/ingest.ts";
import { restampRefsToLedger } from "acp-kernel";
import { UnifiedStore } from "../src/storage/store.ts";
import { resolveStorageMode } from "../src/storage/shadow.ts";
import { resolveStorageWalJournalSizeLimit } from "../src/knobs.ts";
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

// #2671 hermeticity: this suite cpSyncs the REPO corpus into tmp dirs and
// asserts index.db presence/absence per test. A developer machine whose real
// billion-context.json sets storage.unified=full (or whose shell exports
// BILI_STORAGE_UNIFIED) would leak that tier into every test that clears the
// env expecting legacy. Pin BOTH tiers to a hermetic baseline; the file-tier
// test below overrides BILI_CONFIG_FILE per-test and restores it.
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-unified-hermetic-")),
    "no-config.json",
);
// Absent everywhere now resolves to the full DEFAULT (the #3818 flip; before that
// the #2815 rollout
// flip), but this suite loads the REPO corpus IN PLACE (loadCase) and asserts
// index.db presence/absence per test — an implicit shadow sidecar would
// pollute the golden corpus dirs. Pin the env tier to an explicit legacy
// baseline; per-test legs override it and restore this value.
process.env.BILI_STORAGE_UNIFIED = "legacy";

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
    // #4316 PR3/3: cold-load alignment sets refLedgerAligned on the served
    // state — a marker, not view content. The parity digest strips it (the
    // manifest predates the flag); any REAL renumbering still moves byRaw and
    // stays pinned (the corpus cases keep their counter refs — only a state
    // whose rows exist gets aligned, and the corpus regen writes files without
    // a live store session).
    const state = { ...(view.state as Record<string, unknown>) };
    delete state.refLedgerAligned;
    return sha256(JSON.stringify(canonicalize({
        id: view.id,
        meta: view.meta,
        stats: view.stats,
        metadata: view.metadata,
        state,
        blockContents: [...view.blockContents.entries()],
        lastMessages: view.lastMessages,
        lastMessagesFolded: view.lastMessagesFolded,
        pluginSnapshot: view.pluginSnapshot,
        contentStore: view.contentStore,
    })));
}

/**
 * Digest of a PERSISTED RECORD (the envelope payload SessionStore writes).
 * Same digest shape as sessionDigest above — the record's own field names
 * mapped onto the view's — so `recordDigest(record) ===
 * sessionDigest(loadLegacyView(rows))` is the TRUE parity contract: the
 * unified rows must faithfully represent exactly what the legacy file
 * holds. Unlike the corpus-manifest oracle this survives legitimate
 * serialization evolution on master (e.g. #2755 reordering fold summaries
 * after the first user message — old corpus pins predate that world; the
 * raw-ingest pins stay in storage-corpus.test.ts).
 */
function recordDigest(record: Record<string, unknown>): string {
    return sha256(JSON.stringify(canonicalize({
        id: record["id"],
        meta: record["meta"],
        stats: record["stats"],
        metadata: record["metadata"],
        state: record["state"],
        blockContents: Object.entries((record["blockContents"] ?? {}) as Record<string, unknown>),
        lastMessages: record["messages"],
        lastMessagesFolded: record["messagesFolded"] === true,
        pluginSnapshot: record["pluginSnapshot"],
        contentStore: record["forkContentStore"],
    })));
}

/** Finds the persisted envelope for `id` under `root`, skipping `skip` subtrees. */
function findWrittenRecord(root: string, id: string, skip?: string): Record<string, unknown> | null {
    const hits: string[] = [];
    const walk = (d: string) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, f.name);
            if (f.isDirectory()) walk(fp);
            else if (f.name.endsWith(".json") && !(skip && fp.startsWith(skip))) hits.push(fp);
        }
    };
    walk(root);
    for (const hit of hits) {
        const envelope = JSON.parse(fs.readFileSync(hit, "utf8")) as Record<string, unknown>;
        const payload = (envelope["payload"] ?? envelope) as Record<string, unknown>;
        if (payload["id"] === id) return payload;
    }
    return null;
}

function runCase(engine: SqliteEngineName, name: string): void {
    const loaded = loadCase(name);
    const legacy = toLegacyLike(loaded);

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
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
}

const ENGINES: SqliteEngineName[] = ["better-sqlite3", "node:sqlite"];

/** better-sqlite3 is an optional native dep — when its install was skipped
 *  (Windows runners without a VS toolchain, minimal containers) the corpus
 *  runs still cover node:sqlite, and the better-sqlite3 leg skips loudly. */
function betterSqliteAvailable(): boolean {
    const req = createRequire(import.meta.url);
    try {
        req("better-sqlite3");
        return true;
    } catch {
        return false;
    }
}

test("storage unified: corpus round-trip digests equal the legacy manifest (better-sqlite3)", { skip: !betterSqliteAvailable() && "better-sqlite3 not installed (optional native dependency)" }, () => {
    for (const name of Object.keys(CASE_META)) runCase("better-sqlite3", name);
});

test("storage unified: corpus round-trip digests equal the legacy manifest (node:sqlite)", () => {
    for (const name of Object.keys(CASE_META)) runCase("node:sqlite", name);
});

test("storage unified: re-ingest is idempotent across the whole corpus (digest stable, no duplicate rows)", () => {
    for (const name of Object.keys(CASE_META)) {
        const loaded = loadCase(name);
        const legacy = toLegacyLike(loaded);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-unified-"));
        try {
            const store = UnifiedStore.open(path.join(dir, "index.db"));
            try {
                store.ingestSession(planIngest(legacy));
                const first = store.counts();
                store.ingestSession(planIngest(legacy));
                const second = store.counts();
                assert.equal(second.sessions, first.sessions, `${name}: sessions dup`);
                assert.equal(second.messages, first.messages, `${name}: messages dup`);
                assert.equal(second.blocks, first.blocks, `${name}: blocks dup`);
                assert.equal(second.refs, first.refs, `${name}: refs dup`);
                assert.equal(second.content, first.content, `${name}: content dup (CAS dedup broken)`);
                const rows = {
                    session: store.getSessionRow(loaded.id)!,
                    messages: store.getMessages(loaded.id),
                    blocks: store.getBlocks(loaded.id),
                    deadRefs: store.getDeadRefs(loaded.id),
                    refs: store.getRefs(loaded.id),
                };
                assert.equal(sessionDigest(loadLegacyView(rows)), manifest[name]!.digest, `${name}: digest drift after re-ingest`);
            } finally {
                store.close();
            }
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
        }
    }
});

test("storage shadow (BILI_STORAGE_UNIFIED=1): real persist path double-writes and reconciles", async () => {
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "1";
    try {
        for (const name of ["folded", "fork-receipt", "deadrefs", "ccr"]) {
            const meta = CASE_META[name]!;
            // Copy the corpus case out first: loading in place would converge
            // lastSeen and save back into the golden corpus (and open a shadow
            // index.db there). The corpus dir must stay pristine.
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-shadow-"));
            try {
                fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
                const caseDir = path.join(dir, name);
                const loadStore = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
                const loaded = loadStore.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
                assert.ok(loaded, `${name}: loadSync returned null`);
                loadStore.cancelAll();

                const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
                // #3050 R3 ②a: writeNow folds an idle session's resident raw
                // tail to the bounded view AFTER the save captures it — snapshot
                // the live tail the shadow override actually received.
                const liveTail = loaded.lastMessages;
                const liveFolded = loaded.lastMessagesFolded === true;
                await store.writeNow(loaded);
                if (liveTail && liveTail.length > 0) {
                    assert.equal(loaded.lastMessagesFolded, true, `${name}: idle save folds the resident tail`);
                }
                store.closeQuietly();
                const unified = UnifiedStore.open(path.join(dir, "index.db"));
                try {
                    const rows = {
                        session: unified.getSessionRow(loaded.id)!,
                        messages: unified.getMessages(loaded.id),
                        blocks: unified.getBlocks(loaded.id),
                        deadRefs: unified.getDeadRefs(loaded.id),
                        refs: unified.getRefs(loaded.id),
                    };
                    assert.ok(rows.session, `${name}: shadow did not ingest the session`);
                    // Parity oracle: the unified rows must faithfully digest
                    // to the same value as the record the legacy file ACTUALLY
                    // holds after this write. The corpus manifest can't serve
                    // as this oracle anymore: master's fold-view serialization
                    // legitimately evolves (#2755 parks fold summaries after
                    // the first user message, newer builds materialize stats
                    // counters the old pins predate) — the raw-ingest pins in
                    // storage-corpus.test.ts keep guarding the corpus itself.
                    const written = findWrittenRecord(dir, loaded.id, path.join(dir, name) + path.sep);
                    assert.ok(written, `${name}: persisted record not found after writeNow`);
                    // #2960 ⑤ + R3 ②a caveat: the override is only handed the
                    // LIVE RAW tail (lastMessagesFolded !== true). A session
                    // loaded from disk carries the envelope's folded render
                    // (folded=true), so the save presents the record's own
                    // envelope view — the oracle must compare against exactly
                    // what the override received, whichever that is.
                    const overridePresent = !!liveTail && liveTail.length > 0 && liveFolded !== true;
                    assert.equal(
                        sessionDigest(loadLegacyView(rows)),
                        overridePresent
                            ? recordDigest({ ...written, messages: liveTail, messagesFolded: liveFolded })
                            : recordDigest(written),
                        `${name}: shadow replay digest drift through the REAL write path`,
                    );
                    // Fixed point: re-load the written file and persist it
                    // AGAIN — the second record must digest identically. This
                    // is the version-stable serialization guard (an unstable
                    // round-trip would reshuffle the tail on every save).
                    const reload = new SessionStore({ dir, debounceMs: 1, enabled: true });
                    const again = reload.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
                    reload.cancelAll();
                    assert.ok(again, `${name}: reload returned null`);
                    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bili-shadow2-"));
                    try {
                        const store2 = new SessionStore({ dir: dir2, debounceMs: 1, enabled: true });
                        await store2.writeNow(again);
                        store2.closeQuietly();
                        const rewritten = findWrittenRecord(dir2, loaded.id);
                        assert.ok(rewritten, `${name}: second persisted record not found`);
                        assert.equal(
                            recordDigest(rewritten),
                            recordDigest(written),
                            `${name}: round-trip serialization is not a fixed point (second save rewrote the record)`,
                        );
                    } finally {
                        try { fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: best-effort */ }
                    }
                } finally {
                    unified.close();
                }
            } finally {
                try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
            }
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
    }
});

test("resolveStorageMode maps every env spelling", () => {
    const cases: Array<[string | undefined, string]> = [
        [undefined, "full"], // absent everywhere: the full default (#3818 flip)
        ["", "full"],
        ["0", "legacy"],
        ["false", "legacy"],
        ["legacy", "legacy"],
        ["garbage", "legacy"],
        ["1", "shadow"],
        ["true", "shadow"],
        ["shadow", "shadow"],
        ["full", "full"],
        ["unified", "full"],
    ];
    for (const [raw, want] of cases) {
        const env: NodeJS.ProcessEnv = {};
        if (raw !== undefined) env.BILI_STORAGE_UNIFIED = raw;
        assert.equal(resolveStorageMode(env), want, `BILI_STORAGE_UNIFIED=${JSON.stringify(raw)}`);
    }
});

test("resolveStorageMode file tier: storage.unified applies when the env is absent, loses to it otherwise (#2671)", () => {
    const fileCases: Array<[string | undefined, string]> = [
        [undefined, "full"], // absent everywhere: the full default (#3818 flip)
        ["", "full"],
        ["legacy", "legacy"],
        ["shadow", "shadow"],
        ["full", "full"],
        ["Full", "full"],
        ["unified", "legacy"], // file tier is strict: env-only spellings are garbage here
        ["1", "legacy"],
        ["true", "legacy"],
        ["garbage", "legacy"],
    ];
    for (const [file, want] of fileCases) {
        assert.equal(resolveStorageMode({}, file), want, `storage.unified=${JSON.stringify(file)}`);
    }
    // Env tier always wins, including explicit legacy-vs-full.
    assert.equal(resolveStorageMode({ BILI_STORAGE_UNIFIED: "full" }, "shadow"), "full");
    assert.equal(resolveStorageMode({ BILI_STORAGE_UNIFIED: "legacy" }, "full"), "legacy");
});

test("resolveStorageWalJournalSizeLimit: env wins, garbage falls through, file tier, default (#3250)", () => {
    const DEFAULT = 8 * 1024 * 1024; // contract literal, mirrors tests/issue3250-wal-checkpoint.test.ts
    assert.equal(resolveStorageWalJournalSizeLimit({}), DEFAULT, "absent everywhere must give the default cap");
    assert.equal(
        resolveStorageWalJournalSizeLimit({ BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES: "67108864" }, DEFAULT),
        67108864,
        "env tier wins over the file tier",
    );
    assert.equal(
        resolveStorageWalJournalSizeLimit({ BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES: "1048576" }, 67108864),
        1048576,
        "env tier wins even when smaller than the file tier",
    );
    for (const bad of ["garbage", "", "0", "-1", "1.5"]) {
        assert.equal(
            resolveStorageWalJournalSizeLimit({ BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES: bad }, 4096),
            4096,
            `env=${JSON.stringify(bad)} must fall through to the file tier (never crash boot)`,
        );
    }
    assert.equal(resolveStorageWalJournalSizeLimit({}, 2097152), 2097152, "file tier applies when the env is absent");
});

/** #4316 PR3/3 parity oracle: the expected digest for a FULL-mode load is
 *  the LEGACY-mode view of the same files plus the deterministic one-time
 *  ledger alignment (same seqByRaw the full-mode load aligned against). The
 *  corpus manifest keeps pinning the PURE view (storage-corpus suite); this
 *  oracle pins the equivalence "full serve = legacy serve + alignment". */
function alignedLegacyDigest(caseDir: string, meta: { protocol: string; id: string }, seqByRawId: Map<string, number>): string {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-legacy-oracle-"));
    try {
        fs.cpSync(caseDir, path.join(legacyDir, "case"), { recursive: true });
        // Remove any unified sidecar so the legacy store serves the files.
        for (const f of fs.readdirSync(path.join(legacyDir, "case"))) {
            if (f.startsWith("index.db") || f.endsWith(".lock")) fs.rmSync(path.join(path.join(legacyDir, "case"), f), { force: true });
        }
        const prev = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        let store: InstanceType<typeof SessionStore> | null = null;
        try {
            store = new SessionStore({ dir: path.join(legacyDir, "case"), debounceMs: 1, enabled: true });
            const pure = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
            assert.ok(pure, "legacy oracle load returned null");
            const view = toLegacyLike(pure);
            const state = structuredClone(view.state as Record<string, unknown>);
            restampRefsToLedger(state as never, seqByRawId);
            delete state.refLedgerAligned;
            return sessionDigest({ ...view, state: state as never });
        } finally {
            store?.closeQuietly();
            if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
            else process.env.BILI_STORAGE_UNIFIED = prev;
        }
    } finally {
        try { fs.rmSync(legacyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
    }
}

test("storage unified FULL mode: read path serves from the index with organic import + GC parity", async () => {
    const meta = CASE_META["folded"]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-full-"));
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(dir, "folded"), { recursive: true });
        const caseDir = path.join(dir, "folded");
        // First open against a dir that has ONLY the legacy file: loadSync
        // must organically import and serve the unified view.
        const store = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        const session = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(session, "full-mode loadSync returned null");
        store.closeQuietly();
        // The import must have populated the index even though writeNow never ran.
        const probe = UnifiedStore.open(path.join(caseDir, "index.db"));
        let expectedDigest = "";
        try {
            assert.ok(probe.getSessionRow(meta.id), "organic import did not populate index.db");
            // #4316 PR3/3: expected = legacy view of the same files + the
            // deterministic alignment against these very rows.
            expectedDigest = alignedLegacyDigest(caseDir, meta, probe.seqByRaw(meta.id));
        } finally {
            probe.close();
        }
        assert.equal(sessionDigest(toLegacyLike(session)), expectedDigest, "full-mode read digest drift (organic import)");
        // Second store, same dir: load again — serves from the index, no
        // import churn, digest still exact.
        const store2 = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        const again = store2.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(again, "second full-mode loadSync returned null");
        assert.equal(sessionDigest(toLegacyLike(again)), expectedDigest, "second full-mode read digest drift");
        store2.cancelAll();
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});

test("storage unified FULL mode: boot() walks files, imports, and #286 rekey removes the old id from the index", async () => {
    const meta = CASE_META["folded"]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-"));
    const prev = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(dir, "folded"), { recursive: true });
        const caseDir = path.join(dir, "folded");
        const store = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        // corpus-folded's label is "corpus-corpus-folded" (label != id), so
        // boot()'s #286 migration rekeys to the label id and calls
        // removeLegacyFile on the old id — the shadow must follow.
        const sessions = await store.boot();
        store.closeQuietly();
        assert.ok(sessions.size >= 1, "boot loaded nothing");
        const probe = UnifiedStore.open(path.join(caseDir, "index.db"));
        try {
            assert.ok(!probe.getSessionRow(meta.id), "old id still present in index after #286 rekey GC");
            assert.ok(probe.listSessionIds().includes("corpus-corpus-folded"), "rekeyed label id missing from index");
        } finally {
            probe.close();
        }
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prev;
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});

test("storage unified: encryption guard keeps the sidecar closed", () => {
    const meta = CASE_META["folded"]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-enc-"));
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    const prevKey = process.env.BILI_ENCRYPTION_KEY;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ENCRYPTION_KEY = "a".repeat(64); // 32 bytes hex
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(dir, "folded"), { recursive: true });
        const caseDir = path.join(dir, "folded");
        const store = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        const session = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(session, "encrypted legacy loadSync returned null");
        assert.equal(sessionDigest(toLegacyLike(session)), manifest["folded"]!.digest, "encrypted legacy read digest drift");
        store.closeQuietly();
        assert.ok(!fs.existsSync(path.join(caseDir, "index.db")), "index.db must NOT exist while encryption is active");
    } finally {
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevMode;
        if (prevKey === undefined) delete process.env.BILI_ENCRYPTION_KEY;
        else process.env.BILI_ENCRYPTION_KEY = prevKey;
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});

// ---------------------------------------------------------------------------
// #2671 config-file tier: storage.unified=full with NO env must open the
// unified sidecar (same read path as BILI_STORAGE_UNIFIED=full), and an
// explicit env legacy must win over file full.

test("storage unified: file-config storage.unified selects the mode; env tier still wins", () => {
    const meta = CASE_META["folded"]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-filecfg-"));
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    const prevConfigFile = process.env.BILI_CONFIG_FILE;
    delete process.env.BILI_STORAGE_UNIFIED;
    try {
        const caseDir = path.join(dir, "folded");
        const cfgPath = path.join(dir, "billion-context.json");
        fs.writeFileSync(cfgPath, JSON.stringify({ storage: { unified: "full" } }));
        process.env.BILI_CONFIG_FILE = cfgPath;
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), caseDir, { recursive: true });
        // File tier alone: full mode — organic import must populate index.db.
        let store = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
        let session = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(session, "file-tier full loadSync returned null");
        store.closeQuietly();
        const probeStore = UnifiedStore.open(path.join(caseDir, "index.db"));
        let fileTierDigest = "";
        try {
            fileTierDigest = alignedLegacyDigest(caseDir, meta, probeStore.seqByRaw(meta.id));
        } finally {
            probeStore.close();
        }
        assert.equal(sessionDigest(toLegacyLike(session)), fileTierDigest, "file-tier full read digest drift");
        assert.ok(fs.existsSync(path.join(caseDir, "index.db")), "file-tier full did not create index.db");
        // Env tier wins: explicit env legacy overrides file full on a fresh
        // dir — a file-tier full would have opened the sidecar and imported,
        // leaving index.db behind.
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        const caseDir2 = path.join(dir, "folded2");
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), caseDir2, { recursive: true });
        store = new SessionStore({ dir: caseDir2, debounceMs: 1, enabled: true });
        session = store.loadSync(meta.id, { protocol: meta.protocol, upstreamOrigin: "http://127.0.0.1:8199" });
        assert.ok(session, "env-legacy override loadSync returned null");
        assert.equal(sessionDigest(toLegacyLike(session)), manifest["folded"]!.digest, "env-legacy read digest drift");
        store.closeQuietly();
        assert.ok(!fs.existsSync(path.join(caseDir2, "index.db")), "env legacy must beat file full (index.db was created)");
    } finally {
        if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = prevMode;
        if (prevConfigFile === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfigFile;
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});

// ---------------------------------------------------------------------------
// #2671 soak regression: folded tail slides → absolute seqs (no stale replay)
//
// The soak lane hit shadow DIGEST DRIFT on every save of a folded session
// with no pluginSnapshot: planIngest seqs are RELATIVE to the current
// snapshot's log, so once the 1-message tail slides, plan seq 0 names a
// DIFFERENT message each save — and (session_id, seq) INSERT OR IGNORE kept
// the first row forever. Replay then served turn-1's tail on turn-4's save.
// ingestSession now remaps plan seqs to absolute seqs (identity = msgId +
// content hash); this test reproduces the exact sliding-tail shape.
// ---------------------------------------------------------------------------
test("storage: sliding folded tail replays the latest turn, not the first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-slide-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const mkTurn = (n: number) => {
            const msgId = `h_turn${n}`;
            const msg: CoreMessage = { id: msgId, role: "user", contentType: "text", text: `turn ${n}` };
            // Kernel Contract: the ref map only ever GROWS (numbers are never
            // reused or deleted) — model the realistic accumulation.
            const byRaw: Record<string, string> = {};
            const byRef: Record<string, string> = {};
            for (let i = 1; i <= n; i++) {
                byRaw[`h_turn${i}`] = `m0000${i}`;
                byRef[`m0000${i}`] = `h_turn${i}`;
            }
            const legacy: LegacySessionLike = {
                id: "slide-1",
                createdAt: 1_000 + n,
                lastSeen: 2_000 + n,
                meta: { protocol: "openai" },
                stats: { requests: n },
                metadata: {},
                state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
                blockContents: new Map(),
                lastMessages: [msg],
                lastMessagesFolded: true,
                pluginSnapshot: undefined,
                contentStore: undefined,
            };
            return legacy;
        };
        for (let n = 1; n <= 4; n++) {
            const legacy = mkTurn(n);
            store.ingestSession(planIngest(legacy));
            const rows = {
                session: store.getSessionRow("slide-1")!,
                messages: store.getMessages("slide-1"),
                blocks: store.getBlocks("slide-1"),
                deadRefs: store.getDeadRefs("slide-1"),
                refs: store.getRefs("slide-1"),
            };
            const replay = loadLegacyView(rows);
            assert.equal(replay.lastMessages?.length, 1, `turn ${n}: one tail message`);
            assert.equal(replay.lastMessages?.[0]?.text, `turn ${n}`, `turn ${n}: replay tail is the LATEST turn`);
            assert.equal(replay.lastMessagesFolded, true);
        }
        // Log stays append-only: all four identities remain queryable.
        assert.equal(store.getMessages("slide-1").length, 4, "absolute seqs keep every turn in the log");
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});

// ---------------------------------------------------------------------------
// #2671 soak regression 2: block ids are PER-SESSION ("b1", "b2", …), so the
// blocks table must key (session_id, block_id). With a global block_id PK the
// second session's b1 UPSERT-stole the first session's row (boot import of
// 440 real sessions left 249 block rows; one quiet session lost all 28
// blocks). Two sessions sharing block ids must each replay their own blocks.
// ---------------------------------------------------------------------------
test("storage: block ids are per-session — no cross-session steal in one db", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-blockid-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const mkSession = (id: string, nBlocks: number): LegacySessionLike => {
            const blocks: CompressionBlock[] = Array.from({ length: nBlocks }, (_, i) => ({
                blockId: `b${i + 1}`,
                runId: `r${i + 1}`,
                tier: 1,
                summary: `summary ${id} b${i + 1}`,
                directMessageIds: [],
                effectiveMessageIds: [],
                directBlockIds: [],
                compressedTokens: 10,
                createdAt: 1_000 + i,
                survivedCount: 0,
                generation: "young",
                active: true,
            }));
            return {
                id,
                createdAt: 1_000,
                lastSeen: 2_000,
                meta: { protocol: "openai" },
                stats: {},
                metadata: {},
                state: { blocks, nextBlockId: nBlocks + 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
                blockContents: new Map(blocks.map((b) => [b.blockId, { one: null, full: { text: b.summary, count: 1 } }])),
                lastMessages: undefined,
                lastMessagesFolded: undefined,
                pluginSnapshot: undefined,
                contentStore: undefined,
            };
        };
        store.ingestSession(planIngest(mkSession("sess-A", 3)));
        store.ingestSession(planIngest(mkSession("sess-B", 2))); // reuses b1, b2
        const rowsFor = (id: string) => ({
            session: store.getSessionRow(id)!,
            messages: store.getMessages(id),
            blocks: store.getBlocks(id),
            deadRefs: store.getDeadRefs(id),
            refs: store.getRefs(id),
        });
        const a = loadLegacyView(rowsFor("sess-A"));
        const b = loadLegacyView(rowsFor("sess-B"));
        const aSummaries = (a.blockContents.get("b1")!.full as unknown as { text: string }).text;
        const bSummaries = (b.blockContents.get("b1")!.full as unknown as { text: string }).text;
        assert.equal((a.state as { blocks: unknown[] }).blocks.length, 3);
        assert.equal((b.state as { blocks: unknown[] }).blocks.length, 2);
        assert.equal(aSummaries, "summary sess-A b1");
        assert.equal(bSummaries, "summary sess-B b1");
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});

// #2671 soak: protected messages carry the byRaw-only "BLOCKED" token. The
// ref ledger stores it verbatim; the replay must NOT project it into byRef
// (the in-memory map keeps byRef strictly mNNNNN→rawId). Drifted on every
// save of sub-agent sessions with a protected message before the fix.
test("storage: BLOCKED ref replays via byRaw only, never into byRef", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-unified-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const now = Date.now();
            const legacy: LegacySessionLike = {
                id: "blocked-ref-1",
                createdAt: now,
                lastSeen: now,
                meta: { protocol: "openai" },
                metadata: {},
                stats: { requests: 1 },
                state: {
                    nextBlockId: 1,
                    nextRunId: 1,
                    blocks: [],
                    messageRefs: {
                        byRaw: { h_user1: "m00001", h_protected: "BLOCKED", h_user2: "m00002" },
                        byRef: { m00001: "h_user1", m00002: "h_user2" },
                    },
                } as unknown as LegacySessionLike["state"],
                blockContents: new Map(),
                lastMessages: [],
            };
            store.ingestSession(planIngest(legacy));
            const rows = {
                session: store.getSessionRow(legacy.id)!,
                messages: store.getMessages(legacy.id),
                blocks: store.getBlocks(legacy.id),
                deadRefs: store.getDeadRefs(legacy.id),
                refs: store.getRefs(legacy.id),
            };
            const refs = loadLegacyView(rows).state.messageRefs as { byRaw: Record<string, string>; byRef: Record<string, string> };
            assert.equal(refs.byRaw["h_protected"], "BLOCKED", "byRaw keeps the BLOCKED token");
            assert.equal(refs.byRef["BLOCKED"], undefined, "byRef must not gain a BLOCKED key");
            assert.equal(refs.byRef["m00001"], "h_user1");
            assert.equal(refs.byRef["m00002"], "h_user2");
        } finally {
            store.close();
        }
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows: an ephemeral stray handle must not fail CI */ }
    }
});

// ---------------------------------------------------------------------------
// #2815 review finding ②: STORAGE_SCHEMA_VERSION v2 migration. A dev-window
// v1 database (sessions WITHOUT namespace/origin, user_version=1) must
// upgrade in place — v2 adds the identity columns (constant defaults, rows
// survive), v3 adds the conversations identity index and backfills one
// binding per sessions row — and a dev build that already carried the
// columns in its V1 DDL must migrate without a duplicate-column error.
// ---------------------------------------------------------------------------
test("schema v2: dev-window v1 database upgrades in place (identity columns added, rows survive)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-schema-v2-"));
    try {
        const dbPath = path.join(dir, "index.db");
        // Craft the dev-window v1 shape: the REAL pre-#2963 DDL (full
        // column set) minus the identity columns, one live row, user_version=1.
        const { STORAGE_DDL_V1_FOR_TESTS } = await import("../src/storage/schema.ts");
        const v1Ddl = STORAGE_DDL_V1_FOR_TESTS.replace(/^\s*namespace TEXT NOT NULL DEFAULT 'proxy',$/m, "").replace(/^\s*origin TEXT,$/m, "");
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(dbPath);
        raw.exec(v1Ddl);
        raw.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)").run("dev-window-1", 111, 222);
        raw.exec("PRAGMA user_version = 1");
        raw.close();

        const store = UnifiedStore.open(dbPath);
        try {
            const row = store.getSessionRow("dev-window-1") as unknown as { namespace?: string; origin?: string; updated_at?: number } | null;
            assert.ok(row, "row survives the migration");
            assert.equal(row!.namespace, "proxy", "namespace backfills with its constant default");
            assert.equal(row!.origin, null, "origin backfills NULL");
            const ver = (store as unknown as { db: { prepare(q: string): { get(): unknown } } }).db.prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 8, "schema version stamped to 8 (v2 columns + v3 identity index + v4 extension namespaces + v5 watermark column + v6 orphans journal + v7 media map + v8 identity/tombstones)");
            // v3 backfill: every pre-existing sessions row claims its
            // (namespace, conversation_id) identity binding.
            const binding = (store as unknown as { lookupConversation(ns: string, id: string): string | null }).lookupConversation("proxy", "dev-window-1");
            assert.equal(binding, "dev-window-1", "v3 migration backfills the identity binding from sessions rows");
        } finally {
            store.close();
        }

        // Idempotence arm: a dev build whose V1 DDL ALREADY had the columns
        // (user_version still 1) must migrate without duplicate-column errors.
        const dbPath2 = path.join(dir, "index2.db");
        const raw2 = new DatabaseSync(dbPath2);
        raw2.exec(STORAGE_DDL_V1_FOR_TESTS);
        raw2.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)").run("dev-window-2", 333, 444);
        raw2.exec("PRAGMA user_version = 1");
        raw2.close();
        const store2 = UnifiedStore.open(dbPath2);
        try {
            const row2 = store2.getSessionRow("dev-window-2") as unknown as { namespace?: string } | null;
            assert.ok(row2);
            assert.equal(row2!.namespace, "proxy");
            // Straight 1-to-3 arm: the v3-shape DDL at user_version=1
            // migrates in one pass (conversations already exists, IF NOT
            // EXISTS no-ops, backfill dedups against the claim).
            assert.equal(store2.lookupConversation("proxy", "dev-window-2"), "dev-window-2",
                "v3-shape lib at user_version=1 lands the identity binding");
        } finally {
            store2.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
