/**
 * Claude Code reached through bili as an HTTPS proxy keeps Anthropic's address, so it
 * uses Message Threads: a `create` carries the whole history, then every `continue`
 * carries only the new messages. bili folds and nudges by rewriting the history it
 * sees, so on a continue it is blind (upstream #2701): in a 6-turn Haiku run on
 * 2026-11-12 it injected no nudge at all and split the session into 24 lanes.
 *
 * When the request declares bili's own MCP tools (bili is meant to compress this
 * session), bili now answers a threads request itself with the 400 Anthropic gives
 * for an unknown beta header. Claude Code 2.1.322 matches that error, drops the
 * message-threads header and threading for the session, and retries with the full
 * history. Requests without bili's tools keep the threads lane (#2926) unchanged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import type { ProxyOptions } from "../src/server.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-threads-decline-"));
process.env.XDG_STATE_HOME = path.join(tmpRoot, "state");
process.env.XDG_CACHE_HOME = path.join(tmpRoot, "cache");
process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(tmpRoot, "config");
delete process.env.ACP_DUMP_BODY;

const MODEL = "claude-test";
const THREADS_BETA = "message-threads-2026-08-12";
const BETAS = `claude-code-20250219,${THREADS_BETA},interleaved-thinking-2025-05-14`;
const BILI_TOOL = { name: "mcp__bili__compress", description: "Fold ranges.", input_schema: { type: "object", properties: { content: { type: "string" } } } };
const READ_TOOL = { name: "Read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

// Claude Code's matcher (2.1.322): HTTP 400 whose message names the header value and matches /anthropic[-_]beta/.
const claudeCodeDropsThreads = (status: number, body: string): boolean =>
    status === 400 && body.includes(THREADS_BETA) && /anthropic[-_]beta/.test(body);

test("bili declines the threads beta for sessions it compresses, and only those", { timeout: 60_000 }, async () => {
    const { defaultConfig } = await import("acp-kernel");
    const { startServer } = await import("../src/server.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    try {
        const seen: string[] = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                seen.push(String(req.headers["x-claude-code-session-id"] ?? ""));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: `msg_${seen.length}`, type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 200_000 } } } } as ProxyOptions["routes"],
            modelContextLimit: 200_000,
            kernelConfig: defaultConfig(200_000),
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
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
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

        const post = async (sid: string, body: Record<string, unknown>, beta: string | undefined): Promise<{ status: number; text: string }> => {
            const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "claude-cli/2.1.322 (external, cli)", "x-claude-code-session-id": sid };
            if (beta !== undefined) headers["anthropic-beta"] = beta;
            const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: "You are Claude Code.", ...body }) });
            return { status: res.status, text: await res.text() };
        };

        const createSid = "aaaaaaaa-0000-4000-8000-000000000001";
        const create = await post(createSid, { thread: { type: "create" }, messages: [user("hello")], tools: [READ_TOOL, BILI_TOOL] }, BETAS);
        assert.ok(claudeCodeDropsThreads(create.status, create.text), `create with bili tools is declined in Claude Code's shape: ${create.status} ${create.text}`);
        assert.equal(seen.includes(createSid), false, "the declined create never reaches the upstream");

        const contSid = "aaaaaaaa-0000-4000-8000-000000000002";
        const cont = await post(contSid, { thread: { type: "continue", previous_message_id: "msg_prev" }, messages: [user("next")], tools: [READ_TOOL, BILI_TOOL] }, BETAS);
        assert.ok(claudeCodeDropsThreads(cont.status, cont.text), `continue with bili tools is declined too: ${cont.status} ${cont.text}`);
        assert.equal(seen.includes(contSid), false, "the declined continue never reaches the upstream");

        const retrySid = "aaaaaaaa-0000-4000-8000-000000000003";
        const retry = await post(retrySid, { messages: [user("hello")], tools: [READ_TOOL, BILI_TOOL] }, "claude-code-20250219,interleaved-thinking-2025-05-14");
        assert.equal(retry.status, 200, `the retry without threads is forwarded: ${retry.text}`);
        assert.equal(seen.includes(retrySid), true);

        // Claude Code defers MCP tools behind tool search: the tools are off the wire, and bili
        // knows the session only by the MCP server's registration of its session id.
        const regSid = "aaaaaaaa-0000-4000-8000-000000000005";
        const reg = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: regSid, agent: "mcp", identity: true }) });
        assert.equal(reg.status, 200);
        const deferred = await post(regSid, { thread: { type: "create" }, messages: [user("hello")], tools: [READ_TOOL] }, BETAS);
        assert.ok(claudeCodeDropsThreads(deferred.status, deferred.text), `registered session with deferred bili tools is declined: ${deferred.status} ${deferred.text}`);
        assert.equal(seen.includes(regSid), false);

        // Another Anthropic-wire client (omp, say) does not answer the 400 by dropping threads.
        const before = seen.length;
        const other = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "anthropic-beta": BETAS }, body: JSON.stringify({ model: MODEL, max_tokens: 1024, thread: { type: "create" }, messages: [user("hello")], tools: [READ_TOOL, BILI_TOOL] }) });
        const otherText = await other.text();
        assert.equal(other.status, 200, `a non-Claude-Code client with bili tools keeps the threads lane: ${otherText}`);
        assert.equal(seen.length, before + 1);

        const plainSid = "aaaaaaaa-0000-4000-8000-000000000004";
        const plain = await post(plainSid, { thread: { type: "create" }, messages: [user("hello")], tools: [READ_TOOL] }, BETAS);
        assert.equal(plain.status, 200, `a threads request without bili's tools keeps the threads lane: ${plain.text}`);
        assert.equal(seen.includes(plainSid), true);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        const { rmrf } = await import("./tmp-rm.ts");
        rmrf(tmpRoot);
    }
});
