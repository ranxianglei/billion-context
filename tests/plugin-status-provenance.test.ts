import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, DEFAULT_CCR_CONFIG } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { settleUsageReport } from "../src/cache-ledger.ts";

process.env.NODE_ENV = "test";
const root = mkdtempSync(join(tmpdir(), "bili-status-provenance-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

interface StatusResponse {
    contextTokensSource: "usage" | "estimate" | "unavailable";
    contextTokens: number | null;
    contextTokensAt: number | null;
    contextGeneration: string | null;
    sessionRevision: string | null;
    compressCreditTokens: number;
    inputTokens: number;
    cachedTokens: number;
}

async function harness() {
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    _setForTest({});
    let usage: Record<string, number> | undefined = { input_tokens: 8000, cache_read_input_tokens: 2000, output_tokens: 10 };
    let gate: { entered: () => void; wait: Promise<void> } | undefined;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", async () => {
            const pending = gate;
            gate = undefined;
            if (pending) { pending.entered(); await pending.wait; }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_status", role: "assistant", content: [{ type: "text", text: "answer" }], ...(usage === undefined ? {} : { usage }) }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;
    const messages = [{ role: "user", content: "first original ".repeat(250) }, { role: "assistant", content: "second original ".repeat(250) }, { role: "user", content: "tail original" }];
    const send = async (history: unknown[] = messages) => {
        const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "provenance" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: history }) });
        assert.equal(r.status, 200, await r.text());
    };
    const request = async <T>(path: string, body?: unknown): Promise<T> => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        const response: unknown = await r.json();
        assert(response !== null && typeof response === "object" && !Array.isArray(response));
        return response as T;
    };
    const status = () => request<StatusResponse>("/__bili/plugin/status?conversationId=provenance");
    const tool = (name: string, args: Record<string, unknown>) => request<{ result: string }>("/__bili/plugin/tool", { conversationId: "provenance", tool: name, args });
    const compressArgs = { content: [{ startId: "m00001", endId: "m00002", summary: "The prefix preserves the first user request and second assistant response. Original content remains available for decompression using stable references." }] };
    await send();
    return { status, send, tool, messages, compressArgs, origin, setUsage: (value: typeof usage) => { usage = value; }, holdNext: () => {
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => { entered = resolve; });
        const wait = new Promise<void>((resolve) => { release = resolve; });
        gate = { entered, wait };
        return { waiting, release };
    }, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

test("HTTP usage -> compress -> decompress -> request keeps context provenance separate from billing", async (t) => {
    const h = await harness();
    try {
        const before = await h.status();
        const session = resolveConversation("provenance").session!;
        const baseline = session.stats.lastUsageGradeTokens;
        assert.equal(before.contextTokensSource, "usage");
        assert.equal(before.contextTokens, 10000);
        assert(typeof before.contextTokens === "number" && typeof before.contextTokensAt === "number");
        const compressed = await h.tool("compress", h.compressArgs);
        assert(!compressed.result.includes("FAILED"), compressed.result);
        const folded = await h.status();
        assert.equal(folded.contextTokensSource, "estimate", "manual compression is not a new upstream measurement");
        assert(typeof folded.contextTokens === "number" && typeof folded.contextTokensAt === "number");
        assert(folded.contextTokens < before.contextTokens);
        assert.equal(folded.contextTokens, Math.max(0, before.contextTokens - folded.compressCreditTokens));
        assert(folded.contextTokensAt >= before.contextTokensAt);
        assert.notEqual(folded.contextGeneration, before.contextGeneration);
        assert.equal(session.stats.lastUsageGradeTokens, baseline);
        const inputAfterCompress = session.stats.lastInputTokens;
        const restored = await h.tool("decompress", { blockId: "b1", full: true });
        assert.match(restored.result, /first original/);
        const expanded = await h.status();
        assert.equal(expanded.contextTokensSource, "estimate");
        assert(typeof expanded.contextTokens === "number");
        assert(expanded.contextTokens > folded.contextTokens, "inline restored material changes the effective context");
        assert.notEqual(expanded.contextGeneration, folded.contextGeneration);
        assert.equal(session.stats.lastInputTokens, inputAfterCompress);
        assert.equal(session.stats.lastUsageGradeTokens, baseline);
        assert.deepEqual([expanded.inputTokens, expanded.cachedTokens], [before.inputTokens, before.cachedTokens]);
        h.setUsage({ input_tokens: 6000, cache_read_input_tokens: 1000, output_tokens: 10 });
        const history = [...h.messages,
            { role: "assistant", content: [{ type: "tool_use", id: "restore_status", name: "decompress", input: { blockId: "b1", full: true } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "restore_status", content: restored.result }] },
            { role: "user", content: "Continue after restoring the original material." },
        ];
        await h.send(history);
        const measured = await h.status();
        assert.equal(measured.contextTokensSource, "usage");
        assert.equal(measured.contextTokens, 7000);
        assert.equal(measured.compressCreditTokens, 0);
        assert.deepEqual([measured.inputTokens, measured.cachedTokens], [17000, 3000]);
        assert(![before, folded, expanded].some((s) => s.contextGeneration === measured.contextGeneration));
        assert.equal((await h.status()).contextGeneration, measured.contextGeneration);
        h.setUsage({ input_tokens: 0, output_tokens: 0 });
        await h.send([...history, { role: "assistant", content: "prior reply" }, { role: "user", content: "zero-usage gateway turn" }]);
        const zero = await h.status();
        assert.equal(zero.contextTokensSource, "estimate", "zero usage must not rebrand the previous measured generation");
        assert.notEqual(zero.contextGeneration, measured.contextGeneration);
        assert.deepEqual([zero.inputTokens, zero.cachedTokens], [17000, 3000]);
        assert.equal(session.stats.lastUsageGradeTokens, 7000);
        h.setUsage(undefined);
        await h.send([...history, { role: "assistant", content: "prior reply" }, { role: "user", content: "no-usage gateway turn" }]);
        const missing = await h.status();
        assert.equal(missing.contextTokensSource, "estimate");
        assert.notEqual(missing.contextGeneration, zero.contextGeneration);
        t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries({ before, folded, expanded, measured, zero, missing }).map(([step, s]) => [step, { tokens: s.contextTokens, source: s.contextTokensSource, at: s.contextTokensAt, generation: s.contextGeneration, input: s.inputTokens, cached: s.cachedTokens, credit: s.compressCreditTokens }]))));
    } finally { await h.close(); }
});

test("HTTP pending request cannot expose stale usage as its current context", async () => {
    const h = await harness();
    let request: Promise<void> | undefined;
    const held = h.holdNext();
    try {
        const before = await h.status();
        request = h.send([...h.messages, { role: "assistant", content: "answer" }, { role: "user", content: "another turn" }]);
        await held.waiting;
        const pending = await h.status();
        assert.equal(pending.contextTokensSource, "estimate");
        assert.notEqual(pending.contextGeneration, before.contextGeneration);
        held.release();
        await request;
        const after = await h.status();
        assert.equal(after.contextTokensSource, "usage");
        assert.notEqual(after.contextGeneration, pending.contextGeneration);
    } finally { held.release(); await request; await h.close(); }
});

test("HTTP failed manual tools do not publish a new context observation", async () => {
    const h = await harness();
    try {
        const before = await h.status();
        for (const [name, args] of [["compress", { content: [{ startId: "m99998", endId: "m99999", summary: "missing references" }] }], ["decompress", { blockId: "not-a-block" }]] as const) {
            assert.match((await h.tool(name, args)).result, /FAILED|not found/);
            const after = await h.status();
            assert.deepEqual([after.contextTokens, after.contextTokensSource, after.contextTokensAt, after.contextGeneration], [before.contextTokens, before.contextTokensSource, before.contextTokensAt, before.contextGeneration]);
        }
    } finally { await h.close(); }
});

test("HTTP unknown provenance stays unavailable despite a historical usage baseline", async () => {
    const h = await harness();
    try {
        const session = resolveConversation("provenance").session!;
        delete session.metadata.publicContextObservation;
        assert.equal(session.stats.lastInputTokensSource, "usage");
        assert.equal(session.stats.contextTokensSource, "usage");
        const unknown = await h.status();
        assert.equal(unknown.contextTokensSource, "unavailable");
        assert.equal(unknown.contextTokens, null);
        assert.equal(unknown.contextTokensAt, null);
        assert.equal(unknown.contextGeneration, null);
    } finally { await h.close(); }
});

test("HTTP repeated real usage gets a new generation even within the same timestamp", async (t) => {
    const h = await harness();
    try {
        t.mock.method(Date, "now", () => 1791049000000);
        await h.send();
        const first = await h.status();
        await h.send();
        const second = await h.status();
        assert.equal(second.contextTokensAt, first.contextTokensAt);
        assert.equal(second.contextTokens, first.contextTokens);
        assert.equal(second.sessionRevision, first.sessionRevision);
        assert.notEqual(second.contextGeneration, first.contextGeneration);
        assert.equal((await h.status()).contextGeneration, second.contextGeneration);
    } finally { t.mock.restoreAll(); await h.close(); }
});

test("HTTP a real usage report with outstanding fold credit is still an effective estimate", async () => {
    const h = await harness();
    try {
        const session = resolveConversation("provenance").session!;
        session.stats.compressCreditTokens = 1000;
        settleUsageReport(session, { total: 9000, reportedCached: 500, output: 10 });
        const current = await h.status();
        assert.equal(current.contextTokensSource, "estimate");
        assert.equal(current.contextTokens, 8000, "fold credit is applied exactly once");
        assert.deepEqual([current.inputTokens, current.cachedTokens], [19000, 2500]);
        assert.equal(session.stats.lastInputTokens, 8000);
        assert.equal(session.stats.lastUsageGradeTokens, 8000);
    } finally { await h.close(); }
});

test("HTTP CCR range decompress accounts for queued restored content without changing the usage baseline", async () => {
    const h = await harness();
    try {
        const session = resolveConversation("provenance").session!;
        session.metadata.effectiveCcr = { ...DEFAULT_CCR_CONFIG, enabled: true };
        await h.tool("compress", h.compressArgs);
        const folded = await h.status();
        const baseline = session.stats.lastUsageGradeTokens;
        assert(typeof folded.contextTokens === "number");
        const restored = await h.tool("decompress", { blockId: "b1", startId: "m00001", endId: "m00001" });
        assert.match(restored.result, /restored 1 item/);
        assert.equal(session.pendingRetrievals.length, 1);
        const current = await h.status();
        assert.equal(current.contextTokensSource, "estimate");
        assert(typeof current.contextTokens === "number");
        assert(current.contextTokens > folded.contextTokens);
        assert.notEqual(current.contextGeneration, folded.contextGeneration);
        assert.equal(session.stats.lastUsageGradeTokens, baseline);
        assert.deepEqual([current.inputTokens, current.cachedTokens], [folded.inputTokens, folded.cachedTokens]);
    } finally { await h.close(); }
});
test("HTTP status sessionRevision is cache-stable while unchanged and moves after a mutation (#2017 item E)", async () => {
    const h = await harness();
    try {
        await h.send();
        const first = await h.status();
        assert.ok(first.sessionRevision, "snapshot available in this harness");
        const again = await h.status();
        assert.equal(again.sessionRevision, first.sessionRevision, "unchanged session: repeated polls return the identical revision (epoch-keyed cache)");
        await h.send([...h.messages, { role: "assistant", content: "an intervening answer" }, { role: "user", content: "next original turn" }]);
        const moved = await h.status();
        assert.notEqual(moved.sessionRevision, first.sessionRevision, "a real mutation invalidates the cached revision");
        // The cached value is exactly what expectedRevision accepts under the
        // session lock (sessionRevisionOf is the check's data source).
        const ok = await fetch(`${h.origin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "provenance", tool: "acp_status", args: {}, expectedRevision: moved.sessionRevision }) });
        assert.equal(ok.status, 200);
        const stale = await fetch(`${h.origin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "provenance", tool: "acp_status", args: {}, expectedRevision: first.sessionRevision }) });
        assert.equal(stale.status, 409, "stale cached revision must fail closed");
    } finally { await h.close(); }
});
