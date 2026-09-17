import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, type Session } from "../src/session.ts";

// #604: a relay that answers overflow with a hard 5xx (instead of an in-band
// context-overflow error) never reports usage, so lastInputTokens — the input
// to every usage-driven trigger — stays frozen at the last successful turn's
// value. A client that retries verbatim re-sends the identical payload into
// the identical rejection forever. On upstream 5xx / network failure the proxy
// must arm the emergency shrink with a local estimate of the wire body it just
// sent, so the next retry lands in the kernel's emergency band
// (truncate.threshold = 0.95) and truncates large tool results server-side.
//
// Fixture shape (deterministic — no real model involved): bili's configured
// window is 32k, but the mock relay enforces a HIDDEN 29.5k tolerance (the
// modern deadlock shape: master's preflight intercepts anything whose local
// estimate already exceeds the configured window, so the payload that reaches
// the relay fits bili's view but not the relay's). The conversation's wire
// body sits at ~97% of bili's window — under the preflight trigger, above the
// relay's tolerance, and above the 0.95 emergency band once armed. After the
// armed retry the kernel truncates exactly enough big tool results to drop
// below 0.9 × threshold (~27k), which lands under the relay's tolerance.

const WINDOW = 32_000;
const RELAY_WINDOW = 29_500; // the relay's hidden tolerance (tokens, chars/4)
const BIG = 12_000; // chars per tool_result (well over minOutputTokens 1000)
const STEPS = 9; // big tool steps (outside the protected recent zone)

const RELAY_ERROR_BODY = JSON.stringify({
    error: { type: "new_api_error", message: "upstream error: do request failed" },
});

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function summaryJson(): string {
    return JSON.stringify({
        id: "msg_summary",
        type: "message",
        role: "assistant",
        model: "claude-relay",
        content: [{ type: "text", text: "SUMMARY: multi-step build-check session; all checks passed." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 50 },
    });
}

type Msg = { role: string; content: unknown };

function relayConversation(): Msg[] {
    const msgs: Msg[] = [];
    msgs.push({ role: "user", content: "Start the migration job." });
    msgs.push({ role: "assistant", content: "Starting now." });
    for (let i = 0; i < STEPS; i++) {
        msgs.push({
            role: "assistant",
            content: [
                { type: "text", text: `Step ${i}: running check.` },
                { type: "tool_use", id: `tu_${i}`, name: "bash", input: { command: `check-${i}` } },
            ],
        });
        msgs.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: `MARKER_${i}_` + "L".repeat(BIG) }],
        });
    }
    msgs.push({ role: "user", content: "How far along?" });
    msgs.push({ role: "assistant", content: "Nearly done." });
    msgs.push({ role: "user", content: "Any errors?" });
    msgs.push({ role: "assistant", content: "None so far." });
    msgs.push({ role: "user", content: "Finish when ready." });
    return msgs;
}

interface RelayOpts {
    /** Return this status for the FIRST streaming call, unconditionally. */
    failFirstStreamingWith?: number;
    /** Destroy the socket on the first streaming call (network-level failure). */
    destroyFirst?: boolean;
}

/** Mock relay: enforces its hidden token tolerance on every streaming call
 *  (5xx when over), serves summarization calls, records what it received. */
function makeRelay(opts: RelayOpts) {
    const received: Buffer[] = [];
    let streamingCall = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            received.push(raw);
            let parsed: Record<string, unknown> = {};
            try {
                parsed = JSON.parse(raw.toString("utf8"));
            } catch {
                /* non-JSON — treat as streaming forward */
            }
            if (parsed.stream !== true) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(summaryJson());
                return;
            }
            streamingCall += 1;
            if (opts.destroyFirst && streamingCall === 1) {
                req.socket.destroy();
                return;
            }
            if (opts.failFirstStreamingWith && streamingCall === 1) {
                res.writeHead(opts.failFirstStreamingWith, { "content-type": "application/json" });
                res.end(RELAY_ERROR_BODY);
                return;
            }
            // Hidden tolerance: the relay rejects anything over its real window.
            if (raw.length / 4 > RELAY_WINDOW) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(RELAY_ERROR_BODY);
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse());
        });
    });
    return { server, received };
}

async function startProxy(upstreamPort: number, saves?: string[]): Promise<{ proxy: http.Server; port: number }> {
    const store = new SessionStore({ enabled: false });
    if (saves) {
        const orig = store.scheduleSave.bind(store);
        store.scheduleSave = ((s: Session) => { saves.push(s.id); return orig(s); }) as typeof store.scheduleSave;
    }
    _setStoreForTest(store);
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-relay": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, port: proxy.address().port };
}

test("e2e #604: relay 5xx on near-window payload → arm → next retry truncates + recovers", async () => {
    const relay = makeRelay({ failFirstStreamingWith: 500 });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const saves: string[] = [];
    const { proxy, port } = await startProxy(upstreamPort, saves);

    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: relayConversation() });

        // --- Request 1: fits bili's window (no preflight) but not the relay's
        // hidden tolerance → hard 5xx with no usage report ---
        const r1 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "relay-sess" },
            body,
        });
        assert.equal(r1.status, 500, "relay 5xx passed through to the client");
        const r1text = await r1.text();
        assert.ok(r1text.includes("new_api_error"), "relay error body passes through verbatim");

        const sentLen1 = relay.received[0]?.length ?? 0;

        // The proxy armed the emergency shrink with a local estimate of the
        // wire body it just sent: raise-only lower bound, crossing the kernel's
        // emergency band (0.95 × window).
        const s = listSessions().find((x) => x.stats.lastInputTokens > 0);
        assert.ok(s, "session armed after relay 5xx (lastInputTokens raised)");
        assert.ok(
            s!.stats.lastInputTokens >= Math.ceil(sentLen1 / 8),
            `armed value is a raise-only lower bound of the sent body (${s!.stats.lastInputTokens} >= ${Math.ceil(sentLen1 / 8)}, sent=${sentLen1})`,
        );
        assert.ok(
            s!.stats.lastInputTokens >= 0.95 * WINDOW,
            `armed value crosses the kernel emergency band (${s!.stats.lastInputTokens} >= ${0.95 * WINDOW})`,
        );

        // The error path returns before forward()'s trailing markDirty — the
        // arm must schedule its OWN save or it is lost on restart.
        // (prepare marks dirty once; the arm adds a second save.)
        const armSaves = saves.filter((id) => id === s!.id).length;
        assert.ok(armSaves >= 2, `arm scheduled its own save (scheduleSave x${armSaves} for the session)`);

        // --- Request 2: client retries verbatim → prepare() lands in the
        // emergency band → kernel truncates the big tool results server-side →
        // the shrunken payload fits the relay's hidden tolerance → recovery ---
        const r2 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "relay-sess" },
            body,
        });
        assert.equal(r2.status, 200, "retry recovers");
        await r2.text(); // drain

        const sent2 = relay.received[relay.received.length - 1];
        const sent2Text = sent2.toString("utf8");
        assert.ok(sent2Text.includes("[truncated for context space]"), "emergency truncate shrank the retry payload");
        assert.ok(sent2.length / 4 <= RELAY_WINDOW, `truncated payload fits the relay tolerance (${sent2.length / 4} <= ${RELAY_WINDOW})`);

        // The real usage report from the recovered turn overwrote the armed value.
        const s2 = listSessions().find((x) => x.id === s!.id);
        assert.equal(s2?.stats.lastInputTokens, 5000, "real usage report overwrote the armed value");
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});

test("e2e #604: network-level failure arms the emergency shrink too", async () => {
    const relay = makeRelay({ destroyFirst: true });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const { proxy, port } = await startProxy(upstreamPort);

    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: relayConversation() });
        const idsBefore = new Set(listSessions().map((x) => x.id));

        // --- Request 1: the socket dies with no response at all → bili's own
        // 502 ("acp-proxy failure") — and the same missing-usage problem ---
        const r1 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "net-sess" },
            body,
        });
        assert.equal(r1.status, 502, "network failure surfaces as bili's 502");
        const r1text = await r1.text();
        assert.ok(r1text.includes("upstream request failed"), "502 detail names the upstream failure");

        const s = listSessions().find((x) => !idsBefore.has(x.id));
        assert.ok(s, "a session exists for the failed request");
        assert.ok(
            s!.stats.lastInputTokens >= Math.ceil(body.length / 8),
            `armed after network failure (${s!.stats.lastInputTokens} >= ${Math.ceil(body.length / 8)}, sent=${body.length})`,
        );
        assert.ok(
            s!.stats.lastInputTokens >= 0.95 * WINDOW,
            `armed value crosses the kernel emergency band (${s!.stats.lastInputTokens} >= ${0.95 * WINDOW})`,
        );

        // --- Request 2: relay is back but still enforces its tolerance →
        // recovery requires the truncate, exactly like the 5xx case ---
        const r2 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "net-sess" },
            body,
        });
        assert.equal(r2.status, 200, "retry recovers");
        await r2.text(); // drain
        const sent2 = relay.received[relay.received.length - 1];
        assert.ok(sent2.toString("utf8").includes("[truncated for context space]"), "emergency truncate shrank the retry payload");
        const s2 = listSessions().find((x) => x.id === s!.id);
        assert.equal(s2?.stats.lastInputTokens, 5000, "real usage report overwrote the armed value");
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});

test("e2e #604: 4xx (auth) must NOT arm — no distortion of the usage signal", async () => {
    const relay = makeRelay({ failFirstStreamingWith: 401 });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const { proxy, port } = await startProxy(upstreamPort);

    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: relayConversation() });
        const idsBefore = new Set(listSessions().map((x) => x.id));

        const r1 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "auth-sess" },
            body,
        });
        assert.equal(r1.status, 401, "401 passes through verbatim");
        await r1.text();

        const s = listSessions().find((x) => !idsBefore.has(x.id));
        assert.ok(s, "a session exists for the request");
        assert.equal(s!.stats.lastInputTokens, 0, "4xx must not raise lastInputTokens (no usage signal distortion)");
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});
