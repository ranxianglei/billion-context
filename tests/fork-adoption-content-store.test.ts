import test from "node:test";
import assert from "node:assert/strict";
import {
    createCore,
    createContentStore,
    createInitialState,
    defaultConfig,
    storeOriginal,
    hashContent,
    type CoreMessage,
} from "acp-kernel";
import { applyForkAdoption, planForkAdoption } from "../src/fork-adoption.ts";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

/**
 * #1341: fork adoption carried blocks + blockContents + messageRefs but NOT
 * the CCR content store — the forked session showed covered-ref spans yet
 * every acp_retrieve(adopted ref) missed (half-adopted state). Adoption must
 * copy the parent's store entries for the adopted refs, copy-on-fork,
 * first-write-wins, skipping entries whose content blob is gone (corrupt
 * envelope → honest miss, never a broken hit).
 */

const countTokens = (text: string) => Math.ceil(text.length / 4);

/** Minimal fresh Session literal (same shape as session.ts getSession). */
function freshSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function foldFixture(): { parent: Session; coveredIds: string[] } {
    const messages: CoreMessage[] = [];
    for (let i = 1; i <= 6; i++) {
        messages.push({ id: `u${i}`, role: "user", contentType: "text", text: `user turn ${i} with enough prose to fold comfortably`.repeat(3) });
        messages.push({ id: `a${i}`, role: "assistant", contentType: "text", text: `assistant reply ${i} with enough prose to fold comfortably`.repeat(3) });
    }
    const core = createCore({ countTokens });
    const seeded = core.processTurn({ messages, state: createInitialState(), config: defaultConfig(100000), tokenCount: 500 });
    const compressed = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00008", summary: "S".repeat(80) }],
        messages: seeded.messages,
        state: seeded.state,
        config: defaultConfig(100000, { compress: { minCompressRange: 0 }, preserveRecentMessages: 2, preserveRecentTokens: 0 }),
    });
    const parent = freshSession("parent-fixture");
    parent.state = compressed.state;
    const covered = new Set<string>();
    for (const b of compressed.state.blocks) if (b.active) for (const id of b.effectiveMessageIds) covered.add(id);
    return { parent, coveredIds: [...covered] };
}

test("applyForkAdoption carries the parent's content-store entries for adopted refs (#1341)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parent, coveredIds } = foldFixture();
    assert.ok(coveredIds.length >= 4, "fixture must fold a real block");

    // Parent store holds originals for the first two covered refs only —
    // partial coverage is the realistic shape (CCR stores big results, not
    // every message).
    const parentStore = createContentStore();
    const first = coveredIds[0]!;
    const second = coveredIds[1]!;
    parentStore.byRef["m00001"] = { hash: hashContent("ORIGINAL ONE"), rawId: first, kind: "file read", tokens: 12, chars: 11, head: "ORIGINAL ONE" };
    parentStore.byHash[hashContent("ORIGINAL ONE")] = "ORIGINAL ONE";
    parentStore.byRef["m00002"] = { hash: hashContent("ORIGINAL TWO"), rawId: second, kind: "tool:bash", toolName: "bash", tokens: 7, chars: 11, head: "ORIGINAL TWO" };
    parentStore.byHash[hashContent("ORIGINAL TWO")] = "ORIGINAL TWO";
    parent.contentStore = parentStore;

    const incoming = new Set(coveredIds);
    const plan = planForkAdoption(parent, incoming);
    assert.ok(plan.adoptedActive >= 1, "plan adopts the folded block");
    const child = freshSession("child-fork");
    applyForkAdoption(child, plan, parent);

    assert.ok(child.contentStore, "child store must be populated");
    assert.deepEqual(child.contentStore!.byRef["m00001"], parentStore.byRef["m00001"], "entry is copy-identical");
    assert.equal(child.contentStore!.byHash[hashContent("ORIGINAL ONE")], "ORIGINAL ONE", "content blob rides along");
    assert.deepEqual(child.contentStore!.byRef["m00002"], parentStore.byRef["m00002"]);
    assert.equal(child.contentStoreDirty, true, "persist must write the adopted envelope");
    assert.ok(child.stats.storedBytes > 0, "storedBytes reflects the adopted store");
    // Parent untouched (copy-on-fork).
    assert.equal(parentStore.byRef["m00001"].rawId, first);
    assert.equal(Object.keys(parentStore.byRef).length, 2);
});

test("applyForkAdoption skips store entries with a missing content blob (corrupt envelope)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parent, coveredIds } = foldFixture();
    const parentStore = createContentStore();
    const first = coveredIds[0]!;
    parentStore.byRef["m00001"] = { hash: hashContent("GONE"), rawId: first, kind: "file read", tokens: 5, chars: 4, head: "GONE" };
    // byHash deliberately lacks the blob — corrupted / partially deleted file.
    parent.contentStore = parentStore;

    const plan = planForkAdoption(parent, new Set(coveredIds));
    const child = freshSession("child-corrupt");
    applyForkAdoption(child, plan, parent);
    // contentStoreOf may lazily materialize an empty store; what matters is
    // that the broken entry never entered it.
    assert.equal(child.contentStore?.byRef["m00001"], undefined, "broken entry must not be adopted — misses beat broken hits");
    assert.equal(Object.keys(child.contentStore?.byHash ?? {}).length, 0);
    assert.notEqual(child.contentStoreDirty, true);
});

test("applyForkAdoption leaves an empty store untouched when the parent has none", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parent, coveredIds } = foldFixture();
    const plan = planForkAdoption(parent, new Set(coveredIds));
    const child = freshSession("child-empty");
    applyForkAdoption(child, plan, parent);
    assert.notEqual(child.contentStoreDirty, true, "no entries → no dirty flag, no store write");
});
