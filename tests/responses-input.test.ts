import { test } from "node:test";
import assert from "node:assert/strict";
import { planResponsesInput, responsesAckMatches, ResponsesInputHistory } from "../src/responses-input.ts";

const user = { role: "user", content: [{ type: "input_text", text: "hello β\n" }] };
const opaque = { type: "reasoning", id: "rs_synthetic", summary: [], encrypted_content: "OPAQUE/β==\n" };
const call = { type: "function_call", call_id: "call_synthetic", name: "read", arguments: '{"path":"β","limit":2}' };
const output = { type: "function_call_output", call_id: "call_synthetic", output: "exact result β\n" };

test("Responses input seed and acknowledged suffix reconstruct exact opaque ordered items", () => {
    const history = new ResponsesInputHistory();
    const first = planResponsesInput("synthetic", "/route/responses", { model: "gpt-fixture", input: [user], instructions: "first" });
    assert.ok(first);
    const initial = history.prepare("route:synthetic", JSON.parse(first.body));
    initial.commit();
    assert.deepEqual(JSON.parse(initial.body.toString()), { model: "gpt-fixture", instructions: "first", input: [user] });
    assert.ok(responsesAckMatches(first.snapshot, "1"));
    for (const bad of [null, "0", "2", "01", "1x", "9007199254740993"]) {
        assert.equal(responsesAckMatches(first.snapshot, bad), false);
    }
    const next = planResponsesInput("synthetic", "/route/responses", { model: "gpt-fixture", instructions: "current", input: [user, opaque, call, output] }, first.snapshot);
    assert.ok(next);
    assert.deepEqual(JSON.parse(next.body).messages, [opaque, call, output]);
    const expanded = history.prepare("route:synthetic", JSON.parse(next.body));
    assert.equal(expanded.appliedSeq, 4);
    assert.deepEqual(JSON.parse(expanded.body.toString()), { model: "gpt-fixture", instructions: "current", input: [user, opaque, call, output] });
});

test("Responses route, edited prefix, unsupported input and upstream continuation cannot borrow a cursor", () => {
    const seed = planResponsesInput("s", "route-a", { model: "gpt", input: [user, opaque] });
    assert.ok(seed);
    for (const [route, input] of [["route-b", [user, opaque]], ["route-a", [user]], ["route-a", [{ ...user, role: "developer" }, opaque]]] as const) {
        const plan = planResponsesInput("s", route, { model: "gpt", input }, seed.snapshot);
        assert.ok(plan);
        assert.equal(JSON.parse(plan.body).resync, true);
        assert.equal(JSON.parse(plan.body).sinceSeq, 0);
    }
    for (const request of [{ model: "gpt", input: "string input" }, { model: "gpt", input: [user], previous_response_id: "resp_existing" }]) {
        assert.equal(planResponsesInput("s", "route-a", request), null);
    }
});

test("Responses refusal does not change prefix; cold and bounded eviction require reseed", () => {
    const history = new ResponsesInputHistory(4096, 1);
    const seed = { sinceSeq: 0, resync: true, request: { model: "gpt" }, messages: [user] };
    history.prepare("a", seed).commit();
    for (const invalid of [
        { ...seed, sinceSeq: 1 },
        { sinceSeq: 2, request: { model: "gpt" }, messages: [opaque] },
        { sinceSeq: 1, request: { model: "gpt", input: [user] }, messages: [opaque] },
        { sinceSeq: 1, request: { model: "gpt" }, messages: [null] },
    ]) {
        assert.throws(() => history.prepare("a", invalid));
    }
    const next = { sinceSeq: 1, request: { model: "gpt" }, messages: [opaque] };
    assert.deepEqual(JSON.parse(history.prepare("a", next).body.toString()).input, [user, opaque]);
    history.prepare("b", seed).commit();
    assert.throws(() => history.prepare("a", next), /prefix unavailable/);
    history.clear();
    assert.throws(() => history.prepare("b", next), /prefix unavailable/);
});
