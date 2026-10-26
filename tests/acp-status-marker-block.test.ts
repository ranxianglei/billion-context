import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVisibilityMarker } from "../src/loop/core.ts";
import { stripAcpStatusMarkers, stripAcpStatusBlocks, STATUS_REPORT_OPEN, STATUS_REPORT_CLOSE } from "../src/acp-panel.ts";
import { stripAcpTags } from "../src/loop/tag-echo-filter.ts";

// A realistic renderOverview + handleAcpStatus extras body (the shape that
// used to be left orphaned by the line-granular strip, issue #2789).
const REPORT = [
    "ACTIVE SURFACE: pack=default | host=billion-context 0.1.192 (abc1234)",
    "",
    "CONTEXT BREAKDOWN",
    "  0 tool (0%) | 0 text (0%) | 27.1K summaries (100%)",
    "",
    "COMPRESSED BLOCKS — 2 active (1.2K summary, 95.0K original)",
    "",
    '  b1 (T1)  474.4K→169  3 msgs  "preflight overflow compress"',
    '  b2 (T1)  400.0K→150  5 msgs  "exploration"',
    "",
    'Tip: buildStatusReport({scope:"uncompressed", view:"messages", tool:"bash"}) for per-message listing',
].join("\n");

const EXTRAS = [
    "",
    "BILLED INPUT (upstream usage): 912625 tok · est-view total 516609 tok · ratio 1.8×",
    "Nudge: ACTIVE — EMERGENCY T2 distill: max pending 27093, usage 122%",
    "Compressible ranges (1, oldest first):",
    "  m00005–m00040  36 msgs  48.2K [tool 90% | text 10%]",
    "STORAGE — ok",
].join("\n");

test("#2789: buildVisibilityMarker wraps the acp_status body in the sentinel pair", () => {
    const marker = buildVisibilityMarker("acp_status", REPORT);
    assert.equal(marker, `\n📊 [ACP] acp_status result:\n${STATUS_REPORT_OPEN}\n${REPORT}\n${STATUS_REPORT_CLOSE}\n`);
});

test("#2789: single-line markers are unchanged", () => {
    assert.equal(
        buildVisibilityMarker("search_context", '[Found 3 blocks matching "auth"]'),
        '\n🔍 [ACP] Found 3 blocks matching "auth"\n',
    );
    assert.equal(
        buildVisibilityMarker("compress", "[FAILED] invalid range spec"),
        "\n❌ [ACP] FAILED] invalid range spec\n",
    );
});

test("#2789: incoming strip removes the whole new-form block and keeps surrounding prose", () => {
    const marker = buildVisibilityMarker("acp_status", REPORT);
    const messages = [{ role: "assistant", content: `I'll reassess the current state.\n${marker}\nNow I will fold that range.` }];
    const n = stripAcpStatusMarkers(messages);
    assert.equal(n, 1);
    const out = (messages[0] as { content: string }).content;
    assert.ok(!out.includes("ACTIVE SURFACE"));
    assert.ok(!out.includes(STATUS_REPORT_OPEN) && !out.includes(STATUS_REPORT_CLOSE));
    assert.ok(!out.includes("acp_status result:"));
    assert.ok(out.includes("I'll reassess the current state."));
    assert.ok(out.includes("Now I will fold that range."));
});

test("#2789: legacy (pre-pair) bodies are consumed by report grammar and stop at prose", () => {
    const legacy = `intro\n📊 [ACP] acp_status result:\n${REPORT}${EXTRAS}\n\nAlright, let me fold that range.`;
    const messages = [{ role: "assistant", content: legacy }];
    const n = stripAcpStatusMarkers(messages);
    assert.equal(n, 1);
    const out = (messages[0] as { content: string }).content;
    assert.ok(!out.includes("ACTIVE SURFACE"));
    assert.ok(!out.includes("BILLED INPUT"));
    assert.ok(!out.includes("Nudge: ACTIVE"));
    assert.ok(!out.includes("STORAGE — ok"));
    assert.ok(out.startsWith("intro"));
    assert.ok(out.includes("Alright, let me fold that range."), `prose after the report survives, got: ${JSON.stringify(out)}`);
});

test("#2789: legacy body at end of message is fully consumed; marker-only message degrades to a space", () => {
    const messages = [{ role: "assistant", content: `📊 [ACP] acp_status result:\n${REPORT}` }];
    stripAcpStatusMarkers(messages);
    assert.equal((messages[0] as { content: string }).content, " ");
});

test("#2789: head-only marker (truncated before any body) strips just the head", () => {
    const out = stripAcpStatusBlocks(`before\n📊 [ACP] acp_status result:`);
    assert.equal(out, "before");
});

test("#2789: sentinel open without close (message cut mid-report) consumes to end of message", () => {
    const out = stripAcpStatusBlocks(
        `start\n📊 [ACP] acp_status result:\n${STATUS_REPORT_OPEN}\nACTIVE SURFACE: pack=default\nCONTEXT BREAKDOWN`,
    );
    assert.equal(out, "start");
});

test("#2789: single-line markers keep their line-only semantics (#1029)", () => {
    const s = "a\n📦 [ACP] Compressed m00010–m00040 → 1 block(s).\nb";
    const out = stripAcpStatusBlocks(s);
    assert.equal(out, "a\nb");
});

test("#2789: multiple markers in one message are all removed", () => {
    const s = buildVisibilityMarker("acp_status", REPORT) + buildVisibilityMarker("search_context", '[Found 2 blocks matching "x"]');
    const messages = [{ role: "assistant", content: s }];
    const n = stripAcpStatusMarkers(messages);
    assert.equal(n, 2);
    assert.equal((messages[0] as { content: string }).content, " ");
});

test("#2789: non-marker [ACP] prose survives the incoming strip", () => {
    const s = "The label X [ACP] Y stays.\nnote 📊 [ACP] docs inline\n见[ACP]标记的含义如下";
    const messages = [{ role: "user", content: s }];
    stripAcpStatusMarkers(messages);
    assert.equal((messages[0] as { content: string }).content, s);
});

test("#2789: array content parts are cleaned per part", () => {
    const marker = buildVisibilityMarker("acp_status", REPORT);
    const messages = [{ role: "user", content: [{ type: "input_text", text: `q1` }, { type: "input_text", text: `\n${marker}` }] }];
    const n = stripAcpStatusMarkers(messages);
    assert.equal(n, 1);
    const parts = (messages[0] as { content: Array<{ text: string }> }).content;
    assert.equal(parts[0]!.text, "q1");
    assert.equal(parts[1]!.text, " ");
});

test("#2789: outgoing forged-marker filter stays head-only (#717 contract)", () => {
    const s = `intro\n📊 [ACP] acp_status result:\nBreakdown: 4.2K system (21%)\ntail`;
    assert.equal(stripAcpTags(s), "intro\nBreakdown: 4.2K system (21%)\ntail");
});
