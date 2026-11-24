// #6785 step 6 — ccr mirror narrowing (± gate discipline, #3617).
//
// The sessions.ccr_json column used to carry the FULL content store
// (byHash hash→original-text + byRef ref→entry), so EVERY steady-state
// flush re-wrote the whole CCR body (file-read outputs, MB-scale each)
// through the sessions row even when nothing changed. Now:
//
//   - the column keeps the SLIM envelope: {version:1, ccrSlim:1,
//     byRef: {key: {hash: <content-hash of the entry json>}}} — KB-scale;
//   - ccr_entries carries BOTH halves: content_hash (the entry metadata
//     json) AND orig_hash (the original text behind entry.hash — the
//     kernel invariant content-store.ts storeOriginal pins
//     byHash[entry.hash] === original);
//   - steady-state re-saves are a no-op for CCR: the #5744 skip compares
//     ord + content_hash + orig_hash, so unchanged entries write ZERO
//     bytes;
//   - legacy rows keep working: a full column envelope parses byte-exact
//     (pre-step-6 stores), and a slim column over NULL-orig ledger rows
//     degrades to null (the file lane serves) — never a partial store.
//
// Digest safety: the shadow digest canonicalizes the (byHash pairs, byRef
// values) — the rebuild from the ledger must produce the SAME pair set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
    planIngest,
    type LegacySessionLike,
} from "../src/storage/ingest.js";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.js";
import { UnifiedStore } from "../src/storage/store.js";
import { canonicalize } from "../src/storage/canonical.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function open(dir: string): UnifiedStore {
    return UnifiedStore.open(join(dir, "index.db"));
}
function rm(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const BIG_BODY = "B".repeat(64 * 1024);
const BIG_H = sha(BIG_BODY);
const TOOL_JSON = JSON.stringify({ tool: "bash", output: "ok" });
const TOOL_H = sha(TOOL_JSON);

// Kernel invariant (content-store.ts storeOriginal): entry.hash =
// sha256(original text); byHash[entry.hash] = original text.
function makeCcr(): { version: 1, byHash: Record<string, string>, byRef: Record<string, unknown> } {
    return {
        version: 1,
        byHash: { [BIG_H]: BIG_BODY, [TOOL_H]: TOOL_JSON },
        byRef: {
            m00010: { hash: BIG_H, rawId: "raw-10", kind: "file read", tokens: 5, chars: BIG_BODY.length, head: "BBBBBBBBBB" },
            m00011: { hash: TOOL_H, rawId: "raw-11", kind: "command", tokens: 2, chars: TOOL_JSON.length, head: "{...}" },
        },
    };
}

function session(ccr?: { version: 1, byHash: Record<string, string>, byRef: Record<string, unknown> }): LegacySessionLike {
    return {
        id: "sess-ccr",
        createdAt: 1000,
        lastSeen: 2000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: { m1: "1001" }, byRef: { "1001": "m1" } } },
        blockContents: new Map(),
        lastMessages: [{ id: "m1", role: "user", contentType: "text", text: "hi" }],
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: ccr,
    } as LegacySessionLike;
}

test("ccr slim: the column keeps the envelope only; bytes round-trip through the CAS (#6785 step 6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-ccr-slim-"));
    const store = open(dir);
    const raw = openSqliteDatabase(join(dir, "index.db"));
    try {
        const ccr = makeCcr();
        store.ingestSession(planIngest(session(ccr)), undefined, { completeLog: true });

        const col = raw.db
            .prepare("SELECT ccr_json FROM sessions WHERE session_id = ?")
            .get("sess-ccr") as { ccr_json: string } | undefined;
        assert.ok(col, "session row missing");
        const parsed = JSON.parse(col!.ccr_json) as Record<string, unknown>;
        assert.equal(parsed.version, 1);
        assert.equal(parsed.ccrSlim, 1, "column must hold the slim envelope");
        const e10 = makeCcr().byRef.m00010;
        assert.deepEqual(
            (parsed.byRef as Record<string, unknown>)["m00010"],
            { hash: sha(JSON.stringify(e10)) },
            "slim byRef entry keeps the content-hash only");
        assert.ok(!col!.ccr_json.includes(BIG_BODY), "original bytes leaked into the ccr_json column");
        assert.ok(!col!.ccr_json.includes(BIG_H.slice(0, 32)), "the ORIGINAL hash key must not ride the column either");

        // The bytes live in the CAS behind the ledger row.
        const entries = store.getCcrEntries("sess-ccr");
        assert.equal(entries.length, 2);
        const en10 = entries.find((e) => e.key === "m00010");
        assert.ok(en10, "ledger lost m00010");
        assert.equal(en10!.content, JSON.stringify(e10), "entry metadata json must round-trip");
        assert.equal(en10!.origContent, BIG_BODY, "orig CAS half missing");

        // getCcr rebuilds the store byte-identically from slim column + CAS.
        const served = store.getCcr("sess-ccr");
        assert.ok(served, "slim envelope did not hydrate a store");
        assert.equal(served!.byHash[BIG_H], BIG_BODY, "CAS bytes did not round-trip");
        assert.equal(served!.byHash[TOOL_H], TOOL_JSON);
        assert.deepEqual(served!.byRef, makeCcr().byRef, "byRef values must round-trip exactly");
        assert.deepEqual(Object.keys(served!.byHash).sort(), [BIG_H, TOOL_H].sort());
    } finally {
        raw.db.close();
        store.close();
        rm(dir);
    }
});

test("ccr slim: pre-step-6 full columns still serve byte-exact; slim over NULL-orig rows degrades (never partial)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-ccr-slim-legacy-"));
    const store = open(dir);
    const raw = openSqliteDatabase(join(dir, "index.db"));
    try {
        store.ingestSession(planIngest(session(makeCcr())), undefined, { completeLog: true });

        // A pre-step-6 row in an upgraded db: the full parse path must win,
        // entries ignored, bytes verbatim.
        const full = {
            version: 1,
            byHash: { "sha256-ccr-legacy": "LEGACY-BODY" },
            byRef: { m9: { hash: "sha256-ccr-legacy", rawId: "r9", kind: "file read", tokens: 1, chars: 11, head: "L" } },
        };
        raw.db.prepare("UPDATE sessions SET ccr_json = ? WHERE session_id = ?").run(JSON.stringify(full), "sess-ccr");
        const served = store.getCcr("sess-ccr");
        assert.ok(served, "legacy full column did not parse");
        assert.equal(served!.byHash["sha256-ccr-legacy"], "LEGACY-BODY", "legacy full column must serve its own bytes");
        assert.equal((served!.byRef["m9"] as { rawId: string }).rawId, "r9");

        // Slim column + ledger rows with NULL orig (pre-step-6 rows): the
        // bytes are unreachable from the ledger → null (the file lane still
        // holds the truth), never a partial store.
        raw.db.prepare("UPDATE sessions SET ccr_json = ? WHERE session_id = ?")
            .run(JSON.stringify({ version: 1, ccrSlim: 1, byRef: { m1: { hash: "deadbeef" } } }), "sess-ccr");
        raw.db.prepare("UPDATE ccr_entries SET orig_hash = NULL WHERE session_id = ?").run("sess-ccr");
        assert.equal(store.getCcr("sess-ccr"), null, "slim + NULL-orig ledger must degrade to null, not a partial store");

        // And an empty ledger under a slim column: same degrade.
        raw.db.prepare("DELETE FROM ccr_entries WHERE session_id = ?").run("sess-ccr");
        assert.equal(store.getCcr("sess-ccr"), null);
    } finally {
        raw.db.close();
        store.close();
        rm(dir);
    }
});

test("ccr slim: steady-state re-ingest writes zero ccr bytes (the point of slimming)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-ccr-slim-noop-"));
    const store = open(dir);
    const raw = openSqliteDatabase(join(dir, "index.db"));
    try {
        const plan = planIngest(session(makeCcr()));
        store.ingestSession(plan, undefined, { completeLog: true });
        const casBefore = (raw.db.prepare("SELECT COUNT(*) AS n FROM content").get() as { n: number }).n;
        const entriesBefore = JSON.stringify(store.getCcrEntries("sess-ccr").map((e) => [e.key, e.contentHash, e.origHash]));
        const en11Before = store.getCcrEntries("sess-ccr").find((e) => e.key === "m00011")!.contentHash;

        // Same CCR again (steady-state save): rows and CAS untouched.
        store.ingestSession(planIngest(session(makeCcr())), undefined, { completeLog: true });
        const casAfter = (raw.db.prepare("SELECT COUNT(*) AS n FROM content").get() as { n: number }).n;
        assert.equal(casAfter, casBefore, "unchanged CCR must not re-put its bytes into the CAS");
        const entriesAfter = JSON.stringify(store.getCcrEntries("sess-ccr").map((e) => [e.key, e.contentHash, e.origHash]));
        assert.equal(entriesAfter, entriesBefore, "ledger rows must be stable across unchanged saves");

        // Changed CCR content re-puts (positive direction of the skip): the
        // ledger row points at a NEW content hash (old row released).
        const changed = makeCcr();
        changed.byRef.m00011 = { hash: TOOL_H, rawId: "raw-11b", kind: "command", tokens: 2, chars: TOOL_JSON.length, head: "{...}" };
        store.ingestSession(planIngest(session(changed)), undefined, { completeLog: true });
        const after = store.getCcrEntries("sess-ccr").find((e) => e.key === "m00011");
        assert.equal(after!.content, JSON.stringify(changed.byRef.m00011), "a changed entry must re-put");
        assert.notEqual(after!.contentHash, en11Before, "changed entry must land on a new content hash");
    } finally {
        raw.db.close();
        store.close();
        rm(dir);
    }
});

// Digest-relevant sanity: the canonical digest is a pure function of the
// (byHash pairs, byRef values) — order cannot leak. Pin the pair-set
// equality of the slim rebuild against the live store.
test("ccr slim: canonical digest of a slim-restored store equals the live store's", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-ccr-slim-digest-"));
    const store = open(dir);
    try {
        store.ingestSession(planIngest(session(makeCcr())), undefined, { completeLog: true });
        const live = canonicalize(makeCcr());
        const served = canonicalize(store.getCcr("sess-ccr"));
        assert.ok(served, "slim store did not hydrate");
        assert.equal(
            sha(JSON.stringify(live)),
            sha(JSON.stringify(served)),
            "slim round-trip changed the canonical form of the content store");
    } finally {
        store.close();
        rm(dir);
    }
});

// #6785-review regression: the ALWAYS-empty store. Every session materializes
// createContentStore() ({byHash:{},byRef:{}}) via contentStoreOf's ?? fallback,
// so plain (never-compressed) sessions persist a slim envelope with ZERO
// declared refs and ZERO ledger rows. The empty-envelope case is COMPLETE,
// not partial: hydrating it to null desynced the unified replay (undefined)
// from the live view (the empty store object) — a permanent structural
// "diverged: contentStore" digest drift on every sampled verify, forcing a
// full re-ingest per save (O(n²) at large sessions) and walking the
// #4323 escalation → freeze chain. The key-set coverage guard above already
// rejects envelopes that DECLARE refs the ledger lacks (the true partial case).
test("ccr slim: empty envelope + empty ledger hydrates the empty store, digest-parity with the live view", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-ccr-slim-empty-"));
    const store = open(dir);
    const raw = openSqliteDatabase(join(dir, "index.db"));
    try {
        const empty = { version: 1 as const, byHash: {} as Record<string, string>, byRef: {} as Record<string, unknown> };
        store.ingestSession(planIngest(session(empty)), undefined, { completeLog: true });

        // The column carries the slim empty envelope; the ledger stays empty.
        const col = raw.db.prepare("SELECT ccr_json FROM sessions WHERE session_id = ?").get("sess-ccr") as { ccr_json: string };
        assert.equal(col.ccr_json, JSON.stringify({ version: 1, ccrSlim: 1, byRef: {} }));
        assert.equal(store.getCcrEntries("sess-ccr").length, 0);

        // The hydration must yield the exact empty store — null is the regression.
        const served = store.getCcr("sess-ccr");
        assert.ok(served, "empty slim envelope must hydrate (null = the digest-drift regression)");
        assert.deepEqual((served as { byRef: unknown }).byRef, {});
        assert.deepEqual((served as { byHash: unknown }).byHash, {});
        assert.equal(
            sha(JSON.stringify(canonicalize(served))),
            sha(JSON.stringify(canonicalize(empty))),
            "unified replay digest must equal the live view digest for the empty store");
    } finally {
        raw.db.close();
        store.close();
        rm(dir);
    }
});
