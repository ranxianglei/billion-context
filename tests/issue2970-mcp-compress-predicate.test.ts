// #2970: hideConsumedCompressCalls recognized only the bare "compress" name, so
// MCP-lane hosts (tools named mcp__bili__<name>) bypassed inactive-call cleanup
// + live-range arg reduction. The host now routes the MCP compress form through
// the kernel's isCompressTool hook (wired in src/config.ts loadOptions), mirroring
// the #2578 isToolProtected wiring. Pins the predicate truth table + that wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOptions, isMcpBiliCompress } from "../src/config.ts";

test("isMcpBiliCompress recognizes exactly the compress tool forms", () => {
    // Bare name stays true so proxy / in-process lanes remain byte-identical.
    assert.equal(isMcpBiliCompress("compress"), true);
    assert.equal(isMcpBiliCompress("mcp__bili__compress"), true);
    // acp_rule is also MCP-exposed but is NOT a compress tool: matching it would
    // make its calls eligible for summary/arg stripping. Must stay false.
    assert.equal(isMcpBiliCompress("mcp__bili__acp_rule"), false);
    assert.equal(isMcpBiliCompress("acp_rule"), false);
    assert.equal(isMcpBiliCompress("mcp__bili__decompress"), false);
    assert.equal(isMcpBiliCompress("mcp__bili__search_context"), false);
    assert.equal(isMcpBiliCompress("mcp__bili__acp_status"), false);
    assert.equal(isMcpBiliCompress("mcp__other__compress"), false);
    assert.equal(isMcpBiliCompress("mcp__bili__xcompress"), false);
    assert.equal(isMcpBiliCompress("mcp__bili__compresses"), false);
    assert.equal(isMcpBiliCompress("mcp__bili__"), false);
});

test("loadOptions wires the MCP compress predicate into kernelConfig", () => {
    const pred = loadOptions({}).kernelConfig.isCompressTool;
    assert.equal(typeof pred, "function", "kernelConfig.isCompressTool is wired");
    assert.equal(pred!("compress"), true);
    assert.equal(pred!("mcp__bili__compress"), true);
    assert.equal(pred!("mcp__bili__acp_rule"), false);
    assert.equal(pred!("mcp__other__compress"), false);
});
