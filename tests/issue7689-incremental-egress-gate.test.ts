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
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-incr-egress-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

interface Harness {
    proxyUrl: string;
    turn: (t: { conversationId: string; sinceSeq: number; messages: unknown[]; resync?: boolean }) => Promise<{ status: number; headers: Headers; body: unknown }>;
    probe: (conversationId?: string) => Promise<{ status: number; body: unknown }>;
    dir: string;
    close: () => Promise<void>;
}

async function harness(opts: { egressPlane?: boolean } = {}): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = opts.egressPlane === false ? "0" : "1";
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
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
    const turn = async (t: { conversationId: string; sinceSeq: number; messages: unknown[]; resync?: boolean }) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": t.conversationId },
            body: JSON.stringify({ conversationId: t.conversationId, sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: t.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, headers: response.headers, body };
    };
    const probe = async (conversationId?: string) => {
        const url = conversationId !== undefined ? `${proxyUrl}/__bili/plugin/turn?conversation=${conversationId}` : `${proxyUrl}/__bili/plugin/turn`;
        const response = await fetch(url, { method: "GET", headers: { "x-bili-plugin": "dsh" } });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
    };
    return { proxyUrl, turn, probe, dir, close: async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); store.closeQuietly(); await new Promise<void>((resolve) => upstream.close(() => resolve())); } };
}

const userTurn = (n: number, text = "hello") => ({ id: `u${n}`, role: "user", contentType: "text", content: text.repeat(400) });

test("issue7689 M1: egress-on session — turn returns 503, probe reports disabled", async () => {
    const h = await harness();
    try {
        // Seed the session (egress plane is on, but the session is not yet egress-on).
        const seed = await h.turn({ conversationId: "conv-egress-1", sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200, "seed turn succeeds before egress-on is latched");

        // Now latch egress-on on the session.
        const session = peekSession("conv-egress-1");
        assert(session, "session must exist after seed");
        session.metadata = { ...(session.metadata ?? {}), egressAuthority: true };

        // Turn must now return 503 (egress-on gate).
        const frozen = await h.turn({ conversationId: "conv-egress-1", sinceSeq: 1, messages: [userTurn(2)] });
        assert.equal(frozen.status, 503, "egress-on turn must return 503");
        const frozenBody = frozen.body as { error?: string };
        assert(frozenBody.error?.includes("egress-on"), "error message must mention egress-on");

        // Probe for this conversation must report enabled: false.
        const probe = await h.probe("conv-egress-1");
        assert.equal(probe.status, 200);
        const probeBody = probe.body as { ok: boolean; enabled: boolean };
        assert.equal(probeBody.ok, true);
        assert.equal(probeBody.enabled, false, "egress-on conversation probe must report enabled: false");

        // Global probe (no conversationId) still reports enabled: true (global rollout state).
        const globalProbe = await h.probe();
        assert.equal(globalProbe.status, 200);
        const globalBody = globalProbe.body as { ok: boolean; enabled: boolean };
        assert.equal(globalBody.ok, true);
        assert.equal(globalBody.enabled, true, "global probe must still report enabled: true");
    } finally {
        await h.close();
    }
});

test("issue7689 M1: egress plane off from the start — turn succeeds, probe reports enabled", async () => {
    const h = await harness({ egressPlane: false });
    try {
        // Seed the session (egress plane is off, so the session is NOT egress-on).
        const seed = await h.turn({ conversationId: "conv-egress-2", sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200, "seed turn succeeds");

        // Delta turn must succeed (session is not egress-on).
        const delta = await h.turn({ conversationId: "conv-egress-2", sinceSeq: 1, messages: [userTurn(2)] });
        assert.equal(delta.status, 200, "non-egress-on delta turn must succeed");

        // Probe for this conversation must report enabled: true.
        const probe = await h.probe("conv-egress-2");
        assert.equal(probe.status, 200);
        const probeBody = probe.body as { ok: boolean; enabled: boolean };
        assert.equal(probeBody.ok, true);
        assert.equal(probeBody.enabled, true, "non-egress-on conversation probe must report enabled: true");
    } finally {
        await h.close();
    }
});

test("issue7689 M1: egress plane off — egress-on session still works (gate is inert)", async () => {
    const h = await harness();
    try {
        // Seed the session.
        const seed = await h.turn({ conversationId: "conv-egress-3", sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200, "seed turn succeeds");

        // Latch egress-on on the session.
        const session = peekSession("conv-egress-3");
        assert(session, "session must exist after seed");
        session.metadata = { ...(session.metadata ?? {}), egressAuthority: true };

        // Now turn off the egress plane.
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
        try {
            // Turn must succeed (egress plane is off, so the gate is inert).
            const delta = await h.turn({ conversationId: "conv-egress-3", sinceSeq: 1, messages: [userTurn(2)] });
            assert.equal(delta.status, 200, "egress-on session with egress plane off must succeed");

            // Probe for this conversation must report enabled: true (gate is inert).
            const probe = await h.probe("conv-egress-3");
            assert.equal(probe.status, 200);
            const probeBody = probe.body as { ok: boolean; enabled: boolean };
            assert.equal(probeBody.ok, true);
            assert.equal(probeBody.enabled, true, "egress-on session with egress plane off must report enabled: true");
        } finally {
            process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
        }
    } finally {
        await h.close();
    }
});
