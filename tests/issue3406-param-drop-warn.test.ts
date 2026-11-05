import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";
import { __resetIncrementalClientForTests, planIncrementalTurn, type IncrementalWireMessage } from "../src/agent/incremental-client.ts";
import { setLogCapture } from "../src/logger.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-3406-drop-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

// #3406 item 6: the REQUEST_PARAM_KEYS allowlist silently dropped unknown
// top-level request params (vendor-specific knobs, new sampling fields) with
// no log. Both drop layers must warn once per conversation+key, listing the
// key names, while the allowlist enforcement itself stays unchanged.

const userTurn = (n: number) => ({ id: `u${n}`, role: "user", contentType: "text", content: "hello".repeat(400) });

interface Harness {
    turn: (t: { conversationId: string; request?: Record<string, unknown>; messages: unknown[] }) => Promise<{ status: number }>;
    forwarded: Record<string, unknown>[];
    close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const turn = async (t: { conversationId: string; request?: Record<string, unknown>; messages: unknown[] }) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": t.conversationId },
            body: JSON.stringify({ conversationId: t.conversationId, sinceSeq: 0, resync: true, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024, ...(t.request ?? {}) }, messages: t.messages }),
        });
        await response.json().catch(() => null);
        return { status: response.status };
    };
    return { turn, forwarded, close: async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); store.closeQuietly(); await new Promise<void>((resolve) => upstream.close(() => resolve())); } };
}

test("incremental lane: unknown request params are dropped from the upstream body AND warned once per conversation+key (#3406 item 6)", async () => {
    const warnings: string[] = [];
    setLogCapture((level, msg) => {
        if (level === "warn") warnings.push(msg);
    });
    const h = await harness();
    try {
        const first = await h.turn({ conversationId: "conv-drop-1", request: { temperature: 0.7, seed: 42, vendor_extra: "x" }, messages: [userTurn(1)] });
        assert.equal(first.status, 200);

        const upstream1 = h.forwarded.at(-1) as Record<string, unknown>;
        assert.equal(upstream1.temperature, 0.7, "allowlisted param still forwarded");
        assert.ok(!("seed" in upstream1), "unknown param must still be dropped from the upstream body");
        assert.ok(!("vendor_extra" in upstream1), "unknown param must still be dropped from the upstream body");

        const hits = warnings.filter((w) => w.includes("conv-drop-1") && w.includes("dropped"));
        assert.equal(hits.length, 1, `expected exactly one drop warn, got: ${JSON.stringify(warnings)}`);
        assert.match(hits[0]!, /seed/);
        assert.match(hits[0]!, /vendor_extra/);

        // Same conversation, same keys: no second warn (dedup, anti-flood).
        await h.turn({ conversationId: "conv-drop-1", request: { temperature: 0.7, seed: 42, vendor_extra: "x" }, messages: [userTurn(2)] });
        assert.equal(warnings.filter((w) => w.includes("conv-drop-1") && w.includes("dropped")).length, 1, "same conversation+key must not warn twice");

        // A NEW key in the same conversation warns again, listing only the new key.
        await h.turn({ conversationId: "conv-drop-1", request: { frequency_penalty: 0.5 }, messages: [userTurn(3)] });
        const second = warnings.filter((w) => w.includes("conv-drop-1") && w.includes("dropped"));
        assert.equal(second.length, 2, "a new dropped key must warn once more");
        assert.match(second[1]!, /frequency_penalty/);

        // Lane-owned keys (messages/system mirrored from the full body) are
        // by-design and must NOT trip the warn.
        await h.turn({ conversationId: "conv-drop-2", request: { messages: [userTurn(9)], system: "be terse" }, messages: [userTurn(4)] });
        assert.equal(warnings.filter((w) => w.includes("conv-drop-2")).length, 0, "lane-owned keys are not dropped params");
    } finally {
        setLogCapture(null);
        await h.close();
    }
});

test("incremental helper: params dropped client-side are named in one console.error per conversation+key (#3406 item 6)", async () => {
    __resetIncrementalClientForTests();
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(args.map((a) => String(a)).join(" ")); };
    try {
        const messages: IncrementalWireMessage[] = [{ role: "user", content: "hi" }];
        const plan1 = planIncrementalTurn({ conversationId: "conv-helper-1", path: "/v1/messages", messages, system: undefined, request: { model: "m", max_tokens: 10, temperature: 0.3, seed: 7, messages, system: "by-design" } as Record<string, unknown> });
        assert(plan1.mode !== "skip", "fresh conversation must plan a seeded turn");
        const body1 = JSON.parse(plan1.body) as { request: Record<string, unknown> };
        assert.equal(body1.request.temperature, 0.3, "allowlisted param still planned");
        assert.equal(body1.request.seed, undefined, "unknown param must not reach the lane body");
        assert.equal(body1.request.messages, undefined, "lane-owned key must not be mirrored into request");

        const hits = lines.filter((l) => l.includes("conv-helper-1") && l.includes("not sent"));
        assert.equal(hits.length, 1, `expected exactly one helper warn, got: ${JSON.stringify(lines)}`);
        assert.match(hits[0]!, /seed/);
        assert.ok(!/system|messages/.test(hits[0]!.split("not sent:")[1] ?? ""), "lane-owned keys must not be listed as dropped");

        // Same conversation+key: deduped.
        planIncrementalTurn({ conversationId: "conv-helper-1", path: "/v1/messages", messages: [...messages, { role: "assistant", content: "yo" }], system: undefined, request: { model: "m", max_tokens: 10, seed: 7 } as Record<string, unknown> });
        assert.equal(lines.filter((l) => l.includes("conv-helper-1") && l.includes("not sent")).length, 1, "same conversation+key must not warn twice");

        // A different conversation warns for its own keys.
        planIncrementalTurn({ conversationId: "conv-helper-2", path: "/v1/messages", messages, system: undefined, request: { model: "m", max_tokens: 10, top_k: 3, response_format: { type: "json_object" } } as Record<string, unknown> });
        const other = lines.filter((l) => l.includes("conv-helper-2") && l.includes("not sent"));
        assert.equal(other.length, 1);
        assert.match(other[0]!, /response_format/);
    } finally {
        console.error = original;
    }
});
