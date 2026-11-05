/**
 * #4216 / #4242: a session whose blockContents outlives its state.blocks
 * (the #2695 reap shape) must keep advancing in the unified store — no
 * freeze, no hours-old cold loads. The orphan journal rides the ingest plan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "freeze-")), "missing.json");

function mkBlock(blockId: string, refs: string[]) {
    return {
        blockId,
        runId: "r1",
        tier: 1,
        summary: `summary of ${blockId} — ` + "x".repeat(80),
        directMessageIds: refs,
        effectiveMessageIds: refs,
        directBlockIds: [],
        compressedTokens: 5000,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young",
        active: true,
    } as never;
}

function legacyLike(id: string, requests: number, withOrphan: boolean): LegacySessionLike {
    const state = { ...createInitialState(), requests };
    state.nextBlockId = withOrphan ? 4 : 3;
    // b1..b2 stay claimed; b3 was REAPED (removed from state.blocks) but its
    // original text survives in blockContents — the #2695 shape.
    state.blocks = [mkBlock("b1", ["m00001"]), mkBlock("b2", ["m00002"])] as never;
    const contents = new Map<string, { one: null; full: { text: string; count: number } }>();
    contents.set("b1", { one: null, full: { text: "b1 summary", count: 3 } });
    contents.set("b2", { one: null, full: { text: "b2 summary", count: 3 } });
    if (withOrphan) contents.set("b3", { one: null, full: { text: "b3 orphaned original summary", count: 3 } });
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: { label: id, protocol: "anthropic", upstreamOrigin: "https://api.anthropic.com" },
        stats: { requests },
        metadata: { pluginAgent: "dsh" },
        state: state as never,
        blockContents: contents as never,
        lastMessages: [
            { id: "m00001", role: "user", contentType: "text", text: "q1" },
            { id: "m00002", role: "assistant", contentType: "text", text: "a1" },
            ...(withOrphan ? ([{ id: "m00003", role: "user", contentType: "text", text: "q2 after reap" }] as never) : []),
        ],
        lastMessagesFolded: false,
    };
}

test("#4216: post-reap saves keep advancing (no freeze) and cold loads are fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "fz-"));
    try {
        const store = UnifiedStore.open(join(dir, "index.db"));

        // 1. normal two-block session
        store.ingestSession(planIngest(legacyLike("sess", 390, false)));
        assert.equal((store.getSessionRow("sess") as unknown as { status: string }).status, "active");

        // 2. save with the reap shape: b3 orphaned, requests 876
        store.ingestSession(planIngest(legacyLike("sess", 876, true)));

        // The deterministic repro of #4216: the OLD code froze at requests=390.
        const row = store.getSessionRow("sess")!;
        assert.ok((row.statsJson as string).includes("876"), `session row advanced (stats=${(row.statsJson as string).slice(0, 60)})`);

        // 3. cold load: view carries the fresh state, orphan content survives
        const view = loadLegacyView({
            session: row,
            messages: store.getMessages("sess"),
            blocks: store.getBlocks("sess"),
            deadRefs: store.getDeadRefs("sess"),
            refs: store.getRefs("sess"),
        });
        const viewState = view.state as unknown as { blocks: { blockId: string }[] };
        assert.equal(viewState.blocks.length, 2, "reaped block does NOT resurrect");
        assert.ok(view.blockContents.has("b3"), "orphan original survives for decompress");
        assert.equal((view.blockContents.get("b3") as { full: { text: string } }).full.text, "b3 orphaned original summary");

        // 4. journal merge: a later save (still carrying the orphan) is stable,
        //    and a save WITHOUT it (LazyBlockContents trimmed) keeps the journal.
        store.ingestSession(planIngest(legacyLike("sess", 900, true)));
        store.ingestSession(planIngest({ ...legacyLike("sess", 950, false), blockContents: new Map() } as LegacySessionLike));
        const view2 = loadLegacyView({
            session: store.getSessionRow("sess")!,
            messages: store.getMessages("sess"),
            blocks: store.getBlocks("sess"),
            deadRefs: store.getDeadRefs("sess"),
            refs: store.getRefs("sess"),
        });
        assert.ok(view2.blockContents.has("b3"), "trimmed-away journal entry survives the merge");

        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
