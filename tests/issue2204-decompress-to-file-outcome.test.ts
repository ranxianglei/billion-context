// #2204: decompress's toFile export treated a host virtual URI (OMP's
// "local://…") as a plain disk path (mkdir ENOENT under a "local:" dir), and
// every export-failure site returned a success-shaped result — the endpoint
// reported outcome:"success", so hosts rendered isError:false for an export
// that never happened. This suite pins:
//   1. unsupported URI schemes are refused BEFORE any fs operation (nothing
//      created); file:// URIs resolve to the right place; single-letter
//      "schemes" stay drive letters, never URIs;
//   2. mkdir/write failures return toolFail receipts (outcome:"failure") at
//      every entry point — whole-block toFile, whole-block tmp spill, range
//      toFile, range tmp spill — with the preview labeled partial and the
//      original block undamaged;
//   3. the default tmp spill still succeeds with a pointer-only ack;
//   4. propagation: handlePluginTool reports outcome:"failure" and
//      shared.forwardTool maps it (plus "refused") to failed:true.
import { afterEach, beforeEach, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { drainPendingRetrievals, storeEffectiveCcr } from "../src/store.ts";
import { getSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginTool } from "../src/plugin.ts";
import { forwardTool } from "../src/agent/shared.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST = "0";

const pad = (n: number): string => String(n).padStart(5, "0");

/** Fold m00001–m{endRef}. Kernel refuses folds whose summary is < 50 chars or
 *  whose span sits inside the protected recent-window — long summary plus
 *  count=endRef+8 keeps the span older than the last 5. Stored body ≈
 *  msgChars/msg: endRef=4 & 2000 → ~8K (past the 4000-char preview cap);
 *  endRef=8 → ~16K (past the 10000-char auto-tmpdir gate). */
function foldBlock(tag: string, endRef: number, msgChars: number = 2000, log?: (msg: string) => void) {
    const count = endRef + 8;
    const core = createCore();
    const config = defaultConfig(200_000) as Config;
    const session = getSession(`tf2204-${tag}-${Math.random().toString(36).slice(2)}`);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < count; i++) {
        msgs.push({
            id: `h_${tag}_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(msgChars)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: log ?? (() => {}) };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: `m${pad(endRef)}`, summary: `Folded span ${tag}: initial setup, baseline notes, and configuration details for messages 0-${endRef - 1} of the compression pipeline.` }] }), ctx);
    const blockId = [...session.state.blocks].slice(-1)[0]?.blockId!;
    return { ctx, session, blockId };
}

/** CCR-armed fold mirroring tests/ccr-v2.test.ts so range restore is available. */
function foldCcr() {
    const core = createCore();
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { absorb: { enabled: true, minToolTokens: 50 }, ccr: { enabled: true, minToolTokens: 50 } },
    ) as Config;
    const session = getSession(`tfr2204-${Math.random().toString(36).slice(2)}`);
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

test("#2204 whole-block toFile: an unsupported virtual URI is refused BEFORE any file operation", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2204-uri-"));
    const prevCwd = process.cwd();
    process.chdir(scratch);
    try {
        const logs: string[] = [];
        const { ctx, blockId } = foldBlock("uri", 4, 2000, (msg) => logs.push(msg));
        const out = resolveDecompress({ blockId, toFile: "local://bili-investigation-b2.txt" }, ctx);
        assert.equal(out.outcome, "failure", "a refused destination is a business failure, not success");
        assert.ok(out.text.startsWith("[decompress FAILED:"), `receipt: ${out.text.slice(0, 120)}`);
        assert.match(out.text, /unsupported virtual URI scheme "local"/);
        assert.match(out.text, /actual filesystem path/, "the remedy names what to pass instead");
        assert.deepEqual(fs.readdirSync(scratch), [], "NO directory or file was created for the virtual URI");
        assert.ok(logs.some((l) => l.includes("refused before any file operation")), "the refusal is logged");
        // The original block is undamaged: an inline restore right after still works.
        const again = resolveDecompress({ blockId }, ctx);
        assert.equal(again.outcome, "success");
        assert.match(again.text, /Historical detail 0\./);
        assert.doesNotMatch(again.text, /FAILED/);
    } finally {
        process.chdir(prevCwd);
        rmrf(scratch);
    }
});

test("#2204 whole-block toFile: a file:// URI resolves to the correct path", { skip: process.platform === "win32" ? "file:// path semantics differ on Windows" : false }, () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2204-fileuri-"));
    try {
        const { ctx, blockId } = foldBlock("furi", 4);
        const target = path.join(scratch, "via-file-uri.txt");
        const out = resolveDecompress({ blockId, toFile: `file://${target}` }, ctx);
        assert.equal(out.outcome, "success");
        assert.ok(fs.existsSync(target), "written at the resolved location");
        assert.match(out.text, /written to: /);
        assert.match(fs.readFileSync(target, "utf8"), /Historical detail 0\./);
    } finally {
        rmrf(scratch);
    }
});

test("#2204 whole-block toFile: a single-letter \"scheme\" is a drive letter, not a URI", { skip: process.platform === "win32" ? "would touch the real C: drive on Windows" : false }, () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2204-drv-"));
    const prevCwd = process.cwd();
    process.chdir(scratch);
    try {
        const { ctx, blockId } = foldBlock("drv", 4);
        const out = resolveDecompress({ blockId, toFile: "C://weird.txt" }, ctx);
        assert.equal(out.outcome, "success", "C://x keeps its legacy plain-path treatment");
        assert.doesNotMatch(out.text, /unsupported virtual URI scheme/);
        assert.match(out.text, /written to: /);
    } finally {
        process.chdir(prevCwd);
        rmrf(scratch);
    }
});

test("#2204 whole-block toFile write failure → outcome:failure, labeled partial preview, block undamaged", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2204-wf-"));
    try {
        // A regular file where a directory must be created → mkdir throws
        // deterministically (ENOTDIR/EEXIST) on every platform. endRef=6 folds
        // 4 refs (the kernel's recent-zone trims the span tail) → body ≈ 8.3K:
        // past the 4000-char preview cap (partial label) yet under the 10000
        // auto-tmpdir gate, so the no-toFile retry restores INLINE.
        const blocker = path.join(scratch, "blocker");
        fs.writeFileSync(blocker, "x");
        const { ctx, session, blockId } = foldBlock("wf", 6);
        const before = session.stats.wholeBlockRestores ?? 0;
        const out = resolveDecompress({ blockId, toFile: path.join(blocker, "nested", "out.txt") }, ctx);
        assert.equal(out.outcome, "failure", "a write failure must carry the failure outcome (#2204)");
        assert.ok(out.text.startsWith("[decompress FAILED:"), `receipt: ${out.text.slice(0, 120)}`);
        assert.match(out.text, /could not write export to/);
        assert.match(out.text, /did NOT complete/, "the receipt must not read like a completed export");
        assert.match(out.text, /partial content follows \(\d+ of \d+ chars\)/, "truncated preview is labeled with shown/total");
        assert.match(out.text, /Historical detail 0\./, "the preview carries real content");
        assert.doesNotMatch(out.text, /written to:/);
        assert.equal(session.stats.wholeBlockRestores, before + 1, "attempt telemetry unchanged");
        // Retry without toFile: the block is fully intact.
        const again = resolveDecompress({ blockId }, ctx);
        assert.equal(again.outcome, "success");
        assert.match(again.text, /Historical detail 0\./);
    } finally {
        rmrf(scratch);
    }
});

test("#2204 range toFile write failure with a small span labels the preview as FULL, not partial", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2204-rwfs-"));
    try {
        const blocker = path.join(scratch, "blocker");
        fs.writeFileSync(blocker, "x");
        // Whole-block bodies always clear the kernel's 5000-char min-compress
        // threshold, so only a sub-block RANGE span can land under the 4000
        // preview cap. One message ≈ 2K chars → "full content follows".
        const f = foldCcr();
        const ctx = { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
        const out = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00002", toFile: path.join(blocker, "span.txt") }, ctx);
        assert.equal(out.outcome, "failure");
        assert.match(out.text, /full content follows/, "span under the preview cap is not called partial");
        assert.doesNotMatch(out.text, /partial content follows/);
    } finally {
        rmrf(scratch);
    }
});

test("#2204 default unchanged: an over-length restore without toFile still spills to a tracked tmp file (pointer only)", () => {
    const prevTmp = process.env.TMPDIR;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2204-spill-"));
    process.env.TMPDIR = scratch;
    try {
        const { ctx, blockId } = foldBlock("spill", 8);
        const out = resolveDecompress({ blockId }, ctx);
        assert.equal(out.outcome, "success");
        assert.match(out.text, /Content \(\d+ chars\) written to: /);
        const m = out.text.match(/written to: (.+)\n/s);
        assert.ok(m, `ack: ${out.text.slice(0, 200)}`);
        assert.ok(fs.existsSync(m[1]!), "spilled file exists");
        assert.match(fs.readFileSync(m[1]!, "utf8"), /Historical detail 0\./);
        assert.doesNotMatch(out.text, /Historical detail 0\./, "body NOT inlined into the ack");
    } finally {
        if (prevTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prevTmp;
        rmrf(scratch);
    }
});

test("#2204 range toFile: an unsupported virtual URI fails without queueing an injection or counting a restore", () => {
    const f = foldCcr();
    const ctx = { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
    const before = f.session.stats.rangeRestores ?? 0;
    const out = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004", toFile: "local://span.txt" }, ctx);
    assert.equal(out.outcome, "failure");
    assert.match(out.text, /unsupported virtual URI scheme "local"/);
    assert.equal(drainPendingRetrievals(f.session).length, 0, "a failed export queues NO ephemeral injection");
    assert.equal(f.session.stats.rangeRestores ?? 0, before, "no restore counted for a failed export");
    // Retry without toFile restores normally — the block/span is undamaged.
    const ok = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctx);
    assert.equal(ok.outcome, "success");
    assert.match(ok.text, /restored 3 item\(s\)/);
    assert.equal(drainPendingRetrievals(f.session).length, 1);
});

test("#2204 range toFile write failure → outcome:failure, no injection, block undamaged", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2204-rwf-"));
    try {
        const blocker = path.join(scratch, "blocker");
        fs.writeFileSync(blocker, "x");
        const f = foldCcr();
        const ctx = { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
        const out = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004", toFile: path.join(blocker, "span.txt") }, ctx);
        assert.equal(out.outcome, "failure");
        assert.match(out.text, /could not write export to/);
        assert.match(out.text, /did NOT complete/);
        assert.equal(drainPendingRetrievals(f.session).length, 0, "no fake user-role injection for content that was never delivered");
        const ok = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctx);
        assert.equal(ok.outcome, "success");
        assert.match(ok.text, /restored 3 item\(s\)/);
    } finally {
        rmrf(scratch);
    }
});

test("#2204 endpoint: a failed export answers ok:true + outcome:failure (and success stays outcome:success)", async () => {
    _resetPluginStateForTest();
    const core = createCore();
    const config = defaultConfig(200_000) as Config;
    const session = getSession(`t2204-ep-${Math.random().toString(36).slice(2)}`);
    const msgs: CoreMessage[] = [];
    // The kernel's recent-zone trims the span tail and its min-compress
    // threshold (5000 chars) applies to what SURVIVES the trim — endRef=6 at
    // ~2K chars/message folds 4 refs ≈ 8.3K, clearing both gates.
    for (let i = 0; i < 14; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nEndpoint detail ${i}. ${"y".repeat(2000)}`,
        });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00006", summary: "Endpoint span: initial setup and baseline notes for messages 0-5." }] }), ctx);
    const blockId = [...session.state.blocks].slice(-1)[0]?.blockId!;

    const deps: PluginToolDeps = { core, config: defaultConfig(400_000), log: () => {} };
    function call(args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
        let body = "";
        let status = 0;
        const res = {
            writeHead: (code: number) => { status = code; return undefined; },
            end: (chunk: unknown) => { body = String(chunk ?? ""); },
        } as unknown as http.ServerResponse;
        return Promise.resolve(handlePluginTool(JSON.stringify({ conversationId: session.id, tool: "decompress", args }), res, deps))
            .then(() => ({ status, json: JSON.parse(body) as Record<string, unknown> }));
    }

    const fail = await call({ blockId, toFile: "local://endpoint-export.txt" });
    assert.equal(fail.status, 200);
    assert.equal(fail.json.ok, true, "ok keeps meaning transport + execution");
    assert.equal(fail.json.outcome, "failure", "#2204: the business effect rides outcome");
    assert.ok(String(fail.json.result).startsWith("[decompress FAILED:"), `receipt: ${String(fail.json.result).slice(0, 120)}`);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2204-ep-"));
    try {
        const okPath = path.join(scratch, "ep-ok.txt");
        const good = await call({ blockId, toFile: okPath });
        assert.equal(good.status, 200);
        assert.equal(good.json.ok, true);
        assert.equal(good.json.outcome, "success");
        assert.ok(fs.existsSync(okPath), "resolvable destinations still succeed through the endpoint");
    } finally {
        rmrf(scratch);
    }
});

describe("#2204 shared.forwardTool maps the business outcome to failed", () => {
    let origin = "";
    let server: http.Server | null = null;
    let canned: Record<string, unknown> = {};

    beforeEach(async () => {
        canned = {};
        server = http.createServer((req, res) => {
            if (req.url !== "/__bili/plugin/tool") { res.writeHead(404).end("nope"); return; }
            let raw = "";
            req.on("data", (d) => { raw += d; });
            req.on("end", () => {
                const parsed = JSON.parse(raw) as { tool?: string };
                const payload = canned[parsed.tool ?? ""] ?? { ok: false, error: "unexpected tool" };
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
            });
        });
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        origin = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
        if (server) await new Promise<void>((r) => server!.close(() => r()));
        server = null;
    });

    it("outcome:failure → failed:true with the full receipt text", async () => {
        canned.decompress = { ok: true, result: "[decompress FAILED: could not write export to /x: ENOENT]", outcome: "failure" };
        const out = await forwardTool(origin, "conv-1", "decompress", { blockId: "b2", toFile: "local://x.txt" });
        assert.equal(out.failed, true, "the host must be able to set isError from this");
        assert.equal(out.text, "[decompress FAILED: could not write export to /x: ENOENT]");
    });

    it("outcome:refused → failed:true (same mapping as mcp.ts)", async () => {
        canned.compress = { ok: true, result: "[Compression FAILED: range protected]", outcome: "refused", blocksCreated: 0 };
        const out = await forwardTool(origin, "conv-1", "compress", { content: [] });
        assert.equal(out.failed, true);
    });

    it("outcome:success and legacy envelopes (no outcome) → failed:false", async () => {
        canned.acp_status = { ok: true, result: "CONTEXT STATUS", outcome: "success" };
        assert.equal((await forwardTool(origin, "conv-1", "acp_status", {})).failed, false);
        canned.acp_status = { ok: true, result: "LEGACY STATUS" };
        const legacy = await forwardTool(origin, "conv-1", "acp_status", {});
        assert.equal(legacy.failed, false, "an old proxy without the field degrades to pre-#2204 rendering");
        assert.equal(legacy.text, "LEGACY STATUS");
    });

    it("hard error envelopes still throw", async () => {
        canned.acp_cache = { ok: false, error: "boom" };
        await assert.rejects(() => forwardTool(origin, "conv-1", "acp_cache", {}), /boom/);
    });
});
