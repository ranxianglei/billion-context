import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, createCore, createInitialState, assignRefs, emptyRefMap } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { handleAcpStatus } from "../src/acp-status.ts";

// #5021: acp_status printed an absolute `BILLED INPUT … tok` with no
// denominator, and the kernel's `COMPRESSED BLOCKS — … original` header reads
// like current occupancy. An agent that cannot see the route's window therefore
// has no way to answer "how much context is left" — one measured incident
// reported "context exhausted" at 116,902 / 1,000,000 tok (11.7%) and stopped
// mid-task. These tests pin the occupancy anchor that removes the guesswork.

interface CtxOverrides {
    lastInputTokens?: number;
    source?: string;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeCtx(limit: number, messages: CoreMessage[], o?: CtxOverrides): {
    core: ReturnType<typeof createCore>;
    config: ReturnType<typeof defaultConfig>;
    messages: CoreMessage[];
    session: Session;
} {
    return {
        core: createCore(),
        config: defaultConfig(limit),
        messages,
        session: {
            id: "i5021-ctx",
            meta: {},
            stats: {
                requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0,
                lastInputTokens: o?.lastInputTokens ?? 0,
                ...(o?.source !== undefined ? { lastInputTokensSource: o.source as never } : {}),
                compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0,
                storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0,
            },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        } as unknown as Session,
    };
}

function asciiMsgs(count: number, charsPerMsg: number): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= count; i++) msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(charsPerMsg)));
    return msgs;
}

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

// 12 × 4000 ASCII chars → est-view total exactly 12000 tok (chars/4).
const MSGS = () => asciiMsgs(12, 4000);

test("#5021: acp_status prints an occupancy anchor (used / limit / % / remaining) beside BILLED INPUT", () => {
    const ctx = withRefs(makeCtx(200000, MSGS(), { lastInputTokens: 30000, source: "usage" }));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(out.includes("BILLED INPUT (upstream usage): 30000 tok"), `billed line present (got: ${out.slice(0, 400)})`);
    assert.ok(
        out.includes("CONTEXT: 30000 / 200000 tok used (15.0%) · 170000 tok remaining"),
        `occupancy anchor rendered (got: ${out.slice(0, 600)})`,
    );
});

test("#5021: no usage-grade anchor → no CONTEXT line either (never invent occupancy)", () => {
    const ctx = withRefs(makeCtx(200000, MSGS(), {}));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(!out.includes("BILLED INPUT"), "no billed anchor → no BILLED line");
    assert.ok(!out.includes("CONTEXT:"), "no billed anchor → no CONTEXT line");
});

test("#5021: an over-limit reading clamps remaining at 0 instead of printing a negative budget", () => {
    const ctx = withRefs(makeCtx(200000, MSGS(), { lastInputTokens: 250000, source: "usage" }));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(out.includes("CONTEXT: 250000 / 200000 tok used (125.0%) · 0 tok remaining"), `over-limit anchor (got: ${out.slice(0, 600)})`);
});

test("#5021: a non-positive limit prints no anchor (guarded, not NaN)", () => {
    const ctx = withRefs(makeCtx(0, MSGS(), { lastInputTokens: 30000, source: "usage" }));
    const out = handleAcpStatus({}, ctx).text;
    assert.ok(!out.includes("CONTEXT:"), "limit <= 0 → no CONTEXT line");
    assert.ok(!out.includes("NaN"), "no NaN leaks into the report");
});
