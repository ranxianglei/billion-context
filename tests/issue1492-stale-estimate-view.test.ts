import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

// #1492: emergency-shrink arming estimates the wire body it just sent. On a
// fallback turn whose outbound IS the client's full raw history (kernel
// transform failed → forwarding unchanged), that estimate describes the RAW
// view (millions of tokens) while every later turn forwards a FOLDED view
// (~tens of thousands). While upstream keeps failing no usage report arrives
// to overwrite the armed value, and three sizing consumers applied it
// cross-turn without checking its provenance (#857's lastInputTokensSource):
//   1. effectiveTokenCount pinned the nudge at >1000% → false emergency
//      bands every turn;
//   2. the preflight trigger's max(lastInputTokens, payloadEstimate) fired
//      compression over a payload whose own post-fold estimate fit the window;
//   3. the preflight loop floored currentTokens on the same stale value, so
//      each run folded viable ranges to exhaustion (minutes of summarization
//      calls) only to log "payload fits with no compressible ranges".
// Fix: an estimate-sourced baseline may floor sizing decisions ONLY while the
// current payload is unmeasured (empty processed messages → the outbound IS
// the raw body); a usage-sourced baseline keeps flooring (upstream billing can
// legitimately exceed every local estimate). These pins (explicit identity,
// Anthropic wire, 120k window so the kernel's absolute-token zones stay out of
// the fixture's way — same rationale as #1119):
//   A. poisoned ESTIMATE baseline + folded payload → no preflight calls, no
//      nudge, history intact, self-heal via the next real usage report.
//   B. poisoned USAGE baseline → preflight STILL fires (real overflow evidence
//      must keep driving compression — the fix must not over-correct).

const WINDOW = 120_000;
const POISON = 1_200_000; // mirrors the reported 1.27M raw-history estimate
const NUDGE_MARKER = "Context limit reached";

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

// ~7.3k chars each of ASCII code text: optimistic estimate ≈ 1.8k tokens per
// heavy, six heavies ≈ 44k chars total — below every nudge percentage band of
// the 120k window (≈37%), yet far above the kernel's preserve-recent zone so
// the oldest heavies ARE compressible mass for the pre-fix paths.
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

/** Mock relay: always 200; serves summarization calls (non-stream) and
 *  streaming turns, records what it received. */
function makeRelay() {
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
                res.end(summaryJson());
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse());
        });
    });
    return { server, received, nonStreamCalls: () => nonStream };
}

async function runCase(sessionId: string, poisonSource: "usage" | "estimate", conversation?: Msg[]) {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay();
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
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
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    try {
        const url = `http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const headers = { "content-type": "application/json", "x-acp-session": sessionId };
        const base = conversation ?? baseConversation();

        // --- Turn 1: establishes the session + kernel state, reports usage ---
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: base }),
        });
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();

        const s = listSessions().find((x) => x.stats.lastInputTokens === 5000);
        assert.ok(s, "turn 1 reported usage (lastInputTokens = 5000)");
        // Poison exactly what armFailureShrink writes after an upstream failure
        // on a turn whose outbound was the unfolded raw history.
        s!.stats.lastInputTokens = POISON;
        s!.stats.lastInputTokensSource = poisonSource;

        // --- Turn 2: same folded history + one small exchange ---
        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: msgs2 }),
        });
        assert.equal(r2.status, 200, "turn 2 succeeds");
        await r2.text();

        const streamed = relay.received
            .map((b) => b.toString("utf8"))
            .filter((t) => {
                try {
                    return (JSON.parse(t) as Record<string, unknown>).stream === true;
                } catch {
                    return false;
                }
            });
        const s2 = listSessions().find((x) => x.id === s!.id);
        return { relay, proxy, streamed, nonStream: relay.nonStreamCalls(), session: s2!, logs };
    } finally {
        setLogCapture(null);
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
}

test("#1492 A: poisoned estimate baseline must not drive nudge/preflight on a folded payload", async () => {
    const { streamed, nonStream, session, logs } = await runCase("issue1492-est-sess", "estimate");
    assert.equal(nonStream, 0, "preflight must stay silent — the payload's own post-fold estimate fits the window (pre-fix: the stale 1.2M baseline fired it and burned summarization rounds)");
    assert.equal(streamed.length, 2, "two streaming forwards (one per turn)");
    assert.ok(!streamed[1].includes(NUDGE_MARKER), `turn 2 must not carry a nudge (pre-fix: 1.2M/120K ≈ 1000% lit the pressure/emergency bands), got tail: ${streamed[1]?.slice(-400)}`);
    for (let i = 0; i < 6; i++) {
        assert.ok(streamed[1].includes(`CODE_${i}_`), `heavy ${i} must survive unfolded (no fold ran)`);
    }
    assert.equal(session.stats.lastInputTokens, 5000, "the recovered turn's real usage report overwrote the poisoned value");
    assert.ok(
        !logs.some((l) => l.includes("preflight target reached") || l.includes("preflight made no progress") || l.includes("preflight")),
        `preflight must not even ENTER on a folded fitting payload with an estimate-grade baseline (trigger gate): ${JSON.stringify(logs.filter((l) => l.toLowerCase().includes("preflight")))}`,
    );
});

test("#1492 B: a usage-sourced high baseline must STILL fire preflight (real overflow evidence)", async () => {
    const { streamed, nonStream, session } = await runCase("issue1492-usage-sess", "usage");
    assert.ok(nonStream >= 1, `a usage-grade baseline above the window must keep driving compression (nonStream=${nonStream})`);
    // No nudge-marker assertion here: the forwarded body is the POST-FOLD
    // rebuild (server.ts re-runs prepare after preflight), whose fresh nudge
    // decision sees nothing left to fold and suppresses — kernel-owned
    // behavior, identical pre/post fix. The asymmetry pinned by this case is
    // the trigger itself: estimate-source stays silent (case A), usage-source
    // still burns summarization calls.
    void streamed;
    assert.equal(session.stats.lastInputTokens, 5000, "self-heal via the next real usage report");
});

// Test C pins the INNER layer (preflight.ts loop floor): a legitimately-entered
// preflight (the payload itself is over-target, so the trigger gate lets it in
// even with an estimate-grade baseline) must size its loop from the PAYLOAD,
// not from the poisoned baseline — gated, it folds only enough to fit; with the
// floor gate reverted it folds every viable range to exhaustion.
test("#1492 C: preflight loop sizes from the payload, not a poisoned estimate floor", async () => {
    const big: Msg[] = [];
    // 58 mediums ≈ 470K chars ≈ ~117K tokens — just over the preflight target
    // (90% of the 120K window ≈ 108K) with ~50 individually-foldable ranges.
    // The gated loop folds only the ~4 needed to fit; a poisoned floor keeps
    // currentTokens at 1.2M forever and walks the ENTIRE offered list.
    for (let i = 0; i < 58; i++) big.push({ role: i % 2 === 0 ? "user" : "assistant", content: `CODE_${i}_` + LINE(i).repeat(88) });
    big.push({ role: "user", content: "final step?" });
    const { nonStream, session } = await runCase("issue1492-loop-sess", "estimate", big);
    const active = session.state.blocks.filter((b) => b.active).length;
    assert.ok(nonStream >= 1, "the over-target payload legitimately enters preflight");
    console.error(`DIAG nonStream=${nonStream} active=${active} blocks=${session.state.blocks.length} msgs-folded-check`);
    assert.ok(active <= 16, `gated loop folds only enough to fit (active=${active}); an ungated poisoned floor would fold every viable range (~27+)`);
});
