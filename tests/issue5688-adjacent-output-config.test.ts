// #5688: fold reconstruction must not leave two adjacent output_config effort
// directives in the outbound history — OpenRouter rejects that shape with a
// hard 400 ("Two adjacent output_config directives are not allowed") and the
// session dies on every retry until the directives are collapsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAdjacentOutputConfig } from "../src/server.js";

type Msg = Record<string, any>;
const dir = (effort: string): Msg => ({ role: "system", content: [], output_config: { effort } });
const asst = (): Msg => ({ role: "assistant", content: [{ type: "text", text: "ok" }] });
const user = (): Msg => ({ role: "user", content: "q" });
const isDir = (m: Msg) => m.output_config !== undefined;

test("clean history returns the same array reference (fast path)", () => {
    const msgs = [user(), dir("max"), asst(), user(), dir("low"), asst(), user()];
    assert.equal(dedupeAdjacentOutputConfig(msgs), msgs);
});

test("collapses two adjacent directives, keeping the latter effort", () => {
    const msgs = [user(), dir("max"), dir("low"), asst(), user()];
    const out = dedupeAdjacentOutputConfig(msgs);
    assert.equal(out.length, 4);
    assert.deepEqual(out.filter(isDir), [dir("low")]);
});

test("collapses a run of three adjacent directives down to the last", () => {
    const out = dedupeAdjacentOutputConfig([user(), dir("max"), dir("high"), dir("low"), asst(), user()]);
    assert.deepEqual(out.filter(isDir), [dir("low")]);
});

test("text-bearing system messages are never treated as directives", () => {
    const sysText: Msg = { role: "system", content: [{ type: "text", text: "note" }], output_config: { effort: "max" } };
    const msgs = [user(), sysText, dir("low"), asst(), user()];
    const out = dedupeAdjacentOutputConfig(msgs);
    assert.equal(out.length, 5);
    assert.ok(out.includes(sysText));
});

test("empty system messages without output_config are left alone", () => {
    const msgs = [user(), { role: "system", content: [] }, { role: "system", content: [] }, asst(), user()];
    assert.equal(dedupeAdjacentOutputConfig(msgs), msgs);
});

test("directive with absent content field is still detected", () => {
    const out = dedupeAdjacentOutputConfig([user(), dir("low"), { role: "system", output_config: { effort: "max" } }, asst(), user()]);
    assert.deepEqual(out.filter(isDir), [{ role: "system", output_config: { effort: "max" } }]);
});

test("non-adjacent directives are preserved (only adjacent runs collapse)", () => {
    const out = dedupeAdjacentOutputConfig([user(), dir("max"), asst(), user(), dir("low"), asst(), user()]);
    assert.equal(out.filter(isDir).length, 2);
});
