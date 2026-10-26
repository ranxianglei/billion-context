import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, refForRaw, coveredMessageIds } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody } from "acp-kernel/wire";
import type { CoreMessage } from "acp-kernel";
import { parseCompressSettings } from "../src/config.ts";
import { mergeCompress, resolveRequestConfig } from "../src/compress-settings.ts";

// --- Config plumbing ------------------------------------------------------

test("parseCompressSettings accepts a valid protectedTools array", () => {
    const s = parseCompressSettings({ protectedTools: [" skill ", "skill_*"] });
    assert.deepEqual(s?.protectedTools, ["skill", "skill_*"]);
});

test("parseCompressSettings rejects malformed protectedTools", () => {
    assert.equal(parseCompressSettings({ protectedTools: "skill" }), undefined);
    assert.equal(parseCompressSettings({ protectedTools: [] }), undefined);
    assert.equal(parseCompressSettings({ protectedTools: [42] }), undefined);
    assert.equal(parseCompressSettings({ protectedTools: [""] }), undefined);
    assert.equal(parseCompressSettings({ protectedTools: ["skill", null] }), undefined);
});

test("mergeCompress: protectedTools deepest level wins, whole-array replace", () => {
    const merged = mergeCompress(
        { protectedTools: ["skill"], tiers: true },
        { protectedTools: ["webfetch"] },
        { tiers: false },
    );
    assert.deepEqual(merged.protectedTools, ["webfetch"]);
    assert.equal(merged.tiers, false);
    assert.deepEqual(
        mergeCompress({ protectedTools: ["a"] }, undefined, undefined).protectedTools,
        ["a"],
    );
    assert.equal(mergeCompress(undefined, undefined, undefined).protectedTools, undefined);
    // The two knobs merge independently — a provider-level protectedLatestTools
    // must not clobber a global-level protectedTools.
    const both = mergeCompress({ protectedTools: ["skill"] }, { protectedLatestTools: ["todo_list"] });
    assert.deepEqual(both.protectedTools, ["skill"]);
    assert.deepEqual(both.protectedLatestTools, ["todo_list"]);
});

test("resolveRequestConfig passes protectedTools onto the kernel Config", () => {
    const base = defaultConfig(200000);
    const tuned = resolveRequestConfig(base, {}, undefined, "claude-test", 200000, {
        protectedTools: ["skill"],
    });
    assert.deepEqual(tuned.protectedTools, ["skill"]);
    assert.deepEqual(resolveRequestConfig(base, {}, undefined, "claude-test", 200000, {}).protectedTools, []);
});

// --- Kernel end-to-end: every instance survives compression ---------------

function buildBody(): AnthropicRequestBody {
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    const push = (role: "user" | "assistant", content: unknown): void => {
        body.messages.push({ role, content: content as never });
    };
    push("user", "message 0 start of a long working session");
    for (const name of ["alpha", "beta", "gamma"]) {
        push("assistant", [
            { type: "tool_use", id: `sk-${name}`, name: "skill", input: { skill: name } },
        ]);
        push("user", [
            { type: "tool_result", tool_use_id: `sk-${name}`, content: `skill ${name} full reference payload ${"y".repeat(400)}` },
        ]);
    }
    for (let i = 0; i < 30; i++) {
        push(i % 2 === 0 ? "user" : "assistant", `tail message ${i} ${"x".repeat(500)}`);
    }
    return body;
}

function skillsIn(view: CoreMessage[]): CoreMessage[] {
    return view.filter((m) => m.contentType === "tool-call" && m.toolName === "skill");
}

test("protectedTools: explicit compress range cannot fold ANY skill load", () => {
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), protectedTools: ["skill"], preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(buildBody());

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    // Full-history hard exclusion: EVERY instance is unaddressable (BLOCKED).
    for (const id of ["sk-alpha", "sk-beta", "sk-gamma"]) {
        const call = msgs.find((m) => m.contentType === "tool-call" && m.toolCallId === id)!;
        const result = msgs.find((m) => m.contentType === "tool-result" && m.toolCallId === id)!;
        assert.equal(refOf(call), "BLOCKED", `${id} call ref is BLOCKED`);
        assert.equal(refOf(result), "BLOCKED", `${id} result ref is BLOCKED`);
    }
    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const endRef = refOf(spanEnd);
    assert.ok(endRef !== null && /^m\d+$/.test(endRef), `range end ref resolved, got ${endRef}`);

    // An explicit range spanning everything up to AND INCLUDING all three
    // skill pairs — the hard exclusion must carve every instance out.
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef, summary: "fold the whole early history including every skill load".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0, `no errors: ${res.result.errors.join("; ")}`);

    const covered = coveredMessageIds(res.state);
    for (const id of ["sk-alpha", "sk-beta", "sk-gamma"]) {
        const call = msgs.find((m) => m.contentType === "tool-call" && m.toolCallId === id)!;
        const result = msgs.find((m) => m.contentType === "tool-result" && m.toolCallId === id)!;
        assert.ok(!covered.has(call.id) && !covered.has(result.id), `${id} pair NOT covered`);
    }

    // Next turn view: all three skill calls remain visible.
    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    assert.equal(skillsIn(turn2.messages).length, 3, "all skill loads survive");
});

test("without protectedTools every skill load is foldable (default stays off)", () => {
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
    assert.equal((config.protectedTools ?? []).length, 0, "default off");
    const { msgs } = anthropicToCore(buildBody());

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: refOf(spanEnd)!, summary: "fold the whole early history including every skill load".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0);
    assert.ok(!res.result.warnings.some((w) => /protected/.test(w)), "no protection carve by default");
    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    assert.equal(skillsIn(turn2.messages).length, 0, "all skill loads foldable when not configured");
});

// --- #1725: case-insensitive matching (acp-kernel #484, needs kernel >= 0.0.100) ---
// opencode spells the tool "read" while the Claude-style config lists "Read" —
// pre-0.0.100 kernels compared exactly and the lowercase pair silently folded.

test("protectedTools matching is case-insensitive: \"Read\" pattern protects opencode's \"read\" pair (#1725)", () => {
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    body.messages.push({ role: "user", content: "start of session with an opencode file read" as never });
    body.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "rd-1", name: "read", input: { path: "src/a.ts" } }] as never });
    body.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "rd-1", content: `file body ${"z".repeat(600)}` }] as never });
    for (let i = 0; i < 30; i++) {
        body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `tail message ${i} ${"x".repeat(500)}` as never });
    }
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), protectedTools: ["Read"], preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(body);

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    const call = msgs.find((m) => m.contentType === "tool-call" && m.toolCallId === "rd-1")!;
    const result = msgs.find((m) => m.contentType === "tool-result" && m.toolCallId === "rd-1")!;
    assert.equal(refOf(call), "BLOCKED", "opencode 'read' call is BLOCKED by the Claude-cased 'Read' pattern");
    assert.equal(refOf(result), "BLOCKED", "opencode 'read' result is BLOCKED by the Claude-cased 'Read' pattern");

    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: refOf(spanEnd)!, summary: "fold the early history including the file read".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0, `no errors: ${res.result.errors.join("; ")}`);
    const covered = coveredMessageIds(res.state);
    assert.ok(!covered.has(call.id) && !covered.has(result.id), "the case-mismatched read pair is NOT covered");

    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    assert.equal(turn2.messages.filter((m) => m.contentType === "tool-call" && m.toolName === "read").length, 1, "the read pair survives the fold");
});
