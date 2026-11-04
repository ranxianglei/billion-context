import { test } from "node:test";
import assert from "node:assert/strict";
import { completeOrphanToolCalls, dropOrphanToolOutputs, hoistTrappedToolItems } from "../src/tool-pair-order.ts";

const fc = (id: string) => ({ type: "function_call", call_id: id });
const fo = (id: string) => ({ type: "function_call_output", call_id: id });
const ct = (id: string) => ({ type: "custom_tool_call", call_id: id });
const cto = (id: string) => ({ type: "custom_tool_call_output", call_id: id });
const tsc = (id: string) => ({ type: "tool_search_call", call_id: id });
const tso = (id: string) => ({ type: "tool_search_output", call_id: id });
const msg = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const reason = () => ({ type: "reasoning" });

type Item = { type: string; role?: string; content?: unknown[] | string; call_id?: string };

const CALL_T = new Set(["function_call", "custom_tool_call", "tool_search_call"]);
const OUT_T = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);

// Invariant the fix guarantees: no non-tool item sits strictly between a
// call and its matching output (all registered pair families, #5670 included).
function assertNoTrap(items: Item[]): void {
    const callPos = new Map<string, number>();
    const outPos = new Map<string, number>();
    items.forEach((it, i) => {
        if (CALL_T.has(it.type)) {
            if (!callPos.has(it.call_id!)) callPos.set(it.call_id!, i);
        } else if (OUT_T.has(it.type)) {
            if (!outPos.has(it.call_id!)) outPos.set(it.call_id!, i);
        }
    });
    for (let p = 0; p < items.length; p++) {
        const t = items[p].type;
        if (CALL_T.has(t) || OUT_T.has(t)) continue;
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

test("#5670 I1: mid-history call without output gets a synthesized completion; following item stays put", () => {
    const input: Item[] = [fc("orphan"), msg("m"), fc("real"), fo("real")];
    const out = hoistTrappedToolItems(input);
    // "orphan" sits before the trailing run with no surviving output → completed in place;
    // "m" is not trapped (the completed pair closes before it) and keeps its position.
    assert.deepEqual(types(out), ["function_call", "function_call_output", "message", "function_call", "function_call_output"]);
    assert.equal((out[1] as unknown as { output?: string }).output, "tool output lost during context compression");
    assert.equal(out[1].call_id, "orphan");
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

test("#5670 pair registration: reasoning wedged between tool_search_call and tool_search_output is hoisted", () => {
    const input: Item[] = [tsc("search_1"), reason(), tso("search_1")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["reasoning", "tool_search_call", "tool_search_output"]);
    assertNoTrap(out);
});

test("#5670 fail-closed: orphan tool_search_output (call dropped by compression) is removed, rest untouched", () => {
    const input: Item[] = [fc("a"), fo("a"), tso("call_00_D0V8XQjbPiJOdAcTcAX38458"), msg("after")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["function_call", "function_call_output", "message"]);
    assertNoTrap(out);
});

test("#5670 fail-closed: orphan function_call_output is dropped identically", () => {
    const input: Item[] = [fc("keep"), fo("keep"), fo("dead")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["function_call", "function_call_output"]);
});

test("#5670 negative: orphan CALLS are kept (an in-flight turn's call has no output yet)", () => {
    const input: Item[] = [fc("a"), fo("a"), fc("pending")];
    const out = hoistTrappedToolItems(input);
    assert.strictEqual(out, input);
});

test("#5670 negative: output with missing call_id is kept (unjudgeable — dropping would lose data)", () => {
    const bare = { type: "function_call_output" } as Item;
    const input: Item[] = [fc("a"), fo("a"), bare];
    const out = hoistTrappedToolItems(input);
    assert.strictEqual(out, input);
    assert.equal(out.length, 3);
});

test("#5670 negative: healthy input containing tool_search pairs returns the same array reference (byte-stable)", () => {
    const input: Item[] = [tsc("s1"), tso("s1"), msg("m"), fc("f"), fo("f")];
    const out = hoistTrappedToolItems(input);
    assert.strictEqual(out, input);
});

test("#5670 evidence-based: interleaved parallel groups are left alone (DeepSeek accepts them — issue payloads 2-4 all 200)", () => {
    const input: Item[] = [fc("a"), fc("b"), fo("a"), fo("b")];
    const out = hoistTrappedToolItems(input);
    assert.strictEqual(out, input);
});

test("#5670 short-array path still drops a lone orphan output", () => {
    assert.deepEqual(dropOrphanToolOutputs([tso("x")]), []);
    assert.deepEqual(hoistTrappedToolItems([tso("x")]), []);
});

test("dropOrphanToolOutputs: multiple orphans all dropped, paired items survive", () => {
    const input: Item[] = [ct("c1"), cto("c1"), tso("gone_1"), fc("f1"), fo("f1"), tso("gone_2")];
    const out = dropOrphanToolOutputs(input);
    assert.deepEqual(types(out), ["custom_tool_call", "custom_tool_call_output", "function_call", "function_call_output"]);
});

test("#5670 I1: in-flight parallel pending pair at the tail is untouched (same reference)", () => {
    const input: Item[] = [fc("a"), fc("b")];
    assert.strictEqual(hoistTrappedToolItems(input), input);
    assert.strictEqual(completeOrphanToolCalls(input), input);
});

test("#5670 I1: pending batch interleaved with post-call reasoning stays untouched (same reference)", () => {
    const input: Item[] = [msg("m"), fc("a"), reason(), fc("b")];
    const out = hoistTrappedToolItems(input);
    assert.strictEqual(out, input);
});

test("#5670 I1: custom_tool_call orphan mid-history gets a family-matched synthesized output", () => {
    const input: Item[] = [ct("c"), msg("m")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["custom_tool_call", "custom_tool_call_output", "message"]);
    assert.equal((out[1] as unknown as { output?: string }).output, "tool output lost during context compression");
    assertNoTrap(out);
});

test("#5670 I1: tool_search_call orphan mid-history gets a minimal tool_search_output (empty result)", () => {
    const input: Item[] = [tsc("s"), msg("m")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["tool_search_call", "tool_search_output", "message"]);
    assert.deepEqual(
        out[1] as unknown as { type: string; call_id: string; tools: unknown[]; execution: string },
        { type: "tool_search_output", call_id: "s", tools: [], execution: "client" },
    );
    assertNoTrap(out);
});

test("#5670 both directions in one array: dead output dropped, both abandoned calls completed", () => {
    const input: Item[] = [fc("a"), fo("dead"), fc("b"), msg("m")];
    const out = hoistTrappedToolItems(input);
    assert.deepEqual(types(out), ["function_call", "function_call_output", "function_call", "function_call_output", "message"]);
    assert.equal(out[1].call_id, "a");
    assert.equal(out[3].call_id, "b");
    assertNoTrap(out);
});

test("#5670 I1: completeOrphanToolCalls keeps a lone pending call and a message-then-call tail unchanged", () => {
    const lone: Item[] = [fc("only")];
    assert.strictEqual(completeOrphanToolCalls(lone), lone);
    const tail: Item[] = [msg("m"), fc("p")];
    assert.strictEqual(completeOrphanToolCalls(tail), tail);
});

test("#5670 I1: call with missing call_id is unjudgeable — kept, not completed", () => {
    const bare = { type: "function_call" } as Item;
    const input: Item[] = [bare, msg("m")];
    const out = hoistTrappedToolItems(input);
    assert.strictEqual(out, input);
});
