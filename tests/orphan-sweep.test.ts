// #5308 (D2) orphan-block sweep. A collapsed block whose covered substrate was
// never part of the session's durable record (shared-id leftovers from the
// <=v0.1.208 era) reappears forever in the parent session: the #2695 e-gate
// exemption shelters it and the render side keeps it active on any covered-id
// collision. This pins BOTH directions of the discriminator (#3617):
//   negative — a block whose covered ids ARE in the session's unified-store
//              transcript is NEVER flagged (the dangerous false-positive dir);
//   positive — a block whose covered ids have ZERO transcript overlap IS
//              flagged, and under --fix is archived (excluded on reload) without
//              touching the legit block; the archive is reversible and idempotent.
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_PERSIST_ZSTD = "0";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompressionBlock, CoreMessage } from "acp-kernel";
import { createInitialState } from "acp-kernel";
import { SessionStore } from "../src/persist.ts";
import { applyOrphanSweep, detectOrphanBlocks } from "../src/orphan-sweep.ts";

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function makeBlock(blockId: string, effectiveMessageIds: string[]): CompressionBlock {
    return {
        blockId,
        runId: `run-${blockId}`,
        tier: 1,
        summary: "S".repeat(60),
        directMessageIds: [...effectiveMessageIds],
        effectiveMessageIds,
        directBlockIds: [],
        compressedTokens: 1000,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young",
        active: true,
    };
}

function makeStoredSession(id: string, lastMessages: CoreMessage[], blocks: CompressionBlock[] = []) {
    return {
        id,
        meta: { protocol: "anthropic" },
        stats: {
            requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
            cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0,
            retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0,
        },
        metadata: {},
        state: { ...createInitialState(), blocks },
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        lastMessages,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as never;
}

test("#5308 orphan-sweep: zero-overlap blocks are swept, overlapping folds never are", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "bili-orphan-cfg-"));
    process.env.BILI_CONFIG_FILE = join(cfgDir, "no-config.json");
    const dir = mkdtempSync(join(tmpdir(), "bili-orphan-"));
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    try {
        // Seed the unified store with a real transcript (80 message rows).
        await store.writeNow(makeStoredSession("sess-orphan", MESSAGES));
        const tids = store.unifiedSessionTranscriptMsgIds("sess-orphan");
        assert.ok(tids && tids.length > 0, "seeded session must have unified transcript rows");

        // Legit block: covered ids ARE in the transcript. Foreign block: covered
        // ids were never ingested into this session (the shared-id leftover).
        const legit = makeBlock("b_legit", tids!.slice(0, 5));
        const foreign = makeBlock("b_foreign", ["orphan-fx-1", "orphan-fx-2"]);
        const seeded = (await store.loadAll()).get("sess-orphan")!;
        seeded.state.blocks = [legit, foreign];
        await store.writeNow(seeded);

        // NEGATIVE + POSITIVE gate: only the zero-overlap block is flagged.
        const plan = await detectOrphanBlocks(store);
        const flagged = new Set(plan.findings.map((f) => `${f.sessionId}:${f.blockId}`));
        assert.ok(flagged.has("sess-orphan:b_foreign"), "foreign block (zero transcript overlap) must be flagged");
        assert.ok(!flagged.has("sess-orphan:b_legit"), "legit fold (overlapping transcript) must NEVER be flagged");
        assert.equal(plan.performable, true, "full mode must be performable");

        // DRY-RUN default: reports but mutates nothing.
        const dry = await applyOrphanSweep(store, {});
        assert.equal(dry.dryRun, true);
        assert.equal(dry.sweptBlocks, 0, "dry-run must not archive");
        assert.ok((await store.loadAll()).get("sess-orphan")!.state.blocks.some((b) => b.blockId === "b_foreign"),
            "dry-run leaves the foreign block in place");

        // PERFORM: archives only the foreign block.
        const done = await applyOrphanSweep(store, { dryRun: false });
        assert.equal(done.dryRun, false);
        assert.equal(done.sweptBlocks, 1, "exactly the one foreign block archived");
        assert.equal(done.touchedSessions, 1);
        assert.ok(done.lines.some((l) => l.includes("[archived]") && l.includes("b_foreign")), "audit line names the archived block");

        // Reload: foreign block gone, legit block untouched.
        const reloaded = (await store.loadAll()).get("sess-orphan")!;
        const ids = reloaded.state.blocks.map((b) => b.blockId);
        assert.ok(!ids.includes("b_foreign"), "archived foreign block must not render into the session anymore");
        assert.ok(ids.includes("b_legit"), "legit fold must survive the sweep");

        // IDEMPOTENT: nothing left to sweep after the archive.
        const plan2 = await detectOrphanBlocks(store);
        assert.ok(!plan2.findings.some((f) => f.blockId === "b_foreign"), "swept block must not be re-flagged");

        // REVERSIBLE: clearing the exclusion restores the block (data was kept in kstate).
        const meta = { ...(reloaded.metadata as Record<string, unknown>) };
        delete meta.orphanExcludedBlocks;
        store.setUnifiedSessionMetadataJson("sess-orphan", JSON.stringify(meta));
        const restored = (await store.loadAll()).get("sess-orphan")!;
        assert.ok(restored.state.blocks.some((b) => b.blockId === "b_foreign"), "clearing the exclusion must restore the block");
    } finally {
        store.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
        rmSync(cfgDir, { recursive: true, force: true });
    }
});
