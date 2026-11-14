import assert from "node:assert/strict";
import test from "node:test";
import { bufferedSseEvents } from "../src/sse-util.ts";

test("only an empty SSE line dispatches a buffered event", () => {
    assert.deepEqual([...bufferedSseEvents("event: answer\ndata: first\n \n\t\ndata: second\n\n")], [
        { event: "answer", data: "first\nsecond" },
    ]);
});

test("a colon-free data field contributes an empty data line", () => {
    assert.deepEqual([...bufferedSseEvents("data: first\ndata\ndata: last\n\n")], [
        { event: "", data: "first\n\nlast" },
    ]);
    assert.deepEqual([...bufferedSseEvents("data\n\n")], [{ event: "", data: "" }]);
});

test("event fields remove only one optional space and can reset to empty", () => {
    assert.deepEqual([...bufferedSseEvents("event:  answer \ndata: value\n\n")], [
        { event: " answer ", data: "value" },
    ]);
    assert.deepEqual([...bufferedSseEvents("event: answer\nevent\ndata: value\n\n")], [
        { event: "", data: "value" },
    ]);
});

test("unknown fields and comments do not reset fields, and real boundaries do", () => {
    assert.deepEqual([...bufferedSseEvents("event: first\n: comment\nunknown\ndata: one\n\ndata: two\n\n")], [
        { event: "first", data: "one" }, { event: "", data: "two" },
    ]);
});
