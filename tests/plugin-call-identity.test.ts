import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test, { after } from "node:test";
import type { ResponseInputItem } from "acp-kernel/wire";
import type { ProxyOptions } from "../src/config.ts";
import { rmrf } from "./tmp-rm.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-call-identity-"));
for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(home, key);
process.env.BILI_CONFIG_FILE = path.join(home, "config.json");
process.env.BILI_SESSIONS_DIR = path.join(home, "sessions");
after(() => rmrf(home));
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { listSessions, _resetSessionsForTest } = await import("../src/session.ts");

async function harness() {
    const inputs: ResponseInputItem[][] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: ResponseInputItem[] };
            if (Array.isArray(body.input)) inputs.push(body.input);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_identity", output: [], usage: { input_tokens: 1000, output_tokens: 1 } } })}\n\n`);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    const config = defaultConfig(200_000);
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: origin,
        routes: { [origin]: { models: { "gpt-identity": { context: 200_000 } } } },
        modelContextLimit: 200_000, kernelConfig: config,
        compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest", streamErrorShape: "protocol",
        passthroughSource: null, advisoryCheck: false, releaseNotesCheck: false,
        compat: { roles: {} }, mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const cid = "identity-plugin";
    const history: ResponseInputItem[] = Array.from({ length: 20 }, (_, i) => ({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `identity seed ${i} ${"x".repeat(2000)}` }));
    const post = async () => {
        const r = await fetch(`${base}/bili/${origin}/v1/responses`, {
            method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": cid },
            body: JSON.stringify({ model: "gpt-identity", stream: true, instructions: "Stable identity fixture.", input: history }),
        });
        assert.equal(r.status, 200, await r.text());
        return inputs.at(-1)!;
    };
    const tool = async (body: Record<string, unknown>) => {
        const r = await fetch(`${base}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: cid, nativeCaller: true, tool: "compress", ...body }) });
        return { status: r.status, data: await r.json() as { ok?: boolean; result?: string } };
    };
    return { inputs, history, post, tool, session: () => listSessions()[0]!, close: async () => {
        await new Promise<void>((resolve, reject) => proxy.close(e => e ? reject(e) : resolve()));
        await new Promise<void>((resolve, reject) => upstream.close(e => e ? reject(e) : resolve()));
    } };
}

function appendPair(history: ResponseInputItem[], id: string, args: unknown, result: string) {
    history.push({ type: "function_call", name: "compress", call_id: id, arguments: JSON.stringify(args) });
    history.push({ type: "function_call_output", call_id: id, output: result });
}

const args = { content: [{ startId: "m00002", endId: "m00007", topic: "identity", summary: "The earlier fixture messages establish the completed setup. Preserve the retained tail and use the original block when full detail is needed." }] };

test("native plugin compress stores the host call identity, not an unrelated synthetic identity", async () => {
    const h = await harness();
    try {
        await h.post();
        const out = await h.tool({ toolCallId: "call_host_success", args });
        assert.equal(out.status, 200);
        assert.ok(h.session().state.blocks.some(b => b.active), out.data.result);
        assert.equal(h.session().state.blocks.at(-1)?.compressCallId, "call_host_success");
    } finally { await h.close(); }
});

test("two later failures must not evict an active successful plugin carrier or move the cached prefix", async () => {
    const h = await harness();
    try {
        await h.post();
        const out = await h.tool({ toolCallId: "call_host_success", args });
        assert.ok(h.session().state.blocks.some(b => b.active), out.data.result);
        appendPair(h.history, "call_host_success", args, out.data.result!);
        const before = await h.post();
        for (let i = 0; i < 2; i++) appendPair(h.history, `call_failed_${i}`, { content: [] }, "[Compression FAILED: external summary unavailable.]");
        const afterInput = await h.post();
        assert.ok(afterInput.some(item => item.type === "function_call" && item.call_id === "call_host_success"), "still-active success must not be an orphan");
        assert.deepEqual(afterInput.slice(0, before.length), before, "ordinary failed calls must append, not resurrect an early summary anchor or delete the old carrier");
        assert.equal(h.session().state.blocks.filter(b => b.active).length, 1);
    } finally { await h.close(); }
});

test("legacy synthetic blocks bind only to a unique resent carrier before orphan pruning", async () => {
    const h = await harness();
    try {
        await h.post();
        const out = await h.tool({ args });
        const block = h.session().state.blocks.at(-1)!;
        assert.match(block.compressCallId!, /^plugin_/);
        appendPair(h.history, "call_legacy_success", args, out.data.result!);
        const before = await h.post();
        assert.equal(h.session().state.blocks.at(-1)?.compressCallId, "call_legacy_success");
        for (let i = 0; i < 2; i++) appendPair(h.history, `call_failed_${i}`, { content: [] }, "[Compression FAILED: external summary unavailable.]");
        const afterInput = await h.post();
        assert.deepEqual(afterInput.slice(0, before.length), before);
    } finally { await h.close(); }
});

test("ambiguous historical calls must not be guessed as a legacy block's owner", async () => {
    const h = await harness();
    try {
        await h.post();
        const out = await h.tool({ args });
        const oldId = h.session().state.blocks.at(-1)!.compressCallId;
        appendPair(h.history, "call_candidate_1", args, out.data.result!);
        appendPair(h.history, "call_candidate_2", args, "[Compression FAILED: retry.]");
        await h.post();
        assert.equal(h.session().state.blocks.at(-1)?.compressCallId, oldId);
    } finally { await h.close(); }
});

test("matching ranges with a failed or foreign block receipt cannot establish legacy ownership", async () => {
    const h = await harness();
    try {
        await h.post();
        await h.tool({ args });
        const oldId = h.session().state.blocks.at(-1)!.compressCallId;
        appendPair(h.history, "call_foreign_receipt", args, "[Compressed m00002..m00007]\n · b999 full summary 100ch");
        await h.post();
        assert.equal(h.session().state.blocks.at(-1)?.compressCallId, oldId);
    } finally { await h.close(); }
});

test("missing host call identity keeps legacy compatibility; malformed identity rejects before mutation", async () => {
    const h = await harness();
    try {
        await h.post();
        for (const toolCallId of [null, 23, "", " ", "x".repeat(513)]) {
            const out = await h.tool({ toolCallId, args });
            assert.equal(out.status, 400, `invalid id ${String(toolCallId).slice(0, 15)}`);
            assert.equal(h.session().state.blocks.length, 0);
        }
        const out = await h.tool({ args });
        assert.equal(out.status, 200);
        assert.match(h.session().state.blocks.at(-1)?.compressCallId ?? "", /^plugin_/);
    } finally { await h.close(); }
});
