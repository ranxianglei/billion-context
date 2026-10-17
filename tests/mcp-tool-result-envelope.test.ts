// #3472: Claude Code 2.1.300 replaces a SUCCESSFUL MCP result's content array
// with JSON.stringify of its structuredContent record (error results keep their
// text), so the text channel alone never reached the model for the prose-only
// panel tools (acp_status/acp_cache) — it saw `{"outcome":"success"}`.
// This suite pins the envelope itself, host-free: content stays byte-identical,
// structuredContent keeps its outcome/blocksCreated contract, and the report
// text rides inside it as `text`. The wire-level suite through the real stdio
// shim (issue3472-mcp-structured-text.test.ts) covers the per-tool paths.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mcpToolResultEnvelope, type McpForwardedToolResult } from "../src/mcp.ts";

const PANEL = "ACP CACHE REPORT (12:29:18) — 45 requests\n[summary] cache hit 81.0% · per-fold breakeven 6 turns";

function textOf(env: Record<string, unknown>): string {
    const content = env.content as Array<{ text: string }>;
    return content[0]!.text;
}

describe("mcpToolResultEnvelope", () => {
    it("keeps a legacy result byte-identical: no structuredContent at all", () => {
        const env = mcpToolResultEnvelope({ text: PANEL, failed: false });
        assert.deepEqual(env, { content: [{ type: "text", text: PANEL }], isError: false });
        assert.equal("structuredContent" in env, false);
    });

    it("carries the report inside structuredContent for a successful panel tool", () => {
        const env = mcpToolResultEnvelope({ text: PANEL, failed: false, outcome: "success" });
        assert.deepEqual(env.content, [{ type: "text", text: PANEL }]);
        assert.deepEqual(env.structuredContent, { text: PANEL, outcome: "success" });
        // The host substitutes JSON.stringify(structuredContent) for content —
        // this is the exact string the model then sees.
        assert.match(JSON.stringify(env.structuredContent), /ACP CACHE REPORT/);
    });

    it("carries text alongside outcome/blocksCreated on a compress result", () => {
        const env = mcpToolResultEnvelope({ text: PANEL, failed: false, outcome: "applied", blocksCreated: 2 });
        assert.deepEqual(env.structuredContent, { text: PANEL, outcome: "applied", blocksCreated: 2 });
    });

    it("keeps structuredContent.text === content[0].text for every shape", () => {
        const shapes: McpForwardedToolResult[] = [
            { text: PANEL, failed: false, outcome: "success" },
            { text: PANEL, failed: false, outcome: "applied", blocksCreated: 1 },
            { text: PANEL, failed: false, outcome: "partial", blocksCreated: 1 },
            { text: PANEL, failed: true, outcome: "refused" },
            { text: PANEL, failed: true, outcome: "failure" },
            { text: "", failed: false, outcome: "success" },
        ];
        for (const out of shapes) {
            const env = mcpToolResultEnvelope(out);
            assert.equal(textOf(env), out.text, "content text is the report");
            assert.equal((env.structuredContent as { text: string }).text, out.text, `mirror holds for ${out.outcome}`);
        }
    });

    it("still carries the text field when there is no report body", () => {
        // Empty, not absent: one shape, no reader has to ask why text vanished.
        const env = mcpToolResultEnvelope({ text: "", failed: false, outcome: "success" });
        assert.deepEqual(env.structuredContent, { text: "", outcome: "success" });
    });

    it("keeps isError semantics and still mirrors the report for a failure receipt", () => {
        const failed = mcpToolResultEnvelope({ text: PANEL, failed: true, outcome: "refused" });
        assert.equal(failed.isError, true);
        assert.deepEqual(failed.structuredContent, { text: PANEL, outcome: "refused" });
    });

    it("mirrors the partial note verbatim — it is part of the text channel", () => {
        const text = `${PANEL}\n[acp-result: PARTIAL …]`;
        const env = mcpToolResultEnvelope({ text, failed: false, outcome: "partial", blocksCreated: 1 });
        assert.deepEqual(env.structuredContent, { text, outcome: "partial", blocksCreated: 1 });
        assert.deepEqual(env.content, [{ type: "text", text }]);
    });
});
