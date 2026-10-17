// #3633 ask ③: strict session routing — an opt-in guard for multi-instance
// deployments. When enabled, a request whose final session key equals the RAW
// client-provided value and for which THIS instance holds no local record is
// rejected with 409 IF the resent history shows prior turns; genuinely fresh
// conversations always pass. Default off — single-instance behavior is
// byte-identical to before.
//
// Coverage split: the decision core (historyHasPriorTurns) and the knob tier
// resolution are unit-tested below; the wiring (real 409 through startServer,
// memory-record and disk-record passthrough, per-protocol error shapes) is the
// single-harness integration test. Namespaced-id exclusion (|sub: splits,
// codex turn ids) is structural — the gate compares the FINAL key against the
// raw client value, so any decoration bypasses it by construction; that
// comparison is asserted in the unit matrix, not over HTTP.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { dropSessionForGc, _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";
import { historyHasPriorTurns } from "../src/server/handle.ts";
import { strictSessionRouting } from "../src/knobs.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-3633-srr-"));
test.after(() => {
    delete process.env.BILI_STRICT_SESSION_ROUTING;
    delete process.env.BILI_CONFIG_FILE;
    rmSync(testRoot, { recursive: true, force: true });
});

const CONTINUATION = [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
];
const FRESH = [{ role: "user", content: "hello" }];

test("historyHasPriorTurns: wire-shape matrix", () => {
    // Fresh-start shapes never count as prior turns.
    assert.equal(historyHasPriorTurns(FRESH), false);
    assert.equal(historyHasPriorTurns([{ role: "system", content: "x" }, ...FRESH]), false);
    assert.equal(historyHasPriorTurns([]), false);
    // Model/tool roles (openai/anthropic messages[]).
    assert.equal(historyHasPriorTurns([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]), true);
    assert.equal(historyHasPriorTurns([{ role: "tool", tool_call_id: "t1", content: "out" }]), true);
    assert.equal(historyHasPriorTurns([{ role: "developer", content: "d" }]), true);
    // google contents[] uses role "model".
    assert.equal(historyHasPriorTurns([{ role: "user", parts: [] }, { role: "model", parts: [] }]), true);
    // responses input[] typed items.
    assert.equal(historyHasPriorTurns([{ type: "message", role: "user" }, { type: "function_call", name: "f" }]), true);
    assert.equal(historyHasPriorTurns([{ type: "message", role: "user" }, { type: "function_call_output", output: "o" }]), true);
    assert.equal(historyHasPriorTurns([{ type: "message", role: "user" }, { type: "reason", summary: [] }]), true);
    // Unknown/garbage items are skipped, never fatal.
    assert.equal(historyHasPriorTurns(["plain string", null, 42, undefined, { nope: 1 }]), false);
});

test("strictSessionRouting knob: env > file > default(false)", () => {
    const cfg = join(testRoot, "knob-config.json");
    const prevEnv = process.env.BILI_CONFIG_FILE;
    try {
        delete process.env.BILI_STRICT_SESSION_ROUTING;
        process.env.BILI_CONFIG_FILE = cfg;
        writeFileSync(cfg, "{}");
        assert.equal(strictSessionRouting(), false, "default off with empty config");
        writeFileSync(cfg, JSON.stringify({ strictSessionRouting: true }));
        assert.equal(strictSessionRouting(), true, "file tier enables");
        writeFileSync(cfg, JSON.stringify({ strictSessionRouting: false }));
        assert.equal(strictSessionRouting(), false, "file tier explicit false");
        process.env.BILI_STRICT_SESSION_ROUTING = "1";
        assert.equal(strictSessionRouting(), true, "env beats file-false");
        process.env.BILI_STRICT_SESSION_ROUTING = "true";
        assert.equal(strictSessionRouting(), true, "'true' enables");
        writeFileSync(cfg, JSON.stringify({ strictSessionRouting: true }));
        process.env.BILI_STRICT_SESSION_ROUTING = "0";
        assert.equal(strictSessionRouting(), false, "'0' disables even over file-true");
        process.env.BILI_STRICT_SESSION_ROUTING = "garbage";
        assert.equal(strictSessionRouting(), false, "only 1/true enable");
    } finally {
        delete process.env.BILI_STRICT_SESSION_ROUTING;
        if (prevEnv === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevEnv;
    }
});

interface Harness {
    proxyUrl: string;
    forwarded: Record<string, unknown>[];
    store: SessionStore;
    close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_PERSIST_ZSTD = "0";
    delete process.env.BILI_STRICT_SESSION_ROUTING;
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
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    return { proxyUrl, forwarded, store, close: async () => {
        proxy.closeAllConnections?.();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        store.closeQuietly();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    } };
}

async function post(proxyUrl: string, path: string, sessionId: string, messages: unknown[], extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> {
    const res = await fetch(`${proxyUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId, ...extraHeaders },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }),
    });
    const text = await res.text();
    let body: Record<string, any> = {};
    try { body = JSON.parse(text); } catch { /* non-JSON: keep empty */ }
    return { status: res.status, body };
}

test("strict routing end-to-end: off baseline, 409 reject, fresh/memory/disk passthrough, error shapes", { timeout: 60_000 }, async (t) => {
    if (process.platform === "win32") {
        t.skip("win32: unified-storage harness instances crash node on Windows CI (silent exit 1) — decision core covered by the unit matrix above");
        return;
    }
    const h = await harness();
    try {
        // 1. Default OFF: unknown id + prior-turn history passes through (today's behavior).
        const off = await post(h.proxyUrl, "/v1/messages", "srr-off-unknown", CONTINUATION, { "anthropic-version": "2023-06-01" });
        assert.equal(off.status, 200, `flag off must not reject (got ${off.status}: ${JSON.stringify(off.body)})`);
        assert.equal(h.forwarded.length, 1, "flag-off request reaches upstream");

        process.env.BILI_STRICT_SESSION_ROUTING = "1";

        // 2. Unknown id + prior turns → 409, anthropic-wrapped shape.
        const rej = await post(h.proxyUrl, "/v1/messages", "srr-reject-1", CONTINUATION, { "anthropic-version": "2023-06-01" });
        assert.equal(rej.status, 409, `expected 409, got ${rej.status}: ${JSON.stringify(rej.body)}`);
        assert.equal(rej.body.type, "error");
        assert.equal(rej.body.error?.type, "request_conflict");
        assert.match(String(rej.body.error?.message), /\[strictSessionRouting\]/);
        assert.match(String(rej.body.error?.message), /srr-reject-1/);
        assert.match(String(rej.body.error?.message), /instance/);
        assert.equal(h.forwarded.length, 1, "rejected request must NOT reach upstream");

        // 3. Same shape on the openai lane → flat shape with stable code.
        const rejOai = await post(h.proxyUrl, "/v1/chat/completions", "srr-reject-oai", CONTINUATION);
        assert.equal(rejOai.status, 409);
        assert.equal(rejOai.body.ok, false);
        assert.equal(rejOai.body.code, "STRICT_SESSION_ROUTING_REJECTED");
        assert.match(String(rejOai.body.error), /srr-reject-oai/);

        // 4. Genuinely FRESH conversation (no prior turns) passes despite unknown id.
        const fresh = await post(h.proxyUrl, "/v1/messages", "srr-fresh-1", FRESH, { "anthropic-version": "2023-06-01" });
        assert.equal(fresh.status, 200, `fresh conversation must pass (got ${fresh.status}: ${JSON.stringify(fresh.body)})`);
        assert.equal(h.forwarded.length, 2);

        // 5. Continuation of a MEMORY-resident session passes.
        const contMem = await post(h.proxyUrl, "/v1/messages", "srr-fresh-1", CONTINUATION, { "anthropic-version": "2023-06-01" });
        assert.equal(contMem.status, 200, `memory-known session must pass (got ${contMem.status}: ${JSON.stringify(contMem.body)})`);
        assert.ok(peekSession("srr-fresh-1"), "session is resident");
        assert.equal(h.forwarded.length, 3);

        // 6. Continuation of a DISK-only session passes (cold start, warmMax=0 shape):
        //    flush the record, evict it from memory, then the probe must find it
        //    via the store instead of rejecting.
        const resident = peekSession("srr-fresh-1");
        assert.ok(resident, "session still resident before flush");
        h.store.writeNow(resident);
        assert.equal(dropSessionForGc("srr-fresh-1"), true, "evict from the memory map");
        assert.equal(peekSession("srr-fresh-1"), undefined, "memory map really cleared");
        const contDisk = await post(h.proxyUrl, "/v1/messages", "srr-fresh-1", CONTINUATION, { "anthropic-version": "2023-06-01" });
        assert.equal(contDisk.status, 200, `disk-known session must pass (got ${contDisk.status}: ${JSON.stringify(contDisk.body)})`);
        assert.equal(h.forwarded.length, 4);
    } finally {
        delete process.env.BILI_STRICT_SESSION_ROUTING;
        await h.close();
    }
});
