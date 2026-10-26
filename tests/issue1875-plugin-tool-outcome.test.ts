// #1875: POST /__bili/plugin/tool answered {ok:true} even when the kernel
// refused the work (0 blocks created, "[Compression FAILED …" receipt), so
// clients checking `ok` alone believed a refused fold succeeded — the
// confusion class behind #1869. Contract fix (owner-approved Option B):
// `ok` keeps meaning "transport + execution succeeded"; the business effect
// rides additive fields — `outcome` ("applied"|"partial"|"refused"|"success"|
// "failure") and, for compress, `blocksCreated` — while `result` stays the
// byte-stable human/model-facing receipt. Disabled-opt-in note envelopes
// (#1192) and 400/500 error envelopes are unchanged. This suite pins every
// facet: endpoint envelope, executor outcome mapping, #1192 preservation,
// and the MCP shim's isError mapping.
import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginTool } from "../src/plugin.ts";
import { getSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { forwardTool } from "../src/mcp.ts";

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => { status = code; return undefined; },
        end: (chunk: unknown) => { body = String(chunk ?? ""); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

describe("#1875: plugin tool endpoint reports business outcome, not just ok:true", () => {
    let deps: PluginToolDeps;
    let sessionId: string;

    beforeEach(() => {
        _resetPluginStateForTest();
        deps = { core: createCore(), config: defaultConfig(400_000), log: () => {} };
        sessionId = getSession(`t-1875-${Math.random().toString(36).slice(2)}`).id;
    });

    async function call(tool: string, args: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
        const out = mockRes();
        await handlePluginTool(JSON.stringify({ conversationId: sessionId, tool, args }), out.res, deps);
        return { status: out.status(), json: JSON.parse(out.body()) as Record<string, unknown> };
    }

    it("compress refusal (unresolvable refs) → 200 ok:true + outcome:refused + blocksCreated:0", async () => {
        const r = await call("compress", { content: [{ startId: "m99999", endId: "m99999", summary: "s" }] });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.equal(r.json.outcome, "refused");
        assert.equal(r.json.blocksCreated, 0);
        assert.ok(String(r.json.result).startsWith("[Compression FAILED"), `receipt: ${r.json.result}`);
    });

    it("decompress of unknown block → 200 ok:true + outcome:failure, no blocksCreated", async () => {
        const r = await call("decompress", { blockId: "b999" });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.equal(r.json.outcome, "failure");
        assert.equal(r.json.blocksCreated, undefined);
        assert.match(String(r.json.result), /not found/);
    });

    it("acp_status success → outcome:success", async () => {
        const r = await call("acp_status", {});
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.equal(r.json.outcome, "success");
    });

    it("disabled opt-in tool keeps the #1192 note envelope byte-shape (no outcome field)", async () => {
        const r = await call("acp_rule", { rule: "should not record" });
        assert.equal(r.status, 200);
        assert.deepEqual(Object.keys(r.json).sort(), ["ok", "result"]);
        assert.equal(r.json.ok, true);
        assert.match(String(r.json.result), /acp_rule is not enabled on this bili proxy/);
    });

    it("unknown tool still 400s with ok:false + error", async () => {
        const r = await call("definitely_not_a_tool");
        assert.equal(r.status, 400);
        assert.equal(r.json.ok, false);
        assert.match(String(r.json.error), /unknown tool "definitely_not_a_tool"/);
    });
});

describe("#1875: applyRanges outcome mapping (applied / partial / refused)", () => {
    function makeCtx() {
        const core = createCore();
        const config = defaultConfig(200000) as Config;
        const session = getSession(`t-1875-ar-${Math.random().toString(36).slice(2)}`);
        const msgs: CoreMessage[] = [];
        for (let i = 0; i < 12; i++) {
            msgs.push({
                id: `h_${i}`,
                role: i % 2 === 0 ? "user" : "assistant",
                contentType: "text",
                text: `\x3cacp tokens="2K" type="text"\x3em${String(i + 1).padStart(5, "0")}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(3000)}`,
            });
        }
        const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
        session.state = turn.state;
        return { core, config, messages: turn.messages, session, log: () => {} };
    }

    it("clean fold → applied with blocksCreated:1", () => {
        const ctx = makeCtx();
        const out = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "First two turns covered the initial setup phase in detail." }] }), ctx as never);
        assert.equal(out.outcome, "applied");
        assert.equal(out.blocksCreated, 1);
        assert.match(out.text, /^\[Compressed m00001–m00002 → 1 block\(s\)/);
    });

    it("mixed valid + unresolvable ranges → partial with the surviving block count", () => {
        const ctx = makeCtx();
        const out = applyRanges(parseCompressInput({ content: [
            { startId: "m00001", endId: "m00002", summary: "First two turns covered the initial setup phase in detail." },
            { startId: "m99999", endId: "m99999", summary: "ghost range" },
        ] }), ctx as never);
        assert.equal(out.outcome, "partial");
        assert.equal(out.blocksCreated, 1);
        assert.match(out.text, /Compressed .* → 1 block\(s\)/);
    });

    it("all ranges unresolvable → refused with blocksCreated:0", () => {
        const ctx = makeCtx();
        const out = applyRanges(parseCompressInput({ content: [{ startId: "m99999", endId: "m99999", summary: "ghost" }] }), ctx as never);
        assert.equal(out.outcome, "refused");
        assert.equal(out.blocksCreated, 0);
        assert.ok(out.text.startsWith("[Compression FAILED"), out.text);
    });
});

describe("#1875: MCP shim maps failure/refusal receipts to isError", () => {
    let origin = "";
    let server: http.Server | null = null;
    let canned: Record<string, Record<string, unknown>> = {};

    beforeEach(async () => {
        canned = {};
        server = http.createServer((req, res) => {
            if (req.url !== "/__bili/plugin/tool") { res.writeHead(404).end("nope"); return; }
            let raw = "";
            req.on("data", (d) => { raw += d; });
            req.on("end", () => {
                const parsed = JSON.parse(raw) as { tool?: string };
                const payload = canned[parsed.tool ?? ""] ?? { ok: false, error: "unexpected tool" };
                const status = typeof payload.__status === "number" ? payload.__status : 200;
                res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
            });
        });
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        origin = `http://127.0.0.1:${port}`;
        process.env.BILI_MCP_PROXY = origin;
    });

    afterEach(async () => {
        delete process.env.BILI_MCP_PROXY;
        if (server) await new Promise<void>((r) => server!.close(() => r()));
        server = null;
    });

    it("refused receipt → failed:true (isError), text preserved", async () => {
        canned.compress = { ok: true, result: "[Compression FAILED: range protected]", outcome: "refused", blocksCreated: 0 };
        const out = await forwardTool("compress", {}, 3000, "t-1875-mcp");
        assert.equal(out.failed, true);
        assert.equal(out.text, "[Compression FAILED: range protected]");
    });

    it("failure receipt → failed:true", async () => {
        canned.decompress = { ok: true, result: "[Block b999 not found]", outcome: "failure" };
        const out = await forwardTool("decompress", { blockId: "b999" }, 3000, "t-1875-mcp");
        assert.equal(out.failed, true);
    });

    it("partial receipt → failed:false (work landed)", async () => {
        canned.compress = { ok: true, result: "Compressed … 1 block(s), 1 range dropped.", outcome: "partial", blocksCreated: 1 };
        const out = await forwardTool("compress", {}, 3000, "t-1875-mcp");
        assert.equal(out.failed, false);
    });

    it("success / legacy envelope (no outcome) → failed:false", async () => {
        canned.acp_status = { ok: true, result: "CONTEXT STATUS" };
        const out = await forwardTool("acp_status", {}, 3000, "t-1875-mcp");
        assert.equal(out.failed, false);
        assert.equal(out.text, "CONTEXT STATUS");
    });

    it("hard error envelope still throws", async () => {
        canned.acp_cache = { ok: false, error: "boom" };
        await assert.rejects(() => forwardTool("acp_cache", {}, 3000, "t-1875-mcp"), /boom/);
    });
});
