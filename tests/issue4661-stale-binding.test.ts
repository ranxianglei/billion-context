// #4661: ZCode host pins a static session id into its MCP shim (BILI_CONVERSATION_ID
// config pin) — when the host starts a new session or restarts, every MCP tool silently
// answers from the frozen old ledger (all-zero breakdown, idle nudge) while the real
// session is healthy. Complements #4168 (which owns the witness-CONFLICT shape:
// informative 409 + recency facts + identity-binding self-rebind); this issue's
// uncovered shapes are the ones tested here:
//   A. proxy side — runtime traffic evidence (session.lastModelRequestAt, stamped by
//      the request pipeline only): a bound session quiet > STALE_BINDING_QUIET_MS while
//      another non-restored session has strictly newer model traffic is a suspected
//      stale binding. NO-witness calls still execute on the bound session but get a
//      loud ⚠️ advisory + additive staleBinding body field (the silent-zeros shape);
//      the conflict shape keeps #4168's fail-closed informative 409; fresh bindings
//      and nativeCaller (#2024) are untouched; restored sessions never qualify as
//      candidates; the status route exposes the same diagnosis additively.
//      #3617: negative rows for every gate.
//   B. shim side — the REAL src/mcp.ts over stdio against a canned mock proxy: a
//      proxy-proven stale binding is adopted AND retried once (the answered call ran
//      on the frozen session), #4168's 409 self-rebind extends to static pins via the
//      proxy's recency facts, opt-out via BILI_MCP_NO_STALE_ADOPT=1, per-call native
//      routes never consume the adoption, _meta-bound shims keep the loud 409,
//      static pins warn at startup.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { beforeEach, describe, it } from "node:test";

import { createCore, defaultConfig } from "acp-kernel";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginStatus, handlePluginTool } from "../src/plugin.ts";
import { getSession, listSessions } from "../src/session.ts";
import { recordToolWitness, resetToolRingForTest } from "../src/tool-ring.ts";

const QUIET = 15 * 60 * 1000;

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => { status = code; return undefined; },
        end: (chunk: unknown) => { body = String(chunk ?? ""); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

describe("#4661 proxy: stale-binding diagnosis in handlePluginTool", () => {
    let deps: PluginToolDeps;
    let logs: string[];

    beforeEach(() => {
        _resetPluginStateForTest();
        resetToolRingForTest();
        // The sessions map is process-global; clear prior tests' traffic stamps so
        // candidate selection sees exactly this test's fixtures.
        for (const s of listSessions()) s.lastModelRequestAt = undefined;
        logs = [];
        deps = { core: createCore(), config: defaultConfig(400_000), log: (_lvl: string, msg: string) => { logs.push(msg); } };
    });

    async function post(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
        const out = mockRes();
        await handlePluginTool(JSON.stringify(body), out.res, deps);
        return { status: out.status(), json: JSON.parse(out.body()) as Record<string, unknown> };
    }

    function executedOn(): string[] {
        return logs.filter((m) => m.includes("executed via plugin")).map((m) => m.split("]")[0]?.slice(1) ?? "");
    }

    /** Bound session S quiet for 20 min + live candidate F active 1 min ago. */
    function makePair() {
        const s = getSession(`t-4661-s-${Math.random().toString(36).slice(2)}`);
        const f = getSession(`t-4661-f-${Math.random().toString(36).slice(2)}`);
        const sQuiet = Date.now() - 20 * 60 * 1000;
        const fLive = Date.now() - 60 * 1000;
        s.lastModelRequestAt = sQuiet;
        f.lastModelRequestAt = fLive;
        // lastSeen feeds #4168's reported recency facts (witnessLastSeen /
        // namedSessionLastSeen); stamp it explicitly so the row never rides on
        // the two creation-time Date.now() calls landing in different ms.
        s.lastSeen = sQuiet;
        f.lastSeen = fLive;
        return { s, f };
    }

    it("stale bound + unique witness on the live session → #4168's informative 409 (fail closed, name the witness)", async () => {
        const { s, f } = makePair();
        recordToolWitness(f.id, "acp_status", "{}");
        const r = await post({ conversationId: s.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 409);
        assert.equal(r.json.code, "TOOL_CONVERSATION_CONFLICT");
        assert.deepEqual(r.json.witnessSessions, [f.id], "the unique witness is named for the model/shim");
        assert.equal(r.json.namedSessionId, s.id);
        assert.ok(typeof r.json.witnessLastSeen === "number" && (r.json.witnessLastSeen as number) > (r.json.namedSessionLastSeen as number), "recency facts prove traffic moved to the witness");
        assert.match(String(r.json.error), new RegExp(`the identical call lives in conversation "${f.id}"`));
        assert.deepEqual(executedOn(), [], "#2024: explicit ids stay authoritative — no server-side reroute");
    });

    it("stale bound + NO witness → executes on the bound session but says so loudly", async () => {
        const { s, f } = makePair();
        const r = await post({ conversationId: s.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [s.id], "no evidence → keep honoring the explicit id");
        const sb = r.json.staleBinding as Record<string, unknown>;
        assert.equal(sb.boundConversationId, s.id);
        assert.equal(sb.candidateSessionId, f.id);
        assert.ok(typeof sb.quietMs === "number" && sb.quietMs >= QUIET);
        assert.match(String(r.json.result), /^⚠️ STALE BINDING SUSPECTED \(#4661\)/);
        assert.match(logs.join("\n"), /STALE BINDING suspected for conversation/);
    });

    it("NEGATIVE: fresh bound session keeps the hard 409 on a conflicting witness", async () => {
        const { s, f } = makePair();
        s.lastModelRequestAt = Date.now() - 60 * 1000; // live — not stale
        recordToolWitness(f.id, "acp_status", "{}");
        const r = await post({ conversationId: s.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 409);
        assert.equal(r.json.code, "TOOL_CONVERSATION_CONFLICT");
        assert.equal(r.json.staleBinding, undefined, "#2024 fail-closed stays intact for live bindings");
        assert.deepEqual(executedOn(), []);
    });

    it("NEGATIVE: stale bound + multi-witness conflict still fails closed (no guess)", async () => {
        const { s, f } = makePair();
        const g = getSession(`t-4661-g-${Math.random().toString(36).slice(2)}`);
        g.lastModelRequestAt = Date.now() - 120 * 1000;
        recordToolWitness(f.id, "acp_status", "{}");
        recordToolWitness(g.id, "acp_status", "{}");
        const r = await post({ conversationId: s.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 409);
        assert.equal(r.json.code, "TOOL_CONVERSATION_CONFLICT");
        assert.equal(r.json.staleBinding, undefined);
        assert.deepEqual(executedOn(), []);
    });

    it("NEGATIVE: nativeCaller conflict unchanged — honors the host id, no diagnosis", async () => {
        const { s, f } = makePair();
        recordToolWitness(f.id, "acp_status", "{}");
        const r = await post({ conversationId: s.id, tool: "acp_status", args: {}, nativeCaller: true });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [s.id], "#2024: host-stamped ids stay authoritative");
        assert.match(logs.join("\n"), /honoring the native caller, refusing the witness \(#2024\)/);
        assert.equal(r.json.staleBinding, undefined, "native callers are never diagnosed");
    });

    it("NEGATIVE: stale bound with no other active session → plain execution, no flag", async () => {
        const s = getSession(`t-4661-lonely-${Math.random().toString(36).slice(2)}`);
        s.lastModelRequestAt = Date.now() - 20 * 60 * 1000;
        const r = await post({ conversationId: s.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [s.id]);
        assert.equal(r.json.staleBinding, undefined);
        assert.ok(!String(r.json.result).includes("STALE BINDING"));
    });

    it("NEGATIVE: restored sessions never qualify as candidates", async () => {
        const { s, f } = makePair();
        f.restored = true; // disk-restored, no runtime traffic claim
        const r = await post({ conversationId: s.id, tool: "acp_status", args: {} });
        assert.equal(r.status, 200);
        assert.deepEqual(executedOn(), [s.id]);
        assert.equal(r.json.staleBinding, undefined);
    });

    it("status route exposes the additive staleBinding field (direct + fallback rows)", async () => {
        const { s, f } = makePair();
        const out = mockRes();
        handlePluginStatus(s.id, out.res, deps);
        assert.equal(out.status(), 200);
        const direct = JSON.parse(out.body()) as Record<string, unknown>;
        const sb = direct.staleBinding as Record<string, unknown>;
        assert.equal(sb.candidateSessionId, f.id);
        assert.equal(sb.boundConversationId, s.id);

        s.lastModelRequestAt = Date.now() - 60 * 1000; // live — not stale
        const outF = mockRes();
        handlePluginStatus(s.id, outF.res, deps);
        assert.equal(JSON.parse(outF.body()).staleBinding, undefined, "fresh bound session is never flagged");

        // fallback=latest resolving to the stale session must NOT be flagged —
        // adopting the latest is intentional, not a mis-binding.
        s.lastModelRequestAt = Date.now() - 20 * 60 * 1000;
        s.lastSeen = Date.now(); // strictly newest → fallback picks s
        const out3 = mockRes();
        handlePluginStatus("never-seen-4661", out3.res, deps, true);
        const fb = JSON.parse(out3.body()) as Record<string, unknown>;
        assert.equal(fb.fallback, true);
        assert.equal(fb.staleBinding, undefined, "viaFallback adoption is never flagged stale");
    });
});

// ─────────────────────────── Part B: shim contract ───────────────────────────

type CapturedBody = { conversationId?: unknown; tool?: unknown; args?: unknown; nativeCaller?: unknown };

/** Mock proxy whose /__bili/plugin/tool answers from a canned queue (last entry repeats). */
function startCannedProxy(canned: Array<Record<string, unknown>>): Promise<{ url: string; tools: CapturedBody[]; stop: () => Promise<void> }> {
    const tools: CapturedBody[] = [];
    let i = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = (raw ? JSON.parse(raw) : {}) as CapturedBody;
            if (req.method === "GET" && req.url === "/__bili/plugin/manifest") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ tools: { anthropic: [{ name: "acp_status", description: "s", input_schema: { type: "object" } }] } }));
                return;
            }
            if (req.method === "POST" && req.url === "/__bili/plugin/register") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            if (req.method === "POST" && req.url === "/__bili/plugin/tool") {
                tools.push(parsed);
                const rawEntry = canned[Math.min(i++, canned.length - 1)];
                // _http overrides the response status line (the shim branches on
                // res.status, not the JSON body); never echoed into the payload.
                const httpStatus = typeof rawEntry._http === "number" ? rawEntry._http : 200;
                const payload = { ...rawEntry };
                delete payload._http;
                res.writeHead(httpStatus, { "content-type": "application/json" });
                res.end(JSON.stringify(payload));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "not found" }));
        });
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        tools,
        stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    }));
}

/** Minimal multi-call client driving the REAL src/mcp.ts over stdio JSON-RPC
 *  (mcp-native-thread.test.ts pattern). Env spreads process.env so PATH survives. */
class ShimClient {
    private child: ReturnType<typeof spawn>;
    stderr = "";
    private pending = new Map<number, (msg: unknown) => void>();
    private buf = "";

    constructor(env: NodeJS.ProcessEnv) {
        this.child = spawn(process.execPath, ["--import", "tsx", "src/mcp.ts"], {
            cwd: process.cwd(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout?.setEncoding("utf8");
        this.child.stderr?.setEncoding("utf8");
        this.child.stdout?.on("data", (d: string) => {
            this.buf += d;
            let nl: number;
            while ((nl = this.buf.indexOf("\n")) >= 0) {
                const line = this.buf.slice(0, nl).trim();
                this.buf = this.buf.slice(nl + 1);
                if (!line) continue;
                try {
                    const msg = JSON.parse(line) as { id?: unknown };
                    if (typeof msg.id === "number") {
                        const waiter = this.pending.get(msg.id);
                        if (waiter) {
                            this.pending.delete(msg.id);
                            waiter(msg);
                        }
                    }
                } catch { /* non-JSON line — ignore */ }
            }
        });
        this.child.stderr?.on("data", (d: string) => { this.stderr += d; });
        this.child.on("error", () => this.failAll("shim spawn failed"));
    }

    private failAll(reason: string): void {
        for (const waiter of [...this.pending.values()]) waiter({ error: reason, stderr: this.stderr.slice(0, 400) });
        this.pending.clear();
    }

    private send(obj: unknown): void {
        this.child.stdin?.write(`${JSON.stringify(obj)}\n`);
    }

    request(id: number, method: string, params?: Record<string, unknown>): Promise<{ result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: unknown; stderr?: string }> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`shim ${method} (id ${id}) timed out; stderr: ${this.stderr.slice(0, 400)}`));
            }, 20_000);
            this.pending.set(id, (msg) => {
                clearTimeout(timer);
                resolve(msg as { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: unknown; stderr?: string });
            });
            this.send({ jsonrpc: "2.0", id, method, ...(params ? { params : params} : {}) });
        });
    }

    async init(meta?: { ui?: { sessionId?: string } }): Promise<void> {
        const r = await this.request(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zcode-mcp-client", version: "1.0.0" }, ...(meta ? { _meta: meta } : {}) });
        assert.ok(r.result, `initialize must succeed; stderr: ${this.stderr.slice(0, 400)}`);
        this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    }

    close(): void {
        this.child.kill();
    }
}

function callText(r: { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: unknown }): { isError: boolean; text: string } {
    if (r.error) return { isError: true, text: String(r.error) };
    const content = r.result?.content ?? [];
    return { isError: r.result?.isError === true, text: content.map((c) => c.text ?? "").join("") };
}

const PIN = "4661-stale-pin-session";
const LIVE = "4661-live-session";
const IDENT = "4661-identity-binding";
const THREAD = "4661-native-thread";

test("#4661 shim: static pin + proxy-proven staleness → adopt candidate AND retry once", async () => {
    const mock = await startCannedProxy([
        { ok: true, result: "FROZEN ZEROS", staleBinding: { boundConversationId: PIN, candidateSessionId: LIVE, quietMs: 900_000 } },
        { ok: true, result: "LIVE LEDGER" },
    ]);
    try {
        const c = new ShimClient({ ...process.env, BILI_MCP_PROXY: mock.url, BILI_CONVERSATION_ID: PIN, CLAUDE_CODE_SESSION_ID: "" });
        try {
            await c.init();
            const r = await c.request(1, "tools/call", { name: "acp_status", arguments: {} });
            const t = callText(r);
            assert.equal(t.isError, false);
            assert.equal(t.text, "LIVE LEDGER", "the retried call's answer comes back to the caller");
            assert.equal(mock.tools.length, 2, "exactly one retry");
            assert.equal(mock.tools[0].conversationId, PIN);
            assert.equal(mock.tools[1].conversationId, LIVE, "adopted candidate used directly (verbatim-id fallback)");
            assert.match(c.stderr, /adopting live conversation/);
            assert.match(c.stderr, /session binding "4661-stale-pin-session" is STATIC/);
        } finally {
            c.close();
        }
    } finally {
        await mock.stop();
    }
});

test("#4661 shim: static pin + #4168 conflict 409 → one-shot rebind via recency facts", async () => {
    const namedSeen = Date.now() - 3_600_000;
    const witnessSeen = Date.now() - 60_000;
    const mock = await startCannedProxy([
        { _http: 409, ok: false, code: "TOOL_CONVERSATION_CONFLICT", error: `outbound tool witness does not match conversationId — your captured conversation id "${PIN}" is stale: the identical call lives in conversation "${LIVE}". Re-send with conversation_id="${LIVE}", or restart the client to re-bind.`, conversationId: PIN, namedSessionId: PIN, witnessSessions: [LIVE], namedSessionLastSeen: namedSeen, witnessLastSeen: witnessSeen },
        { ok: true, result: "LIVE LEDGER" },
    ]);
    try {
        const c = new ShimClient({ ...process.env, BILI_MCP_PROXY: mock.url, BILI_CONVERSATION_ID: PIN, CLAUDE_CODE_SESSION_ID: "" });
        try {
            await c.init();
            const r = await c.request(1, "tools/call", { name: "acp_status", arguments: {} });
            const t = callText(r);
            assert.equal(t.isError, false, "the retry after rebind succeeds");
            assert.equal(t.text, "LIVE LEDGER");
            assert.equal(mock.tools.length, 2, "exactly one retry after the 409");
            assert.equal(mock.tools[1].conversationId, LIVE, "#4661: static-pin bindings now arm #4168's 409 adoption");
            assert.match(c.stderr, /re-binding/);
        } finally {
            c.close();
        }
    } finally {
        await mock.stop();
    }
});

test("#4661 shim NEGATIVE: _meta-bound (neither identity nor static pin) keeps the loud 409, no adoption", async () => {
    const META = "4661-meta-binding";
    const namedSeen = Date.now() - 3_600_000;
    const witnessSeen = Date.now() - 60_000;
    const mock = await startCannedProxy([
        { _http: 409, ok: false, code: "TOOL_CONVERSATION_CONFLICT", error: `outbound tool witness does not match conversationId — your captured conversation id "${META}" is stale: the identical call lives in conversation "${LIVE}". Re-send with conversation_id="${LIVE}", or restart the client to re-bind.`, conversationId: META, namedSessionId: META, witnessSessions: [LIVE], namedSessionLastSeen: namedSeen, witnessLastSeen: witnessSeen },
        { ok: true, result: "LIVE LEDGER" },
    ]);
    try {
        const c = new ShimClient({ ...process.env, BILI_MCP_PROXY: mock.url, BILI_CONVERSATION_ID: "", CLAUDE_CODE_SESSION_ID: "" });
        try {
            // bind through initialize _meta.ui.sessionId — a binding kind neither
            // ORPHAN_ADOPT nor the #4661 static-pin extension arms for.
            await c.init({ ui: { sessionId: META } });
            const r = await c.request(1, "tools/call", { name: "acp_status", arguments: {} });
            const t = callText(r);
            assert.ok(t.isError || t.text.includes("outbound tool witness does not match"), "the 409 error surfaces to the caller");
            assert.ok(!t.text.includes("LIVE LEDGER"), "no silent retry against the sibling session");
            assert.equal(mock.tools.length, 1, "no adoption → no retry");
            assert.ok(!c.stderr.includes("re-binding"));
        } finally {
            c.close();
        }
    } finally {
        await mock.stop();
    }
});

test("#4661 shim: BILI_MCP_NO_STALE_ADOPT=1 disables adoption (frozen answer passes through)", async () => {
    const mock = await startCannedProxy([
        { ok: true, result: "FROZEN ZEROS", staleBinding: { boundConversationId: PIN, candidateSessionId: LIVE, quietMs: 900_000 } },
        { ok: true, result: "LIVE LEDGER" },
    ]);
    try {
        const c = new ShimClient({ ...process.env, BILI_MCP_PROXY: mock.url, BILI_CONVERSATION_ID: PIN, CLAUDE_CODE_SESSION_ID: "", BILI_MCP_NO_STALE_ADOPT: "1" });
        try {
            await c.init();
            const r = await c.request(1, "tools/call", { name: "acp_status", arguments: {} });
            const t = callText(r);
            assert.equal(t.text, "FROZEN ZEROS", "opt-out: the bound session's answer stands");
            assert.equal(mock.tools.length, 1);
            assert.ok(!c.stderr.includes("adopting live conversation"));
        } finally {
            c.close();
        }
    } finally {
        await mock.stop();
    }
});

test("#4661 shim: native per-call routes never consume the adoption; identity binding skips the static warning", async () => {
    const mock = await startCannedProxy([
        { ok: true, result: "NATIVE OK" },
        { ok: true, result: "FROZEN ZEROS", staleBinding: { boundConversationId: IDENT, candidateSessionId: LIVE, quietMs: 900_000, action: "executed-on-bound" } },
        { ok: true, result: "LIVE LEDGER" },
    ]);
    try {
        const c = new ShimClient({ ...process.env, BILI_MCP_PROXY: mock.url, BILI_CONVERSATION_ID: "", CLAUDE_CODE_SESSION_ID: IDENT });
        try {
            await c.init();
            await c.request(1, "tools/call", { name: "acp_status", arguments: {}, _meta: { threadId: THREAD } });
            const r = await c.request(2, "tools/call", { name: "acp_status", arguments: {} });
            const t = callText(r);
            assert.equal(t.text, "LIVE LEDGER");
            assert.equal(mock.tools.length, 3);
            assert.equal(mock.tools[0].conversationId, THREAD, "native route first…");
            assert.equal(mock.tools[0].nativeCaller, true, "…host-stamped");
            assert.equal(mock.tools[1].conversationId, IDENT, "global binding untouched by the native call");
            assert.equal(mock.tools[2].conversationId, LIVE, "adoption happens on the next plain call");
            assert.ok(!c.stderr.includes("is STATIC"), "identity bindings do not get the static-pin warning");
        } finally {
            c.close();
        }
    } finally {
        await mock.stop();
    }
});
