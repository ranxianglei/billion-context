import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import { createSession, type Session } from "../src/session.ts";
import { planIngest, toLegacyLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { rmrf } from "./tmp-rm.ts";

const root = mkdtempSync(join(tmpdir(), "bili-orphan-recovery-"));
process.env.BILI_CONFIG_FILE = join(root, "missing.json");
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_JSON_WRITER = "on";
test.after(() => rmrf(root));

function snapshot(requests: number, nextBlockId: number, orphan = true): Session {
    const session = createSession("frozen-session");
    session.stats.requests = requests;
    session.state.nextBlockId = nextBlockId;
    session.lastSeen = 1000;
    if (orphan) session.blockContents.set("b1", {
        one: null,
        full: { text: "retained original", count: 1 },
    });
    return session;
}

async function fixture(t: TestContext, indexed: Session, envelope?: Session) {
    const dir = mkdtempSync(join(root, "case-"));
    if (envelope) {
        process.env.BILI_STORAGE_UNIFIED = "legacy";
        const writer = new SessionStore({ dir, enabled: true });
        try {
            await writer.writeNow(envelope);
        } finally {
            writer.closeQuietly();
        }
    }
    const db = UnifiedStore.open(join(dir, "index.db"));
    try {
        db.ingestSession(planIngest(toLegacyLike(indexed)));
    } finally {
        db.close();
    }
    process.env.BILI_STORAGE_UNIFIED = "full";
    const store = new SessionStore({ dir, enabled: true });
    t.after(() => store.closeQuietly());
    return { store, dir };
}

test("cold load recovers the pre-fix orphan freeze before processing a request", async (t) => {
    const fresh = snapshot(876, 4);
    fresh.state.blocks.push({
        blockId: "b3", runId: "r1", tier: 1, summary: "current fold",
        directMessageIds: ["raw-new"], effectiveMessageIds: ["raw-new"], directBlockIds: [],
        compressedTokens: 5000, createdAt: 2000, survivedCount: 0, generation: "young", active: true,
    });
    fresh.state.messageRefs = { byRaw: { "raw-new": "m00003" }, byRef: { m00003: "raw-new" } };
    fresh.lastMessages = [
        { id: "raw-new", role: "user", contentType: "text", text: "covered turn" },
        { id: "raw-tail", role: "user", contentType: "text", text: "new turn" },
    ];
    fresh.metadata.recoveryMarker = "fresh";
    const { store, dir } = await fixture(t, snapshot(390, 3), fresh);
    const recovered = store.loadSync(fresh.id);
    assert.ok(recovered);
    assert.equal(recovered.stats.requests, 876);
    assert.equal(recovered.state.nextBlockId, 4);
    assert.deepEqual(recovered.state.blocks.map(b => b.blockId), ["b3"]);
    // #4316 PR3/3: a full-mode cold load re-homes citation numbers once
    // (ledger alignment) — pin the content-addressable round-trip, not the
    // counter-era number, so the assertion holds under any numbering scheme.
    const alignedRef = recovered.state.messageRefs.byRaw["raw-new"];
    assert.ok(alignedRef, "raw-new must keep a citation number after recovery");
    assert.equal(recovered.state.messageRefs.byRef[alignedRef], "raw-new");
    // The pre-alignment number is recorded as superseded, not silently dropped.
    assert.equal(alignedRef, "m00001", "the first stored message aligns to seq 0 + 1");
    assert.equal(recovered.restampSuperseded?.get("m00003"), "raw-new");
    assert.equal(recovered.lastMessages?.at(-1)?.text, "new turn");
    assert.equal(recovered.metadata.recoveryMarker, "fresh");
    assert.equal(recovered.blockContents.get("b1")?.full.text, "retained original");
    store.closeQuietly();

    const envelopes = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".json"));
    assert.ok(envelopes.length > 0);
    for (const file of envelopes) unlinkSync(join(dir, file));
    const restarted = new SessionStore({ dir, enabled: true });
    t.after(() => restarted.closeQuietly());
    const fromIndex = restarted.loadSync(fresh.id);
    assert.ok(fromIndex);
    assert.equal(fromIndex.stats.requests, 876, "recovery must persist without a subsequent request/save");
    assert.equal(fromIndex.blockContents.get("b1")?.full.text, "retained original");
    assert.deepEqual(fromIndex.state.blocks.map(b => b.blockId), ["b3"]);
});

test("equal request counters recover a more advanced fold cursor", async (t) => {
    const { store } = await fixture(t, snapshot(390, 3), snapshot(390, 4));
    assert.equal(store.loadSync("frozen-session")?.state.nextBlockId, 4);
});

test("bare-id cold loads recover a namespaced envelope", async (t) => {
    const indexed = snapshot(390, 3);
    const envelope = snapshot(876, 4);
    indexed.meta = envelope.meta = { protocol: "responses", upstreamOrigin: "https://chatgpt.com" };
    const { store } = await fixture(t, indexed, envelope);
    assert.equal(store.loadSync(indexed.id)?.stats.requests, 876);
});

for (const [label, requests, nextBlockId] of [
    ["fewer requests", 389, 9],
    ["older fold cursor", 390, 2],
    ["equal progress", 390, 3],
] as const) {
    test(`a more recently written envelope with ${label} cannot roll back the index`, async (t) => {
        const indexed = snapshot(390, 3);
        indexed.metadata.recoveryMarker = "index";
        const envelope = snapshot(requests, nextBlockId);
        envelope.metadata.recoveryMarker = "envelope";
        const { store } = await fixture(t, indexed, envelope);
        const loaded = store.loadSync(indexed.id);
        assert.equal(loaded?.stats.requests, 390);
        assert.equal(loaded?.state.nextBlockId, 3);
        assert.equal(loaded?.metadata.recoveryMarker, "index");
    });
}

test("orphan journals without an envelope keep loading from the index", async (t) => {
    const { store } = await fixture(t, snapshot(390, 3));
    const loaded = store.loadSync("frozen-session");
    assert.equal(loaded?.stats.requests, 390);
    assert.equal(loaded?.blockContents.get("b1")?.full.text, "retained original");
});

test("a corrupt recovery envelope leaves the index readable", async (t) => {
    const { store, dir } = await fixture(t, snapshot(390, 3), snapshot(876, 4));
    const file = readdirSync(dir, { recursive: true, encoding: "utf8" }).find(name => name.endsWith(".json"));
    assert.ok(file);
    writeFileSync(join(dir, file), "{");
    assert.equal(store.loadSync("frozen-session")?.stats.requests, 390);
});

test("defensive sync recovers a frozen index without the orphan fingerprint", async (t) => {
    // #4216/#4370: a journal-write failure or an async-backend importRecord
    // miss freezes the index with NO retained orphan contents in the view —
    // progress, not shape, decides on cold load.
    const indexed = snapshot(390, 3, false);
    indexed.metadata.recoveryMarker = "index";
    const envelope = snapshot(876, 4, false);
    envelope.metadata.recoveryMarker = "envelope";
    const { store } = await fixture(t, indexed, envelope);
    const loaded = store.loadSync("frozen-session");
    assert.equal(loaded?.stats.requests, 876);
    assert.equal(loaded?.state.nextBlockId, 4);
    assert.equal(loaded?.metadata.recoveryMarker, "envelope");
});

test("ordinary full-mode records with an ahead envelope defensive-sync forward", async (t) => {
    const { store } = await fixture(t, snapshot(390, 3, false), snapshot(876, 4, false));
    assert.equal(store.loadSync("frozen-session")?.stats.requests, 876);
});

test("ordinary full-mode records with an equal envelope retain index authority", async (t) => {
    const indexed = snapshot(390, 3, false);
    indexed.metadata.recoveryMarker = "index";
    const envelope = snapshot(390, 3, false);
    envelope.metadata.recoveryMarker = "envelope";
    const { store } = await fixture(t, indexed, envelope);
    const loaded = store.loadSync("frozen-session");
    assert.equal(loaded?.stats.requests, 390);
    assert.equal(loaded?.metadata.recoveryMarker, "index");
});
