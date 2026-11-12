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

// #4161: windows-latest runner load can starve the event loop past a fixed
// ms-budget; poll until the condition holds or the budget expires — the
// verdict is the same either way, only the happy path becomes load-tolerant.
async function pollFor(cond: () => boolean, budgetMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > budgetMs) return false;
        await settle(50);
    }
    return true;
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

test("#3818 ③ an unopenable full-mode sidecar refuses to start (#3135 ③)", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const dir = tmpDir("stamp-dead");
        // index.db-as-directory makes the sidecar open fail — under the
        // no-degradation policy (#5213) that is a startup refusal, not a
        // silent legacy stamp against a dead sidecar.
        fs.mkdirSync(path.join(dir, "index.db"), { recursive: true });
        assert.throws(
            () => new SessionStore({ enabled: true, dir, debounceMs: 0 }),
            (err: unknown) => err instanceof Error && /unable to open database file|refus/i.test(err.message),
            "an unopenable sidecar must refuse to start instead of degrading to legacy stamps",
        );
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
        // Commit the v2 envelope synchronously: a fixed 120ms settle races a
        // slow FS (win/node24 runner saw the v1 envelope and served 2).
        assert.ok(store.flushSync(session), "v2 envelope committed");
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
// 4b. #4323: when the two sides drift, the RICHER side wins — a stale
// envelope (older multi-writer generation) must not resurrect an outdated
// fold state over a newer index generation.
// ---------------------------------------------------------------------------

test("#4323 4b drifted session serves the richer side — a stale envelope loses to a newer index generation", async () => {
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const dir = tmpDir("drift-rich");
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const session = makeSession("drift-rich-session");
        const byRef: Record<string, string> = {};
        const byRaw: Record<string, string> = {};
        for (let i = 1; i <= 8; i++) {
            const ref = "m" + String(i).padStart(5, "0");
            byRef[ref] = "raw-" + i;
            byRaw["raw-" + i] = ref;
        }
        (session.state as { messageRefs: { byRef: Record<string, string>; byRaw: Record<string, string> } }).messageRefs = { byRaw, byRef };
        store.scheduleSave(session);
        await settle(300);
        const sh = (store as unknown as { shadow?: { record(r: unknown): void; driftedSessions?: Set<string> } }).shadow;
        assert.ok(sh, "full mode opens a sidecar");

        // Freeze the index at the RICH v1, then let a stale writer commit a
        // SMALLER v2 to the envelope only — the #4323 multi-writer shape.
        const realRecord = sh.record.bind(sh);
        sh.record = () => {};
        if (!sh.driftedSessions) sh.driftedSessions = new Set();
        sh.driftedSessions.add("drift-rich-session");
        const stale = makeSession("drift-rich-session");
        (stale.state as { messageRefs: { byRef: Record<string, string>; byRaw: Record<string, string> } }).messageRefs = { byRaw: { old1: "m00001" }, byRef: { m00001: "old1" } };
        (stale.stats as { requests: number }).requests = 42;
        store.scheduleSave(stale);
        assert.ok(store.flushSync(stale), "smaller (stale envelope) committed");
        await settle();
        sh.record = realRecord;

        const reloaded = store.loadSync("drift-rich-session");
        assert.ok(reloaded, "session loads");
        const refs = Object.keys((reloaded.state as { messageRefs?: { byRef?: Record<string, string> } }).messageRefs?.byRef ?? {}).length;
        assert.ok(refs >= 8, "the richer index side must win the drift (want >= 8 refs — the stale envelope had 1), got " + refs);
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

test("#3818 ⑥ writerOff mid-build disable no longer writes an envelope: index-only IS the contract (#3135 ①, breaker removed)", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "0";
    try {
        const dir = tmpDir("threestrike");
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const session = makeSession("threestrike-session");
        // Flip the legacy 3-strike "disabled" flag DURING the build. The breaker
        // and its same-tick JSON safety valve were removed (owner policy
        // 2026-10-30): jsonWriter=off accepts index-only persistence and failed
        // index writes are retried on every save — so this stub now proves
        // nothing changes: no envelope appears, and the data lands in the index.
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
        // Short poll window: the envelope must STAY absent under writerOff.
        const appeared = await pollFor(() => findStateFile(dir, "threestrike-session") !== null, 1500);
        sh.record = realRecord;
        assert.ok(calls >= 1, "the writerOff build reached the sidecar");
        assert.equal(appeared, false, "no JSON envelope under writerOff — the removed breaker's same-tick valve stays gone");
        const served = store.loadSync("threestrike-session", { protocol: "openai", upstreamOrigin: "https://api.openai.com" });
        assert.ok(served, "the save lives in the index (index-only persistence is the contract)");
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

test("#4242 ⑨ writerOff + reap-shape rides the index journal (orphans are representable, #4216)", async () => {
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
        // writerOff stays off — the record's durability comes from the index
        // (sessions.orphans_json), no JSON-envelope escape hatch is needed.
        store.closeQuietly();

        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const reloaded = store2.loadSync("reap-writereoff-session");
        assert.ok(reloaded, "record reloads under full mode (index-served)");
        // The journal must carry the CONTENT, not just the key — pin the exact
        // bytes so a placeholder/empty entry can't pass as "survived".
        const reloadedB1 = (reloaded.blockContents as Map<string, unknown>).get("b1") as
            | { full?: { text?: string } }
            | undefined;
        assert.equal(reloadedB1?.full?.text, "retained zombie summary", "orphan content survives via the journal");
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

test("#4242 review: reap-shape records ride the ingest journal and reload fresh (#4216 freeze fix)", async () => {
    _resetStorageRuntimeStatusForTest();
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const dir = tmpDir("reap-representable");
        const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const session = makeSession("reap-representable-session");
        const base = (session.stats as { requests: number }).requests;
        (session.blockContents as Map<string, unknown>).set("b9", { one: null, full: { text: "reaped original", count: 2 } });
        await store.writeNow(session);
        // A LATER save (requests advanced) with the same orphan still carried.
        session.stats.requests = base + 5;
        await store.writeNow(session);
        store.closeQuietly();

        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        const reloaded = store2.loadSync("reap-representable-session");
        assert.ok(reloaded, "reload works");
        assert.equal((reloaded.stats as { requests?: number }).requests, base + 5, "post-reap saves keep advancing (#4216)");
        assert.ok((reloaded.blockContents as Map<string, unknown>).has("b9"), "orphan content survives");
        store2.closeQuietly();
        rmrf(dir);
    } finally {
        delete process.env.BILI_STORAGE_UNIFIED;
    }
});

// ---------------------------------------------------------------------------
// #4004 (via #4242): full-mode authority over a tampered envelope.
// The unified index is the load path; a corrupted JSON envelope alone must
// NOT fail the load while the index holds the record. Corrupt BOTH carriers
// and the guard finally rejects.
// ---------------------------------------------------------------------------
test("#4242 ⑦ full mode serves the index when only the envelope id was tampered (#4004)", async () => {
    const dir = tmpDir("authority");
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const { SessionStore } = await import("../src/persist.ts");
        // #4004/#4242: _setStoreForTest lives on persist.ts; keep the peek-only
        // discipline (loadSync must find the store the test just built).
        const setStore = _setStoreForTest as unknown as ((s: unknown) => void) | undefined;
        const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        if (setStore) setStore(store);
        const session = makeSession("authority-session");
        await store.writeNow(session);
        const found = findStateFile(dir, "authority-session");
        assert.ok(found, "envelope written");

        // Tamper ONLY the envelope body id — the index still holds the record.
        const tampered = JSON.parse(JSON.stringify(found.payload)) as Record<string, unknown>;
        tampered.id = "not-the-real-id";
        fs.writeFileSync(found.file, JSON.stringify({ version: 1, payload: tampered }));

        const served = store.loadSync("authority-session", { protocol: "openai", upstreamOrigin: "https://api.openai.com" });
        assert.ok(served, "full mode serves the intact index record despite the tampered envelope");

        // Corrupt BOTH carriers: drop the index row, keep the tampered file.
        store.closeQuietly();
        const { UnifiedStore } = await import("../src/storage/store.ts");
        const uni = UnifiedStore.open(path.join(dir, "index.db"));
        uni.deleteSession("authority-session");
        uni.close();
        const store2 = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        if (setStore) setStore(store2);
        const rejected = store2.loadSync("authority-session", { protocol: "openai", upstreamOrigin: "https://api.openai.com" });
        assert.equal(rejected, null, "with both carriers gone/tampered the load rejects");
        store2.closeQuietly();
    } finally {
        process.env.BILI_STORAGE_UNIFIED = "full";
        rmrf(dir);
    }
});
