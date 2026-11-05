// #3756: snapshot render — proxy-lane outbound rendered from the server-side
// canonical history instead of the client's resent bytes.
//
// Contract staked BEFORE the implementation (打桩):
//
//  1. steady state: the outbound prefix (covered region rendered as summary
//     anchors + uncovered snapshot rows) is byte-stable turn over turn;
//  2. seed upgrade (a codec/identity change re-mints every message id on
//     identical content — the #3752/#3658 regression class): the outbound
//     prefix stays byte-identical, the block survives, no destroy verdict;
//  3. client-side deletion/checkpointing of the covered region is ignored
//     (server-authoritative prefix), the checkpoint itself rides the tail;
//  4. rewind: dropped tail messages do not come back;
//  5. protocol switch mid-session: same session, anchors render, stable;
//  6. rollout off (default): the legacy path keeps today's behavior — the
//     upgrade scenario demonstrably churns (the bug this lane fixes);
//  7. storage unavailable: D quietly falls back to the legacy path.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
// The D-lane renders from the unified store's tail view, so its sidecar must be
// open. Pin shadow explicitly: an ambient BILI_STORAGE_UNIFIED of legacy/0/false
// (or a config value) otherwise resolves mode to "legacy", where maybeOpen returns
// null SILENTLY and every D-on test degrades to the legacy path (#3771).
process.env.BILI_STORAGE_UNIFIED = "shadow";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-snap-hermetic-")), "no-config.json");

import { defaultConfig } from "acp-kernel";
import { __setMessageIdSaltForTests } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

const SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// Gemini native-wire SSE frame (same candidate/usageMetadata shape as e2e-google-compress.test.ts).
const GUSAGE = { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 1050 };
function gframe(parts: Record<string, unknown>[], finishReason?: string, usage?: Record<string, number>): string {
    const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
    if (finishReason) candidate.finishReason = finishReason;
    const frame: Record<string, unknown> = { candidates: [candidate], modelVersion: "gemini-test" };
    if (usage) frame.usageMetadata = usage;
    return `data: ${JSON.stringify(frame)}\n\n`;
}

// 23 messages × ~1.5k chars (~375 tokens each): total ~9k tokens stays under
// the 15k window (no preflight); the default protection zone (preserveRecent
// 3 + 5000-token walk ≈ 14 messages) leaves the first ~9 compressible, so the
// m00001..m00008 range lands intact. The transcript ENDS ON A USER message —
// every turn's streamed reply then appends exactly one assistant message and
// the alternation never breaks (cache-friendly client discipline).
function conversation(tail: { role: string; content: string }[] = []): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = [];
    for (let i = 0; i < 23; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return [...out, ...tail];
}

type Harness = {
    proxy: http.Server;
    upstream: http.Server;
    bodies: string[];
    openaiUrl: string;
    anthropicUrl: string;
    store: { unifiedTailSeqs(sessionId: string): number[] | null } | null;
    googleUrl: string;
    sessionOf: (label: string) => { meta: { label: string }; state: { blocks: { id: string; active: boolean }[] }; metadata: Record<string, unknown> } | undefined;
};

async function withHarness(fn: (h: Harness) => Promise<void>, storeEnabled: boolean): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            const n = bodies.length;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if ((req.url ?? "").toLowerCase().includes("generatecontent")) {
                if (n === 1) {
                    res.write(gframe([{ functionCall: { id: "fc_p", name: "compress", args: { content: [{ startId: "m00001", endId: "m00008", topic: "setup", summary: SUMMARY }] } } }]));
                    res.write(gframe([], "STOP", GUSAGE));
                } else {
                    const text = n === 2 ? "done compressing" : `ok ${n}`;
                    res.write(gframe([{ text }]));
                    res.write(gframe([], "STOP", GUSAGE));
                }
                res.end();
                return;
            }
            if (n === 1) {
                // turn 1 request: the model folds the oldest range and stops.
                const args = JSON.stringify({ content: [{ startId: "m00001", endId: "m00008", topic: "setup", summary: SUMMARY }] });
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "compress", arguments: args } }] } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                // turn 1 re-request (folded view) and later client turns: plain text.
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

    const dir = mkdtempSync(path.join(tmpdir(), "bili-snap-store-"));
    const store = storeEnabled ? new SessionStore({ enabled: true, dir, debounceMs: 0 }) : new SessionStore({ enabled: false });
    _setStoreForTest(store);
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 15_000 }, "gemini-test": { context: 15_000 } } } },
        modelContextLimit: 15_000,
        kernelConfig: defaultConfig(15_000),
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
        anthropicUrl: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        store: storeEnabled ? store : null,
        googleUrl: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`,
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
        __setMessageIdSaltForTests(null);
        delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
        store.closeQuietly();
        void rmrf(dir);
    }
}

type Msg = { role: string; content: string };

async function turn(h: Harness, url: string, label: string, messages: unknown[], history: Msg[] | null = null, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string; idx: number }> {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label, ...extraHeaders },
        body: JSON.stringify({ model: "gpt-test", messages, stream: true }),
    });
    const body = await r.text();
    await settleRows(h, label); // debounced=0 write + ingest must LAND before the next turn's D view build
    void history; // (history appended below after body parse)
    // realistic client: fold the assistant's visible reply into the transcript
    if (history) {
        for (const m of extractAssistantText(body)) history.push(m);
    }
    return { status: r.status ?? 0, body, idx: h.bodies.length - 1 };
}

/** Wait until the unified store's row count for the session GROWS past the
 *  count observed after the previous turn (first turn: ≥1) — the D engine
 *  reads rows DURING the next turn's prepare, and on a loaded CI runner the
 *  save→ingest roundtrip can outlive a fixed 60ms nap (the exact flake
 *  #3767's first full run tripped: surface asserts passed on the legacy
 *  path, only the D latch exposed that rows weren't there yet). */
const rowsSeen = new Map<string, number>();
async function settleRows(h: Harness, label: string): Promise<void> {
    if (!h.store) {
        await new Promise((res) => setTimeout(res, 60)); // D off: legacy path, no rows needed
        return;
    }
    const prev = rowsSeen.get(label) ?? 0;
    for (let i = 0; i < 200; i++) {
        const n = h.store.unifiedTailSeqs(label)?.length ?? 0;
        // The tail view is the CURRENT observation selector — a rewind turn
        // legitimately NET-SHRINKS it (dropped pointers), so wait for any
        // CHANGE, not growth.
        if (n !== prev && n > 0) {
            rowsSeen.set(label, n);
            return;
        }
        await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`settleRows: store tail view never changed for ${label} (still ${prev})`);
}

/** One assistant transcript entry per response: all plain-text content deltas
 *  concatenated (cache-friendly-proxy client discipline — the stateless client
 *  sees the model text plus any streamed 📦 receipt line as one reply). */
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

/** outbound openai messages from the i-th upstream hit */
function sent(bodies: string[], i: number): { role: string; content: unknown }[] {
    return JSON.parse(bodies[i]).messages as { role: string; content: unknown }[];
}

function textOf(m: { role: string; content: unknown }): string {
    return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/** Count anchor-shaped renders (the receipt echo also contains the summary
 *  head; only the section marker counts as an anchor copy). */
function anchorCount(s: string): number {
    return s.split("[Compressed conversation section]").length - 1;
}

/** The stable-prefix comparator: the serialized message stream of `a` up to
 *  its tail must equal `b` element-wise. tailLen = how many trailing messages
 *  of `a` are new (the live tail). */
function assertPrefixStable(a: { role: string; content: unknown }[], b: { role: string; content: unknown }[], tailLenA: number, note: string): void {
    const pa = a.slice(0, a.length - tailLenA);
    assert.ok(b.length >= pa.length, `${note}: other view at least as long (${b.length} < ${pa.length})`);
    for (let i = 0; i < pa.length; i++) {
        assert.equal(JSON.stringify(pa[i]), JSON.stringify(b[i]), `${note}: prefix diverges at outbound message ${i}`);
    }
}

/** Loud guard for the #3771 blind spot: a D-on test must prove the lane
 *  ACTUALLY rendered, not silently run the legacy path (whose behavior also
 *  satisfies most functional asserts, so a silent fallback read as green). On
 *  short activation, throw naming the degrade reason + store state. */
function assertDActive(h: Harness, label: string, minTurns: number, ctx: string): void {
    const s = h.sessionOf(label)!;
    const turns = s.metadata["snapshotRenderTurns"] as number | undefined;
    if (typeof turns === "number" && turns >= minTurns) return;
    const st = getStore();
    throw new Error(
        `[D-lane] did not activate (${ctx}): snapshotRenderTurns=${turns ?? "undefined"} (want >= ${minTurns}); degradeReason=${s.metadata["snapshotRenderDegradeReason"] ?? "(none - lane off or nothing armed)"}; ` +
        `replicasAvailable=${String(st.replicasAvailable())} rows=${st.unifiedTailViewRows(label)?.length ?? "null"} seqs=${st.unifiedTailSeqs(label)?.length ?? "null"}`,
    );
}

async function armBlock(h: Harness, label: string): Promise<void> {
    const r = await turn(h, h.openaiUrl, label, conversation());
    assert.equal(r.status, 200, r.body);
    const s = h.sessionOf(label);
    assert.ok(s, "session exists");
    assert.ok(s!.state.blocks.some((b) => b.active), "setup created an active block");
}

test("D on: steady state — anchor rendered once, covered rows absent, prefix byte-stable", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-steady", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-steady")!.state.blocks.some((b) => b.active), "block armed");
        // turn 2: transcript + a live tail of 2
        const tail = [
            { role: "user", content: "Message 24 tail question. " + "TAIL_A_".repeat(80) },
        ];
        const full2 = [...history, ...tail];
        const r2 = await turn(h, h.openaiUrl, "s-steady", full2, history);
        assert.equal(r2.status, 200, r2.body);
        const out2 = sent(h.bodies, r2.idx);
        const joined2 = out2.map(textOf).join("\n");
        assert.ok(joined2.includes(SUMMARY), "summary anchor rendered");
        assert.equal(anchorCount(joined2), 1, "exactly one anchor copy");
        assert.ok(!joined2.includes("WORK_1_content_"), "covered row 1 suppressed");
        assert.ok(!joined2.includes("WORK_7_content_"), "covered row 7 suppressed");
        assert.ok(joined2.includes("TAIL_A_"), "live tail present");
        // turn 3: identical transcript + one more tail message → whole prefix
        // (incl. everything before the new message) byte-identical to turn 2.
        const r3 = await turn(h, h.openaiUrl, "s-steady", [...history, { role: "user", content: "Message 26 follow-up. " + "TAIL_C_".repeat(80) }], history);
        assert.equal(r3.status, 200, r3.body);
        const out3 = sent(h.bodies, r3.idx);
        // tail = the new user message + the assistant run that absorbed the
        // turn-2 reply (#3658 openai assistant run-merge discipline).
        assertPrefixStable(out3, out2, 2, "steady-state");
        assertDActive(h, "s-steady", 2, "steady-state");
        assert.equal(h.sessionOf("s-steady")!.metadata["snapshotRenderDegradeReason"], undefined, "degrade reason cleared after successful D renders");
    }, true);
});

test("D on: identity-seed upgrade — outbound prefix byte-identical, block alive, no destroy verdict", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-upg", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-upg")!.state.blocks.some((b) => b.active), "block armed");
        const tail = [{ role: "user", content: "Post-upgrade question. " + "UPG_A_".repeat(80) }];
        const r2 = await turn(h, h.openaiUrl, "s-upg", [...history, ...tail], history);
        assert.equal(r2.status, 200, r2.body);
        const out2 = sent(h.bodies, r2.idx);
        // simulate the #3752/#3658 regression class: every id re-mints on the
        // SAME byte-identical content. The client resends the same history.
        __setMessageIdSaltForTests("upgrade-v2");
        const r3 = await turn(h, h.openaiUrl, "s-upg", [...history, ...tail], null);
        assert.equal(r3.status, 200, r3.body);
        const out3 = sent(h.bodies, r3.idx);
        const joined3 = out3.map(textOf).join("\n");
        assert.ok(joined3.includes(SUMMARY), "anchor still rendered after id re-mint");
        assert.ok(!joined3.includes("WORK_1_content_"), "covered rows still suppressed (no duplicate render)");
        assert.ok(joined3.includes("UPG_A_"), "tail present");
        assert.equal(anchorCount(joined3), 1, "exactly one anchor copy");
        // prefix (everything except the live tail) byte-identical to pre-upgrade
        assertPrefixStable(out3, out2, 1, "seed-upgrade");
        assertDActive(h, "s-upg", 1, "seed-upgrade");
        const s = h.sessionOf("s-upg")!;
        assert.ok(s.state.blocks.some((b) => b.active), "block survived the upgrade");
        assert.equal(s.metadata["foldDriftEscalated"], undefined, "no destroy verdict");
    }, true);
});

test("D on: client drops/checkpoints the covered region — server-authoritative prefix, client checkpoint ignored", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-drop", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-drop")!.state.blocks.some((b) => b.active), "block armed");
        // dsh-style checkpoint: first 10 messages replaced by one summary message
        const dropped = [
            { role: "user", content: "Earlier context was summarized by the client checkpoint: setup work happened." },
            ...history.slice(10),
            { role: "user", content: "Continuing after checkpoint. " + "KEEP_A_".repeat(80) },
        ];
        const r2 = await turn(h, h.openaiUrl, "s-drop", dropped, null);
        const out2 = sent(h.bodies, r2.idx);
        const joined2 = out2.map(textOf).join("\n");
        assert.ok(joined2.includes(SUMMARY), "anchor rendered from server state");
        assert.ok(!joined2.includes("WORK_1_content_"), "client's idea of the covered region does not resurrect rows");
        assert.ok(joined2.includes("WORK_10_content_"), "uncovered snapshot rows render");
        // Server-authoritative head (#3756 doctrine): the client's checkpoint
        // replacement sits BELOW the chain join, so it never renders — the
        // covered region belongs to the server's own summary (anchor), and
        // the uncovered head renders from the transcript rows it replaced.
        assert.ok(!joined2.includes("client checkpoint"), "client-side checkpoint of the head is ignored (server-authoritative)");
        assert.equal(anchorCount(joined2), 1, "exactly one anchor copy");
        // next turn: the transcript view has ADOPTED the client's checkpoint
        // shape — the block's fold-time ids no longer resolve against the
        // view (the client dropped the covered region for good). #3812
        // doctrine: an unanchorable block must not park its summary at the
        // top of a raw-history render — the lane degrades to legacy, where
        // the checkpoint-aware reconcile path owns rebasing the block.
        const turnsAfterR2 = h.sessionOf("s-drop")!.metadata["snapshotRenderTurns"] as number;
        const r3 = await turn(h, h.openaiUrl, "s-drop", [...dropped, { role: "user", content: "And one more. " + "KEEP_B_".repeat(80) }], null);
        assert.equal(r3.status, 200, r3.body);
        const s3 = h.sessionOf("s-drop")!;
        assert.equal(s3.metadata["snapshotRenderDegradeReason"], "block-unanchored", "adoption turn degrades: fold-time ids left the view");
        assert.equal(s3.metadata["snapshotRenderTurns"], turnsAfterR2, "degraded turn does not count as a D render");
        const out3 = sent(h.bodies, r3.idx);
        const joined3 = out3.map(textOf).join("\n");
        assert.ok(!joined3.includes("WORK_1_content_"), "covered rows never render raw (client dropped them; server never resurrects)");
        // steady after the degrade: the next turn is byte-stable on the prefix
        const r4 = await turn(h, h.openaiUrl, "s-drop", [...dropped, { role: "user", content: "And one more. " + "KEEP_B_".repeat(80) }, { role: "user", content: "Final follow. " + "KEEP_C_".repeat(80) }], null);
        assert.equal(r4.status, 200, r4.body);
        const out4 = sent(h.bodies, r4.idx);
        assertPrefixStable(out4, out3, 1, "client-checkpoint");
        assertDActive(h, "s-drop", 1, "client-checkpoint");
    }, true);
});

test("D on: rewind — dropped tail messages do not come back", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-rw", history, history);
        assert.equal(r1.status, 200, r1.body);
        const r2 = await turn(h, h.openaiUrl, "s-rw", [...history, { role: "user", content: "Rewind target question. " + "RW_A_".repeat(80) }], history);
        assert.equal(r2.status, 200, r2.body);
        // client rewinds the last exchange and asks something else
        const rewound = [...conversation(), { role: "user", content: "Different question instead. " + "RW_B_".repeat(80) }];
        const r3 = await turn(h, h.openaiUrl, "s-rw", rewound);
        assert.equal(r3.status, 200, r3.body);
        const joined3 = sent(h.bodies, r3.idx).map(textOf).join("\n");
        assert.ok(!joined3.includes("RW_A_"), "rewound message not rendered");
        assert.ok(joined3.includes("RW_B_"), "new question present");
        assert.ok(joined3.includes(SUMMARY), "anchor still rendered");
        assertDActive(h, "s-rw", 1, "rewind");
    }, true);
});

test("D on: protocol switch mid-session — anchors render on the new wire, session not forked", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-switch", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-switch")!.state.blocks.some((b) => b.active), "block armed");
        // next turn arrives on the anthropic wire, same session header
        const msgs = [...history, { role: "user", content: "Switched protocol. " + "SW_A_".repeat(80) }].map((m) => ({
            role: m.role,
            content: [{ type: "text", text: m.content }],
        }));
        const r2 = await turn(h, h.anthropicUrl, "s-switch", msgs, null, { "anthropic-version": "2023-06-01" });
        assert.equal(r2.status, 200, r2.body);
        const joined2 = sent(h.bodies, r2.idx).map(textOf).join("\n");
        assert.ok(joined2.includes(SUMMARY), "anchor renders on the anthropic wire");
        assert.ok(!joined2.includes("WORK_1_content_"), "covered rows suppressed after the switch");
        assert.ok(joined2.includes("SW_A_"), "tail present");
        const s = h.sessionOf("s-switch");
        assert.ok(s, "session survived the protocol switch (not forked away)");
        assertDActive(h, "s-switch", 1, "protocol-switch");
    }, true);
});

test("D off (default): the seed-upgrade scenario churns — documents the bug this lane fixes", async () => {
    delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-legacy", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-legacy")!.state.blocks.some((b) => b.active), "block armed");
        const tail = [{ role: "user", content: "Post-upgrade question. " + "UPG_A_".repeat(80) }];
        const r2 = await turn(h, h.openaiUrl, "s-legacy", [...history, ...tail], history);
        assert.equal(r2.status, 200, r2.body);
        __setMessageIdSaltForTests("upgrade-v2");
        const r3 = await turn(h, h.openaiUrl, "s-legacy", [...history, ...tail], null);
        assert.equal(r3.status, 200, r3.body);
        const joined3 = sent(h.bodies, r3.idx).map(textOf).join("\n");
        // legacy: coverage matching by id fails wholesale → raw rows re-render
        // (or the block deactivates). Either way the covered content leaks back.
        const leaked = joined3.includes("WORK_0_content_") || !joined3.includes(SUMMARY);
        assert.ok(leaked, "legacy path churns on identity re-mint (the #3752 regression class)");
        assert.equal(h.sessionOf("s-legacy")!.metadata["snapshotRenderTurns"], undefined, "no D latch");
    }, true);
});

test("D on but storage unavailable: legacy fallback, request still served", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turn(h, h.openaiUrl, "s-nostore", history, history);
        assert.equal(r1.status, 200, r1.body);
        const s = h.sessionOf("s-nostore");
        assert.ok(s!.state.blocks.some((b) => b.active), "block armed in memory");
        const r2 = await turn(h, h.openaiUrl, "s-nostore", [...history, { role: "user", content: "Still works. " + "NS_A_".repeat(80) }], history);
        assert.equal(r2.status, 200, r2.body);
        const joined2 = sent(h.bodies, r2.idx).map(textOf).join("\n");
        assert.ok(joined2.includes("NS_A_"), "served");
        assert.equal(h.sessionOf("s-nostore")!.metadata["snapshotRenderTurns"], undefined, "D inactive without rows");
        assert.equal(h.sessionOf("s-nostore")!.metadata["snapshotRenderDegradeReason"], "transcript-empty", "degrade reason surfaced on post-arm degrade");
    }, false);
});

// ── #3764: google-lane variants ───────────────────────────────────────────────
// Same wiring as the lanes above, driven over the Gemini native wire. The engine
// is wire-agnostic (it eats core BiliMessage); the projection seam under test is
// that the acp_summary anchor is a mid-stream SYSTEM core, and coreToGoogle rides
// non-assistant cores onto the user side (Gemini has no system role inside contents).
// Prefix stability is asserted on the JOINED TEXT sliced through the summary, not
// element-wise: coreToGoogle merges same-side runs, so the anchor can share one
// contents entry with the live tail and element counts are not comparable.
type GPart = { text?: unknown; thought?: boolean };
type GContent = { role: string; parts: GPart[] };

async function turnGoogle(h: Harness, label: string, messages: Msg[], history: Msg[] | null = null): Promise<{ status: number; body: string; idx: number }> {
    const r = await fetch(h.googleUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label },
        body: JSON.stringify({
            model: "gemini-test",
            contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
            generationConfig: { maxOutputTokens: 4096 },
        }),
    });
    const body = await r.text();
    await settleRows(h, label); // same anti-flake discipline as the openai turn(): rows must LAND before the next D view build
    if (history) for (const m of extractAssistantGoogle(body)) history.push(m);
    return { status: r.status ?? 0, body, idx: h.bodies.length - 1 };
}

function extractAssistantGoogle(body: string): Msg[] {
    let text = "";
    for (const block of body.trim().split("\n\n")) {
        if (!block.startsWith("data: ")) continue;
        try {
            const ev = JSON.parse(block.slice(6).trim()) as { candidates?: { content?: { parts?: GPart[] } }[] };
            for (const cand of ev.candidates ?? []) for (const part of cand.content?.parts ?? []) if (typeof part.text === "string" && part.thought !== true) text += part.text;
        } catch { /* keep scanning */ }
    }
    return text ? [{ role: "assistant", content: text }] : [];
}

function sentGoogle(bodies: string[], i: number): GContent[] {
    return JSON.parse(bodies[i]).contents as GContent[];
}

function joinedGoogle(contents: GContent[]): string {
    return contents.flatMap((c) => c.parts ?? []).map((p) => (typeof p.text === "string" ? p.text : "")).join("\n");
}

/** Byte prefix of the outbound through the end of the summary text — the
 *  server-authoritative rows plus the anchor, minus the client's live tail. */
function prefixThroughSummary(joined: string): string | null {
    const i = joined.indexOf(SUMMARY);
    return i < 0 ? null : joined.slice(0, i + SUMMARY.length);
}

test("D on · google: steady state — anchor rendered once, covered rows suppressed, prefix byte-stable", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turnGoogle(h, "g-steady", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("g-steady")!.state.blocks.some((b) => b.active), "block armed");
        const r2 = await turnGoogle(h, "g-steady", [...history, { role: "user", content: "Message 24 tail question. " + "GTAIL_A_".repeat(80) }], history);
        assert.equal(r2.status, 200, r2.body);
        const j2 = joinedGoogle(sentGoogle(h.bodies, r2.idx));
        assert.ok(j2.includes(SUMMARY), "summary anchor rendered");
        assert.equal(anchorCount(j2), 1, "exactly one anchor copy");
        assert.ok(!j2.includes("WORK_1_content_"), "covered row 1 suppressed");
        assert.ok(!j2.includes("WORK_7_content_"), "covered row 7 suppressed");
        assert.ok(j2.includes("GTAIL_A_"), "live tail present");
        const r3 = await turnGoogle(h, "g-steady", [...history, { role: "user", content: "Message 26 follow-up. " + "GTAIL_C_".repeat(80) }], history);
        assert.equal(r3.status, 200, r3.body);
        const j3 = joinedGoogle(sentGoogle(h.bodies, r3.idx));
        const p2 = prefixThroughSummary(j2);
        const p3 = prefixThroughSummary(j3);
        assert.ok(p2 !== null && p3 !== null, "summary present in both turns");
        assert.equal(p3, p2, "google prefix through the summary byte-stable");
        assertDActive(h, "g-steady", 2, "google-steady-state");
    }, true);
});

test("D on · google: identity-seed upgrade — prefix byte-identical, block alive, no destroy verdict", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turnGoogle(h, "g-upg", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("g-upg")!.state.blocks.some((b) => b.active), "block armed");
        const tail = [{ role: "user", content: "Post-upgrade question. " + "GUPG_A_".repeat(80) }];
        const r2 = await turnGoogle(h, "g-upg", [...history, ...tail], history);
        assert.equal(r2.status, 200, r2.body);
        const j2 = joinedGoogle(sentGoogle(h.bodies, r2.idx));
        __setMessageIdSaltForTests("upgrade-v2");
        const r3 = await turnGoogle(h, "g-upg", [...history, ...tail], null);
        assert.equal(r3.status, 200, r3.body);
        const j3 = joinedGoogle(sentGoogle(h.bodies, r3.idx));
        assert.ok(j3.includes(SUMMARY), "anchor still rendered after id re-mint");
        assert.ok(!j3.includes("WORK_1_content_"), "covered rows still suppressed");
        assert.ok(j3.includes("GUPG_A_"), "tail present");
        assert.equal(anchorCount(j3), 1, "exactly one anchor copy");
        const p2 = prefixThroughSummary(j2);
        const p3 = prefixThroughSummary(j3);
        assert.ok(p2 !== null && p3 !== null, "summary present in both turns");
        assert.equal(p3, p2, "google prefix byte-identical across the identity re-mint (#3752)");
        const s = h.sessionOf("g-upg")!;
        assert.ok(s.state.blocks.some((b) => b.active), "block survived the upgrade");
        assert.equal(s.metadata["foldDriftEscalated"], undefined, "no destroy verdict");
        assertDActive(h, "g-upg", 1, "google-seed-upgrade");
    }, true);
});

test("D off (default) · google: the seed-upgrade scenario churns — documents the bug this lane fixes", async () => {
    delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
    await withHarness(async (h) => {
        const history = conversation();
        const r1 = await turnGoogle(h, "g-legacy", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("g-legacy")!.state.blocks.some((b) => b.active), "block armed");
        const tail = [{ role: "user", content: "Post-upgrade question. " + "GUPG_A_".repeat(80) }];
        const r2 = await turnGoogle(h, "g-legacy", [...history, ...tail], history);
        assert.equal(r2.status, 200, r2.body);
        __setMessageIdSaltForTests("upgrade-v2");
        const r3 = await turnGoogle(h, "g-legacy", [...history, ...tail], null);
        assert.equal(r3.status, 200, r3.body);
        const j3 = joinedGoogle(sentGoogle(h.bodies, r3.idx));
        const leaked = j3.includes("WORK_0_content_") || !j3.includes(SUMMARY);
        assert.ok(leaked, "legacy google path churns on identity re-mint (the #3752 regression class)");
        assert.equal(h.sessionOf("g-legacy")!.metadata["snapshotRenderTurns"], undefined, "no D latch");
    }, true);
});

// ---------------------------------------------------------------------------
// #3812 stakes: the identity signature has no id component, so repeated short
// texts ("继续"/yes/1) let a single sig hit masquerade as a seam and silently
// truncate history; the per-block sig propagation swept uncovered same-text
// rows into coverage (losing real messages); an unanchored block (fold-time
// ids absent from the view) parked the summary anchor at the very top.
// ---------------------------------------------------------------------------

test("#3812 D on: repeated short user text must not silently truncate history", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        history[2] = { role: "user", content: "继续" }; // a covered-region duplicate of the turn-3 tail
        const r1 = await turn(h, h.openaiUrl, "s-dup", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-dup")!.state.blocks.some((b) => b.active), "block armed");
        const tailA = [{ role: "user", content: "NEXT_REQUEST_A. " + "TAIL_A_".repeat(80) }];
        const r2 = await turn(h, h.openaiUrl, "s-dup", [...history, ...tailA], history);
        assert.equal(r2.status, 200, r2.body);
        assertDActive(h, "s-dup", 1, "dup-text pre-state");
        const turnsBefore = h.sessionOf("s-dup")!.metadata["snapshotRenderTurns"] as number;
        // turn 3: the live tail repeats a COVERED message's exact text.
        // #4052: covered rows no longer accept signature binds, so the fresh
        // "继续" cannot masquerade as the seam anymore — it rides the tail,
        // while the stable-id chain carries the rest of the history into a
        // verified render (pre-#4052 this shape degraded as seam-too-short).
        const r3 = await turn(h, h.openaiUrl, "s-dup", [...history, { role: "user", content: "继续" }], null);
        assert.equal(r3.status, 200, r3.body);
        const out3 = sent(h.bodies, r3.idx);
        const joined = out3.map((m) => textOf(m)).join("\n");
        // the recent replies and deep history must ALL survive the seam
        assert.ok(joined.includes("ok 3"), "#3812: turn-2 reply silently truncated by short-text seam");
        assert.ok(joined.includes("WORK_10_content_"), "#3812: mid-history message silently truncated by short-text seam");
        // the covered copy of "继续" is suppressed, so its presence here can
        // only come from the fresh tail message — the #4052 loss is closed.
        assert.ok(joined.includes("继续"), "#4052: fresh message repeating covered text must stay visible");
        const s3 = h.sessionOf("s-dup")!;
        assert.equal(s3.metadata["snapshotRenderDegradeReason"], undefined, "#4052: verified id-chain seam renders instead of degrading");
        assert.equal(s3.metadata["snapshotRenderTurns"], turnsBefore + 1, "rendered turn counts as a D render");
    }, true);
});

test("#3812 D on: an uncovered same-text sibling in the prefix must render", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const history = conversation();
        const dupText = "DUP_PAYLOAD_MARKER_ " + "SHARED_TEXT_".repeat(60);
        history[2] = { role: "user", content: dupText }; // covered (inside m00001..m00008)
        history[10] = { role: "user", content: dupText }; // uncovered (protection zone)
        const r1 = await turn(h, h.openaiUrl, "s-sib", history, history);
        assert.equal(r1.status, 200, r1.body);
        assert.ok(h.sessionOf("s-sib")!.state.blocks.some((b) => b.active), "block armed");
        const r2 = await turn(h, h.openaiUrl, "s-sib", [...history, { role: "user", content: "SIB_NEXT. " + "TAIL_B_".repeat(80) }], null);
        assert.equal(r2.status, 200, r2.body);
        assertDActive(h, "s-sib", 1, "sibling render");
        const out2 = sent(h.bodies, r2.idx);
        const copies = out2.filter((m) => textOf(m).includes("SHARED_TEXT_")).length;
        assert.equal(copies, 1, "#3812: uncovered duplicate sibling was swept into coverage (real message lost)");
    }, true);
});


