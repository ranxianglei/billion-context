// #6653: a client's native compaction is detected as a generic rewrite but the
// client's marker is NOT recognized → recorded as "unannounced-rewrite" (alarm
// tier) instead of "native-compaction" (handled tier, quiet). When there are no
// active fold blocks to lose (activeBefore.size === 0), the rebase is clean —
// the client's own native compaction, not a second compressor. Classify as
// native-compaction (handled tier, quiet) instead of unannounced-rewrite (alarm).
//
// Gate-test both directions (#3617):
//   1. clean rebase (no active blocks) → native-compaction (quiet)
//   2. dirty rebase (active blocks)    → unannounced-rewrite (alarm)

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { conflictEventsOf, formatConflictSection } from "../src/conflict-watch.ts";

const SID_CLEAN = "clean-rebase-sess";
const SID_DIRTY = "dirty-rebase-sess";

function msg(i: number, tag: string): { role: string; content: string } {
    return { role: i % 2 === 0 ? "user" : "assistant", content: `${tag}_${i}_payload_`.repeat(180) };
}

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    close: () => Promise<void>;
};

async function startRig(window: number): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (/TASK: The conversation segment below/.test(raw)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", created: 1, model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "PREFLIGHT SUMMARY of the folded segment: multi-step debugging work on the billing pipeline. Key decisions: chose retry with backoff over fail-fast because upstream flakiness was intermittent. Files touched: src/a.ts:10, src/b.ts:20. Outcome: verified green." }, finish_reason: "stop" }] }));
                return;
            }
            const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
                `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chunk({ role: "assistant" }, null) + chunk({ content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: window } } } } as ProxyOptions["routes"],
        modelContextLimit: window,
        kernelConfig: defaultConfig(window, { preserveRecentMessages: 2, preserveRecentTokens: 2000, compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstreamPort,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

test("#6653 clean rebase: no active fold blocks → native-compaction (handled tier, quiet)", async () => {
    const rig = await startRig(10_000);
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/chat/completions`;
    const post = (sid: string, messages: Array<{ role: string; content: string }>): Promise<{ status: number; body: string }> =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sid }, body: JSON.stringify({ model: "gpt-test", max_tokens: 1024, stream: true, messages }) }).then(async (r) => ({ status: r.status, body: await r.text() }));

    try {
        const orig = Array.from({ length: 24 }, (_, i) => msg(i, "FILLER"));

        // Turn 1: ~18k-token estimate vs 10k window → preflight folds the oldest
        // FILLER messages into a REAL proxy-created block (active).
        const r1 = await post(SID_CLEAN, orig);
        assert.equal(r1.status, 200);
        let sess = listSessions().find((s) => s.id === SID_CLEAN);
        assert.ok(sess, "session exists");
        assert.ok(sess!.state.blocks.some((b) => b.active), "turn 1 preflight created an active block");

        // Turn 2: first rewrite (dirty rebase — active blocks present). This archives
        // the active blocks, leaving only deactivated blocks in the session.
        const rewritten1 = [...orig.slice(16), ...Array.from({ length: 16 }, (_, k) => msg(k, "NEWMSG"))];
        const r2 = await post(SID_CLEAN, rewritten1);
        assert.equal(r2.status, 200);
        sess = listSessions().find((s) => s.id === SID_CLEAN)!;
        assert.ok(sess.state.blocks.length > 0, "blocks exist after turn 2");

        // Manually deactivate all blocks to simulate the #6653 scenario:
        // blocks exist (satisfying blocks.length > 0) but none are active
        // (activeBefore.size === 0 → clean rebase).
        for (const b of sess.state.blocks) b.active = false;

        // Turn 3: second rewrite (clean rebase — no active blocks, only deactivated).
        // The client keeps the last 8 of turn-2's messages, appends 16 fresh ones.
        const rewritten2 = [...rewritten1.slice(16), ...Array.from({ length: 16 }, (_, k) => msg(k, "NEWMSG2"))];
        const r3 = await post(SID_CLEAN, rewritten2);
        assert.equal(r3.status, 200);

        sess = listSessions().find((s) => s.id === SID_CLEAN)!;
        const events = conflictEventsOf(sess);
        const rewriteEvents = events.filter((e) => e.kind === "unannounced-rewrite" || e.kind === "native-compaction");
        // Turn 2 produced unannounced-rewrite (dirty), turn 3 produced native-compaction (clean).
        const cleanEvents = rewriteEvents.filter((e) => e.kind === "native-compaction");
        assert.ok(cleanEvents.length >= 1, `expected at least one native-compaction event (clean rebase), got ${rewriteEvents.length} total: ${JSON.stringify(rewriteEvents)}`);
        const clean = cleanEvents[cleanEvents.length - 1]!;
        assert.ok(clean.detail.includes("clean rebase"), `detail should mention clean rebase: ${clean.detail}`);
        assert.ok(clean.detail.includes("#6653"), `detail should cite #6653: ${clean.detail}`);

        // The latest event is native-compaction (handled tier, quiet).
        assert.equal(clean.kind, "native-compaction");
    } finally {
        await rig.close();
    }
});

test("#6653 dirty rebase: active fold blocks present → unannounced-rewrite (alarm tier)", async () => {
    const rig = await startRig(10_000);
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/chat/completions`;
    const post = (sid: string, messages: Array<{ role: string; content: string }>): Promise<{ status: number; body: string }> =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sid }, body: JSON.stringify({ model: "gpt-test", max_tokens: 1024, stream: true, messages }) }).then(async (r) => ({ status: r.status, body: await r.text() }));

    try {
        const orig = Array.from({ length: 24 }, (_, i) => msg(i, "FILLER"));

        // Turn 1: ~18k-token estimate vs 10k window → preflight folds the oldest
        // FILLER messages into a REAL proxy-created block (active).
        const r1 = await post(SID_DIRTY, orig);
        assert.equal(r1.status, 200);
        let sess = listSessions().find((s) => s.id === SID_DIRTY);
        assert.ok(sess, "session exists");
        assert.equal(Object.keys(sess!.state.messageRefs.byRaw).length, 24, "all 24 messages got refs");
        assert.ok(sess!.state.blocks.some((b) => b.active), "turn 1 preflight created an active block");

        // Turn 2: the client silently rewrites its history (native compaction):
        // keeps the last 8 originals, appends 16 fresh ones. Active blocks present → dirty rebase.
        const rewritten = [...orig.slice(16), ...Array.from({ length: 16 }, (_, k) => msg(k, "NEWMSG"))];
        const r2 = await post(SID_DIRTY, rewritten);
        assert.equal(r2.status, 200);

        sess = listSessions().find((s) => s.id === SID_DIRTY)!;
        const events = conflictEventsOf(sess);
        const rewriteEvents = events.filter((e) => e.kind === "unannounced-rewrite" || e.kind === "native-compaction");
        assert.equal(rewriteEvents.length, 1, `expected exactly one rewrite event, got ${rewriteEvents.length}: ${JSON.stringify(rewriteEvents)}`);
        assert.equal(rewriteEvents[0]!.kind, "unannounced-rewrite", `expected unannounced-rewrite (dirty rebase with active blocks), got ${rewriteEvents[0]!.kind}`);

        // The alarm tier should fire: banner text present.
        const section = formatConflictSection(events, Date.now());
        const sectionText = section.join("\n");
        assert.ok(sectionText.includes("UNCONFIRMED signal"), `dirty rebase should fire the unconfirmed signal tier: ${sectionText}`);
    } finally {
        await rig.close();
    }
});
