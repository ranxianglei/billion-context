import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { createInitialState } from "acp-kernel";
import type { CompressionBlock, MessageRole } from "acp-kernel";
import { LazyBlockContents, _resetSessionsForTest, getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetDiskCacheForTest, buildMessageContent, buildSessionDetail } from "../src/web/sessions-data.ts";

// #4738: the blocks pane must survive the CLIENT'S native compaction. The
// fixture drives the REAL persist path in shadow mode (double-write into a
// hermetic index.db), then prunes the live window the way pi/codex compaction
// does, and asserts the tree leaves and the click-through text both fall back
// to the unified log instead of going "missing".
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "shadow";
// The web layer resolves its OWN disk-store singleton against BILI_SESSIONS_DIR
// (sessions-data getDiskStore → defaultDir, a second connection to the same
// index.db — the production shape), so the fixture store MUST be rooted at the
// very same dir or it double-writes into a database nobody reads.
const SESSIONS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-webleaf-sess-"));
process.env.BILI_SESSIONS_DIR = SESSIONS_ROOT;
process.env.BILI_CONFIG_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bili-webleaf-")), "no-config.json");

function mkBlock(blockId: string, direct: string[]): CompressionBlock {
    return {
        blockId,
        runId: "run-1",
        tier: 1,
        summary: "## T1\n- folded",
        directMessageIds: direct,
        effectiveMessageIds: direct,
        directBlockIds: [],
        compressedTokens: 1000,
        createdAt: 1_700_000_000_000,
        survivedCount: 0,
        generation: "young",
        active: true,
    };
}

const BLOCK_CONTENT = { one: null, full: { text: "## T1\n- folded", count: 0 } };

type SeedMessage = { id: string; role?: MessageRole; text: string };

function seedSession(id: string, block: CompressionBlock, refs: { byRaw: Record<string, string>; byRef: Record<string, string> }, messages: SeedMessage[]): ReturnType<typeof getSession> {
    const s = getSession(id, { protocol: "openai" });
    s.state = createInitialState();
    s.state.blocks = [block];
    s.state.messageRefs = refs;
    // A wired loader lets a LATER save re-materialize the resident contents
    // after dropResidentBlockContents folded them away (a null loader makes
    // the next buildRecord refuse the thinned view by design).
    s.blockContents = new LazyBlockContents(s.id, {}, () => ({ [block.blockId]: BLOCK_CONTENT }));
    s.blockContents.set(block.blockId, BLOCK_CONTENT);
    s.lastMessages = messages.map((m) => ({ id: m.id, role: m.role ?? "user", contentType: "text", text: m.text }));
    return s;
}

test("#4738: pruned leaves fall back to the unified log; absent-from-both stays missing", async () => {
    const store = new SessionStore({ dir: SESSIONS_ROOT, debounceMs: 1, enabled: true });
    _setStoreForTest(store);
    try {
        _resetSessionsForTest();
        const s = seedSession(
            "leaf-4738",
            mkBlock("b1", ["rm1", "rm2", "rm9"]),
            {
                byRaw: { rm1: "m00001", rm2: "m00002", rm9: "m00009" },
                byRef: { m00001: "rm1", m00002: "rm2", m00009: "rm9" },
            },
            [
                { id: "rm1", role: "user", text: "first message body" },
                { id: "rm2", role: "assistant", text: "second message body" },
                { id: "rm3", role: "user", text: "still resident" },
            ],
        );
        await store.writeNow(s);

        // Native compaction: the client window keeps only the newest message,
        // and the host persists the pruned view — after this save no source
        // in memory or on disk still carries rm1/rm2.
        s.lastMessages = [{ id: "rm3", role: "user", contentType: "text", text: "still resident" }];
        await store.writeNow(s);
        _resetDiskCacheForTest();

        const d = await buildSessionDetail("leaf-4738");
        assert.ok(d, "live session resolves");
        assert.deepEqual(d!.blockDetails[0].directMessages, [
            { ref: "m00001", role: "user", preview: "first message body" },
            { ref: "m00002", role: "assistant", preview: "second message body" },
            { ref: "m00009", missing: true },
        ], "pruned leaves render from storage; rm9 was never stored — honest miss");
        assert.equal(d!.blockDetails[0].directMessageCount, 3, "the count still says three were folded");

        const one = await buildMessageContent("leaf-4738", "m00001");
        assert.ok(one.ok, "click-through resolves the pruned message from storage");
        assert.equal(one.role, "user");
        assert.equal(one.text, "first message body");
        assert.equal(one.truncated, false);
        assert.deepEqual(await buildMessageContent("leaf-4738", "m00009"), { ok: false, reason: "unknown-message" });
    } finally {
        store.closeQuietly();
    }
});

test("#4738: a re-sent message with changed bytes serves the NEWEST stored version", async () => {
    const store = new SessionStore({ dir: SESSIONS_ROOT, debounceMs: 1, enabled: true });
    _setStoreForTest(store);
    try {
        _resetSessionsForTest();
        const s = seedSession(
            "leaf-4738-v2",
            mkBlock("b1", ["rm2"]),
            { byRaw: { rm2: "m00002" }, byRef: { m00002: "rm2" } },
            [{ id: "rm2", role: "assistant", text: "second message v1" }],
        );
        await store.writeNow(s);

        // The client re-sent the same id with edited bytes (split tool-call
        // cores share an id across distinct stored rows) — a fresh raw tail so
        // the second save ingests the new version.
        s.lastMessagesFolded = false;
        s.lastMessages = [{ id: "rm2", role: "assistant", contentType: "text", text: "second message v2" }];
        await store.writeNow(s);
        s.lastMessages = [];
        _resetDiskCacheForTest();

        const d = await buildSessionDetail("leaf-4738-v2");
        assert.ok(d);
        assert.deepEqual(d!.blockDetails[0].directMessages, [
            { ref: "m00002", role: "assistant", preview: "second message v2" },
        ], "max-seq wins: the freshest stored bytes are what the client last sent");
        const one = await buildMessageContent("leaf-4738-v2", "m00002");
        assert.ok(one.ok);
        assert.equal(one.text, "second message v2");
    } finally {
        store.closeQuietly();
    }
});
