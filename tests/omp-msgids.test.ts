// #4491 omp host wiring for plugin-lane msgids: omp's session branch carries
// stable entry ids (randomUUID tail), and the incremental lane can pin them as
// server-side message identity. The wiring is two halves — the extension
// event (pi.ts omp branch of before_provider_request) snapshots
// ompBranchMsgIdEntries(sid) into noteHostMsgIdHint, and the fetch-layer
// planner (omp-native ompIncrementalBeforeSend) aligns that hint against the
// ACTUALLY-sent messages (count + role, pairwise) and passes the ids into
// planIncrementalTurn, which splices `msgIds` parallel to the messages the
// mode sends. All-or-nothing: any misalignment drops the WHOLE field (the
// lane hard-400s poisoned ids and a misaligned id would pin the wrong
// identity), so every degrade path here asserts the field is ABSENT, never
// partial. Harness mirrors tests/omp-native-incremental.test.ts (fake lane
// origin + the two exported seams); every converting round is acked because
// the #3378 single-flight guard holds the URL slot until its ack lands.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.NODE_TEST_CONTEXT = "1";

const { ompIncrementalBeforeSend, ompIncrementalOnResponse, _setOmpOriginForTest, __resetOmpIncrementalForTests } = await import("../src/agent/omp-native.ts");
const { __resetIncrementalClientForTests, noteHostMsgIdHint, noteIncrementalAck, planIncrementalTurn } = await import("../src/agent/incremental-client.ts");
const { ompBranchMsgIdEntries } = await import("../src/agent/pi.ts");

const MODEL_URL = "https://api.openai-anthropic.example/v1/messages";

type CtxShape = Parameters<typeof ompBranchMsgIdEntries>[0];

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

function initOf(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function headersOf(h: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
}

/** omp branch entry shapes (pi-family session tree): message entries carry a
 *  stable id; model_change / native-compaction entries ride alongside without
 *  one (the compaction summary references firstKeptEntryId instead). */
const msgEntry = (id: string, role: "user" | "assistant", text: string) => ({ type: "message", id, message: { role, content: [{ type: "text", text }] }, timestamp: "2026-10-24T00:00:00.000Z" });
const wire = (role: "user" | "assistant", text: string) => ({ role, content: text });

/** Drive the exact stash the omp extension performs per model request: the
 *  (id, role) extraction from the live branch, keyed by the session id the
 *  prompt_cache_key will carry. */
function stashHint(sid: string, branch: unknown[]): void {
    const ctx = { sessionManager: { getSessionId: () => sid, getBranch: () => branch } } as CtxShape;
    noteHostMsgIdHint(sid, ompBranchMsgIdEntries(ctx));
}

/** Convert one outgoing request through the fetch-layer seam; `ack` settles
 *  the round so the next conversion on this URL is not single-flight held. */
async function convert(sid: string, messages: unknown[]): Promise<{ body: Record<string, unknown>; ack: (appliedSeq: number) => void }> {
    const init = initOf({ model: "claude-test", max_tokens: 512, prompt_cache_key: sid, messages });
    await ompIncrementalBeforeSend(MODEL_URL, init);
    const headers = init.headers as Headers;
    const normalized = headersOf(headers);
    return {
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        ack: (appliedSeq: number) => {
            ompIncrementalOnResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": String(appliedSeq) } }), normalized);
        },
    };
}

const lanes: { close: () => Promise<void> }[] = [];
after(async () => {
    for (const l of lanes) await l.close();
    _setOmpOriginForTest(undefined);
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
});

// ── ① aligned ids ride the seed and the delta, parallel to the sent set ──

test("omp msgids: a 1:1-aligned branch carries msgIds on the seed turn and the delta suffix", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);
    const sid = "omp-msgids-1";

    // Seed: branch [u1, a1, u2] ↔ wire [u1, a1, u2] — ids ride in order.
    const seedBranch = [msgEntry("e1a2b3c4", "user", "hello"), msgEntry("e5f6a7b8", "assistant", "hi there"), msgEntry("e9c0d1e2", "user", "continue")];
    const seedWire = [wire("user", "hello"), wire("assistant", "hi there"), wire("user", "continue")];
    stashHint(sid, seedBranch);
    const seed = await convert(sid, seedWire);
    assert.equal(seed.body.conversationId, sid);
    assert.equal(seed.body.resync, true, "first turn seeds");
    assert.deepEqual(seed.body.msgIds, ["e1a2b3c4", "e5f6a7b8", "e9c0d1e2"], "seed msgIds = full id sequence in message order");
    seed.ack(3);

    // Delta: branch grew by [a2, u3] — only the suffix ids ride, parallel to
    // the delta messages the envelope actually sends.
    const deltaBranch = [...seedBranch, msgEntry("f0e1d2c3", "assistant", "answer two"), msgEntry("f4b5a6d7", "user", "next question")];
    const deltaWire = [...seedWire, wire("assistant", "answer two"), wire("user", "next question")];
    stashHint(sid, deltaBranch);
    const delta = await convert(sid, deltaWire);
    assert.equal(delta.body.sinceSeq, 3, "acked watermark rides");
    assert.equal((delta.body.messages as unknown[]).length, 2, "delta sends only the suffix");
    assert.deepEqual(delta.body.msgIds, ["f0e1d2c3", "f4b5a6d7"], "delta msgIds = the suffix ids, aligned with the delta messages");
});

// ── ② any id-less entry drops the WHOLE field (all-or-nothing) ──

test("omp msgids: an entry without a stable id drops the whole field", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);
    const sid = "omp-msgids-noid";

    stashHint(sid, [msgEntry("e1a2b3c4", "user", "hello"), msgEntry("", "assistant", "legacy entry without id")]);
    const round = await convert(sid, [wire("user", "hello"), wire("assistant", "legacy entry without id")]);
    assert.equal(round.body.resync, true, "the turn itself still converts");
    assert.equal("msgIds" in round.body, false, "no id for one entry ⇒ no field at all, never a partial array");
});

test("omp msgids: a native-compaction summary (no message id) drops the whole field", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);
    const sid = "omp-msgids-compaction";

    // omp native compaction: the branch keeps [compaction(summary +
    // firstKeptEntryId), kept message] while the wire sends [summary-as-user,
    // kept message] — the summary has no message id, so the counts diverge
    // and the field must vanish.
    stashHint(sid, [
        { type: "compaction", id: "cx1", compaction: { firstKeptEntryId: "e2", summary: "earlier turns summarized" } },
        msgEntry("e2", "user", "kept turn"),
    ]);
    const round = await convert(sid, [wire("user", "Summary of earlier turns:\nearlier turns summarized"), wire("user", "kept turn")]);
    assert.equal(round.body.resync, true);
    assert.equal("msgIds" in round.body, false, "summary entry has no id ⇒ alignment impossible ⇒ no field");
});

// ── ③ rewind: the carried ids follow the SURVIVING messages ──

test("omp msgids: after a rewind the resync carries exactly the surviving id sequence", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);
    const sid = "omp-msgids-rewind";

    const fullBranch = [msgEntry("r1", "user", "one"), msgEntry("r2", "assistant", "two"), msgEntry("r3", "user", "three")];
    const fullWire = [wire("user", "one"), wire("assistant", "two"), wire("user", "three")];
    stashHint(sid, fullBranch);
    const seeded = await convert(sid, fullWire);
    seeded.ack(3);

    // Rewind (leaf re-point) drops the last entry: branch and wire both
    // shrink to the surviving path — the plan resyncs (prefix no longer
    // matches the acked set) and the ids align with what is actually sent.
    const keptBranch = fullBranch.slice(0, 2);
    const keptWire = fullWire.slice(0, 2);
    stashHint(sid, keptBranch);
    const resync = await convert(sid, keptWire);
    assert.equal(resync.body.resync, true, "shrunk history resyncs wholesale");
    assert.equal((resync.body.messages as unknown[]).length, 2);
    assert.deepEqual(resync.body.msgIds, ["r1", "r2"], "rewind carries the SURVIVING ids, aligned with the sent messages");
    resync.ack(2);

    // The next append after the rewind rides a delta whose id is the fresh
    // branch entry — never the rewound-away one.
    stashHint(sid, [...keptBranch, msgEntry("r4", "user", "three (edited)")]);
    const post = await convert(sid, [...keptWire, wire("user", "three (edited)")]);
    assert.equal((post.body.messages as unknown[]).length, 1, "delta after the rewind's ack");
    assert.deepEqual(post.body.msgIds, ["r4"], "post-rewind delta carries the fresh entry's id");
});

// ── gate matrix: the degrade direction (#3617 both-ways discipline) ──

test("omp msgids: extraction skips non-message entries; shape mismatches degrade to no field", async () => {
    __resetIncrementalClientForTests();
    __resetOmpIncrementalForTests();
    const lane = await fakeLane();
    lanes.push(lane);
    _setOmpOriginForTest(lane.base);

    // model_change entries ride the branch but have no message slot — the
    // extractor skips them and the alignment still carries.
    const sid = "omp-msgids-modelchange";
    stashHint(sid, [
        msgEntry("m1", "user", "hello"),
        { type: "model_change", id: "mc1", from: "model-a", to: "model-b" },
        msgEntry("m2", "assistant", "hi"),
    ]);
    const body = await convert(sid, [wire("user", "hello"), wire("assistant", "hi")]);
    assert.deepEqual(body.body.msgIds, ["m1", "m2"], "model_change entries are transparent to the alignment");
    body.ack(2);

    // Role mismatch between branch and wire (aux/persona divergence) ⇒ no field.
    const sid2 = "omp-msgids-roles";
    stashHint(sid2, [msgEntry("p1", "user", "hello"), msgEntry("p2", "assistant", "hi")]);
    const body2 = await convert(sid2, [wire("user", "hello"), wire("user", "hi")]);
    assert.equal("msgIds" in body2.body, false, "role divergence ⇒ provably not parallel ⇒ no field");
    body2.ack(2);

    // No hint at all (host without getBranch stashes nothing; a stale hint
    // ages out) ⇒ no field, conversion itself unaffected.
    const body3 = await convert("omp-msgids-nohint", [wire("user", "hello")]);
    assert.equal(body3.body.resync, true);
    assert.equal("msgIds" in body3.body, false, "no hint ⇒ no field — the turn still converts");
    body3.ack(1);

    // Length mismatch (branch out of sync with the sent history) ⇒ no field.
    const sid4 = "omp-msgids-len";
    stashHint(sid4, [msgEntry("l1", "user", "hello")]);
    const body4 = await convert(sid4, [wire("user", "hello"), wire("user", "extra")]);
    assert.equal("msgIds" in body4.body, false, "count divergence ⇒ no field");

    // getBranch throwing ⇒ the extractor yields [] ⇒ no field (never a stale hint).
    const ctxThrow = { sessionManager: { getSessionId: () => "omp-msgids-throw", getBranch: () => { throw new Error("boom"); } } } as CtxShape;
    assert.deepEqual(ompBranchMsgIdEntries(ctxThrow), [], "throwing getBranch degrades to an empty hint");
    assert.deepEqual(ompBranchMsgIdEntries({} as CtxShape), [], "missing sessionManager degrades to an empty hint");
});

// ── claim gate: the client-side mirror of the lane's reuse-400 ──

test("omp msgids: a re-planned delta never re-claims ids the lane may already hold", () => {
    __resetIncrementalClientForTests();
    const sid = "omp-msgids-claim";
    const seedMsgs = [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }];
    const seed = planIncrementalTurn({ conversationId: sid, messages: seedMsgs, system: undefined, msgIds: ["c1", "c2"] });
    assert.deepEqual(JSON.parse((seed as { body: string }).body).msgIds, ["c1", "c2"], "seed carries the ids");
    noteIncrementalAck(sid, 2, seedMsgs, undefined);

    // First delta plan carries the fresh ids…
    const deltaMsgs = [...seedMsgs, { role: "user", content: "q2" }];
    const first = planIncrementalTurn({ conversationId: sid, messages: deltaMsgs, system: undefined, msgIds: ["c1", "c2", "c3"] });
    assert.deepEqual(JSON.parse((first as { body: string }).body).msgIds, ["c3"], "delta carries only the suffix id");

    // …a re-plan of the SAME delta without an intervening ack (host retry
    // whose first attempt may have landed server-side) drops them: re-sending
    // c3 would trip the lane's "msgIds reuse an existing canonical id" 400.
    const retry = planIncrementalTurn({ conversationId: sid, messages: deltaMsgs, system: undefined, msgIds: ["c1", "c2", "c3"] });
    assert.equal("msgIds" in JSON.parse((retry as { body: string }).body), false, "re-planned delta drops the claimed ids — the turn still lands on derived ids");

    // A resync re-claims wholesale (the lane replaces the canonical on
    // resync:true), so the same ids may ride a resync again.
    const resync = planIncrementalTurn({ conversationId: sid, messages: deltaMsgs, system: undefined, msgIds: ["c1", "c2", "c3"] }, true);
    assert.deepEqual(JSON.parse((resync as { body: string }).body).msgIds, ["c1", "c2", "c3"], "resync replaces the claim set wholesale");
});
