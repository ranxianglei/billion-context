import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, effectiveFileStorageMode, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { resolveStorageMode } from "../src/knobs.ts";
import { storageStatusWire, _resetStorageRuntimeStatusForTest } from "../src/storage/runtime-status.ts";

/**
 * Storage full-flip wrap-up (#3818, absorbs #3135).
 *
 * Seven stakes, one per defect plus the default flip itself:
 *
 *   1. resolveStorageMode absent-everywhere default: "full" (the flip).
 *   2. #3135 ②: BILI_PERSIST=0 (store disabled) must report
 *      intentionalOptOut, never a "storage degraded" banner with a false
 *      engine reason.
 *   3. #3135 ③: the per-record storageMode stamp tells the truth — a store
 *      whose sidecar failed to open stamps "legacy", not the requested mode.
 *   4. #3135 ④: verifyDrift is visible in the status wire, and a drifted
 *      session in full mode falls back to the JSON envelope read while the
 *      envelope still exists.
 *   5. #3135 ⑥: bootBounded (limits boot) enumerates the index union — a
 *      jsonWriter=off pure-index session is warm after a bounded boot.
 *   6. #3135 ①: when the sidecar 3-strikes DURING a writerOff build, the
 *      same tick still lands a JSON write — no window where the last save
 *      exists on neither copy.
 *   7. #3135 ⑤ lives in tests/storage-engine-bootstrap.test.ts (unloadable
 *      cache is removed and a pinned download is retried).
 *   8. Review finding: #2695 reap-shape records (state.blocks loses an entry,
 *      blockContents keeps the text for the derived-decompress fallback) are
 *      NOT hand-built-only — real reaped sessions trip the orphan-contents
 *      guard too. They must stay envelope-served, never gutted into the index.
 */

process.env.BILI_PERSIST_ZSTD = "0";
const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-full-flip-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;
delete process.env.BILI_STORAGE_JSON_WRITER;

const PREV_UNIFIED = process.env.BILI_STORAGE_UNIFIED;
const PREV_JSON_WRITER = process.env.BILI_STORAGE_JSON_WRITER;

// Windows can still hold an ephemeral handle on index.db/-wal right after a
// store closes (Defender scan, delayed close), so a bare rmSync throws EPERM
// and fails an otherwise green run. Retry, then give up quietly: the dir lives
// under HERMETIC, which the after hook clears anyway.
function rmrf(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* Windows stray handle */
    }
}

function tmpDir(tag: string): string {
    return fs.mkdtempSync(path.join(HERMETIC, `${tag}-`));
}

function settle(ms = 120): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

let seq = 0;
function makeSession(id?: string): Session {
    seq += 1;
    return {
        id: id ?? `flip-${seq}`,
        createdAt: Date.now(),
        meta: {},
        metadata: {},
        stats: { requests: seq },
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
        blockContents: new Map(),
        lastMessages: [],
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as unknown as Session;
}

/** Find the persisted state JSON (not the content-store sidecar) for an id. */
function findStateFile(root: string, id: string): { file: string; payload: Record<string, unknown> } | null {
    const out: Array<{ file: string; payload: Record<string, unknown> }> = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".json") && !e.name.endsWith(".content-store.json") && !e.name.startsWith("index.db")) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
                    const payload = (parsed && typeof parsed === "object" && "payload" in parsed ? parsed.payload : parsed) as Record<string, unknown>;
                    if (payload && payload.id === id) out.push({ file: p, payload });
                } catch {
                    /* non-JSON or partial: skip */
                }
            }
        }
    };
    walk(root);
    return out[0] ?? null;
}

/** The writerOff lane keeps zero JSON files — probe by scanning the tree. */
function countStateFiles(root: string): number {
    let n = 0;
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".json") && !e.name.endsWith(".content-store.json") && e.name !== "no-config.json") n++;
        }
    };
    walk(root);
    return n;
}

test.after(() => {
    if (PREV_UNIFIED === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = PREV_UNIFIED;
    if (PREV_JSON_WRITER === undefined) delete process.env.BILI_STORAGE_JSON_WRITER;
    else process.env.BILI_STORAGE_JSON_WRITER = PREV_JSON_WRITER;
    rmrf(HERMETIC);
});

// ---------------------------------------------------------------------------
// 1. The default flip
// ---------------------------------------------------------------------------

test("#3818 ① absent everywhere resolves to full (default flip)", () => {
    assert.equal(resolveStorageMode({}), "full", "env absent + file absent must be the new default");
    assert.equal(resolveStorageMode({}, undefined), "full");
    assert.equal(resolveStorageMode({}, ""), "full", "empty file value is absence, not a spelling");
    // Explicit tiers keep their meaning — the flip only moves the DEFAULT.
    assert.equal(resolveStorageMode({ BILI_STORAGE_UNIFIED: "legacy" }, "full"), "legacy", "escape hatch intact");
    assert.equal(resolveStorageMode({ BILI_STORAGE_UNIFIED: "shadow" }), "shadow", "explicit shadow still reachable");
});

// ---------------------------------------------------------------------------
// 2. BILI_PERSIST=0 reports intentional opt-out, never a false degrade banner
// ---------------------------------------------------------------------------

test("#3818 ② disabled persistence reports intentionalOptOut with no degraded banner (#3135 ②)", () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const dir = tmpDir("persist-off");
        const store = new SessionStore({ enabled: false, dir, debounceMs: 0 });
        const wire = storageStatusWire();
        assert.equal(wire.requested, "full");
        assert.equal(wire.intentionalOptOut, true, "persistence disabled is an intentional opt-out, not a degrade");
        assert.equal(wire.degraded, false, "no degraded banner when the user turned persistence off");
        assert.equal(wire.reason, null, "no fabricated engine reason");
        store.closeQuietly();
        rmrf(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
    }
});

// ---------------------------------------------------------------------------
// 3. The storageMode stamp tells the truth when the sidecar cannot open
// ---------------------------------------------------------------------------

test("#3818 ③ stamp says legacy when the sidecar failed to open (#3135 ③)", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    _setStoreForTest(new SessionStore({ enabled: false, dir: tmpDir("stamp-ref") }));
    try {
        const dir = tmpDir("stamp-dead");
        // index.db-as-directory makes the sidecar open fail -> shadow undefined
        fs.mkdirSync(path.join(dir, "index.db"), { recursive: true });
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const session = makeSession("stamp-dead-session");
        store.scheduleSave(session);
        await settle();
        const found = findStateFile(dir, "stamp-dead-session");
        assert.ok(found, "the JSON envelope is written when the sidecar is dead");
        const metadata = found.payload.metadata as Record<string, unknown>;
        assert.equal(metadata.storageMode, "legacy", "stamp must describe the mode that actually holds data (no index.db copy exists)");
        store.closeQuietly();
        rmrf(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
        _setStoreForTest(new SessionStore({ enabled: false, dir: tmpDir("stamp-out") }));
    }
    // #3135 ③ semantics: a disabled-by-config singleton (BILI_PERSIST=0)
    // ALSO reports legacy — with persistence off nothing is unified either,
    // and the runtime banner (item ②) explains the intentional opt-out; the
    // knob tier below only remains for pre-store moments (fresh boot before
    // the first store build, CLI one-shots without a singleton).
    assert.equal(effectiveFileStorageMode(), "legacy", "module-level stamp follows the live singleton (disabled persistence is legacy: nothing is unified)");
});

// ---------------------------------------------------------------------------
// 4. verifyDrift is visible + drifted sessions fall back to the envelope
// ---------------------------------------------------------------------------

test("#3818 ④ verifyDrift in the wire; drifted session reads the envelope while it exists (#3135 ④)", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const dir = tmpDir("drift");
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const wire0 = storageStatusWire();
        assert.equal(typeof wire0.verifyDrift, "number", "the drift counter must be part of the status wire");

        const session = makeSession("drift-session");
        store.scheduleSave(session);
        await settle(300);
        const sh = (store as unknown as { shadow?: { record(r: unknown): void; stats: { verifyDrift: number }; driftedSessions?: Set<string> } }).shadow;
        assert.ok(sh, "full mode opens a sidecar");

        // Mark the session as drifted, then update ONLY the file (stub the
        // sidecar ingest for one save) — index holds v1, envelope holds v2.
        if (!sh.driftedSessions) sh.driftedSessions = new Set();
        sh.driftedSessions.add("drift-session");
        const realRecord = sh.record.bind(sh);
        sh.record = () => {};
        (session.stats as { requests: number }).requests = 99;
        store.scheduleSave(session);
        await settle();
        sh.record = realRecord;

        const reloaded = store.loadSync("drift-session");
        assert.ok(reloaded, "session loads");
        assert.equal((reloaded.stats as { requests?: number }).requests, 99, "drifted session must serve the envelope (file) view, not the stale index view");
        store.closeQuietly();
        rmrf(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
    }
});

// ---------------------------------------------------------------------------
// 5. bootBounded enumerates the index union
// ---------------------------------------------------------------------------

test("#3818 ⑤ bounded boot warms pure-index sessions (#3135 ⑥)", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "0";
    try {
        const dir = tmpDir("bounded");
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const session = makeSession("bounded-index-only");
        store.scheduleSave(session);
        await settle(300);
        assert.equal(countStateFiles(dir), 0, "writerOff leaves no JSON files");
        store.closeQuietly();

        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const warm = await store2.boot({ maxSessions: 8, maxBytes: 64 * 1024 * 1024 });
        assert.ok(warm.has("bounded-index-only"), "a jsonWriter=off pure-index session must be enumerable after a BOUNDED boot");
        store2.closeQuietly();
        rmrf(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
        delete process.env.BILI_STORAGE_JSON_WRITER;
    }
});

// ---------------------------------------------------------------------------
// 6. A sidecar 3-striking mid-build still lands the JSON write that tick
// ---------------------------------------------------------------------------

test("#3818 ⑥ writerOff save that disables the sidecar still lands JSON the same tick (#3135 ①)", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "0";
    try {
        const dir = tmpDir("threestrike");
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const session = makeSession("threestrike-session");
        // Flip the sidecar to disabled DURING the build (exactly what the
        // 3rd consecutive record failure does inside shadow.record).
        const sh = (store as unknown as { shadow?: { record(r: unknown): void; stats: { disabled: boolean } } }).shadow;
        assert.ok(sh, "full mode opens a sidecar");
        const realRecord = sh.record.bind(sh);
        let calls = 0;
        sh.record = (...args: Parameters<typeof realRecord>) => {
            void realRecord(...args);
            calls += 1;
            sh.stats.disabled = true;
        };
        store.scheduleSave(session);
        await settle(400);
        sh.record = realRecord;
        assert.ok(calls >= 1, "the writerOff build reached the sidecar");
        assert.ok(findStateFile(dir, "threestrike-session"), "the disabling tick must land a JSON write — no window where the save exists on neither copy");
        store.closeQuietly();
        rmrf(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
        delete process.env.BILI_STORAGE_JSON_WRITER;
    }
});

// ---------------------------------------------------------------------------
// 9. #3818 writerOff safety valve: an unrepresentable record must never end
//    up on NO copy at all (index skips it, writerOff wrote no file)
// ---------------------------------------------------------------------------

test("#3818 ⑨ writerOff + reap-shape lands a JSON envelope anyway (no silent data death)", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "0";
    try {
        const dir = tmpDir("reap-writereoff");
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const session = makeSession("reap-writereoff-session");
        // #2695 reap shape: block gone from state.blocks, text kept.
        (session.blockContents as Map<string, unknown>).set("b1", { one: null, full: { text: "retained zombie summary", count: 1 } });
        store.scheduleSave(session);
        await settle(300);
        assert.ok(countStateFiles(dir) >= 1, "the safety valve lands a JSON envelope even under writerOff");
        const sh = (store as unknown as { shadow?: { stats: { orphanSkips: number } } }).shadow;
        assert.ok((sh?.stats.orphanSkips ?? 0) >= 1, "the mirror skipped the unrepresentable record");
        store.closeQuietly();

        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const reloaded = store2.loadSync("reap-writereoff-session");
        assert.equal((reloaded?.blockContents.get("b1") as { full: { text: string } } | undefined)?.full?.text, "retained zombie summary",
            "the retained content survives the restart via the envelope");
        store2.closeQuietly();
        rmrf(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
        delete process.env.BILI_STORAGE_JSON_WRITER;
    }
});

// ---------------------------------------------------------------------------
// 8. #2695 reap-shape records stay envelope-served, never gutted by the index
// ---------------------------------------------------------------------------

test("#3818 review: reap-shape records (content kept, block gone) stay envelope-served across restart", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const dir = tmpDir("reap");
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const session = makeSession("reap-session");
        // reapDestroyedSubstrate (#2695) shape: state.blocks loses the entry,
        // blockContents keeps the text for the derived-decompress fallback.
        (session.blockContents as Map<string, unknown>).set("b1", { one: null, full: { text: "retained zombie summary", count: 1 } });
        store.scheduleSave(session);
        await settle(300);
        const sh = (store as unknown as { shadow?: { stats: { orphanSkips: number } } }).shadow;
        assert.ok(sh, "full mode opens a sidecar");
        assert.ok((sh.stats.orphanSkips ?? 0) >= 1, "an unrepresentable record is skipped from the mirror, not gutted into it");
        const reloaded = store.loadSync("reap-session");
        assert.ok(reloaded, "session loads");
        assert.equal((reloaded.blockContents.get("b1") as { full: { text: string } }).full.text, "retained zombie summary", "same-process read keeps the retained content");
        store.closeQuietly();

        // Restart: nothing was ever ingested, so the cold read import-skips
        // again and serves the envelope — the index never holds this shape.
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const reloaded2 = store2.loadSync("reap-session");
        assert.ok(reloaded2, "session loads after restart");
        assert.equal((reloaded2.blockContents.get("b1") as { full: { text: string } }).full.text, "retained zombie summary", "cross-restart read keeps the retained content");
        const sh2 = (store2 as unknown as { shadow?: { stats: { imports: number; orphanSkips: number } } }).shadow;
        assert.equal(sh2?.stats.imports, 0, "the unrepresentable record never enters the index");
        assert.ok((sh2?.stats.orphanSkips ?? 0) >= 1);
        store2.closeQuietly();
        rmrf(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
    }
});
