// #3248 phase 2 — omp native incremental adapter. omp never emits header
// events, so the ONLY identity signal at the fetch layer is prompt_cache_key
// (stamped into the body by the omp extension). These suites drive the two
// exported seams (ompIncrementalBeforeSend / ompIncrementalOnResponse) with a
// fake lane origin pinned via _setOmpOriginForTest. #3329: ack calls pass the
// OUTGOING headers of the very request being acknowledged (the init.headers
// the plan stamped, exactly as native-intercept threads them into onResponse)
// — attribution is by the per-request turn id, never by URL.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.NODE_TEST_CONTEXT = "1";

const { ompIncrementalBeforeSend, ompIncrementalOnResponse, _setOmpOriginForTest, __resetOmpIncrementalForTests } = await import("../src/agent/omp-native.ts");
const { __resetIncrementalClientForTests } = await import("../src/agent/incremental-client.ts");

const MODEL_URL = "https://api.openai-anthropic.example/v1/messages";

async function fakeLane(enabled: boolean): Promise<{ base: string; close: () => Promise<void> }> {
    const srv = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/__bili/plugin/turn") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled, storage: enabled ? "unified" : "legacy-only" }));
            return;
        }
        res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function initOf(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** The outgoing headers of a planned init, normalized exactly like
 *  native-intercept's outgoingHeadersOf does (init.headers wins). */
function headersOf(h: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
}

const lanes: { close: () => Promise<void> }[] = [];
after(async () => {
    for (const l of lanes) await l.close();
    _setOmpOriginForTest(undefined);
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
});

test("omp incremental: prompt_cache_key becomes the conversation id; plugin headers + marker land on init; delta after ack", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);

    const msgs1 = [{ role: "user", content: "hello omp" }];
    const init = initOf({ model: "claude-test", max_tokens: 512, prompt_cache_key: "omp-inc-1", messages: msgs1 });
    await ompIncrementalBeforeSend(MODEL_URL, init);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.conversationId, "omp-inc-1", "prompt_cache_key rides as the conversation id");
    assert.equal(body.sinceSeq, 0);
    assert.equal((body.messages as unknown[]).length, 1);
    const headers = init.headers as Headers;
    assert.equal(headers.get("x-bili-plugin"), "omp");
    assert.equal(headers.get("x-bili-plugin-conversation"), "omp-inc-1");
    assert.equal(headers.get("x-bili-plugin-turn"), "1");
    assert.notEqual(headers.get("x-bili-turn-id"), null, "turn id stamped on the outgoing init (#3329)");

    ompIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "1" } }), headersOf(headers));

    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "next" }];
    const init2 = initOf({ model: "claude-test", max_tokens: 512, prompt_cache_key: "omp-inc-1", messages: msgs2 });
    await ompIncrementalBeforeSend(MODEL_URL, init2);
    const body2 = JSON.parse(String(init2.body)) as Record<string, unknown>;
    assert.equal(body2.sinceSeq, 1, "acked watermark rides");
    assert.equal((body2.messages as unknown[]).length, 2, "delta only");
});

test("omp incremental: no prompt_cache_key (plugin inactive) leaves the init untouched", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);
    const original = { model: "claude-test", max_tokens: 512, messages: [{ role: "user", content: "hi" }] };
    const init = initOf(original);
    await ompIncrementalBeforeSend(MODEL_URL, init);
    assert.deepEqual(JSON.parse(String(init.body)), original, "unstamped body = extension inactive = full resend");
    assert.deepEqual(init.headers, { "content-type": "application/json" }, "headers untouched when no plan lands");
});

test("omp incremental: probe disabled leaves the body untouched", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane(false);
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);
    const original = { model: "claude-test", max_tokens: 512, prompt_cache_key: "omp-inc-off", messages: [{ role: "user", content: "hi" }] };
    const init = initOf(original);
    await ompIncrementalBeforeSend(MODEL_URL, init);
    assert.deepEqual(JSON.parse(String(init.body)), original);
});

test("omp incremental: late response crossing the TTL attributes by turn id, never by URL (#3329)", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane(true);
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);
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
        const initA1 = initOf({ model: "claude-test", max_tokens: 512, system, prompt_cache_key: "omp-late-a", messages: a1msgs });
        await ompIncrementalBeforeSend(MODEL_URL, initA1);
        const aHeaders = headersOf(initA1.headers as Headers);
        assert.notEqual(aHeaders["x-bili-turn-id"], undefined, "turn id stamped on A's outgoing init");

        // A's round-trip outlives the pending TTL (slow non-streaming request)
        // — the sweep frees the URL slot, so B converts under the guard.
        t += 31_000;
        const initB1 = initOf({ model: "claude-test", max_tokens: 512, system, prompt_cache_key: "omp-late-b", messages: b1msgs });
        await ompIncrementalBeforeSend(MODEL_URL, initB1);
        const bHeaders = headersOf(initB1.headers as Headers);
        assert.notEqual(bHeaders["x-bili-turn-id"], undefined, "turn id stamped on B's outgoing init");
        assert.notEqual(bHeaders["x-bili-turn-id"], aHeaders["x-bili-turn-id"], "each dispatch carries its own correlation id");
        const b1Body = JSON.parse(String(initB1.body)) as Record<string, unknown>;
        assert.equal(b1Body.sinceSeq, 0, "B's first turn seeds (not credited with anything yet)");
        assert.equal(b1Body.resync, true, "B's first turn seeds");
        assert.equal(b1Body.system, system, "seed carries B's own system — no taint from A");

        // A's LATE response lands after B planned on the same URL. The old
        // URL-keyed table credited this ack to B; now A's entry was swept and
        // the response carries no live turn id — it cannot touch either state
        // machine except through its own (expired) id.
        ompIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "42" } }), aHeaders);

        // B's OWN response then credits exactly B — and the delta it plans
        // rides watermark 7, never 42: if A's late ack had been attributed to
        // B (the URL-keyed bug), this sinceSeq would read 42.
        ompIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "7" } }), bHeaders);
        const b2msgs = [...b1msgs, { role: "assistant", content: "b1r" }, { role: "user", content: "b2" }];
        const initB2 = initOf({ model: "claude-test", max_tokens: 512, system, prompt_cache_key: "omp-late-b", messages: b2msgs });
        await ompIncrementalBeforeSend(MODEL_URL, initB2);
        const b2Body = JSON.parse(String(initB2.body)) as Record<string, unknown>;
        assert.equal(b2Body.sinceSeq, 7, "B was never credited with A's ack (42) — it rides its own (7)");
        assert.equal((b2Body.messages as unknown[]).length, 2, "delta only — B's own watermark carries");

        // B's chain keeps riding its own acks: ack b2 FIRST — the #3378
        // single-flight guard holds the URL slot until b2's ack lands.
        ompIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "9" } }), headersOf(initB2.headers as Headers));

        // A's expired turn is an honest loss: A reseeds instead of riding a
        // watermark it never actually received (b2's pending was consumed by
        // its own ack above, so the URL slot is free again).
        const a2msgs = [...a1msgs, { role: "assistant", content: "a1r" }, { role: "user", content: "a2" }];
        const initA2 = initOf({ model: "claude-test", max_tokens: 512, system, prompt_cache_key: "omp-late-a", messages: a2msgs });
        await ompIncrementalBeforeSend(MODEL_URL, initA2);
        const a2Body = JSON.parse(String(initA2.body)) as Record<string, unknown>;
        assert.equal(a2Body.sinceSeq, 0, "A's expired entry was swept — honest reseed");
        assert.equal(a2Body.resync, true, "A reseeds wholesale, not on a watermark it never saw");

        // A's reseed acks on ITS OWN turn id (a1's expired id stays dead);
        // B's next delta is then free to convert under the guard.
        ompIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "11" } }), headersOf(initA2.headers as Headers));
        const b3msgs = [...b2msgs, { role: "assistant", content: "b2r" }, { role: "user", content: "b3" }];
        const initB3 = initOf({ model: "claude-test", max_tokens: 512, system, prompt_cache_key: "omp-late-b", messages: b3msgs });
        await ompIncrementalBeforeSend(MODEL_URL, initB3);
        const b3Body = JSON.parse(String(initB3.body)) as { sinceSeq: number };
        assert.equal(b3Body.sinceSeq, 9, "B rides its own watermark");
    } finally {
        Date.now = realNow;
    }
});
