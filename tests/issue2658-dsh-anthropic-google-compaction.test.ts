// #2658: the #2432 dsh native-compaction rebase landed only on the openai
// (#2432) and responses (#2451) lanes — yet the server-side REFUSAL gate has
// had an anthropic branch all along (dshCompactionRefusal("anthropic")), so
// any checkpoint that LANDS on the anthropic wire (direct-bypass without ALS
// attribution, allowDshCompaction, future gate mismatch) left the ACP state
// permanently unrebased: cannot-be-anchored death spiral + persistent
// prefix-cache loss (#2596 main complaint). prepare-anthropic.ts now runs the
// same dual-signal detector (dsh-bound session + checkpoint framing in resent
// history + fold coverage decimated past DSH_LOCAL_COMPACTION_MIN_MISSING and
// majority-missing) and rebases in the SAME turn; prepare-google.ts closes the
// identical hole on the fourth wire (no known dsh+google traffic yet).
//
// Lane-agnostic negatives (non-dsh binding, foreign producer template) are
// already pinned by the #2432/#2451 fixtures — the gate expression
// (pluginAgent === "dsh" + framing + decimated coverage) is shared across all
// four lanes, so those shapes are re-pinned here per wire only where the lane
// adds its own twist (the anthropic unannounced-rewrite double-record skip).

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
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";

const MODEL_ANTHROPIC = "claude-test";
const MODEL_GOOGLE = "gemini-test";
const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

type Rig = {
    url: string;
    pluginToolUrl: string;
    bodies: string[];
    close: () => Promise<void>;
};

function dshHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}

// 14 messages sized like the #2432/#2451 fixtures: the kernel protects the
// last 5 messages, so folding m00001–m00009 covers 9 ids (> the 8-id floor),
// decimated by the compacted replay below.
function seedText(i: number): string {
    return `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230);
}

function checkpointText(): string {
    return `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. The work established the harness, drove one fold, and then dsh compacted natively. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`;
}

async function startProxy(upstreamPort: number, model: string): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [model]: { context: 30_000 } } } },
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
    return proxy;
}

async function startAnthropicRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const inputTokens = Math.max(1, Math.round(raw.length / 4));
            const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(
                sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } }) +
                sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
                sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
                sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
                sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
                sse("message_stop", { type: "message_stop" }),
            );
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, MODEL_ANTHROPIC);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        pluginToolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`,
        bodies,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

async function startGoogleRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const inputTokens = Math.max(1, Math.round(raw.length / 4));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP", index: 0 }],
                usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: 2, totalTokenCount: inputTokens + 2 },
                modelVersion: MODEL_GOOGLE,
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, MODEL_GOOGLE);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/${MODEL_GOOGLE}:generateContent`,
        pluginToolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`,
        bodies,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

async function seedAndFold(rig: Rig, conv: string, body: Record<string, unknown>): Promise<void> {
    const r1 = await fetch(rig.url, { method: "POST", headers: dshHeaders(conv), body: JSON.stringify(body) });
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const s = getSession(conv);
    assert.ok(s, "seed session exists under the conversation key");
    assert.equal(s!.metadata["pluginAgent"], "dsh", "session bound to the dsh lane");
    assert.ok(Object.keys(s!.state.messageRefs.byRaw).length >= 14, "refs assigned to the seeded history");

    const r2 = await fetch(rig.pluginToolUrl, {
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

function assertRebased(conv: string, rig: Rig): void {
    const s = getSession(conv)!;
    assert.equal((s.state.blocks ?? []).filter((b) => b.active).length, 0, "no active blocks survive the rebase");
    assert.equal((s.state.blocks ?? []).length, 0, "block list empty after the boundary reset");
    const boundary = s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean } | undefined;
    assert.ok(boundary, "native-compaction boundary recorded");
    assert.equal(boundary?.pendingRebase, false, "rebase consumed within the same request");
    assert.ok(s.metadata.nativeCompactionAt, "nativeCompactionAt recorded by the reset");
    assert.equal(Object.keys(s.state.messageRefs.byRaw).length, 3, "refs re-seeded onto exactly the compacted view (checkpoint + 2 retained)");
    const events = conflictEventsOf(s);
    assert.ok(events.some((e) => e.kind === "native-compaction"), "classified as native-compaction in the conflict ledger");
    const forward = rig.bodies[rig.bodies.length - 1];
    assert.ok(forward.includes(DSH_CHECKPOINT_OPEN_TAG), "checkpoint framing forwarded upstream");
    assert.ok(forward.includes("FILLER_13_"), "retained tail forwarded upstream");
}

test("e2e #2658: dsh replaying [checkpoint, retained tail] on /v1/messages rebases the ACP state instead of drifting forever", async () => {
    const rig = await startAnthropicRig();
    const conv = "dshc-ant-main";
    try {
        await seedAndFold(rig, conv, {
            model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true,
            messages: Array.from({ length: 14 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: seedText(i) })),
        });
        const s0 = getSession(conv)!;
        const coveredBefore = new Set(s0.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, "precondition: live fold covering >=8 ids");

        const replay = (): Record<string, unknown> => ({
            model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true,
            messages: [
                { role: "user", content: checkpointText() },
                { role: "user", content: seedText(12) },
                { role: "assistant", content: seedText(13) },
            ],
        });
        const r = await fetch(rig.url, { method: "POST", headers: dshHeaders(conv), body: JSON.stringify(replay()) });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        assertRebased(conv, rig);
        const s = getSession(conv)!;
        assert.ok(!conflictEventsOf(s).some((e) => e.kind === "unannounced-rewrite"), "no double-record as unannounced-rewrite beside the native-compaction entry");

        // The session keeps working afterwards (append + forward).
        const r2 = await fetch(rig.url, { method: "POST", headers: dshHeaders(conv), body: JSON.stringify({ ...replay(), messages: [...replay().messages as unknown[], { role: "user", content: "Post-compaction turn continues fine." }] }) });
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const s2 = getSession(conv)!;
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 4, "refs accumulate append-only after the rebase");
    } finally {
        await rig.close();
    }
});

test("negative #2658: anthropic framing paste while history is intact does NOT rebase", async () => {
    const rig = await startAnthropicRig();
    const conv = "dshc-ant-paste";
    try {
        const seedMessages = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: seedText(i) }));
        await seedAndFold(rig, conv, { model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true, messages: seedMessages });
        const r = await fetch(rig.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true,
                messages: [...seedMessages, { role: "user", content: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} that a colleague pasted into the chat for reference — not a compaction boundary.` }],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok((s.state.blocks ?? []).some((b) => b.active), "full replay keeps the fold — no gap, no rebase");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary without coverage decimation");
    } finally {
        await rig.close();
    }
});

test("negative #2658: anthropic decimated history WITHOUT checkpoint framing stays on the existing paths", async () => {
    const rig = await startAnthropicRig();
    const conv = "dshc-ant-nomarker";
    try {
        await seedAndFold(rig, conv, {
            model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true,
            messages: Array.from({ length: 14 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: seedText(i) })),
        });
        const r = await fetch(rig.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true,
                messages: [
                    { role: "user", content: "A different rewritten head — no dsh checkpoint framing here. " + "HEAD_.repeat".repeat(40) },
                    { role: "user", content: seedText(12) },
                    { role: "assistant", content: seedText(13) },
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no rebase without the checkpoint framing (gap alone is ordinary churn)");
    } finally {
        await rig.close();
    }
});

test("e2e #2658: dsh replaying [checkpoint, retained tail] on generateContent rebases the ACP state instead of drifting forever", async () => {
    const rig = await startGoogleRig();
    const conv = "dshc-gem-main";
    try {
        await seedAndFold(rig, conv, {
            model: MODEL_GOOGLE, generationConfig: { maxOutputTokens: 8192 },
            contents: Array.from({ length: 14 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: seedText(i) }] })),
        });
        const s0 = getSession(conv)!;
        const coveredBefore = new Set(s0.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, "precondition: live fold covering >=8 ids");

        const replay = (): Record<string, unknown> => ({
            model: MODEL_GOOGLE, generationConfig: { maxOutputTokens: 8192 },
            contents: [
                { role: "user", parts: [{ text: checkpointText() }] },
                { role: "user", parts: [{ text: seedText(12) }] },
                { role: "model", parts: [{ text: seedText(13) }] },
            ],
        });
        const r = await fetch(rig.url, { method: "POST", headers: dshHeaders(conv), body: JSON.stringify(replay()) });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        assertRebased(conv, rig);

        // The session keeps working afterwards (append + forward).
        const r2 = await fetch(rig.url, { method: "POST", headers: dshHeaders(conv), body: JSON.stringify({ ...replay(), contents: [...replay().contents as unknown[], { role: "user", parts: [{ text: "Post-compaction turn continues fine." }] }] }) });
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const s2 = getSession(conv)!;
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 4, "refs accumulate append-only after the rebase");
    } finally {
        await rig.close();
    }
});

test("negative #2658: google framing paste while history is intact does NOT rebase", async () => {
    const rig = await startGoogleRig();
    const conv = "dshc-gem-paste";
    try {
        const seedContents = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: seedText(i) }] }));
        await seedAndFold(rig, conv, { model: MODEL_GOOGLE, generationConfig: { maxOutputTokens: 8192 }, contents: seedContents });
        const r = await fetch(rig.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL_GOOGLE, generationConfig: { maxOutputTokens: 8192 },
                contents: [...seedContents, { role: "user", parts: [{ text: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} that a colleague pasted into the chat for reference — not a compaction boundary.` }] }],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok((s.state.blocks ?? []).some((b) => b.active), "full replay keeps the fold — no gap, no rebase");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary without coverage decimation");
    } finally {
        await rig.close();
    }
});

test("negative #2658: google decimated history WITHOUT checkpoint framing stays on the existing paths", async () => {
    const rig = await startGoogleRig();
    const conv = "dshc-gem-nomarker";
    try {
        await seedAndFold(rig, conv, {
            model: MODEL_GOOGLE, generationConfig: { maxOutputTokens: 8192 },
            contents: Array.from({ length: 14 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: seedText(i) }] })),
        });
        const r = await fetch(rig.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL_GOOGLE, generationConfig: { maxOutputTokens: 8192 },
                contents: [
                    { role: "user", parts: [{ text: "A different rewritten head — no dsh checkpoint framing here. " + "HEAD_.repeat".repeat(40) }] },
                    { role: "user", parts: [{ text: seedText(12) }] },
                    { role: "model", parts: [{ text: seedText(13) }] },
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no rebase without the checkpoint framing (gap alone is ordinary churn)");
    } finally {
        await rig.close();
    }
});
