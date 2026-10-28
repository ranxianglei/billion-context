import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { LazyBlockContents, _resetSessionsForTest, getSession } from "../src/session.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, toLegacyLike } from "../src/storage/ingest.ts";
import { _resetDiskCacheForTest, buildMessageContent, buildSessionDetail } from "../src/web/sessions-data.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = mkdtempSync(path.join(tmpdir(), "bili-web-fallback-sess-"));
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-web-fallback-cfg-")), "no-config.json");

function mkBlock(blockId: string, direct: string[], effective: string[]): CompressionBlock {
    return {
        blockId,
        runId: "run-1",
        tier: 1 as CompressionBlock["tier"],
        summary: "s",
        directMessageIds: direct,
        effectiveMessageIds: effective,
        directBlockIds: [],
        compressedTokens: 1000,
        createdAt: 1_700_000_000_000,
        survivedCount: 0,
        generation: "young",
        active: true,
    };
}

test("#4738: messages pruned from the resident window hydrate previews + full text from storage", async () => {
    _resetSessionsForTest();
    const s = getSession("fallback-msgs", { protocol: "openai" });
    s.state = createInitialState();
    s.state.blocks = [mkBlock("b1", ["rm1", "rm2", "rm3"], ["rm1", "rm2", "rm3"])];
    s.state.messageRefs = {
        byRaw: { rm1: "m00001", rm2: "m00002", rm3: "m00099" },
        byRef: { m00001: "rm1", m00002: "rm2", m00099: "rm3" },
    };
    s.lastMessages = [
        { id: "rm1", role: "user", contentType: "text", text: "hello   there\nworld" },
        { id: "rm2", role: "assistant", contentType: "text", text: "stored answer" },
    ];
    s.blockContents = new LazyBlockContents("fallback-msgs", {}, () => null);

    // Seed the unified index exactly the way a save would have. Then the live
    // session forgets the bytes — the same observable state as host-side native
    // compaction pruning `lastMessages` client-side (rm3 was never stored).
    const dbPath = path.join(process.env.BILI_SESSIONS_DIR!, "index.db");
    const seed = UnifiedStore.open(dbPath);
    try {
        seed.ingestSession(planIngest(toLegacyLike(s)));
    } finally {
        seed.close();
    }
    s.lastMessages = [{ id: "rm1", role: "user", contentType: "text", text: "hello   there\nworld" }];
    _resetDiskCacheForTest();
    try {
        const d = await buildSessionDetail("fallback-msgs");
        assert.ok(d);
        assert.deepEqual(d.blockDetails[0].directMessages, [
            { ref: "m00001", role: "user", preview: "hello there world" },
            { ref: "m00002", role: "assistant", preview: "stored answer" }, // pruned from the window → hydrated, NOT missing
            { ref: "m00099", missing: true }, // stamped by the ledger but absent from storage too → honest miss
        ]);
        assert.equal(d.blockDetails[0].directMessageCount, 3);
        assert.deepEqual(d.blockDetails[0].directMessageRefs, ["m00001", "m00002", "m00099"]);

        const one = await buildMessageContent("fallback-msgs", "m00002");
        assert.ok(one.ok, "click-to-open serves a pruned message from storage");
        assert.equal(one.role, "assistant");
        assert.equal(one.text, "stored answer");
        assert.equal(one.totalBytes, Buffer.byteLength("stored answer"));

        const resident = await buildMessageContent("fallback-msgs", "m00001");
        assert.ok(resident.ok);
        assert.equal(resident.text, "hello   there\nworld", "resident bytes stay verbatim — fallback never rewrites them");

        assert.deepEqual(await buildMessageContent("fallback-msgs", "m00099"), { ok: false, reason: "unknown-message" });
        assert.deepEqual(await buildMessageContent("no-such-session", "m00001"), { ok: false, reason: "unknown-session" });
    } finally {
        _resetDiskCacheForTest();
    }
});

test("#4738 fail-open: with no unified store the pruned leaf stays an honest miss", async () => {
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    _resetSessionsForTest();
    const s = getSession("fallback-miss", { protocol: "openai" });
    s.state = createInitialState();
    s.state.blocks = [mkBlock("b1", ["rm1"], ["rm1"])];
    s.state.messageRefs = { byRaw: { rm1: "m00001" }, byRef: { m00001: "rm1" } };
    s.lastMessages = [];
    s.blockContents = new LazyBlockContents("fallback-miss", {}, () => null);
    _resetDiskCacheForTest();
    try {
        const d = await buildSessionDetail("fallback-miss");
        assert.ok(d);
        assert.deepEqual(d.blockDetails[0].directMessages, [{ ref: "m00001", missing: true }]);
        assert.deepEqual(await buildMessageContent("fallback-miss", "m00001"), { ok: false, reason: "unknown-message" });
    } finally {
        process.env.BILI_STORAGE_UNIFIED = "full";
        _resetDiskCacheForTest();
    }
});
