// #3477: the /v1/responses lane never consumed the announced native-compaction
// boundary created by POST /__bili/plugin/compact (pi session_compact callback).
// The anthropic/openai/google lanes each snapshot the active fold blocks BEFORE
// processTurn and call applyCompactionArchive after state adoption; the responses
// lane had neither — so on this wire the announced boundary stayed pending
// forever, the pre-compaction archive got no record, and obsolete raw-id→ref
// mappings leaked. This wires applyCompactionArchive into prepareResponses,
// guarded so a codex compaction-generation request (native remote-compact
// trigger, or the recognized local SUMMARIZATION_PROMPT prompt form) never eats
// an unrelated pending marker — only an ordinary turn may consume it.
//
// Harness mirrors the #2451 responses-lane fixture: in-process proxy + loopback
// SSE upstream, isolated store/registry/session/plugin state. Folds ride the
// plugin tool channel (plugin mode) or the model's own compress function_call
// (proxy mode); the announced boundary is marked through the REAL
// POST /__bili/plugin/compact endpoint in both modes, then consumed by the next
// /v1/responses turn.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, REF_FLOOR_RAW_ID, preCompactionArchiveOf, type Session } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { CODEX_COMPACT_PROMPT_ANCHOR } from "../src/codex-compact.ts";

const MODEL = "gpt-resp";
const WINDOW = 30_000;
const INSTRUCTIONS = "You are the test coding agent.";
const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

// Plugin mode suppresses the compress loop, so proxy-mode folds ride the model's
// own compress function_call (the non-plugin path the codex #2372 fixture uses).
function fcEvents(callId: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress", arguments: args } }),
    ].join("");
}

// 12 distinct alternating messages; folding m00001–m00007 covers 7 raw ids and
// leaves m00008–m00012 as the retained tail (byte-identical on resend, so its
// refs stay valid and read as "live" to the archive).
function seedInput() {
    return Array.from({ length: 12 }, (_, i) => ({
        type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} ${"x".repeat(2000)}`,
    }));
}

function tailInput() {
    return seedInput().slice(7);
}

type Harness = {
    url: string;
    pluginToolUrl: string;
    compactUrl: string;
    bodies: string[];
    close: () => Promise<void>;
};

async function startHarness(modelFold: boolean): Promise<Harness> {
    const bodies: string[] = [];
    let foldArmed = modelFold;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            if (raw.includes("__FAIL_UPSTREAM__")) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "synthetic upstream failure" } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (foldArmed) {
                foldArmed = false;
                res.write(fcEvents("call_p", JSON.stringify({ content: [{ startId: "m00001", endId: "m00007", topic: "folded head", summary: FOLD_SUMMARY }] })));
            }
            res.write(completed(800));
            res.end();
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
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
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`,
        pluginToolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`,
        compactUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/compact`,
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

function pluginHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv };
}

function proxyHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-acp-session": conv };
}

function findSession(conv: string, agent?: string): Session | undefined {
    return listSessions().find((x) => x.id === conv || x.meta.label === conv || (agent !== undefined && x.metadata.pluginAgent === agent));
}

type Boundary = { pending?: boolean; archivedBlocks?: string[] };

function boundaryOf(s: Session): Boundary {
    return (s.metadata.compactionBoundary ?? {}) as Boundary;
}

function nonFloorRefCount(s: Session): number {
    return Object.keys(s.state.messageRefs.byRaw).filter((k) => k !== REF_FLOOR_RAW_ID).length;
}

// Highest numeric ref currently held (mNNNNN → NNNNN). The pre-compaction
// high-water must survive consumption: either a retained live id still holds the
// top ref, or the bili:ref-floor sentinel re-pins it — either way no number at
// or below it is ever re-issued (Kernel Contract: refs are never reused).
function maxRefIndex(byRaw: Record<string, string>): number {
    let hi = 0;
    for (const v of Object.values(byRaw)) {
        const m = /^m(\d+)$/.exec(v);
        if (m) hi = Math.max(hi, parseInt(m[1], 10));
    }
    return hi;
}

// Seed a folded session: 12-message history + one active fold over m00001–m00007.
async function seedPlugin(h: Harness, conv: string): Promise<Session> {
    const r = await fetch(h.url, { method: "POST", headers: pluginHeaders(conv), body: JSON.stringify({ model: MODEL, stream: true, session_id: conv, instructions: INSTRUCTIONS, input: seedInput() }) });
    assert.equal(r.status, 200, "seed request succeeds");
    await r.text();
    const r2 = await fetch(h.pluginToolUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00007", topic: "folded head", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r2.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok && !j.result?.includes("[Compression FAILED"), `plugin-channel fold accepted (${r2.status}): ${j.result?.slice(0, 160)}`);
    const s = findSession(conv, "pi");
    assert.ok(s, "seed session exists and is pi-bound");
    assert.ok(s!.state.blocks.some((b) => b.active), "an active fold block exists after seeding");
    return s!;
}

// Mark the announced boundary through the REAL endpoint and confirm it is pending.
async function announceCompact(h: Harness, conv: string): Promise<void> {
    const r = await fetch(h.compactUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv }) });
    assert.equal(r.status, 200, "compact endpoint answers 200");
    const j = (await r.json()) as { ok: boolean };
    assert.ok(j.ok, "boundary announced");
    assert.equal(boundaryOf(findSession(conv, "pi")!).pending, true, "announced boundary is pending before the post-compaction turn");
}

// The invariants the fix must establish on the consuming turn. preNonFloor /
// preMaxRef are snapshot VALUES taken before the turn (the session object is
// mutated in place, so a live reference would already reflect the post state).
function assertConsumed(s: Session, preNonFloor: number, preMaxRef: number): void {
    const b = boundaryOf(s);
    assert.equal(b.pending, false, "announced boundary consumed exactly once");
    assert.ok(Array.isArray(b.archivedBlocks) && b.archivedBlocks.length >= 1, "archivedBlocks records the deactivated generation");
    const archived = new Set(b.archivedBlocks!);
    for (const blk of s.state.blocks) {
        if (archived.has(blk.blockId)) assert.equal(blk.active, false, "archived block is inactive");
    }
    const archive = preCompactionArchiveOf(s);
    assert.ok([...archived].some((id) => archive[id] !== undefined && /native compaction/.test(archive[id]!.reason)), "archive entry recorded with the native-compaction reason");
    const nonFloorAfter = nonFloorRefCount(s);
    assert.ok(nonFloorAfter < preNonFloor, `obsolete ref mappings pruned (${preNonFloor}→${nonFloorAfter})`);
    assert.ok(nonFloorAfter >= tailInput().length, `live tail refs retained (got ${nonFloorAfter}, want ≥${tailInput().length})`);
    const maxRefAfter = maxRefIndex(s.state.messageRefs.byRaw);
    assert.ok(maxRefAfter >= preMaxRef, `ref high-water preserved (${preMaxRef}→${maxRefAfter})`);
}

test("#3477 plugin mode: announced /__bili/plugin/compact boundary is consumed on the next /v1/responses turn", async () => {
    const h = await startHarness(false);
    const conv = "bc3477-plugin";
    try {
        const s0 = await seedPlugin(h, conv);
        const preNonFloor = nonFloorRefCount(s0);
        const preMaxRef = maxRefIndex(s0.state.messageRefs.byRaw);
        await announceCompact(h, conv);
        const r = await fetch(h.url, { method: "POST", headers: pluginHeaders(conv), body: JSON.stringify({ model: MODEL, stream: true, session_id: conv, instructions: INSTRUCTIONS, input: tailInput() }) });
        assert.equal(r.status, 200, "post-compaction turn succeeds");
        await r.text();
        const s = findSession(conv, "pi")!;
        assertConsumed(s, preNonFloor, preMaxRef);
        assert.equal(s.id, s0.id, "session identity retained across the compaction");
        assert.equal(s.metadata.pluginAgent, "pi", "plugin binding retained");
    } finally {
        await h.close();
    }
});

test("#3477 proxy mode: same lifecycle without the plugin channel", async () => {
    const h = await startHarness(true);
    const conv = "bc3477-proxy";
    try {
        const r1 = await fetch(h.url, { method: "POST", headers: proxyHeaders(conv), body: JSON.stringify({ model: MODEL, stream: true, session_id: conv, instructions: INSTRUCTIONS, input: seedInput() }) });
        assert.equal(r1.status, 200, "seed request succeeds");
        await r1.text();
        const s0 = findSession(conv);
        assert.ok(s0, "seed session exists");
        assert.equal(s0!.metadata.pluginAgent, undefined, "proxy mode: not plugin-bound");
        assert.ok(s0!.state.blocks.some((b) => b.active), "model-driven fold created an active block");
        const preNonFloor = nonFloorRefCount(s0!);
        const preMaxRef = maxRefIndex(s0!.state.messageRefs.byRaw);
        await announceCompact(h, conv);
        const r = await fetch(h.url, { method: "POST", headers: proxyHeaders(conv), body: JSON.stringify({ model: MODEL, stream: true, session_id: conv, instructions: INSTRUCTIONS, input: tailInput() }) });
        assert.equal(r.status, 200, "post-compaction turn succeeds");
        await r.text();
        const s = findSession(conv)!;
        assertConsumed(s, preNonFloor, preMaxRef);
        assert.equal(s.id, s0!.id, "session identity retained across the compaction");
    } finally {
        await h.close();
    }
});

test("#3477: a compaction-trigger generation request does NOT consume an unrelated announced boundary", async () => {
    const h = await startHarness(false);
    const conv = "bc3477-trigger";
    try {
        await seedPlugin(h, conv);
        await announceCompact(h, conv);
        const r = await fetch(h.url, { method: "POST", headers: pluginHeaders(conv), body: JSON.stringify({ model: MODEL, stream: true, session_id: conv, instructions: INSTRUCTIONS, input: [...seedInput(), { type: "compaction_trigger" }] }) });
        assert.equal(r.status, 200, "trigger-form request succeeds");
        await r.text();
        const s = findSession(conv, "pi")!;
        const b = boundaryOf(s);
        assert.equal(b.pending, true, "trigger-form request must NOT consume the announced boundary");
        assert.ok(!Array.isArray(b.archivedBlocks) || b.archivedBlocks.length === 0, "no blocks archived by the trigger-form request");
        assert.ok(s.state.blocks.some((x) => x.active), "the live fold survives the trigger-form turn");
    } finally {
        await h.close();
    }
});

test("#3477: a recognized Codex compaction-prompt generation request does NOT consume it either", async () => {
    const h = await startHarness(false);
    const conv = "bc3477-prompt";
    try {
        await seedPlugin(h, conv);
        await announceCompact(h, conv);
        const promptMsg = { type: "message", role: "user", content: `${CODEX_COMPACT_PROMPT_ANCHOR} Summarize the conversation so far into a checkpoint.` };
        const r = await fetch(h.url, { method: "POST", headers: pluginHeaders(conv), body: JSON.stringify({ model: MODEL, stream: true, session_id: conv, instructions: INSTRUCTIONS, input: [...seedInput().slice(0, 11), promptMsg] }) });
        assert.equal(r.status, 200, "prompt-form request succeeds");
        await r.text();
        const s = findSession(conv, "pi")!;
        const b = boundaryOf(s);
        assert.equal(b.pending, true, "prompt-form request must NOT consume the announced boundary");
        assert.ok(!Array.isArray(b.archivedBlocks) || b.archivedBlocks.length === 0, "no blocks archived by the prompt-form request");
    } finally {
        await h.close();
    }
});

test("#3477: a later upstream HTTP failure does not undo bookkeeping for a compaction that already completed", async () => {
    const h = await startHarness(false);
    const conv = "bc3477-fail";
    try {
        await seedPlugin(h, conv);
        await announceCompact(h, conv);
        const r = await fetch(h.url, { method: "POST", headers: pluginHeaders(conv), body: JSON.stringify({ model: MODEL, stream: true, session_id: conv, instructions: INSTRUCTIONS, input: tailInput() }) });
        assert.equal(r.status, 200, "compaction turn succeeds");
        await r.text();
        const consumed = findSession(conv, "pi")!;
        assert.equal(boundaryOf(consumed).pending, false, "boundary consumed by the successful compaction turn");
        assert.ok((boundaryOf(consumed).archivedBlocks ?? []).length >= 1, "archive recorded by the successful compaction turn");
        const okMaxRef = maxRefIndex(consumed.state.messageRefs.byRaw);

        const r2 = await fetch(h.url, { method: "POST", headers: pluginHeaders(conv), body: JSON.stringify({ model: MODEL, stream: true, session_id: conv, instructions: INSTRUCTIONS, input: [...tailInput(), { type: "message", role: "user", content: "next turn __FAIL_UPSTREAM__ padding" }] }) });
        assert.ok(r2.status >= 500, `the later turn surfaces the synthetic upstream failure (got ${r2.status})`);
        await r2.text();

        const s = findSession(conv, "pi")!;
        const b = boundaryOf(s);
        assert.equal(b.pending, false, "a later upstream failure must NOT re-open the consumed boundary");
        assert.ok((b.archivedBlocks ?? []).length >= 1, "the pre-compaction archive survives the later failure");
        assert.ok(maxRefIndex(s.state.messageRefs.byRaw) >= okMaxRef,
            `the ref high-water survives the later failure (${okMaxRef}→${maxRefIndex(s.state.messageRefs.byRaw)})`);
    } finally {
        await h.close();
    }
});
