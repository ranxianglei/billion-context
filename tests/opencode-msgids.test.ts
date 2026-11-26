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
const { __resetOpencodeMsgIdsForTests, harvestOpencodeMsgIds, deriveOpencodeEntry } = await import("../src/agent/opencode-msgids.ts");
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

test("opencode msgids: a single-flight-blocked turn does not burn its ids (#4491/#3378)", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    const s = state(lane.base);
    const hooks = createV1ServerHooks(() => lane.base, {}, {});

    const sid = "ses_guard_burn";
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: [hostMessage("msg_u1", "user", "hello", sid)] });
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: [wmsg("user", "hello")] }, sid);
    await maybeIncrementalOpencode(t1.e, s);
    assert.equal((t1.e.request as Request).headers.get("x-bili-plugin-turn"), "1", "seed converted, left UN-acked");

    // While the seed is still pending, the next turn hits the single-flight
    // guard: the request must ride the normal pipeline untouched — and the
    // blocked attempt must NOT claim this turn's ids.
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: [
        hostMessage("msg_u1", "user", "hello", sid),
        hostMessage("msg_a1", "assistant", "hi there", sid),
        hostMessage("msg_u2", "user", "next", sid),
    ] });
    const wire2 = { model: "claude-test", max_tokens: 512, system: "be terse", messages: [wmsg("user", "hello"), wmsg("assistant", "hi there"), wmsg("user", "next")] };
    const t2b = fakeEvent(wire2, sid);
    await maybeIncrementalOpencode(t2b.e, s);
    assert.equal((t2b.e.request as Request).headers.get("x-bili-plugin-turn"), null, "guard: blocked attempt rides the normal pipeline");
    assert.deepEqual(await plannedBody(t2b.e), JSON.parse(JSON.stringify(wire2)), "body untouched by the blocked attempt");

    // The seed acks; the host retries the same turn — the delta ids must
    // still ride (a burned claim would silently drop the whole field).
    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(t1.e.request as Request));
    const t2 = fakeEvent(wire2, sid);
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = await plannedBody(t2.e);
    assert.deepEqual(body2.msgIds, ["msg_a1", "msg_u2"], "blocked attempt did not burn the delta ids");
});

// ── #5743 redo: REAL host ids from both seams (V2 "context" event shapes,
// tool sessions, the #5741 repeated-prompt scenario). The host message
// shapes below mirror live 2.0.4 captures (anthropic provider): role
// user/assistant/tool, content parts text / tool-call / tool-result.

function ctxMessage(id: string, role: string, content: unknown[]): { id: string; role: string; content: unknown[] } {
    return { id, role, content };
}

/** Simulate one `ctx.session.hook("context")` fire (V2 seam). */
function fireContext(sid: string, messages: unknown[]): void {
    harvestOpencodeMsgIds(sid, messages);
}

test("opencode msgids: V2 context seam carries real ids through a TOOL session", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    const s = state(lane.base);
    const sid = "ses_v2ctx_1";

    // Turn 1: user asks, assistant calls read(), the result comes back as a
    // host role-"tool" message carrying an ERROR result.
    fireContext(sid, [
        ctxMessage("msg_vu1", "user", [{ type: "text", text: "read README.md" }]),
    ]);
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: [
        { role: "user", content: [{ type: "text", text: "read README.md" }] },
        { role: "assistant", content: [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" }, cache_control: { type: "ephemeral" } },
        ] },
        { role: "user", content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "{\"error\":{}}", is_error: true, cache_control: { type: "ephemeral" } },
        ] },
    ] }, sid);
    // NOTE: fired BEFORE the request assembled — order inside the handler:
    // context first, http.request after; the seed below replans against this
    // latest fire exactly like the live hook does.
    fireContext(sid, [
        ctxMessage("msg_vu1", "user", [{ type: "text", text: "read README.md" }]),
        ctxMessage("msg_va1", "assistant", [
            { type: "text", text: "Reading." },
            { type: "tool-call", id: "toolu_1", name: "read", input: { path: "README.md" }, providerExecuted: false },
        ]),
        ctxMessage("msg_vt1", "tool", [
            { type: "tool-result", id: "toolu_1", name: "read", result: { type: "error", value: { error: {} } }, providerExecuted: false },
        ]),
    ]);
    await maybeIncrementalOpencode(t1.e, s);
    const body1 = await plannedBody(t1.e);
    assert.deepEqual(body1.msgIds, ["msg_vu1", "msg_va1", "msg_vt1"],
        "seed rides REAL host ids — text, tool-call (assistant), tool-result (host role \"tool\" normalized to wire \"user\"); error flag matched via is_error");

    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(t1.e.request as Request));

    // Turn 2: assistant settles on text; the delta must carry exactly its
    // own fresh id, sliced in lockstep with the suffix messages.
    fireContext(sid, [
        ctxMessage("msg_vu1", "user", [{ type: "text", text: "read README.md" }]),
        ctxMessage("msg_va1", "assistant", [
            { type: "text", text: "Reading." },
            { type: "tool-call", id: "toolu_1", name: "read", input: { path: "README.md" }, providerExecuted: false },
        ]),
        ctxMessage("msg_vt1", "tool", [
            { type: "tool-result", id: "toolu_1", name: "read", result: { type: "error", value: { error: {} } }, providerExecuted: false },
        ]),
        ctxMessage("msg_va2", "assistant", [{ type: "text", text: "It failed: missing file." }]),
        ctxMessage("msg_vu2", "user", [{ type: "text", text: "ok thanks" }]),
    ]);
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: [
        { role: "user", content: [{ type: "text", text: "read README.md" }] },
        { role: "assistant", content: [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" }, cache_control: { type: "ephemeral" } },
        ] },
        { role: "user", content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "{\"error\":{}}", is_error: true, cache_control: { type: "ephemeral" } },
        ] },
        { role: "assistant", content: [{ type: "text", text: "It failed: missing file." }] },
        { role: "user", content: [{ type: "text", text: "ok thanks" }] },
    ] }, sid);
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = await plannedBody(t2.e);
    assert.equal((body2.messages as unknown[]).length, 2, "delta rides only the suffix");
    assert.deepEqual(body2.msgIds, ["msg_va2", "msg_vu2"], "delta rides ONLY the fresh host ids");
});

test("opencode msgids: #5741 repeated-prompt turns get DISTINCT real ids", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    const s = state(lane.base);
    const sid = "ses_repeat_1";

    // Turn 1: prompt "go" → ids r1/a1.
    fireContext(sid, [ctxMessage("msg_r1", "user", [{ type: "text", text: "go" }])]);
    const w1 = { model: "claude-test", max_tokens: 512, system: "s", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] };
    const t1 = fakeEvent(w1, sid);
    await maybeIncrementalOpencode(t1.e, s);
    assert.deepEqual((await plannedBody(t1.e)).msgIds, ["msg_r1"]);
    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(t1.e.request as Request));

    // Turn 2: the BYTE-IDENTICAL prompt resends — opencode mints a FRESH id
    // for it. With derived content hashes both occurrences would collide;
    // the client must vouch the SECOND id so the lane pins a second row.
    fireContext(sid, [
        ctxMessage("msg_r1", "user", [{ type: "text", text: "go" }]),
        ctxMessage("msg_a1", "assistant", [{ type: "text", text: "done" }]),
        ctxMessage("msg_r2", "user", [{ type: "text", text: "go" }]),
    ]);
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "s", messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "text", text: "go" }] },
    ] }, sid);
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = await plannedBody(t2.e);
    assert.equal((body2.messages as unknown[]).length, 2,
        "delta covers the acked prompt's reply plus the repeated prompt itself");
    assert.deepEqual(body2.msgIds, ["msg_a1", "msg_r2"],
        "the repeated prompt vouches its OWN fresh id (msg_r2) — never collides with the pinned msg_r1 row");
});

test("opencode msgids: reasoning↔thinking aligns; noise parts skip; unknown parts degrade", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    __resetOpencodeMsgIdsForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    const s = state(lane.base);

    // reasoning part ↔ thinking block; v1 bookkeeping parts carry no wire block
    const sid = "ses_think_1";
    fireContext(sid, [
        ctxMessage("msg_h1", "assistant", [
            { type: "reasoning", text: "hmm…" },
            { type: "text", text: "answer" },
        ]),
    ]);
    let t = fakeEvent({ model: "claude-test", max_tokens: 512, messages: [
        { role: "assistant", content: [
            { type: "thinking", thinking: "hmm…", signature: "sig" },
            { type: "text", text: "answer" },
        ] },
    ] }, sid);
    await maybeIncrementalOpencode(t.e, s);
    assert.deepEqual((await plannedBody(t.e)).msgIds, ["msg_h1"], "reasoning part proves onto the thinking block positionally");

    // an UNRECOGNIZED part type must drop the field (never guess)
    const sid2 = "ses_unknown_1";
    fireContext(sid2, [
        ctxMessage("msg_k1", "user", [{ type: "source-url", url: "https://example.com" }]),
    ]);
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: [
        { role: "user", content: [{ type: "text", text: "whatever" }] },
    ] }, sid2);
    await maybeIncrementalOpencode(t2.e, s);
    assert.equal("msgIds" in (await plannedBody(t2.e)), false, "unknown part types degrade to content-derived identities");

    // duplicate ids drop the whole field even when every position otherwise aligns
    const sid3 = "ses_dup_1";
    fireContext(sid3, [
        ctxMessage("msg_d1", "user", [{ type: "text", text: "a" }]),
        ctxMessage("msg_d1", "assistant", [{ type: "text", text: "b" }]),
    ]);
    const t3 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
    ] }, sid3);
    await maybeIncrementalOpencode(t3.e, s);
    assert.equal("msgIds" in (await plannedBody(t3.e)), false, "duplicate ids can never ride");
});

test("opencode msgids: deriveOpencodeEntry unit-level normalization", () => {
    const e1 = deriveOpencodeEntry(ctxMessage("msg_x1", "tool", [
        { type: "tool-result", id: "toolu_9", name: "bash", result: { type: "error", value: "boom" }, providerExecuted: false },
    ]));
    assert.equal(e1.shape?.role, "user", "host role \"tool\" normalizes to wire \"user\"");
    assert.deepEqual(e1.shape?.toks, [`r\u0000toolu_9\u00001`], "tool-result anchored by id + error flag");

    const e2 = deriveOpencodeEntry({ info: { id: "msg_y1", role: "assistant", sessionID: "s" }, parts: [
        { type: "step-start" },
        { type: "text", text: "hi" },
        { type: "tool", tool: "bash", callID: "call_7", state: { status: "running" } },
        { type: "snapshot", snapshot: "abc" },
    ] });
    assert.deepEqual(e2.shape?.toks, [`t\u0000hi`, `c\u0000call_7\u0000bash`], "v1 bookkeeping parts (step-start/snapshot) skip; tool part anchors by callID+name");

    assert.equal(deriveOpencodeEntry({ info: { role: "system" }, parts: [] }).shape, null, "non-conversation roles poison the entry only");
    assert.equal(deriveOpencodeEntry({ id: "not-a-host-id", role: "user", content: [] }).id, "", "foreign-shaped ids stay unusable");
});
