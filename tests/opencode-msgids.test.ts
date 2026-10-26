// #4491 host wiring (opencode) — msgIds on incremental-lane turns.
//
// Stakes (all unit-level over the two seams the wiring owns, harness shaped
// like tests/opencode-incremental.test.ts):
//   1. ids flow end to end: the V1 `experimental.chat.messages.transform`
//      harvest lands on the planned turn body aligned 1:1 with the wire
//      messages — seed carries the full list, the post-ack delta carries
//      only the delta's ids (sliced in lockstep with the messages);
//   2. all-or-nothing: one message without a usable id (or with a part that
//      cannot be proven to lower 1:1) drops the whole msgIds field;
//   3. V2 shape — the dispatch fires with no V1 hook ever having run
//      (http.request sees only the wire) → no msgIds field, degrade safe.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.NODE_TEST_CONTEXT = "1";

const { maybeIncrementalOpencode, opencodeIncrementalOnResponse, __resetOpencodeIncrementalForTests, createV1ServerHooks } = await import("../src/agent/opencode-native.ts");
const { __resetIncrementalClientForTests } = await import("../src/agent/incremental-client.ts");
const { __resetOpencodeMsgIdsForTests } = await import("../src/agent/opencode-msgids.ts");
import type { V2HttpRequestEvent, V2State } from "../src/agent/opencode-v2.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";

async function fakeLane(): Promise<{ base: string; close: () => Promise<void> }> {
    const srv = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/__bili/plugin/turn") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled: true, storage: "unified" }));
            return;
        }
        res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function fakeEvent(body: unknown, sid: string): { e: V2HttpRequestEvent; url: string } {
    const req = new Request(MODEL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
        body: JSON.stringify(body),
    });
    const e = { request: req, sessionID: sid } as unknown as V2HttpRequestEvent;
    return { e, url: req.url };
}

function state(base: string): V2State {
    return { proxyBase: base } as unknown as V2State;
}

/** The outgoing headers of a swapped Request, normalized exactly like
 *  native-intercept's outgoingHeadersOf does for a Request-object input. */
function headersOf(req: Request): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of req.headers) out[k.toLowerCase()] = v;
    return out;
}

async function plannedBody(e: V2HttpRequestEvent): Promise<Record<string, unknown>> {
    return JSON.parse(await (e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
}

/** opencode 1.x messages.transform fire: host messages {info, parts}. */
function hostMessage(id: string, role: "user" | "assistant", text: string, sid: string): { info: { id: string; role: string; sessionID: string }; parts: unknown[] } {
    return { info: { id, role, sessionID: sid }, parts: [{ type: "text", text }] };
}

const wmsg = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });

const lanes: { close: () => Promise<void> }[] = [];
after(async () => {
    for (const l of lanes) await l.close();
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
});

test("opencode msgids: V1 harvest rides the turn body 1:1 — seed full, delta sliced", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    const s = state(lane.base);
    const hooks = createV1ServerHooks(() => lane.base, {}, {});

    const sid = "ses_msgid_1";
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: [hostMessage("msg_u1", "user", "hello", sid)] });
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: [wmsg("user", "hello")] }, sid);
    await maybeIncrementalOpencode(t1.e, s);
    const body1 = await plannedBody(t1.e);
    assert.equal((body1.messages as unknown[]).length, 1, "seed swap happened");
    assert.deepEqual(body1.msgIds, ["msg_u1"], "seed carries the harvested id aligned 1:1 with the wire message");
    assert.equal((t1.e.request as Request).headers.get("x-bili-plugin-turn"), "1", "marker still stamped");

    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(t1.e.request as Request));

    // next turn: the host re-fires the transform with the settled history —
    // the streaming-settled assistant arrives under its own id
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: [
        hostMessage("msg_u1", "user", "hello", sid),
        hostMessage("msg_a1", "assistant", "hi there", sid),
        hostMessage("msg_u2", "user", "next", sid),
    ] });
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: [wmsg("user", "hello"), wmsg("assistant", "hi there"), wmsg("user", "next")] }, sid);
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = await plannedBody(t2.e);
    assert.equal((body2.messages as unknown[]).length, 2, "delta turn rides only the suffix");
    assert.deepEqual(body2.msgIds, ["msg_a1", "msg_u2"], "delta msgIds sliced in lockstep with the delta messages");
});

test("opencode msgids: one unusable message drops the whole field (all-or-nothing)", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    const s = state(lane.base);
    const hooks = createV1ServerHooks(() => lane.base, {}, {});
    const sid = "ses_msgid_2";

    // a message without a host id → no msgIds at all (never mis-align)
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: [
        hostMessage("msg_u1", "user", "hello", sid),
        { info: { role: "assistant", sessionID: sid }, parts: [{ type: "text", text: "hi" }] },
        hostMessage("msg_u2", "user", "next", sid),
    ] });
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: [wmsg("user", "hello"), wmsg("assistant", "hi"), wmsg("user", "next")] }, sid);
    await maybeIncrementalOpencode(t1.e, s);
    const body1 = await plannedBody(t1.e);
    assert.equal((body1.messages as unknown[]).length, 3, "seed swap happened");
    assert.equal("msgIds" in body1, false, "a missing id drops the field for the whole turn");

    // a tool-bearing part cannot be proven to lower 1:1 → same degradation
    const sid2 = "ses_msgid_2b";
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: [
        hostMessage("msg_t1", "assistant", "calling", sid2),
        { info: { id: "msg_t2", role: "assistant", sessionID: sid2 }, parts: [{ type: "tool", tool: "bash", state: {} }] },
    ] });
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: [wmsg("assistant", "calling"), { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] }] }, sid2);
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = await plannedBody(t2.e);
    assert.equal("msgIds" in body2, false, "non-text parts degrade the turn to content-derived identities");
});

test("opencode msgids: V2 shape (no V1 hook fired) carries no msgIds — degrade safe", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    const s = state(lane.base);
    const sid = "ses_msgid_3";

    // http.request sees only the wire: no harvest exists for this session
    const msgs1 = [{ role: "user", content: "hello opencode" }];
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs1 }, sid);
    await maybeIncrementalOpencode(t1.e, s);
    const body1 = await plannedBody(t1.e);
    assert.equal((body1.messages as unknown[]).length, 1, "seed swap happened");
    assert.equal("msgIds" in body1, false, "V2-shaped seed carries no msgIds");

    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(t1.e.request as Request));

    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs2 }, sid);
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = await plannedBody(t2.e);
    assert.equal((body2.messages as unknown[]).length, 2, "delta planned");
    assert.equal("msgIds" in body2, false, "V2-shaped delta carries no msgIds either");
});

test("opencode msgids: content drift between harvest and wire degrades instead of mis-aligning", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    const s = state(lane.base);
    const hooks = createV1ServerHooks(() => lane.base, {}, {});
    const sid = "ses_msgid_4";

    // the wire text differs from the harvested parts → ids would mis-align
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: [hostMessage("msg_u1", "user", "hello", sid)] });
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: [wmsg("user", "hello EDITED")] }, sid);
    await maybeIncrementalOpencode(t1.e, s);
    const body1 = await plannedBody(t1.e);
    assert.equal((body1.messages as unknown[]).length, 1, "seed swap happened");
    assert.equal("msgIds" in body1, false, "drifted content never inherits an id it cannot prove");
    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(t1.e.request as Request));

    // cache_control on the wire is transport-only — alignment must survive it
    const sid2 = "ses_msgid_4b";
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: [hostMessage("msg_c1", "user", "cached", sid2)] });
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: [{ role: "user", content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] }] }, sid2);
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = await plannedBody(t2.e);
    assert.deepEqual(body2.msgIds, ["msg_c1"], "cache_control markers do not break the 1:1 proof");
});
