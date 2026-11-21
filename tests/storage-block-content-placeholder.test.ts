// Repro on master: a legacy session with a folded block but no blockContents
// snapshot. After SQLite import the index replays the completeBlockContents
// placeholder ({ one: null, full: { text: summary, count: 0 } }) and readers
// treat it as the compression-time snapshot.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ph-repro-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { storeEffectiveCcr } from "../src/store.ts";
import { getSession, type Session } from "../src/session.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges } from "../src/stream.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { SessionStore } from "../src/persist.ts";

const pad = (n: number): string => String(n).padStart(5, "0");

function fold() {
    const core = createCore();
    const config = applyCompressSettings(defaultConfig(200_000), 200_000, { ccr: { enabled: true, minToolTokens: 50 } }) as Config;
    const session = getSession(`ph-repro-${Math.random().toString(36).slice(2)}`);
    session.meta.protocol = "anthropic";
    session.meta.upstreamOrigin = "http://127.0.0.1:8199";
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    const raw: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
        raw.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(1000)}`,
        });
    }
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    return { ctx, session, block };
}

function reload(dir: string, mode: string, session: Session): Session {
    process.env.BILI_STORAGE_UNIFIED = mode;
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
    try {
        const loaded = store.loadSync(session.id, session.meta);
        assert.ok(loaded, `${mode}: loadSync returned null`);
        return loaded;
    } finally {
        store.cancelAll();
        store.closeQuietly();
    }
}

test("legacy session without a block snapshot: SQLite load must decompress like the JSON load", async () => {
    const dir = path.join(hermetic, "store");
    const { ctx, session, block } = fold();
    // Legacy record without a snapshot for the folded block (pruned / never cached).
    session.blockContents = new Map();
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    const writer = new SessionStore({ dir, debounceMs: 1, enabled: true });
    await writer.writeNow(session);
    writer.cancelAll();
    writer.closeQuietly();

    const legacy = reload(dir, "legacy", session);
    const legacyText = resolveDecompress({ blockId: block.blockId }, { ...ctx, session: legacy }).text;

    reload(dir, "full", session); // organic import
    const migrated = reload(dir, "full", session); // served from the index
    // Pin the precondition: the index replay must serve the placeholder shape —
    // without it this test would stop exercising the bug and still pass.
    assert.equal(legacy.blockContents.get(block.blockId), undefined, "legacy load has no snapshot for the block");
    assert.deepEqual(migrated.blockContents.get(block.blockId), { one: null, full: { text: block.summary, count: 0 } }, "index replay serves the completeBlockContents placeholder");
    const migratedText = resolveDecompress({ blockId: block.blockId }, { ...ctx, session: migrated }).text;
    assert.match(legacyText, /Historical detail 0\./, "legacy JSON load restores originals from the live messages");
    assert.equal(migratedText, legacyText, "SQLite load must not serve the block summary as its content");
});

