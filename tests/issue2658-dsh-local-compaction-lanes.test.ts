// #2658: the #2432 single-turn rebase (dsh native compaction landing without
// transiting bili → detect checkpoint framing + decimated fold coverage →
// mark+reconcile in-turn) shipped only on the openai and responses wires.
// The anthropic wire had NO recovery at all: a landed checkpoint left ACP
// state unrebased, syncBlocks kept partially-alive blocks forever, and every
// later compress failed "cannot be anchored" (the #2432 death spiral); the
// google wire had the identical gap. This suite pins the ported detector on
// both wires: positive rebase per wire, plus the anthropic double-record
// guard (a classified dsh compaction must NOT also log as
// "unannounced-rewrite") and the no-framing negative (gap alone is ordinary
// churn).

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

const MODEL = "deepseek-flash";

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    bodies: string[];
    close: () => Promise<void>;
};

async function startRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const promptTokens = Math.max(1, Math.round(raw.length / 4));
            const url = req.url ?? "";
            res.writeHead(200, { "content-type": "application/json" });
            if (url.includes("/v1/messages")) {
                res.end(JSON.stringify({
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    model: MODEL,
                    content: [{ type: "text", text: "ok" }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: promptTokens, output_tokens: 3 },
                }));
            } else if (url.includes(":generateContent")) {
                res.end(JSON.stringify({
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP", index: 0 }],
                    modelVersion: MODEL,
                    usageMetadata: { promptTokenCount: promptTokens, cachedContentTokenCount: 0, candidatesTokenCount: 3, totalTokenCount: promptTokens + 3 },
                }));
            } else {
                res.end(JSON.stringify({
                    id: "chatcmpl-1",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
                }));
            }
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
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

const anthropicUrl = (rig: Rig) => `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
const googleUrl = (rig: Rig) => `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1beta/models/${MODEL}:generateContent`;

function dshHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}

// 14 messages sized like the #2432 fixture: the kernel protects the last 5,
// so folding m00001–m00009 covers 9 ids (> the 8-id floor).
function seedInput() {
    return Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
}

function checkpointText() {
    return `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. The work established the harness, drove one fold, and then dsh compacted natively. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`;
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

async function seedAndFold(rig: Rig, conv: string, url: string, body: (messages: { role: string; content: string }[]) => unknown): Promise<void> {
    const r1 = await fetch(url, {
        method: "POST",
        headers: dshHeaders(conv),
        body: JSON.stringify(body(seedInput())),
    });
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const s = getSession(conv);
    assert.ok(s, "seed session exists under the conversation key");
    assert.equal(s!.metadata["pluginAgent"], "dsh", "session bound to the dsh agent");
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

function assertRebased(conv: string, rig: Rig): void {
    const s = getSession(conv)!;
    assert.equal((s.state.blocks ?? []).length, 0, "block list empty after the rebase reset");
    const boundary = s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean } | undefined;
    assert.ok(boundary, "native-compaction boundary recorded");
    assert.equal(boundary?.pendingRebase, false, "rebase consumed within the same request");
    assert.ok(s.metadata.nativeCompactionAt, "nativeCompactionAt recorded by the reset");
    assert.equal(Object.keys(s.state.messageRefs.byRaw).length, 3, "refs re-seeded onto exactly the compacted view (checkpoint + 2 retained)");
    const events = conflictEventsOf(s);
    assert.ok(events.some((e) => e.kind === "native-compaction"), "classified as native-compaction in the conflict ledger");
    assert.ok(!events.some((e) => e.kind === "unannounced-rewrite"), "no double-record as unannounced-rewrite beside it");
    const forward = rig.bodies[rig.bodies.length - 1];
    assert.ok(forward.includes(DSH_CHECKPOINT_OPEN_TAG), "checkpoint framing forwarded upstream");
    assert.ok(forward.includes("FILLER_13_"), "retained tail forwarded upstream");
}

test("e2e #2658: dsh replaying [checkpoint, retained tail] on the ANTHROPIC wire rebases the ACP state", async () => {
    const rig = await startRig();
    const conv = "dshc-anthropic-main";
    try {
        await seedAndFold(rig, conv, anthropicUrl(rig), (messages) => ({ model: MODEL, max_tokens: 1024, messages }));
        const s0 = getSession(conv)!;
        const coveredBefore = new Set(s0.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, "precondition: live fold covering >=8 ids");

        const r = await fetch(anthropicUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1024,
                messages: [
                    { role: "user", content: checkpointText() },
                    seedInput()[12],
                    seedInput()[13],
                ],
            }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();
        assertRebased(conv, rig);
    } finally {
        await rig.close();
    }
});

test("e2e #2658: dsh replaying [checkpoint, retained tail] on the GOOGLE wire rebases the ACP state", async () => {
    const rig = await startRig();
    const conv = "dshc-google-main";
    try {
        const toContents = (messages: { role: string; content: string }[]) =>
            messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
        await seedAndFold(rig, conv, googleUrl(rig), (messages) => ({ contents: toContents(messages), generationConfig: { maxOutputTokens: 1024 } }));
        const s0 = getSession(conv)!;
        const coveredBefore = new Set(s0.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, "precondition: live fold covering >=8 ids");

        const r = await fetch(googleUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                contents: toContents([
                    { role: "user", content: checkpointText() },
                    seedInput()[12],
                    seedInput()[13],
                ]),
                generationConfig: { maxOutputTokens: 1024 },
            }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();
        assertRebased(conv, rig);
    } finally {
        await rig.close();
    }
});

test("negative #2658: decimated history WITHOUT checkpoint framing on the anthropic wire stays on the existing paths", async () => {
    const rig = await startRig();
    const conv = "dshc-anthropic-nomarker";
    try {
        await seedAndFold(rig, conv, anthropicUrl(rig), (messages) => ({ model: MODEL, max_tokens: 1024, messages }));
        const r = await fetch(anthropicUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1024,
                messages: [
                    { role: "user", content: "A different rewritten head — no dsh checkpoint framing here. " + "HEAD_.repeat".repeat(40) },
                    seedInput()[12],
                    seedInput()[13],
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
