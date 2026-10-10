// #2578: MCP-lane hosts expose bili tools under mcp__bili__<name> (Kimi Code,
// Claude Code, zcode). The kernel's hard protection matches bare names only,
// so MCP-prefixed compress/acp_rule calls were foldable while their
// bare-name twins were not. The host now routes the MCP forms through the
// kernel's isToolProtected hook (wired in src/config.ts loadOptions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, refForRaw, coveredMessageIds, type CoreMessage } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody } from "acp-kernel/wire";
import { loadOptions, isMcpBiliHardProtected } from "../src/config.ts";
import { resolveRequestConfig } from "../src/compress-settings.ts";

// --- Predicate unit behavior ----------------------------------------------

test("isMcpBiliHardProtected recognizes exactly the MCP forms of the kernel hard-protected set", () => {
    assert.equal(isMcpBiliHardProtected("mcp__bili__acp_rule"), true);
    assert.equal(isMcpBiliHardProtected("mcp__bili__compress"), true);
    // Bare names belong to the kernel's own always-protected list, not this hook.
    assert.equal(isMcpBiliHardProtected("acp_rule"), false);
    assert.equal(isMcpBiliHardProtected("compress"), false);
    // Other bili MCP tools are NOT hard-protected (parity with their bare names).
    assert.equal(isMcpBiliHardProtected("mcp__bili__decompress"), false);
    assert.equal(isMcpBiliHardProtected("mcp__bili__search_context"), false);
    assert.equal(isMcpBiliHardProtected("mcp__bili__acp_status"), false);
    // Another server's identically-named tools must never be protected here.
    assert.equal(isMcpBiliHardProtected("mcp__other__acp_rule"), false);
    assert.equal(isMcpBiliHardProtected("mcp__other__compress"), false);
    // Name-shape traps.
    assert.equal(isMcpBiliHardProtected("mcp__bili__acp_rules"), false);
    assert.equal(isMcpBiliHardProtected("mcp__bili__xcompress"), false);
    assert.equal(isMcpBiliHardProtected("mcp__bili__"), false);
});

// --- Config plumbing --------------------------------------------------------

test("loadOptions wires the MCP hard-protection hook into kernelConfig", () => {
    const pred = loadOptions({}).kernelConfig.isToolProtected;
    assert.equal(typeof pred, "function", "kernelConfig.isToolProtected is wired");
    assert.equal(pred!("mcp__bili__acp_rule"), true);
    assert.equal(pred!("mcp__bili__compress"), true);
    assert.equal(pred!("mcp__other__acp_rule"), false);
});

test("resolveRequestConfig cascade keeps the hook on tuned configs", () => {
    const base = { ...defaultConfig(200000), isToolProtected: isMcpBiliHardProtected };
    const tuned = resolveRequestConfig(base, {}, undefined, "kimi-test", 200000, { protectedTools: ["read"] });
    assert.equal(tuned.isToolProtected?.("mcp__bili__acp_rule"), true, "hook survives the per-request resolve");
});

// --- Kernel end-to-end: MCP-named pairs survive compression -----------------

function buildBody(): AnthropicRequestBody {
    const body: AnthropicRequestBody = { model: "kimi-test", messages: [] };
    const push = (role: "user" | "assistant", content: unknown): void => {
        body.messages.push({ role, content: content as never });
    };
    push("user", "message 0 start of a long working session");
    push("assistant", [
        { type: "tool_use", id: "rule-1", name: "mcp__bili__acp_rule", input: { action: "add", rule: "always reply concisely" } },
    ]);
    push("user", [
        { type: "tool_result", tool_use_id: "rule-1", content: `rule stored ${"y".repeat(400)}` },
    ]);
    for (let i = 0; i < 30; i++) {
        push(i % 2 === 0 ? "user" : "assistant", `tail message ${i} ${"x".repeat(500)}`);
    }
    return body;
}

function mcpRuleCalls(view: CoreMessage[]): CoreMessage[] {
    return view.filter((m) => m.contentType === "tool-call" && m.toolName === "mcp__bili__acp_rule");
}

test("MCP acp_rule pair is BLOCKED and survives an explicit full-history fold", () => {
    const core = createCore();
    const state = createInitialState();
    const config = { ...loadOptions({}).kernelConfig, preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(buildBody());

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    const call = msgs.find((m) => m.contentType === "tool-call" && m.toolCallId === "rule-1")!;
    const result = msgs.find((m) => m.contentType === "tool-result" && m.toolCallId === "rule-1")!;
    assert.equal(refOf(call), "BLOCKED", "mcp__bili__acp_rule call ref is BLOCKED");
    assert.equal(refOf(result), "BLOCKED", "mcp__bili__acp_rule result ref is BLOCKED");

    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: refOf(spanEnd)!, summary: "fold the whole early history including the rule call".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0, `no errors: ${res.result.errors.join("; ")}`);
    const covered = coveredMessageIds(res.state);
    assert.ok(!covered.has(call.id) && !covered.has(result.id), "the MCP acp_rule pair is NOT covered");

    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    assert.equal(mcpRuleCalls(turn2.messages).length, 1, "the MCP acp_rule call survives the fold");
});

test("control: without the host hook the same MCP pair folds (original bug)", () => {
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(buildBody());

    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    const call = msgs.find((m) => m.contentType === "tool-call" && m.toolCallId === "rule-1")!;
    assert.match(refOf(call)!, /^m\d+$/, "without the hook the MCP call gets a foldable ref (bug repro)");

    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: refOf(spanEnd)!, summary: "fold the whole early history including the rule call".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0, `no errors: ${res.result.errors.join("; ")}`);
    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    assert.equal(mcpRuleCalls(turn2.messages).length, 0, "the MCP acp_rule call folds away without the hook");
});

// Parity control: the kernel's own always-protected list covers bare acp_rule
// at the CARVING layer (applyCompression excludes it from any range) even
// though plain defaultConfig leaves it a normal m-ref — the guarantee that
// matters is survival, which the MCP forms must match after the fix.
test("parity control: bare acp_rule survives an explicit full-history fold under plain defaultConfig", () => {
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    body.messages.push({ role: "user", content: "start of session" as never });
    body.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "r-bare", name: "acp_rule", input: { action: "add", rule: "x" } }] as never });
    body.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "r-bare", content: "stored" }] as never });
    for (let i = 0; i < 30; i++) {
        body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `tail message ${i} ${"x".repeat(500)}` as never });
    }
    const core = createCore();
    const state = createInitialState();
    const config = { ...defaultConfig(200000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const { msgs } = anthropicToCore(body);
    const turn = core.processTurn({ messages: msgs, state, config, tokenCount: 9999, renderTags: "text-only" });
    const refOf = (m: CoreMessage): string | null => refForRaw(turn.state.messageRefs, m.id);
    const spanEnd = msgs.find((m) => m.contentType === "text" && m.text?.startsWith("tail message 20"))!;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: refOf(spanEnd)!, summary: "fold the whole early history including the rule call".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.errors.length, 0, `no errors: ${res.result.errors.join("; ")}`);
    const covered = coveredMessageIds(res.state);
    const call = msgs.find((m) => m.contentType === "tool-call" && m.toolCallId === "r-bare")!;
    const result = msgs.find((m) => m.contentType === "tool-result" && m.toolCallId === "r-bare")!;
    assert.ok(!covered.has(call.id) && !covered.has(result.id), "bare acp_rule pair carved out of the fold");
    const turn2 = core.processTurn({ messages: msgs, state: res.state, config, tokenCount: 9999, renderTags: "text-only" });
    assert.equal(turn2.messages.filter((m) => m.contentType === "tool-call" && m.toolName === "acp_rule").length, 1, "bare acp_rule call survives");
});
