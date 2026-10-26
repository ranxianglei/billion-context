import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, refForRaw, coveredMessageIds } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody } from "acp-kernel/wire";
import type { CoreMessage } from "acp-kernel";
import { parseCompressSettings } from "../src/config.ts";
import { mergeCompress, resolveRequestConfig } from "../src/compress-settings.ts";

// --- Config plumbing ------------------------------------------------------

test("parseCompressSettings accepts a valid protectedLatestTools array", () => {
    const s = parseCompressSettings({ protectedLatestTools: [" todo_list ", "TodoWrite"] });
    assert.deepEqual(s?.protectedLatestTools, ["todo_list", "TodoWrite"]);
});

test("parseCompressSettings rejects malformed protectedLatestTools", () => {
    assert.equal(parseCompressSettings({ protectedLatestTools: "todo_list" }), undefined);
    assert.equal(parseCompressSettings({ protectedLatestTools: [] }), undefined);
    assert.equal(parseCompressSettings({ protectedLatestTools: [42] }), undefined);
    assert.equal(parseCompressSettings({ protectedLatestTools: [""] }), undefined);
    assert.equal(parseCompressSettings({ protectedLatestTools: ["todo_list", null] }), undefined);
});

test("mergeCompress: protectedLatestTools deepest level wins, whole-array replace", () => {
    const merged = mergeCompress(
        { protectedLatestTools: ["todo_list"], tiers: true },
        { protectedLatestTools: ["TodoWrite"] },
        { tiers: false },
    );
    assert.deepEqual(merged.protectedLatestTools, ["TodoWrite"]);
    assert.equal(merged.tiers, false);
    assert.deepEqual(
        mergeCompress({ protectedLatestTools: ["a"] }, undefined, undefined).protectedLatestTools,
        ["a"],
    );
    assert.equal(mergeCompress(undefined, undefined, undefined).protectedLatestTools, undefined);
});

test("resolveRequestConfig passes protectedLatestTools onto the kernel Config", () => {
    const base = defaultConfig(200000);
    const tuned = resolveRequestConfig(base, {}, undefined, "claude-test", 200000, {
        protectedLatestTools: ["todo_list"],
    });
    assert.deepEqual(tuned.protectedLatestTools, ["todo_list"]);
    assert.deepEqual(resolveRequestConfig(base, {}, undefined, "claude-test", 200000, {}).protectedLatestTools, []);
});

// --- Kernel end-to-end: latest instance survives compression --------------

function buildBody(): AnthropicRequestBody {
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    const push = (role: "user" | "assistant", content: unknown): void => {
        body.messages.push({ role, content: content as never });
    };
    push("user", "message 0 start of a long working session");
    for (const rev of [1, 2, 3]) {
        push("assistant", [
            { type: "tool_use", id: `todo-${rev}`, name: "todo_list", input: { revision: rev, todos: [{ id: `t${rev}`, content: `task ${rev}`, status: "in_progress" }] } },
        ]);
        push("user", [
            { type: "tool_result", tool_use_id: `todo-${rev}`, content: `todo revision ${rev} snapshot` },
        ]);
    }
    for (let i = 0; i < 30; i++) {
        push(i % 2 === 0 ? "user" : "assistant", `tail message ${i} ${"x".repeat(500)}`);
    }
    return body;
}

function todosIn(view: CoreMessage[]): CoreMessage[] {
    return view.filter((m) => m.contentType === "tool-call" && m.toolName === "todo_list");
}

test("protectedLatestTools: explicit compress range cannot fold the latest todo snapshot", () => {
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), protectedLatestTools: ["todo_list"], preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(buildBody());

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    const latestCall = msgs.find((m) => m.contentType === "tool-call" && m.toolCallId === "todo-3")!;
    const latestResult = msgs.find((m) => m.contentType === "tool-result" && m.toolCallId === "todo-3")!;
    // A tail message sitting AFTER the latest todo pair: a range ending here
    // SPANS the latest snapshot — the hard exclusion must carve it out.
    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const endRef = refOf(spanEnd);
    assert.ok(endRef !== null && /^m\d+$/.test(endRef), `range end ref resolved, got ${endRef}`);
    // The latest protected pair is UNADDRESSABLE: its refs render as the
    // literal "BLOCKED" marker, so no range (model-issued or explicit) can
    // ever cite the live snapshot into a compress range.
    assert.equal(refOf(latestCall), "BLOCKED", "latest todo call ref is BLOCKED");
    assert.equal(refOf(latestResult), "BLOCKED", "latest todo result ref is BLOCKED");

    // An explicit range spanning everything up to AND INCLUDING the latest
    // todo pair — the hard exclusion must carve the latest instance out.
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef, summary: "fold the whole early history including every todo snapshot".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0, `no errors: ${res.result.errors.join("; ")}`);

    // The older revisions folded; the latest call+result did not.
    const covered = coveredMessageIds(res.state);
    assert.ok(!covered.has(latestCall.id) && !covered.has(latestResult.id), "latest todo pair NOT covered");

    // Next turn view: exactly one todo_list call remains — the real, latest
    // one (kernel #223), not a host-side replay.
    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    const calls = todosIn(turn2.messages);
    assert.equal(calls.length, 1, `exactly one todo_list call visible, got ${calls.length}`);
    assert.equal(calls[0].toolCallId, "todo-3");
    assert.ok(
        turn2.messages.some((m) => m.contentType === "tool-result" && m.toolCallId === "todo-3"),
        "latest todo result visible in view",
    );
});

test("without protectedLatestTools every todo snapshot is foldable (default stays off)", () => {
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
    assert.equal((config.protectedLatestTools ?? []).length, 0, "default off");
    const { msgs } = anthropicToCore(buildBody());

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: refOf(spanEnd)!, summary: "fold the whole early history including every todo snapshot".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0);
    assert.ok(!res.result.warnings.some((w) => /protected/.test(w)), "no protection carve by default");
    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    assert.equal(todosIn(turn2.messages).length, 0, "all todo snapshots foldable when not configured");
});
