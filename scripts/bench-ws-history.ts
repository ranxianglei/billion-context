import assert from "node:assert/strict";
import { ResponsesWsHistory } from "../src/responses-ws.ts";

const turns = 6_000;
const history = new ResponsesWsHistory();
const expected: unknown[] = [];
for (let i = 0; i < turns; i++) {
    const tail = [{ type: "message", role: "user", content: `question-${i}` }];
    const output = [{ type: "message", role: "assistant", content: `answer-${i}` }];
    expected.push(...tail, ...output);
    history.commit({ model: "m", input: tail }, { id: `r${i}`, status: "completed", output },
        i === 0 ? undefined : { continuedId: `r${i - 1}`, tail });
}
const frame = { type: "response.create", previous_response_id: `r${turns - 1}`, input: [] };
assert.deepEqual(history.expand(frame).input, expected);
const milliseconds: number[] = [];
for (let sample = 0; sample < 7; sample++) {
    const start = process.hrtime.bigint();
    const expanded = history.expand(frame);
    milliseconds.push(Number(process.hrtime.bigint() - start) / 1e6);
    assert.deepEqual(expanded.input, expected);
}
console.log(JSON.stringify({
    turns, outputItems: expected.length, milliseconds,
    medianMs: [...milliseconds].sort((a, b) => a - b)[3],
    exactOrderChecked: true,
}, null, 2));
