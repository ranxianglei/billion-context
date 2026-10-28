/**
 * #4804 — WS delta continuation: unit pins for the anchored snapshot render,
 * the chained checkpoint history, and the session's admission short-circuit.
 *
 * A codex/opencode WebSocket client that keeps a previous_response_id
 * checkpoint sends small input tails instead of full-history replays. bili
 * augments the tail with the server-committed previous output, renders the
 * outbound prefix from the unified transcript (anchored mode of the #3756
 * engine), and verifies the seam against an identitySig recorded at commit
 * time. Every miss degrades to the legacy full-reconstruction path or the
 * 400 the client answers with a full replay — never a guessed view.
 *
 * Gate discipline (#3617): every positive case has its negative twin below.
 */

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_ROLLOUT_WS_DELTA_CONTINUATION = "1";

import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";

process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-ws-delta-anchor-")), "no-config.json");

import type { BiliMessage } from "acp-kernel/wire";
import { buildAnchoredView, identitySig, SnapshotAnchorFallbackError, WS_ANCHORED_REQ_PROP } from "../src/server/snapshot-render.ts";
import { responsesToCoreWithToolImages } from "../src/responses-tool-output.ts";
import { _setStoreForTest, type SessionStore } from "../src/persist.ts";
import { ResponsesWsHistory, ResponsesWsSession } from "../src/responses-ws.ts";
import type { WsBridgeCodec, WsBridgeContext } from "../src/ws-bridge.ts";
import type { Session } from "../src/session.ts";

type Item = Record<string, unknown>;

function msg(id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage {
    return { id, role, contentType: "text", text } as BiliMessage;
}

interface RawRow {
    seq: number;
    msgId: string;
    content: string;
}

function fakeStore(rows: RawRow[]): SessionStore {
    const inWindow = (seq: number, intervals: readonly [number, number][]) => intervals.some(([a, b]) => seq >= a && seq <= b);
    const fake = {
        unifiedReads: () => true,
        unifiedTailSeqs: () => rows.map((r) => r.seq),
        unifiedTailViewRows: () => rows,
        unifiedMessageIdRows: () => rows.map(({ seq, msgId }) => ({ seq, msgId })),
        unifiedUncoveredRows: (_id: string, intervals: readonly [number, number][]) => rows.filter((r) => !inWindow(r.seq, intervals)),
        unifiedMessageRows: (_id: string, ids: readonly string[]) => rows.filter((r) => ids.includes(r.msgId)),
    };
    return fake as unknown as SessionStore;
}

let nextSessionId = 0;

function anchorRender(blocks: { blockId: string; active: boolean; effectiveMessageIds: string[] }[], tail: BiliMessage[], rows: RawRow[], probeSig: string | null): ReturnType<typeof buildAnchoredView> {
    _setStoreForTest(fakeStore(rows));
    nextSessionId++;
    const session = {
        id: `sess-ws-delta-${nextSessionId}`,
        state: { blocks },
        metadata: {},
    } as unknown as Session;
    return buildAnchoredView(session, tail, probeSig);
}

const rowsOf = (msgs: BiliMessage[]): RawRow[] => msgs.map((m, i) => ({ seq: i + 1, msgId: m.id, content: JSON.stringify(m) }));

test("#4804 anchored: probe parity renders all rows + verbatim tail (nothing folded)", () => {
    const rows = [msg("r1", "one"), msg("r2", "two"), msg("r3", "three")];
    const tail = [msg("t1", "tail-one"), msg("t2", "tail-two")];
    const result = anchorRender([], tail, rowsOf(rows), identitySig(rows[2]));
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.view.map((m) => m.id), ["r1", "r2", "r3", "t1", "t2"]);
    assert.equal(result.tailStart, 3);
});

test("#4804 anchored: covered region suppressed behind its synthetic anchor", () => {
    const rows = [msg("r1", "one"), msg("r2", "folded"), msg("r3", "folded-too"), msg("r4", "four")];
    const result = anchorRender([{ blockId: "b1", active: true, effectiveMessageIds: ["r2", "r3"] }], [msg("t1", "tail")], rowsOf(rows), identitySig(rows[3]));
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.view.map((m) => m.id), ["r1", "acp_summary_b1", "r4", "t1"]);
    assert.equal(result.tailStart, 3);
});

test("#4804 anchored: probe mismatch degrades (never guesses across a broken seam)", () => {
    const rows = [msg("r1", "one"), msg("r2", "two")];
    assert.deepEqual(anchorRender([], [msg("t1", "tail")], rowsOf(rows), identitySig(msg("other", "different"))), { ok: false, reason: "anchor-mismatch" });
});

test("#4804 anchored: null probe degrades (checkpoint carried no sig)", () => {
    assert.deepEqual(anchorRender([], [msg("t1", "tail")], rowsOf([msg("r1", "one")]), null), { ok: false, reason: "anchor-probe-unavailable" });
});

test("#4804 anchored: empty transcript degrades", () => {
    assert.deepEqual(anchorRender([], [msg("t1", "tail")], [], identitySig(msg("r1", "one"))), { ok: false, reason: "transcript-empty" });
});

test("#4804 anchored: unparsable last-row bytes degrade", () => {
    const rows: RawRow[] = [{ seq: 1, msgId: "r1", content: "{not-json" }];
    assert.deepEqual(anchorRender([], [msg("t1", "tail")], rows, identitySig(msg("r1", "one"))), { ok: false, reason: "row-unparsable" });
});

test("#4804 history: chained commits let expand() reconstruct across levels", () => {
    const h = new ResponsesWsHistory();
    const inA = [{ type: "message", role: "user", content: "a" }];
    const outA = [{ type: "message", role: "assistant", content: "reply-a" }];
    const inB = [{ type: "message", role: "user", content: "b" }];
    h.commit({ model: "m", input: inA }, { id: "ra", status: "completed", output: outA });
    h.commit({ model: "m", input: inB }, { id: "rb", status: "completed", output: [] }, { continuedId: "ra", tail: inB });
    assert.ok(h.current()?.base, "second commit must chain onto the first");
    const full = h.expand({ type: "response.create", previous_response_id: "rb", input: [{ type: "message", role: "user", content: "c" }] });
    assert.deepEqual(full.input, [...inA, ...outA, ...inB, { type: "message", role: "user", content: "c" }]);
});

test("#4804 history: a non-continuing commit replaces the chain (flat)", () => {
    const h = new ResponsesWsHistory();
    h.commit({ model: "m", input: [1] }, { id: "ra", status: "completed", output: [] });
    h.commit({ model: "m", input: [2] }, { id: "rb", status: "completed", output: [] });
    assert.equal(h.current()?.base, undefined);
    assert.equal(h.current()?.id, "rb");
});

test("#4804 history: over-budget commit clears the whole chain", () => {
    const h = new ResponsesWsHistory(64);
    h.commit({ model: "m", input: ["x".repeat(20)] }, { id: "ra", status: "completed", output: ["y".repeat(20)] });
    h.commit({ model: "m", input: ["z".repeat(20)] }, { id: "rb", status: "completed", output: ["w".repeat(20)] }, { continuedId: "ra" });
    assert.equal(h.current(), undefined, "combined size over the budget must drop the checkpoint");
    assert.throws(() => h.expand({ type: "response.create", previous_response_id: "rb", input: [] }), /previous_response_not_found/);
});

interface StubRes {
    response?: Item;
    restoredOutputItems: number;
    writableEnded: boolean;
    terminal: boolean;
    end(): void;
    destroy(): void;
}

function makeStubRes(): StubRes {
    return { restoredOutputItems: 0, writableEnded: false, terminal: false, end() { this.writableEnded = true; }, destroy() { this.writableEnded = true; } };
}

async function readBody(req: http.IncomingMessage): Promise<Item> {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    await once(req, "end");
    return JSON.parse(Buffer.concat(chunks).toString()) as Item;
}

function makeSession(dispatch: (req: http.IncomingMessage, res: Item & StubRes) => Promise<void>) {
    const socket = new net.Socket();
    const sent: Item[] = [];
    const context = {
        codec: { name: "codex-responses-ws", conversationHeader: "session-id", allowStreamFlag: true, matchUpgrade: () => undefined, createSession: () => { throw new Error("unused"); } } as unknown as WsBridgeCodec,
        peer: { readyState: 1, send: (text: string) => sent.push(JSON.parse(text)), close() {} } as unknown as WsBridgeContext["peer"],
        source: { socket, url: "/synthetic/v1/responses", headers: {} } as unknown as WsBridgeContext["source"],
        upstreamUrl: "https://example.invalid/responses",
        log: () => {},
        instanceId: "test-instance",
        dispatch,
    } as unknown as WsBridgeContext;
    const session = new ResponsesWsSession(context);
    return { session, sent, shutdown: () => { session.shutdown("test-finished"); socket.destroy(); } };
}

const userItem = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistantOut = (text: string): Item => ({ type: "message", id: `om_${Math.random().toString(36).slice(2)}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const completedTurn = (id: string, output: Item[]): Item => ({ id, status: "completed", output });
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const frame = (fields: Item): Buffer => Buffer.from(JSON.stringify({ type: "response.create", model: "synthetic", ...fields }));

test("#4804 session: eligible delta short-circuits to echo+tail with the anchor stamp", async () => {
    const turns: Array<{ body: Item; anchored: boolean }> = [];
    const s = makeSession(async (req, res) => {
        turns.push({ body: await readBody(req), anchored: Object.getOwnPropertySymbols(req).includes(WS_ANCHORED_REQ_PROP) });
        res.response = completedTurn(turns.length === 1 ? "cp-1" : "cp-2", turns.length === 1 ? [assistantOut("ok-one")] : []);
    });
    try {
        s.session.onMessage(frame({ input: [userItem("first-turn-text")] }), false);
        await tick();
        assert.equal(turns.length, 1, "seed turn reaches dispatch");
        s.session.onMessage(frame({ previous_response_id: "cp-1", input: [userItem("delta-tail")] }), false);
        await tick();
        assert.equal(turns.length, 2, "delta turn reaches dispatch");
        const { body, anchored } = turns[1];
        const input = body.input as Item[];
        const echoed = input[0];
        assert.equal(echoed?.type, "message", JSON.stringify(input));
        assert.equal(echoed?.role, "assistant");
        assert.deepEqual(echoed?.content, [{ type: "output_text", text: "ok-one" }], "echoed prev output rides first");
        assert.deepEqual(input[1], userItem("delta-tail"), "new tail follows the echo");
        assert.equal(anchored, true, "envelope must carry the non-enumerable anchor payload");
    } finally {
        s.shutdown();
    }
});

test("#4804 session: anchor fallback error becomes the client's standard 400 recovery", async () => {
    let calls = 0;
    const s = makeSession(async (_req, res) => {
        calls++;
        if (calls === 1) {
            res.response = completedTurn("cp-1", [assistantOut("ok-one")]);
            return;
        }
        if (calls === 2) throw new SnapshotAnchorFallbackError("anchor-mismatch");
        res.response = completedTurn("cp-3", []);
    });
    try {
        s.session.onMessage(frame({ input: [userItem("first-turn-text")] }), false);
        await tick();
        s.session.onMessage(frame({ previous_response_id: "cp-1", input: [userItem("delta-tail")] }), false);
        await tick();
        const refusals = s.sent.filter((e) => e.error);
        assert.equal(refusals.length, 1, JSON.stringify(s.sent));
        assert.equal((refusals[0]?.error as Item | undefined)?.code, "previous_response_not_found");
        assert.equal(refusals[0]?.status, 400);
        // Recovery: the chain is dropped, the client's full replay proceeds.
        s.session.onMessage(frame({ input: [userItem("first-turn-text"), userItem("full-replay")] }), false);
        await tick();
        assert.equal(calls, 3, "replay must reach dispatch");
        assert.equal(s.sent.filter((e) => e.error).length, 1, "replay must not be refused again");
    } finally {
        s.shutdown();
    }
});

test("#4804 session: rollout off takes the legacy full-reconstruction path", async () => {
    const prior = process.env.BILI_ROLLOUT_WS_DELTA_CONTINUATION;
    delete process.env.BILI_ROLLOUT_WS_DELTA_CONTINUATION;
    try {
        const turns: Array<{ body: Item; anchored: boolean }> = [];
        const s = makeSession(async (req, res) => {
            turns.push({ body: await readBody(req), anchored: Object.getOwnPropertySymbols(req).includes(WS_ANCHORED_REQ_PROP) });
            res.response = completedTurn(`cp-${turns.length}`, turns.length === 1 ? [assistantOut("ok-one")] : []);
        });
        try {
            s.session.onMessage(frame({ input: [userItem("first-turn-text")] }), false);
            await tick();
            s.session.onMessage(frame({ previous_response_id: `cp-1`, input: [userItem("delta-tail")] }), false);
            await tick();
            assert.equal(turns.length, 2);
            const { body, anchored } = turns[1];
            assert.equal(anchored, false, "no anchor stamp on the legacy path");
            assert.equal((body.input as Item[]).length, 3, "legacy expand(): prior input + prior output + new tail");
            assert.deepEqual((body.input as Item[])[2], userItem("delta-tail"));
        } finally {
            s.shutdown();
        }
    } finally {
        if (prior !== undefined) process.env.BILI_ROLLOUT_WS_DELTA_CONTINUATION = prior;
    }
});

test("#4804 session: non-echoable output item takes the turn down the legacy path", async () => {
    const turns: Array<{ body: Item; anchored: boolean }> = [];
    const s = makeSession(async (req, res) => {
        turns.push({ body: await readBody(req), anchored: Object.getOwnPropertySymbols(req).includes(WS_ANCHORED_REQ_PROP) });
        res.response = completedTurn(`cp-${turns.length}`, turns.length === 1 ? [{ type: "file_search_call", id: "fs_1", status: "completed" }] : []);
    });
    try {
        s.session.onMessage(frame({ input: [userItem("first-turn-text")] }), false);
        await tick();
        s.session.onMessage(frame({ previous_response_id: "cp-1", input: [userItem("delta-tail")] }), false);
        await tick();
        assert.equal(turns.length, 2);
        const { body, anchored } = turns[1];
        assert.equal(anchored, false, "search-call outputs cannot be echoed as input items");
        assert.equal((body.input as Item[]).length, 3, "legacy full reconstruction (in + out + tail)");
    } finally {
        s.shutdown();
    }
});

// The parity argument rests on converter determinism: the checkpoint's tailSig
// and the stored row's sig must derive from the same bytes identically.
test("#4804 tailSig: converting the same body twice yields identical last-core sigs", () => {
    const body: Item = { model: "m", stream: true, input: [userItem("probe-body-text")] };
    const convert = (): string => {
        const { msgs } = responsesToCoreWithToolImages(body as never);
        assert.ok(msgs[msgs.length - 1], "body must convert to at least one core message");
        return identitySig(msgs[msgs.length - 1]);
    };
    assert.equal(convert(), convert());
});
