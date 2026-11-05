// #3472: since #2752 the MCP shim attaches structuredContent {outcome,
// blocksCreated} to every result carrying machine state. Some hosts (Claude
// Code via its MCP bridge) prefer structuredContent when present and DROP the
// content text — every success call reached the model as bare
// {"outcome":"success"} and the whole report (compressible ranges, GRAND
// LEDGER, search hits, restored content) was lost. The fix makes
// structuredContent self-contained: it carries the full report itself
// (structured.text = out.text, byte-identical to content[0].text) alongside
// the machine fields. Pinned here through the REAL shim over stdio JSON-RPC:
//   1. success envelopes (acp_status / acp_cache / search_context / decompress):
//      structuredContent.text === content[0].text byte-for-byte, outcome kept;
//   2. compress applied/partial: the #2752 machine fields are unchanged, the
//      text is present and byte-stable (partial incl. the marker line);
//   3. legacy envelopes (no outcome/blocksCreated): NO structuredContent at
//      all — pre-#2752 clients see exactly the old shape;
//   4. isError semantics unchanged (failure/refused stay errors, partial stays
//      non-error) and content[0].text stays byte-stable everywhere, so
//      content-reading hosts are untouched.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";

import { partialOutcomeNote } from "../src/proxy-tool-result.ts";

const STATUS_REPORT = [
    "ACTIVE SURFACE:",
    "Breakdown: 10.0K system (30%) | 23.3K tool (70%)",
    "Compressible ranges (1, oldest first):",
    "- m00001–m00010  1.2K effective  tool",
].join("\n");
const CACHE_REPORT = "GRAND LEDGER:\ntotal input 1,000,000 · cached 960,000 (96.0%)\nFOLD ECONOMICS:\nb1 net saved 12,000 — paid back";
const SEARCH_REPORT = 'Found 2 block(s) for "auth":\n\n[b2] "Auth System Exploration" — m00010–m00050';
const DECOMPRESSED_BODY = "[decompress b1 m00001–m00010: restored 10 item(s) — full content follows]\n<original bytes>";
const APPLIED_TEXT = "[Compressed m00001–m00100 → 2 block(s), ~5000 tokens saved.]";
const PARTIAL_TEXT = "[Compressed m00001–m00200 → 1 block(s), ~4000 tokens saved. Errors: m00101–m00200: unknown ref]";
const REFUSED_TEXT = "[Compression FAILED: requested range(s) resolved to no messages]";

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

describe("#3472: structuredContent carries the full report for structured-preferring hosts", () => {
    let proxy: Awaited<ReturnType<typeof startCannedProxy>> | null = null;
    let client: WireShimClient | null = null;

    beforeEach(async () => {
        proxy = await startCannedProxy();
        proxy.canned.set("acp_status", { ok: true, result: STATUS_REPORT, outcome: "success" });
        proxy.canned.set("acp_cache", { ok: true, result: CACHE_REPORT, outcome: "success" });
        proxy.canned.set("search_context", { ok: true, result: SEARCH_REPORT, outcome: "success" });
        proxy.canned.set("decompress", { ok: true, result: DECOMPRESSED_BODY, outcome: "success" });
        proxy.canned.set("compress", { ok: true, result: APPLIED_TEXT, outcome: "applied", blocksCreated: 2 });
        client = new WireShimClient({ ...process.env, BILI_MCP_PROXY: proxy.origin, BILI_CONVERSATION_ID: "conv-wire-3472" });
        await client.init();
    });
    afterEach(() => {
        client?.close();
        client = null;
        if (proxy) void proxy.close();
        proxy = null;
    });

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<WireResult> => {
        assert.ok(client);
        const r = await client.request(name.length + 1, "tools/call", { name, arguments: args });
        assert.ok(!r.error, `no JSON-RPC error: ${JSON.stringify(r.error)}`);
        assert.ok(r.result, "a result object comes back");
        return r.result!;
    };

    it("acp_status success: the complete report is recoverable from structuredContent alone", async () => {
        const r = await call("acp_status");
        assert.notEqual(r.isError, true);
        assert.equal(r.content?.[0]?.text, STATUS_REPORT);
        assert.deepEqual(r.structuredContent, { text: STATUS_REPORT, outcome: "success" },
            "a host that renders only structuredContent must still see the full status report");
    });

    it("acp_cache / search_context / decompress success: full body inside structuredContent, outcome kept", async () => {
        const cases: Array<[string, Record<string, unknown>, string]> = [
            ["acp_cache", {}, CACHE_REPORT],
            ["search_context", { query: "auth" }, SEARCH_REPORT],
            ["decompress", { blockId: "b1" }, DECOMPRESSED_BODY],
        ];
        for (const [name, args, body] of cases) {
            const r = await call(name, args);
            assert.notEqual(r.isError, true, name);
            assert.equal(r.content?.[0]?.text, body, `${name}: content text byte-stable`);
            assert.deepEqual(r.structuredContent, { text: body, outcome: "success" }, `${name}: structured carries the full body`);
        }
    });

    it("compress applied: the #2752 machine fields stay intact, text rides alongside", async () => {
        const r = await call("compress", { content: [] });
        assert.notEqual(r.isError, true);
        assert.equal(r.content?.[0]?.text, APPLIED_TEXT);
        assert.deepEqual(r.structuredContent, { text: APPLIED_TEXT, outcome: "applied", blocksCreated: 2 });
    });

    it("compress partial: marker line present in BOTH carriers, machine state unchanged", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: PARTIAL_TEXT, outcome: "partial", blocksCreated: 1 });
        const r = await call("compress", { content: [] });
        assert.notEqual(r.isError, true, "partial stays non-error (work landed)");
        const expected = `${PARTIAL_TEXT}\n${partialOutcomeNote(1)}`;
        assert.equal(r.content?.[0]?.text, expected);
        assert.deepEqual(r.structuredContent, { text: expected, outcome: "partial", blocksCreated: 1 });
    });

    it("refused: isError true, receipt text in both carriers", async () => {
        assert.ok(proxy);
        proxy.canned.set("compress", { ok: true, result: REFUSED_TEXT, outcome: "refused", blocksCreated: 0 });
        const r = await call("compress", { content: [] });
        assert.equal(r.isError, true);
        assert.equal(r.content?.[0]?.text, REFUSED_TEXT);
        assert.deepEqual(r.structuredContent, { text: REFUSED_TEXT, outcome: "refused", blocksCreated: 0 });
    });

    it("legacy envelope (no outcome/blocksCreated): NO structuredContent — old clients see the old shape", async () => {
        assert.ok(proxy);
        proxy.canned.set("acp_status", { ok: true, result: "CONTEXT STATUS" });
        const r = await call("acp_status");
        assert.notEqual(r.isError, true);
        assert.equal(r.content?.[0]?.text, "CONTEXT STATUS");
        assert.equal(r.structuredContent, undefined, "pre-#2752 envelopes keep their exact wire shape");
    });
});
