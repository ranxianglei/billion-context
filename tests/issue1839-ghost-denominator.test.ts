import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #1839: any turn that ends WITHOUT a usage report (client abort, upstream 5xx)
// used to write a local estimate into stats.lastInputTokens (source "estimate"),
// and the next turn's effectiveTokenCount() re-derived a char-count upper bound
// from the FULL INBOUND history as the nudge denominator — inflating it 12–65×
// vs real usage until a genuine usage report landed (reported logs: 719521 armed
// → 2939167 ghost vs real input 143419; false EMERGENCY bands at >1000%,
// unnecessary irreversible folds that invalidated ~129K-token cache prefixes,
// self-contradictory preflight fail-fast 502s, impossible [acp-compress-obs]
// ratios). Pinned here:
//   1. a failed turn without a usage report arms the baseline ONLY as an
//      estimate-grade value (#604's emergency-band rescue stays intact) — and
//      while a real-usage anchor exists, that arm can no longer reach any sizing
//      decision: the next turn still sizes on the MEASURED input (pre-fix the
//      same arm led to the 719521→2939167 ghost vs real input 143419) — e2e via
//      a real upstream 503.
//   2. once a REAL usage report has anchored lastUsageGradeTokens, an
//      estimate-grade turn sizes on that anchor — not on any re-derived view of
//      the inbound history.
//   3. overflow arming (armOverflowShrink) carries source "overflow-arm" — a
//      rescue-grade value the effectiveTokenCount fast path still accepts, but
//      never conflated with billing-grade "usage".

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, type Session } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

const WINDOW = 120_000;
const NUDGE_MARKER = "Context limit reached";

function okSse(reportUsage: boolean): string {
    const message: Record<string, unknown> = { id: "m1", role: "assistant" };
    if (reportUsage) message.usage = { input_tokens: 5000 };
    const start: Record<string, unknown> = { type: "message_start", message };
    const delta: Record<string, unknown> = { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } };
    if (reportUsage) delta.usage = { output_tokens: 3 };
    return (
        `event: message_start\ndata: ${JSON.stringify(start)}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify(delta)}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

// Dense ASCII code fixture (same shape as the #1569/#1492 suites): the
// calibrated estimate of this view lands far below both the char-count upper
// bound and the 120k window, so NONE of these turns may trigger preflight —
// any summary call means the sizing regressed.
const LINE = (i: number) =>
    `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
const HEAVY = (i: number) => `CODE_${i}_` + LINE(i).repeat(62);

type Msg = { role: string; content: unknown };

function baseConversation(): Msg[] {
    const msgs: Msg[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: i < 6 ? HEAVY(i) : `note_${i}_short tail ${i}` });
    }
    return msgs;
}

type VerdictRule = { when?: string; status?: number; body?: string };

/** Content-routed relay: a streaming main request gets the verdict of the FIRST
 *  rule whose `when` substring appears in its LAST message's content, else 200
 *  SSE with usage. Routing by the last message (not the whole body) matters:
 *  every turn resends the FULL history, so a marker embedded in an earlier turn
 *  would otherwise keep matching every later turn. A same-turn rescue resend
 *  (#1195/#3787) carries either the identical last message or the injected
 *  compress-instruction tail — tests add explicit rules for both shapes.
 *  Kernel summary calls (non-stream) always get a summary. */
function makeRelay(rules: VerdictRule[] = []) {
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
                    model: "claude-relay",
                    content: [{ type: "text", text: "SUMMARY: ok." }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
                return;
            }
            const msgsArr = Array.isArray(parsed.messages) ? (parsed.messages as Array<Record<string, unknown>>) : [];
            const lastMsg = msgsArr[msgsArr.length - 1];
            const tail = typeof lastMsg?.content === "string" ? lastMsg.content : JSON.stringify(lastMsg?.content ?? "");
            const rule = rules.find((r) => r.when !== undefined && tail.includes(r.when));
            if (!rule) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(true));
                return;
            }
            res.writeHead(rule.status ?? 500, { "content-type": "application/json" });
            res.end(rule.body ?? "");
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

function streamedBodies(received: Buffer[]): string[] {
    return received.map((b) => b.toString("utf8")).filter((t) => {
        try {
            return (JSON.parse(t) as Record<string, unknown>).stream === true;
        } catch {
            return false;
        }
    });
}

async function startHarness(sessionId: string, script: VerdictRule[]) {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay(script);
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = (relay.server.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
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
        log: true,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const headers = { "content-type": "application/json", "x-acp-session": sessionId };
    const post = (messages: Msg[]) => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages }),
    });
    const session = (): Session => {
        const s = listSessions().find((x) => x.id === sessionId);
        assert.ok(s, "session exists");
        return s!;
    };
    const close = async () => {
        await new Promise<void>((r) => proxy.close(() => r()));
        await new Promise<void>((r) => relay.server.close(() => r()));
    };
    return { logs, relay, post, session, close };
}

test("#1839 G1: a failed turn arms only an estimate-grade value; the measured anchor still sizes the next turn (e2e)", async () => {
    const id = "sess-1839-g1";
    const h = await startHarness(id, [
        { when: "step two?", status: 503, body: '{"error":"upstream unavailable"}' },
    ]);
    try {
        const base = baseConversation();
        const r1 = await h.post(base);
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();
        let s = h.session();
        assert.equal(s.stats.lastInputTokens, 5000, "usage-grade baseline after turn 1");
        assert.equal(s.stats.lastInputTokensSource, "usage");

        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await h.post(msgs2);
        assert.equal(r2.status, 503, "upstream 503 passes through");
        await r2.text();
        s = h.session();
        // #604's arm IS still written — it is load-bearing for the emergency-band
        // rescue on anchor-less sessions — but it carries ESTIMATE grade, and
        // that grade must no longer reach a sizing decision while a usage-grade
        // anchor exists (pre-#1839 this exact write led to the ghost: the next
        // turn re-derived a char-count upper bound from the full inbound history
        // and pinned the nudge to it until a real usage report landed).
        assert.ok(s.stats.lastInputTokens > 5000, `failure arm raised the baseline to an outbound estimate (${s.stats.lastInputTokens})`);
        assert.equal(s.stats.lastInputTokensSource, "estimate", "the arm is tagged estimate-grade");
        assert.ok(h.logs.some((l) => l.includes("armed emergency shrink with local estimate")), "armFailureShrink warn present");

        const msgs3: Msg[] = [...msgs2, { role: "assistant", content: "working." }, { role: "user", content: "step three?" }];
        const r3 = await h.post(msgs3);
        assert.equal(r3.status, 200, "turn 3 succeeds");
        await r3.text();
        s = h.session();
        const sized = lastNudgeSized(h.logs, id);
        assert.ok(sized >= 0, "nudge diagnostic present");
        assert.equal(sized, 5000, "nudge denominator stays the measured value — no ghost inflation");
        assert.equal(h.relay.nonStreamCalls(), 0, "no preflight summary calls");
        const streamed = streamedBodies(h.relay.received);
        assert.ok(!streamed[1].includes(NUDGE_MARKER), "no spurious nudge injection on the healthy turn");
        assert.equal(s.stats.contextTokensSource, "usage", "display grade follows the baseline provenance");
    } finally {
        await h.close();
    }
});

test("#1839 G2: with a real-usage anchor, an estimate-grade turn sizes on the anchor (read path)", async () => {
    const id = "sess-1839-g2";
    const h = await startHarness(id, []); // every turn: 200 stream, usage reported
    try {
        const base = baseConversation();
        const r1 = await h.post(base);
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();
        const s = h.session();
        assert.equal(s.stats.lastUsageGradeTokens, 5000, "anchor established by the real usage report");

        // Simulate the remaining estimate-grade writer (preflight fold write-back):
        // baseline estimate-grade while a billing-grade anchor exists.
        s.stats.lastInputTokens = 60_000;
        s.stats.lastInputTokensSource = "estimate";

        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await h.post(msgs2);
        assert.equal(r2.status, 200, "turn 2 succeeds");
        await r2.text();
        const sized = lastNudgeSized(h.logs, id);
        assert.ok(sized >= 0, "nudge diagnostic present");
        // Pre-fix this returned the calibrated estimate of the FULL INBOUND
        // history (~11k here) instead of the anchor — the same branch that
        // produced the 2.9M ghost in the reported log.
        assert.equal(sized, 5000, "anchored sizing must use the last usage report exactly, not any re-derived view");
        assert.equal(h.relay.nonStreamCalls(), 0, "no preflight summary calls");
        const streamed = streamedBodies(h.relay.received);
        assert.ok(!streamed[1].includes(NUDGE_MARKER), "no spurious nudge injection");
        assert.equal(s.stats.contextTokensSource, "usage", "display grade = anchor grade, not estimate");
    } finally {
        await h.close();
    }
});

test("#1839 G3: overflow arming is tagged 'overflow-arm', never billing-grade 'usage'", async () => {
    const id = "sess-1839-g3";
    const h = await startHarness(id, [
        { when: "step two?", status: 400, body: '{"error":{"message":"prompt is too long"}}' }, // turn 2: overflow, no window number
        // #3787: a numberless overflow now triggers an in-request rescue — the
        // refold re-send carries the injected compress instructions (marker
        // silence clause tail) as its last message instead of the identical
        // view the #1195 resend used to carry. Both shapes must hit the same
        // verdict so the rejection passes through and the arm keeps its
        // 'overflow-arm' provenance (this test's actual subject).
        { when: "when the tool returns, continue the task directly", status: 400, body: '{"error":{"message":"prompt is too long"}}' },
    ]);
    try {
        const base = baseConversation();
        const r1 = await h.post(base);
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();

        assert.equal(h.relay.nonStreamCalls(), 0, "turn 1 sizing stays estimate-clean — no preflight summary calls");
        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await h.post(msgs2);
        assert.equal(r2.status, 400, "overflow rejection passes through");
        await r2.text();
        const s = h.session();
        assert.equal(s.stats.lastInputTokensSource, "overflow-arm", "armed value must carry its own provenance, not 'usage'");
        assert.ok(s.stats.overflowArmTokens! > 0, "side-request guard armed (#1110)");
        assert.ok(s.stats.lastInputTokens > 0 && s.stats.lastInputTokens <= WINDOW, "arm bounded by the declared window");
        const armVal = s.stats.lastInputTokens;
        assert.ok(h.logs.some((l) => l.includes("armed emergency shrink at ~")), "arm warning logged");

        const msgs3: Msg[] = [...msgs2, { role: "assistant", content: "working." }, { role: "user", content: "step three?" }];
        const r3 = await h.post(msgs3);
        assert.equal(r3.status, 200, "turn 3 succeeds");
        await r3.text();
        const sized = lastNudgeSized(h.logs, id);
        assert.equal(sized, armVal, "fast path still accepts the armed value — rescue chain intact");
        // #3787: the numberless-overflow rescue folds in-request under arm*0.9
        // before re-sending, so summary calls from turn 2 are the rescue doing
        // its job — the fixture's zero-summary discipline still holds for
        // every normally-sized turn (asserted after turn 1 above).
    } finally {
        await h.close();
    }
});
