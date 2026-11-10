// The second wire-truth channel: a Codex cloud compaction is visible at the
// moment it happens. When the client opted into server-side compaction on the
// request, the compaction item in the response closes the read-only history
// generation on the SAME turn (no one-turn lag, no dependency on the client
// coming back). A client that replays the checkpoint later — with or without
// dsh-codex-subscription's announcement headers — names the same event and must
// never rebase twice.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, historyGenerationsOf, REF_FLOOR_RAW_ID, type Session } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { refIndex } from "../src/history-generations.ts";

const MODEL = "gpt-resp";
const WINDOW = 30_000;
const INSTRUCTIONS = "You are the test coding agent.";
const FOLD_SUMMARY = "RESPONSE-SIDE-BOUNDARY-SUMMARY-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK";
const COMPACTION_ITEM = { type: "compaction", id: "cmp_resp_1", encrypted_content: `gAAAAAB${"z".repeat(400)}` };
const INPUT_ITEM = { type: "compaction", id: "cmp_input_1", encrypted_content: `gAAAAAC${"y".repeat(400)}` };

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textItem(): string {
    return sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    });
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

type Harness = { url: string; pluginToolUrl: string; bodies: Record<string, unknown>[]; close: () => Promise<void> };

async function startHarness(): Promise<Harness> {
    const bodies: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* non-JSON probe */ }
            bodies.push(parsed);
            const compacting = Array.isArray(parsed.context_management)
                && (parsed.context_management as Array<{ type?: string }>).some((e) => e?.type === "compaction");
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(textItem());
            if (compacting) {
                res.write(sse("response.output_item.done", { type: "response.output_item.done", output_index: 1, item: COMPACTION_ITEM }));
            }
            res.write(completed(900));
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

function messages(from: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({ type: "message", role: (from + i) % 2 === 0 ? "user" : "assistant", content: `message ${from + i} ${"x".repeat(4000)}` }));
}

function body(conv: string, input: unknown[], opts: { compactionRequested?: boolean } = {}): string {
    return JSON.stringify({
        model: MODEL,
        stream: true,
        session_id: conv,
        instructions: INSTRUCTIONS,
        input,
        ...(opts.compactionRequested ? { context_management: [{ type: "compaction", compact_threshold: 1000 }] } : {}),
        tools: [{ type: "function", name: "shell", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    });
}

function pluginHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}

function codexHeaders(conv: string, id: string, seq: number): Record<string, string> {
    return {
        ...pluginHeaders(conv),
        "x-bili-codex-checkpoint": id,
        "x-bili-codex-checkpoint-seq": String(seq),
        "x-bili-codex-checkpoint-state": "reuse",
        "x-bili-codex-checkpoint-covered": "7",
        "x-bili-codex-checkpoint-digest": "0123456789abcdef0123456789abcdef",
    };
}

function findSession(conv: string): Session {
    const session = listSessions().find((s) => s.id === conv || s.meta.label === conv);
    assert.ok(session, "session exists");
    return session!;
}

function mappedRefs(session: Session): string[] {
    return Object.entries(session.state.messageRefs.byRaw)
        .filter(([raw]) => raw !== REF_FLOOR_RAW_ID)
        .map(([, ref]) => ref)
        .sort((a, b) => refIndex(a) - refIndex(b));
}

async function foldRefs(h: Harness, conv: string, refs: string[]): Promise<void> {
    const r = await fetch(h.pluginToolUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: refs[0], endId: refs[refs.length - 1], topic: "folded head", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok && !j.result?.includes("[Compression FAILED") && !j.result?.includes("no-op"), `fold accepted: ${j.result?.slice(0, 200)}`);
}

async function seed(h: Harness, conv: string, headers: Record<string, string>): Promise<Session> {
    await fetch(h.url, { method: "POST", headers, body: body(conv, messages(0, 12)) }).then((r) => r.text());
    const session = findSession(conv);
    await foldRefs(h, conv, mappedRefs(session).slice(0, 7));
    assert.ok(session.state.blocks.some((b) => b.active), "a fold block exists before compaction");
    return session;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${label}`);
}

test("a compaction item in the response closes the generation on the same turn", async () => {
    const h = await startHarness();
    try {
        const conv = "resp-side-conv";
        const seeded = await seed(h, conv, pluginHeaders(conv));
        const firstBlock = seeded.state.blocks.find((b) => b.active)!.blockId;

        const res = await fetch(h.url, {
            method: "POST",
            headers: pluginHeaders(conv),
            body: body(conv, messages(7, 5), { compactionRequested: true }),
        });
        assert.equal(res.status, 200);
        await res.text();
        const session = findSession(conv);
        await waitFor(() => historyGenerationsOf(session).length === 1, "response-time generation close");
        const gens = historyGenerationsOf(session);
        assert.equal(gens.length, 1);
        assert.equal(gens[0].cause, "codex-cloud-compaction");
        assert.equal(gens[0].checkpointId, COMPACTION_ITEM.id);
        assert.deepEqual(gens[0].blockIds, [firstBlock]);
        const record = session.metadata.codexCloudCheckpoint as { id: string; seq: number };
        assert.equal(record.id, COMPACTION_ITEM.id);
        assert.equal(record.seq, 1);
        // The compacting turn itself never gets the archived history resent.
        assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)?.input ?? []), /message 0 /);

        // The replay on the next turn names the same event: no second rebase,
        // old refs still restorable.
        await fetch(h.url, {
            method: "POST",
            headers: codexHeaders(conv, COMPACTION_ITEM.id, 1),
            body: body(conv, [COMPACTION_ITEM, ...messages(7, 5)]),
        }).then((r) => r.text());
        assert.equal(historyGenerationsOf(findSession(conv)).length, 1, "replay does not rebase twice");
        // From the next turn on, the model gets the compact navigation index.
        assert.match(JSON.stringify(h.bodies.at(-1)?.input ?? []), /closed history generation\(s\) are preserved read-only/);
        assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)?.input ?? []), /message 0 /);
        const restored = await fetch(h.pluginToolUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "decompress", args: { blockId: firstBlock, startId: "m00001", endId: "m00002" } }),
        }).then((r) => r.json()) as { ok: boolean; result?: string };
        assert.ok(restored.ok);
        const at = /written to: (\S+)/.exec(restored.result ?? "");
        const text = at ? readFileSync(at[1], "utf8") : restored.result ?? "";
        assert.match(text, /message 0 /);
    } finally {
        await h.close();
    }
});

test("a headerless client that replays a checkpoint still gets the boundary", async () => {
    const h = await startHarness();
    try {
        const conv = "cli-conv";
        const seeded = await seed(h, conv, { "content-type": "application/json", "x-bili-plugin": "codex", "x-bili-plugin-conversation": conv });
        const firstBlock = seeded.state.blocks.find((b) => b.active)!.blockId;
        const res = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "codex", "x-bili-plugin-conversation": conv },
            body: body(conv, [INPUT_ITEM, ...messages(7, 5)]),
        });
        assert.equal(res.status, 200);
        await res.text();
        const gens = historyGenerationsOf(findSession(conv));
        assert.equal(gens.length, 1, "replayed compaction item is a boundary even without headers");
        assert.equal(gens[0].checkpointId, INPUT_ITEM.id);
        assert.deepEqual(gens[0].blockIds, [firstBlock]);
    } finally {
        await h.close();
    }
});

test("bili's own forged carrier never counts as a remote checkpoint", async () => {
    const h = await startHarness();
    try {
        const conv = "forged-conv";
        await seed(h, conv, pluginHeaders(conv));
        const forged = { type: "compaction", id: "fc_bili_1", encrypted_content: "bili:acp:summary-of-the-folded-range" };
        await fetch(h.url, { method: "POST", headers: pluginHeaders(conv), body: body(conv, [forged, ...messages(7, 5)]) }).then((r) => r.text());
        assert.equal(historyGenerationsOf(findSession(conv)).length, 0, "the summary handoff is not a remote boundary");
    } finally {
        await h.close();
    }
});
