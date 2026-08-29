import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";

// Issue #321 PR-E2: conditional interception + forgery of codex's native
// compaction requests. When BILI_CODEX_COMPACT=intercept, the client is codex,
// and the ACP state is healthy (transform ok + steady-state < 90% + an active
// block to hand off), bili forges a success response and never contacts
// upstream — a deterministic handoff to the ACP state. Otherwise (kill-switch
// off, ACP not keeping up, or nothing compressed yet) the request passes
// through to upstream and native compaction backstops.

const CODEX_UA = "codex_cli_rs/0.1.0 (linux x86_64)";
const SESSION = "trig-sess";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}
function fcEvents(callId: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress", arguments: args }, output_index: 0 }),
    ].join("");
}
// 7 messages × ~4400 chars (~1100 tokens each, ~7700 total). Below the 10k
// window so preflight never fires; above the recent-tail protection so
// m00001/m00002 are compressible by the model.
function conversation() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 7; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(290) });
    }
    return input;
}

type Harness = {
    proxy: http.Server;
    upstream: http.Server;
    bodies: string[];
    url: string;
    compactUrl: string;
};

async function withHarness(opts: { mode?: string; firstTurnTokens: number }, fn: (h: Harness) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            if ((req.url ?? "").includes("/responses/compact")) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output: [] }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (bodies.length === 1) {
                // First turn: the model compresses the oldest pair → active block.
                const compressArgs = JSON.stringify({
                    content: [{ startId: "m00001", endId: "m00002", topic: "setup", summary: "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }],
                });
                res.write(fcEvents("call_p", compressArgs));
            }
            res.write(completed(opts.firstTurnTokens));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    if (opts.mode === undefined) delete process.env.BILI_CODEX_COMPACT;
    else process.env.BILI_CODEX_COMPACT = opts.mode;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1`;
    const h: Harness = { proxy, upstream, bodies, url: `${base}/responses`, compactUrl: `${base}/responses/compact` };
    try {
        await fn(h);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
        delete process.env.BILI_CODEX_COMPACT;
    }
}

// Turn 1: a normal turn where the model compresses the oldest pair, leaving an
// active block. Returns the upstream-request count after setup.
async function setupCompressedSession(h: Harness): Promise<number> {
    const r1 = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: SESSION, instructions: "You are the test coding agent.", input: conversation() }),
    });
    assert.equal(r1.status, 200);
    await r1.text();
    const s = listSessions().find((x) => x.meta.label === SESSION);
    assert.ok(s, "session exists");
    assert.ok((s!.state.blocks ?? []).some((b) => b.active), "setup created an active block");
    return h.bodies.length;
}

test("e2e E2 (trigger form): intercept + healthy ACP → forged 2-frame SSE, upstream untouched", async () => {
    await withHarness({ mode: "intercept", firstTurnTokens: 1000 }, async (h) => {
        const afterSetup = await setupCompressedSession(h);
        const s = listSessions().find((x) => x.meta.label === SESSION)!;
        assert.ok(s.stats.lastInputTokens < 9000, "low steady-state usage → gate passes");

        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: SESSION, instructions: "You are the test coding agent.", input: [...conversation(), { type: "compaction_trigger" }] }),
        });
        assert.equal(r2.status, 200, "intercepted compact returns 200");
        assert.equal(r2.headers.get("content-type"), "text/event-stream", "forged SSE");
        const frames = (await r2.text()).split("\n\n").filter((f) => f.startsWith("data: "));
        assert.equal(frames.length, 2, "exactly two data frames");
        const e1 = JSON.parse(frames[0]!.slice("data: ".length)) as { type: string; item: { type: string; id: string; encrypted_content: string } };
        assert.equal(e1.type, "response.output_item.done");
        assert.equal(e1.item.type, "compaction");
        assert.ok(e1.item.id.startsWith("fc_bili_"), "bili compaction id prefix");
        assert.ok(e1.item.encrypted_content.startsWith("bili:acp:"), "sentinel in blob");
        const e2 = JSON.parse(frames[1]!.slice("data: ".length)) as { type: string; response: { id: string; usage: { total_tokens: number } } };
        assert.equal(e2.type, "response.completed");
        assert.ok(e2.response.id.startsWith("resp_bili_"), "forged response id");

        assert.equal(h.bodies.length, afterSetup, "upstream NOT contacted for the intercepted compact");
    });
});

test("e2e E2 (trigger form): kill-switch off (default) → forwarded to upstream", async () => {
    await withHarness({ mode: undefined, firstTurnTokens: 1000 }, async (h) => {
        const afterSetup = await setupCompressedSession(h);
        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: SESSION, instructions: "You are the test coding agent.", input: [...conversation(), { type: "compaction_trigger" }] }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(h.bodies.length, afterSetup + 1, "compact request forwarded to upstream");
    });
});

test("e2e E2 (trigger form): intercept + ACP not keeping up (≥90%) → forwarded (native backstop)", async () => {
    await withHarness({ mode: "intercept", firstTurnTokens: 15000 }, async (h) => {
        const afterSetup = await setupCompressedSession(h);
        const s = listSessions().find((x) => x.meta.label === SESSION)!;
        assert.ok(s.stats.lastInputTokens >= 9000, "high steady-state usage → gate fails");
        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: SESSION, instructions: "You are the test coding agent.", input: [...conversation(), { type: "compaction_trigger" }] }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(h.bodies.length, afterSetup + 1, "unhealthy ACP → compact forwarded to upstream");
    });
});

test("e2e E2 (trigger form): intercept + nothing compressed yet → forwarded (no summary to hand off)", async () => {
    await withHarness({ mode: "intercept", firstTurnTokens: 1000 }, async (h) => {
        // Fresh session, no setup compression — the compact request is the first.
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "fresh-sess", instructions: "You are the test coding agent.", input: [...conversation(), { type: "compaction_trigger" }] }),
        });
        assert.equal(r.status, 200);
        const text = await r.text();
        assert.ok(!text.includes("fc_bili_"), "no active block → compact NOT forged (forwarded to upstream)");
        assert.ok(!text.includes("resp_bili_"), "no forged response id");
        assert.ok(h.bodies.length >= 1, "compact request reached upstream");
    });
});

test("e2e E2 (trigger form): post-forge turn — echo replaced by a history-borne handoff; dev re-injection only when the echo is absent", async () => {
    await withHarness({ mode: "intercept", firstTurnTokens: 1000 }, async (h) => {
        const afterSetup = await setupCompressedSession(h);

        // Turn 2: codex native auto-compact trigger → intercepted + forged.
        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: SESSION, instructions: "You are the test coding agent.", input: [...conversation(), { type: "compaction_trigger" }] }),
        });
        assert.equal(r2.status, 200);
        const frames = (await r2.text()).split("\n\n").filter((f) => f.startsWith("data: "));
        const e1 = JSON.parse(frames[0]!.slice("data: ".length)) as { item: { type: string; id: string; encrypted_content: string } };
        assert.equal(e1.item.type, "compaction", "forge returned the compaction item");

        // Turn 3: codex replays [forged compaction item, retained tail, new
        // turn]. The echo is REPLACED by a summary-carrying user message — a
        // history-borne handoff the kernel can fold again — and the developer
        // re-injection is suppressed for this turn to avoid duplication.
        const r3 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: SESSION, instructions: "You are the test coding agent.", input: [e1.item, ...conversation().slice(-2), { type: "message", role: "user", content: "continue the work" }] }),
        });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(h.bodies.length, afterSetup + 1, "post-forge turn forwarded to upstream exactly once");

        const s = listSessions().find((x) => x.meta.label === SESSION)!;
        const captured = s.metadata.codexForgedSummaries as string[] | undefined;
        assert.ok(Array.isArray(captured) && captured.length > 0, "forge captured the active block summaries");
        assert.ok(captured.some((t) => t.includes("MAIN-SUMMARY-SETUP")), "captured summary is the setup block's");

        const fwd = h.bodies[h.bodies.length - 1];
        assert.ok(!fwd.includes("fc_bili_"), "echoed bili compaction item replaced before forwarding");
        const fwdBody = JSON.parse(fwd) as { input: Array<{ type: string; role?: string; content?: unknown }> };
        const handoff = fwdBody.input.find((i) => JSON.stringify(i).includes("[bili] context summary after compaction"));
        assert.ok(handoff, "summary handoff user message present in forwarded input");
        assert.ok(JSON.stringify(handoff).includes("MAIN-SUMMARY-SETUP"), "pre-compaction summary carried by the handoff");
        const dev = fwdBody.input.find((i) => i.type === "message" && i.role === "developer");
        assert.ok(!dev || !JSON.stringify(dev).includes("MAIN-SUMMARY-SETUP"), "developer re-injection suppressed while the echo handoff carries the summary");

        // Turn 4: the echo did NOT come back (codex dropped / restarted) —
        // now the captured summaries must surface via the developer-message
        // re-injection fallback instead.
        const r4 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: SESSION, instructions: "You are the test coding agent.", input: [...conversation().slice(-2), { type: "message", role: "user", content: "still here" }] }),
        });
        assert.equal(r4.status, 200);
        await r4.text();
        const fwd4 = h.bodies[h.bodies.length - 1];
        const fwd4Body = JSON.parse(fwd4) as { input: Array<{ type: string; role?: string; content?: unknown }> };
        const dev4 = fwd4Body.input.find((i) => i.type === "message" && i.role === "developer");
        assert.ok(dev4, "developer message present when the echo is absent");
        assert.ok(JSON.stringify(dev4).includes("MAIN-SUMMARY-SETUP"), "captured summary re-injected via the fallback path");
    });
});

test("e2e E2 (endpoint form): intercept + healthy ACP → forged JSON {output}, upstream untouched", async () => {
    await withHarness({ mode: "intercept", firstTurnTokens: 1000 }, async (h) => {
        const afterSetup = await setupCompressedSession(h);
        const r2 = await fetch(h.compactUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: false, session_id: SESSION, instructions: "You are the test coding agent.", input: conversation() }),
        });
        assert.equal(r2.status, 200, "intercepted endpoint compact returns 200");
        assert.ok((r2.headers.get("content-type") ?? "").includes("application/json"), "forged JSON");
        const parsed = JSON.parse(await r2.text()) as { output: unknown[] };
        assert.ok(Array.isArray(parsed.output), "output is an array");
        assert.ok(parsed.output.length > 0, "output carries the compacted history");
        assert.equal(h.bodies.length, afterSetup, "upstream NOT contacted for the intercepted endpoint compact");
    });
});
