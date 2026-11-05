import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #3450 follow-up: "the upstream counts the completion share inside the
// context wall" is a PROVIDER fact, not turn evidence. #3450 learns the share
// but books it on the one-shot overflow arm, which retires on the next usage
// report (#1110) — deliberately, for "this session cannot exceed N". The
// provider fact, however, stays true after the turn recovered: dropping it
// re-judges every later turn on the declared window, which on an anthropic-WIRE
// endpoint that bills completion inside the wall (DeepSeek /anthropic: 1048576
// stated, "requested 1370540 (1114540 in the messages, 256000 in the
// completion)") means the session over-fills again, 400s again, and pays
// another multi-range emergency fold each time — the live 5m28s incident.
//
// Contract pinned here:
//   1. recovery still retires the ARM and its reserve (#1110 unchanged);
//   2. the proven share survives on its own lifetime, scoped to origin+model;
//   3. the very next turn judges input against (declared window − proven share)
//      even though the wire protocol is anthropic (shouldReserveOutputHeadroom
//      says false) — so the 400 cannot recur;
//   4. a DIFFERENT origin can never claim the proof (its own declaration rules).

const SMALL_WINDOW_OVERFLOW_BODY = JSON.stringify({
    error: {
        code: "context_length_exceeded",
        message: "This model's maximum context length is 30000 tokens. However, you requested 35000 tokens (28000 in the messages, 7000 in the completion). Please reduce the length of the inputs or output.",
    },
});

// 12000 of a 40000 wall is 30% — above the 25% #896 cap on GUESSED output
// budgets. A measured share must not be clipped by that cap.
const COMPLETION_HEAVY_OVERFLOW_BODY = JSON.stringify({
    error: {
        code: "context_length_exceeded",
        message: "This model's maximum context length is 40000 tokens. However, you requested 42000 tokens (30000 in the messages, 12000 in the completion). Please reduce the length of the inputs or output.",
    },
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

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. Key decisions: folded the oldest ranges because the payload had to fit the proven message budget. Files touched: src/a.ts:10. Outcome: fixed and verified by tests.";

function summaryJson(): string {
    return JSON.stringify({
        id: "msg_summary",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: SUMMARY_TEXT }],
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 50 },
    });
}

function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

type Upstream = { server: http.Server; port: number; streamingCalls: number; summaryCalls: number };

async function makeUpstream(overflowFirst: boolean, overflowBody: string = SMALL_WINDOW_OVERFLOW_BODY): Promise<Upstream> {
    const state = { server: undefined as unknown as http.Server, port: 0, streamingCalls: 0, summaryCalls: 0 };
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = {};
            }
            if (parsed.stream === false) {
                state.summaryCalls += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(summaryJson());
                return;
            }
            if (overflowFirst && state.streamingCalls === 0) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(overflowBody);
            } else {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            }
            state.streamingCalls += 1;
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    state.server = server;
    state.port = (server.address() as { port: number }).port;
    return state as Upstream;
}

function baseOptions(ports: number[], window: number): ProxyOptions {
    const routes: NonNullable<ProxyOptions["routes"]> = {};
    for (const port of ports) {
        routes[`http://127.0.0.1:${port}`] = { models: { "claude-test": { context: window } } };
    }
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes,
        modelContextLimit: window,
        kernelConfig: defaultConfig(window),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

test("e2e #3450 follow-up: a proven completion wall outlives the arm — the next turn judges on window − completion and a foreign origin cannot claim it", async () => {
    const proving = await makeUpstream(true);
    const foreign = await makeUpstream(false);
    const proxy = await startServer(baseOptions([proving.port, foreign.port], 40_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const url = (port: number) => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${port}/v1/messages`;
    // The wire is anthropic (shouldReserveOutputHeadroom === false) — the whole
    // point of the proof is that this exemption must give way to measured truth.
    const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
    const headers = { "content-type": "application/json", "x-acp-session": "t3450-proof-sess" };

    try {
        // 1. First request: upstream rejects with the stated counts; the
        // in-request refold recovers it (T2's contract, unchanged).
        const r1 = await fetch(url(proving.port), { method: "POST", headers, body });
        assert.equal(r1.status, 200, "the stated completion share still rescues the turn in-request");
        await r1.text();
        assert.ok(proving.summaryCalls >= 1, "preflight folded against window − completion");
        const foldsAfterFirst = proving.summaryCalls;
        const s1 = listSessions().find((x) => x.id === "t3450-proof-sess");
        assert.ok(s1, "session exists");
        // 2. The arm retired with its reserve (#1110 lifecycle untouched) ...
        assert.equal(s1!.stats.overflowArmTokens, undefined, "the one-shot arm retires on the usage report");
        assert.equal(s1!.stats.overflowArmCompletionReserve, undefined, "the arm's own reservation retires with it (#3450)");
        // ... but the PROVIDER fact it proved survives, scoped to this route.
        assert.equal(s1!.stats.provenCompletionWall, 7_000, "the completion share is remembered past the arm");
        assert.equal(s1!.stats.provenCompletionWallOrigin, `http://127.0.0.1:${proving.port}`);
        assert.equal(s1!.stats.provenCompletionWallModel, "claude-test");

        // 3. Second request on an anthropic wire: the exemption must yield to
        // the proof, or this turn re-earns the 400 (the live incident loop).
        const r2 = await fetch(url(proving.port), { method: "POST", headers, body });
        assert.equal(r2.status, 200, "the follow-up turn must not walk into the same wall again");
        await r2.text();
        const s2 = listSessions().find((x) => x.id === "t3450-proof-sess");
        assert.ok(s2, "same session");
        // #4205 split the display window (effectiveContextLimit, the declared
        // wall) from the judged one (reservedContextLimit); the proof acts on
        // the latter — the number nudge/preflight actually judge input against.
        assert.equal(s2!.metadata.effectiveContextLimit, 40_000, "the declared wall stays visible as declared");
        assert.equal(s2!.metadata.reservedContextLimit, 33_000, "judged on 40000 − 7000 proven completion, not the raw declared window");
        assert.equal(proving.summaryCalls, foldsAfterFirst, "the second turn folds nothing: the proven denominator already fits");

        // 4. A different upstream has its own declaration — the proof never
        // travels with the session id to a route that never stated it.
        const foreignHeaders = { "content-type": "application/json", "x-acp-session": "t3450-proof-foreign" };
        const r3 = await fetch(url(foreign.port), { method: "POST", headers: foreignHeaders, body });
        assert.equal(r3.status, 200);
        await r3.text();
        const s3 = listSessions().find((x) => x.id === "t3450-proof-foreign");
        assert.ok(s3, "foreign session exists");
        assert.equal(s3!.stats.provenCompletionWall, undefined, "a new session starts with no proof");
        assert.equal(s3!.metadata.reservedContextLimit, 40_000, "anthropic wire on an unproven origin keeps the plain protocol rule");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        for (const up of [proving, foreign]) {
            up.server.close();
            up.server.closeIdleConnections?.();
            await once(up.server, "close");
        }
    }
});

test("e2e #3450 follow-up: a proven share above the #896 cap is reserved in full", async () => {
    const proving = await makeUpstream(true, COMPLETION_HEAVY_OVERFLOW_BODY);
    const proxy = await startServer(baseOptions([proving.port], 40_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${proving.port}/v1/messages`;
    const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
    const headers = { "content-type": "application/json", "x-acp-session": "t3450-proof-cap" };

    try {
        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 200, "the stated completion share still rescues the turn in-request");
        await r1.text();
        const s1 = listSessions().find((x) => x.id === "t3450-proof-cap");
        assert.equal(s1!.stats.provenCompletionWall, 12_000, "the stated completion share is booked in full");

        const r2 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r2.status, 200, "the follow-up turn must not walk into the same wall again");
        await r2.text();
        const s2 = listSessions().find((x) => x.id === "t3450-proof-cap");
        // 12000 is 30% of the 40000 window: the 25% cap would leave 30000,
        // which the upstream's own arithmetic says still overflows.
        assert.equal(s2!.metadata.reservedContextLimit, 28_000, "measured proof outranks the guess-only #896 cap");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        proving.server.close();
        proving.server.closeIdleConnections?.();
        await once(proving.server, "close");
    }
});
