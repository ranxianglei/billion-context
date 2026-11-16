import assert from "node:assert/strict";
import test from "node:test";
import { resolveLaneDecisions } from "../src/server/lane-decisions.ts";

// #6958: Claude Code keeps MCP tools OUT of tools[] until the model loads
// them with ToolSearch; until then it lists them by name in a message:
//
//   The following deferred tools are now available via ToolSearch. Their
//   schemas are NOT loaded — calling them directly will fail with
//   InputValidationError. Use ToolSearch with query "select:<name>[,...]"
//   to load tool schemas before calling them:
//   mcp__bili__compress
//   WebFetch
//   ...
//
// bili decided both lane decisions from tools[] alone:
//   (1) mcpDialect was true only when tools[] declared mcp__bili__compress,
//       so while the tool was deferred the prompt named bare `compress` — a
//       tool that does not exist on the host (14 workers hit "No such tool
//       available: compress", 13 grew to 133K–234K tokens).
//   (2) Claude Code has no host profile, so the anonymous profile's
//       toolsHostScopedByDefault=false kept the compress surface on whatever
//       tools[] held — an agent with no bili tool was nudged 127× up to 440K
//       tokens with no way to fold.
//
// The fix reads the deferred list: mcp__bili__compress counts as listed when
// declared OR deferred, and a Claude Code request (system block carrying
// cc_version=) with no compress tool declared or listed reads as unreachable.
// Other hosts keep today's behaviour (the deferred-list header phrase is
// Claude-Code-specific).
//
// These 5 cases build anthropic-wire requests in the shape Claude Code
// 2.1.325 sends. On master, 3 of the 5 fail (cases 1, 2, 3); with the fix
// all 5 pass.

const BILLING_HEADER = "x-anthropic-billing-header: cc_version=2.1.325.ca9; cc_entrypoint=sdk-cli; cch=00000;";

/** The deferred-tools list Claude Code injects into a message: a header line
 *  ending with ":", then tool names one-per-line, a blank line ends the list. */
function deferredToolsList(names: string[]): string {
    return "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query \"select:<name>[,<name>...]\" to load tool schemas before calling them:\n" + names.join("\n");
}

/** Build an anthropic-wire body in the shape Claude Code 2.1.325 sends:
 *  billing header in the system block, optional deferred-tools list in the
 *  first user message, declared tools in tools[]. */
function ccBody(deferred: string[], declared: string[]): unknown {
    const messages: Array<{ role: string; content: string }> = [];
    if (deferred.length > 0) messages.push({ role: "user", content: deferredToolsList(deferred) });
    messages.push({ role: "user", content: "hello" }, { role: "assistant", content: "hi" });
    return {
        model: "model-test",
        system: [
            { type: "text", text: BILLING_HEADER },
            { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ],
        messages,
        ...(declared.length > 0 ? { tools: declared.map((name) => ({ name, description: "d", input_schema: { type: "object", properties: {} } })) } : {}),
        max_tokens: 64_000,
        stream: false,
    };
}

const input = (body: unknown, pluginAgent: string) => ({
    protocol: "anthropic" as const,
    pluginMode: true,
    pluginAgent,
    parsed: body,
    shouldInject: true,
    pluginHeaderPresent: true,
});

interface CaseExpect {
    mcpDialect: boolean;
    compressSurfaceOn: boolean;
}

const CASES: Array<{ name: string; body: unknown; agent: string; expect: CaseExpect }> = [
    {
        // #6958 bug 1: the tool is deferred (not in tools[]), so the prompt
        // must teach the MCP-prefixed name the host actually exposes.
        name: "deferred mcp__bili__compress → MCP dialect name in the prompt",
        body: ccBody(["mcp__bili__compress", "WebFetch"], []),
        agent: "claude",
        expect: { mcpDialect: true, compressSurfaceOn: true },
    },
    {
        // #6958 bug 2: no compress tool declared or listed → the surface is
        // off and the agent is not nudged (it has no way to fold).
        name: "no compress tool (declared or deferred) → surface off, no nudge",
        body: ccBody([], []),
        agent: "claude",
        expect: { mcpDialect: false, compressSurfaceOn: false },
    },
    {
        // #6958 bug 2: the deferred list holds other tools but not compress
        // → same as the no-tool case.
        name: "deferred list has other tools but not compress → surface off, no nudge",
        body: ccBody(["WebFetch", "WebSearch"], []),
        agent: "claude",
        expect: { mcpDialect: false, compressSurfaceOn: false },
    },
    {
        // Control: the tool is declared in tools[] (not deferred) → the MCP
        // dialect applies (passes on master).
        name: "declared mcp__bili__compress → MCP dialect name in the prompt",
        body: ccBody([], ["mcp__bili__compress"]),
        agent: "claude",
        expect: { mcpDialect: true, compressSurfaceOn: true },
    },
    {
        // Control: the bare name is declared → no MCP dialect (passes on
        // master).
        name: "declared bare compress → bare name in the prompt",
        body: ccBody([], ["compress"]),
        agent: "claude",
        expect: { mcpDialect: false, compressSurfaceOn: true },
    },
];

for (const c of CASES) {
    test(`cc-deferred ${c.name}`, () => {
        const d = resolveLaneDecisions(input(c.body, c.agent));
        assert.equal(d.mcpDialect, c.expect.mcpDialect, `mcpDialect (case=${c.name})`);
        assert.equal(d.compressSurfaceOn, c.expect.compressSurfaceOn, `compressSurfaceOn (case=${c.name})`);
    });
}

// Regression guard: a NON-Claude-Code host with no compress tool keeps today's
// behaviour (the anonymous profile's toolsHostScopedByDefault=false keeps the
// surface on). This is the "other hosts keep today's behaviour" guarantee —
// the cc_version= gate must not leak to other wires.
test("cc-deferred non-CC host with no compress tool → surface stays on (unchanged)", () => {
    const body = {
        model: "model-test",
        system: [{ type: "text", text: "You are a coding agent." }],
        messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
        max_tokens: 64_000,
        stream: false,
    };
    const d = resolveLaneDecisions(input(body, "pi"));
    assert.equal(d.compressSurfaceOn, true, "pi with no compress tool keeps the surface on");
    assert.equal(d.mcpDialect, false, "pi with no compress tool has no MCP dialect");
});
