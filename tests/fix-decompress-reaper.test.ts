import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { getSession } from "../src/session.ts";

function makeCtx(tag: string) {
    const core = createCore();
    const config = defaultConfig(200000) as Config;
    const session = getSession(`fix-${tag}-${Math.random().toString(36).slice(2)}`);
    return { core, config, session };
}

function buildLargeBlock(tag: string, bodySize: number) {
    const { core, config, session } = makeCtx(tag);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({
            id: `h_${tag}_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${String(i + 1).padStart(5, "0")}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(2000)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: `Compressed range for ${tag}: initial setup and baseline testing.` }] }), ctx as never);
    const blockId = [...session.state.blocks].slice(-1)[0]?.blockId;
    assert.ok(blockId, "block created");
    const big = "x".repeat(bodySize);
    session.blockContents.set(blockId!, { one: { text: big, count: 1 }, full: { text: big, count: 1 } });
    return { ctx, blockId: blockId! };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("resolveDecompress reaper: caps tracked temp files, unlinks oldest", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-reap-"));
    const prevTmpdir = process.env.TMPDIR;
    const prevCap = process.env.BILI_DECOMPRESS_TMP_CAP;
    process.env.TMPDIR = scratch;
    process.env.BILI_DECOMPRESS_TMP_CAP = "3";
    try {
        const written: string[] = [];
        for (let i = 0; i < 5; i++) {
            const { ctx, blockId } = buildLargeBlock(`r${i}`, 11000);
            const out = resolveDecompress({ blockId }, ctx);
            const m = out.match(/written to: (.+)$/m);
            assert.ok(m, `iteration ${i} should spill to temp file`);
            written.push(m![1]);
            await sleep(2);
        }
        const remaining = fs.readdirSync(scratch).filter((f) => f.startsWith("acp-decompress-"));
        assert.ok(remaining.length <= 3, `reaper should keep <= cap(3) files, got ${remaining.length}`);
        assert.ok(!fs.existsSync(written[0]), "oldest temp file should be reaped");
        assert.ok(!fs.existsSync(written[1]), "2nd oldest temp file should be reaped");
        assert.ok(fs.existsSync(written[2]), "3rd file should survive");
        assert.ok(fs.existsSync(written[3]), "4th file should survive");
        assert.ok(fs.existsSync(written[4]), "5th file should survive");
    } finally {
        if (prevTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prevTmpdir;
        if (prevCap === undefined) delete process.env.BILI_DECOMPRESS_TMP_CAP;
        else process.env.BILI_DECOMPRESS_TMP_CAP = prevCap;
        try {
            for (const f of fs.readdirSync(scratch)) fs.unlinkSync(path.join(scratch, f));
            fs.rmdirSync(scratch);
        } catch {}
    }
});
