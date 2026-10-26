import { test } from "node:test";
import assert from "node:assert/strict";
import { hoistTrappedToolItems } from "../src/tool-pair-order.ts";

const fc = (id: string) => ({ type: "function_call", call_id: id });
const fo = (id: string) => ({ type: "function_call_output", call_id: id });
const ct = (id: string) => ({ type: "custom_tool_call", call_id: id });
const cto = (id: string) => ({ type: "custom_tool_call_output", call_id: id });
const msg = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const reason = () => ({ type: "reasoning" });

type Item = { type: string; role?: string; content?: unknown[] | string; call_id?: string };

// Invariant the fix guarantees: no non-tool item sits strictly between a
// function_call/custom_tool_call and its matching output.
function assertNoTrap(items: Item[]): void {
    const callPos = new Map<string, number>();
    const outPos = new Map<string, number>();
    items.forEach((it, i) => {
        if (it.type === "function_call" || it.type === "custom_tool_call") {
            if (!callPos.has(it.call_id!)) callPos.set(it.call_id!, i);
        } else if (it.type === "function_call_output" || it.type === "custom_tool_call_output") {
            if (!outPos.has(it.call_id!)) outPos.set(it.call_id!, i);
        }
    });
    for (let p = 0; p < items.length; p++) {
        const t = items[p].type;
        if (t === "function_call" || t === "custom_tool_call" || t === "function_call_output" || t === "custom_tool_call_output") continue;
        for (const [id, c] of callPos) {
            const o = outPos.get(id);
            assert.ok(!(o !== undefined && c < p && o > p), `non-tool item at ${p} trapped between call@${c} and output@${o} (${id})`);
        }
    }
}

const types = (items: Item[]) => items.map((i) => i.type);

test("#766 exact pattern: assistant marker wedged between call and output is hoisted before the call", () => {
    const input: Item[] = [fc("call_1"), msg("\n📊 [ACP] acp_status result:\n..."), fo("call_1")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["message", "function_call", "function_call_output"]);
    assert.equal(out[0].call_id, undefined);
    assert.equal(out[1].call_id, "call_1");
    assert.equal(out[2].call_id, "call_1");
    assertNoTrap(out);
});

test("parallel calls: item after all calls but before outputs is hoisted before the first call", () => {
    const input: Item[] = [fc("a"), fc("b"), msg("marker"), fo("a"), fo("b")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["message", "function_call", "function_call", "function_call_output", "function_call_output"]);
    assertNoTrap(out);
});

test("item between two completed exchanges is NOT trapped (left in place)", () => {
    const input: Item[] = [fc("a"), fo("a"), msg("between turns"), fc("b"), fo("b")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["function_call", "function_call_output", "message", "function_call", "function_call_output"]);
    assertNoTrap(out);
});

test("reasoning item wedged between call and output is hoisted", () => {
    const input: Item[] = [fc("x"), reason(), fo("x")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["reasoning", "function_call", "function_call_output"]);
    assertNoTrap(out);
});

test("custom_tool_call variant is handled identically", () => {
    const input: Item[] = [ct("c1"), msg("m"), cto("c1")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["message", "custom_tool_call", "custom_tool_call_output"]);
    assertNoTrap(out);
});

test("item after the trailing output is not trapped", () => {
    const input: Item[] = [fc("z"), fo("z"), msg("after")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["function_call", "function_call_output", "message"]);
    assertNoTrap(out);
});

test("orphan call (no output) does not trap a following item", () => {
    const input: Item[] = [fc("orphan"), msg("m"), fc("real"), fo("real")];
    const out = hoistTrappedToolItems(input);
    // "m" has no matching-output call before it that also has an output after → stays put.
    assert.deepEqual(types(out), ["function_call", "message", "function_call", "function_call_output"]);
    assertNoTrap(out);
});

test("multiple trapped items keep relative order when hoisted to the same target", () => {
    const input: Item[] = [fc("a"), msg("m1"), reason(), fc("b"), fo("a"), fo("b")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["message", "reasoning", "function_call", "function_call", "function_call_output", "function_call_output"]);
    assertNoTrap(out);
});

test("healthy input is a no-op returning the same array reference (prefix-cache byte-stable)", () => {
    const input: Item[] = [{ type: "system", content: "s" } as Item, { type: "user", content: "u" } as Item, fc("q"), fo("q"), { type: "assistant", content: "a" } as Item];
    const out = hoistTrappedToolItems(input);
    assert.strictEqual(out, input);
});

test("short arrays are returned unchanged", () => {
    assert.deepEqual(hoistTrappedToolItems([]), []);
    assert.deepEqual(hoistTrappedToolItems([msg("only")]), [msg("only")]);
    assert.deepEqual(hoistTrappedToolItems([fc("a"), fo("a")]), [fc("a"), fo("a")]);
});
