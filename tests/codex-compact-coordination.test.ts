import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { resolveStaticWindow, type ProviderRoutes } from "../src/config.ts";
import { codexModelWindow, isCodexClient } from "../src/codex-models.ts";
import { codexBudgetArgs } from "../src/launcher.ts";
import type { ClientConfig } from "../src/client-config.ts";
import { applyCodexWindowClamp, rewriteForgedCompactions, startServer, type ProxyOptions } from "../src/server.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";

// #320: codex compression-budget coordination (PR-D launcher injection,
// PR-E1 window clamp, PR-C semantic rebasing gate, PR-E2 conditional
// interception + forge).

const CODEX_HEADERS: Record<string, string> = { "x-codex-turn-metadata": "sess=1;thread=1;turn=1" };

function makeBlock(blockId: string, summary: string, topic?: string) {
    return {
        blockId,
        runId: "r1",
        tier: 1 as const,
        ...(topic ? { topic } : {}),
        summary,
        directMessageIds: [],
        effectiveMessageIds: [],
        directBlockIds: [],
        compressedTokens: 1000,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young" as const,
        active: true,
    };
}

test("snapshot: src/codex-models-snapshot.json ships a usable model table", () => {
    const snap = JSON.parse(fs.readFileSync(new URL("../src/codex-models-snapshot.json", import.meta.url), "utf8")) as {
        models: Record<string, { context_window?: number; max_context_window?: number }>;
    };
    assert.ok(snap.models && Object.keys(snap.models).length > 0, "snapshot must ship at least one model");
    for (const [slug, entry] of Object.entries(snap.models)) {
        const w = entry.context_window ?? entry.max_context_window;
        assert.ok(typeof w === "number" && w > 0, `model ${slug} must carry a positive window`);
    }
    assert.ok(fs.existsSync(new URL("../scripts/update-codex-models-snapshot.mjs", import.meta.url)), "refresh script must exist");
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    assert.ok(pkg.scripts["codex:snapshot"], "package.json must wire the codex:snapshot script");
});

test("codexModelWindow: in-table / out-of-table / undefined", () => {
    assert.equal(codexModelWindow("gpt-5.5"), 272_000);
    assert.equal(codexModelWindow("gpt-5.4"), 272_000);
    assert.equal(codexModelWindow("qwen3.8-27b"), undefined);
    assert.equal(codexModelWindow(""), undefined);
    assert.equal(codexModelWindow(undefined), undefined);
});

test("isCodexClient: keyed on x-codex-turn-metadata presence", () => {
    assert.equal(isCodexClient(CODEX_HEADERS), true);
    assert.equal(isCodexClient({}), false);
    assert.equal(isCodexClient({ "x-session-id": "x" }), false);
});

test("applyCodexWindowClamp: in-table clamp / user-override / out-of-table / non-codex / native missing", () => {
    assert.deepEqual(applyCodexWindowClamp(1_000_000, "gpt-5.5", CODEX_HEADERS), { window: 272_000, clamped: true });
    assert.deepEqual(applyCodexWindowClamp(200_000, "gpt-5.5", CODEX_HEADERS), { window: 200_000, clamped: false });
    assert.deepEqual(applyCodexWindowClamp(1_000_000, "qwen3.8-27b", CODEX_HEADERS), { window: 1_000_000, clamped: false });
    assert.deepEqual(applyCodexWindowClamp(1_000_000, "gpt-5.5", {}), { window: 1_000_000, clamped: false });
    assert.deepEqual(applyCodexWindowClamp(undefined, "gpt-5.5", CODEX_HEADERS), { window: 272_000, clamped: true });
    assert.deepEqual(applyCodexWindowClamp(undefined, "qwen3.8-27b", CODEX_HEADERS), { window: undefined, clamped: false });
});

test("resolveStaticWindow: source precedence launcher > registry > config > table", () => {
    setRegistryForTest({ "reg-model": { limit: { context: 200_000 } } });
    const routes = { "http://r.example": { models: { "cfg-model": { context: 150_000 } } } } as unknown as ProviderRoutes;
    assert.deepEqual(resolveStaticWindow("any-model", undefined, routes, undefined, { "any-model": 999 }), { window: 999, source: "launcher" });
    assert.deepEqual(resolveStaticWindow("reg-model", "h.example", routes, undefined, undefined), { window: 200_000, source: "registry" });
    assert.deepEqual(resolveStaticWindow("cfg-model", undefined, routes, "http://r.example/v1", undefined), { window: 150_000, source: "config" });
    assert.deepEqual(resolveStaticWindow("claude-opus-4", undefined, {}, undefined, undefined), { window: 200_000, source: "table" });
    assert.equal(resolveStaticWindow("zzz-unknown-model", undefined, {}, undefined, undefined), undefined);
    assert.equal(resolveStaticWindow(undefined, undefined, {}, undefined, undefined), undefined);
});

test("codexBudgetArgs: no codex model → no args", () => {
    assert.deepEqual(codexBudgetArgs({} as ClientConfig), []);
    assert.deepEqual(codexBudgetArgs({ codex: {} } as ClientConfig), []);
});

test("codexBudgetArgs: min(bili window, codex table) — in-table model", () => {
    const cfg: ClientConfig = {
        codex: {
            model: "gpt-5.5",
            modelProvider: "prov",
            providers: { prov: { baseUrl: "http://127.0.0.1:9999/v1" } },
            modelWindows: [{ id: "gpt-5.5", contextWindow: 500_000 }],
        },
    };
    assert.deepEqual(codexBudgetArgs(cfg), ["-c", "model_context_window=272000", "-c", "model_auto_compact_token_limit=272000"]);
});

test("codexBudgetArgs: user override below codex table wins", () => {
    const cfg: ClientConfig = {
        codex: {
            model: "gpt-5.5",
            providers: { prov: { baseUrl: "http://127.0.0.1:9999/v1" } },
            modelWindows: [{ id: "gpt-5.5", contextWindow: 200_000 }],
        },
    };
    assert.deepEqual(codexBudgetArgs(cfg), ["-c", "model_context_window=200000", "-c", "model_auto_compact_token_limit=200000"]);
});

test("codexBudgetArgs: model outside codex table → bili window as-is", () => {
    const cfg: ClientConfig = {
        codex: {
            model: "qwen3.8-27b",
            openaiBaseUrl: "http://127.0.0.1:9999/v1",
            modelWindows: [{ id: "qwen3.8-27b", contextWindow: 262_144 }],
        },
    };
    assert.deepEqual(codexBudgetArgs(cfg), ["-c", "model_context_window=262144", "-c", "model_auto_compact_token_limit=262144"]);
});

test("rewriteForgedCompactions: forged id → developer message; unknown id untouched", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    const s = getSession("t-forge-rewrite", { protocol: "responses" });
    s.metadata.forgedCompactions = { cmp_1: "SUMMARY-TEXT" };
    const input: unknown[] = [
        { type: "message", id: "m1", role: "user", content: "hi" },
        { type: "compaction", id: "cmp_1", encrypted_content: "whatever" },
        { type: "compaction", id: "cmp_unknown", encrypted_content: "real" },
    ];
    const n = rewriteForgedCompactions(input, s);
    assert.equal(n, 1);
    assert.deepEqual(input[1], { type: "message", role: "developer", content: "SUMMARY-TEXT" });
    assert.equal((input[2] as { id: string }).id, "cmp_unknown");
});

test("rewriteForgedCompactions: non-array / no map → 0", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    const s = getSession("t-forge-rewrite2", { protocol: "responses" });
    assert.equal(rewriteForgedCompactions("nope", s), 0);
    assert.equal(rewriteForgedCompactions([{ type: "compaction", id: "x" }], s), 0);
});

type Seen = { url: string; body: any; headers: http.IncomingHttpHeaders }[];

function startUpstream(handler: (body: any, url: string, res: http.ServerResponse) => void): Promise<{ port: number; seen: Seen; close: () => Promise<void> }> {
    const seen: Seen = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw ? JSON.parse(raw) : undefined;
            seen.push({ url: req.url ?? "", body, headers: req.headers });
            handler(body, req.url ?? "", res);
        });
    });
    return new Promise((resolve) => {
        upstream.listen(0, "127.0.0.1", () => {
            resolve({
                port: (upstream.address() as { port: number }).port,
                seen,
                close: () => new Promise<void>((res, rej) => { upstream.close((e) => (e ? rej(e) : res())); }),
            });
        });
    });
}

function sseEvent(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responsesCompletedSse(usage: { input_tokens: number; output_tokens: number; total_tokens: number }): string {
    return sseEvent("response.completed", {
        type: "response.completed",
        response: { id: "resp_up_1", status: "completed", output: [], usage },
    });
}

async function startProxy(t: test.TestContext, modelContextLimit: number): Promise<{ url: (p: string) => string; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit,
        kernelConfig: defaultConfig(modelContextLimit),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-session-id",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    return { url: (p: string) => `http://127.0.0.1:${port}/bili/${p}`, close: () => new Promise<void>((res, rej) => { proxy.close((e) => (e ? rej(e) : res())); }) };
}

async function post(url: string, body: unknown, sessionId: string, extra?: Record<string, string>): Promise<{ status: number; text: string }> {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": sessionId, ...extra },
        body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
}

function parseSse(text: string): { type: string; data: any }[] {
    const out: { type: string; data: any }[] = [];
    for (const block of text.split("\n\n")) {
        const ev = block.match(/^event: (.+)$/m);
        const data = block.match(/^data: (.+)$/m);
        if (ev && data) {
            try { out.push({ type: ev[1]!.trim(), data: JSON.parse(data[1]!) }); } catch { /* keep only well-formed events */ }
        }
    }
    return out;
}

test("e2e PR-E2 kill-switch pass (default): compaction request reaches upstream unmodified", async (t) => {
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesCompletedSse({ input_tokens: 100, output_tokens: 5, total_tokens: 105 }));
    });
    const proxy = await startProxy(t, 200_000);
    const url = proxy.url(`http://127.0.0.1:${upstream.port}/v1/responses`);

    const r1 = await post(url, { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "hello" }] }, "cs-pass", CODEX_HEADERS);
    assert.equal(r1.status, 200);

    const r2 = await post(url, {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "hello" }, { type: "message", role: "assistant", content: "ok" }, { type: "compaction_trigger" }],
    }, "cs-pass", CODEX_HEADERS);
    assert.equal(r2.status, 200);

    assert.equal(upstream.seen.length, 2, "both turns must reach the upstream in pass mode");
    const lastInput = upstream.seen[1]!.body.input as { type?: string }[];
    assert.equal(lastInput[lastInput.length - 1]!.type, "compaction_trigger", "read-only projection keeps the trigger final");
    assert.equal(peekSession("cs-pass")?.metadata.forgedCompactions, undefined, "no forge records in pass mode");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-E2 intercept + healthy ACP: V2 trigger request forged, upstream untouched, summary replayed next turn", async (t) => {
    process.env.BILI_CODEX_COMPACT = "intercept";
    t.after(() => { delete process.env.BILI_CODEX_COMPACT; });
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesCompletedSse({ input_tokens: 100, output_tokens: 5, total_tokens: 105 }));
    });
    const proxy = await startProxy(t, 200_000);
    const url = proxy.url(`http://127.0.0.1:${upstream.port}/v1/responses`);

    const session = getSession("forge-v2", { protocol: "responses" });
    session.stats.lastInputTokens = 1000;
    session.state.blocks = [makeBlock("b1", "SUMMARY-ONE"), makeBlock("b2", "SUMMARY-TWO", "topic-two")];

    const r = await post(url, {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "go" }, { type: "compaction_trigger" }],
    }, "forge-v2", CODEX_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(upstream.seen.length, 0, "intercepted request must NOT reach the upstream");

    const events = parseSse(r.text);
    const done = events.find((e) => e.type === "response.output_item.done");
    assert.ok(done, "forged stream must carry response.output_item.done");
    assert.equal(done!.data.item.type, "compaction");
    assert.equal(done!.data.item.encrypted_content, "SUMMARY-ONE\n\n## topic-two\nSUMMARY-TWO");
    assert.ok(done!.data.item.id.startsWith("cmp_"));
    const completed = events.find((e) => e.type === "response.completed");
    assert.ok(completed, "forged stream must end with response.completed");
    assert.ok(completed!.data.response.id.startsWith("resp_"));
    assert.ok(completed!.data.response.usage.total_tokens > 0);

    const cmpId: string = done!.data.item.id;
    const after = peekSession("forge-v2")!;
    assert.equal(after.state.blocks.length, 0, "ACP state must be reset by the forge");
    const forged = after.metadata.forgedCompactions as Record<string, string>;
    assert.equal(forged[cmpId], "SUMMARY-ONE\n\n## topic-two\nSUMMARY-TWO");

    const r3 = await post(url, {
        model: "gpt-5.5",
        stream: true,
        input: [
            { type: "compaction", id: cmpId, encrypted_content: "SUMMARY-ONE\n\n## topic-two\nSUMMARY-TWO" },
            { type: "message", role: "user", content: "next" },
        ],
    }, "forge-v2", CODEX_HEADERS);
    assert.equal(r3.status, 200);
    assert.equal(upstream.seen.length, 1, "the follow-up turn reaches the upstream");
    const fwd = upstream.seen[0]!.body.input as { type?: string; role?: string; content?: string }[];
    assert.ok(!fwd.some((i) => i.type === "compaction"), "forged compaction item must not be forwarded");
    const dev = fwd.find((i) => i.role === "developer");
    assert.ok(dev, "summary must be replayed as a developer message");
    assert.ok(dev!.content.includes("SUMMARY-ONE\n\n## topic-two\nSUMMARY-TWO"), "summary must be carried by the replayed developer message");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-E2 intercept + healthy ACP: V1 /responses/compact forged as JSON", async (t) => {
    process.env.BILI_CODEX_COMPACT = "intercept";
    t.after(() => { delete process.env.BILI_CODEX_COMPACT; });
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ output: [] }));
    });
    const proxy = await startProxy(t, 200_000);
    const url = compactUrl(proxy, upstream.port);

    const session = getSession("forge-v1", { protocol: "responses" });
    session.stats.lastInputTokens = 1000;
    session.state.blocks = [makeBlock("b1", "V1-SUMMARY")];

    const r = await post(url, { model: "gpt-5.5", input: [{ type: "message", role: "user", content: "go" }] }, "forge-v1", CODEX_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(upstream.seen.length, 0, "intercepted compact request must NOT reach the upstream");
    const body = JSON.parse(r.text) as { output: { type: string; id: string; encrypted_content: string }[] };
    assert.equal(body.output.length, 1);
    assert.equal(body.output[0]!.type, "compaction");
    assert.equal(body.output[0]!.encrypted_content, "V1-SUMMARY");
    assert.ok(body.output[0]!.id.startsWith("cmp_"));
    await proxy.close();
    await upstream.close();
});

test("e2e PR-E2 intercept + unhealthy ACP (no state): passes through", async (t) => {
    process.env.BILI_CODEX_COMPACT = "intercept";
    t.after(() => { delete process.env.BILI_CODEX_COMPACT; });
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesCompletedSse({ input_tokens: 100, output_tokens: 5, total_tokens: 105 }));
    });
    const proxy = await startProxy(t, 200_000);
    const url = proxy.url(`http://127.0.0.1:${upstream.port}/v1/responses`);

    const r = await post(url, {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "go" }, { type: "compaction_trigger" }],
    }, "forge-unhealthy", CODEX_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(upstream.seen.length, 1, "unhealthy ACP state must fall through to native compaction");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-E2 intercept + over-limit steady state: passes through", async (t) => {
    process.env.BILI_CODEX_COMPACT = "intercept";
    t.after(() => { delete process.env.BILI_CODEX_COMPACT; });
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesCompletedSse({ input_tokens: 100, output_tokens: 5, total_tokens: 105 }));
    });
    const proxy = await startProxy(t, 200_000);
    const url = proxy.url(`http://127.0.0.1:${upstream.port}/v1/responses`);

    const session = getSession("forge-over", { protocol: "responses" });
    session.stats.lastInputTokens = 200_001;
    session.state.blocks = [makeBlock("b1", "S")];

    const r = await post(url, {
        model: "zzz-not-in-codex-table",
        stream: true,
        input: [{ type: "message", role: "user", content: "go" }, { type: "compaction_trigger" }],
    }, "forge-over", CODEX_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(upstream.seen.length, 1, "over-limit steady state must fall through to native compaction");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-E2 intercept + non-codex client: passes through", async (t) => {
    process.env.BILI_CODEX_COMPACT = "intercept";
    t.after(() => { delete process.env.BILI_CODEX_COMPACT; });
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesCompletedSse({ input_tokens: 100, output_tokens: 5, total_tokens: 105 }));
    });
    const proxy = await startProxy(t, 200_000);
    const url = proxy.url(`http://127.0.0.1:${upstream.port}/v1/responses`);

    const session = getSession("forge-noncodex", { protocol: "responses" });
    session.stats.lastInputTokens = 1000;
    session.state.blocks = [makeBlock("b1", "S")];

    const r = await post(url, {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "go" }, { type: "compaction_trigger" }],
    }, "forge-noncodex");
    assert.equal(r.status, 200);
    assert.equal(upstream.seen.length, 1, "non-codex clients are never intercepted");
    await proxy.close();
    await upstream.close();
});

function compactUrl(proxy: { url: (p: string) => string }, port: number): string {
    return proxy.url(`http://127.0.0.1:${port}/v1/responses/compact`);
}

async function runCompactOutcome(t: test.TestContext, upstreamPort: number, sessionId: string, sse: string, emptyBody = false): Promise<boolean> {
    const upstream = await startUpstream((_b, _u, res) => {
        if (emptyBody) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end();
        } else {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sse);
        }
    });
    const proxy = await startProxy(t, 200_000);
    const r = await post(compactUrl(proxy, upstreamPort), { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "go" }] }, sessionId);
    assert.equal(r.status, 200);
    await proxy.close();
    await upstream.close();
    return Boolean(peekSession(sessionId)?.metadata.nativeCompactionBoundary);
}

test("e2e PR-C: SSE response.completed → rebase scheduled", async (t) => {
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesCompletedSse({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }));
    });
    const proxy = await startProxy(t, 200_000);
    const r = await post(compactUrl(proxy, upstream.port), { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "go" }] }, "pc-completed");
    assert.equal(r.status, 200);
    assert.ok(peekSession("pc-completed")?.metadata.nativeCompactionBoundary, "completed → rebase scheduled");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-C: SSE response.failed → NOT rebased", async (t) => {
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseEvent("response.failed", { type: "response.failed", response: { id: "resp_x", error: { code: "boom", message: "nope" } } }));
    });
    const proxy = await startProxy(t, 200_000);
    const r = await post(compactUrl(proxy, upstream.port), { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "go" }] }, "pc-failed");
    assert.equal(r.status, 200);
    assert.equal(peekSession("pc-failed")?.metadata.nativeCompactionBoundary, undefined, "failed compaction must not rebase ACP state");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-C: SSE response.incomplete → NOT rebased", async (t) => {
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseEvent("response.incomplete", { type: "response.incomplete", response: { id: "resp_x", incomplete_details: { reason: "max_output_tokens" } } }));
    });
    const proxy = await startProxy(t, 200_000);
    const r = await post(compactUrl(proxy, upstream.port), { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "go" }] }, "pc-incomplete");
    assert.equal(r.status, 200);
    assert.equal(peekSession("pc-incomplete")?.metadata.nativeCompactionBoundary, undefined, "incomplete compaction must not rebase ACP state");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-C: truncated SSE (no terminal event) → NOT rebased", async (t) => {
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseEvent("response.output_item.done", { type: "response.output_item.done", item: { type: "message", role: "assistant", content: "partial" } }));
    });
    const proxy = await startProxy(t, 200_000);
    const r = await post(compactUrl(proxy, upstream.port), { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "go" }] }, "pc-truncated");
    assert.equal(r.status, 200);
    assert.equal(peekSession("pc-truncated")?.metadata.nativeCompactionBoundary, undefined, "truncated stream → unknown outcome → no rebase");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-C: empty-body 200 → NOT rebased", async (t) => {
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end();
    });
    const proxy = await startProxy(t, 200_000);
    const r = await post(compactUrl(proxy, upstream.port), { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "go" }] }, "pc-empty");
    assert.equal(r.status, 200);
    assert.equal(peekSession("pc-empty")?.metadata.nativeCompactionBoundary, undefined, "empty body → unknown outcome → no rebase");
    await proxy.close();
    await upstream.close();
});

test("e2e PR-E1: codex client window clamped to codex table → nudge fires earlier than control", async (t) => {
    const upstream = await startUpstream((_b, _u, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesCompletedSse({ input_tokens: 219_000, output_tokens: 1_000, total_tokens: 220_000 }));
    });
    const proxy = await startProxy(t, 1_000_000);
    const url = proxy.url(`http://127.0.0.1:${upstream.port}/v1/responses`);

    const longText = "x".repeat(20_000);
    const filler: { type: string; role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= 12; i++) {
        filler.push({ type: "message", role: "user", content: `q${i} ` + "f".repeat(997) });
        filler.push({ type: "message", role: "assistant", content: `a${i} ` + "e".repeat(997) });
    }
    const turn2 = {
        model: "gpt-5.5",
        stream: true,
        input: [
            { type: "message", role: "user", content: "hello" },
            { type: "message", role: "assistant", content: "ok" },
            { type: "message", role: "user", content: "continue" },
            { type: "message", role: "assistant", content: longText },
            ...filler,
            { type: "message", role: "user", content: "now summarize" },
        ],
    };

    // Codex client: bili window clamped 1M → 272k (codex table), 220k/272k = 81% > 75% → nudge.
    await post(url, { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "hello" }] }, "e1-codex", CODEX_HEADERS);
    const rc = await post(url, turn2, "e1-codex", CODEX_HEADERS);
    assert.equal(rc.status, 200);

    // Control: no codex header → window stays 1M (table gpt-5 → 400k, still far above 220k/75%) → no nudge.
    await post(url, { model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "hello" }] }, "e1-control");
    const rr = await post(url, turn2, "e1-control");
    assert.equal(rr.status, 200);

    assert.equal(upstream.seen.length, 4);
    const codexFwd = upstream.seen[2]!.body.input as { role?: string; content?: string }[];
    const controlFwd = upstream.seen[3]!.body.input as { role?: string; content?: string }[];
    const codexLast = codexFwd[codexFwd.length - 1]!;
    const controlLast = controlFwd[controlFwd.length - 1]!;
    assert.ok(typeof controlLast.content === "string" && controlLast.content.endsWith("now summarize"), "control (no clamp) must not nudge at 55% of 400k");
    assert.notEqual(codexLast.content, "now summarize", "clamped codex window (272k) must nudge at 81%");
    assert.equal(codexLast.role, "user");
    await proxy.close();
    await upstream.close();
});
