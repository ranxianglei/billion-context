import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
// #4804 Option A: every WS-lane byte budget resolves through the EXISTING
// receive budget knob (BILI_RECEIVE_BODY_BYTES > network.receiveBodyBytes >
// 5 GiB) with zero new config fields. Pin a tiny budget process-wide: node
// --test isolates this file's process, and limitsReceiveBytes() resolves at
// construction time, so every session/history built below sees 1 MiB.
process.env.BILI_RECEIVE_BODY_BYTES = "1048576"; // 1 MiB

import { ResponsesWsHistory, ResponsesWsSession } from "../src/responses-ws.ts";
import type { WsBridgeContext } from "../src/ws-bridge.ts";

const KiB = 1024;

function makeContext(dispatch: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) {
    const socket = new net.Socket();
    const source = new http.IncomingMessage(socket);
    source.url = "/synthetic/responses";
    const sent: unknown[] = [];
    return {
        context: {
            log: () => {},
            peer: { readyState: 1, send: (text: string) => sent.push(JSON.parse(text)), close: () => {} } as unknown as WsBridgeContext["peer"],
            source,
            upstreamUrl: "https://example.invalid/responses",
            dispatch,
            codec: { name: "codex-responses-ws", conversationHeader: "session-id", allowStreamFlag: true, matchUpgrade: () => undefined, createSession: () => { throw new Error("unused"); } },
            instanceId: randomUUID(),
        } as unknown as WsBridgeContext,
        sent,
        socket,
    };
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const refusals = (sent: unknown[]): Array<{ code?: string; message?: string }> =>
    sent.filter(e => typeof e === "object" && e !== null && "error" in e).map(e => (e as { error?: { code?: string; message?: string } }).error ?? {});

test("WS admission honors the receive budget knob in both directions (#4804)", async () => {
    let dispatches = 0;
    const { context, sent, socket } = makeContext(async () => { dispatches += 1; });
    try {
        const session = new ResponsesWsSession(context);
        session.onMessage(Buffer.from(JSON.stringify({ type: "response.create", model: "synthetic", input: [{ role: "user", content: "x".repeat(512 * KiB) }] })), false);
        await tick();
        assert.equal(dispatches, 1, `sub-budget frame must be dispatched, refusals=${JSON.stringify(refusals(sent))}`);
        session.onMessage(Buffer.from(JSON.stringify({ type: "response.create", model: "synthetic", input: [{ role: "user", content: "y".repeat(1536 * KiB) }] })), false);
        await tick();
        assert.equal(dispatches, 1, "over-budget frame must not be dispatched");
        const refusal = refusals(sent).at(-1);
        assert.equal(refusal?.code, "request_too_large");
        assert.match(refusal?.message ?? "", /1 MiB request limit/, "refusal must name the live budget");
    } finally {
        socket.destroy();
    }
});

test("WS checkpoint accounting honors the receive budget knob in both directions (#4804)", () => {
    const history = new ResponsesWsHistory();
    // Combined serialized request+output ~1.2 MiB > 1 MiB: checkpoint must NOT be retained.
    history.commit({ model: "synthetic", stream: true, input: [{ role: "user", content: "x".repeat(900 * KiB) }] },
        { id: "cp-big", status: "completed", output: [{ role: "assistant", content: "z".repeat(300 * KiB) }] });
    assert.throws(() => history.expand({ type: "response.create", previous_response_id: "cp-big", input: [] }), { message: "previous_response_not_found" });
    // Combined ~576 KiB < 1 MiB: checkpoint retained, continuation expands.
    history.commit({ model: "synthetic", stream: true, input: [{ role: "user", content: "a".repeat(512 * KiB) }] },
        { id: "cp-small", status: "completed", output: [{ role: "assistant", content: "b".repeat(64 * KiB) }] });
    assert.doesNotThrow(() => history.expand({ type: "response.create", previous_response_id: "cp-small", input: [] }));
});
