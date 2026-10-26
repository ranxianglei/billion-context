// #1947: URL path syntax for protectedTools / protectedLatestTools.
//
// Skill loads project to a canonical `skill/<name>` path on every client
// (opencode `skill({name})`, Claude Code/ZCode `Skill({skill})`, any tool
// reading `<dir>/<name>/SKILL.md`), so one knob addresses an individual skill
// without new config fields. These host-side tests cover the config plumbing
// plus end-to-end compression runs over the anthropic, openai-chat and
// responses wires; unit-level coverage of the projection and matcher lives in
// kernel/tests/protected-paths.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, refForRaw, coveredMessageIds } from "acp-kernel";
import { anthropicToCore, openaiToCore, responsesToCore, type AnthropicRequestBody, type OpenAIRequestBody, type ResponsesRequestBody } from "acp-kernel/wire";
import type { CoreMessage } from "acp-kernel";
import { parseCompressSettings } from "../src/config.ts";
import { extractPlanState } from "../src/decompress-shared.ts";

// --- Config plumbing --------------------------------------------------------

test("parseCompressSettings accepts path patterns verbatim (slash + glob)", () => {
    const s = parseCompressSettings({
        protectedTools: ["skill/release-orchestrator"],
        protectedLatestTools: ["todo_list", "skill/*"],
    });
    assert.deepEqual(s?.protectedTools, ["skill/release-orchestrator"]);
    assert.deepEqual(s?.protectedLatestTools, ["todo_list", "skill/*"]);
});

// --- Wire helpers -----------------------------------------------------------

function buildBody(): AnthropicRequestBody {
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    const push = (role: "user" | "assistant", content: unknown) =>
        body.messages.push({ role, content: content as never });
    push("user", "message 0 start of a long working session");
    // Claude Code shape: Skill({skill}); one orchestrator skill, two light ones.
    for (const name of ["release-orchestrator", "review-loop", "deploy-checks"]) {
        push("assistant", [{ type: "tool_use", id: `sk-${name}`, name: "Skill", input: { skill: name } }]);
        push("user", [{ type: "tool_result", tool_use_id: `sk-${name}`, content: `skill ${name} full reference payload ${"y".repeat(400)}` }]);
    }
    // pi shape: no skill tool — the skill arrives via a read of SKILL.md.
    push("assistant", [{ type: "tool_use", id: "rd-skill", name: "read", input: { path: "/home/u/skills/review-loop/SKILL.md" } }]);
    push("user", [{ type: "tool_result", tool_use_id: "rd-skill", content: `# review loop skill body ${"y".repeat(400)}` }]);
    for (let i = 0; i < 30; i++) {
        push(i % 2 === 0 ? "user" : "assistant", `tail message ${i} ${"x".repeat(500)}`);
    }
    return body;
}

function pairOf(msgs: CoreMessage[], callId: string): { call: CoreMessage; result: CoreMessage } {
    const call = msgs.find((m) => m.contentType === "tool-call" && m.toolCallId === callId);
    const result = msgs.find((m) => m.contentType === "tool-result" && m.toolCallId === callId);
    assert.ok(call && result, `pair ${callId} resolved`);
    return { call: call!, result: result! };
}

// --- protectedTools: named skill path ----------------------------------------

test("protectedTools [\"skill/release-orchestrator\"]: only that skill's loads stay, others fold", () => {
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), protectedTools: ["skill/release-orchestrator"], preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(buildBody());

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);

    const kept = pairOf(msgs, "sk-release-orchestrator");
    assert.equal(refOf(kept.call), "BLOCKED", "named skill call is BLOCKED");
    assert.equal(refOf(kept.result), "BLOCKED", "named skill result is BLOCKED");
    for (const id of ["sk-review-loop", "sk-deploy-checks"]) {
        const { call, result } = pairOf(msgs, id);
        assert.ok(/^m\d+$/.test(refOf(call) ?? ""), `${id} call stays addressable`);
        assert.ok(/^m\d+$/.test(refOf(result) ?? ""), `${id} result stays addressable`);
    }

    // The SKILL.md read of a light skill stays an ordinary read — the bare
    // tool name keeps matching so `read` patterns behave exactly as before.
    const rd = pairOf(msgs, "rd-skill");
    assert.ok(/^m\d+$/.test(refOf(rd.call) ?? ""), "SKILL.md read is foldable under a name-only knob");
});

test("protectedTools [\"skill/review-*\"] glob protects the SKILL.md read (pi shape) and named loads (client shapes)", () => {
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), protectedTools: ["skill/review-*"], preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(buildBody());

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    for (const id of ["sk-review-loop", "rd-skill"]) {
        const { call, result } = pairOf(msgs, id);
        assert.equal(refOf(call), "BLOCKED", `${id} call BLOCKED by skill/review-*`);
        assert.equal(refOf(result), "BLOCKED", `${id} result BLOCKED by skill/review-*`);
    }
    const other = pairOf(msgs, "sk-release-orchestrator");
    assert.ok(/^m\d+$/.test(refOf(other.call) ?? ""), "non-matching skill stays foldable");
});

// --- protectedLatestTools: latest-per-name -----------------------------------

test("protectedLatestTools [\"skill/*\"]: newest load PER skill survives, older loads fold", () => {
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    const push = (role: "user" | "assistant", content: unknown) =>
        body.messages.push({ role, content: content as never });
    push("user", "start of a long working session");
    // opencode shape: skill({name}). Two loads of alpha (old→new), one of beta.
    let seq = 0;
    const load = (name: string) => {
        const id = `oc-${name}-${seq++}`;
        push("assistant", [{ type: "tool_use", id, name: "skill", input: { name } }]);
        push("user", [{ type: "tool_result", tool_use_id: id, content: `skill ${name} payload ${"y".repeat(400)}` }]);
    };
    load("alpha"); load("beta"); load("alpha");
    for (let i = 0; i < 30; i++) {
        push(i % 2 === 0 ? "user" : "assistant", `tail message ${i} ${"x".repeat(500)}`);
    }
    const core = createCore();
    const config = { ...defaultConfig(200000), protectedLatestTools: ["skill/*"], preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(body);
    const turn = core.processTurn({ messages: msgs, state: createInitialState(), config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);

    const oldAlpha = pairOf(msgs, "oc-alpha-0");
    assert.ok(/^m\d+$/.test(refOf(oldAlpha.call) ?? ""), "older alpha load stays foldable");
    for (const id of ["oc-alpha-2", "oc-beta-1"]) {
        const { call, result } = pairOf(msgs, id);
        assert.equal(refOf(call), "BLOCKED", `${id} latest load call BLOCKED`);
        assert.equal(refOf(result), "BLOCKED", `${id} latest load result BLOCKED`);
    }

    // Folding the whole early history keeps exactly the newest of each name.
    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: refOf(spanEnd)!, summary: "fold early history; per-skill snapshots survive".repeat(3) }],
        state: turn.state, config, messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0, `no errors: ${res.result.errors.join("; ")}`);
    const covered = coveredMessageIds(res.state);
    assert.ok(covered.has(oldAlpha.call.id), "older alpha load folded");
    for (const id of ["oc-alpha-2", "oc-beta-1"]) {
        const { call, result } = pairOf(msgs, id);
        assert.ok(!covered.has(call.id) && !covered.has(result.id), `${id} pair NOT covered`);
    }
    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    const loads = turn2.messages.filter((m) => m.contentType === "tool-call" && m.toolName === "skill");
    assert.deepEqual(loads.map((m) => JSON.parse((m as { text?: string }).text ?? "{}").name), ["beta", "alpha"], "newest load of each skill survives (history order)");
});

// --- Plan-aware retrieval: path patterns feed extractPlanState ----------------

test("extractPlanState honors skill path patterns (extraPatterns [\"skill/*\"])", () => {
    const msgs: CoreMessage[] = [
        { id: "s1", role: "assistant", contentType: "tool-call", toolName: "skill", text: JSON.stringify({ name: "release-orchestrator" }) },
        { id: "u1", role: "user", contentType: "text", text: "cut the release today" },
    ];
    // Without a pattern the skill load is not a planning surface: only the
    // user turn would count — a lone skill call yields nothing.
    assert.equal(extractPlanState([msgs[0]]), null, "skill load alone is not a plan surface");
    const st = extractPlanState(msgs, ["skill/*"]);
    assert.ok(st, "plan state extracted via skill path pattern");
    assert.ok(st!.terms.has("orchestrator"), "skill load terms present");
    // Per-path mirroring of the kernel's latest-per-name grouping: two
    // distinct skills each keep their own slot (a pattern-keyed map would
    // collapse them into one global-latest entry).
    const two: CoreMessage[] = [
        { id: "s1", role: "assistant", contentType: "tool-call", toolName: "skill", text: JSON.stringify({ name: "release-orchestrator" }) },
        { id: "s2", role: "assistant", contentType: "tool-call", toolName: "skill", text: JSON.stringify({ name: "audit-checklist" }) },
    ];
    const st2 = extractPlanState(two, ["skill/*"]);
    assert.ok(st2, "plan state extracted for two skills");
    assert.ok(st2!.terms.has("orchestrator"), "first skill's terms kept in its own slot");
    assert.ok(st2!.terms.has("checklist"), "second skill's terms kept in its own slot");
});

// --- Non-anthropic wires: projection feeds the same path matcher -------------

test("openai-chat wire: Skill({skill}) loads project to skill/<name> under path patterns", () => {
    const body: OpenAIRequestBody = { model: "gpt-test", messages: [
        { role: "user", content: "start of a long working session" },
        { role: "assistant", content: null, tool_calls: [
            { id: "sk-orc", type: "function", function: { name: "Skill", arguments: JSON.stringify({ skill: "release-orchestrator" }) } },
            { id: "sk-light", type: "function", function: { name: "Skill", arguments: JSON.stringify({ skill: "review-loop" }) } },
        ] },
        { role: "tool", tool_call_id: "sk-orc", content: `skill release-orchestrator payload ${"y".repeat(400)}` },
        { role: "tool", tool_call_id: "sk-light", content: `skill review-loop payload ${"y".repeat(400)}` },
    ] };
    const core = createCore();
    const config = { ...defaultConfig(200000), protectedTools: ["skill/release-orchestrator"], preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = openaiToCore(body);
    const turn = core.processTurn({ messages: msgs, state: createInitialState(), config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    const kept = pairOf(msgs, "sk-orc");
    assert.equal(refOf(kept.call), "BLOCKED", "named skill call BLOCKED on openai wire");
    assert.equal(refOf(kept.result), "BLOCKED", "named skill result BLOCKED on openai wire");
    const light = pairOf(msgs, "sk-light");
    assert.ok(/^m\d+$/.test(refOf(light.call) ?? ""), "non-matching skill stays foldable");
});

test("responses wire: skill({name}) loads project to skill/<name> under path patterns", () => {
    const body: ResponsesRequestBody = { model: "gpt-test", input: [
        { type: "message", role: "user", content: "start of a long working session" },
        { type: "function_call", call_id: "call-orc", name: "skill", arguments: JSON.stringify({ name: "release-orchestrator" }) },
        { type: "function_call_output", call_id: "call-orc", output: `skill release-orchestrator payload ${"y".repeat(400)}` },
        { type: "function_call", call_id: "call-light", name: "skill", arguments: JSON.stringify({ name: "review-loop" }) },
        { type: "function_call_output", call_id: "call-light", output: `skill review-loop payload ${"y".repeat(400)}` },
    ] };
    const core = createCore();
    const config = { ...defaultConfig(200000), protectedLatestTools: ["skill/*"], preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = responsesToCore(body);
    const turn = core.processTurn({ messages: msgs, state: createInitialState(), config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    for (const id of ["call-orc", "call-light"]) {
        const { call, result } = pairOf(msgs, id);
        assert.equal(refOf(call), "BLOCKED", `${id} latest-per-name call BLOCKED on responses wire`);
        assert.equal(refOf(result), "BLOCKED", `${id} latest-per-name result BLOCKED on responses wire`);
    }
});
