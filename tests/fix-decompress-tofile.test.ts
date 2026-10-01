// #1691: `toFile` was documented in the decompress schema/prompt but never read
// (every restore went to os.tmpdir() gated only by body size). Pins the honored
// behavior: explicit destination wins regardless of size, relative paths resolve
// against the proxy cwd, malformed values warn + fall back, default unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { drainPendingRetrievals, storeEffectiveCcr } from "../src/store.ts";
import { getSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";

process.env.BILI_PERSIST = "0";

const pad = (n: number): string => String(n).padStart(5, "0");

/** Fold m00001–m{endRef}. The kernel refuses a fold whose summary is < 50 chars
 *  or whose span sits inside the protected recent-window (last 5 msgs) — so the
 *  summary stays long and count=endRef+8 keeps the span older than the last 5.
 *  Stored body ≈ 1KB/msg: endRef=4 → ~4K (inline by default); endRef=8 → ~12K
 *  (past the 10000-char auto-tmpdir gate). */
function foldBlock(tag: string, endRef: number, log?: (msg: string) => void) {
    const count = endRef + 8;
    const core = createCore();
    const config = defaultConfig(200_000) as Config;
    const session = getSession(`tf-${tag}-${Math.random().toString(36).slice(2)}`);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < count; i++) {
        msgs.push({
            id: `h_${tag}_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(2000)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: log ?? (() => {}) };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: `m${pad(endRef)}`, summary: `Folded span ${tag}: initial setup, baseline notes, and configuration details for messages 0-${endRef - 1} of the compression pipeline.` }] }), ctx);
    const blockId = [...session.state.blocks].slice(-1)[0]?.blockId!;
    return { ctx, session, blockId };
}

test("#1691 whole-block toFile: a small restore (would be inline) writes to the requested path", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-tofile-"));
    try {
        const { ctx, session, blockId } = foldBlock("s", 4);
        const target = path.join(scratch, "nested", "small-restore.txt");
        const out = resolveDecompress({ blockId, toFile: target }, ctx);
        assert.ok(fs.existsSync(target), "file created at the exact requested path (nested dirs created)");
        assert.match(out, /written to: /);
        assert.ok(out.includes(target), "ack references the caller path");
        assert.doesNotMatch(out, /Historical detail 0\./, "body NOT inlined into the ack");
        assert.doesNotMatch(out, /Re-fold:/, "no refold hint on the file path");
        const disk = fs.readFileSync(target, "utf8");
        assert.match(disk, /Historical detail 0\./, "folded content present in the file");
        assert.doesNotMatch(disk, /Historical detail 9\./, "messages outside the folded span are not written");
        const block = session.state.blocks.find((b) => b.blockId === blockId);
        assert.notEqual(block?.restoredInline, true, "toFile path does not flag restoredInline");
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test("#1691 whole-block toFile: a large restore targets the caller path, not os.tmpdir()", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-tofile-"));
    try {
        const { ctx, blockId } = foldBlock("l", 8);
        const target = path.join(scratch, "large-restore.txt");
        const out = resolveDecompress({ blockId, toFile: target }, ctx);
        assert.ok(fs.existsSync(target), "file created at the caller path");
        assert.ok(out.includes(target), "ack points at the caller path");
        assert.doesNotMatch(out, /acp-decompress-/, "not the auto tmpdir spill name");
        const disk = fs.readFileSync(target, "utf8");
        assert.match(disk, /Historical detail 0\./, "folded content present in the file");
        assert.doesNotMatch(disk, /Historical detail 13\./, "messages outside the folded span are not written");
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test("#1691 default unchanged: no toFile leaves a small restore inline (no file)", () => {
    const prevTmp = process.env.TMPDIR;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-tofile-none-"));
    process.env.TMPDIR = scratch;
    try {
        const { ctx, blockId } = foldBlock("n", 4);
        const out = resolveDecompress({ blockId }, ctx);
        assert.doesNotMatch(out, /written to:/, "small body inlines, no file");
        assert.match(out, /Historical detail 0\./, "inline body present");
        const files = fs.readdirSync(scratch).filter((f) => f.startsWith("acp-decompress-"));
        assert.equal(files.length, 0, "no temp file created for an inline restore");
    } finally {
        if (prevTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prevTmp;
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test("#1691 malformed toFile (non-string) warns once and falls back to the default output", () => {
    const logs: string[] = [];
    const { ctx, blockId } = foldBlock("m", 4, (msg) => logs.push(msg));
    const out = resolveDecompress({ blockId, toFile: 12345 }, ctx);
    assert.match(out, /Historical detail 0\./, "fell back to inline (small body)");
    assert.doesNotMatch(out, /written to:/);
    assert.ok(logs.some((l) => l.includes("toFile must be a string")), `expected a warning, got: ${JSON.stringify(logs)}`);
});

test("#1691 relative toFile resolves against the proxy cwd", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-tofile-rel-"));
    const prevCwd = process.cwd();
    try {
        process.chdir(scratch);
        const { ctx, blockId } = foldBlock("r", 4);
        const out = resolveDecompress({ blockId, toFile: "rel-restore.txt" }, ctx);
        const resolved = path.join(scratch, "rel-restore.txt");
        assert.ok(fs.existsSync(resolved), "relative path created under cwd");
        assert.ok(out.includes(resolved), "ack reports the resolved absolute path");
    } finally {
        process.chdir(prevCwd);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

/** CCR-armed fold mirroring tests/ccr-v2.test.ts so range restore is available. */
function foldCcr() {
    const core = createCore();
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { absorb: { enabled: true, minToolTokens: 50 }, ccr: { enabled: true, minToolTokens: 50 } },
    ) as Config;
    const session = getSession(`tfrange-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    const raw: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
        raw.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(2000)}`,
        });
    }
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active)!;
    return { core, config, session, msgs: turn.messages, blockId: block.blockId };
}

test("#1691 range toFile: writes the span to the caller path and queues only a lean pointer", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-tofile-range-"));
    try {
        const f = foldCcr();
        const ctx = { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
        const target = path.join(scratch, "span.txt");
        const ack = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004", toFile: target }, ctx);
        assert.match(ack, /restored 3 item\(s\)/);
        assert.ok(fs.existsSync(target), "span written to the caller path");
        const disk = fs.readFileSync(target, "utf8");
        assert.match(disk, /Historical detail 1\./);
        assert.match(disk, /Historical detail 3\./);
        assert.doesNotMatch(disk, /Historical detail 4\./, "span upper bound excluded");
        const injs = drainPendingRetrievals(f.session);
        assert.equal(injs.length, 1, "one ephemeral injection queued");
        assert.ok(injs[0]!.text!.includes(target), "queued injection points at the file");
        assert.doesNotMatch(injs[0]!.text!, /Historical detail 1\./, "full body NOT injected (lean pointer keeps context flat)");
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
