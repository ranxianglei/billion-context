import test from "node:test";
import assert from "node:assert/strict";
import { ResponsesWsHistory } from "../src/responses-ws.ts";

type Item = Record<string, unknown>;

function chainedHistory(turns: number): { history: ResponsesWsHistory; expected: Item[] } {
    const history = new ResponsesWsHistory();
    const expected: Item[] = [];
    let priorOutput: Item[] = [];
    for (let i = 0; i < turns; i++) {
        const tail = [{ type: "message", role: "user", content: `question-${i}` }];
        const output = i % 3 === 0 ? [] : [{ type: "message", role: "assistant", content: `answer-${i}` }];
        history.commit(
            { model: `model-${i}`, input: [...priorOutput, ...tail], generate: false },
            { id: `response-${i}`, status: "completed", output },
            i === 0 ? undefined : { continuedId: `response-${i - 1}`, tail },
        );
        expected.push(...tail, ...output);
        priorOutput = output;
    }
    return { history, expected };
}

test("checkpoint expansion visits history items linearly and preserves exact order", () => {
    const turns = 256;
    const { history, expected } = chainedHistory(turns);
    const next = { type: "message", role: "user", content: "continue" };
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
    const original = Array.prototype[Symbol.iterator];
    let visits = 0;
    let expanded: Item;
    Object.defineProperty(Array.prototype, Symbol.iterator, {
        ...descriptor,
        value: function* (this: unknown[]): Generator<unknown> {
            const iterator = original.call(this);
            for (;;) {
                const step = iterator.next();
                if (step.done) return;
                visits++;
                yield step.value;
            }
        },
    });
    try {
        expanded = history.expand({ type: "response.create", previous_response_id: `response-${turns - 1}`, input: [next] });
    } finally {
        Object.defineProperty(Array.prototype, Symbol.iterator, descriptor);
    }
    assert.deepEqual(expanded, { model: `model-${turns - 1}`, input: [...expected, next] });
    assert.ok(visits <= 8 * (expected.length + turns), `visited ${visits} array elements for ${expected.length} history items`);
});

test("long chained fallback preserves fields, output gaps and explicit per-turn actions", () => {
    const { history, expected } = chainedHistory(2_048);
    const expanded = history.expand({ type: "response.create", previous_response_id: "response-2047", input: "next", model: "override", generate: false });
    assert.deepEqual(expanded, {
        model: "override", generate: false,
        input: [...expected, { type: "message", role: "user", content: "next" }],
    });
    assert.throws(() => history.expand({ type: "response.create", previous_response_id: "unknown", input: [] }), /previous_response_not_found/);
});

test("a full replay rebaselines a checkpoint chain without mutating retained arrays", () => {
    const { history } = chainedHistory(16);
    const input = Object.freeze([{ type: "message", role: "user", content: "new branch" }]);
    const output = Object.freeze([{ type: "message", role: "assistant", content: "new answer" }]);
    history.commit({ model: "new", input }, { id: "rebase", status: "completed", output });
    const expanded = history.expand({ type: "response.create", previous_response_id: "rebase", input: [] });
    assert.deepEqual(expanded, { model: "new", input: [...input, ...output] });
    assert.equal(input.length, 1);
    assert.equal(output.length, 1);
    assert.equal(history.current()?.base, undefined);
});

test("a single large checkpoint does not exceed a function argument limit", () => {
    const history = new ResponsesWsHistory();
    const input = Array.from({ length: 150_000 }, (_, i) => ({ type: "message", role: "user", content: String(i) }));
    history.commit({ model: "m", input }, { id: "large", status: "completed", output: [] });
    const expanded = history.expand({ type: "response.create", previous_response_id: "large", input: [] });
    assert.deepEqual(expanded.input, input);
    assert.notEqual(expanded.input, input);
});
