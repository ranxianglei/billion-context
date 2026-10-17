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

const { maybeIncrementalOpencode, opencodeIncrementalOnResponse, __resetOpencodeIncrementalForTests } = await import("../src/agent/opencode-native.ts");
const { __resetIncrementalClientForTests } = await import("../src/agent/incremental-client.ts");
import type { V2HttpRequestEvent, V2State } from "../src/agent/opencode-v2.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";

async function fakeLane(enabled: boolean): Promise<{ base: string; close: () => Promise<void>; receipts: Map<string, { appliedSeq: number; boundary: string | null }>; pullCount: { pulls: number } }> {
    // #3352: the lane also serves the pull receipt — GET ?conversation=<sid>
    // answers { conversation: { appliedSeq, boundary } }. Tests drive the
    // receipt table directly (the canonical lives in the real lane; here we
    // pin the CLIENT half of the contract: when to adopt, when to decline).
    const receipts = new Map<string, { appliedSeq: number; boundary: string | null }>();
    const counters = { pulls: 0 };
    const srv = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && u.pathname === "/__bili/plugin/turn") {
            const conversation = u.searchParams.get("conversation");
            if (conversation !== null) {
                counters.pulls += 1;
                const r = receipts.get(conversation) ?? { appliedSeq: 0, boundary: null };
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled, storage: enabled ? "unified" : "legacy-only", conversation: { appliedSeq: r.appliedSeq, boundary: r.boundary } }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled, storage: enabled ? "unified" : "legacy-only" }));
            return;
        }
        res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())), receipts, pullCount: counters };
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

const lanes: { close: () => Promise<void> }[] = [];
after(async () => {
    for (const l of lanes) await l.close();
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
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

test("opencode incremental: #3352 pull reconcile — a V2 host with no response seam settles its last turn by boundary", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const s = state(lane.base);
    const { incrementalWireHash } = await import("../src/agent/incremental-client.ts");

    // V2 host: the http.request hook never observes responses — the seed's
    // pending entry is the only record of what was sent, and NOTHING acks it.
    const msgs1 = [{ role: "user", content: "hello pull" }];
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs1 }, "oc-pull-1");
    await maybeIncrementalOpencode(t1.e, s);
    assert.notEqual(headersOf(t1.e.request as Request)["x-bili-turn-id"], undefined, "seed dispatched with a turn id");
    // (no opencodeIncrementalOnResponse call — that seam does not exist here)

    // the lane's receipt: appliedSeq = seed length, boundary = wire hash of
    // the LAST message the host sent — the formula is shared by both sides.
    lane.receipts.set("oc-pull-1", { appliedSeq: msgs1.length, boundary: incrementalWireHash(msgs1[msgs1.length - 1]) });

    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs2 }, "oc-pull-1");
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = JSON.parse(await (t2.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
    assert.equal(body2.sinceSeq, 1, "pull receipt ADOPTED — the watermark advanced via the boundary match");
    assert.equal((body2.messages as unknown[]).length, 2, "delta rides on the pulled watermark");
    assert.equal(lane.pullCount.pulls, 1, "exactly one pull per reconcile");
});

test("opencode incremental: #3352 pull reconcile — a cold (null) or mismatched boundary is declined and re-seeds", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const s = state(lane.base);
    const { incrementalWireHash } = await import("../src/agent/incremental-client.ts");

    const msgs1 = [{ role: "user", content: "hello cold" }];
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs1 }, "oc-pull-2");
    await maybeIncrementalOpencode(t1.e, s);
    assert.equal(lane.pullCount.pulls, 0, "no stash → the seed turn itself never pulls");

    // cold lane: the canonical was rebuilt from the store — boundary is null
    // by design and MUST be declined (adopting would credit foreign rows).
    lane.receipts.set("oc-pull-2", { appliedSeq: 9, boundary: null });
    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs2 }, "oc-pull-2");
    await maybeIncrementalOpencode(t2.e, s);
    const body2 = JSON.parse(await (t2.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
    assert.equal(body2.sinceSeq, 0, "cold boundary declined — this turn plans against stale state");
    assert.equal(body2.resync, true, "one decline re-seeds (self-heal, #3369 circuit not tripped)");

    // an interleaved full-resend advanced the canonical: the boundary now
    // hashes a FOREIGN tail — mismatch must also be declined.
    lane.receipts.set("oc-pull-2", { appliedSeq: 4, boundary: incrementalWireHash({ role: "user", content: "foreign tail from a wire full-resend" }) });
    const msgs3 = [...msgs2, { role: "assistant", content: "again" }, { role: "user", content: "third" }];
    const t3 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs3 }, "oc-pull-2");
    await maybeIncrementalOpencode(t3.e, s);
    const body3 = JSON.parse(await (t3.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
    assert.equal(body3.resync, true, "foreign boundary declined — resync replaces the canonical wholesale");
    assert.equal(body3.sinceSeq, 0, "watermark never advanced on a declined receipt");

    // the resync landed; a matching receipt then carries the chain forward
    // (the stash from the resync turn is settled by the NEXT pull).
    lane.receipts.set("oc-pull-2", { appliedSeq: msgs3.length, boundary: incrementalWireHash(msgs3[msgs3.length - 1]) });
    const msgs4 = [...msgs3, { role: "user", content: "fourth" }];
    const t4 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs4 }, "oc-pull-2");
    await maybeIncrementalOpencode(t4.e, s);
    const body4 = JSON.parse(await (t4.e.request as Request).clone().json().then((j) => JSON.stringify(j))) as Record<string, unknown>;
    assert.equal(body4.sinceSeq, msgs3.length, "after the resync settled, the pull adopts and deltas ride");
    assert.equal((body4.messages as unknown[]).length, 1, "only the new message rides");
});

test("opencode incremental: #3352 pull reconcile — an unreachable lane skips incremental this turn and keeps the stash", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const s = state(lane.base);

    const msgs1 = [{ role: "user", content: "hello unreachable" }];
    const t1 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs1 }, "oc-pull-3");
    await maybeIncrementalOpencode(t1.e, s);

    // pull breaks (connection refused): the adapter must NOT convert this
    // turn on stale state — but it also keeps the stash so a later pull can
    // still settle the seed.
    const deadBase = "http://127.0.0.1:1"; // nothing listens on port 1
    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const t2 = fakeEvent({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs2 }, "oc-pull-3");
    await maybeIncrementalOpencode(t2.e, { proxyBase: deadBase } as unknown as V2State);
    const body2 = await (t2.e.request as Request).clone().json();
    assert.equal((body2 as Record<string, unknown>).conversationId, undefined, "no incremental payload when the pull cannot be verified");
    assert.deepEqual(body2, { model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs2 }, "full resend rides the host path byte-identically");
});

test("opencode incremental: #3352 V1 seam — beforeSend converts, stamps marker+turn-id, acks on the response seam", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const { maybeIncrementalOpencodeV1ForTest, __setOpencodeOriginForTests } = await import("../src/agent/opencode-native.ts");
    __setOpencodeOriginForTests(lane.base);
    const { incrementalWireHash } = await import("../src/agent/incremental-client.ts");

    // the V1 shape: an ordinary anthropic body on a model URL, the plugin
    // stamp (chat.headers) already on the init — the only conversation
    // identity the seam can bookkeep under.
    const msgs1 = [{ role: "user", content: "hello v1" }];
    const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "oc-v1-1" },
        body: JSON.stringify({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs1 }),
    };
    await maybeIncrementalOpencodeV1ForTest("https://api.anthropic.com/v1/messages", init);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.conversationId, "oc-v1-1", "seed payload swapped in place");
    assert.equal(body.sinceSeq, 0);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-bili-plugin-turn"), "1", "marker stamped on the same init (atomic, #3370)");
    const turnId = headers.get("x-bili-turn-id");
    assert.ok(turnId, "turn id stamped for response-seam attribution (#3329)");

    // V1 hosts DO have the response seam: the ack lands per turn id.
    opencodeIncrementalOnResponse("https://api.anthropic.com/v1/messages", new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), Object.fromEntries(headers));
    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const init2: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "oc-v1-1" },
        body: JSON.stringify({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs2 }),
    };
    await maybeIncrementalOpencodeV1ForTest("https://api.anthropic.com/v1/messages", init2);
    const body2 = JSON.parse(String(init2.body)) as Record<string, unknown>;
    assert.equal(body2.sinceSeq, 1, "V1 rides the response-seam ack");
    assert.equal((body2.messages as unknown[]).length, 2, "delta only");

    // a MISSED seam heals via the pull: stash turn 2, do not ack it, then
    // hand the lane a receipt matching turn 2's wire tail.
    lane.receipts.set("oc-v1-1", { appliedSeq: msgs2.length, boundary: incrementalWireHash(msgs2[msgs2.length - 1]) });
    const msgs3 = [...msgs2, { role: "user", content: "third" }];
    const init3: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "oc-v1-1" },
        body: JSON.stringify({ model: "claude-test", max_tokens: 512, system: "be terse", messages: msgs3 }),
    };
    await maybeIncrementalOpencodeV1ForTest("https://api.anthropic.com/v1/messages", init3);
    const body3 = JSON.parse(String(init3.body)) as Record<string, unknown>;
    assert.equal(body3.sinceSeq, msgs2.length, "pull receipt settled the missed seam — delta rides");
    assert.equal((body3.messages as unknown[]).length, 1, "only the new message");
});

test("opencode incremental: #3352 V1 seam — no plugin stamp (proxy mode) stays full resend", async () => {
    __resetIncrementalClientForTests();
    __resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    const { maybeIncrementalOpencodeV1ForTest, __setOpencodeOriginForTests } = await import("../src/agent/opencode-native.ts");
    __setOpencodeOriginForTests(lane.base);
    const original = { model: "claude-test", max_tokens: 512, messages: [{ role: "user", content: "no stamp" }] };
    const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(original) };
    await maybeIncrementalOpencodeV1ForTest("https://api.anthropic.com/v1/messages", init);
    assert.deepEqual(JSON.parse(String(init.body)), original, "no x-bili-plugin-conversation → no conversation identity → untouched");
    assert.equal(new Headers(init.headers).get("x-bili-plugin-turn"), null);
});
