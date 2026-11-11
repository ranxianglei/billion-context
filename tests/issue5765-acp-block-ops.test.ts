// #5765: host surface for block retirement / external summary rewrite —
// executeProxyTool dispatch receipts, loop tool classification, and the
// export ledger metadata (messages range, char counts, lifecycle status).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { executeProxyTool } from "../src/loop/core.ts";
import { MUTATING_PROXY_TOOLS, READONLY_PROXY_TOOLS } from "../src/compress-tool.ts";
import { renderHandoff, renderSessionJsonlFromSession } from "../src/export.ts";

const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_STORAGE_UNIFIED", "BILI_ENCRYPTION_KEY"] as const;

function isolate(base: string): Record<string, string | undefined> {
    const snap: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    const sessions = path.join(base, "sessions");
    mkdtempSync(sessions);
    process.env.BILI_SESSIONS_DIR = sessions;
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
    delete process.env.BILI_STORAGE_UNIFIED;
    delete process.env.BILI_ENCRYPTION_KEY;
    return snap;
}

function restore(snap: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title: "block ops" },
        stats: { requests: 1, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: true,
        pendingRetrievals: [],
    };
}

function addBlock(s: Session, blockId: string, opts: { active?: boolean; retired?: boolean; summary?: string; startRef?: string; endRef?: string } = {}): void {
    s.state.blocks.push({
        blockId, runId: "r0", tier: 1, topic: "topic",
        summary: opts.summary ?? `summary body of ${blockId}`,
        directMessageIds: [`m-${blockId}`], effectiveMessageIds: [`m-${blockId}`], directBlockIds: [],
        compressedTokens: 4200, createdAt: Date.now() - 5000, survivedCount: 2, generation: "young",
        active: opts.active ?? true,
        ...(opts.retired ? { retired: true } : {}),
        ...(opts.startRef !== undefined && opts.endRef !== undefined ? { startRef: opts.startRef, endRef: opts.endRef } : {}),
    });
    s.blockContents.set(blockId, { one: null, full: { text: `original text of ${blockId}`, count: 1 } });
}

const ctxOf = (session: Session, blockOpsEnabled = true) => ({
    session,
    config: blockOpsEnabled ? { blockOps: { enabled: true } } : {},
}) as unknown as Parameters<typeof executeProxyTool>[2];

test("acp_retire dispatch: batch ids retire, receipt reports freed chars, state flags set", () => {
    const base = mkdtempSync(path.join(tmpdir(), "issue5765-"));
    const snap = isolate(base);
    try {
        const s = makeSession("t-retire");
        addBlock(s, "b1", { summary: "alpha" });
        addBlock(s, "b2", { summary: "bravo bravo" });
        const r = executeProxyTool("acp_retire", { blockId: "b1", ids: ["b2"] }, ctxOf(s));
        assert.equal(r.outcome, "success");
        assert.ok(r.text.includes("b1, b2 retired"), r.text);
        assert.ok(r.text.includes("~16 summary chars"), `freed chars = 5 + 11 (got: ${r.text})`);
        assert.equal(s.state.blocks[0].retired, true);
        assert.equal(s.state.blocks[1].retired, true);
    } finally {
        restore(snap);
    }
});

test("acp_retire failures: no args / unknown id / malformed id / inactive block", () => {
    const base = mkdtempSync(path.join(tmpdir(), "issue5765-"));
    const snap = isolate(base);
    try {
        const s = makeSession("t-retire-fail");
        addBlock(s, "b1");
        addBlock(s, "b3", { active: false });
        let r = executeProxyTool("acp_retire", {}, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /blockId or ids is required/);
        r = executeProxyTool("acp_retire", { blockId: "b99" }, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /does not exist/);
        r = executeProxyTool("acp_retire", { blockId: "zz" }, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /not a valid block id/);
        r = executeProxyTool("acp_retire", { blockId: "b3" }, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /not active/);
        assert.equal(s.state.blocks[0].retired, undefined, "failures must not flip state");
    } finally {
        restore(snap);
    }
});

test("acp_restore: restores, second call is an honest noop receipt", () => {
    const base = mkdtempSync(path.join(tmpdir(), "issue5765-"));
    const snap = isolate(base);
    try {
        const s = makeSession("t-restore");
        addBlock(s, "b1");
        executeProxyTool("acp_retire", { blockId: "b1" }, ctxOf(s));
        let r = executeProxyTool("acp_restore", { blockId: "b1" }, ctxOf(s));
        assert.equal(r.outcome, "success");
        assert.ok(r.text.includes("b1 restored"), r.text);
        assert.equal(s.state.blocks[0].retired, false);
        r = executeProxyTool("acp_restore", { blockId: "b1" }, ctxOf(s));
        assert.equal(r.outcome, "success");
        assert.ok(r.text.includes("already active"), r.text);
        r = executeProxyTool("acp_restore", {}, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /blockId or ids is required/);
    } finally {
        restore(snap);
    }
});

test("acp_rewrite: single + batch replace in place, previousSummary kept, rejections honest", () => {
    const base = mkdtempSync(path.join(tmpdir(), "issue5765-"));
    const snap = isolate(base);
    try {
        const s = makeSession("t-rewrite");
        addBlock(s, "b1", { summary: "a much longer original summary text" });
        addBlock(s, "b2", { summary: "another long summary here" });
        const oldSummary = s.state.blocks[0].summary;
        let r = executeProxyTool("acp_rewrite", { blockId: "b1", summary: "short" }, ctxOf(s));
        assert.equal(r.outcome, "success");
        assert.ok(r.text.includes(`b1 summary replaced (${oldSummary.length} → 5 chars)`), r.text);
        assert.equal(s.state.blocks[0].summary, "short");
        assert.equal(s.state.blocks[0].previousSummary, oldSummary, "one-step rollback slot");
        assert.ok(typeof s.state.blocks[0].rewrittenAt === "number");
        // identical + blank + unknown rejections
        r = executeProxyTool("acp_rewrite", { blockId: "b1", summary: "short" }, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /identical/);
        r = executeProxyTool("acp_rewrite", { blockId: "b1", summary: "   " }, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /non-empty/);
        r = executeProxyTool("acp_rewrite", { blockId: "b99", summary: "x" }, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /does not exist/);
        r = executeProxyTool("acp_rewrite", {}, ctxOf(s));
        assert.equal(r.outcome, "failure");
        assert.match(r.text, /provide \{ blockId, summary \} or items/);
        // batch via items
        r = executeProxyTool("acp_rewrite", { items: [{ blockId: "b1", summary: "s1" }, { blockId: "b2", summary: "s2" }] }, ctxOf(s));
        assert.equal(r.outcome, "success");
        assert.ok(r.text.includes("b1 summary replaced") && r.text.includes("b2 summary replaced"), r.text);
        assert.equal(s.state.blocks[0].previousSummary, "short", "rollback slot chains one step deep");
        assert.equal(s.state.blocks[1].summary, "s2");
    } finally {
        restore(snap);
    }
});

test("classification: all three are mutating proxy tools, never readonly", () => {
    for (const name of ["acp_retire", "acp_restore", "acp_rewrite"]) {
        assert.ok(MUTATING_PROXY_TOOLS.has(name), `${name} must be mutating`);
        assert.ok(!READONLY_PROXY_TOOLS.has(name), `${name} must not be readonly`);
    }
});

test("opt-in gate: default-off calls get the model-facing not-enabled receipt, no state mutation", () => {
    const base = mkdtempSync(path.join(tmpdir(), "issue5765-"));
    const snap = isolate(base);
    try {
        const s = makeSession("t-gate");
        addBlock(s, "b1", { summary: "alpha" });
        let r = executeProxyTool("acp_retire", { blockId: "b1" }, ctxOf(s, false));
        assert.equal(r.outcome, "success");
        assert.match(r.text, /not enabled on this bili proxy \(compress\.blockOps\.enabled is not true\)/);
        assert.match(r.text, /no blocks were retired/);
        r = executeProxyTool("acp_restore", { blockId: "b1" }, ctxOf(s, false));
        assert.equal(r.outcome, "success");
        assert.match(r.text, /no blocks were restored/);
        r = executeProxyTool("acp_rewrite", { blockId: "b1", summary: "x" }, ctxOf(s, false));
        assert.equal(r.outcome, "success");
        assert.match(r.text, /no summary was rewritten/);
        assert.equal(s.state.blocks[0].retired, undefined, "disabled calls must not touch state");
        assert.equal(s.state.blocks[0].summary, "alpha");
    } finally {
        restore(snap);
    }
});

test("export markdown ledger: ref range, char counts, status; retired listed, consumed excluded", () => {
    const s = makeSession("t-export");
    addBlock(s, "b1", { startRef: "m00001", endRef: "m00003", summary: "alpha" });
    addBlock(s, "b2", { retired: true, summary: "beta" });
    addBlock(s, "b3", { active: false, summary: "gamma" });
    s.blockContents.delete("b2");
    const md = renderHandoff(s, false);
    assert.match(md, /## Block b1 — topic/);
    assert.match(md, /messages m00001–m00003 · original 19 chars · summary 5 chars · active/);
    assert.match(md, /## Block b2 — topic/, "retired block stays listed");
    assert.match(md, /· retired/);
    assert.match(md, /original not cached/, "missing blockContents degrades honestly");
    assert.doesNotMatch(md, /## Block b3/, "consumed block stays excluded (#845 contract)");
});

test("export JSONL: block records carry retired/rewrittenAt/originalChars/summaryChars conditionally", () => {
    const s = makeSession("t-jsonl");
    addBlock(s, "b1", { summary: "alpha" });
    addBlock(s, "b2", { retired: true, summary: "beta" });
    s.state.blocks[0].rewrittenAt = 1234567890;
    const out = renderSessionJsonlFromSession(s, false);
    const rows = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => o.type === "block");
    assert.equal(rows.length, 2);
    const [r1, r2] = rows;
    assert.equal(r1.retired, undefined, "live row omits retired");
    assert.equal(r1.rewrittenAt, 1234567890);
    assert.equal(r1.originalChars, "original text of b1".length);
    assert.equal(r1.summaryChars, 5);
    assert.equal(r2.retired, true);
    assert.equal(r2.rewrittenAt, undefined);
});
