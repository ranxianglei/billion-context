// #6917: a Remote Control child (`claude --print --sdk-url … --resume=<session url>`)
// spawns the bili MCP shim with a fresh CLAUDE_CODE_SESSION_ID, then adopts the
// remote session's id (written to ~/.claude/sessions/<pid>.json) and sends its
// model requests under that id. Measured live: shim env 3847869d-…, requests and
// sessions file cc233f11-…. Nothing calls a bili tool first, so the #6361 per-call
// re-bind never runs: the proxy never sees the session as bili's, never declines
// the message-threads beta, and every request arrives as a 2-message delta.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const SPAWN_ID = "3847869d-1ea6-4dfd-b32c-6fe55813d0cf";
const REMOTE_ID = "cc233f11-aea8-54c4-8747-09901d9075cc";
process.env.CLAUDE_CODE_SESSION_ID = SPAWN_ID;

const { readClaudeSessionId, _setClaudeHostPidForTest } = await import("../src/claude-mcp-entry.ts");
const { _resetMcpBindingForTest, setClaudeSessionResolver, _resetClaudeSessionResolverForTest, watchClaudeSession } = await import("../src/mcp.ts");
const { rmrf } = await import("./tmp-rm.ts");

const HOST_PID = 18431;

async function withProxyAndSessionsFile(sessionId: string, fn: (registers: () => unknown[]) => Promise<void>): Promise<void> {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
            posts.push({ url: req.url ?? "", body: JSON.parse(raw || "{}") });
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{\"ok\":true}");
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-rc-"));
    fs.mkdirSync(path.join(dir, "sessions"));
    fs.writeFileSync(path.join(dir, "sessions", `${HOST_PID}.json`), JSON.stringify({ pid: HOST_PID, sessionId, entrypoint: "sdk-cli" }));
    process.env.BILI_MCP_PROXY = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    process.env.CLAUDE_CONFIG_DIR = dir;
    _setClaudeHostPidForTest(HOST_PID);
    _resetMcpBindingForTest(SPAWN_ID);
    setClaudeSessionResolver(readClaudeSessionId);
    try {
        await fn(() => posts.filter((p) => p.url === "/__bili/plugin/register").map((p) => p.body));
    } finally {
        delete process.env.BILI_MCP_PROXY;
        delete process.env.CLAUDE_CONFIG_DIR;
        _resetClaudeSessionResolverForTest();
        _resetMcpBindingForTest();
        await new Promise<void>((r) => server.close(() => r()));
        rmrf(dir);
    }
}

const settle = () => new Promise((r) => setTimeout(r, 200));

describe("#6917: the claude shim follows a Remote Control child's session id without a tool call", () => {
    test("registers the remote session id the host adopted after spawn", async () => {
        await withProxyAndSessionsFile(REMOTE_ID, async (registers) => {
            const stop = watchClaudeSession(20);
            try {
                await settle();
            } finally {
                stop();
            }
            assert.deepEqual(registers(), [{ conversationId: REMOTE_ID, agent: "mcp", identity: true }]);
        });
    });

    test("registers nothing new while the host keeps the spawn id", async () => {
        await withProxyAndSessionsFile(SPAWN_ID, async (registers) => {
            const stop = watchClaudeSession(20);
            try {
                await settle();
            } finally {
                stop();
            }
            assert.deepEqual(registers(), []);
        });
    });
});
