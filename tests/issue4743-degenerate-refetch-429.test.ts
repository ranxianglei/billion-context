import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { makeContinuationRefetch } from "../src/degenerate-retry.ts";
import { noteUpstreamThrottle429, noteUpstreamThrottleResolved, upstreamThrottleLocalReject } from "../src/upstream-throttle.ts";

// #4743 (PR #4725 round-3 residue, cherry-picked from #4752 ab6a7f10): the
// degenerate-turn continuation refetch is an egress send like any other, but
// it was invisible to the 429 governor — a 429-storming upstream never armed
// the hold from retry traffic, and an already-armed hold still burned an
// upstream slot on the retry. The refetch now (a) answers locally under an
// armed hold (passing the empty turn through — holding the CLIENT's open
// stream is not an option), and (b) feeds noteUpstreamThrottle429 /
// noteUpstreamThrottleResolved like every other egress send.
//
// Both assertions are RED on master (no gate call, no notes): the hold case
// records a real server hit on master, and the 429 case leaves the governor
// un-armed.

const CHAT_BODY = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });

function opts(url: string, label: string) {
    return {
        protocol: "openai" as const,
        body: CHAT_BODY,
        upstreamUrl: url,
        reqHeaders: {},
        signal: new AbortController().signal,
        log: () => {},
        label,
    };
}

async function recordedServer(status: number, body: string): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
    let hitCount = 0;
    const server = http.createServer((_req, res) => {
        hitCount++;
        res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
        res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no addr");
    return {
        url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
        hits: () => hitCount,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

test("#4743 A: an armed 429 hold answers the continuation refetch locally — the empty turn passes through and the upstream records ZERO hits", async () => {
    const srv = await recordedServer(200, "event: message_start\ndata: {}\n\n");
    try {
        // arm the governor for this exact upstream (same streak shape as the
        // loop-lane contract test: two consecutive verdicts)
        noteUpstreamThrottle429(srv.url, {}, null);
        noteUpstreamThrottle429(srv.url, {}, null);
        assert.ok(upstreamThrottleLocalReject(srv.url, {}), "precondition: hold armed");

        const refetch = makeContinuationRefetch(opts(srv.url, "gate-4743"));
        const out = await refetch();
        assert.equal(out, null, "the refetch must be answered locally (null = empty turn passes through)");
        assert.equal(srv.hits(), 0, "the armed hold must NOT burn an upstream slot on the retry");
    } finally {
        await srv.close();
        noteUpstreamThrottleResolved(srv.url, {}, 200);
    }
});

test("#4743 B: the refetch's own 429 verdict arms the governor; a resolved retry lifts the hold", async () => {
    const rejected = await recordedServer(429, JSON.stringify({ error: { message: "rate limited" } }));
    const ok = await recordedServer(200, "event: message_start\ndata: {}\n\n");
    try {
        assert.equal(upstreamThrottleLocalReject(rejected.url, {}), undefined, "precondition: no hold yet");

        const first = await makeContinuationRefetch(opts(rejected.url, "storm-4743"))();
        assert.equal(first, null, "a rejected retry passes the empty turn through");

        const armed = upstreamThrottleLocalReject(rejected.url, {});
        assert.ok(armed, "the refetch's 429 verdict must reach the governor (arm for the next main-lane send)");

        const second = await makeContinuationRefetch(opts(ok.url, "lift-4743"))();
        assert.ok(second, "an ok retry still yields its stream");
        // the ok settle resolved the (different-host) governor key of its own
        // upstream; verify the observe pair by checking the rejected host's
        // hold is still armed until an explicit resolved verdict lifts it
        assert.ok(upstreamThrottleLocalReject(rejected.url, {}), "hold on the storming host persists until a resolved verdict");
        noteUpstreamThrottleResolved(rejected.url, {}, 200);
        assert.equal(upstreamThrottleLocalReject(rejected.url, {}), undefined, "resolved verdict lifts the hold");
    } finally {
        await rejected.close();
        await ok.close();
    }
});
