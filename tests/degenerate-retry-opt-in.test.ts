import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

process.env.NODE_ENV = "test";

// Hermetic state dir per repo convention: without it this suite's writes land
// in the machine-global state and cross-contaminate parallel suites.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-degenerate-retry-opt-in-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
type ProxyOptions = import("../src/config.ts").ProxyOptions;
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetSessionsForTest } = await import("../src/session.ts");
const { DEGENERATE_RETRY_NUDGE } = await import("../src/degenerate-retry.ts");

/** A degenerate anthropic turn: a thinking block and a clean end_turn terminal,
 *  zero answer text — the #732/#821 silent-stop shape. */
const degenerateTurn = (): string[] => [
    `event: message_start\n` +
    `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_deg", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null } })}\n\n`,
    `event: content_block_start\n` +
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
    `event: content_block_delta\n` +
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "weighing the request silently" } })}\n\n`,
    `event: content_block_stop\n` +
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\n` +
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } })}\n\n`,
    `event: message_stop\n` +
    `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
];

/** A healthy anthropic turn with one text block. */
const goodTurn = (): string[] => [
    `event: message_start\n` +
    `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_good", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null } })}\n\n`,
    `event: content_block_start\n` +
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\n` +
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The actual answer arrives now." } })}\n\n`,
    `event: content_block_stop\n` +
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\n` +
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } })}\n\n`,
    `event: message_stop\n` +
    `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
];

interface MockUpstream {
    port: number;
    /** Every POST body received, in order — the retry must show up here. */
    bodies: string[];
    close(): Promise<void>;
}

/** Anthropic-wire mock: the FIRST request degenerates (thinking-only clean
 *  stop); every later request answers with text. */
async function startMockUpstream(): Promise<MockUpstream> {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            if (req.method !== "POST") {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "mock upstream: unsupported" } }));
                return;
            }
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end((bodies.length === 1 ? degenerateTurn() : goodTurn()).join(""));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        port: (server.address() as { port: number }).port,
        bodies,
        close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
}

interface Harness {
    proxyPort: number;
    upstream: MockUpstream;
    close(): Promise<void>;
}

async function startHarness(degenerateRetry: boolean): Promise<Harness> {
    const upstream = await startMockUpstream();
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const routes: ProxyOptions["routes"] = {};
    routes[`http://127.0.0.1:${upstream.port}`] = { models: { "claude-test": { context: 100_000 } } };
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes,
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        degenerateRetry,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    });
    await once(proxy, "listening");
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstream,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            await upstream.close();
        },
    };
}

const anthropicBody = (): Record<string, unknown> => ({
    model: "claude-test",
    stream: true,
    max_tokens: 256,
    messages: [{ role: "user", content: "What is the answer?" }],
});

async function streamOnce(h: Harness): Promise<string> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstream.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "s-degen-optin", "x-api-key": "test", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(anthropicBody()),
    });
    if (resp.status !== 200) throw new Error(`proxy returned ${resp.status}: ${await resp.text()}`);
    assert.match(resp.headers.get("content-type") ?? "", /text\/event-stream/);
    const chunks: Buffer[] = [];
    for await (const c of (resp.body ?? {} as AsyncIterable<Uint8Array>)) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}

test("degenerateRetry default OFF: a zero-output turn passes through with NO re-issue", async () => {
    const h = await startHarness(false);
    try {
        const out = await streamOnce(h);
        // Exactly one upstream request: the degenerate retry must NOT fire.
        assert.equal(h.upstream.bodies.length, 1, `expected no re-issue, got ${h.upstream.bodies.length} upstream requests`);
        // The client receives the empty-but-completed turn verbatim: a
        // thinking block, a clean message_stop, zero answer text, and no
        // in-band #870 error (that error belongs to a FAILED retry).
        assert.match(out, /message_stop/);
        assert.doesNotMatch(out, /text_delta/);
        assert.doesNotMatch(out, /degenerated again/);
        // No nudge ever hit the wire.
        assert.ok(!h.upstream.bodies[0]!.includes(DEGENERATE_RETRY_NUDGE), "the nudge must not be injected when the retry is off");
    } finally {
        await h.close();
    }
});

test("degenerateRetry: true — the same turn re-issues once with the neutral nudge and stitches the answer", async () => {
    const h = await startHarness(true);
    try {
        const out = await streamOnce(h);
        // The degenerate first attempt + exactly one re-issue.
        assert.equal(h.upstream.bodies.length, 2, `expected one re-issue, got ${h.upstream.bodies.length} upstream requests`);
        // The re-issued body carries the continuation nudge appended to the
        // last user turn (appendTrailingUserText merge), and it is the NEUTRAL
        // wording — no "final answer" push.
        const retryBody = h.upstream.bodies[1]!;
        assert.ok(retryBody.includes(DEGENERATE_RETRY_NUDGE), "retry body must carry DEGENERATE_RETRY_NUDGE");
        assert.ok(!retryBody.includes("state your final answer"), "nudge wording must stay neutral");
        // The client sees the retry's answer text stitched in, and no error
        // frame. (The loop lane forwards the first attempt's thinking framing
        // before the retry, so a second message_start pair is expected here.)
        assert.match(out, /The actual answer arrives now\./);
        assert.doesNotMatch(out, /degenerated again/);
    } finally {
        await h.close();
    }
});
