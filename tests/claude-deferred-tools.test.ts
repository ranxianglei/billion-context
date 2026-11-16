import assert from "node:assert/strict";
import test from "node:test";
import { resolveLaneDecisions } from "../src/server/lane-decisions.ts";

// Claude Code keeps MCP tools out of `tools` until the model loads them with
// ToolSearch and lists them by name in a message instead (shape captured from
// Claude Code 2.1.325). Workers told to call bare `compress` failed with
// "No such tool available: compress"; research subagents whose allow-list
// holds no bili tool were nudged 127 times without any way to fold.

const BILLING = { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.325.382; cc_entrypoint=sdk-cli;" };
const tool = (name: string) => ({ name, description: "d", input_schema: { type: "object", properties: {} } });

function announcement(names: string[]): string {
    return "<system-reminder>\nThe following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query \"select:<name>[,<name>...]\" to load tool schemas before calling them:\n"
        + names.join("\n") + "\n\nAvailable agent types for the Agent tool:\n- claude: ...\n</system-reminder>";
}

function claudeBody(opts: { tools: string[]; deferred?: string[]; billing?: boolean }): unknown {
    const messages: unknown[] = [];
    if (opts.deferred) messages.push({ role: "user", content: [{ type: "text", text: announcement(opts.deferred) }, { type: "text", text: "hi" }] });
    else messages.push({ role: "user", content: "hi" });
    return {
        model: "claude-haiku-5-5",
        system: opts.billing === false ? [{ type: "text", text: "You are a helper." }] : [BILLING, { type: "text", text: "You are a Claude agent." }],
        messages,
        tools: opts.tools.map(tool),
    };
}

const decide = (parsed: unknown, pluginHeaderPresent = false) =>
    resolveLaneDecisions({ protocol: "anthropic", pluginMode: true, pluginAgent: "mcp", parsed, shouldInject: true, pluginHeaderPresent });

test("a deferred mcp__bili__compress names the MCP tool in the prompt", () => {
    const d = decide(claudeBody({ tools: ["Bash", "Read", "ToolSearch"], deferred: ["WebFetch", "mcp__bili__acp_status", "mcp__bili__compress", "mcp__bili__decompress"] }));
    assert.equal(d.compressSurfaceOn, true);
    assert.equal(d.mcpDialect, true, "the model must be told to call mcp__bili__compress, not compress");
});

test("the dialect stays on once ToolSearch has loaded the tool", () => {
    const d = decide(claudeBody({ tools: ["Bash", "ToolSearch", "mcp__bili__compress"], deferred: ["mcp__bili__compress"] }));
    assert.equal(d.compressSurfaceOn, true);
    assert.equal(d.mcpDialect, true);
});

test("a Claude Code agent with no bili tool anywhere gets no compress surface", () => {
    const listedElsewhere = decide(claudeBody({ tools: ["Bash", "Read", "ToolSearch"], deferred: ["WebFetch", "WebSearch"] }));
    assert.equal(listedElsewhere.compressSurfaceOn, false, "deferred list without bili tools");
    assert.equal(listedElsewhere.mcpDialect, false);
    const noList = decide(claudeBody({ tools: ["Bash", "Read", "Glob", "Grep", "WebFetch"] }));
    assert.equal(noList.compressSurfaceOn, false, "allow-list agent with no deferred tools at all");
});

test("the tool-less rule is Claude Code only and leaves bare compress alone", () => {
    const other = decide(claudeBody({ tools: ["Bash"], billing: false }));
    assert.equal(other.compressSurfaceOn, true, "a non-Claude-Code MCP lane keeps today's default");
    assert.equal(other.mcpDialect, false);
    const bare = decide(claudeBody({ tools: ["Bash", "compress"] }));
    assert.equal(bare.compressSurfaceOn, true);
    assert.equal(bare.mcpDialect, false, "a bare declaration needs no name mapping");
});

test("an announcement inside a string message body is read too", () => {
    const parsed = { system: [BILLING], messages: [{ role: "user", content: announcement(["mcp__bili__compress"]) }], tools: [tool("Bash")] };
    assert.equal(decide(parsed).mcpDialect, true);
});
