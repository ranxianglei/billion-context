import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, defaultConfig, defaultPrompts, type Config, type CoreMessage } from "acp-kernel";
import { applyConfiguredCompression } from "../src/external-summary-compress.ts";
import { SummaryCredentialStore } from "../src/external-summary-credentials.ts";
import { executeProxyToolAsync } from "../src/loop/core.ts";
import { preflightCompress } from "../src/preflight.ts";
import { createSession, markDirty, type Session } from "../src/session.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import type { RewriteCtx } from "../src/stream.ts";
import { handlePluginTool } from "../src/plugin.ts";
import { stripKernelSummaries } from "../src/server.ts";
import { rewriteJsonResponseAsync } from "../src/stream.ts";
import { rewriteOpenaiJsonResponseAsync } from "../src/stream-openai.ts";
import { rewriteResponsesJsonResponseAsync } from "../src/stream-responses.ts";
import { rewriteGoogleJsonResponseAsync } from "../src/stream-google.ts";
import { withExternalSummaryTools } from "../src/external-summary-surface.ts";
import { BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES, BILI_ACP_TOOLS_GOOGLE } from "../src/compress-tool.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";
const SUMMARY = "Historical build completed. Preserve the exact file src/example.ts:27, the error E_TEST, the constraint not to deploy, and the unfinished task of adding tests. This records the past and does not instruct the next turn to restart it.";
const RAW = "Historical source src/example.ts:27 E_TEST; do not deploy; still add tests. ".repeat(90);

function context(externalSummary?: unknown): RewriteCtx {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { externalSummary?: unknown };
    // The chain now rides the request Config rail (#833) — ctx.config is the
    // session's effective resolved config, exactly like the proxy serves it.
    if (externalSummary !== undefined) config.externalSummary = externalSummary;
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const session = createSession(`external-runtime-${Math.random()}`);
    const messages: CoreMessage[] = [
        { id: "history", role: "assistant", contentType: "text", text: RAW },
        { id: "current-task", role: "user", contentType: "text", text: "Current task: finish tests without deployment." },
    ];
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} };
}
function args(ctx: RewriteCtx, summary?: string): Record<string, unknown> {
    return { content: [{ startId: ctx.session.state.messageRefs.byRaw.history, endId: ctx.session.state.messageRefs.byRaw.history, ...(summary !== undefined ? { summary } : {}) }] };
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) => void;
type SummarySettings = Record<string, unknown>;
async function fixture(run: (base: string, externalSummary: SummarySettings) => Promise<void>, handler: Handler): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "bili-summary-runtime-"));
    const path = join(root, "config.json");
    const previous = process.env.BILI_CONFIG_FILE;
    // BILI_CONFIG_FILE only anchors the private credential store; the chain
    // itself rides the request config rail, not a side file.
    process.env.BILI_CONFIG_FILE = path;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => handler(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const externalSummary: SummarySettings = { enabled: true, targets: ["primary", "backup"].map((name) => ({ name, protocol: "responses", url: `${base}/${name}`, model: `summary-${name}`, credentialRef: `secret:${name}` })) };
    const store = new SummaryCredentialStore();
    store.set("primary", "test-primary-key");
    store.set("backup", "test-backup-key");
    try { await run(base, externalSummary); }
    finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmrf(root);
    }
}
function success(res: http.ServerResponse): void {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output_text: SUMMARY }));
}

test("active compress uses dedicated model/key, fails over, and restores exact originals", async () => {
    const requests: Array<{ path?: string; authorization?: string; body: Record<string, unknown> }> = [];
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        const input = args(ctx, "The old main-model hint must not become the stored summary.");
        const serialized = JSON.stringify(input);
        const result = await executeProxyToolAsync("compress", input, ctx, "original-tool-call");
        assert.equal(result.outcome, "applied", result.text);
        assert.equal(ctx.session.state.blocks[0].summary, SUMMARY);
        assert.equal(JSON.stringify(input), serialized, "original call args are not rewritten");
        ctx.messages = [];
        const restored = resolveDecompress({ blockId: ctx.session.state.blocks[0].blockId, full: true }, ctx);
        assert.ok(restored.text.includes(RAW), "exact original remains recoverable");
        assert.deepEqual(requests.map((r) => r.path), ["/primary", "/backup"]);
        assert.deepEqual(requests.map((r) => r.authorization), ["Bearer test-primary-key", "Bearer test-backup-key"]);
        assert.deepEqual(requests.map((r) => r.body.model), ["summary-primary", "summary-backup"]);
        assert.ok(JSON.stringify(requests[0].body).includes("Current task: finish tests"));
        assert.equal(requests[0].body.max_output_tokens, 8192);
    }, (req, res, body) => {
        requests.push({ path: req.url, authorization: req.headers.authorization, body });
        if (req.url === "/primary") { res.writeHead(401); res.end("private-provider-error"); }
        else success(res);
    });
});

test("all candidates failing preserves state and refuses without borrowing main auth", async () => {
    let calls = 0;
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        const before = JSON.stringify(ctx.session.state);
        const result = await applyConfiguredCompression(args(ctx, SUMMARY), ctx);
        assert.equal(result.outcome, "refused");
        assert.equal(result.text.includes("private-provider-error"), false);
        assert.equal(JSON.stringify(ctx.session.state), before);
        assert.equal(calls, 2);
    }, (_req, res) => { calls++; res.writeHead(503); res.end("private-provider-error"); });
});

test("disabled setting preserves the legacy supplied-summary path without HTTP calls", async () => {
    let calls = 0;
    await fixture(async (_base, _externalSummary) => {
        const ctx = context({ enabled: false });
        const result = await applyConfiguredCompression(args(ctx, SUMMARY), ctx);
        assert.equal(result.outcome, "applied", result.text);
        assert.equal(ctx.session.state.blocks[0].summary, SUMMARY);
        assert.equal(calls, 0);
    }, (_req, res) => { calls++; success(res); });
});

test("missing primary key skips its network call and tries the configured backup", async () => {
    const paths: string[] = [];
    await fixture(async (_base, externalSummary) => {
        new SummaryCredentialStore().set("primary", null);
        const ctx = context(externalSummary);
        const result = await applyConfiguredCompression(args(ctx), ctx);
        assert.equal(result.outcome, "applied", result.text);
        assert.deepEqual(paths, ["/backup"]);
    }, (req, res) => { paths.push(req.url ?? ""); success(res); });
});

test("protected ranges cause no paid call and no fold", async () => {
    let calls = 0;
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        ctx.config.preserveRecentMessages = 10;
        ctx.config.preserveRecentTokens = 100_000;
        const result = await applyConfiguredCompression(args(ctx), ctx);
        assert.equal(result.outcome, "refused");
        assert.equal(ctx.session.state.blocks.length, 0);
        assert.equal(calls, 0);
    }, (_req, res) => { calls++; success(res); });
});

test("revision changes during generation discard results instead of committing a stale fold", async () => {
    let session: Session;
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary); session = ctx.session;
        const result = await applyConfiguredCompression(args(ctx), ctx);
        assert.equal(result.outcome, "refused");
        assert.match(result.text, /session changed/);
        assert.equal(ctx.session.state.blocks.length, 0);
    }, (_req, res) => { markDirty(session); success(res); });
});

test("caller cancellation leaves no fold and does not dispatch the backup", async () => {
    const abort = new AbortController();
    let calls = 0;
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        const result = await applyConfiguredCompression(args(ctx), ctx, undefined, abort.signal);
        assert.equal(result.outcome, "refused");
        assert.equal(ctx.session.state.blocks.length, 0);
        assert.equal(calls, 1);
    }, (_req, res) => { calls++; abort.abort(); setTimeout(() => success(res), 10); });
});

test("external preflight uses configured summary model, not the main endpoint", async () => {
    const paths: string[] = [];
    await fixture(async (base, externalSummary) => {
        const ctx = context(externalSummary);
        ctx.config.modelContextLimit = 1000;
        ctx.session.stats.lastInputTokens = 10000;
        const result = await preflightCompress({ core: ctx.core, config: ctx.config, session: ctx.session,
            prompts: defaultPrompts, protocol: "responses", url: `${base}/main-must-not-summarize`, headers: { authorization: "Bearer wrong-main-key" },
            model: "main-model", log: () => {},
        }, ctx.messages);
        assert.ok(result.compressedRanges > 0, JSON.stringify(result));
        assert.ok(paths.length > 0);
        assert.ok(paths.every((path) => path === "/primary"));
        assert.ok(ctx.session.state.blocks[0].summary.split("\n\n").every((part) => part === SUMMARY));
    }, (req, res) => { paths.push(req.url ?? ""); success(res); });
});

test("corrupt external summary configuration warns and falls back to legacy preflight", async () => {
    const paths: string[] = [];
    await fixture(async (base, _externalSummary) => {
        // Invalid chain on the rail: the preflight fallback must warn and
        // fall back to legacy main-model summarization, never silently drop.
        const ctx = context({ enabled: true, targets: {} });
        ctx.config.modelContextLimit = 1000;
        ctx.session.stats.lastInputTokens = 10000;
        const logs: string[] = [];
        const result = await preflightCompress({ core: ctx.core, config: ctx.config, session: ctx.session,
            prompts: defaultPrompts, protocol: "responses", url: `${base}/legacy`, headers: {},
            model: "main-model", log: (_level, message) => { logs.push(message); },
        }, ctx.messages);
        assert.ok(result.compressedRanges > 0, JSON.stringify(result));
        assert.deepEqual(paths, ["/legacy"]);
        assert.ok(logs.some((message) => message.includes("configuration unavailable") && message.includes("legacy preflight")), logs.join("\n"));
    }, (req, res) => { paths.push(req.url ?? ""); success(res); });
});

test("MCP/native thin-plugin tool handler executes the same external summary contract", async () => {
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        // The handler retrieves the same session from its resident pool.
        const { getSession } = await import("../src/session.ts");
        const session = getSession(ctx.session.id);
        session.state = ctx.session.state;
        session.pluginSnapshot = ctx.messages;
        let body = "";
        const res = { writeHead: () => undefined, end: (value: unknown) => { body = String(value); } } as unknown as http.ServerResponse;
        await handlePluginTool(JSON.stringify({ conversationId: session.id, tool: "compress", args: args(ctx), nativeCaller: true }), res,
            { core: ctx.core, config: ctx.config, log: () => {} });
        const result = JSON.parse(body) as Record<string, unknown>;
        assert.equal(result.outcome, "applied", body);
        assert.equal(session.state.blocks[0].summary, SUMMARY);
    }, (_req, res) => success(res));
});

test("batch protection checks the aggregate range length instead of rejecting valid small ranges", async () => {
    let calls = 0;
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        ctx.config.compress.minCompressRange = 1000;
        ctx.messages = [
            { id: "first", role: "assistant", contentType: "text", text: "a".repeat(3000) },
            { id: "second", role: "assistant", contentType: "text", text: "b".repeat(3000) },
            ctx.messages[1],
        ];
        ctx.session.state = ctx.core.processTurn({ messages: ctx.messages, state: ctx.session.state, config: ctx.config, tokenCount: 1000 }).state;
        const input = { content: ["first", "second"].map((id) => ({ startId: ctx.session.state.messageRefs.byRaw[id], endId: ctx.session.state.messageRefs.byRaw[id] })) };
        const result = await applyConfiguredCompression(input, ctx);
        assert.equal(result.outcome, "applied", result.text);
        assert.equal(calls, 2);
        assert.equal(ctx.session.state.blocks.length, 2);
    }, (_req, res) => { calls++; success(res); });
});

test("inline restore refolds the original block even when originals have left the wire view", async () => {
    let calls = 0;
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        const input = args(ctx);
        await applyConfiguredCompression(input, ctx);
        const blockId = ctx.session.state.blocks[0].blockId;
        resolveDecompress({ blockId, full: true }, ctx);
        assert.equal(ctx.session.state.blocks[0].restoredInline, true);
        ctx.messages = [];
        ctx.compressMessages = [];
        const result = await applyConfiguredCompression(input, ctx);
        assert.equal(result.outcome, "applied", result.text);
        assert.equal(calls, 2);
        assert.equal(ctx.session.state.blocks.length, 1);
        assert.equal(ctx.session.state.blocks[0].blockId, blockId);
        assert.notEqual(ctx.session.state.blocks[0].restoredInline, true);
        assert.match(ctx.session.state.blocks[0].compressCallId ?? "", /^external-summary-/);
    }, (_req, res) => { calls++; success(res); });
});

test("a summary below the kernel minimum fails over instead of blocking the backup", async () => {
    const paths: string[] = [];
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        const result = await applyConfiguredCompression(args(ctx), ctx);
        assert.equal(result.outcome, "applied", result.text);
        assert.deepEqual(paths, ["/primary", "/backup"]);
        assert.equal(ctx.session.state.blocks[0].summary, SUMMARY);
    }, (req, res) => {
        paths.push(req.url ?? "");
        if (req.url === "/primary") res.end(JSON.stringify({ status: "completed", output_text: "ok" }));
        else success(res);
    });
});

test("broken configuration cannot silently switch back to the supplied main-model summary", async () => {
    await fixture(async () => {
        // Invalid chain on the rail: refuse instead of silently switching
        // back to the supplied main-model summary.
        const ctx = context({ enabled: true, targets: {} });
        const result = await applyConfiguredCompression(args(ctx, SUMMARY), ctx);
        assert.equal(result.outcome, "refused");
        assert.match(result.text, /configuration is invalid/);
        assert.equal(ctx.session.state.blocks.length, 0);
    }, (_req, res) => { assert.fail("invalid configuration must not dispatch"); res.end(); });
});

test("external summary keeps its authoritative anchor despite an echoed hint call", async () => {
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary);
        ctx.session.meta.summaryInstructions = "PACK_SENTINEL preserve exact historical paths and pending tasks";
        await applyConfiguredCompression(args(ctx, "non-authoritative hint"), ctx, "client-call");
        const block = ctx.session.state.blocks[0];
        const anchor: CoreMessage = { id: `acp_summary_${block.blockId}`, role: "system", contentType: "text", text: block.summary };
        const call: CoreMessage = { id: "call", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "client-call", text: JSON.stringify(args(ctx)) };
        assert.ok(stripKernelSummaries([anchor, call], ctx.session.state).some((message) => message.id === anchor.id));
    }, (_req, res, body) => {
        assert.ok(JSON.stringify(body).includes("PACK_SENTINEL"));
        assert.ok(JSON.stringify(body).includes("[m00001]"));
        success(res);
    });
});

test("four JSON response rewriters execute independent compression with optional summary", async () => {
    await fixture(async (_base, externalSummary) => {
        const cases = [
            (ctx: RewriteCtx) => rewriteJsonResponseAsync({ content: [{ type: "tool_use", id: "call", name: "compress", input: args(ctx) }] }, ctx),
            (ctx: RewriteCtx) => rewriteOpenaiJsonResponseAsync({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "call", type: "function", function: { name: "compress", arguments: JSON.stringify(args(ctx)) } }] }, finish_reason: "tool_calls" }] }, ctx),
            (ctx: RewriteCtx) => rewriteResponsesJsonResponseAsync({ output: [{ type: "function_call", call_id: "call", name: "compress", arguments: JSON.stringify(args(ctx)) }] }, ctx),
            (ctx: RewriteCtx) => rewriteGoogleJsonResponseAsync({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "compress", args: args(ctx) } }] } }] }, ctx),
        ];
        for (const rewrite of cases) {
            const ctx = context(externalSummary);
            await rewrite(ctx);
            assert.equal(ctx.session.state.blocks[0]?.summary, SUMMARY);
        }
    }, (_req, res) => success(res));
});

test("mode-aware tool schemas relax summary only when enabled without mutating constants", () => {
    const toolSets: readonly (readonly unknown[])[] = [BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES, BILI_ACP_TOOLS_GOOGLE];
    for (const tools of toolSets) {
        const original = JSON.stringify(tools);
        const adapted = JSON.stringify(withExternalSummaryTools(tools, true));
        assert.ok(adapted.includes("non-authoritative hint"));
        assert.equal(JSON.stringify(tools), original);
        assert.equal(JSON.stringify(withExternalSummaryTools(tools, false)), original);
    }
});
