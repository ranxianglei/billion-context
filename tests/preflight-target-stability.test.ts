import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress } from "../src/preflight.ts";
import { createSession } from "../src/session.ts";
import { SessionStore } from "../src/persist.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.ts";
import { rmrf } from "./tmp-rm.ts";

for (const mode of ["unchanged", "equivalent", "direct", "persistence", "covered", "batch-unchanged", "batch-remapped"] as const) test(`summary target stability during ${mode}`, async (t) => {
    const core = createCore();
    const config = defaultConfig(20_000);
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const messages: CoreMessage[] = Array.from({ length: 16 }, (_, i) => ({
        id: `raw-${i + 1}`, role: i % 2 ? "assistant" : "user", contentType: "text",
        text: `ORIGINAL MESSAGE ${i + 1}: ${"unique context and decisions ".repeat(100)}`,
    }));
    const session = createSession("preflight-state-race");
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 15_000, renderTags: "text-only" }).state;
    session.stats.lastInputTokens = 15_000;
    session.stats.requests = 1;
    const first = session.state.messageRefs.byRaw["raw-1"]!;
    const last = session.state.messageRefs.byRaw["raw-4"]!;
    const fresh = createSession(session.id);
    const reordered = [...messages.slice(8), ...messages.slice(0, 8)];
    fresh.state = core.processTurn({ messages: reordered, state: fresh.state, config, tokenCount: 15_000, renderTags: "text-only" }).state;
    fresh.stats.requests = 2;
    fresh.stats.lastInputTokens = 15_000;
    assert.equal(fresh.state.messageRefs.byRef[first], "raw-9");
    assert.equal(fresh.state.messageRefs.byRef[last], "raw-12");
    const covered = core.applyCompression({ messages, state: session.state, config, ranges: [{ startRef: first, endRef: session.state.messageRefs.byRaw["raw-2"], summary: "NEWER SUMMARY: the first two messages have already been folded and their decisions preserved independently." }] }).state;
    assert.ok(covered.blocks.length > 0);
    const equivalent = structuredClone(session.state);
    let calls = 0;
    const staleSummary = "STALE SUMMARY: messages one through four established the original design and all their decisions are retained here.";
    const logs: string[] = [];
    const previousStorage = process.env.BILI_STORAGE_UNIFIED;
    t.after(() => {
        if (previousStorage === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = previousStorage;
    });
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    const dir = mkdtempSync(join(tmpdir(), "preflight-race-"));
    const writer = new SessionStore({ dir, enabled: true });
    await writer.writeNow(fresh);
    writer.closeQuietly();
    const store = new SessionStore({ dir, enabled: true, log: (_level, msg) => logs.push(msg) });
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", async () => {
            calls++;
            if (calls === 1 && (mode === "direct" || mode === "batch-remapped")) session.state = fresh.state;
            if (calls === 1 && mode === "covered") session.state = covered;
            if (calls === 1 && mode === "equivalent") session.state = equivalent;
            if (calls === 1 && mode === "persistence") await store.writeNow(session);
            res.setHeader("content-type", "application/json");
            const summary = calls === 1 ? staleSummary : "Fresh summary of the current span, preserving its decisions, constraints and outstanding tasks for the next turn.";
            res.end(JSON.stringify({ output_text: summary, choices: [{ message: { role: "assistant", content: summary }, finish_reason: "stop" }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const injected: typeof core = Object.create(core);
    injected.processTurn = (args) => {
        const turn = core.processTurn(args);
        const ranges = [{ startRef: first, endRef: last, count: 4, tokens: 2800, chars: 11_000, toolPct: 0, textPct: 1 }];
        if (mode.startsWith("batch")) ranges.push({ ...ranges[0]!, startRef: session.state.messageRefs.byRaw["raw-5"]!, endRef: session.state.messageRefs.byRaw["raw-8"]! });
        return { ...turn, nudge: { ...turn.nudge!, compressibleRanges: ranges } };
    };
    try {
        const url = `http://127.0.0.1:${address.port}`;
        const externalSummary = mode.startsWith("batch") ? new ConfiguredSummaryPlan({ enabled: true, targets: [{ name: "test", protocol: "openai", url, model: "test", apiKey: "fake" }] }) : undefined;
        await preflightCompress({ core: injected, session, config, prompts: defaultPrompts, protocol: "responses", url, headers: {}, model: "test", unknownBaseline: false, compressionTarget: 9000, externalSummary, log: (_level, msg) => logs.push(msg) }, messages);
        assert.ok(calls > 0, logs.join("\n"));
        const stale = session.state.blocks.find(b => b.summary === staleSummary);
        if (mode === "unchanged" || mode === "equivalent" || mode === "batch-unchanged") {
            assert.deepEqual(stale?.effectiveMessageIds, ["raw-1", "raw-2", "raw-3", "raw-4"], logs.join("\n"));
            if (mode === "batch-unchanged") assert.equal(session.state.blocks.length, 2, logs.join("\n"));
        }
        else {
            if (mode === "persistence") assert.ok(logs.some(msg => msg.includes("converging in-memory state")), logs.join("\n"));
            assert.equal(stale, undefined, `stale summary was attached to ${stale?.effectiveMessageIds.join(",")}`);
            if (mode === "batch-remapped") assert.equal(session.state.blocks.length, 0, "every stale batch entry must be discarded");
        }
    } finally {
        upstream.close();
        upstream.closeAllConnections();
        await once(upstream, "close");
        store.closeQuietly();
        rmrf(dir);
    }
});

for (const changedField of ["summary", "topic"] as const) test(`tier distillation must discard a summary after a source block's ${changedField} changes`, async () => {
    const core = createCore();
    const config = defaultConfig(12_000);
    config.preserveRecentMessages = 1;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const text = (size: number, label: string) => `${label} alpha beta gamma delta epsilon `.repeat(Math.ceil(size / 30)).slice(0, size);
    const messages: CoreMessage[] = [{ id: "early", role: "user", contentType: "text", text: text(500, "early") }];
    for (let i = 0; i < 6; i++) {
        messages.push({ id: `u${i}`, role: "user", contentType: "text", text: text(18_000, `USER${i}`) });
        messages.push({ id: `a${i}`, role: "assistant", contentType: "text", text: text(120, `REPLY${i}`) });
    }
    messages.push({ id: "tail", role: "user", contentType: "text", text: text(200, "tail") });
    const session = createSession("tier-state-race");
    session.state = core.processTurn({ messages, state: session.state, config: { ...config, modelContextLimit: 12_000_000 }, tokenCount: 12_000_000, renderTags: "text-only" }).state;
    for (let i = 0; i < 6; i++) {
        const ref = session.state.messageRefs.byRaw[`u${i}`]!;
        session.state = core.applyCompression({ messages, state: session.state, config: { ...config, preserveRecentMessages: 0 }, ranges: [{ startRef: ref, endRef: ref, summary: text(18_000, `BLOCK${i}`) }] }).state;
    }
    assert.equal(session.state.blocks.length, 6);
    session.stats.lastInputTokens = 48_000;
    let changed = false;
    const obsolete = "OBSOLETE TIER SUMMARY: source blocks have been distilled with their old decisions and constraints retained for future work.";
    const logs: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const source = Buffer.concat(chunks).toString("utf8");
            const tier = source.includes("[summarized");
            if (tier && !changed) {
                changed = true;
                session.state.blocks[0]![changedField] = "NEW SOURCE BLOCK: this replacement must not be hidden by an obsolete distillation.";
            }
            const content = tier ? obsolete : "A compact summary preserving the early raw message and all its relevant decisions for subsequent processing.";
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    try {
        const url = `http://127.0.0.1:${address.port}`;
        await preflightCompress({ core, session, config, prompts: defaultPrompts, protocol: "responses", url, headers: {}, model: "test", externalSummary: new ConfiguredSummaryPlan({ enabled: true, targets: [{ name: "test", protocol: "openai", url, model: "test", apiKey: "fake" }] }), log: (_level, msg) => logs.push(msg) }, messages);
        assert.ok(changed, logs.join("\n"));
        assert.equal(session.state.blocks.some(b => b.summary === obsolete), false, "changed source summary must not be replaced by stale distillation");
        assert.ok(logs.some(msg => msg.includes("discarded tier-distillation summary")), logs.join("\n"));
    } finally {
        upstream.close();
        upstream.closeAllConnections();
        await once(upstream, "close");
    }
});
