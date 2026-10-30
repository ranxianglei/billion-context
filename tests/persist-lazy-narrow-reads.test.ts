import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState, type CompressionBlock } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import { isDroppedMetadata, LazyBlockContents, type BlockContent, type Session } from "../src/session.ts";
import type { UnifiedShadow } from "../src/storage/shadow.ts";
import type { UnifiedStore } from "../src/storage/store.ts";
import { rmrf } from "./tmp-rm.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "bili-lazy-narrow-"));
process.env.BILI_CONFIG_FILE = path.join(ROOT, "no-config.json");
process.env.BILI_PERSIST_ZSTD = "0";
delete process.env.BILI_STORAGE_JSON_WRITER;
test.after(() => rmrf(ROOT));

type SavedFields = { metadata: Record<string, unknown>; blockContents: Record<string, BlockContent> };
type StoreInternals = {
    shadow: UnifiedShadow;
    loadEnvelope(id: string, meta?: Session["meta"]): { payload: SavedFields } | null;
    buildRecordForSave(session: Session): SavedFields;
};

function makeBlock(blockId: string, active = true): CompressionBlock {
    return {
        blockId, runId: "r0", tier: 1, summary: `summary ${blockId}`,
        directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
        compressedTokens: 0, createdAt: 1, survivedCount: 0, generation: "young", active,
    };
}

function makeSession(id: string, source: string): Session {
    return {
        id, meta: { protocol: "openai", upstreamOrigin: "http://up:1", label: id },
        stats: {
            requests: 5, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
            cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0,
            storeBytesSaved: 0, rangeRestores: 0,
        },
        metadata: { source }, state: createInitialState(),
        createdAt: 1, lastSeen: 2, inFlight: 0, persisted: false, pendingRetrievals: [],
        blockContents: new Map([["orphan", { one: null, full: { text: `${source} orphan original`, count: 2 } }]]),
    };
}

function fixture(t: TestContext, mode: "full" | "legacy"): { store: SessionStore; dir: string } {
    process.env.BILI_STORAGE_UNIFIED = mode;
    const dir = mkdtempSync(path.join(ROOT, `${mode}-`));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 60_000 });
    t.after(() => store.closeQuietly());
    return { store, dir };
}

function internals(store: SessionStore): StoreInternals {
    return store as unknown as StoreInternals;
}

function stateFile(dir: string): string {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = stateFile(file);
            if (nested) return nested;
        } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".content-store.json")) {
            return file;
        }
    }
    return "";
}

function assertDropped(session: Session): void {
    assert.equal(isDroppedMetadata(session.metadata), true);
    assert.ok(session.blockContents instanceof LazyBlockContents);
    assert.equal(session.blockContents.isDropped, true);
}

test("full-mode lazy getters read only their requested resident field and keep all originals", async (t) => {
    const { store } = fixture(t, "full");
    const session = makeSession("narrow-full", "index");
    session.state.blocks = [makeBlock("active"), makeBlock("archived", false)];
    session.blockContents.set("active", {
        one: { text: "short view", count: 1 }, full: { text: "full active original", count: 4 },
    });
    session.blockContents.set("archived", {
        one: { text: "same archived original", count: 2 }, full: { text: "same archived original", count: 2 },
    });
    await store.writeNow(session);
    assertDropped(session);

    const shadow = internals(store).shadow;
    const driver = (shadow as unknown as { sync: UnifiedStore }).sync;
    assert.ok(driver, "full mode must exercise the SQLite lane");
    const wholeLoads = t.mock.method(store, "loadSync");
    const wholeViews = t.mock.method(shadow, "viewFor");
    const messages = t.mock.method(driver, "getMessages");
    const blockPayloads = t.mock.method(driver, "getBlocks");
    const sessionRows = t.mock.method(driver, "getSessionRow");
    const metadata = t.mock.method(driver, "getMetadataJson");
    const contents = t.mock.method(driver, "getBlockContents");
    const narrow = t.mock.method(shadow, "readResidentFieldsFor");
    const imports = t.mock.method(shadow, "importRecord");
    const saves = t.mock.method(store, "scheduleSave");

    assert.equal(session.metadata.source, "index");
    assert.equal(metadata.mock.callCount(), 1);
    assert.equal(contents.mock.callCount(), 0, "metadata access does not fetch any originals");
    assert.equal((session.blockContents as LazyBlockContents).isDropped, true);
    assert.deepEqual(narrow.mock.calls[0].arguments[1], { metadata: true });

    assert.deepEqual(session.blockContents.get("active"), {
        one: { text: "short view", count: 1 }, full: { text: "full active original", count: 4 },
    });
    assert.deepEqual(session.blockContents.get("archived"), {
        one: null, full: { text: "same archived original", count: 2 },
    }, "inactive originals survive and duplicate one/full pairs normalize");
    assert.deepEqual(session.blockContents.get("orphan"), { one: null, full: { text: "index orphan original", count: 2 } });
    assert.equal(session.blockContents.size, 3);
    assert.equal(metadata.mock.callCount(), 1, "contents access does not re-fetch metadata");
    assert.deepEqual(narrow.mock.calls[1].arguments[1], { blockContents: true });
    for (const spy of [wholeLoads, wholeViews, messages, blockPayloads, sessionRows, imports, saves]) {
        assert.equal(spy.mock.callCount(), 0, "a lazy getter must not rebuild, import or schedule a whole session");
    }
});

test("legacy save builder shares one envelope read for both dropped fields without retaining an old projection", async (t) => {
    const { store, dir } = fixture(t, "legacy");
    const session = makeSession("narrow-legacy", "first");
    await store.writeNow(session);
    assertDropped(session);
    const envelopes = t.mock.method(internals(store), "loadEnvelope");
    const wholeLoads = t.mock.method(store, "loadSync");

    const saved = internals(store).buildRecordForSave(session);
    assert.equal(saved.metadata.source, "first");
    assert.equal(saved.blockContents.orphan.full.text, "first orphan original");
    assert.equal(envelopes.mock.callCount(), 1, "one build shares a single source read across both lazy getters");
    assert.equal(wholeLoads.mock.callCount(), 0);
    await store.writeNow(session);
    assertDropped(session);
    const priorReads = envelopes.mock.callCount();

    // An external writer changes only the two resident fields. The next read
    // must consult disk again after the synchronous save has finished.
    const file = stateFile(dir);
    assert.ok(file);
    const envelope = JSON.parse(readFileSync(file, "utf8")) as { payload: SavedFields };
    envelope.payload.metadata.source = "external";
    envelope.payload.blockContents.orphan.full.text = "external original";
    writeFileSync(file, JSON.stringify(envelope));
    assert.equal(session.metadata.source, "external");
    assert.equal(session.blockContents.get("orphan")?.full.text, "external original");
    assert.equal(envelopes.mock.callCount(), priorReads + 2, "independent touches outside a save each select their current source");
    assert.equal(wholeLoads.mock.callCount(), 0);
});

test("lazy source arbitration matches cold-load progress and drift rules", async (t) => {
    type Generation = { requests: number; nextBlockId: number; active: number; refs: number };
    const base: Generation = { requests: 5, nextBlockId: 10, active: 1, refs: 1 };
    const cases: { name: string; latch: boolean; index?: Partial<Generation>; envelope: Partial<Generation>; expected: string }[] = [
        { name: "strictly more envelope requests", latch: false, envelope: { requests: 6 }, expected: "envelope" },
        { name: "equal requests and ahead envelope fold cursor", latch: false, envelope: { nextBlockId: 11 }, expected: "envelope" },
        { name: "equal progress keeps index", latch: false, envelope: {}, expected: "index" },
        { name: "drift prefers greater index active coverage", latch: true, index: { active: 2 }, envelope: { requests: 99 }, expected: "index" },
        { name: "drift prefers greater index mapped refs", latch: true, index: { refs: 3 }, envelope: { requests: 99 }, expected: "index" },
        { name: "drift ties keep envelope", latch: true, envelope: {}, expected: "envelope" },
    ];
    for (const [i, c] of cases.entries()) {
        await t.test(c.name, async (st) => {
            const { store } = fixture(st, "full");
            const id = `narrow-arbitration-${i}`;
            const generation = (source: string, values: Generation): Session => {
                const session = makeSession(id, source);
                session.stats.requests = values.requests;
                session.state.nextBlockId = values.nextBlockId;
                session.state.blocks = Array.from({ length: values.active }, (_, n) => makeBlock(`b${n + 1}`));
                for (let n = 1; n <= values.refs; n++) {
                    const ref = `m${String(n).padStart(5, "0")}`;
                    session.state.messageRefs.byRaw[`raw-${n}`] = ref;
                    session.state.messageRefs.byRef[ref] = `raw-${n}`;
                }
                return session;
            };
            await store.writeNow(generation("index", { ...base, ...c.index }));
            const shadow = internals(store).shadow;
            const ingest = st.mock.method(shadow, "record", () => {});
            const envelope = generation("envelope", { ...base, ...c.envelope });
            await store.writeNow(envelope);
            ingest.mock.restore();
            if (c.latch) shadow.driftedSessions.add(id);
            assertDropped(envelope);

            const loads = st.mock.method(store, "loadSync");
            const views = st.mock.method(shadow, "viewFor");
            assert.equal(envelope.metadata.source, c.expected);
            assert.equal(envelope.blockContents.get("orphan")?.full.text, `${c.expected} orphan original`);
            assert.equal(loads.mock.callCount(), 0);
            assert.equal(views.mock.callCount(), 0);
            loads.mock.restore();
            views.mock.restore();
            const cold = store.loadSync(id);
            assert.equal(cold?.metadata.source, c.expected, "the public cold loader selects the same generation");
            assert.equal(cold?.blockContents.get("orphan")?.full.text, envelope.blockContents.get("orphan")?.full.text);
        });
    }
});
