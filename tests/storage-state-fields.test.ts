/**
 * #4192 / #4242: state fields survive the unified round-trip — the field
 * list is DERIVED from mergeState, so hydration cannot silently drop fields
 * the envelope loader keeps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { COMPRESSION_STATE_FIELDS, mergeState } from "../src/state-hydration.ts";
import { planIngest, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "statefields-")), "missing.json");

test("#4192: sweptOrphanCallIds / pendingOrphanSweepMinRef survive the unified round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-db-"));
    try {
        const store = UnifiedStore.open(join(dir, "index.db"));
        const state: Record<string, unknown> = {
            ...createInitialState(),
            sweptOrphanCallIds: ["m00042", "m00043"],
            pendingOrphanSweepMinRef: 42,
        };
        const legacy = {
            id: "sf-1",
            createdAt: Date.now(),
            lastSeen: Date.now(),
            meta: { label: "sf-1", protocol: "anthropic", upstreamOrigin: "https://api.anthropic.com" },
            stats: { requests: 1 },
            metadata: { pluginAgent: "dsh" },
            state: state as never,
            blockContents: new Map(),
            lastMessages: [{ id: "m00001", role: "user", contentType: "text", text: "hello" }],
            lastMessagesFolded: false,
        } satisfies LegacySessionLike;
        store.ingestSession(planIngest(legacy));

        const rows = {
            session: store.getSessionRow("sf-1")!,
            messages: store.getMessages("sf-1"),
            blocks: store.getBlocks("sf-1"),
            deadRefs: store.getDeadRefs("sf-1"),
            refs: store.getRefs("sf-1"),
        };
        const view = loadLegacyView(rows);
        // The two fields the hand list dropped (#4192) must round-trip intact.
        assert.deepEqual((view.state as Record<string, unknown>).sweptOrphanCallIds, ["m00042", "m00043"]);
        assert.equal((view.state as Record<string, unknown>).pendingOrphanSweepMinRef, 42);
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("mechanism: every field of a fresh state is covered by the derived list (no future #4192)", () => {
    const freshKeys = Object.keys(createInitialState());
    for (const key of freshKeys) {
        assert.ok(
            (COMPRESSION_STATE_FIELDS as readonly string[]).includes(key),
            `createInitialState emits "${key}" but COMPRESSION_STATE_FIELDS lacks it — add it to mergeState's literal (src/state-hydration.ts)`,
        );
    }
    // And the list is exactly the merge output — nothing stale either.
    assert.deepEqual([...COMPRESSION_STATE_FIELDS], Object.keys(mergeState(createInitialState())));
});
