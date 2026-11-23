import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, resetSessionCompression } from "../src/session.ts";
import { epochConfirmPending } from "../src/fold-reconcile.ts";
import { normalizeUpstreamOrigin } from "../src/util.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// One-shot preflight fold gate (2026-11-22 log-32 incident): proxy-driven
// preflight folding gets exactly ONE attempt per session lifecycle. After
// bili has compressed the session (committed fold) or a fold attempt started,
// the trigger forwards as-is — overflow recovery stays with #1195 in-request
// refold and the egress fuse, steady growth is the model's compress tool.
// Gate Test Discipline: every "blocked" case below is paired with the
// POSITIVE case A, which proves the identical payload shape DOES trigger and
// fold on a fresh session — so a blocked result can never be a vacuous
// non-trigger.

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

// ~12k tokens of message text against a 10k window — the SAME shape the #330
// test folds (two large recent messages, soft zone relaxed under overflow).
function overWindowPayload(): Array<{ role: string; content: string }> {
    return [
        { role: "user", content: "start the task" },
        { role: "assistant", content: "A".repeat(24_000) },
        { role: "user", content: "B".repeat(24_000) },
    ];
}

// Distinct-word history of `count` messages, each ~`repeat` copies of a
// per-message marker — the #6069 e2e shape (enough covered ids for the
// fold-reconcile escalation, verbatim tails that stay identifiable).
function wireHistory(tag: string, count: number, repeat: number): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${tag} message ${i}. ` + `${tag}_${i}_content_`.repeat(repeat) });
    }
    return messages;
}

type Call = { stream: boolean; body: string };

function makeUpstreamOk(calls?: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls?.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1_000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ content: [{ type: "text", text: "SUMMARY: the large recent messages were deterministic filler; their raw content is no longer needed." }] }));
            }
        });
    });
}

function seedEvidence(sessionId: string, upstreamPort: number): void {
    const s = getSession(sessionId);
    s.stats.lastInputTokens = 1_000;
    s.stats.lastInputTokensSource = "usage";
    s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(`http://127.0.0.1:${upstreamPort}`);
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

async function post(
    proxyPort: number,
    upstreamPort: number,
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
): Promise<{ status: number; body: string }> {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "claude-small", max_tokens: 1_024, stream: true, messages }),
    });
    const body = await r.text();
    return { status: r.status, body };
}

async function startPair(): Promise<{ proxy: http.Server; upstream: http.Server; proxyPort: number; upstreamPort: number; calls: Call[]; close: () => Promise<void> }> {
    const calls: Call[] = [];
    const upstream = makeUpstreamOk(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxy, upstream, proxyPort, upstreamPort, calls,
        close: async () => {
            proxy.close(); proxy.closeIdleConnections?.();
            upstream.close(); upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

// A (POSITIVE): a fresh session's first over-window payload triggers preflight,
// spends the summary call, folds, forwards the folded payload — and marks the
// session as spent (preflightRuns=1, committed fold).
test("one-shot gate: fresh session's first over-window payload still folds", async () => {
    const env = await startPair();
    try {
        const r = await post(env.proxyPort, env.upstreamPort, "oneshot-fresh", overWindowPayload());
        assert.equal(r.status, 200, r.body.slice(0, 300));
        assert.ok(env.calls.filter((c) => !c.stream).length >= 1, "preflight made the summarization call (the trigger fired)");
        assert.equal(env.calls.filter((c) => c.stream).length, 1, "the folded payload was forwarded upstream");
        const forwarded = env.calls.find((c) => c.stream)?.body ?? "";
        assert.ok(!forwarded.includes("A".repeat(100)), "the folded big message did NOT ride the forwarded payload");
        const s = getSession("oneshot-fresh");
        assert.ok(s.state.blocks.length >= 1, "the fold committed a block");
        assert.ok((s.state.stats?.compressionCount ?? 0) > 0, "the commit spends the session's one-shot fold (compression-managed)");
    } finally {
        await env.close();
    }
});

// B (NEGATIVE): a session bili has already compressed (committed fold — the
// "managed session" the directive targets) must NOT get another proxy-side
// fold: the identical over-window payload is forwarded as-is, zero summary
// calls. The FIRST post in this test doubles as the positive proof that the
// exact shape triggers and folds on a fresh session (same as case A).
test("one-shot gate: compression-managed session (committed fold) → forwarded as-is, no fold", async () => {
    const env = await startPair();
    try {
        // Shot one: the fresh session's first over-window payload folds.
        const r1 = await post(env.proxyPort, env.upstreamPort, "oneshot-managed", overWindowPayload());
        assert.equal(r1.status, 200, r1.body.slice(0, 300));
        assert.ok(env.calls.filter((c) => !c.stream).length >= 1, "shot one: preflight made the summarization call");
        const s = getSession("oneshot-managed");
        assert.ok((s.state.stats?.compressionCount ?? 0) > 0, "shot one committed (test precondition: the session is now compression-managed)");

        // Shot two: the SAME over-window payload again — the gate must block
        // the fold: forwarded as-is, no second summarization call.
        const summaryCallsAfterShot1 = env.calls.filter((c) => !c.stream).length;
        const r2 = await post(env.proxyPort, env.upstreamPort, "oneshot-managed", overWindowPayload());
        assert.equal(r2.status, 200, "the over-window payload is forwarded as-is, not withheld (r.status=" + r2.status + " " + r2.body.slice(0, 300) + ")");
        assert.equal(env.calls.filter((c) => !c.stream).length, summaryCallsAfterShot1, "NO new summarization call: the one-shot gate blocked the second fold");
        assert.equal(env.calls.filter((c) => c.stream).length, 2, "the second request was forwarded upstream (as-is, not withheld or re-folded)");
        const before = s.state.blocks.length;
        assert.equal(getSession("oneshot-managed").state.blocks.length, before, "no new block was committed on the second request");
    } finally {
        await env.close();
    }
});

// B2 (NEGATIVE, the discriminating one for the managed branch): case B's second
// request never reaches the gate — after shot 1's fold the reconciled payload
// FITS the window, so the triggerFires early return fires first. This variant
// regrows the session over-window with NEW large content, so the trigger
// genuinely fires and only the gate blocks the fold: without the gate this
// case re-folds (a new summarization call); with the gate it forwards as-is.
test("one-shot gate: managed session regrows over-window on new content → trigger fires, still no fold", async () => {
    const env = await startPair();
    try {
        // Shot one commits a fold (the session is now compression-managed).
        const r1 = await post(env.proxyPort, env.upstreamPort, "oneshot-managed-grow", overWindowPayload());
        assert.equal(r1.status, 200, r1.body.slice(0, 300));
        const s = getSession("oneshot-managed-grow");
        assert.ok((s.state.stats?.compressionCount ?? 0) > 0, "shot one committed (precondition: the session is compression-managed)");

        // Shot two: the SAME conversation plus NEW large content — the outbound
        // is over-window again, so the trigger fires (not the fits early
        // return). The gate must block the fold.
        const summaryCallsBefore = env.calls.filter((c) => !c.stream).length;
        const r2 = await post(env.proxyPort, env.upstreamPort, "oneshot-managed-grow", [
            { role: "user", content: "start the task" },
            { role: "user", content: "A".repeat(24000) },
            { role: "user", content: "A".repeat(24000) },
            { role: "user", content: "C".repeat(60000) },
        ]);
        assert.equal(r2.status, 200, "the regrown over-window payload is forwarded as-is, not withheld (r.status=" + r2.status + " " + r2.body.slice(0, 300) + ")");
        assert.equal(env.calls.filter((c) => !c.stream).length, summaryCallsBefore, "NO new summarization call: the gate blocked the regrown trigger (this case re-folds without the gate)");
        assert.ok(env.calls.some((c) => c.stream && c.body.includes("C".repeat(100))), "the UNFOLDED new content rode the forward");
        assert.equal(getSession("oneshot-managed-grow").state.blocks.length, s.state.blocks.length, "no new block was committed on the second request");
    } finally {
        await env.close();
    }
});

// C (NEGATIVE): the log-32 livelock shape — an ABORTED first attempt (flag set,
// nothing committed) must not re-start the multi-minute summary on the retry:
// the identical over-window payload is forwarded as-is, zero summary calls.
test("one-shot gate: spent flag (aborted first attempt, no commit) → retry forwarded as-is", async () => {
    const env = await startPair();
    try {
        const r0 = await post(env.proxyPort, env.upstreamPort, "oneshot-aborted", [{ role: "user", content: "hi" }]);
        assert.equal(r0.status, 200, r0.body.slice(0, 300));
        seedEvidence("oneshot-aborted", env.upstreamPort);
        const s = getSession("oneshot-aborted");
        // Simulate the 300s-aborted attempt: the flag was spent when the fold
        // path began, but the summary never returned so no block committed.
        s.stats.preflightRuns = 1;
        assert.equal(s.state.blocks.length, 0, "nothing committed (test precondition)");

        const summaryCallsBefore = env.calls.filter((c) => !c.stream).length;
        const r = await post(env.proxyPort, env.upstreamPort, "oneshot-aborted", overWindowPayload());
        assert.equal(r.status, 200, "the retry is forwarded as-is, not re-folded (r.status=" + r.status + " " + r.body.slice(0, 300) + ")");
        assert.equal(env.calls.filter((c) => !c.stream).length, summaryCallsBefore, "the livelock is killed: no second summarization call");
        assert.ok(env.calls.find((c) => c.stream && c.body.includes("A".repeat(100))) !== undefined, "the UNFOLDED payload rode the forward");
    } finally {
        await env.close();
    }
});

// D (POSITIVE): compression reset re-arms the gate — a rebuilt conversation is
// a fresh lifecycle and gets its own first attempt.
test("one-shot gate: compression reset re-arms the one-shot fold", async () => {
    const env = await startPair();
    try {
        const r0 = await post(env.proxyPort, env.upstreamPort, "oneshot-reset", [{ role: "user", content: "hi" }]);
        assert.equal(r0.status, 200, r0.body.slice(0, 300));
        seedEvidence("oneshot-reset", env.upstreamPort);
        const s = getSession("oneshot-reset");
        s.stats.preflightRuns = 1;
        resetSessionCompression(s);
        assert.equal(s.stats.preflightRuns, undefined, "the reset cleared the one-shot flag");

        const r = await post(env.proxyPort, env.upstreamPort, "oneshot-reset", overWindowPayload());
        assert.equal(r.status, 200, r.body.slice(0, 300));
        assert.ok(env.calls.filter((c) => !c.stream).length >= 1, "after reset the fresh lifecycle folds again");
        assert.ok(getSession("oneshot-reset").state.blocks.length >= 1, "the re-armed attempt committed a block");
    } finally {
        await env.close();
    }
});

// E (POSITIVE, the #6069 epoch exception): a session whose fold substrate was
// wholesale replaced under the same session id gets the NEW epoch's own
// one-shot — the old epoch's committed folds must not starve the new
// history's first over-window turn (the merged gate regressed exactly this:
// tests/issue6069-epoch-pause-over-window.test.ts). The paired negative proof
// is case B2: a managed session whose substrate was NOT replaced stays
// blocked. The final shot proves the exception is scoped to the latch window
// — once the new fold commits and the latch clears, the one-shot holds again.
test("one-shot gate: epoch replacement (latched) → the new epoch's over-window turn folds again", async () => {
    const env = await startPair();
    try {
        // Old epoch: a large history folds (the session is now compression-managed).
        const r1 = await post(env.proxyPort, env.upstreamPort, "oneshot-epoch", wireHistory("OLD", 24, 250));
        assert.equal(r1.status, 200, r1.body.slice(0, 300));
        const s = getSession("oneshot-epoch");
        assert.ok(s.state.blocks.some((b) => b.active), "the old history is folded");
        assert.ok((s.state.stats?.compressionCount ?? 0) > 0, "precondition: the session is compression-managed");

        // Replacement: an unrelated history that fits the window, resent three
        // times — fold-reconcile latches the epoch confirmation.
        const replaced = wireHistory("NEW", 12, 100);
        for (let pass = 0; pass < 3; pass++) {
            const r = await post(env.proxyPort, env.upstreamPort, "oneshot-epoch", replaced);
            assert.equal(r.status, 200, "a fitting history passes through while folding is paused (r.status=" + r.status + " " + r.body.slice(0, 300) + ")");
        }
        assert.equal(epochConfirmPending(s), true, "precondition: the epoch-confirm latch is pending");

        // Grown: the new history grows past the window — the epoch exception
        // must let the new epoch's one-shot fire. Without it, the gate blocks
        // on the old epoch's committed count and the turn goes out unfolded.
        const summaryCallsBefore = env.calls.filter((c) => !c.stream).length;
        const grown = [...replaced, ...wireHistory("GROWN", 16, 250)];
        const r2 = await post(env.proxyPort, env.upstreamPort, "oneshot-epoch", grown);
        assert.equal(r2.status, 200, "the over-window turn is folded and forwarded, not withheld (r.status=" + r2.status + " " + r2.body.slice(0, 300) + ")");
        assert.ok(env.calls.filter((c) => !c.stream).length > summaryCallsBefore, "the new epoch's one-shot fired: a new summarization call");
        const forwarded = env.calls.filter((c) => c.stream).at(-1);
        assert.ok(forwarded, "a forward happened");
        assert.ok(forwarded.body.includes("SUMMARY: the large recent messages"), "the new summary is in the forwarded payload");
        assert.ok(forwarded.body.includes("GROWN_15_content_"), "the newest turn stays verbatim");
        assert.equal(epochConfirmPending(s), false, "the fresh fold starts the new epoch: the latch clears");

        // The new epoch's one-shot is still ONE shot: the next over-window
        // turn on the now-managed session is forwarded as-is.
        const summaryCallsAfterNewEpoch = env.calls.filter((c) => !c.stream).length;
        const r3 = await post(env.proxyPort, env.upstreamPort, "oneshot-epoch", [...grown, { role: "user", content: "Z".repeat(24_000) }]);
        assert.equal(r3.status, 200, "the regrown payload is forwarded as-is, not withheld (r.status=" + r3.status + " " + r3.body.slice(0, 300) + ")");
        assert.equal(env.calls.filter((c) => !c.stream).length, summaryCallsAfterNewEpoch, "the new epoch's one-shot is spent: no further proxy-side fold");
    } finally {
        await env.close();
    }
});
