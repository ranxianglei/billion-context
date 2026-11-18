// #6361: Claude Code /clear (or /new) starts a NEW session id but keeps this
// stdio MCP child running — the spawn-time CLAUDE_CODE_SESSION_ID env
// (mcp.ts's CONVERSATION_FROM_ENV) goes stale, and NEITHER existing recovery
// path fires (the #656 404 adoption needs the bound id to be unknown — it is
// still registered + active, so calls succeed against it; the #4168 409
// re-bind needs a witness conflict — none occurs). Tools silently run against
// the OLD session and the NEW session never enters plugin mode.
//
// Fix: the claude entry (claude-mcp-entry.ts) injects a resolver that reads the
// host's CURRENT session id from <CLAUDE_CONFIG_DIR|~/.claude>/sessions/
// <host-pid>.json (rewritten on /clear; the host pid is stable for this child's
// lifetime). On each tools/call the shim re-reads it and, when it differs from
// the bound id, re-binds + re-registers so the new session enters plugin mode.
//
// Pins the contract at both layers:
//   A. resolver — reads + validates the sessions file defensively (any read /
//                 parse / shape failure → undefined, i.e. "no re-bind", never a
//                 crash); honors CLAUDE_CONFIG_DIR + the (cached) host pid;
//   B. shim     — maybeRebindConversation re-points the default binding at the
//                 host's current id exactly when it changed, fires a register
//                 for the new id, and leaves the binding untouched for same-id /
//                 no-resolver / throwing-resolver / non-identity cases (gate
//                 ships both directions per #3617).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Identity-bound shim: the captured binding goes stale on /clear. Must be set
// BEFORE src/mcp.ts loads (module-load-time constants).
process.env.CLAUDE_CODE_SESSION_ID = "env-stale-id-6361";

const { readClaudeSessionFile, readClaudeSessionId, _resetClaudeHostPidForTest, _setClaudeHostPidForTest } = await import("../src/claude-mcp-entry.ts");
const { _resetMcpBindingForTest, forwardTool, setClaudeSessionResolver, maybeRebindConversation, _resetClaudeSessionResolverForTest } = await import("../src/mcp.ts");
const { rmrf } = await import("./tmp-rm.ts");

const HOST_PID = 12345;

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): void | Promise<void> {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    const restore = () => {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
}

// A CLAUDE_CONFIG_DIR tree with one sessions file. `content` is the raw file
// body (string) or an object to JSON.stringify, or null for "no file".
function sessionsSandbox(content: unknown, pid: number = HOST_PID): { dir: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-sess-"));
    const sessionsDir = path.join(dir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    if (content !== null) {
        fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), typeof content === "string" ? content : JSON.stringify(content));
    }
    return { dir, cleanup: () => rmrf(dir) };
}

// ─────────────────────── Part A: claude session resolver ─────────────────────

describe("#6361 resolver: readClaudeSessionFile reads + validates the sessions file", () => {
    test("returns the sessionId from a well-formed file", () => {
        const box = sessionsSandbox({ sessionId: "5b1cb753-1234-4abc-8def-0123456789ab" });
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), "5b1cb753-1234-4abc-8def-0123456789ab");
        } finally {
            box.cleanup();
        }
    });

    test("accepts the session_id and id fallback shapes", () => {
        let box = sessionsSandbox({ session_id: "abc123" });
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), "abc123");
        } finally {
            box.cleanup();
        }
        box = sessionsSandbox({ id: "def456" });
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), "def456");
        } finally {
            box.cleanup();
        }
    });

    test("sessionId wins over the fallbacks when several are present", () => {
        const box = sessionsSandbox({ sessionId: "primary", session_id: "secondary", id: "third" });
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), "primary");
        } finally {
            box.cleanup();
        }
    });

    test("missing file → undefined", () => {
        const box = sessionsSandbox(null);
        try {
            assert.equal(readClaudeSessionFile(box.dir, 99999), undefined);
        } finally {
            box.cleanup();
        }
    });

    test("malformed JSON → undefined", () => {
        const box = sessionsSandbox("{ not json");
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), undefined);
        } finally {
            box.cleanup();
        }
    });

    test("non-object JSON → undefined", () => {
        const box = sessionsSandbox('"just a string"');
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), undefined);
        } finally {
            box.cleanup();
        }
    });

    test("missing session field → undefined", () => {
        const box = sessionsSandbox({ foo: "bar" });
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), undefined);
        } finally {
            box.cleanup();
        }
    });

    test("non-string session field → undefined", () => {
        const box = sessionsSandbox({ sessionId: 12345 });
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), undefined);
        } finally {
            box.cleanup();
        }
    });

    test("invalid session-id shape → undefined (too short / space / path separator)", () => {
        for (const bad of ["ab", "has space", "a/b"]) {
            const box = sessionsSandbox({ sessionId: bad });
            try {
                assert.equal(readClaudeSessionFile(box.dir, HOST_PID), undefined, `rejected ${JSON.stringify(bad)}`);
            } finally {
                box.cleanup();
            }
        }
    });

    test("trims surrounding whitespace from the id", () => {
        const box = sessionsSandbox({ sessionId: "  padded-id-123  " });
        try {
            assert.equal(readClaudeSessionFile(box.dir, HOST_PID), "padded-id-123");
        } finally {
            box.cleanup();
        }
    });
});

describe("#6361 resolver: readClaudeSessionId wires CLAUDE_CONFIG_DIR + host pid", () => {
    test("reads the file for the (pinned) host pid under CLAUDE_CONFIG_DIR", async () => {
        const box = sessionsSandbox({ sessionId: "wired-session-1" });
        await withEnv({ CLAUDE_CONFIG_DIR: box.dir }, () => {
            _setClaudeHostPidForTest(HOST_PID);
            try {
                assert.equal(readClaudeSessionId(), "wired-session-1");
            } finally {
                _resetClaudeHostPidForTest();
            }
        });
        box.cleanup();
    });

    test("no resolvable host pid → undefined (no crash)", async () => {
        const box = sessionsSandbox({ sessionId: "wired-session-1" });
        await withEnv({ CLAUDE_CONFIG_DIR: box.dir }, () => {
            _setClaudeHostPidForTest(undefined);
            try {
                assert.equal(readClaudeSessionId(), undefined);
            } finally {
                _resetClaudeHostPidForTest();
            }
        });
        box.cleanup();
    });

    test("host pid set but no sessions file → undefined", async () => {
        const box = sessionsSandbox(null);
        await withEnv({ CLAUDE_CONFIG_DIR: box.dir }, () => {
            _setClaudeHostPidForTest(HOST_PID);
            try {
                assert.equal(readClaudeSessionId(), undefined);
            } finally {
                _resetClaudeHostPidForTest();
            }
        });
        box.cleanup();
    });
});

// ─────────────────────── Part B: shim re-bind seam ───────────────────────────

type CapturedPost = { url: string; body: Record<string, unknown> };

function mockProxy(script: Array<{ status: number; json: Record<string, unknown> }>): Promise<{ url: string; posts: CapturedPost[]; stop(): Promise<void> }> {
    const posts: CapturedPost[] = [];
    let i = 0;
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(raw); } catch { /* ignore */ }
            posts.push({ url: req.url ?? "", body });
            const step = script[Math.min(i, script.length - 1)] ?? { status: 500, json: { ok: false, error: "mock exhausted" } };
            i += 1;
            res.writeHead(step.status, { "content-type": "application/json" });
            res.end(JSON.stringify(step.json));
        });
    });
    return new Promise((resolveFn) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as import("node:net").AddressInfo).port;
            resolveFn({
                url: `http://127.0.0.1:${port}`,
                posts,
                stop: () => new Promise((r) => { server.close(() => { r(); }); }),
            });
        });
    });
}

function toolPosts(posts: CapturedPost[]): Record<string, unknown>[] {
    return posts.filter((p) => p.url === "/__bili/plugin/tool").map((p) => p.body);
}

function registerPosts(posts: CapturedPost[]): Record<string, unknown>[] {
    return posts.filter((p) => p.url === "/__bili/plugin/register").map((p) => p.body);
}

async function waitForUrl(posts: CapturedPost[], url: string, timeoutMs = 1500): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (posts.some((p) => p.url === url)) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    return posts.some((p) => p.url === url);
}

describe("#6361 shim: maybeRebindConversation re-points at the host's current id", () => {
    test("no resolver set → no re-bind (non-claude hosts leave the seam unset)", () => {
        _resetMcpBindingForTest("bound-session-a");
        _resetClaudeSessionResolverForTest();
        assert.equal(maybeRebindConversation(), undefined);
    });

    test("resolver returns the SAME id → no re-bind", () => {
        _resetMcpBindingForTest("same-session");
        setClaudeSessionResolver(() => "same-session");
        try {
            assert.equal(maybeRebindConversation(), undefined);
        } finally {
            _resetClaudeSessionResolverForTest();
            _resetMcpBindingForTest();
        }
    });

    test("resolver returns a NEW id → re-binds and returns it", () => {
        _resetMcpBindingForTest("old-session");
        setClaudeSessionResolver(() => "new-session");
        try {
            assert.equal(maybeRebindConversation(), "new-session");
        } finally {
            _resetClaudeSessionResolverForTest();
            _resetMcpBindingForTest();
        }
    });

    test("resolver returns undefined → no re-bind", () => {
        _resetMcpBindingForTest("old-session");
        setClaudeSessionResolver(() => undefined);
        try {
            assert.equal(maybeRebindConversation(), undefined);
        } finally {
            _resetClaudeSessionResolverForTest();
            _resetMcpBindingForTest();
        }
    });

    test("resolver throws → no re-bind (defensive: a read error never crashes the shim)", () => {
        _resetMcpBindingForTest("old-session");
        setClaudeSessionResolver(() => { throw new Error("boom"); });
        try {
            assert.equal(maybeRebindConversation(), undefined);
        } finally {
            _resetClaudeSessionResolverForTest();
            _resetMcpBindingForTest();
        }
    });
});

describe("#6361 shim: tools/call sequence carries the re-bound id to the proxy", () => {
    test("after a /clear re-bind, the forward hits the NEW session", async () => {
        const mock = await mockProxy([{ status: 200, json: { ok: true } }]);
        process.env.BILI_MCP_PROXY = mock.url;
        _resetMcpBindingForTest("old-session");
        setClaudeSessionResolver(() => "new-session");
        try {
            // Mirror the tools/call case: re-bind, then forward.
            maybeRebindConversation();
            await forwardTool("acp_status", {});
            const tools = toolPosts(mock.posts);
            assert.equal(tools.length, 1);
            assert.equal(tools[0].conversationId, "new-session");
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetClaudeSessionResolverForTest();
            _resetMcpBindingForTest();
            await mock.stop();
        }
    });

    test("no re-bind (same id) → the forward stays on the bound session", async () => {
        const mock = await mockProxy([{ status: 200, json: { ok: true } }]);
        process.env.BILI_MCP_PROXY = mock.url;
        _resetMcpBindingForTest("bound-session");
        setClaudeSessionResolver(() => "bound-session");
        try {
            maybeRebindConversation();
            await forwardTool("acp_status", {});
            const tools = toolPosts(mock.posts);
            assert.equal(tools.length, 1);
            assert.equal(tools[0].conversationId, "bound-session");
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetClaudeSessionResolverForTest();
            _resetMcpBindingForTest();
            await mock.stop();
        }
    });

    test("no resolver → the forward stays on the bound session (other hosts)", async () => {
        const mock = await mockProxy([{ status: 200, json: { ok: true } }]);
        process.env.BILI_MCP_PROXY = mock.url;
        _resetMcpBindingForTest("bound-session");
        _resetClaudeSessionResolverForTest();
        try {
            maybeRebindConversation();
            await forwardTool("acp_status", {});
            const tools = toolPosts(mock.posts);
            assert.equal(tools.length, 1);
            assert.equal(tools[0].conversationId, "bound-session");
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetMcpBindingForTest();
            await mock.stop();
        }
    });

    test("a re-bind fires a register for the NEW session (so it enters plugin mode)", async () => {
        const mock = await mockProxy([{ status: 200, json: { ok: true } }]);
        process.env.BILI_MCP_PROXY = mock.url;
        // Unique id: registeredConversations is module state, so a fresh id
        // guarantees the register branch runs.
        const fresh = `fresh-session-${Math.random().toString(36).slice(2)}`;
        _resetMcpBindingForTest("old-session");
        setClaudeSessionResolver(() => fresh);
        try {
            maybeRebindConversation();
            const landed = await waitForUrl(mock.posts, "/__bili/plugin/register");
            assert.equal(landed, true, "register POST landed");
            const regs = registerPosts(mock.posts);
            assert.equal(regs.length, 1);
            assert.equal(regs[0].conversationId, fresh);
            assert.equal(regs[0].agent, "mcp");
            assert.equal(regs[0].identity, true);
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetClaudeSessionResolverForTest();
            _resetMcpBindingForTest();
            await mock.stop();
        }
    });
});
