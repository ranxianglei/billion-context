import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { SessionStore } from "../src/persist.js";
import { scanForeignBlocks, applyForeignBlockSweep, type ForeignBlockPlan } from "../src/foreign-block-sweep.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-fbs-cfg-")), "no-config.json");

/**
 * #5312 D2 — legacy cross-session fold blocks linger forever in a parent
 * session after upgrade. Option A (host-side sweep) judges each block against
 * the session's FULL persisted transcript (live AND retired rows): zero
 * intersection = provably foreign → reversibly archive; any intersection =
 * collision needing the kernel lineage field (option B) → left alone.
 *
 * Covers: (a) the reversible block archive primitive, (b) the classification
 * policy (archivable / collision / no-covered / empty-transcript guard /
 * base-id stability / dry-run read-only), (c) end-to-end through the real
 * SessionStore facade. Healthy folds MUST be spared (regression guard).
 */

function msg(id: string): CoreMessage {
    return { id, role: "user", contentType: "text", text: `body ${id}` } as unknown as CoreMessage;
}

interface BlockSpec { blockId: string; effectiveMessageIds: string[]; active?: boolean; tier?: number; }

function session(id: string, tail: CoreMessage[], blocks: BlockSpec[]): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    tail.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
    });
    const blks = blocks.map((b, idx) => ({
        blockId: b.blockId, runId: idx + 1, createdAt: 1_000, tier: b.tier ?? 1, active: b.active ?? true,
        summary: `summary of ${b.blockId}`, kind: "fold", reason: "test",
        effectiveMessageIds: b.effectiveMessageIds, directMessageIds: [] as string[],
    }) as never);
    return {
        id, createdAt: 1_000, lastSeen: 2_000, meta: { protocol: "openai" }, stats: {}, metadata: {},
        state: { blocks: blks, nextBlockId: blocks.length + 1, nextRunId: blocks.length + 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(), lastMessages: tail, lastMessagesFolded: false, pluginSnapshot: undefined, contentStore: undefined,
    } as unknown as LegacySessionLike;
}

function openStore(label: string): { dir: string; store: UnifiedStore; close(): void } {
    const dir = mkdtempSync(path.join(tmpdir(), `bili-fbs-${label}-`));
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    return {
        dir, store,
        close() {
            try { store.close(); } catch { /* already closed */ }
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        },
    };
}

test("#5312 engine: allMessageIds returns every ingested id (live + retired)", () => {
    const h = openStore("allids");
    try {
        h.store.ingestSession(planIngest(session("s1", ["A", "B", "C"].map(msg), [])), undefined, { completeLog: true });
        // Rewind A out of the view: the sweep must RETIRE its row (not delete),
        // else a fold covering A would read zero-overlap. Pins that invariant.
        h.store.ingestSession(planIngest(session("s1", ["B", "C"].map(msg), [])), undefined, { completeLog: true });
        const got = h.store.allMessageIds("s1").slice().sort();
        assert.deepEqual(got, ["A", "B", "C"], "retired id A must stay queryable alongside live B/C");
        // Empty session (no messages) → empty set, not null.
        h.store.ingestSession(planIngest(session("s-empty", [], [{ blockId: "b", effectiveMessageIds: ["x"] }])));
        assert.deepEqual(h.store.allMessageIds("s-empty"), []);
    } finally { h.close(); }
});

test("#5312 engine: archiveBlock is reversible — content preserved, row restored byte-exact", () => {
    const h = openStore("roundtrip");
    try {
        const sid = "s1";
        h.store.ingestSession(planIngest(session(sid, ["A", "B", "C"].map(msg), [
            { blockId: "healthy", effectiveMessageIds: ["A", "B"] },
            { blockId: "foreign", effectiveMessageIds: ["f1", "f2"] },
        ])));
        const before = h.store.getBlocks(sid).find((b) => b.blockId === "foreign");
        assert.ok(before, "foreign block present pre-archive");
        const origPayload = before.payloadJson;
        const origSummary = before.summary;
        const origHash = before.summaryHash;

        const arcDir = path.join(h.dir, "archive");
        const res = h.store.archiveBlock(sid, "foreign", { archiveDir: arcDir });
        assert.ok(res.ok, `archive ok (${res.reason})`);
        assert.ok(existsSync(path.join(arcDir, UnifiedStore.BLOCK_ARCHIVE_LOG_NAME)), "block archive log written");
        assert.ok(!h.store.getBlocks(sid).some((b) => b.blockId === "foreign"), "foreign block swept from live set");
        assert.ok(h.store.getBlocks(sid).some((b) => b.blockId === "healthy"), "healthy sibling untouched");
        // Idempotent: archiving an absent block is a clean no-op.
        assert.equal(h.store.archiveBlock(sid, "foreign", { archiveDir: arcDir }).reason, "not-found");

        const back = h.store.restoreBlock(sid, "foreign", { archiveDir: arcDir });
        assert.ok(back.ok, `restore ok (${back.reason})`);
        const restored = h.store.getBlocks(sid).find((b) => b.blockId === "foreign");
        assert.ok(restored, "foreign block restored");
        assert.equal(restored.payloadJson, origPayload, "payload_json byte-exact");
        assert.equal(restored.summary, origSummary, "summary body round-trips");
        assert.equal(restored.summaryHash, origHash, "summary hash unchanged");
        // The restored line is consumed from the log → a second restore is a no-op.
        assert.equal(h.store.restoreBlock(sid, "foreign", { archiveDir: arcDir }).reason, "not-found");
    } finally { h.close(); }
});

test("#5312 engine: restore onto a live twin keeps the twin and does not leak content refs", () => {
    const h = openStore("twin");
    try {
        const sid = "s1";
        const plan = planIngest(session(sid, ["A", "B", "C"].map(msg), [
            { blockId: "foreign", effectiveMessageIds: ["f1", "f2"] },
        ]));
        h.store.ingestSession(plan);
        const origHash = h.store.getBlocks(sid).find((b) => b.blockId === "foreign")?.summaryHash;
        assert.ok(origHash, "summary hash present pre-archive");
        const rcOf = (hash: string): number => {
            const db = (h.store as unknown as { db: { prepare(q: string): { get(p: string): { n: number } | undefined } } }).db;
            return Number(db.prepare("SELECT refcount AS n FROM content WHERE hash = ?").get(hash)?.n ?? 0);
        };
        const arcDir = path.join(h.dir, "archive");
        assert.ok(h.store.archiveBlock(sid, "foreign", { archiveDir: arcDir }).ok, "archive ok");
        // Re-ingest the identical log → the twin reappears live with byte-identical
        // summary (same hash), so restore hits the ON CONFLICT path.
        h.store.ingestSession(plan);
        assert.ok(h.store.getBlocks(sid).some((b) => b.blockId === "foreign"), "twin block is live");
        const rcBefore = rcOf(origHash!);
        assert.ok(rcBefore >= 1, "twin content row alive with a refcount to compare against");

        const res = h.store.restoreBlock(sid, "foreign", { archiveDir: arcDir });
        assert.ok(res.ok, `restore onto twin ok (${res.reason})`);
        // Twin stays authoritative AND the conflicted restore must not have
        // bumped the body's refcount (it would never reach 0 again = leak).
        assert.equal(rcOf(origHash!), rcBefore, "conflicted restore must not inflate content refcount");
        // The archive line was still consumed → second restore no-ops.
        assert.equal(h.store.restoreBlock(sid, "foreign", { archiveDir: arcDir }).reason, "not-found");
    } finally { h.close(); }
});

// --- Policy classification via a lightweight stub (no DB; deterministic) ---

interface StubBlock { blockId: string; tier: number; active: boolean; payloadJson: string; }
function stubBlock(blockId: string, eff: unknown, extra: Partial<StubBlock> = {}): StubBlock {
    return { blockId, tier: 1, active: true, payloadJson: JSON.stringify({ blockId, effectiveMessageIds: eff }), ...extra };
}
function stubStore(sessions: Record<string, { ids: string[] | null; blocks: StubBlock[] }>) {
    const archived: string[] = [];
    return {
        archived,
        unifiedListSessionIds: () => Object.keys(sessions),
        unifiedAllMessageIds: (sid: string) => (sessions[sid] ? sessions[sid].ids : null),
        unifiedGetBlocks: (sid: string) => (sessions[sid] ? (sessions[sid].blocks as never[]) : null),
        unifiedArchiveBlock: (sid: string, bid: string) => { archived.push(`${sid}:${bid}`); return { ok: true }; },
    };
}

test("#5312 policy: classifies archivable vs collision vs no-covered; spares healthy folds", () => {
    const stub = stubStore({
        P: { ids: ["A", "B", "C"], blocks: [
            stubBlock("healthy", ["A", "B"]),          // real tie → collision (NOT archived)
            stubBlock("foreign", ["f1", "f2"]),         // zero overlap → archivable
            stubBlock("partial", ["A", "z9"]),          // one tie → collision
            stubBlock("baseline", ["A#v2"]),            // base-id match across model switch → collision
        ] },
        E: { ids: [], blocks: [stubBlock("ghost", ["x"])] },   // empty transcript → skipped, undecided
        N: { ids: ["A"], blocks: [stubBlock("emptycov", [])] }, // no coverage → undecidable, never archived
    });
    const plan = scanForeignBlocks(stub as unknown as SessionStore);
    assert.ok(plan);
    assert.deepEqual(plan.archivable.map((f) => f.blockId), ["foreign"]);
    assert.deepEqual(plan.collision.map((f) => f.blockId).sort(), ["baseline", "healthy", "partial"]);
    assert.deepEqual(plan.noCovered.map((f) => f.blockId), ["emptycov"]);
    assert.equal(plan.skippedEmptyTranscript, 1, "empty-transcript session counted, not acted on");
    // The ghost block of the empty-transcript session must appear NOWHERE.
    const all = [...plan.archivable, ...plan.collision, ...plan.noCovered];
    assert.ok(!all.some((f) => f.blockId === "ghost"));
    // Dry-run: scanning mutates nothing.
    assert.equal(stub.archived.length, 0, "scan is read-only");
});

test("#5312 policy: unavailable store → null; apply archives ONLY the archivable set", () => {
    // unavailable: listSessionIds returns null
    const down = { unifiedListSessionIds: () => null } as unknown as SessionStore;
    assert.equal(scanForeignBlocks(down), null);

    const stub = stubStore({
        P: { ids: ["A"], blocks: [stubBlock("keep", ["A"]), stubBlock("drop", ["zz"])] },
    });
    const plan = scanForeignBlocks(stub as unknown as SessionStore)!;
    const res = applyForeignBlockSweep(stub as unknown as SessionStore, plan);
    assert.ok(res);
    assert.deepEqual(res.archived.map((f) => f.blockId), ["drop"]);
    assert.deepEqual(stub.archived, ["P:drop"]);
    assert.equal(res.failed.length, 0);
});

test("#5312 policy: failed archive surfaces in result, not silently dropped", () => {
    const stub = stubStore({ P: { ids: ["A"], blocks: [stubBlock("drop", ["zz"])] } });
    (stub as unknown as { unifiedArchiveBlock: () => { ok: boolean; reason?: string } }).unifiedArchiveBlock = () => ({ ok: false, reason: "export-missing" });
    const plan = scanForeignBlocks(stub as unknown as SessionStore)!;
    const res = applyForeignBlockSweep(stub as unknown as SessionStore, plan)!;
    assert.equal(res.archived.length, 0);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].finding.blockId, "drop");
    assert.equal(res.failed[0].reason, "export-missing");
});

// --- End-to-end through the real SessionStore facade over a real index.db ---

test("#5312 e2e: scanForeignBlocks + applyForeignBlockSweep through the SessionStore facade", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-fbs-e2e-"));
    try {
        const db = UnifiedStore.open(path.join(dir, "index.db"));
        db.ingestSession(planIngest(session("sess-P", ["A", "B", "C"].map(msg), [
            { blockId: "healthy", effectiveMessageIds: ["A", "B"] },
            { blockId: "foreign", effectiveMessageIds: ["f1", "f2"] },
        ])));
        db.close();

        const store = new SessionStore({ dir, enabled: true });
        try {
            assert.ok(store.replicasAvailable(), "unified store available in this lane");
            const plan: ForeignBlockPlan | null = scanForeignBlocks(store);
            assert.ok(plan, "plan produced");
            assert.deepEqual(plan.archivable.map((f) => f.blockId), ["foreign"]);
            assert.deepEqual(plan.collision.map((f) => f.blockId), ["healthy"]);

            const res = applyForeignBlockSweep(store, plan)!;
            assert.equal(res.archived.length, 1, "exactly the foreign block archived");
            assert.equal(res.failed.length, 0);
            const remaining = store.unifiedGetBlocks("sess-P")!;
            assert.ok(!remaining.some((b) => b.blockId === "foreign"), "foreign block gone from live set");
            assert.ok(remaining.some((b) => b.blockId === "healthy"), "healthy fold preserved");

            // Reversible through the facade too.
            const back = store.unifiedRestoreBlock("sess-P", "foreign");
            assert.ok(back?.ok, `facade restore ok (${back?.reason})`);
            assert.ok(store.unifiedGetBlocks("sess-P")!.some((b) => b.blockId === "foreign"), "foreign block back");
        } finally {
            store.closeQuietly();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
