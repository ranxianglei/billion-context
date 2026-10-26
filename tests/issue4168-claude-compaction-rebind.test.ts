// #4168: Claude Code native-compaction continuation — the MCP shim's
// env-captured session id goes stale while still RESOLVING, so every
// management call fails closed on the outbound-witness 409 forever (#656's
// 404-only adoption never fires) and the session is lost for good. Pins the
// recovery contract at both layers:
//   A. proxy  — the 409 keeps its fail-closed code/prefix but names the unique
//               witnessing conversation and carries the recency facts
//               (additive fields; matching witnesses and native callers are
//               untouched);
//   B. shim   — forwardTool adopts the UNIQUE witnessing session exactly once
//               when the recency facts prove traffic moved there AFTER the
//               bound session's last activity; multi-witness, fresh-binding,
//               missing-facts, per-call-override, and re-conflict all stay on
//               the loud 409 (fail closed, never guess).
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Identity-bound shim: the captured binding goes stale mid-session. Must be set
// BEFORE src/mcp.ts loads (module-load-time constants).
process.env.CLAUDE_CODE_SESSION_ID = "env-stale-id-4168";

const { createCore, defaultConfig } = await import("acp-kernel");
type PluginToolDeps = import("../src/plugin.ts").PluginToolDeps;
const { _resetPluginStateForTest, handlePluginTool } = await import("../src/plugin.ts");
const { getSession } = await import("../src/session.ts");
const { recordToolWitness, resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetMcpBindingForTest, forwardTool } = await import("../src/mcp.ts");

function rand(): string {
    return Math.random().toString(36).slice(2);
}

// ─────────────────────── Part A: proxy 409 payload ───────────────────────────

describe("#4168 proxy: witness-conflict 409 stays fail-closed but names the live conversation", () => {
    let deps: PluginToolDeps;
    let logs: string[];

    beforeEach(() => {
        _resetPluginStateForTest();
        resetToolRingForTest();
        logs = [];
        deps = { core: createCore(), config: defaultConfig(400_000), log: (_lvl: string, msg: string) => { logs.push(msg); } };
    });

    async function post(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
        let outBody = "";
        let status = 0;
        const res = {
            writeHead: (code: number) => { status = code; return undefined; },
            end: (chunk: unknown) => { outBody = String(chunk ?? ""); },
        } as unknown as import("node:http").ServerResponse;
        await handlePluginTool(JSON.stringify(body), res, deps);
        return { status, json: JSON.parse(outBody) as Record<string, unknown> };
    }

    function executedOn(): string[] {
        return logs.filter((m) => m.includes("executed via plugin")).map((m) => m.split("]")[0]?.slice(1) ?? "");
    }

    test("unique witness: 409 gains additive identity + recency fields and names the live conversation", async () => {
        const stale = getSession(`t4168-stale-${rand()}`);
        const live = getSession(`t4168-live-${rand()}`);
        stale.lastSeen = Date.now() - 3_600_000;
        live.lastSeen = Date.now();
        recordToolWitness(live.id, "acp_status", "{}");
        const r = await post({ conversationId: stale.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 409);
        // machine-readable contract unchanged
        assert.equal(r.json.code, "TOOL_CONVERSATION_CONFLICT");
        assert.match(String(r.json.error), /^outbound tool witness does not match conversationId/);
        // additive identity + recency facts
        assert.equal(r.json.conversationId, stale.id);
        assert.equal(r.json.namedSessionId, stale.id);
        assert.deepEqual(r.json.witnessSessions, [live.id]);
        assert.equal(r.json.namedSessionLastSeen, stale.lastSeen);
        assert.equal(r.json.witnessLastSeen, live.lastSeen);
        // actionable hint for the #760 per-call channel
        assert.ok(String(r.json.error).includes(`conversation_id="${live.id}"`), "single witness must be named for model self-recovery");
        // fail-closed behavior unchanged: nothing executes
        assert.deepEqual(executedOn(), []);
    });

    test("multiple witnesses: refuse to guess — no single conversation is named", async () => {
        const stale = getSession(`t4168-stale2-${rand()}`);
        const liveA = getSession(`t4168-liveA-${rand()}`);
        const liveB = getSession(`t4168-liveB-${rand()}`);
        recordToolWitness(liveA.id, "acp_status", "{}");
        recordToolWitness(liveB.id, "acp_status", "{}");
        const r = await post({ conversationId: stale.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 409);
        assert.equal(r.json.code, "TOOL_CONVERSATION_CONFLICT");
        assert.deepEqual([...r.json.witnessSessions as string[]].sort(), [liveA.id, liveB.id].sort());
        assert.ok(String(r.json.error).includes("2 sessions hold the matching outbound witness"));
        assert.ok(String(r.json.error).includes("refuse to guess"));
        assert.ok(!String(r.json.error).includes('conversation_id="'), "ambiguous conflict must not name a session");
        assert.deepEqual(executedOn(), []);
    });

    test("matching witness: no conflict, routes by body id (gate negative direction)", async () => {
        const live = getSession(`t4168-match-${rand()}`);
        recordToolWitness(live.id, "acp_status", "{}");
        const r = await post({ conversationId: live.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [live.id]);
    });

    test("native caller still outranks a conflicting witness (adjacent branch untouched)", async () => {
        const named = getSession(`t4168-native-${rand()}`);
        const live = getSession(`t4168-native-live-${rand()}`);
        recordToolWitness(live.id, "acp_status", "{}");
        const r = await post({ conversationId: named.id, tool: "acp_status", args: {}, nativeCaller: true });
        assert.equal(r.status, 200, "#2024: confirmed native caller must not hard-fail on a conflicting witness");
        assert.deepEqual(executedOn(), [named.id]);
    });
});

// ─────────────────────── Part B: shim self-rebind ────────────────────────────

type ToolPost = { conversationId?: string; tool?: string; args?: unknown; nativeCaller?: boolean };

function mockProxy(script: Array<{ status: number; json: Record<string, unknown> }>): Promise<{ url: string; posts: ToolPost[]; stop(): Promise<void> }> {
    const posts: ToolPost[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
            if (req.url?.startsWith("/__bili/plugin/tool")) posts.push(JSON.parse(raw) as ToolPost);
            const step = script[posts.length - 1] ?? script[script.length - 1] ?? { status: 500, json: { ok: false, error: "mock exhausted" } };
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

function conflict409(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ok: false,
        code: "TOOL_CONVERSATION_CONFLICT",
        error: "outbound tool witness does not match conversationId",
        ...extra,
    };
}

describe("#4168 shim: one-shot adoption of the unique witnessing session on 409 conflict", () => {
    const STALE = "env-stale-id-4168";
    const LIVE = "live-conversation-4168";

    test("adopts the unique witnessing session when traffic provably moved there, then retries once", async () => {
        const t0 = Date.now() - 3_600_000;
        const t1 = Date.now();
        const mock = await mockProxy([
            { status: 409, json: conflict409({ conversationId: STALE, namedSessionId: STALE, witnessSessions: [LIVE], namedSessionLastSeen: t0, witnessLastSeen: t1 }) },
            { status: 200, json: { ok: true, result: "done" } },
        ]);
        process.env.BILI_MCP_PROXY = mock.url;
        try {
            _resetMcpBindingForTest(STALE);
            const out = await forwardTool("acp_status", {});
            assert.equal(out.failed, false);
            assert.equal(out.text, "done");
            assert.equal(mock.posts.length, 2, "exactly one retry after adoption");
            assert.equal(mock.posts[0].conversationId, STALE, "first attempt carries the stale binding");
            assert.equal(mock.posts[1].conversationId, LIVE, "retry carries the adopted binding");
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetMcpBindingForTest(STALE);
            await mock.stop();
        }
    });

    test("does NOT adopt while the bound session is still the fresher one (multi-window safety)", async () => {
        const mock = await mockProxy([
            { status: 409, json: conflict409({ conversationId: STALE, witnessSessions: [LIVE], namedSessionLastSeen: Date.now(), witnessLastSeen: Date.now() - 3_600_000 }) },
        ]);
        process.env.BILI_MCP_PROXY = mock.url;
        try {
            _resetMcpBindingForTest(STALE);
            await assert.rejects(() => forwardTool("acp_status", {}), /outbound tool witness does not match conversationId/);
            assert.equal(mock.posts.length, 1, "no retry — the loud 409 stands");
            assert.equal(mock.posts[0].conversationId, STALE);
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetMcpBindingForTest(STALE);
            await mock.stop();
        }
    });

    test("does NOT adopt with multiple witnesses (ambiguous)", async () => {
        const mock = await mockProxy([
            { status: 409, json: conflict409({ conversationId: STALE, witnessSessions: [LIVE, "other-4168"], namedSessionLastSeen: Date.now() - 3_600_000, witnessLastSeen: Date.now() }) },
        ]);
        process.env.BILI_MCP_PROXY = mock.url;
        try {
            _resetMcpBindingForTest(STALE);
            await assert.rejects(() => forwardTool("acp_status", {}), /outbound tool witness does not match conversationId/);
            assert.equal(mock.posts.length, 1);
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetMcpBindingForTest(STALE);
            await mock.stop();
        }
    });

    test("per-call override never adopts and never touches the global binding", async () => {
        const mock = await mockProxy([
            // adoptable facts, but on a PER-CALL id — adoption must stay off
            { status: 409, json: conflict409({ conversationId: "per-call-4168", witnessSessions: [LIVE], namedSessionLastSeen: Date.now() - 3_600_000, witnessLastSeen: Date.now() }) },
            // the follow-up default-bound call hits its own AMBIGUOUS conflict —
            // loud 409 again, and it must still carry the untouched STALE binding
            { status: 409, json: conflict409({ conversationId: STALE, witnessSessions: ["other-a-4168", "other-b-4168"], namedSessionLastSeen: Date.now() - 3_600_000, witnessLastSeen: Date.now() }) },
        ]);
        process.env.BILI_MCP_PROXY = mock.url;
        try {
            _resetMcpBindingForTest(STALE);
            await assert.rejects(() => forwardTool("acp_status", {}, undefined, "per-call-4168"), /outbound tool witness does not match conversationId/);
            // global binding untouched: the next default-bound call still uses STALE
            await assert.rejects(() => forwardTool("acp_status", {}), /outbound tool witness does not match conversationId/);
            assert.equal(mock.posts.length, 2);
            assert.equal(mock.posts[0].conversationId, "per-call-4168");
            assert.equal(mock.posts[1].conversationId, STALE, "global binding must survive a per-call conflict unadopted");
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetMcpBindingForTest(STALE);
            await mock.stop();
        }
    });

    test("missing recency facts (older proxy) keep the loud 409 — defensive no-adoption", async () => {
        const mock = await mockProxy([
            { status: 409, json: conflict409() },
        ]);
        process.env.BILI_MCP_PROXY = mock.url;
        try {
            _resetMcpBindingForTest(STALE);
            await assert.rejects(() => forwardTool("acp_status", {}), /outbound tool witness does not match conversationId/);
            assert.equal(mock.posts.length, 1);
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetMcpBindingForTest(STALE);
            await mock.stop();
        }
    });

    test("a second conflict after adoption throws instead of looping", async () => {
        const adoptable = () => ({ status: 409, json: conflict409({ conversationId: STALE, witnessSessions: [LIVE], namedSessionLastSeen: Date.now() - 3_600_000, witnessLastSeen: Date.now() }) });
        const mock = await mockProxy([adoptable(), adoptable()]);
        process.env.BILI_MCP_PROXY = mock.url;
        try {
            _resetMcpBindingForTest(STALE);
            await assert.rejects(() => forwardTool("acp_status", {}), /outbound tool witness does not match conversationId/);
            assert.equal(mock.posts.length, 2, "at most one retry");
            assert.equal(mock.posts[1].conversationId, LIVE, "the retry did use the adopted binding");
        } finally {
            delete process.env.BILI_MCP_PROXY;
            _resetMcpBindingForTest(STALE);
            await mock.stop();
        }
    });
});
