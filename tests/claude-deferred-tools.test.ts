import assert from "node:assert/strict";
import test from "node:test";
import { extractDeferredBiliToolNames, resolveLaneDecisions } from "../src/server/lane-decisions.ts";
import { mcpBiliToolName } from "../src/compress-tool.ts";

// #6958 — Claude Code defers its MCP tools: `mcp__bili__compress` never
// appears in tools[] until the client's ToolSearch loads it; the request
// messages carry the announcement instead ("The following deferred tools are
// now available via ToolSearch … mcp__bili__compress …"). The decisions read
// tools[] ONLY, so the dialect was always false for CC and the nudge
// advertised the bare `compress`, which CC answers "No such tool available"
// — 14 field workers hard-failed, 13 of them never folded, sessions pinned
// at 133K–244K tokens (issue #6958, 81-worker sample).
//
// The fix: "the host has this tool" now means "declared in tools[] OR
// announced deferred" for BOTH the #4344 dialect decision and compress
// reachability, observed from this request's messages.
//
// Deliberately NOT the #6960 variant: its claudeCodeWithoutTool gate (no
// compress anywhere → surface off) would also starve the #4372 zombie probe
// on headerless rounds (the `pluginHeaderPresent === false` clause). That
// trade needs its own discussion and is left out here.

const CC_ANNOUNCEMENT = [
    "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded",
    "into your tool list yet. Use ToolSearch with query \"select:<name>[,<name>...]\" to load",
    "their schemas before calling them:",
    mcpBiliToolName("compress"),
    mcpBiliToolName("acp_status"),
].join("\n");

const ccParsed = {
    model: "m",
    messages: [{ role: "user", content: CC_ANNOUNCEMENT + "\n\nNow finish the task." }],
    tools: [],
};

test("#6958: a CC deferred announcement flips the MCP dialect (the field repro)", () => {
    // CC shape: plugin mode, no pluginAgent (wire-client identified), tools[]
    // empty because every bili tool is deferred into the announcement.
    const d = resolveLaneDecisions({ protocol: "openai", pluginMode: true, pluginAgent: undefined, parsed: ccParsed, shouldInject: true });
    assert.equal(d.mcpDialect, true, "announced mcp__bili__compress must enable the MCP dialect so the standing prompt teaches the name CC actually exposes");
    assert.equal(d.toolsReachable.compress, true);
    assert.equal(d.compressSurfaceOn, true);
});

test("#6958: the deferred announcement counts as reachability on a host-scoped profile", () => {
    // zcode declares toolsHostScopedByDefault:true — reachability is OBSERVED,
    // never assumed. Pre-fix a deferred-only CC-style request read unreachable
    // here; the announcement must count as "the host has this tool".
    const withAnnounce = resolveLaneDecisions({ protocol: "openai", pluginMode: true, pluginAgent: "zcode", parsed: ccParsed, shouldInject: true });
    assert.equal(withAnnounce.toolsReachable.compress, true, "deferred announcement must satisfy the observed reachability gate");

    const control = resolveLaneDecisions({ protocol: "openai", pluginMode: true, pluginAgent: "zcode", parsed: { model: "m", messages: [{ role: "user", content: "do the task" }], tools: [] }, shouldInject: true });
    assert.equal(control.toolsReachable.compress, false, "control: nothing declared, nothing announced → unreachable (surface may go silent, #4344 discipline)");
});

test("#6958: a declared bare compress still wins over the deferred MCP name", () => {
    const d = resolveLaneDecisions({
        protocol: "openai", pluginMode: true, pluginAgent: undefined,
        parsed: { model: "m", messages: [{ role: "user", content: CC_ANNOUNCEMENT }], tools: [{ type: "function", function: { name: "compress", description: "d" } }] },
        shouldInject: true,
    });
    assert.equal(d.mcpDialect, false, "bare `compress` is directly callable — the dialect note must not rebrand it");
    assert.equal(d.toolsReachable.compress, true);
});

test("#6958: the extractor reads the announcement from both message content shapes", () => {
    // openai string content
    const fromString = extractDeferredBiliToolNames(ccParsed);
    assert.ok(fromString.has(mcpBiliToolName("compress")));
    assert.ok(fromString.has(mcpBiliToolName("acp_status")));

    // anthropic block content
    const fromBlocks = extractDeferredBiliToolNames({
        model: "m",
        messages: [{ role: "user", content: [{ type: "text", text: CC_ANNOUNCEMENT }] }],
    });
    assert.ok(fromBlocks.has(mcpBiliToolName("compress")));

    // no announcement → empty (every non-CC host)
    const none = extractDeferredBiliToolNames({ model: "m", messages: [{ role: "user", content: "plain text, no tools" }] });
    assert.equal(none.size, 0);
});
