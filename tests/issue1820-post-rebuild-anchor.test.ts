import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #1820: right after a big preflight rebuild the usage-grade baseline is
// momentarily absent (the rebuild request's own report hasn't landed yet, or
// the upstream never reports one), so effectiveTokenCount fell through to
// branches sizing on the INCOMING RAW history — the very mass the rebuild just
// folded away. Char-count upper bound inflates ~3.4× on code/JSON payloads, so
// the FIRST post-rebuild turn decided against a phantom meter (repro: 597900
// vs ~178079 real, usage=358%), lit the kernel's uncadenced EMERGENCY branch,
// pinned the growth reference phantom-high, and injected a 7K-char nudge into
// an already-at-window context. #1595's re-anchor only corrected it one more
// round-trip later. Fix: the preflight fit gate already measures the rebuilt
// payload (the view that goes out) — stamp that size as a bounded meter anchor
// (a few prepares) until a real usage-grade sample supersedes it.

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, setPostRebuildAnchor, postRebuildAnchorTokens, tickPostRebuildAnchor, clearPostRebuildAnchor, resetSessionCompression } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

const MODEL = "claude-relay";
const WINDOW = 120_000;
const ANCHOR = 15_000;
const POISON_BASELINE = 60_000;
const NUDGE_MARKER = "Context limit reached";

function okSse(reportUsage: boolean): string {
    const message: Record<string, unknown> = { id: "m1", role: "assistant" };
    if (reportUsage) message.usage = { input_tokens: 5000 };
    const delta: Record<string, unknown> = { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } };
    if (reportUsage) delta.usage = { output_tokens: 3 };
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify(delta)}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

// ~220k chars of dense ASCII code across thirty heavies: char-count upper
// bound ≈ 220k (≈183% of the 120k window — inside the kernel's uncadenced
// EMERGENCY band, where the repro's phantom meter landed), calibrated
// estimate ≈ 1/4 of that (≈55k — below the preflight target, which for the
// Anthropic wire is the FULL window, so preflight stays silent throughout).
const LINE = (i: number) =>
    `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
const HEAVY = (i: number) => `CODE_${i}_` + LINE(i).repeat(62);

type Msg = { role: string; content: unknown };

function baseConversation(): Msg[] {
    const msgs: Msg[] = [];
    for (let i = 0; i < 30; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: HEAVY(i) });
    }
    return msgs;
}

function makeRelay(reportUsage: boolean) {
    const received: Buffer[] = [];
    let nonStream = 0;
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
                nonStream += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    model: MODEL,
                    content: [{ type: "text", text: "SUMMARY: ok." }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(reportUsage));
        });
    });
    return { server, received, nonStreamCalls: () => nonStream };
}

function lastNudgeSized(logs: string[], sessionId: string): number {
    const re = new RegExp(`\\[${sessionId}\\] nudge .*?usage=\\d+% \\((\\d+)/`, "g");
    let m: RegExpExecArray | null;
    let last = -1;
    while ((m = re.exec(logs.join("\n"))) !== null) last = Number(m[1]);
    return last;
}

async function startHarness(sessionId: string, reportUsage: boolean): Promise<{
    url: string; headers: Record<string, string>; base: Msg[];
    proxy: Awaited<ReturnType<typeof startServer>>; relay: ReturnType<typeof makeRelay>;
    logs: string[]; cleanup: () => Promise<void>;
}> {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay(reportUsage);
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        url: `http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        base: baseConversation(),
        proxy, relay, logs,
        cleanup: async () => {
            setLogCapture(null);
            proxy.close();
            await once(proxy, "close");
            relay.server.close();
            await once(relay.server, "close");
        },
    };
}

async function post(url: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<string> {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(r.status, 200, `request succeeds (got ${r.status})`);
    return r.text();
}

test("#1820 A: meter rides the rebuilt-payload anchor until expiry, then legacy sizing resumes", async () => {
    const h = await startHarness("issue1820-anchor-sess", false);
    try {
        // --- Turn 1: establish the session (no usage report lands) ---
        await post(h.url, h.headers, { model: MODEL, max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: h.base });
        const s = listSessions().find((x) => x.id === "issue1820-anchor-sess");
        assert.ok(s, "session exists after turn 1");
        assert.equal(h.relay.nonStreamCalls(), 0, "preflight stays silent (calibrated payload fits the window)");

        // --- Simulate the post-rebuild state: estimate-grade baseline from the
        //     preflight write-back, no usage-grade sample anywhere ---
        s.stats.lastInputTokens = POISON_BASELINE;
        s.stats.lastInputTokensSource = "estimate";
        setPostRebuildAnchor(s, ANCHOR);
        assert.equal(postRebuildAnchorTokens(s), ANCHOR, "anchor readable right after the stamp");

        // --- Turns 2–3: the meter must decide against the anchor, not the
        //     char-count-scale fallback (old code read ~220k here → EMERGENCY) ---
        for (const [turn, extra] of [[2, "continue"], [3, "and continue"]] as const) {
            const streamedBefore = h.relay.received.length;
            await post(h.url, h.headers, { model: MODEL, max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: [...h.base, { role: "user", content: extra }] });
            const forwarded = h.relay.received.slice(streamedBefore);
            assert.equal(forwarded.length, 1, `turn ${turn} forwarded exactly once`);
            assert.ok(!forwarded.some((b) => b.toString("utf8").includes(NUDGE_MARKER)), `turn ${turn}: no phantom nudge injected into the at-window context`);
            assert.equal(lastNudgeSized(h.logs, "issue1820-anchor-sess"), ANCHOR, `turn ${turn}: meter reads the rebuilt-payload anchor`);
        }
        assert.ok(postRebuildAnchorTokens(s) === ANCHOR, "anchor still alive within its prepare budget");

        // --- Turn 4: budget exhausted (the stamp's own re-prepare + two client
        //     requests) — legacy per-turn sizing resumes instead of freezing ---
        await post(h.url, h.headers, { model: MODEL, max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: [...h.base, { role: "user", content: "again" }] });
        assert.equal(s.metadata["postRebuildAnchor"], undefined, "anchor retired after its prepare budget");
        const legacy = lastNudgeSized(h.logs, "issue1820-anchor-sess");
        assert.ok(legacy >= 100_000, `legacy char-scale sizing resumed after expiry (got ${legacy})`);
        assert.equal(h.relay.nonStreamCalls(), 0, "preflight stayed silent for the whole run");
    } finally {
        await h.cleanup();
    }
});

test("#1820 B: a real usage-grade sample supersedes the anchor before its budget runs out", async () => {
    const h = await startHarness("issue1820-settle-sess", true);
    try {
        await post(h.url, h.headers, { model: MODEL, max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: h.base });
        const s = listSessions().find((x) => x.id === "issue1820-settle-sess");
        assert.ok(s, "session exists after turn 1");
        assert.equal(s.stats.lastUsageGradeTokens, 5000, "turn 1's usage report set the calibration anchor");

        setPostRebuildAnchor(s, ANCHOR);
        const streamedBefore = h.relay.received.length;
        await post(h.url, h.headers, { model: MODEL, max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: [...h.base, { role: "user", content: "next" }] });
        assert.equal(h.relay.received.length - streamedBefore, 1, "turn 2 forwarded exactly once");
        assert.equal(lastNudgeSized(h.logs, "issue1820-settle-sess"), 5000, "usage-grade fast path outranks the anchor");
        assert.equal(s.metadata["postRebuildAnchor"], undefined, "settle cleared the anchor although its prepare budget remained");
    } finally {
        await h.cleanup();
    }
});

test("#1820 C: anchor helpers validate corrupt stamps and clear at the compaction boundary", async () => {
    const h = await startHarness("issue1820-unit-sess", false);
    try {
        await post(h.url, h.headers, { model: MODEL, max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: h.base.slice(0, 4) });
        const s = listSessions().find((x) => x.id === "issue1820-unit-sess");
        assert.ok(s, "session exists");

        setPostRebuildAnchor(s, ANCHOR);
        assert.deepEqual(s.metadata["postRebuildAnchor"], { tokens: ANCHOR, remainingPrepares: 3 }, "stamp shape");

        s.metadata["postRebuildAnchor"] = { tokens: Number.NaN, remainingPrepares: 3 };
        assert.equal(postRebuildAnchorTokens(s), 0, "NaN stamp degrades to no-anchor");
        s.metadata["postRebuildAnchor"] = { tokens: "not-a-number" };
        assert.equal(postRebuildAnchorTokens(s), 0, "string stamp degrades to no-anchor");
        s.metadata["postRebuildAnchor"] = "corrupt";
        assert.equal(postRebuildAnchorTokens(s), 0, "scalar stamp degrades to no-anchor");

        setPostRebuildAnchor(s, -5);
        assert.equal(postRebuildAnchorTokens(s), 0, "non-positive tokens rejected");
        tickPostRebuildAnchor(s);
        clearPostRebuildAnchor(s);
        assert.equal(postRebuildAnchorTokens(undefined), 0, "undefined session inert-safe");

        setPostRebuildAnchor(s, ANCHOR);
        assert.equal(postRebuildAnchorTokens(s), ANCHOR, "fresh stamp before compaction");
        resetSessionCompression(s);
        assert.equal(postRebuildAnchorTokens(s), 0, "native-compaction boundary drops the anchor");
    } finally {
        await h.cleanup();
    }
});
