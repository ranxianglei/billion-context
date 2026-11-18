import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { epochConfirmPending } from "../src/fold-reconcile.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { preflightCompress } from "../src/preflight.ts";
import * as registry from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import { getSession, listSessions, type Session } from "../src/session.ts";

// #6069: the #3641 epoch-confirm latch pauses preflight folding and passes the
// request through verbatim. That is only possible while the verbatim payload
// fits the model window. Once it does not, the paused preflight reported
// "0 compressible range(s)" and the request was refused with
// `preflight_compress_failed` (retryable=false) on every turn. The latch
// clears only after a turn is forwarded, so the session could never recover.
//
// Contract pinned here: the pause holds while the payload fits; an over-window
// payload folds as usual.

const SUMMARY = "summary text long enough to pass the apply gate at fifty chars.";
const WINDOW = 20_000;

async function summaryUpstream(): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
    let calls = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            calls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY } }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        calls: () => calls,
        close: async () => {
            server.close();
            server.closeIdleConnections?.();
            await once(server, "close");
        },
    };
}

function latchedSession(name: string): Session {
    _setStoreForTest(new SessionStore({ enabled: false }));
    registry._resetForTest();
    const session = getSession(`issue6069-${name}-${Math.random().toString(36).slice(2)}`);
    session.metadata.foldEpochConfirmPending = true;
    assert.equal(epochConfirmPending(session), true, "precondition: the epoch-confirm latch is pending");
    return session;
}

/** `turns` large turns between a first and a last user message; each large
 *  turn is ~5K tokens of distinct words. */
function conversation(turns: number): CoreMessage[] {
    const messages: CoreMessage[] = [{ id: "first", role: "user", contentType: "text", text: "Keep the task goal." }];
    for (let i = 0; i < turns; i++) {
        messages.push({ id: `turn${i}`, role: i % 2 === 0 ? "assistant" : "user", contentType: "text", text: `TURN${i}_WORD `.repeat(2000) });
    }
    messages.push({ id: "last", role: "user", contentType: "text", text: "Continue the task." });
    return messages;
}

test("#6069: epoch-confirm pending and the verbatim payload fits the window: folding stays paused", async () => {
    const upstream = await summaryUpstream();
    const session = latchedSession("fits");
    try {
        const result = await preflightCompress(
            {
                core: createCore(), session, config: defaultConfig(WINDOW, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
                prompts: defaultPrompts, protocol: "openai", url: upstream.url, headers: {}, model: "test-model",
                log: () => { /* quiet */ },
            },
            conversation(2),
        );
        assert.equal(upstream.calls(), 0, "paused: no summarization call");
        assert.equal(result.compressedRanges, 0, "paused: no range folded");
        assert.equal(result.fitsWindow, true, "the verbatim payload is forwardable");
        assert.equal(epochConfirmPending(session), true, "the latch is left for fold-reconcile to clear");
    } finally {
        await upstream.close();
    }
});

test("#6069: epoch-confirm pending and the verbatim payload exceeds the window: preflight folds instead of refusing", async () => {
    const upstream = await summaryUpstream();
    const session = latchedSession("over");
    const logs: string[] = [];
    try {
        const result = await preflightCompress(
            {
                core: createCore(), session, config: defaultConfig(WINDOW, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
                prompts: defaultPrompts, protocol: "openai", url: upstream.url, headers: {}, model: "test-model",
                log: (level, msg) => logs.push(`${level}: ${msg}`),
            },
            conversation(8),
        );
        assert.ok(upstream.calls() >= 1, `an over-window payload is folded (summarization calls: ${upstream.calls()})`);
        assert.ok(result.compressedRanges >= 1, `at least one range folded (got ${result.compressedRanges})`);
        assert.equal(result.fitsWindow, true, "the folded payload fits the window and is forwardable");
        assert.ok(session.state.blocks.some((b) => b.active), "the fold is recorded as an active block");
        assert.equal(logs.filter((line) => line.startsWith("warn") && line.includes("#6069")).length, 1, "one warn line names the resumed folding");
    } finally {
        await upstream.close();
    }
});

// End to end, with the latch set by fold-reconcile itself: a folded history is
// replaced by an unrelated one under the same session id (three passes), then
// the new history grows past the window.

const E2E_SUMMARY =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. " +
    "Key decisions: chose the preflight approach. Files touched: src/a.ts:10. Outcome: fixed and verified by tests.";

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function wireHistory(tag: string, count: number, repeat: number): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${tag} message ${i}. ` + `${tag}_${i}_content_`.repeat(repeat) });
    }
    return messages;
}

test("e2e #6069: history replaced under the same session id, then grown past the window: the turn is folded and forwarded", async () => {
    const calls: Array<{ stream: boolean; body: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", type: "message", role: "assistant", model: "claude-small",
                    content: [{ type: "text", text: E2E_SUMMARY }], stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    registry._setForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: 12_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    const send = async (messages: unknown): Promise<number> => {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue6069-e2e" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages }),
        });
        await response.text();
        return response.status;
    };
    const summaryCalls = (): number => calls.filter((c) => !c.stream).length;
    const session = (): Session => {
        const found = listSessions().find((s) => s.id === "issue6069-e2e");
        assert.ok(found, "the session exists");
        return found;
    };

    try {
        // 1. A ~26K-token history on a 12K window: preflight folds it.
        assert.equal(await send(wireHistory("OLD", 24, 250)), 200);
        assert.ok(session().state.blocks.some((b) => b.active), "the old history is folded");

        // 2. An unrelated history that fits the window, resent three times:
        //    fold-reconcile latches the epoch confirmation and keeps the snapshot.
        const replaced = wireHistory("NEW", 12, 100);
        for (let pass = 0; pass < 3; pass++) assert.equal(await send(replaced), 200, "a fitting history passes through while folding is paused");
        assert.equal(epochConfirmPending(session()), true, "precondition: the epoch-confirm latch is pending");
        const foldedBefore = summaryCalls();

        // 3. The new history grows past the window.
        const grown = [...replaced, ...wireHistory("GROWN", 16, 250)];
        assert.equal(await send(grown), 200, "the over-window turn is folded and forwarded, not refused");
        assert.ok(summaryCalls() > foldedBefore, "preflight summarized the new history");
        const forwarded = calls.filter((c) => c.stream).at(-1);
        assert.ok(forwarded, "a forward happened");
        assert.ok(forwarded.body.includes(E2E_SUMMARY), "the new summary is in the forwarded payload");
        assert.ok(!forwarded.body.includes("OLD_1_content_"), "nothing of the replaced history is forwarded");
        assert.ok(forwarded.body.includes("GROWN_15_content_"), "the newest turn stays verbatim");
        assert.equal(epochConfirmPending(session()), false, "the fresh fold starts the new epoch: the latch clears");

        // 4. The session keeps working.
        assert.equal(await send([...grown, { role: "assistant", content: "ok" }, { role: "user", content: "next question" }]), 200);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
