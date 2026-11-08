// #3248 phase 2 — opencode incremental adapter. Drives the two exported
// seams directly (maybeIncrementalOpencode / opencodeIncrementalOnResponse)
// against a fake lane origin: the probe endpoint decides enablement, the
// body/marker assertions pin the divert contract, and the ack→delta pair
// pins the state machine ride-along. #3329: ack calls pass the OUTGOING
// headers of the very request being acknowledged (read back off the swapped
// Request, exactly as native-intercept threads them into onResponse) —
// attribution is by the per-request turn id, never by URL. The full e2e
// (marker divert through the real server) lives in incremental-lane.test.ts.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.NODE_TEST_CONTEXT = "1";

const { maybeIncrementalOpencode, opencodeIncrementalOnResponse, opencodeIncrementalOnHttpResponse, __resetOpencodeIncrementalForTests } = await import("../src/agent/opencode-native.ts");
const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.ts");
const { __resetIncrementalClientForTests } = await import("../src/agent/incremental-client.ts");
import type { V2HttpRequestEvent, V2State } from "../src/agent/opencode-v2.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";

async function fakeLane(enabled: boolean, cacheControlRetouch?: boolean, responsesInput?: boolean): Promise<{ base: string; close: () => Promise<void> }> {
    const srv = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/__bili/plugin/turn") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled, storage: enabled ? "unified" : "legacy-only", cacheControlRetouch, responsesInput }));
            return;
        }
        res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function fakeEvent(body: unknown, sid: string, modelUrl = MODEL_URL): { e: V2HttpRequestEvent; url: string } {
    const req = new Request(modelUrl, {
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

const lanes: { close: () => Promise<void> }[] = [];

for (const supported of [undefined, false, true]) {
    test(`HTTP Responses: capability ${String(supported)} gates exact input-item suffix transport`, async () => {
        __resetIncrementalClientForTests();
        __resetOpencodeIncrementalForTests();
        const lane = await fakeLane(true, undefined, supported);
        lanes.push(lane);
        const s = state(lane.base);
        const url = "https://api.openai.com/v1/responses";
        const seed = [{ role: "user", content: [{ type: "input_text", text: "hello β" }] }];
        const parameters = { model: "gpt-fixture", stream: true, instructions: "preserve opaque values" };
        const first = fakeEvent({ ...parameters, input: seed }, "responses-items", url);
        const original = first.e.request;
        await maybeIncrementalOpencode(first.e, s);
        if (supported !== true) {
            assert.equal(first.e.request, original, "unadvertised support must retain the ORIGINAL request");
            assert.equal((first.e.request as Request).headers.get("x-bili-plugin-turn"), null);
            return;
        }
        const sent = first.e.request as Request;
        assert.equal(sent.headers.get("x-bili-plugin-turn"), "1", "HTTP Responses must use the advertised item lane");
        const initial = await sent.clone().json() as { wireFormat: string; sinceSeq: number; messages: unknown[]; request: Record<string, unknown> };
        assert.equal(initial.wireFormat, "responses");
        assert.equal(initial.sinceSeq, 0);
        assert.deepEqual(initial.messages, seed);
        assert.equal(initial.request.input, undefined);
        assert.equal(initial.request.instructions, parameters.instructions);
        opencodeIncrementalOnResponse(url, new Response("{}", { headers: { "x-bili-applied-seq": "1" } }), headersOf(sent));
        const suffix = [
            { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "OPAQUE β\\n0==" },
            { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read", arguments: '{"path":"synthetic β","limit":2}' },
            { type: "function_call_output", call_id: "call_fixture", output: "exact tool result β\n" },
            { role: "user", content: [{ type: "input_text", text: "next" }] },
        ];
        const next = fakeEvent({ ...parameters, input: [...seed, ...suffix] }, "responses-items", url);
        await maybeIncrementalOpencode(next.e, s);
        const body = await (next.e.request as Request).clone().json() as { wireFormat: string; sinceSeq: number; messages: unknown[] };
        assert.equal(body.wireFormat, "responses");
        assert.equal(body.sinceSeq, 1);
        assert.deepEqual(body.messages, suffix, "opaque reasoning and ordered call/result values must remain exact");
        assert.equal(body.messages.length, 4, "count wire items rather than core messages");
    });
}

after(async () => {
    for (const l of lanes) await l.close();
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
});

test("HTTP Responses: false item ack reseeds; upstream continuation remains untouched", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true, undefined, true);
    lanes.push(lane);
    const s = state(lane.base);
    const url = "https://api.openai.com/v1/responses";
    const firstInput = [{ role: "user", content: "one" }];
    const first = fakeEvent({ model: "gpt-fixture", input: firstInput }, "responses-false-ack", url);
    await maybeIncrementalOpencode(first.e, s);
    opencodeIncrementalOnResponse(url, new Response("{}", { headers: { "x-bili-applied-seq": "2" } }), headersOf(first.e.request as Request));
    const nextInput = [...firstInput, { role: "assistant", content: "two" }, { role: "user", content: "three" }];
    const next = fakeEvent({ model: "gpt-fixture", input: nextInput }, "responses-false-ack", url);
    await maybeIncrementalOpencode(next.e, s);
    const sent = await (next.e.request as Request).clone().json() as { sinceSeq: number; resync: boolean; messages: unknown[] };
    assert.equal(sent.sinceSeq, 0);
    assert.equal(sent.resync, true);
    assert.deepEqual(sent.messages, nextInput);
    opencodeIncrementalOnResponse(url, new Response("{}", { headers: { "x-bili-applied-seq": "3" } }), headersOf(next.e.request as Request));
    const continuing = fakeEvent({ model: "gpt-fixture", input: [{ role: "user", content: "four" }], previous_response_id: "resp_existing" }, "responses-false-ack", url);
    const original = continuing.e.request;
    await maybeIncrementalOpencode(continuing.e, s);
    assert.equal(continuing.e.request, original);
});

test("HTTP Responses: a lost replacement acknowledgement cannot reuse an earlier equal-length prefix", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true, undefined, true);
    lanes.push(lane);
    const s = state(lane.base);
    const url = "https://api.openai.com/v1/responses";
    const a = { role: "user", content: "history A" };
    const b = { role: "user", content: "replacement B" };
    const c = { role: "user", content: "suffix C" };
    const seed = fakeEvent({ model: "gpt-fixture", input: [a] }, "lost-replacement-ack", url);
    await maybeIncrementalOpencode(seed.e, s);
    opencodeIncrementalOnResponse(url, new Response("{}", { headers: { "x-bili-applied-seq": "1" } }), headersOf(seed.e.request as Request));
    const replacement = fakeEvent({ model: "gpt-fixture", input: [b] }, "lost-replacement-ack", url);
    await maybeIncrementalOpencode(replacement.e, s);
    const replaced = await (replacement.e.request as Request).clone().json() as { resync: boolean; messages: unknown[] };
    assert.equal(replaced.resync, true);
    assert.deepEqual(replaced.messages, [b]);
    // The server accepted B, but its response never reaches the adapter.
    // Advance only the adapter's pending TTL, then return to the original branch.
    const now = Date.now;
    const advanced = now() + 31_000;
    try {
        Date.now = () => advanced;
        const next = fakeEvent({ model: "gpt-fixture", input: [a, c] }, "lost-replacement-ack", url);
        await maybeIncrementalOpencode(next.e, s);
        const sent = await (next.e.request as Request).clone().json() as { sinceSeq: number; resync: boolean; messages: unknown[] };
        assert.equal(sent.sinceSeq, 0, "an unacknowledged replacement invalidates the earlier prefix");
        assert.equal(sent.resync, true);
        assert.deepEqual(sent.messages, [a, c], "never append C to the server's replacement B");
    } finally {
        Date.now = now;
    }
});

test("opencode incremental: seed swap (marker + shaped body, headers preserved), ack, then delta", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const s = state(lane.base);

    const msgs1 = [{ role: "user", content: "hello opencode" }];
    const { e, url } = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs1 }, "oc-inc-1");
    await maybeIncrementalOpencode(e, s);
    const swapped = e.request as Request;
    assert.notEqual(swapped.url, undefined);
    const body = JSON.parse(await swapped.clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
    assert.equal(body.conversationId, "oc-inc-1");
    assert.equal(body.sinceSeq, 0);
    assert.equal((body.messages as unknown[]).length, 1);
    assert.equal(body.model, undefined, "incremental payload carries model inside request, not top-level");
    assert.equal(swapped.headers.get("x-bili-plugin-turn"), "1", "marker stamped on the replaced request");
    assert.equal(swapped.headers.get("authorization"), "Bearer sk-test", "original headers survive the swap");

    // ack advances the helper state machine (attributed by this request's own turn id)
    opencodeIncrementalOnResponse(url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(swapped));
    assert.notEqual(headersOf(swapped)["x-bili-turn-id"], undefined, "turn id stamped on the outgoing request");

    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs2 }, "oc-inc-1");
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = JSON.parse(await (t2.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
    assert.equal(body2.sinceSeq, 1, "second turn rides the acked watermark");
    assert.equal((body2.messages as unknown[]).length, 2, "only the delta rides");
});

for (const supported of [undefined, false, true]) {
    test(`opencode rolling marks: capability ${String(supported)} gates retouch`, async () => {
        __resetIncrementalClientForTests();
        __resetOpencodeIncrementalForTests();
        const lane = await fakeLane(true, supported);
        lanes.push(lane);
        const s = state(lane.base);
        const marked = { type: "text", text: "first", cache_control: { type: "ephemeral" } };
        const first = fakeEvent({ model: "claude-test", messages: [{ role: "user", content: [marked] }] }, "oc-capability");
        await maybeIncrementalOpencode(first.e, s);
        opencodeIncrementalOnResponse(first.url, new Response("{}", { headers: { "x-bili-applied-seq": "1" } }), headersOf(first.e.request as Request));
        const next = fakeEvent({ model: "claude-test", messages: [
            { role: "user", content: [{ type: "text", text: "first" }] },
            { role: "assistant", content: "reply" },
            { role: "user", content: [{ ...marked, text: "next" }] },
        ] }, "oc-capability");
        const original = next.e.request;
        await maybeIncrementalOpencode(next.e, s);
        if (supported !== true) {
            assert.equal(next.e.request, original, "old server gets unchanged full request");
        } else {
            const body = await (next.e.request as Request).json() as { messages: unknown[]; retouch?: unknown };
            assert.equal(body.messages.length, 2);
            assert.deepEqual(body.retouch, [{ index: 0, message: { role: "user", content: [{ type: "text", text: "first" }] } }]);
        }
    });
}

test("opencode incremental: probe disabled leaves the request untouched", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(false);
    lanes.push(lane);
    const original = { model: "claude-test", max_tokens: 512, messages: [{ role: "user", content: "hello" }] };
    const { e } = fakeEvent(original, "oc-inc-off");
    await maybeIncrementalOpencode(e, state(lane.base));
    const body = await (e.request as Request).clone().json();
    assert.deepEqual(body, original, "request body is byte-equivalent when the feature is off");
    assert.equal((e.request as Request).headers.get("x-bili-plugin-turn"), null);
});

test("opencode incremental: OpenAI-tool shapes never swap", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const original = { model: "gpt-test", max_tokens: 512, messages: [{ role: "assistant", content: "x", tool_calls: [{ id: "c", type: "function", function: { name: "f" } }] }] };
    const { e } = fakeEvent(original, "oc-inc-tool");
    await maybeIncrementalOpencode(e, state(lane.base));
    const body = await (e.request as Request).clone().json();
    assert.deepEqual(body, original, "non-anthropic wire shapes ride full resend");
});

test("opencode incremental: #3369 — one 409 re-seeds the next turn; three consecutive 409s fall back for good", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const s = state(lane.base);
    // seed → ack → delta rejected 409 — transient drift must SELF-HEAL: the
    // next turn re-seeds with a full resync:true body instead of going dead.
    const msgs1 = [{ role: "user", content: "hello" }];
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: msgs1 }, "oc-inc-dead");
    await maybeIncrementalOpencode(t1.e, s);
    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(t1.e.request as Request));
    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "again" }];
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: msgs2 }, "oc-inc-dead");
    await maybeIncrementalOpencode(t2.e, s);
    const t2Body = JSON.parse(await (t2.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as { sinceSeq: number };
    assert.equal(t2Body.sinceSeq, 1, "delta planned");
    // the delta was parsed from the CLONED request — ack with the ORIGINAL t2 url
    opencodeIncrementalOnResponse(t2.url, new Response("{}", { status: 409, headers: { "x-bili-server-seq": "1" } }), headersOf(t2.e.request as Request));
    const original = { model: "claude-test", max_tokens: 512, messages: [...msgs2, { role: "user", content: "more" }] };
    const t3 = fakeEvent(original, "oc-inc-dead");
    await maybeIncrementalOpencode(t3.e, s);
    const body = await (t3.e.request as Request).clone().json() as { resync?: boolean; sinceSeq: number; messages: unknown[] };
    assert.equal(body.resync, true, "#3369: re-seed with a wholesale resync after one drift");
    assert.equal(body.sinceSeq, 0);
    assert.equal(body.messages.length, original.messages.length, "full set, not a delta");

    // the re-seed landed and was acked (circuit cleared) — now trip it for
    // good: three consecutive 409s with no ack between → sticky fallback.
    opencodeIncrementalOnResponse(t3.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": String(original.messages.length) } }), headersOf(t3.e.request as Request));
    for (let i = 0; i < 3; i++) {
        const t = fakeEvent({ model: "claude-test", max_tokens: 512, messages: [...original.messages, { role: "user", content: `x${i}` }] }, "oc-inc-dead");
        await maybeIncrementalOpencode(t.e, s);
        opencodeIncrementalOnResponse(t.url, new Response("{}", { status: 409, headers: { "x-bili-server-seq": "1" } }), headersOf(t.e.request as Request));
    }
    const last = { model: "claude-test", max_tokens: 512, messages: [...original.messages, { role: "user", content: "final" }] };
    const t4 = fakeEvent(last, "oc-inc-dead");
    await maybeIncrementalOpencode(t4.e, s);
    const body4 = await (t4.e.request as Request).clone().json();
    assert.deepEqual(body4, last, "circuit tripped: dead conversation resends full via the host path");
});

test("opencode incremental: a 200 without an ack header does not steal the pending slot (#3369)", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const s = state(lane.base);
    const msgs1 = [{ role: "user", content: "hello" }];
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: msgs1 }, "oc-inc-slot");
    await maybeIncrementalOpencode(t1.e, s); // seed — pending entry set for the model URL

    // a concurrent full-resend request on the same URL answers first WITHOUT
    // the ack header — it must not consume the marker'd turn's pending slot.
    // #3329: the 2-arg call carries no outgoing headers at all — a response
    // with no turn-id header is not an incremental ack and consumes nothing.
    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200 }));

    // the marker'd turn's own 200 still records its ack (attributed by its
    // own turn id, threaded from its outgoing headers)
    opencodeIncrementalOnResponse(t1.url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(t1.e.request as Request));

    // ...so the next turn rides the delta instead of re-seeding
    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, messages: msgs2 }, "oc-inc-slot");
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = JSON.parse(await (t2.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
    assert.equal(body2.sinceSeq, 1, "ack survived the interleaved headerless 200");
    assert.equal((body2.messages as unknown[]).length, 2, "delta rides — no re-seed after the interleaving");
});

test("opencode incremental: late response crossing the TTL attributes by turn id, never by URL (#3329)", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const s = state(lane.base);
    // Two conversations sharing ONE provider URL and the SAME host system
    // prompt — the shape #3329 reports in the field. Sequenced for the #3378
    // single-flight guard (kept over #3329's removal per the #3340 rebase
    // decision): while a marker'd request for this URL is un-acked, a second
    // conversion on the same URL rides full resend — so B's post-ack turn
    // can only be exercised after B's OWN ack, and A's reseed after B's
    // pending is consumed. Every original assertion intent survives the
    // reordering (documented inline).
    const system = "be terse";
    const a1msgs = [{ role: "user", content: "a1" }];
    const b1msgs = [{ role: "user", content: "b1" }];

    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;
    try {
        const a1 = fakeEvent({ model: "claude-test", max_tokens: 512, system, messages: a1msgs }, "oc-late-a");
        await maybeIncrementalOpencode(a1.e, s);
        const aHeaders = headersOf(a1.e.request as Request);
        assert.notEqual(aHeaders["x-bili-turn-id"], undefined, "turn id stamped on A's outgoing request");

        // A's round-trip outlives the pending TTL (slow non-streaming request)
        // — the sweep frees the URL slot, so B converts under the guard.
        t += 31_000;
        const b1 = fakeEvent({ model: "claude-test", max_tokens: 512, system, messages: b1msgs }, "oc-late-b");
        await maybeIncrementalOpencode(b1.e, s);
        const bHeaders = headersOf(b1.e.request as Request);
        assert.notEqual(bHeaders["x-bili-turn-id"], undefined, "turn id stamped on B's outgoing request");
        assert.notEqual(bHeaders["x-bili-turn-id"], aHeaders["x-bili-turn-id"], "each dispatch carries its own correlation id");
        const b1Body = JSON.parse(await (b1.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
        assert.equal(b1Body.sinceSeq, 0, "B's first turn seeds (not credited with anything yet)");
        assert.equal(b1Body.resync, true, "B's first turn seeds");
        assert.equal(b1Body.system, system, "seed carries B's own system — no taint from A");

        // A's LATE response lands after B planned on the same URL. The old
        // URL-keyed table credited this ack to B; now A's entry was swept and
        // the response carries no live turn id — it cannot touch either state
        // machine except through its own (expired) id.
        opencodeIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "42" } }), aHeaders);

        // B's OWN response then credits exactly B — and the delta it plans
        // rides watermark 7, never 42: if A's late ack had been attributed to
        // B (the URL-keyed bug), this sinceSeq would read 42.
        opencodeIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "7" } }), bHeaders);
        const b2msgs = [...b1msgs, { role: "assistant", content: "b1r" }, { role: "user", content: "b2" }];
        const b2 = fakeEvent({ model: "claude-test", max_tokens: 512, system, messages: b2msgs }, "oc-late-b");
        await maybeIncrementalOpencode(b2.e, s);
        const b2Body = JSON.parse(await (b2.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
        assert.equal(b2Body.sinceSeq, 7, "B was never credited with A's ack (42) — it rides its own (7)");
        assert.equal((b2Body.messages as unknown[]).length, 2, "delta only — B's own watermark carries");

        // B's chain keeps riding its own acks: ack b2 FIRST — the #3378
        // single-flight guard holds the URL slot until b2's ack lands.
        opencodeIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "9" } }), headersOf(b2.e.request as Request));

        // A's expired turn is an honest loss: A reseeds instead of riding a
        // watermark it never actually received (b2's pending was consumed by
        // its own ack above, so the URL slot is free again).
        const a2msgs = [...a1msgs, { role: "assistant", content: "a1r" }, { role: "user", content: "a2" }];
        const a2 = fakeEvent({ model: "claude-test", max_tokens: 512, system, messages: a2msgs }, "oc-late-a");
        await maybeIncrementalOpencode(a2.e, s);
        const a2Body = JSON.parse(await (a2.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
        assert.equal(a2Body.sinceSeq, 0, "A's expired entry was swept — honest reseed");
        assert.equal(a2Body.resync, true, "A reseeds wholesale, not on a watermark it never saw");

        // A's reseed acks on ITS OWN turn id (a1's expired id stays dead);
        // B's next delta is then free to convert under the guard.
        opencodeIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "11" } }), headersOf(a2.e.request as Request));
        const b3msgs = [...b2msgs, { role: "assistant", content: "b2r" }, { role: "user", content: "b3" }];
        const b3 = fakeEvent({ model: "claude-test", max_tokens: 512, system, messages: b3msgs }, "oc-late-b");
        await maybeIncrementalOpencode(b3.e, s);
        const b3Body = JSON.parse(await (b3.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as { sinceSeq: number };
        assert.equal(b3Body.sinceSeq, 9, "B rides its own watermark");
    } finally {
        Date.now = realNow;
    }
});

test("opencode incremental: V2 http.response seam acks the turn (attach/spawn mode has no fetch intercept)", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const s = state(lane.base);

    const msgs1 = [{ role: "user", content: "hello v2" }];
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs1 }, "oc-inc-v2");
    await maybeIncrementalOpencode(t1.e, s);
    const sent = t1.e.request as Request;
    assert.equal(sent.headers.get("x-bili-plugin-turn"), "1");

    // ignored: events without a response, or for requests the lane never stamped
    opencodeIncrementalOnHttpResponse({ request: sent } as unknown as V2HttpRequestEvent);
    opencodeIncrementalOnHttpResponse({ request: new Request(MODEL_URL, { method: "POST", body: "{}" }), response: new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "7" } }) } as unknown as V2HttpRequestEvent);

    // the host's http.response event: the SENT request + the upstream reply
    opencodeIncrementalOnHttpResponse({ request: sent, response: new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }) } as unknown as V2HttpRequestEvent);

    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs2 }, "oc-inc-v2");
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = await (t2.e.request as Request).clone().json() as Record<string, unknown>;
    assert.equal(body2.sinceSeq, 1, "the http.response ack advanced the watermark");
    assert.equal((body2.messages as unknown[]).length, 2, "only the delta rides");
});

test("opencode v2 setup: onResponse registers the http.response hook and never throws into the host", async () => {
    const hooks = new Map<string, (e: Record<string, unknown>) => unknown>();
    const seen: unknown[] = [];
    const ctx = {
        session: {
            hook: async (name: string, cb: (e: Record<string, unknown>) => unknown) => {
                hooks.set(name, cb);
                return { dispose: () => {} };
            },
        },
    };
    const setup = createOpencodeV2Setup({ onResponse: (e) => { seen.push(e); throw new Error("boom"); } });
    try {
        await (setup as unknown as (c: unknown) => Promise<unknown>)(ctx);
    } catch {
        // other seams of this minimal fake ctx may be missing; only the hook registration matters here
    }
    const cb = hooks.get("http.response");
    assert.ok(cb, "http.response hook registered");
    const ev = { response: new Response("{}") };
    await cb(ev);
    assert.deepEqual(seen, [ev], "callback receives the host event; its throw is swallowed");
});
