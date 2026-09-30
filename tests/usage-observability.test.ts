import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyUsageSample } from "../src/plugin.ts";
import { buildSessionCacheReport } from "../src/cache-ledger.ts";
import { setLogCapture } from "../src/logger.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeSession(): Session {
    return {
        id: "usage-obs-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function makeCtx(messages: CoreMessage[]): Ctx {
    const logs: string[] = [];
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    const session = makeSession();
    session.state.messageRefs = res.map;
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session,
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

const COMPRESS_ARGS = { content: [{ startId: "m00001", endId: "m00002", summary: "USAGE-OBS-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] };

function captureLogs<T>(fn: () => T): { lines: string[]; result: T } {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    try {
        const result = fn();
        return { lines, result };
    } finally {
        setLogCapture(null);
    }
}

test("#695: applyRanges marks the next request as fold-materializing and logs the anchor ceiling", () => {
    const ctx = makeCtx([
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ]);
    ctx.session.stats.lastInputTokens = 100000;
    const out = applyRanges(parseCompressInput(COMPRESS_ARGS), ctx);
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out}`);
    assert.equal(ctx.session.stats.pendingFoldUsage, true, "flag set for the fold-materializing request");
    const obs = ctx.logs.find((l) => l.includes("[acp-compress-obs]"));
    assert.ok(obs, "observability line logged");
    assert.ok(obs!.includes("anchor≈"), `anchor estimate present: ${obs}`);
    assert.ok(obs!.includes("active blocks"), `block count present: ${obs}`);
    assert.ok(obs!.includes("postCtx≈"), `post-fold context present: ${obs}`);
    assert.ok(obs!.includes("ceiling ≥"), `cache ceiling present: ${obs}`);
});

test("#695: applyUsageSample logs a per-request [acp-usage] line and consumes the fold flag", () => {
    const session = makeSession();
    session.stats.pendingFoldUsage = true;
    const { lines } = captureLogs(() => applyUsageSample(session, { inputTokens: 50000, cachedTokens: 8000, outputTokens: 100 }, "openai"));
    const line = lines.find((l) => l.includes("[acp-usage]"));
    assert.ok(line, `[acp-usage] logged: ${lines}`);
    assert.ok(line!.includes("input=50000"), `input present: ${line}`);
    assert.ok(line!.includes("cached=8000"), `cached present: ${line}`);
    assert.ok(line!.includes("(cache hit 16%)"), `hit pct present: ${line}`);
    assert.ok(line!.includes("fold=new"), `fold marker on the materializing request: ${line}`);
    assert.equal(session.stats.pendingFoldUsage, false, "flag consumed after the report");
});

test("#695: subsequent usage lines carry no fold marker", () => {
    const session = makeSession();
    const { lines } = captureLogs(() => {
        applyUsageSample(session, { inputTokens: 50000, cachedTokens: 8000, outputTokens: 100 }, "openai");
        applyUsageSample(session, { inputTokens: 52000, cachedTokens: 51000, outputTokens: 100 }, "openai");
    });
    const line = lines.filter((l) => l.includes("[acp-usage]"));
    assert.equal(line.length, 2, `two lines: ${lines}`);
    assert.ok(!line[1].includes("fold=new"), `no stale marker: ${line[1]}`);
});

test("#695: missing cached field logs no-cache-report without a hit percentage", () => {
    const session = makeSession();
    const { lines } = captureLogs(() => applyUsageSample(session, { inputTokens: 50000, outputTokens: 100 }, "openai"));
    const line = lines.find((l) => l.includes("[acp-usage]"));
    assert.ok(line, `logged: ${lines}`);
    assert.ok(line!.includes("(no cache report)"), `marker present: ${line}`);
    assert.ok(!line!.includes("cache hit"), `no hit pct when cached unknown: ${line}`);
});

test("#1536: plugin pipe quarantines missing cached tokens instead of booking a 0% miss", () => {
    const session = makeSession();
    session.id = "q-plugin-" + process.pid;
    captureLogs(() => {
        applyUsageSample(session, { inputTokens: 100000, cachedTokens: 90000, outputTokens: 10 }, "openai", "https://a.example");
        for (let i = 0; i < 3; i++) {
            applyUsageSample(session, { inputTokens: 100000, outputTokens: 10 }, "openai", "https://a.example");
        }
    });
    const r = buildSessionCacheReport(session);
    assert.equal(r.unmeasured.samples, 3, "unmeasured samples counted");
    assert.equal(r.unmeasured.inputTokens, 300000, "unmeasured input excluded from closure");
    assert.equal(r.totals.input, 100000, "closure totals cover the measurable subset only");
    assert.equal(r.totals.cached, 90000);
    assert.equal(r.totals.residual, 0, "kernel identity still closes exactly");
    assert.equal(r.totals.balanced, true);
});

test("#1536: non-reporting provider never trips the collapse watch via the plugin pipe", () => {
    const session = makeSession();
    session.id = "collapse-suppress-" + process.pid;
    const { lines } = captureLogs(() => {
        applyUsageSample(session, { inputTokens: 100000, cachedTokens: 95000, outputTokens: 10 }, "openai");
        for (let i = 0; i < 6; i++) {
            applyUsageSample(session, { inputTokens: 100000, outputTokens: 10 }, "openai");
        }
    });
    assert.ok(!lines.some((l) => l.includes("prompt-cache collapse")), `no false-positive collapse warning: ${lines}`);
});

test("#1536: plugin-pipe usage carries wire/upstream identity into the invalidation buckets", () => {
    const session = makeSession();
    session.id = "wire-up-plugin-" + process.pid;
    captureLogs(() => {
        applyUsageSample(session, { inputTokens: 100000, cachedTokens: 90000, outputTokens: 10 }, "anthropic", "https://a.example");
        applyUsageSample(session, { inputTokens: 100000, cachedTokens: 0, outputTokens: 10 }, "openai", "https://a.example");
        applyUsageSample(session, { inputTokens: 100000, cachedTokens: 0, outputTokens: 10 }, "openai", "https://b.example");
    });
    const r = buildSessionCacheReport(session);
    assert.equal(r.wireSwitches.count, 1, `wire switch flagged: ${JSON.stringify(r.wireSwitches)}`);
    assert.equal(r.upstreamSwitches.count, 1, `upstream switch flagged: ${JSON.stringify(r.upstreamSwitches)}`);
    assert.equal(r.modelSwitches.count, 0, "model bucket untouched without lastModel");
});
