// #1029 regressions:
// ② no-valid-ranges failure must be self-contained on ONE line (the ❌
//    visibility marker keeps only line 1 — the old multi-line "Rejected
//    entries:" list reached clients as a dangling header with no items) and
//    repeated identical malformed calls must escalate via the repeat-failure
//    guard (previously parse failures bypassed it entirely).
// ③ zero-block rejections must inline the current session's ref span so stale
//    refs from a previous session generation are actionable without an
//    acp_status round-trip.
// ① incoming full-history resends must be stripped of ACP status marker lines
//    before projection (markers are ephemeral proxy status, not conversation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { buildVisibilityMarker } from "../src/loop/core.ts";
import { stripAcpStatusMarkers } from "../src/acp-panel.ts";

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue1029-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function makeCtx(messages: CoreMessage[]): RewriteCtx & { session: Session } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: defaultConfig(200000), messages, session, log: () => {} };
}

test("#1029-②: no-valid-ranges failure is self-contained on line 1 (no dangling 'Rejected entries:' header)", () => {
    const ctx = makeCtx([
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ]);
    const out = applyRanges(
        parseCompressInput({ content: [{ summary: "no bounds" }, { startId: "m00001", endId: "m00002" }] }),
        ctx,
    );
    assert.ok(out.startsWith("[Compression FAILED"), `expected failure, got: ${out}`);
    assert.equal(out.split("\n").length, 1, `failure must be single-line, got: ${JSON.stringify(out)}`);
    assert.match(out, /Rejected entries: entry 0: missing range bounds/, "reason 0 inlined");
    assert.match(out, /entry 1: missing summary/, "reason 1 inlined");
    const marker = buildVisibilityMarker("compress", out);
    assert.match(marker, /❌ \[ACP\] Compression FAILED.*Rejected entries: entry 0:/, "marker carries the complete failure");
});

test("#1029-②: repeated identical malformed calls escalate via the repeat-failure guard", () => {
    const ctx = makeCtx([textMsg("raw_1", "assistant", "a".repeat(800))]);
    const bad = () => applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002" }] }), ctx);
    const first = bad();
    assert.ok(first.startsWith("[Compression FAILED"), first);
    assert.ok(!first.includes("Repeat-failure guard"), "first attempt has no escalation");
    const second = bad();
    assert.match(second, /Repeat-failure guard/);
    assert.match(second, /2 time\(s\)/);
});

test("#1029-③: zero-block rejection inlines the current ref span (stale refs from another generation)", () => {
    // Fresh session instance: refs assigned from m00001 (post-restart/fork
    // generation). The model still carries refs from the PREVIOUS generation
    // (m00100–m00110 never existed here).
    const msgs = [
        textMsg("raw_1", "assistant", "a".repeat(6000)),
        textMsg("raw_2", "user", "hi"),
        textMsg("raw_3", "assistant", "b".repeat(6000)),
    ];
    const ctx = makeCtx(msgs);
    const out = applyRanges(
        parseCompressInput({ content: [{ startId: "m00100", endId: "m00110", summary: SUMMARY }] }),
        ctx,
    );
    assert.ok(out.startsWith("[Compression FAILED"), `expected failure, got: ${out}`);
    assert.match(out, /\[Current context: 3 visible message\(s\), refs m00001–m00003, \d+ active block\(s\)\./, "current span inlined");
    assert.match(out, /refs inside this span|acp_status/i, "points at actionable refs or acp_status");
});

test("#1029-①: incoming history resends are stripped of ACP status marker lines", () => {
    const msgs: unknown[] = [
        { role: "user", content: "继续|刚刚怎么出问题了？" },
        { role: "assistant", content: "没问题。\n❌ [ACP] Compression FAILED: no valid ranges parsed (kind=no-valid-ranges, dropped=2).\n" },
        { role: "assistant", content: [{ type: "text", text: "📦 [ACP] Compressed m00001–m00010.\nsome real answer" }] },
        { role: "assistant", content: [{ type: "input_text", text: "\n📊 [ACP] acp_status result:\ntotal\n" }] },
        { role: "tool", content: "tool results stay untouched" },
        { role: "user", content: "user quoting [ACP] without an emoji prefix survives" },
    ];
    const n = stripAcpStatusMarkers(msgs);
    assert.equal(n, 3, "three marker lines removed");
    assert.equal((msgs[1] as { content: string }).content, "没问题。\n", "non-marker assistant text preserved");
    assert.equal((msgs[2] as { content: Array<{ text: string }> }).content[0].text, "some real answer", "marker line removed from text part");
    assert.equal((msgs[4] as { content: string }).content, "tool results stay untouched", "tool role untouched");
    assert.equal((msgs[5] as { content: string }).content, "user quoting [ACP] without an emoji prefix survives", "plain [ACP] text survives");
});

test("#1029-①: marker-only messages degrade to a space and are never deleted (tool pairing)", () => {
    const solo: unknown[] = [{ role: "assistant", content: "❌ [ACP] Compression FAILED: x", tool_calls: [{ id: "c1" }] }];
    assert.equal(stripAcpStatusMarkers(solo), 1);
    assert.equal(solo.length, 1, "message kept");
    assert.equal((solo[0] as { content: string }).content, " ", "degraded to a space");
    assert.equal(stripAcpStatusMarkers(null), 0, "non-array input is a no-op");
});
