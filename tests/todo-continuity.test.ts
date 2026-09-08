import test from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import {
    BILI_TODO_CONTINUITY_HEADER,
    BILI_TODO_CONTINUITY_END,
    BILI_TODO_CONTINUITY_PREFIX,
    biliEnsureTodoContinuity,
    biliTodoLatestSnapshot,
    biliTodoRenderCarrier,
} from "../src/todo-continuity.ts";

function todoCall(id: string, toolCallId: string): CoreMessage {
    return { id, role: "assistant", contentType: "tool-call", toolName: "todo_list", toolCallId, text: "" };
}
function todoResult(id: string, toolCallId: string, body: unknown): CoreMessage {
    return { id, role: "user", contentType: "tool-result", toolCallId, text: JSON.stringify(body) };
}
function userText(id: string, text: string): CoreMessage {
    return { id, role: "user", contentType: "text", text };
}

const REV3 = { revision: 3, todos: [
    { id: "a", content: "do A", status: "in_progress" },
    { id: "b", content: "do B", status: "pending", parent: "a" },
] };

test("latest snapshot: picks highest revision, tie-breaks by result index", () => {
    const src = [
        todoCall("c1", "t1"), todoResult("r1", "t1", { revision: 3, todos: [{ id: "a", content: "A", status: "pending" }] }),
        todoCall("c2", "t2"), todoResult("r2", "t2", { revision: 5, todos: [{ id: "c", content: "C", status: "completed" }] }),
        todoCall("c3", "t3"), todoResult("r3", "t3", { revision: 5, todos: [{ id: "d", content: "D", status: "pending" }] }),
    ];
    const snap = biliTodoLatestSnapshot(src);
    assert.equal(snap?.callId, "t3");
    assert.equal(snap?.revision, 5);
});

test("latest snapshot: undefined with no todo_list tool", () => {
    assert.equal(biliTodoLatestSnapshot([userText("u", "hi")]), undefined);
});

test("latest snapshot: rejects malformed results", () => {
    const cases: { name: string; messages: CoreMessage[] }[] = [
        { name: "missing revision", messages: [todoCall("c", "t"), todoResult("r", "t", { todos: [] })] },
        { name: "negative revision", messages: [todoCall("c", "t"), todoResult("r", "t", { revision: -1, todos: [] })] },
        { name: "invalid status", messages: [todoCall("c", "t"), todoResult("r", "t", { revision: 1, todos: [{ id: "a", content: "A", status: "bogus" }] })] },
        { name: "duplicate ids", messages: [todoCall("c", "t"), todoResult("r", "t", { revision: 1, todos: [{ id: "a", content: "A", status: "pending" }, { id: "a", content: "A2", status: "pending" }] })] },
        { name: "parent not present", messages: [todoCall("c", "t"), todoResult("r", "t", { revision: 1, todos: [{ id: "a", content: "A", status: "pending", parent: "zz" }] })] },
        { name: "parent self-reference", messages: [todoCall("c", "t"), todoResult("r", "t", { revision: 1, todos: [{ id: "a", content: "A", status: "pending", parent: "a" }] })] },
        { name: "orphan result without call", messages: [todoResult("r", "t", REV3)] },
        { name: "empty todos at revision 0", messages: [todoCall("c", "t"), todoResult("r", "t", { revision: 0, todos: [] })] },
    ];
    for (const c of cases) {
        assert.equal(biliTodoLatestSnapshot(c.messages), undefined, c.name);
    }
});

test("render carrier: wraps small payload in header/end markers", () => {
    const snap = biliTodoLatestSnapshot([todoCall("c", "t"), todoResult("r", "t", REV3)]);
    assert.ok(snap);
    const text = biliTodoRenderCarrier(snap);
    assert.ok(text.startsWith(BILI_TODO_CONTINUITY_HEADER + "\n"));
    assert.ok(text.endsWith("\n" + BILI_TODO_CONTINUITY_END));
    assert.ok(text.includes('"revision":3'));
    assert.ok(text.includes('"do A"'));
});

test("render carrier: oversized payload truncates to active todos + ancestors", () => {
    const big = (id: string, status: string, parent?: string) => ({ id, content: "x".repeat(4000), status, ...(parent ? { parent } : {}) });
    const todos = [
        big("root", "completed"),
        big("active", "in_progress", "root"),
        big("done1", "completed", "root"),
        big("done2", "completed", "root"),
        big("done3", "completed", "root"),
        big("done4", "completed", "root"),
        big("done5", "completed", "root"),
        big("done6", "completed", "root"),
        big("done7", "completed", "root"),
        big("done8", "completed", "root"),
    ];
    const snap = biliTodoLatestSnapshot([todoCall("c", "t"), todoResult("r", "t", { revision: 1, todos })]);
    assert.ok(snap);
    const text = biliTodoRenderCarrier(snap);
    assert.ok(text.length <= 32768, `carrier ${text.length} exceeds cap`);
    const firstNl = text.indexOf("\n", BILI_TODO_CONTINUITY_HEADER.length);
    const secondNl = text.indexOf("\n", firstNl + 1);
    const body = text.slice(secondNl + 1, text.lastIndexOf("\n" + BILI_TODO_CONTINUITY_END));
    const parsed = JSON.parse(body) as { todos: { id: string }[]; truncated?: boolean };
    assert.ok(parsed.todos.some((t) => t.id === "active"), "active todo kept");
    assert.ok(parsed.todos.some((t) => t.id === "root"), "ancestor of active todo kept");
    assert.ok(parsed.truncated === true || parsed.todos.length < todos.length);
});

test("ensure: injects carrier when todo pair was compressed away", () => {
    const source = [todoCall("c", "t"), todoResult("r", "t", REV3), userText("u", "continue")];
    const view = [userText("u", "continue")];
    const out = biliEnsureTodoContinuity(view, source);
    assert.equal(out.length, 1);
    assert.ok(out[0].text!.startsWith(BILI_TODO_CONTINUITY_HEADER), "carrier merged in front of user text");
    assert.ok(out[0].text!.endsWith("continue"), "original user text preserved after carrier");
});

test("ensure: no carrier when todo pair still visible", () => {
    const source = [todoCall("c", "t"), todoResult("r", "t", REV3), userText("u", "continue")];
    const out = biliEnsureTodoContinuity(source, source);
    assert.deepEqual(out, source, "unchanged when call+result present");
});

test("ensure: no-op when there is no todo state", () => {
    const view = [userText("u", "hi")];
    assert.deepEqual(biliEnsureTodoContinuity(view, view), view);
});

test("ensure: idempotent — re-feeding its own output does not double-inject", () => {
    const source = [todoCall("c", "t"), todoResult("r", "t", REV3), userText("u", "continue")];
    const once = biliEnsureTodoContinuity([userText("u", "continue")], source);
    const twice = biliEnsureTodoContinuity(once, source);
    assert.deepEqual(twice, once, "stable across re-feed");
    assert.equal(twice[0].text!.split(BILI_TODO_CONTINUITY_HEADER).length - 1, 1, "exactly one carrier header");
});

test("ensure: appends carrier when no user text message exists", () => {
    const source = [todoCall("c", "t"), todoResult("r", "t", REV3)];
    const view: CoreMessage[] = [{ id: "a1", role: "assistant", contentType: "text", text: "working" }];
    const out = biliEnsureTodoContinuity(view, source);
    assert.equal(out.length, 2);
    assert.ok(out[1].text!.startsWith(BILI_TODO_CONTINUITY_HEADER));
    assert.ok(out[1].id.startsWith(BILI_TODO_CONTINUITY_PREFIX));
});

test("ensure: supersedes a stale carrier when the source revision advances", () => {
    const staleSource = [todoCall("c0", "t0"), todoResult("r0", "t0", { revision: 1, todos: [{ id: "z", content: "old", status: "pending" }] }), userText("u", "continue")];
    const withStale = biliEnsureTodoContinuity([userText("u", "continue")], staleSource);
    const advanced = [todoCall("c", "t"), todoResult("r", "t", REV3), userText("u", "continue")];
    const out = biliEnsureTodoContinuity(withStale, advanced);
    assert.equal(out[0].text!.split('"revision":1').length - 1, 0, "stale revision carrier removed");
    assert.ok(out[0].text!.includes('"revision":3'), "current revision carrier present");
});
