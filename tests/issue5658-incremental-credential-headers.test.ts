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

// #5658: the delta lane rebuilt the outbound request with a positive header
// allowlist (authorization / anthropic-version / anthropic-beta), so any
// credential outside it — x-api-key above all — was silently dropped and the
// upstream answered 401 ("governor"), which DSH maps to an account sign-out.
// The fix forwards the client's own end-to-end headers (minus hop-by-hop and
// x-bili-* markers); these tests pin that credentials reach the upstream and
// lane markers do not.
process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-incr-cred-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

interface UpstreamHit {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
}

async function harness(): Promise<{
    proxyUrl: string;
    turn: (extraHeaders: Record<string, string>) => Promise<number>;
    markerTurn: (extraHeaders: Record<string, string>) => Promise<number>;
    hits: UpstreamHit[];
    close: () => Promise<void>;
}> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    const savedRollout = process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    // The marker-divert entry gates on the pluginIncrementalTurns rollout feature.
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const hits: UpstreamHit[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            hits.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
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
    const path = "/v1/messages";
    const seedBody = { conversationId: "conv-cred", sinceSeq: 0, path, request: { model: "claude-test", max_tokens: 1024 }, messages: [{ role: "user", content: "hello" }] };
    // Direct /__bili/plugin/turn entry: the client carries its credentials on the
    // turn POST exactly as it would on a full-resend request.
    const turn = async (extraHeaders: Record<string, string>): Promise<number> => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-cred", ...extraHeaders },
            body: JSON.stringify(seedBody),
        });
        return response.status;
    };
    // Marker-divert entry: shaped turn posted on the ORDINARY model path with the
    // x-bili-plugin-turn marker — the marker must NOT reach the upstream.
    const markerTurn = async (extraHeaders: Record<string, string>): Promise<number> => {
        const response = await fetch(`${proxyUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-cred-marker", "x-acp-session": "conv-cred-marker", "x-bili-plugin-turn": "1", ...extraHeaders },
            body: JSON.stringify({ conversationId: "conv-cred-marker", sinceSeq: 0, request: { model: "claude-test", max_tokens: 1024 }, messages: [{ role: "user", content: "hello" }] }),
        });
        return response.status;
    };
    const close = async (): Promise<void> => {
        if (savedRollout === undefined) delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        else process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = savedRollout;
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        store.closeQuietly();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    };
    return { proxyUrl, turn, markerTurn, hits, close };
}

const CREDENTIALS: [string, string][] = [
    ["authorization", "Bearer TEST-AUTH"],
    ["x-api-key", "sk-TEST-XAPIKEY"],
    ["x-goog-api-key", "goog-TEST"],
    ["api-key", "vendor-TEST"],
];

function hitHasCredential(h: UpstreamHit, name: string, value: string): boolean {
    const v = h.headers[name.toLowerCase()];
    return v === value || (Array.isArray(v) && v.includes(value));
}

test("#5658 direct turn: every credential header reaches the upstream, no x-bili marker leaks", async () => {
    const h = await harness();
    try {
        const status = await h.turn({ ...Object.fromEntries(CREDENTIALS), "x-custom-gateway": "gw-TEST", "x-bili-turn-id": "turn-direct-TEST" });
        assert.equal(status, 200);
        assert.equal(h.hits.length, 1);
        const hit = h.hits[0];
        for (const [name, value] of CREDENTIALS) {
            assert.ok(hitHasCredential(hit, name, value), `credential header ${name} must reach the upstream`);
        }
        // Full-resend parity (#5658): the lane forwards the client's OWN end-to-end
        // headers verbatim (buildForwardHeaders downstream), never an allowlist — an
        // arbitrary non-credential client header must ride through as well.
        assert.ok(hitHasCredential(hit, "x-custom-gateway", "gw-TEST"), "an arbitrary client end-to-end header must reach the upstream");
        assert.equal(hit.headers["x-bili-turn-id"] ?? null, null, "lane turn-id bookkeeping must not be forwarded verbatim");
    } finally {
        await h.close();
    }
});

test("#5658 marker divert: credentials reach the upstream, x-bili-plugin-turn marker is stripped", async () => {
    const h = await harness();
    try {
        const status = await h.markerTurn({ ...Object.fromEntries(CREDENTIALS), "x-bili-turn-id": "turn-divert-TEST" });
        assert.equal(status, 200);
        assert.equal(h.hits.length, 1);
        const hit = h.hits[0];
        for (const [name, value] of CREDENTIALS) {
            assert.ok(hitHasCredential(hit, name, value), `credential header ${name} must reach the upstream`);
        }
        assert.equal(hit.headers["x-bili-plugin-turn"] ?? null, null, "the divert marker must never ride onto the upstream request");
        assert.equal(hit.headers["x-bili-turn-id"] ?? null, null, "lane turn-id bookkeeping must not be forwarded verbatim");
    } finally {
        await h.close();
    }
});
