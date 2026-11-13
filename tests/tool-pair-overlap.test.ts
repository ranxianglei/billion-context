import assert from "node:assert/strict";
import { test } from "node:test";
import { hoistTrappedToolItems } from "../src/tool-pair-order.ts";

const call = (id: string) => ({ type: "function_call", call_id: id });
const output = (id: string) => ({ type: "function_call_output", call_id: id });
const message = (id: string) => ({ type: "message", id });

test("crossing tool pairs hoist all intervening messages before the complete call group", () => {
    const a = call("a"), b = call("b"), ao = output("a"), bo = output("b");
    const first = message("first"), second = message("second");
    const result = hoistTrappedToolItems([a, b, first, ao, second, bo]);
    assert.deepEqual(result, [first, second, a, b, ao, bo]);
});

test("overlap propagation spans three pairs without moving a later completed exchange", () => {
    const a = call("a"), b = call("b"), c = call("c"), d = call("d");
    const ao = output("a"), bo = output("b"), co = output("c"), od = output("d");
    const first = message("first"), second = message("second"), between = message("between");
    const result = hoistTrappedToolItems([a, b, ao, first, c, bo, second, co, between, d, od]);
    assert.deepEqual(result, [first, second, a, b, ao, c, bo, co, between, d, od]);
});

test("nested pairs preserve original non-tool order", () => {
    const a = call("a"), b = call("b"), ao = output("a"), bo = output("b");
    const first = message("first"), second = message("second");
    assert.deepEqual(hoistTrappedToolItems([a, first, b, second, bo, ao]), [first, second, a, b, bo, ao]);
});

test("a large trapped batch does not overflow the function argument stack", () => {
    const a = call("a"), ao = output("a");
    const messages = Array.from({ length: 150_000 }, (_, i) => message(String(i)));
    const input: Array<{ type: string; call_id?: string; id?: string }> = [a];
    for (const item of messages) input.push(item);
    input.push(ao);
    const result = hoistTrappedToolItems(input);
    assert.equal(result.length, input.length);
    for (let i = 0; i < messages.length; i++) assert.equal(result[i], messages[i]);
    assert.equal(result.at(-2), a);
    assert.equal(result.at(-1), ao);
});

test("long healthy histories preserve the original array and item identities", () => {
    const input: Array<{ type: string; call_id?: string; id?: string }> = [];
    for (let i = 0; i < 5_000; i++) input.push(call(String(i)), output(String(i)), message(String(i)));
    assert.equal(hoistTrappedToolItems(input), input);
});
