// #2752: the endpoint's machine-readable compress outcome (#1875) was dropped
// at the host forwarding layer — shared.forwardTool and the MCP shim's own
// forwardTool both collapsed {text, failed}, so a PARTIAL fold (some ranges
// applied, some not) reached every host as an ordinary non-error result whose
// leading receipt line reads as a clean success. This suite pins:
//   1. both forwarders pass outcome/blocksCreated through, defensively parsed
//      (legacy envelopes without the fields, malformed values → absent);
//   2. ONLY a partial envelope gains the appended [acp-result: PARTIAL …] note
//      — applied/refused/failure/legacy texts stay byte-identical to before;
//   3. isError semantics are unchanged: failure/refused stay errors (incl. the
//      idempotent "already compressed" refusal), partial stays non-error;
//   4. the pi lane exposes the structured state on AgentToolResult.details on
//      BOTH branches; the MCP lane rides structuredContent.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

import { partialOutcomeNote } from "../src/proxy-tool-result.ts";
import { forwardTool as sharedForwardTool } from "../src/agent/shared.ts";
import { forwardTool as mcpForwardTool } from "../src/mcp.ts";
import { createBiliPlugin } from "../src/agent/pi.ts";

const APPLIED_TEXT = "[Compressed m00001–m00100 → 2 block(s), ~5000 tokens saved.]";
const PARTIAL_TEXT = "[Compressed m00001–m00200 → 1 block(s), ~4000 tokens saved. Errors: m00101–m00200: unknown ref]";
const REFUSED_TEXT = "[Compression FAILED: requested range(s) resolved to no messages]";
const IDEMPOTENT_REFUSED_TEXT = "[Compression FAILED: m00001–m00010 already compressed into b1]";
const FAILURE_TEXT = "[decompress FAILED: could not write export to /tmp/x.txt: ENOENT]";

type Envelope = Record<string, unknown>;

async function startCannedProxy(): Promise<{ origin: string; canned: Map<string, Envelope>; close(): Promise<void> }> {
    const canned = new Map<string, Envelope>();
    const server = http.createServer((req, res) => {
        if (req.url !== "/__bili/plugin/tool") { res.writeHead(404).end("nope"); return; }
        let raw = "";
        req.on("data", (d) => { raw += d; });
        req.on("end", () => {
            const parsed = JSON.parse(raw) as { tool?: string };
            const payload = canned.get(parsed.tool ?? "") ?? { ok: false, error: "unexpected tool" };
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    let closed = false;
    return {
        origin: `http://127.0.0.1:${port}`,
        canned,
        close: () => closed ? Promise.resolve() : (closed = true, new Promise<void>((r) => server.close(() => r()))),
    };
}

describe("#2752: shared.forwardTool carries the endpoint outcome through", () => {
    let proxy: Awaited<ReturnType<typeof startCannedProxy>> | null = null;

    beforeEach(async () => { proxy = await startCannedProxy(); });
    afterEach(async () => { if (proxy) await proxy.close(); });

    it("applied: structured state passes through, text byte-stable", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: APPLIED_TEXT, outcome: "applied", blocksCreated: 2 });
        const out = await sharedForwardTool(proxy.origin, "conv-1", "compress", { content: [] });
        assert.equal(out.failed, false);
        assert.equal(out.outcome, "applied");
        assert.equal(out.blocksCreated, 2);
        assert.equal(out.text, APPLIED_TEXT, "applied receipts keep their exact historical bytes");
    });

    it("partial: exactly one marker line appended after the untouched original", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: PARTIAL_TEXT, outcome: "partial", blocksCreated: 1 });
        const out = await sharedForwardTool(proxy.origin, "conv-1", "compress", { content: [] });
        assert.equal(out.failed, false, "partial stays a non-error (work landed)");
        assert.equal(out.outcome, "partial");
        assert.equal(out.blocksCreated, 1);
        assert.equal(out.text, `${PARTIAL_TEXT}\n${partialOutcomeNote(1)}`);
        assert.ok(out.text.startsWith(PARTIAL_TEXT + "\n"), "the kernel receipt bytes are preserved verbatim in front");
    });

    it("partial without blocksCreated: marker drops the count, keeps the warning", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: PARTIAL_TEXT, outcome: "partial" });
        const out = await sharedForwardTool(proxy.origin, "conv-1", "compress", { content: [] });
        assert.equal(out.failed, false);
        assert.equal(out.outcome, "partial");
        assert.equal(out.blocksCreated, undefined);
        assert.equal(out.text, `${PARTIAL_TEXT}\n${partialOutcomeNote(undefined)}`);
        assert.doesNotMatch(out.text, /block\(s\) created/);
    });

    it("refused: failed:true, byte-stable text, state still passes through", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: REFUSED_TEXT, outcome: "refused", blocksCreated: 0 });
        const out = await sharedForwardTool(proxy.origin, "conv-1", "compress", { content: [] });
        assert.equal(out.failed, true);
        assert.equal(out.outcome, "refused");
        assert.equal(out.blocksCreated, 0);
        assert.equal(out.text, REFUSED_TEXT, "refused receipts gain no marker (isError already makes them unmissable)");
    });

    it("idempotent refusal (already compressed) stays failed:true — never reclassified as partial", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: IDEMPOTENT_REFUSED_TEXT, outcome: "refused", blocksCreated: 0 });
        const out = await sharedForwardTool(proxy.origin, "conv-1", "compress", { content: [] });
        assert.equal(out.failed, true, "a skipped/already-folded range is a refusal, not a partial success");
        assert.doesNotMatch(out.text, /\[acp-result: PARTIAL/);
    });

    it("failure: failed:true, byte-stable text", async () => {
        assert.ok(proxy);
        proxy.canned.set("decompress", { ok: true, result: FAILURE_TEXT, outcome: "failure" });
        const out = await sharedForwardTool(proxy.origin, "conv-1", "decompress", { blockId: "b999" });
        assert.equal(out.failed, true);
        assert.equal(out.outcome, "failure");
        assert.equal(out.text, FAILURE_TEXT);
    });

    it("legacy envelope (no outcome/blocksCreated): old shape, no fields, no marker", async () => {
        assert.ok(proxy);
        proxy.canned.set("acp_status", { ok: true, result: "CONTEXT STATUS" });
        const out = await sharedForwardTool(proxy.origin, "conv-1", "acp_status", {});
        assert.equal(out.failed, false);
        assert.equal(out.outcome, undefined);
        assert.equal(out.blocksCreated, undefined);
        assert.equal(out.text, "CONTEXT STATUS");
    });

    it("malformed outcome values are treated as absent — no marker, no field, not a failure", async () => {
        assert.ok(proxy);
        for (const bad of ["PARTIAL", "Applied", 42, null, {}]) {
            proxy.canned.set("acp_status", { ok: true, result: "CONTEXT STATUS", outcome: bad });
            const out = await sharedForwardTool(proxy.origin, "conv-1", "acp_status", {});
            assert.equal(out.failed, false, `outcome=${JSON.stringify(bad)} must not flip failed`);
            assert.equal(out.outcome, undefined, `outcome=${JSON.stringify(bad)} must degrade to absent`);
            assert.equal(out.text, "CONTEXT STATUS", `outcome=${JSON.stringify(bad)} must gain no marker`);
        }
    });

    it("malformed blocksCreated values are treated as absent", async () => {
        assert.ok(proxy);
        for (const bad of ["3", -1, 1.5, null, []]) {
            proxy.canned.set("compress", { ok: true, result: APPLIED_TEXT, outcome: "applied", blocksCreated: bad });
            const out = await sharedForwardTool(proxy.origin, "conv-1", "compress", { content: [] });
            assert.equal(out.blocksCreated, undefined, `blocksCreated=${JSON.stringify(bad)} must degrade to absent`);
            assert.equal(out.outcome, "applied");
        }
    });

    it("ok:false hard error still throws (transport contract unchanged)", async () => {
        assert.ok(proxy);
        const p = proxy;
        p.canned.set("acp_cache", { ok: false, error: "boom" });
        await assert.rejects(() => sharedForwardTool(p.origin, "conv-1", "acp_cache", {}), /boom/);
    });
});

describe("#2752: the MCP shim's own forwardTool keeps the same contract", () => {
    let proxy: Awaited<ReturnType<typeof startCannedProxy>> | null = null;
    let prevEnv: string | undefined;

    beforeEach(async () => {
        proxy = await startCannedProxy();
        prevEnv = process.env.BILI_MCP_PROXY;
        process.env.BILI_MCP_PROXY = proxy.origin;
    });
    afterEach(async () => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
        if (proxy) await proxy.close();
    });

    it("partial: failed:false, state passes through, marker appended", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: PARTIAL_TEXT, outcome: "partial", blocksCreated: 1 });
        const out = await mcpForwardTool("compress", {}, 3000, "conv-mcp");
        assert.equal(out.failed, false);
        assert.equal(out.outcome, "partial");
        assert.equal(out.blocksCreated, 1);
        assert.equal(out.text, `${PARTIAL_TEXT}\n${partialOutcomeNote(1)}`);
    });

    it("applied: byte-stable, no marker", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: APPLIED_TEXT, outcome: "applied", blocksCreated: 2 });
        const out = await mcpForwardTool("compress", {}, 3000, "conv-mcp");
        assert.equal(out.failed, false);
        assert.equal(out.text, APPLIED_TEXT);
    });

    it("refused: failed:true, byte-stable", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: IDEMPOTENT_REFUSED_TEXT, outcome: "refused", blocksCreated: 0 });
        const out = await mcpForwardTool("compress", {}, 3000, "conv-mcp");
        assert.equal(out.failed, true);
        assert.equal(out.outcome, "refused");
        assert.equal(out.text, IDEMPOTENT_REFUSED_TEXT);
    });

    it("legacy envelope: no fields, no marker", async () => {
        assert.ok(proxy);
        proxy.canned.set("acp_status", { ok: true, result: "CONTEXT STATUS" });
        const out = await mcpForwardTool("acp_status", {}, 3000, "conv-mcp");
        assert.equal(out.failed, false);
        assert.equal(out.outcome, undefined);
        assert.equal(out.blocksCreated, undefined);
        assert.equal(out.text, "CONTEXT STATUS");
    });
});

// ——— pi lane end-to-end: manifest tool execute() against a canned proxy ————

type RecordedPiTool = { name: string; parameters: unknown; execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown }> };

type FakePi = {
    events: Map<string, (event: unknown, ctx: unknown) => unknown>;
    tools: RecordedPiTool[];
    on: (event: string, handler: (event: never, ctx: never) => unknown) => void;
    registerTool: (tool: RecordedPiTool) => void;
    registerCommand: (name: string, options: Record<string, unknown>) => void;
};

function makeFakePi(): FakePi {
    const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools: RecordedPiTool[] = [];
    return {
        events,
        tools,
        on: (event, handler) => {
            const h = handler as (event: unknown, ctx: unknown) => unknown;
            const prev = events.get(event);
            events.set(event, prev ? ((e, c) => { prev(e, c); return h(e, c); }) : h);
        },
        registerTool: (tool) => tools.push(tool),
        registerCommand: () => {},
    };
}

async function waitForTools(pi: FakePi, count: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pi.tools.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} registered tools; got ${pi.tools.length}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

async function startPiFakeProxy(canned: Map<string, Envelope>): Promise<{ origin: string; close(): Promise<void> }> {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ tools: { anthropic: [
                { name: "compress", description: "Compress context ranges", input_schema: { type: "object", properties: { content: { type: "array" } }, required: ["content"] } },
                { name: "decompress", description: "Restore", input_schema: { type: "object", properties: { blockId: { type: "string" } }, required: ["blockId"] } },
                { name: "acp_status", description: "Status", input_schema: { type: "object", properties: {} } },
            ] } }));
            return;
        }
        if (url === "/__bili/plugin/tool" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { tool?: string };
                const payload = canned.get(data.tool ?? "") ?? { ok: false, error: "unexpected tool" };
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
            });
            return;
        }
        if (url.startsWith("/__bili/plugin/register") || url.startsWith("/__bili/plugin/runtime-info")) {
            req.resume();
            req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })); });
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, contextTokens: 1 }));
            return;
        }
        res.writeHead(404).end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    let closed = false;
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () => closed ? Promise.resolve() : (closed = true, new Promise<void>((r) => server.close(() => r()))),
    };
}

describe("#2752: the pi lane exposes outcome/blocksCreated on details, isError unchanged", () => {
    let proxy: Awaited<ReturnType<typeof startPiFakeProxy>> | null = null;
    const canned = new Map<string, Envelope>();
    let pi: FakePi | null = null;
    let fakeCtx: (() => Record<string, unknown>) | null = null;

    beforeEach(async () => {
        canned.clear();
        proxy = await startPiFakeProxy(canned);
        fakeCtx = () => ({
            sessionManager: { getSessionId: () => "sess-2752" },
            model: { contextWindow: 1_000_000, baseUrl: `${proxy!.origin}/bili/https://api.example.com/v1` },
            cwd: "/tmp",
        });
        pi = makeFakePi();
        createBiliPlugin("pi")(pi as never);
        await pi.events.get("session_start")!({}, fakeCtx());
        await waitForTools(pi, 3);
    });
    afterEach(async () => {
        pi = null;
        fakeCtx = null;
        if (proxy) await proxy.close();
    });

    const exec = async (name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown }> => {
        assert.ok(pi && fakeCtx);
        const tool = pi.tools.find((t) => t.name === name);
        assert.ok(tool, `manifest served ${name}`);
        return tool.execute("call-1", args, undefined, undefined, fakeCtx()) as never;
    };

    it("partial: non-error, marker in the host-visible text, structured state on details", async () => {
        canned.set("compress", { ok: true, result: PARTIAL_TEXT, outcome: "partial", blocksCreated: 1 });
        const out = await exec("compress", { content: [] });
        assert.notEqual(out.isError, true, "partial is NOT an error — the applied block stands");
        assert.equal(out.content[0]?.text, `${PARTIAL_TEXT}\n${partialOutcomeNote(1)}`);
        assert.deepEqual(out.details, { outcome: "partial", blocksCreated: 1 });
    });

    it("applied: clean success, no marker, details carry the full-applied state", async () => {
        canned.set("compress", { ok: true, result: APPLIED_TEXT, outcome: "applied", blocksCreated: 2 });
        const out = await exec("compress", { content: [] });
        assert.notEqual(out.isError, true);
        assert.equal(out.content[0]?.text, APPLIED_TEXT);
        assert.deepEqual(out.details, { outcome: "applied", blocksCreated: 2 });
    });

    it("refused: isError:true with the receipt byte-stable and its outcome on details", async () => {
        canned.set("compress", { ok: true, result: IDEMPOTENT_REFUSED_TEXT, outcome: "refused", blocksCreated: 0 });
        const out = await exec("compress", { content: [] });
        assert.equal(out.isError, true, "a fully refused batch still errors (idempotent skip included)");
        assert.equal(out.content[0]?.text, IDEMPOTENT_REFUSED_TEXT);
        assert.deepEqual(out.details, { outcome: "refused", blocksCreated: 0 });
    });

    it("failure: isError:true, details carry the failure outcome", async () => {
        canned.set("decompress", { ok: true, result: FAILURE_TEXT, outcome: "failure" });
        const out = await exec("decompress", { blockId: "b999" });
        assert.equal(out.isError, true);
        assert.equal(out.content[0]?.text, FAILURE_TEXT);
        assert.deepEqual(out.details, { outcome: "failure" });
    });

    it("legacy envelope: no details field at all (old hosts see the old shape)", async () => {
        canned.set("acp_status", { ok: true, result: "CONTEXT STATUS" });
        const out = await exec("acp_status", {});
        assert.notEqual(out.isError, true);
        assert.equal(out.content[0]?.text, "CONTEXT STATUS");
        assert.equal(out.details, undefined);
    });
});

// ——— MCP wire level: the real shim over stdio JSON-RPC ——————————————————

type WireResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

class WireShimClient {
    private child: ReturnType<typeof spawn>;
    private stderr = "";
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
    }

    request(id: number, method: string, params?: Record<string, unknown>): Promise<{ result?: WireResult; error?: unknown }> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`shim ${method} (id ${id}) timed out; stderr: ${this.stderr.slice(0, 400)}`));
            }, 20_000);
            this.pending.set(id, (msg) => {
                clearTimeout(timer);
                resolve(msg as { result?: WireResult; error?: unknown });
            });
            this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
        });
    }

    async init(): Promise<void> {
        const r = await this.request(0, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "bili-wire-test", version: "0.1.0" },
        });
        assert.ok(r.result && !r.error, `initialize must succeed; stderr: ${this.stderr.slice(0, 400)}`);
        this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    }

    close(): void { this.child.kill(); }
}

describe("#2752: the shim's tools/call response carries structuredContent on the wire", () => {
    let proxy: Awaited<ReturnType<typeof startCannedProxy>> | null = null;
    let client: WireShimClient | null = null;

    beforeEach(async () => {
        proxy = await startCannedProxy();
        proxy.canned.set("compress", { ok: true, result: PARTIAL_TEXT, outcome: "partial", blocksCreated: 1 });
        proxy.canned.set("decompress", { ok: true, result: FAILURE_TEXT, outcome: "failure" });
        proxy.canned.set("acp_status", { ok: true, result: "CONTEXT STATUS" });
        client = new WireShimClient({ ...process.env, BILI_MCP_PROXY: proxy.origin, BILI_CONVERSATION_ID: "conv-wire-2752" });
        await client.init();
    });
    afterEach(() => {
        client?.close();
        client = null;
        if (proxy) void proxy.close();
        proxy = null;
    });

    it("partial: isError false, marker in content text, structured state on structuredContent", async () => {
        assert.ok(client);
        const r = await client.request(1, "tools/call", { name: "compress", arguments: { content: [] } });
        assert.ok(!r.error, `no JSON-RPC error: ${JSON.stringify(r.error)}`);
        assert.ok(r.result, "a result object comes back");
        assert.notEqual(r.result!.isError, true, "partial is NOT an error on the wire");
        assert.equal(r.result!.content?.[0]?.text, `${PARTIAL_TEXT}\n${partialOutcomeNote(1)}`);
        // #3472: structuredContent also carries the full report text so
        // structured-preferring hosts do not lose the receipt body.
        assert.deepEqual(r.result!.structuredContent, { text: `${PARTIAL_TEXT}\n${partialOutcomeNote(1)}`, outcome: "partial", blocksCreated: 1 });
    });

    it("failure: isError true with its outcome still on structuredContent", async () => {
        assert.ok(client);
        const r = await client.request(2, "tools/call", { name: "decompress", arguments: { blockId: "b999" } });
        assert.ok(!r.error, `no JSON-RPC error: ${JSON.stringify(r.error)}`);
        assert.equal(r.result?.isError, true);
        // #3472: the failure receipt text rides structuredContent too.
        assert.deepEqual(r.result?.structuredContent, { text: FAILURE_TEXT, outcome: "failure" });
    });

    it("legacy envelope: no structuredContent field at all", async () => {
        assert.ok(client);
        const r = await client.request(3, "tools/call", { name: "acp_status", arguments: {} });
        assert.ok(!r.error, `no JSON-RPC error: ${JSON.stringify(r.error)}`);
        assert.notEqual(r.result?.isError, true);
        assert.equal(r.result?.content?.[0]?.text, "CONTEXT STATUS");
        assert.equal(r.result?.structuredContent, undefined, "clients predating the field see exactly the old shape");
    });
});
