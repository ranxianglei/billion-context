import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createContentStore, storeOriginal, type CompressionBlock, type MessageContentStore, type StoredEntry } from "acp-kernel";
import { openaiToCore } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, _resetSessionsForTest, type Session } from "../src/session.ts";
import { maybeAdoptForkBlocks, planForkStoreAdoption } from "../src/fork-adoption.ts";
import { drainPendingRetrievals, executeRetrieve } from "../src/store.ts";

/**
 * #1340 fork CCR store adoption: an armed parent folds blocks AND stores CCR
 * originals; an anonymous fork adopts the blocks (#629) but today starts with
 * an EMPTY content store — every acp_retrieve on a cited ref misses, and the
 * first post-fork fold can poison the child store with placeholder text
 * (kernel side: acp-kernel#432). These tests pin: the child inherits exactly
 * the store entries its view can cite, retrieves return the TRUE original,
 * the parent envelope stays untouched, the child persists its own companion,
 * and a CCR-less parent creates no artifact.
 */

const UP = "http://upstream.test/v1";
const ORIGINAL_TOOL_TEXT = "TOOL-ORIGINAL-PAYLOAD ".repeat(256);
const VISIBLE_TEXT = "visible assistant reply with stored original";

function makeBody(): unknown {
    return {
        model: "test-model",
        messages: [
            { role: "user", content: "run the benchmark" },
            {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "make bench" }) } }],
            },
            { role: "tool", tool_call_id: "call_1", name: "bash", content: ORIGINAL_TOOL_TEXT },
            { role: "assistant", content: VISIBLE_TEXT },
        ],
    };
}

function refFor(index: number): string {
    return `m${String(index + 1).padStart(5, "0")}`;
}

interface Fixture {
    body: unknown;
    userMsgId: string;
    toolResultMsgId: string;
    visibleMsgId: string;
    toolResultRef: string;
    visibleRef: string;
}

type ChatBody = Parameters<typeof openaiToCore>[0];

function coreMsgs(body: unknown) {
    return openaiToCore(body as ChatBody).msgs;
}

function buildFixture(): Fixture {
    const body = makeBody();
    const msgs = coreMsgs(body);
    const user = msgs.find((m) => m.role === "user");
    const toolResult = msgs.find((m) => m.contentType === "tool-result");
    const visible = msgs.filter((m) => m.role === "assistant" && m.contentType === "text").at(-1)!;
    if (!user || !toolResult) throw new Error("fixture conversion failed");
    const index = (id: string): number => msgs.findIndex((m) => m.id === id);
    return {
        body,
        userMsgId: user.id,
        toolResultMsgId: toolResult.id,
        visibleMsgId: visible.id,
        toolResultRef: refFor(index(toolResult.id)),
        visibleRef: refFor(index(visible.id)),
    };
}

function makeParent(id: string, fx: Fixture, withStore: boolean): Session {
    const parent = getSession(id, { protocol: "openai", upstreamOrigin: UP });
    const msgs = coreMsgs(fx.body);
    for (let i = 0; i < msgs.length; i++) {
        parent.state.messageRefs.byRaw[msgs[i]!.id] = refFor(i);
        parent.state.messageRefs.byRef[refFor(i)] = msgs[i]!.id;
    }
    const block: CompressionBlock = {
        blockId: "b1",
        runId: "r1",
        tier: 1,
        topic: "benchmark run",
        summary: "ran make bench; captured output",
        directMessageIds: [fx.userMsgId, fx.toolResultMsgId],
        effectiveMessageIds: [fx.userMsgId, fx.toolResultMsgId],
        directBlockIds: [],
        compressedTokens: 512,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young",
        active: true,
    };
    parent.state.blocks.push(block);
    if (withStore) {
        let store: MessageContentStore = createContentStore();
        store = storeOriginal(store, { ref: fx.toolResultRef, rawId: fx.toolResultMsgId, text: ORIGINAL_TOOL_TEXT, kind: "shell output", tokens: 2048, head: ORIGINAL_TOOL_TEXT.slice(0, 64) });
        store = storeOriginal(store, { ref: fx.visibleRef, rawId: fx.visibleMsgId, text: VISIBLE_TEXT, kind: "text", tokens: 12, head: VISIBLE_TEXT.slice(0, 64) });
        store = storeOriginal(store, { ref: "m00099", rawId: "raw-beyond-fork-point", text: "message beyond the fork point", kind: "text", tokens: 8, head: "message beyond" });
        parent.contentStore = store;
    }
    return parent;
}

function adopt(fx: Fixture, parentId: string, childId: string, enabled: boolean): Session {
    const child = getSession(childId, { protocol: "openai", upstreamOrigin: UP });
    maybeAdoptForkBlocks({ session: child, parentId, protocol: "openai", parsed: fx.body, upstreamOrigin: UP, enabled, log: () => {} });
    return child;
}

test("planForkStoreAdoption keeps reachable entries, clones them, trims byHash to referenced payloads", () => {
    let store = createContentStore();
    store = storeOriginal(store, { ref: "m00001", rawId: "rawA", text: "alpha original", kind: "text", tokens: 3, head: "alpha origi" });
    store = storeOriginal(store, { ref: "m00002", rawId: "rawB", text: "beta original", kind: "text", tokens: 3, head: "beta origina" });
    store = storeOriginal(store, { ref: "m00003", rawId: "rawC", text: "gamma beyond fork", kind: "text", tokens: 4, head: "gamma beyon" });
    const result = planForkStoreAdoption(store, new Set(["rawA", "rawB"]));
    assert.ok(result, "reachable entries must produce a store");
    assert.deepEqual(Object.keys(result!.byRef).sort(), ["m00001", "m00002"]);
    assert.equal(result!.byHash[result!.byRef["m00001"]!.hash], "alpha original");
    assert.equal(result!.byHash[result!.byRef["m00002"]!.hash], "beta original");
    assert.equal(Object.keys(result!.byHash).length, 2, "unreferenced payloads must not ride along");
});

test("planForkStoreAdoption dedups shared payloads and returns null when nothing survives", () => {
    let store = createContentStore();
    store = storeOriginal(store, { ref: "m00001", rawId: "rawA", text: "shared payload", kind: "text", tokens: 3, head: "shared payl" });
    store = storeOriginal(store, { ref: "m00002", rawId: "rawB", text: "shared payload", kind: "text", tokens: 3, head: "shared payl" });
    const result = planForkStoreAdoption(store, new Set(["rawA"]));
    assert.equal(Object.keys(result!.byHash).length, 1, "identical text stores once regardless of ref count");
    assert.equal(planForkStoreAdoption(store, new Set(["rawX"])), null, "nothing reachable → null (no empty artifact)");
});

test("planForkStoreAdoption clones independently (copy-on-fork, parent envelope untouched)", () => {
    let store = createContentStore();
    store = storeOriginal(store, { ref: "m00001", rawId: "rawA", text: "alpha original", kind: "text", tokens: 3, head: "alpha origi" });
    const result = planForkStoreAdoption(store, new Set(["rawA"]));
    result!.byHash = { tampered: "tampered" };
    result!.byRef["m00002"] = { hash: "x", rawId: "rawX", kind: "text", tokens: 1, chars: 1, head: "x" } as StoredEntry;
    assert.deepEqual(Object.keys(store.byRef), ["m00001"], "mutating the clone must not touch the parent byRef");
    assert.equal(store.byHash[store.byRef["m00001"]!.hash], "alpha original", "mutating the clone must not touch the parent byHash");
});

test("fork of an armed parent adopts blocks AND resolves adopted refs via acp_retrieve with the true original (#1340 AC1/AC3/AC4)", () => {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    const fx = buildFixture();
    const parent = makeParent("parent-x", fx, true);
    const parentBefore = JSON.stringify(parent.contentStore);
    const child = adopt(fx, "parent-x", "child-y", true);

    assert.equal(child.state.blocks.length, 1, "block adoption still works");
    assert.equal(child.state.blocks[0]?.blockId, "b1");
    assert.ok(child.contentStore, "child must inherit a content store");
    assert.deepEqual(Object.keys(child.contentStore!.byRef).sort(), [fx.toolResultRef, fx.visibleRef].sort(), "exactly the refs the child's view can cite; beyond-fork entry excluded");
    assert.equal(child.contentStore!.byHash[child.contentStore!.byRef[fx.toolResultRef]!.hash], ORIGINAL_TOOL_TEXT, "true original text, not placeholder-shaped");

    const ack = executeRetrieve({ ref: fx.toolResultRef }, child);
    assert.match(ack, /^retrieved /, `hit ack expected, got: ${ack}`);
    assert.equal(child.stats.retrieveHits, 1);
    const drained = drainPendingRetrievals(child);
    assert.equal(drained.length, 1);
    assert.ok(drained[0]!.text.startsWith("[acp-retrieved #"), "wire-safe retrieval marker");
    assert.ok(drained[0]!.text.endsWith(ORIGINAL_TOOL_TEXT), "retrieval injects the TRUE original");

    assert.equal(JSON.stringify(parent.contentStore), parentBefore, "parent envelope untouched (AC3)");
    assert.ok(!parent.contentStoreDirty, "parent must not be marked dirty by adoption");
    assert.equal(child.contentStoreDirty, true, "child must persist its own companion (AC4)");
});

test("arrival-stored message folded into an adopted block is retrievable in the child (owner scenario: r50 folded into b3)", () => {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    const fx = buildFixture();
    makeParent("parent-folded", fx, true);
    const child = adopt(fx, "parent-folded", "child-folded", true);
    const entry = child.contentStore?.byRef[fx.toolResultRef];
    assert.ok(entry, "the folded message's arrival-time entry must be adopted (its block b1 covers it)");
    assert.equal(entry!.rawId, fx.toolResultMsgId, "frozen rawId alias preserved");
    const ack = executeRetrieve({ ref: fx.toolResultRef }, child);
    assert.match(ack, /^retrieved /, "retrieve on a folded-but-stored ref must HIT, not miss");
});

test("fork of a CCR-less parent adopts blocks but creates no store artifact (#1340 AC5)", () => {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    const fx = buildFixture();
    makeParent("parent-noccr", fx, false);
    const child = adopt(fx, "parent-noccr", "child-noccr", true);
    assert.equal(child.state.blocks.length, 1, "block adoption unaffected");
    assert.equal(child.contentStore, undefined, "no envelope materialized for a CCR-less parent");
    assert.ok(!child.contentStoreDirty, "no dirty flag → persist writes nothing");
});

test("forkAdoption disabled leaves the fork without blocks or store", () => {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    const fx = buildFixture();
    makeParent("parent-dis", fx, true);
    const child = adopt(fx, "parent-dis", "child-dis", false);
    assert.equal(child.state.blocks.length, 0);
    assert.equal(child.contentStore, undefined);
    assert.ok(!child.contentStoreDirty);
});

function findContentStoreFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir, { withFileTypes: true })) {
            if (name.isDirectory()) walk(path.join(dir, name.name));
            else if (name.name.endsWith(".content-store.json")) out.push(path.join(dir, name.name));
        }
    };
    walk(root);
    return out.sort();
}

test("evicted parent loads from disk into the fork; child persists its own companion readable after restart (#1340 AC4)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bili-fork-ccr-"));
    const warm = new SessionStore({ dir, debounceMs: 0, enabled: true });
    _setStoreForTest(warm);
    _resetSessionsForTest();
    try {
        const fx = buildFixture();
        const parent = makeParent("parent-disk", fx, true);
        parent.contentStoreDirty = true;
        assert.equal(warm.flushSync(parent), true, "parent state + companion must flush");
        const parentFiles = findContentStoreFiles(dir);
        assert.equal(parentFiles.length, 1, "exactly one companion (the parent's) exists before the fork");

        _resetSessionsForTest();
        const child = adopt(fx, "parent-disk", "child-disk", true);
        assert.ok(child.contentStore, "store must be adopted with the parent loaded FROM DISK");
        assert.equal(child.contentStore!.byHash[child.contentStore!.byRef[fx.toolResultRef]!.hash], ORIGINAL_TOOL_TEXT);
        assert.equal(warm.flushSync(child), true, "child must flush its own companion");

        const filesAfter = findContentStoreFiles(dir);
        assert.equal(filesAfter.length, 2, "parent + child companions coexist");
        const childEnvelope = filesAfter.map((f) => JSON.parse(readFileSync(f, "utf8")) as MessageContentStore).find((s) => Object.keys(s.byRef).length === 2);
        assert.ok(childEnvelope, "a two-entry (filtered) companion must exist on disk");
        assert.equal(childEnvelope!.byHash[childEnvelope!.byRef[fx.toolResultRef]!.hash], ORIGINAL_TOOL_TEXT, "cold-read of the child's companion yields the true original");
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
    }
});
