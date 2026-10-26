// #4241 — the invariant judge must not false-positive I2 on snapshot-render
// turns. The render lane REPLACES the outbound prefix with the server
// transcript (summary anchors + store rows); the client's own inbound bytes
// for the same history are legitimately ABSENT from the frozen prefix. The
// judge's ground truth for a render turn is the RENDERED view, not the
// inbound — reconciling against the inbound reports a rewrite that is the
// engine's definition behavior.
//
// Contract staked BEFORE the fix (打桩):
//
//  1. render turn with a host-side history edit (the client re-sends the
//     transcript with an early message's bytes changed — re-stamp family):
//     the outbound stays SERVER-authoritative (store bytes render, the edit
//     is overridden below the chain join) AND the main-lane judge verdict
//     for that forward is CLEAN. Before the fix this fires I2
//     mid-history-rewrite — the exact #4241 report.
//  2. teeth: the same shape with an injected exit defect (a frozen-prefix
//     row dropped from the outbound) still FIRES — the baseline swap blinds
//     the judge to legitimate divergence, not to defects.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
// The D-lane renders from the unified store's tail view — its sidecar must be
// open (see tests/snapshot-render.test.ts for the #3771 note on ambient env).
process.env.BILI_STORAGE_UNIFIED = "shadow";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-4241-hermetic-")), "no-config.json");

import { defaultConfig, type CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { _setInvariantJudgeForTest, _setInvariantJudgeFaultForTest, type JudgeVerdict } from "../src/invariant-judge.ts";
import { rmrf } from "./tmp-rm.ts";

const SUMMARY = "MID-HISTORY-SUMMARY-OF-THE-MIDDLE-REGION-LONG-ENOUGH-FOR-THE-KERNEL-MINIMUM-LENGTH-CHECK";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// 46 messages × ~1.5k chars (~375 tokens each) ≈ 17k tokens under the 30k
// window (no preflight); the protection zone (preserveRecent 3 + 5000-token
// walk ≈ 14 messages) leaves the first ~32 compressible, so a MID-LIST range
// (m17..m30) folds intact and the turn-2 outbound carries UNCOVERED prefix
// rows BEFORE the carrier — the shape the judge actually scans (a covered
// region at index 0 free-passes everything, which is why the D-lane tests
// never tripped #4241).
function conversation(tail: { role: string; content: string }[] = []): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = [];
    for (let i = 0; i < 46; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return [...out, ...tail];
}

type Harness = {
    proxy: http.Server;
    upstream: http.Server;
    bodies: string[];
    openaiUrl: string;
    store: { unifiedTailSeqs(sessionId: string): number[] | null };
    sessionOf: (label: string) => { meta: { label: string }; state: { blocks: { id: string; active: boolean }[] }; metadata: Record<string, unknown> } | undefined;
};

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            const n = bodies.length;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (n === 1) {
                // turn 1: the model folds the MID-LIST range m00017..m00030.
                const args = JSON.stringify({ content: [{ startId: "m00017", endId: "m00030", topic: "middle region", summary: SUMMARY }] });
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "compress", arguments: args } }] } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                const text = n === 2 ? "done compressing" : `ok ${n}`;
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const dir = mkdtempSync(path.join(tmpdir(), "bili-4241-store-"));
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: Boolean(process.env.SNAP_DEBUG),
        debug: Boolean(process.env.SNAP_DEBUG),
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const h: Harness = {
        proxy,
        upstream,
        bodies,
        openaiUrl: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        store,
        sessionOf: (label) => listSessions().find((x) => x.meta.label === label) as never,
    };
    try {
        await fn(h);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
        store.closeQuietly();
        void rmrf(dir);
    }
}

type Msg = { role: string; content: string };

async function turn(h: Harness, messages: unknown[], label: string, history: Msg[] | null): Promise<{ status: number; body: string; idx: number }> {
    const r = await fetch(h.openaiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label },
        body: JSON.stringify({ model: "gpt-test", messages, stream: true }),
    });
    const body = await r.text();
    await settleRows(h, label);
    if (history) {
        for (const m of extractAssistantText(body)) history.push(m);
    }
    return { status: r.status ?? 0, body, idx: h.bodies.length - 1 };
}

const rowsSeen = new Map<string, number>();
async function settleRows(h: Harness, label: string): Promise<void> {
    const prev = rowsSeen.get(label) ?? 0;
    for (let i = 0; i < 200; i++) {
        const n = h.store.unifiedTailSeqs(label)?.length ?? 0;
        if (n !== prev && n > 0) {
            rowsSeen.set(label, n);
            return;
        }
        await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`settleRows: store tail view never changed for ${label} (still ${prev})`);
}

function extractAssistantText(body: string): Msg[] {
    let text = "";
    for (const block of body.trim().split("\n\n")) {
        if (!block.startsWith("data: ")) continue;
        const data = block.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
            const delta = (JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta;
            const c = delta?.content;
            if (typeof c === "string") text += c;
        } catch { /* keep scanning */ }
    }
    return text ? [{ role: "assistant", content: text }] : [];
}

function sent(bodies: string[], i: number): { role: string; content: unknown }[] {
    return JSON.parse(bodies[i]).messages as { role: string; content: unknown }[];
}

function textOf(m: { role: string; content: unknown }): string {
    return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

test("#4241: render turn with a host-side history edit — judge reconciles against the rendered baseline, stays clean, teeth intact", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    const verdicts: JudgeVerdict[] = [];
    _setInvariantJudgeForTest(true, (v) => verdicts.push(v));
    try {
        await withHarness(async (h) => {
            const label = "s-4241";
            const history = conversation();
            // turn 1: mid-list fold lands (m17..m30).
            const r1 = await turn(h, history, label, history);
            assert.equal(r1.status, 200, r1.body);
            assert.ok(h.sessionOf(label)!.state.blocks.some((b) => b.active), "block armed");

            // turn 2: the client re-sends the transcript with an EARLY
            // UNCOVERED message's bytes rewritten (host re-stamp family) plus
            // a live tail. The D lane is server-authoritative: the store's
            // original bytes render and the edit is overridden — so the
            // inbound ORIGINALS are legitimately absent from the outbound
            // prefix, which is exactly the #4241 false-positive shape.
            const edited = conversation();
            edited[2] = { role: "user", content: `Message 2 rewritten by the host re-stamp. ` + `EDIT_2_`.repeat(88) };
            const full2 = [...edited, { role: "user", content: "Message 46 tail question. " + "TAIL_A_".repeat(80) }];
            verdicts.length = 0;
            const r2 = await turn(h, full2, label, null);
            assert.equal(r2.status, 200, r2.body);

            const out2 = sent(h.bodies, r2.idx);
            const joined2 = out2.map(textOf).join("\n");
            assert.ok(joined2.includes(SUMMARY), "mid-list anchor rendered");
            assert.ok(joined2.includes("WORK_2_content_"), "store's original row 2 renders (server-authoritative prefix)");
            assert.ok(!joined2.includes("EDIT_2_"), "client-side edit of the prefix is overridden below the chain join");
            assert.ok(!joined2.includes("WORK_17_content_"), "covered middle rows suppressed");
            assert.ok(joined2.includes("TAIL_A_"), "live tail present");
            const meta = h.sessionOf(label)!.metadata;
            const renderTurns = meta["snapshotRenderTurns"] as number | undefined;
            assert.ok(typeof renderTurns === "number" && renderTurns >= 1, "D lane active on turn 2");

            // THE STAKE: the main-lane judge verdict(s) for the render turn
            // must be clean — reconciled against the rendered baseline, not
            // the inbound bytes.
            const main = verdicts.filter((v) => v.lane === "main");
            assert.ok(main.length >= 1, "judge ran on the turn-2 forward");
            for (const v of main) {
                assert.ok(v.ok, `main-lane verdict must be clean on a render turn: ${JSON.stringify(v.violations[0])}`);
            }

            // teeth: same shape, but the outbound DROPS the last client tail
            // row (exitCores.length - 2: the engine appends its trailing nudge
            // as the final wire message, so the last tail row sits one before
            // it) — the part the render lane owns byte-intact. The rendered
            // PREFIX is exempt by design (#4241: cross-turn prefix stability
            // is seamLcp's/shadow's job); the tail drop must fire.
            _setInvariantJudgeFaultForTest((exitCores: CoreMessage[]) => exitCores.filter((_, i) => i !== exitCores.length - 2));
            verdicts.length = 0;
            const r3 = await turn(h, [...full2, { role: "user", content: "And one more. " + "TAIL_B_".repeat(80) }], label, null);
            assert.equal(r3.status, 200, r3.body);
            _setInvariantJudgeFaultForTest(null);
            const main3 = verdicts.filter((v) => v.lane === "main");
            assert.ok(main3.length >= 1, "judge ran on the faulted forward");
            assert.ok(main3.some((v) => !v.ok), "exit defect on a render turn still fires (teeth intact)");
        });
    } finally {
        _setInvariantJudgeForTest(false);
        _setInvariantJudgeFaultForTest(null);
    }
});
