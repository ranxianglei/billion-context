import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planIngest, loadLegacyView, LegacyViewBuilder, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { SqliteBackend } from "../src/storage/backend.ts";
import type { SqliteDatabase } from "../src/storage/driver.ts";

function fixture(): LegacySessionLike {
    const messages: NonNullable<LegacySessionLike["lastMessages"]> = Array.from({ length: 80 }, (_, i) => ({
        id: `msg${i}`, role: "user", contentType: "text", text: `message ${i}`,
    }));
    const blocks: LegacySessionLike["state"]["blocks"] = Array.from({ length: 70 }, (_, i) => ({
        blockId: `b${i + 1}`, runId: "r1", tier: 1, summary: `summary ${i + 1}`,
        directMessageIds: [`msg${i}`], effectiveMessageIds: [`msg${i}`], directBlockIds: [],
        compressedTokens: 10, createdAt: 1000 + i, survivedCount: 0, generation: "young", active: i % 2 === 0,
    }));
    return {
        id: "bounded", createdAt: 1000, lastSeen: 2000,
        meta: { protocol: "openai" }, stats: { requests: 7 }, metadata: { pluginAgent: "codex", note: "retained" },
        state: {
            blocks, nextBlockId: 71, nextRunId: 2,
            messageRefs: { byRaw: { msg0: "m00001", alias: "m00001", ghost: "m99999", blocked: "BLOCKED" }, byRef: { m00001: "msg0", m99999: "ghost" } },
            deadRefs: ["m90001", "m90002"],
        },
        blockContents: new Map(blocks.map((block) => [block.blockId, {
            one: { text: `one ${block.blockId}`, count: 1 }, full: { text: `original ${block.blockId}`, count: 2 },
        }])),
        decompositionLog: messages,
        pluginSnapshot: messages.slice(0, 36),
        lastMessages: [messages[65], messages[33], messages[65]],
        lastMessagesFolded: true,
        contentStore: { version: 1, byHash: { h: "retained CCR" }, byRef: {} },
    };
}

function seed(store: UnifiedStore): void {
    const plan = planIngest(fixture());
    plan.session.orphansJson = JSON.stringify({
        b1: { one: null, full: { text: "stale journal duplicate", count: 1 } },
        reaped: { one: null, full: { text: "reaped original", count: 1 } },
    });
    store.ingestSession(plan);
    // Simulate missing historical backing rows after the ingest remapper.
    const tail = JSON.parse(store.getSessionRow("bounded")!.tailJson) as { tailSeqs: number[]; pluginSnapshotSeqs: number[] };
    tail.tailSeqs.push(9999);
    tail.pluginSnapshotSeqs.push(9999);
    (store as unknown as { db: SqliteDatabase }).db.prepare("UPDATE sessions SET tail_json = ? WHERE session_id = ?").run(JSON.stringify(tail), "bounded");
}

function allRows(store: UnifiedStore) {
    return {
        session: store.getSessionRow("bounded")!, messages: store.getMessages("bounded"),
        blocks: store.getBlocks("bounded"), refs: store.getRefs("bounded"), deadRefs: store.getDeadRefs("bounded"),
    };
}

function assertHistory(view: LegacySessionLike | null): asserts view is LegacySessionLike {
    assert.ok(view);
    assert.equal(view.state.blocks.length, 70);
    assert.equal(view.state.blocks.filter((block) => !block.active).length, 35, "inactive ancestors remain available to decompress");
    assert.deepEqual(view.state.blocks.map((block) => block.blockId), fixture().state.blocks.map((block) => block.blockId));
    assert.equal(view.blockContents.get("b1")!.full.text, "original b1", "block row wins over a stale orphan journal entry");
    assert.equal(view.blockContents.get("reaped")!.full.text, "reaped original");
    assert.equal(view.blockContents.size, 71);
    assert.deepEqual(view.lastMessages?.map((message) => message.id), ["msg65", "msg33", "msg65"]);
    assert.strictEqual(view.lastMessages![0], view.lastMessages![2], "repeated pointers retain shared message identity");
    assert.strictEqual(view.lastMessages![1], view.pluginSnapshot![33], "tail and snapshot overlap shares one parsed message");
    assert.deepEqual(view.state.messageRefs, fixture().state.messageRefs, "ghost and BLOCKED refs survive verbatim");
    assert.deepEqual(view.state.deadRefs, ["m90001", "m90002"]);
    assert.deepEqual(view.contentStore, fixture().contentStore);
    assert.equal((view as unknown as { tailGaps: number }).tailGaps, 2);
}

test("ordinary sync cold load reads only unique tail/snapshot seqs and bounded block pages", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-bounded-load-"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    const store = (shadow as unknown as { sync: UnifiedStore }).sync;
    t.after(() => { shadow.close(); rmSync(dir, { recursive: true, force: true }); });
    seed(store);
    const expected = loadLegacyView(allRows(store));
    const getMessages = store.getMessages.bind(store);
    const getBlocks = store.getBlocks.bind(store);
    const requested: number[] = [];
    const blockPages: number[] = [];
    let snapshots = 0;
    const snapshot = store.readSnapshot.bind(store);
    store.readSnapshot = (fn) => { snapshots++; return snapshot(fn); };
    store.getMessages = (id, opts) => {
        assert.ok(opts?.seqs && opts.seqs.length <= 32, "cold load must never hydrate the whole message log");
        requested.push(...opts.seqs);
        return getMessages(id, opts);
    };
    store.getBlocks = (id, opts) => {
        assert.equal(opts?.limit, 32);
        blockPages.push(opts?.offset ?? 0);
        return getBlocks(id, opts);
    };
    const view = shadow.viewFor("bounded");
    assertHistory(view);
    assert.deepEqual(view, expected);
    assert.equal(snapshots, 1, "header and every page share one read snapshot");
    assert.deepEqual(blockPages, [0, 32, 64]);
    assert.equal(requested.length, new Set(requested).size);
    assert.deepEqual(new Set(requested), new Set([65, 33, 9999, ...Array.from({ length: 36 }, (_, i) => i)]));
    assert.equal(shadow.viewFor("absent"), null);
});

test("ordinary async cold load uses the snapshot reader for each bounded page", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-bounded-async-"));
    const backend = SqliteBackend.open(join(dir, "index.db"));
    t.after(async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }); });
    seed(backend.store);
    const expected = loadLegacyView(allRows(backend.store));
    const readSnapshot = backend.readSnapshot.bind(backend);
    const offsets: number[] = [];
    const requested: number[] = [];
    let snapshots = 0;
    backend.readSnapshot = (fn) => readSnapshot(async (reader) => {
        snapshots++;
        return fn({
            ...reader,
            getMessages: async (id, opts) => {
                assert.ok(opts?.seqs && opts.seqs.length <= 32);
                requested.push(...opts.seqs);
                return reader.getMessages(id, opts);
            },
            getBlocks: async (id, opts) => {
                assert.equal(opts?.limit, 32);
                offsets.push(opts?.offset ?? 0);
                return reader.getBlocks(id, opts);
            },
        });
    });
    backend.getMessages = async () => { throw new Error("load bypassed the snapshot reader"); };
    backend.getBlocks = async () => { throw new Error("load bypassed the snapshot reader"); };
    const shadow = Reflect.construct(UnifiedShadow, ["full", null, () => null, backend]) as UnifiedShadow;
    const view = await shadow.viewForAsync("bounded");
    assertHistory(view);
    assert.deepEqual(view, expected);
    assert.equal(snapshots, 1);
    assert.deepEqual(offsets, [0, 32, 64]);
    assert.equal(requested.length, new Set(requested).size);
    assert.deepEqual(new Set(requested), new Set([65, 33, 9999, ...Array.from({ length: 36 }, (_, i) => i)]));
});

test("a failed block page falls back and releases the read snapshot for the next load", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-bounded-failure-"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    const store = (shadow as unknown as { sync: UnifiedStore }).sync;
    t.after(() => { shadow.close(); rmSync(dir, { recursive: true, force: true }); });
    seed(store);
    const getBlocks = store.getBlocks.bind(store);
    store.getBlocks = (id, opts) => {
        if (opts?.offset === 32) throw new Error("injected block page failure");
        return getBlocks(id, opts);
    };
    assert.equal(shadow.viewFor("bounded"), null, "partial views must never escape on a failed page");
    store.getBlocks = getBlocks;
    assertHistory(shadow.viewFor("bounded"));
});

test("resident field reads avoid unrelated JSON, messages, refs, and block payloads", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-resident-fields-"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    const store = (shadow as unknown as { sync: UnifiedStore }).sync;
    t.after(() => { shadow.close(); rmSync(dir, { recursive: true, force: true }); });
    seed(store);
    const expected = loadLegacyView(allRows(store));
    for (const key of ["getSessionRow", "getMessages", "getBlocks", "getRefs", "getDeadRefs"] as const) {
        store[key] = () => { throw new Error(`resident field read called ${key}`); };
    }
    let metadataReads = 0;
    let contentReads = 0;
    let orphanReads = 0;
    let snapshots = 0;
    const snapshot = store.readSnapshot.bind(store);
    store.readSnapshot = (fn) => { snapshots++; return snapshot(fn); };
    const metadata = store.getMetadataJson.bind(store);
    const contents = store.getBlockContents.bind(store);
    const orphans = store.getOrphansJson.bind(store);
    store.getMetadataJson = (id) => { metadataReads++; return metadata(id); };
    store.getBlockContents = ((id: string, opts?: { limit: number; offset?: number }) => {
        contentReads++;
        assert.equal(opts?.limit, 32);
        return contents(id, opts);
    }) as typeof store.getBlockContents;
    store.getOrphansJson = (id) => { orphanReads++; return orphans(id); };
    const meta = shadow.readResidentFieldsFor("bounded", { metadata: true });
    assert.deepEqual(meta, { header: { requests: 7, nextBlockId: 71, activeBlockCount: 35, mappedRefCount: 2 }, metadata: expected.metadata });
    assert.equal(contentReads, 0);
    assert.equal(orphanReads, 0);
    const blocks = shadow.readResidentFieldsFor("bounded", { blockContents: true });
    assert.deepEqual(blocks?.blockContents, expected.blockContents);
    assert.equal(metadataReads, 1, "content getter does not read metadata");
    const both = shadow.readResidentFieldsFor("bounded", { metadata: true, blockContents: true });
    assert.deepEqual(both?.metadata, expected.metadata);
    assert.deepEqual(both?.blockContents, expected.blockContents);
    assert.equal(snapshots, 3, "combined fields use one snapshot");
    assert.equal(contentReads, 6);
    assert.equal(orphanReads, 2);
});

test("incremental assembly preserves empty versus absent pointers and skips a corrupt orphan journal", () => {
    const plan = planIngest(fixture());
    plan.session.tailJson = JSON.stringify({ tailSeqs: [], pluginSnapshotSeqs: null, tailFolded: false });
    plan.session.orphansJson = "broken journal";
    const builder = new LegacyViewBuilder(plan.session, plan.refs!, plan.deadRefs);
    assert.deepEqual(builder.messageSeqs, []);
    builder.addBlocks(plan.blocks);
    const view = builder.finish();
    assert.deepEqual(view.lastMessages, []);
    assert.equal(view.pluginSnapshot, undefined);
    assert.equal(view.tailGaps, 0);
    assert.equal(view.blockContents.size, 70);
    plan.session.tailJson = JSON.stringify({ tailSeqs: null, pluginSnapshotSeqs: [], tailFolded: false });
    const other = new LegacyViewBuilder(plan.session, [], []).finish();
    assert.equal(other.lastMessages, undefined);
    assert.deepEqual(other.pluginSnapshot, []);
});
