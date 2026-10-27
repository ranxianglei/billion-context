// #3712: a native-compaction rebase (dsh desktop's checkpoint landing outside
// bili, #2432/#2373) calls resetSessionCompression, which wipes every sizing
// anchor effectiveTokenCount reads (lastInputTokens → 0, lastUsageGradeTokens
// deleted, localInputEstimate cleared) — and the tokenCount computed BEFORE the
// rebase describes the PRE-compaction payload. Feeding either into the immediate
// core.processTurn strands the nudge meter: a stale-low usage gates off
// firstSightMassReady (usage >= minContextLimitPct) while the real ready mass sits
// undrained until unrelated growth crosses the band — the permanent degradation
// reported in #3712 (out/in 62.5% vs 16.8%, blocked: T1 (cadence) forever).
//
// The fix re-measures the CURRENT compacted view after the rebase. This pins that
// the per-turn sizing input handed to core.processTurn → decideNudge (recorded on
// session.stats.contextTokens / …Source) is a FRESH measure of the current view
// (source "estimate") instead of the stale usage-grade number from before the
// compaction (source "usage"). DSH lanes themselves receive no nudge (#3177
// host-scope tools), so the input is the correct place to observe the unblocking.
// The seed/fold/replay fixture mirrors issue2432-dsh-local-compaction.test.ts.

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
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";

const MODEL = "deepseek-flash";

type Rig = { proxyPort: number; upstreamPort: number; bodies: string[]; close: () => Promise<void> };

async function startRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            // Report prompt tokens proportional to the payload so the session
            // accumulates a real usage-grade baseline between requests.
            const promptTokens = Math.max(1, Math.round(raw.length / 4));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstreamPort,
        bodies,
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

const chatUrl = (rig: Rig) => `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;

function dshHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}

// 14 messages sized like the codex #2372 fixture: the kernel protects the
// last 5 messages, so folding m00001–m00009 covers 9 ids (> the 8-id floor).
function seedInput() {
    return Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
}

function checkpointMessage() {
    return {
        role: "user",
        content: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. The work established the harness, drove one fold, and then dsh compacted natively. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`,
    };
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

// #3712 review: the re-measure must price the FULL outbound view — tool schemas
// included, matching the usage-grade caliber (upstream prompt_tokens) it replaces.
// A messages-only count drops this block entirely; the floor below discriminates.
const TOOLS_DESC = "T".repeat(20_000);

async function seedAndFold(rig: Rig, conv: string): Promise<void> {
    const r1 = await fetch(chatUrl(rig), {
        method: "POST",
        headers: dshHeaders(conv),
        body: JSON.stringify({ model: MODEL, messages: seedInput() }),
    });
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const s = getSession(conv);
    assert.ok(s, "seed session exists under the conversation key");
    assert.ok(Object.keys(s!.state.messageRefs.byRaw).length >= 14, "refs assigned to the seeded history");
    const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00009", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r2.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok, `fold accepted (${r2.status})`);
    assert.ok(!j.result?.includes("[Compression FAILED"), `fold succeeded: ${j.result?.slice(0, 200)}`);
    const covered = new Set((s!.state.blocks ?? []).flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
    assert.ok(covered.size >= 8, `fold covers >=8 ids (got ${covered.size})`);
}

test("#3712: a dsh native-compaction rebase re-measures the turn's sizing input off the CURRENT compacted view, not the stale pre-compaction measurement", async () => {
    const rig = await startRig();
    const conv = "dshc-3712-meter-b";
    try {
        await seedAndFold(rig, conv);
        const s0 = getSession(conv)!;
        // Precondition: the seed left a usage-grade input measurement behind — the
        // STALE value a pre-fix rebase would reuse for the post-rebase decision.
        const staleInput = s0.stats.lastInputTokens;
        assert.ok(staleInput > 0, `precondition: the seed produced a usage-grade input measurement (${staleInput})`);

        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                messages: [checkpointMessage(), seedInput()[12], seedInput()[13]],
                tools: [{ type: "function", function: { name: "probe", description: TOOLS_DESC, parameters: { type: "object", properties: {} } } }],
            }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        const s = getSession(conv)!;
        const boundary = s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean; priced?: { tokens: number; source: string } } | undefined;
        assert.ok(boundary, "native-compaction boundary recorded");
        assert.equal(boundary?.pendingRebase, false, "rebase consumed within the same request");
        assert.equal((s.state.blocks ?? []).length, 0, "block list reset by the rebase");
        // THE FIX: the rebased turn must price its context off a FRESH measure of the
        // current compacted view (source "estimate"), not the stale usage-grade baseline
        // from before the compaction (source "usage") — which is what gated off
        // firstSightMassReady and stranded the meter in #3712. The pricing is stamped on
        // the boundary itself because stats.contextTokens is refreshed to the freshest
        // upstream figure by this same turn's usage report and would otherwise lose it.
        assert.ok(boundary?.priced, "the rebased turn's pricing was recorded on the boundary");
        assert.equal(boundary?.priced?.source, "estimate", "post-rebase sizing input is a fresh measure, not the stale usage-grade baseline");
        assert.ok((boundary?.priced?.tokens ?? 0) > 0, `post-rebase sizing input measured a real current-view size (${boundary?.priced?.tokens})`);
        // Caliber pin: the tool schema (TOOLS_DESC, ~5K tok at 4 chars/token) must be
        // in the measure — a messages-only count would land near the core mass only
        // (~1.8K tok here) and fail this floor.
        assert.ok((boundary?.priced?.tokens ?? 0) >= TOOLS_DESC.length / 4 + 500, `post-rebase pricing covers the full outbound view incl. tools (${boundary?.priced?.tokens} >= ${TOOLS_DESC.length / 4 + 500})`);
    } finally {
        await rig.close();
    }
});
