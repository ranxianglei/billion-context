import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { ResponsesWsHistory, ResponsesWsSession } from "../src/responses-ws.ts";
import type { WsBridgeContext, WsBridgeSession } from "../src/ws-bridge.ts";

// #4804: the WS admission gate measures the RECONSTRUCTED full history —
// expand() = prior input + prior output + new input — against the fixed
// 100 MiB cap BEFORE dispatch runs, so a session whose processed outbound
// is far below the cap dies with 413 request_too_large on the next turn,
// even when the client only sends a few MiB of delta. Checkpoint accounting
// (commit) shares the same cap and clears checkpoints near it, stranding
// the following continuation with previous_response_not_found.
//
// These tests drive the real ResponsesWsSession.onMessage() admission seam
// directly (the same seam as the issue's offline repro harness) with a
// stubbed pipeline: dispatch is counted, and a completed turn is recorded
// by setting res.response exactly like the pipeline does. A full-stack
// fixture cannot express case 1: the ws server's maxPayload would kill a
// >100 MiB wire frame before the session code ever saw it. Heavy cases
// materialize ~100 MiB strings; node --test gives this file its own process
// so the spike stays contained.
//
// Cases 1–3 express the ACCEPTANCE behavior — they fail on unfixed code and
// their failure IS the bug reproduction. The controls must pass both before
// and after the fix (gate discipline #3617: both directions asserted).

type Item = Record<string, unknown>;

const MiB = 1024 * 1024;
const OLD_CAP_BYTES = 100 * MiB;

function makeContext(dispatch: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>): { context: WsBridgeContext; sent: Item[]; socket: net.Socket } {
    const socket = new net.Socket();
    const sent: Item[] = [];
    const source = new http.IncomingMessage(socket);
    source.url = "/synthetic/responses";
    const context: WsBridgeContext = {
        log: () => { },
        peer: {
            readyState: 1,
            send: (data: string): void => { sent.push(JSON.parse(data) as Item); },
            close: (): void => { },
        } as unknown as WsBridgeContext["peer"],
        source,
        upstreamUrl: "https://example.invalid/responses",
        dispatch,
        codec: {
            name: "codex-responses-ws",
            conversationHeader: "session-id",
            allowStreamFlag: true,
            matchUpgrade: (): string | undefined => undefined,
            createSession: (): WsBridgeSession => { throw new Error("unused at this seam"); },
        },
        instanceId: randomUUID(),
    };
    return { context, sent, socket };
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function completedTurn(id: string, text: string): Item {
    return { id, status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] };
}

test("#4804 case 1: full-history replay above the old 100 MiB cap reaches the ACP pipeline", { timeout: 60000 }, async () => {
    let dispatches = 0;
    const { context, sent, socket } = makeContext(async () => { dispatches++; });
    const session = new ResponsesWsSession(context);
    try {
        const frame: Item = { type: "response.create", model: "m", stream: true, input: [{ role: "user", content: "x".repeat(101 * MiB) }] };
        session.onMessage(Buffer.from(JSON.stringify(frame)), false);
        await tick();
        assert.equal(dispatches, 1, `full replay must reach dispatch, refusals: ${JSON.stringify(sent.map(e => e.error))}`);
    } finally {
        session.shutdown("test-finished");
        socket.destroy();
    }
});

test("#4804 case 2: small previous_response_id continuation reaches the pipeline once the reconstructed history crosses the old cap", { timeout: 90000 }, async () => {
    let dispatches = 0;
    const { context, sent, socket } = makeContext(async (_req, res) => {
        dispatches++;
        if (dispatches === 1) (res as unknown as { response?: Item }).response = completedTurn("cp-1", "ok-1");
    });
    const session = new ResponsesWsSession(context);
    try {
        // Turn one: a 99 MiB full turn — under the old cap, admitted, and its
        // completed response committed as the continuation checkpoint, exactly
        // what a successful production turn leaves behind.
        session.onMessage(Buffer.from(JSON.stringify({ type: "response.create", model: "m", stream: true, input: [{ role: "user", content: "x".repeat(99 * MiB) }] })), false);
        await tick();
        assert.equal(dispatches, 1, `turn one must be admitted under the old cap, refusals: ${JSON.stringify(sent.map(e => e.error))}`);
        // Turn two: a ~2 MiB delta frame. The client sends little; expand()
        // reconstructs ~101 MiB, which the old gate measured and refused.
        const delta: Item = { type: "response.create", model: "m", stream: true, previous_response_id: "cp-1", input: [{ role: "user", content: "y".repeat(2 * MiB) }] };
        assert.ok(Buffer.byteLength(JSON.stringify(delta)) < OLD_CAP_BYTES, "client frame itself must stay under the old cap");
        session.onMessage(Buffer.from(JSON.stringify(delta)), false);
        await tick();
        assert.equal(dispatches, 2, `small delta must reach dispatch although the reconstructed history exceeds the old cap, refusals: ${JSON.stringify(sent.map(e => e.error))}`);
    } finally {
        session.shutdown("test-finished");
        socket.destroy();
    }
});

test("#4804 stranding: checkpoint accounting retains a completed turn whose combined size crosses the old cap", { timeout: 60000 }, () => {
    const history = new ResponsesWsHistory();
    // Combined serialized request+output is ~101 MiB: the old shared-cap
    // accounting cleared the checkpoint here, and the next continuation died
    // with previous_response_not_found although the turn had succeeded.
    history.commit(
        { model: "m", stream: true, input: [{ role: "user", content: "x".repeat(99 * MiB) }] },
        { id: "cp-boundary", status: "completed", output: [{ type: "message", role: "assistant", content: "z".repeat(2 * MiB) }] },
    );
    assert.doesNotThrow(
        () => history.expand({ type: "response.create", model: "m", stream: true, previous_response_id: "cp-boundary", input: [{ role: "user", content: "next" }] }),
        "checkpoint must survive a combined size crossing the old 100 MiB cap",
    );
});

test("#4804 control: small turns continue normally through the admission gate", { timeout: 30000 }, async () => {
    let dispatches = 0;
    const { context, sent, socket } = makeContext(async (_req, res) => {
        dispatches++;
        (res as unknown as { response?: Item }).response = completedTurn(`cp-${dispatches}`, `ok-${dispatches}`);
    });
    const session = new ResponsesWsSession(context);
    try {
        session.onMessage(Buffer.from(JSON.stringify({ type: "response.create", model: "m", stream: true, input: [{ role: "user", content: "first" }] })), false);
        await tick();
        session.onMessage(Buffer.from(JSON.stringify({ type: "response.create", model: "m", stream: true, previous_response_id: "cp-1", input: [{ role: "user", content: "second" }] })), false);
        await tick();
        assert.equal(dispatches, 2, JSON.stringify(sent.map(e => e.error)));
        assert.ok(!sent.some(e => e.type === "error"), JSON.stringify(sent));
    } finally {
        session.shutdown("test-finished");
        socket.destroy();
    }
});

test("#4804 control: unknown previous_response_id is still refused with 400 and no dispatch", { timeout: 30000 }, async () => {
    let dispatches = 0;
    const { context, sent, socket } = makeContext(async () => { dispatches++; });
    const session = new ResponsesWsSession(context);
    try {
        session.onMessage(Buffer.from(JSON.stringify({ type: "response.create", model: "m", stream: true, previous_response_id: "nope", input: [{ role: "user", content: "x" }] })), false);
        await tick();
        assert.equal(dispatches, 0);
        const refusal = sent.find(e => e.type === "error");
        assert.ok(refusal, JSON.stringify(sent));
        assert.equal(refusal.status, 400);
        assert.equal((refusal.error as Item)?.code, "previous_response_not_found");
    } finally {
        session.shutdown("test-finished");
        socket.destroy();
    }
});
