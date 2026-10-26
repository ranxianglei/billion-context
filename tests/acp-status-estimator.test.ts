import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { executeProxyTool } from "../src/loop/core.ts";

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

// CJK payload: defaultCountTokens counts it ~1:1 while the old
// estimateTokensFast (chars/4) under-counts 4x. Asserting the 1:1 figure
// guards against a regression back to the mixed-scale reporting (#386).
const cjk = (n: number): string => "中".repeat(n);

function cjkToolSession(): { session: Session; messages: CoreMessage[] } {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const messages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: cjk(100) },
        { id: "call-c1", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "c1", text: "{}" },
        { id: "res-c1", role: "user", contentType: "tool-result", toolCallId: "c1", text: cjk(4000) },
        { id: "call-c2", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "c2", text: "{}" },
        { id: "res-c2", role: "user", contentType: "tool-result", toolCallId: "c2", text: cjk(2000) },
    ];
    const turn = core.processTurn({ messages, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    return { session, messages: turn.messages };
}

test("acp_status reports CJK at 1:1 scale (defaultCountTokens, not chars/4) (#386)", () => {
    const { session, messages } = cjkToolSession();
    const ctx = { core: createCore(), config: defaultConfig(200000), messages, session, log: (_msg: string) => {} };
    const out = executeProxyTool("acp_status", {}, ctx).text;
    const line = out.split("\n").find((l) => l.includes(" tool (") && l.includes(" text ("));
    assert.ok(line, `no breakdown line in:\n${out}`);
    assert.ok(line.includes("6.0K tool"), `tool bucket should be ~6000 CJK tokens (1:1), not chars/4: ${line}`);
    const toolPct = Number(/tool \((\d+)%\)/.exec(line)?.[1] ?? -1);
    assert.ok(toolPct >= 95, `tool should dominate: ${line}`);
});

test("acp_status attributes CJK tool-results to their calling tools (#386)", () => {
    const { session, messages } = cjkToolSession();
    const ctx = { core: createCore(), config: defaultConfig(200000), messages, session, log: (_msg: string) => {} };
    const out = executeProxyTool("acp_status", {}, ctx).text;
    const top = out.split("\n").find((l) => l.startsWith("  Top tools:"));
    assert.ok(top, `no Top tools line in:\n${out}`);
    assert.ok(top.includes("bash"), `bash missing: ${top}`);
    assert.ok(top.includes("read"), `read missing: ${top}`);
    const textPct = /text \((\d+)%\)/.exec(top)?.[1];
    assert.ok(!textPct || Number(textPct) <= 5, `text must not dominate Top tools: ${top}`);
});
