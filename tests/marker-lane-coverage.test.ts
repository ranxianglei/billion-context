// #2811 plan B coverage contract: every raw-stage marker class from
// src/marker/spec.ts is stripped (or deliberately preserved, when a
// downstream stage owns it) on EVERY wire protocol through the one engine.
//
// This is the leak-matrix pin: the打桩 audit (issue #2811) found google
// stripped none of these (#2798) and anthropic/openai/responses only
// head-lines (#2789). If a class regresses on any wire, this file goes red
// BEFORE the field does.
import test from "node:test";
import assert from "node:assert/strict";
import { stripRawStage, type RawStripCounts } from "../src/marker/engine.ts";
import { MARKER_SPECS, type MarkerId, type MarkerScope, type MarkerSpec, type MarkerStage } from "../src/marker/spec.ts";
import { MARKER_INTEGRITY_NOTE } from "../src/marker/anchors.ts";
import { buildVisibilityMarker } from "../src/loop/core.ts";

// ── fixtures, one per MarkerId (raw stage) ────────────────────────────────
const DIGEST = "sha256:" + "ab".repeat(32);
const CHAIN_CARRIER = `\x3cbili-chain v="1" processor="leaked-instance" issued-at="1760000000000" request-id="r-old-a" digest="${DIGEST}"/\x3e`;
const PANEL_MESSAGE = "[acp-cache] grand ledger: 4.8% hit rate over 9 requests\n[/acp-cache]";
// #2789 shape: head line + contiguous report body sections; the prose lines
// around it must survive.
const STATUS_BODY_MESSAGE =
    "prose before the report\n" +
    "📦 [ACP] acp_status result:\n" +
    "  ACTIVE SURFACE 61% of window\n" +
    "  CONTEXT BREAKDOWN\n" +
    "    raw history       38,412 tok (14.7%)\n" +
    "  COMPRESSED BLOCKS\n" +
    "    b1 | m00001–m00003 | 63% saved\n" +
    "  BILLED INPUT 104,100 tok\n" +
    "prose after the report";
const WRAPPED_STATUS = buildVisibilityMarker("acp_status", "Compressible ranges (1):\n  m00001–m00010 | synthetic stale range").trim();
const MARKER_LINE_MESSAGE =
    "user prose stays\n📦 [ACP] Compressed m00001–m00110 → b7\n❌ [ACP] compress FAILED: range cannot be anchored\nand so does this";
// #1357: a FOREIGN literal tag is user data — raw stage keeps it byte-intact
// (advisory processing); own echoes are stripped at the projection layer.
// KDD#2: complete tags are hex-escaped in source.
const RENDER_TAG_PROSE = 'the panel said \x3cacp tokens="60" type="text"\x3em00123\x3c/acp\x3e and that is all';
const NUDGE_ECHO = "This is an efficiency nudge to compress early." + MARKER_INTEGRITY_NOTE;
// Deliberately PRESERVED at raw stage — owned downstream:
const SUMMARY_ANCHOR = "[Compressed conversation section] m00001–m00080";
const CODEX_HANDOFF = "[bili] context summary after compaction:";

type Case = { name: string; text: string };

const userCases: Case[] = [
    { name: "panel", text: PANEL_MESSAGE },
    { name: "status body", text: STATUS_BODY_MESSAGE },
    { name: "wrapped status body", text: WRAPPED_STATUS },
    { name: "orphaned status body", text: WRAPPED_STATUS.slice(WRAPPED_STATUS.indexOf("[acp-status]")) },
    { name: "marker lines", text: MARKER_LINE_MESSAGE },
    { name: "render tag", text: RENDER_TAG_PROSE },
    { name: "chain carrier", text: CHAIN_CARRIER },
    { name: "summary anchor (state-owned)", text: SUMMARY_ANCHOR },
    { name: "codex handoff (absorb-owned)", text: CODEX_HANDOFF },
    { name: "plain user text", text: "plain q1" },
];

function assertStripped(body: unknown, counts: RawStripCounts, label: string): void {
    const json = JSON.stringify(body);
    assert.ok(!json.includes("[acp-cache]"), `${label}: panel message must be gone`);
    assert.ok(!json.includes("acp_status result:"), `${label}: status body head must be gone`);
    assert.ok(!json.includes("ACTIVE SURFACE"), `${label}: status body sections must be gone`);
    assert.ok(!json.includes("CONTEXT BREAKDOWN"), `${label}: status body sections must be gone (2)`);
    assert.ok(!json.includes("synthetic stale range"), `${label}: wrapped and orphaned status bodies must be gone`);
    assert.ok(!json.includes("[acp-status]"), `${label}: status wrappers must be gone`);
    assert.ok(!json.includes("Compressed m00001–m00110"), `${label}: confirmation marker line must be gone`);
    assert.ok(!json.includes("compress FAILED"), `${label}: failure marker line must be gone`);
    assert.ok(!json.includes(DIGEST), `${label}: chain carrier must be gone`);
    assert.ok(!json.includes("efficiency nudge"), `${label}: nudge echo must be gone`);
    assert.ok(!json.includes("MARKER integrity"), `${label}: integrity note must be gone`);
    // preserved prose + downstream-owned shapes
    assert.ok(json.includes("plain q1"), `${label}: plain user text survives`);
    assert.ok(json.includes("prose before the report"), `${label}: prose around a status body survives`);
    assert.ok(json.includes("prose after the report"), `${label}: prose around a status body survives (2)`);
    assert.ok(json.includes("user prose stays"), `${label}: prose around marker lines survives`);
    assert.ok(json.includes("and so does this"), `${label}: prose around marker lines survives (2)`);
    assert.ok(json.includes("the panel said"), `${label}: prose around a render tag survives`);
    // note: needle must avoid double quotes — JSON.stringify escapes them
    assert.ok(json.includes("m00123\x3c/acp\x3e"), `${label}: foreign literal tag survives raw stage (#1357 advisory)`);
    assert.ok(json.includes(SUMMARY_ANCHOR), `${label}: summary anchors are state-stage, raw must keep them`);
    assert.ok(json.includes(CODEX_HANDOFF), `${label}: codex handoff is absorb-owned, raw must keep it`);
    // counts
    assert.ok(counts.panels >= 1, `${label}: panel counted`);
    assert.ok(counts.statusBodies >= 1, `${label}: status body counted`);
    assert.ok(counts.statusBodyLines >= 4, `${label}: status body lines counted`);
    assert.ok(counts.markerLines >= 2, `${label}: marker lines counted`);
    assert.ok(counts.carriers >= 1, `${label}: carrier counted`);
}

test("engine: anthropic/openai messages walk strips every raw class", () => {
    for (const wire of ["anthropic", "openai"] as const) {
        const body = {
            messages: [
                // whole-message classes arrive as standalone messages
                { role: "user", content: PANEL_MESSAGE },
                { role: "user", content: NUDGE_ECHO },
                // span/line/block classes share one message as text parts
                { role: "user", content: userCases.filter((c) => c.name !== "panel").map((c) => ({ type: "text", text: c.text })) },
                { role: "assistant", content: "assistant ack" },
                // latest user turn (paste guard): plain text, nothing to strip
                { role: "user", content: "latest turn question" },
            ],
        };
        const counts = stripRawStage(body, wire);
        assertStripped(body, counts, wire);
        // whole-message classes splice the message itself
        const json = JSON.stringify(body);
        assert.ok(!json.includes('"type":"text","text":"[acp-cache]'), `${wire}: panel message spliced`);
        assert.ok(body.messages.length === 3, `${wire}: panel + nudge messages spliced (2 of 5 gone)`);
        assert.ok(json.includes("latest turn question"), `${wire}: latest user turn survives`);
    }
});

test("engine: google contents walk strips every raw class (#2798 pin)", () => {
    const body = {
        contents: [
            { role: "user", parts: [{ text: PANEL_MESSAGE }] },
            { role: "user", parts: [{ text: NUDGE_ECHO }] },
            {
                role: "user",
                parts: userCases.filter((c) => c.name !== "panel").map((c) => ({ text: c.text })),
            },
            { role: "model", parts: [{ text: "model ack" }] },
            { role: "user", parts: [{ text: "latest turn question" }] },
        ],
    };
    const counts = stripRawStage(body, "google");
    assertStripped(body, counts, "google");
    assert.ok(body.contents.length === 3, "google: panel + nudge contents spliced (2 of 5 gone)");
});

test("engine: responses input walk strips every raw class", () => {
    const body = {
        instructions: "sys",
        input: [
            { type: "message", role: "user", content: PANEL_MESSAGE },
            { type: "message", role: "user", content: NUDGE_ECHO },
            {
                type: "message",
                role: "user",
                content: userCases.filter((c) => c.name !== "panel").map((c) => ({ type: "input_text", text: c.text })),
            },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "assistant ack" }] },
            // carrier in its native responses part form (single-key input_text part)
            { type: "message", role: "user", content: [{ type: "input_text", text: CHAIN_CARRIER }] },
            { type: "message", role: "user", content: "latest turn question" },
        ],
    };
    const counts = stripRawStage(body, "responses");
    assertStripped(body, counts, "responses");
    // panel (string content) + nudge + native carrier messages spliced;
    // the multi-part message keeps its shape with the carrier part gone
    assert.ok(body.input.length === 3, `responses: panel/nudge/carrier messages spliced (got ${body.input.length} of 6)`);
});

test("engine: the declarative spec table and the engine agree on raw-stage classes", () => {
    // contract both directions: every raw-stage id the table declares is one
    // this file proves behaviorally, and every class the engine counts is a
    // row in the table (no silently-added class).
    const byStage = (s: MarkerSpec, stage: MarkerStage): boolean => s.stage === stage;
    const scopeOf = (s: MarkerSpec): MarkerScope => s.scope;
    const rawIds = MARKER_SPECS.filter((s) => byStage(s, "raw")).map((s) => s.id as MarkerId).sort();
    for (const s of MARKER_SPECS) void scopeOf(s);
    assert.deepEqual(rawIds, [
        "acp_panel_message",
        "acp_status_body",
        "chain_carrier",
        "confirmation_marker",
        "forged_header",
        "marker_line",
        "nudge_echo",
    ]);
    // render_tag lives at the projection layer by design (#1357): the raw
    // stage must NEVER strip a foreign literal tag from user text.
    assert.ok(!rawIds.includes("render_tag"));
    const counted = ["panels", "statusBodies", "markerLines", "nudges", "carriers"] as const;
    assert.equal(Object.keys(stripRawStage({ messages: [] }, "anthropic")).length, counted.length + 1, "counts shape unchanged: spec/engine drift check");
});

test("engine: degraded slots become a space, never an empty string (#1542 zombie guard)", () => {
    const body = {
        messages: [
            { role: "assistant", content: "📦 [ACP] Compressed m00001–m00010 → b5", tool_calls: [{ id: "t1", function: { name: "compress", arguments: "{}" } }] },
        ],
    };
    stripRawStage(body, "openai");
    assert.equal(body.messages[0]!.content, " ", "assistant slot degrades to one space so tool_calls survive");
    assert.ok(Array.isArray(body.messages[0]!.tool_calls), "tool_calls untouched");
});

// ── KDD #10: signed reasoning rides byte-for-byte through the raw walk ────
// The review of the leak matrix (issue #2811, comment 6110433698) pinned the
// fatality class: any rewrite of signed text (Anthropic thinking blocks,
// Gemini thought parts + thoughtSignature, OpenAI reasoning_content) desyncs
// it from its signature and bricks replay (#1882 / #1960). These fixtures
// put marker-shaped text INSIDE every signed slot and assert the walk leaves
// the containing message byte-identical.
test("engine: signed thinking slots are byte-invariant under the raw walk (KDD #10)", () => {
    const poisoned = WRAPPED_STATUS + "\nmodel thought\n📦 [ACP] Compressed m00001–m00010 → b5\n\x3cacp tokens=\"9\" type=\"text\"\x3em00001\x3c/acp\x3e tail";

    // anthropic: {type:"thinking", thinking, signature} block — text field is
    // `.thinking`, and the explicit gate must hold even if a future shape
    // adds `.text`.
    {
        const body = {
            messages: [
                { role: "assistant", content: [{ type: "thinking", thinking: poisoned, signature: "sig-1", text: poisoned }] },
                { role: "user", content: "📦 [ACP] Compressed m00001–m00010 → b5" },
            ],
        };
        const before = JSON.stringify(body.messages[0]);
        stripRawStage(body, "anthropic");
        assert.equal(JSON.stringify(body.messages[0]), before, "anthropic thinking block must ride byte-for-byte");
        assert.equal((body.messages[1] as { content: string }).content, " ", "non-signed user slot still strips");
    }

    // google: {text, thought:true} and {text, thoughtSignature} parts
    {
        const body = {
            contents: [
                { role: "model", parts: [{ text: poisoned, thought: true }] },
                { role: "model", parts: [{ text: poisoned, thoughtSignature: "sig-2" }] },
                { role: "user", parts: [{ text: poisoned }] },
            ],
        };
        const b0 = JSON.stringify(body.contents[0]);
        const b1 = JSON.stringify(body.contents[1]);
        stripRawStage(body, "google");
        assert.equal(JSON.stringify(body.contents[0]), b0, "google thought:true part must ride byte-for-byte");
        assert.equal(JSON.stringify(body.contents[1]), b1, "google thoughtSignature part must ride byte-for-byte");
        const strippedText = (body.contents[2] as { parts: { text: string }[] }).parts[0]!.text;
        assert.ok(!strippedText.includes("Compressed m00001–m00010"), "plain google text slot still strips the marker line");
        assert.ok(strippedText.includes(" tail"), "non-marker prose survives");
    }

    // openai: reasoning_content is never a strip slot
    {
        const body = {
            messages: [
                { role: "assistant", content: "ok", reasoning_content: poisoned },
                { role: "assistant", content: poisoned },
            ],
        };
        const before = JSON.stringify(body.messages[0]);
        stripRawStage(body, "openai");
        assert.equal(JSON.stringify(body.messages[0]), before, "openai reasoning_content must ride byte-for-byte");
        const openaiText = (body.messages[1] as { content: string }).content;
        assert.ok(!openaiText.includes("Compressed m00001–m00010"), "assistant content slot still strips the marker line");
        assert.ok(openaiText.includes(" tail"), "non-marker prose survives (openai control)");
    }

    // responses: {type:"reasoning", …} items are type-gated out of the walk
    {
        const body = {
            input: [
                { type: "reasoning", summary: [{ type: "summary_text", text: poisoned }], content: poisoned },
                { type: "message", role: "user", content: poisoned },
            ],
        };
        const before = JSON.stringify(body.input[0]);
        stripRawStage(body, "responses");
        assert.equal(JSON.stringify(body.input[0]), before, "responses reasoning item must ride byte-for-byte");
        const respText = (body.input[1] as { content: string }).content;
        assert.ok(!respText.includes("Compressed m00001–m00010"), "message content slot still strips the marker line");
        assert.ok(respText.includes(" tail"), "non-marker prose survives (responses control)");
    }
});

// ── #2815 review point 3: the current turn is not an echo ─────────────────
// The raw layer cannot tell an echoed report from a user PASTING one to
// report a bug. Resolution: the LATEST user message is the current turn —
// status-body consumption skips it entirely (marker head lines still strip,
// which the review acknowledged); every resent position still consumes.
test("engine: a report pasted into the latest user message survives (paste guard)", () => {
    for (const wire of ["anthropic", "openai"] as const) {
        const body = {
            messages: [
                { role: "user", content: "old question" },
                { role: "assistant", content: STATUS_BODY_MESSAGE },
                { role: "user", content: STATUS_BODY_MESSAGE },
            ],
        };
        const counts = stripRawStage(body, wire);
        assert.equal(counts.statusBodies, 1, `${wire}: older assistant echo consumed, current-turn paste kept`);
        const json = JSON.stringify(body);
        assert.ok(json.includes("ACTIVE SURFACE"), `${wire}: pasted report body survives in the latest user message`);
        assert.ok(!json.includes('"content":"prose before the report\\n📦 [ACP] acp_status result:\\n  ACTIVE SURFACE'), `${wire}: older positions still consume`);
    }
    // google + responses: same guard on their native shapes
    const g = { contents: [
        { role: "model", parts: [{ text: STATUS_BODY_MESSAGE }] },
        { role: "user", parts: [{ text: STATUS_BODY_MESSAGE }] },
    ] };
    const gc = stripRawStage(g, "google");
    assert.equal(gc.statusBodies, 1, "google: model echo consumed, current-turn paste kept");
    assert.ok(JSON.stringify(g).includes("ACTIVE SURFACE"), "google: pasted body survives");
    const r = { input: [
        { type: "message", role: "assistant", content: STATUS_BODY_MESSAGE },
        { type: "message", role: "user", content: STATUS_BODY_MESSAGE },
    ] };
    const rc = stripRawStage(r, "responses");
    assert.equal(rc.statusBodies, 1, "responses: assistant echo consumed, current-turn paste kept");
    assert.ok(JSON.stringify(r).includes("ACTIVE SURFACE"), "responses: pasted body survives");
});


test("engine: wrapped current-user reports survive on every wire", () => {
    for (const wire of ["openai", "anthropic", "responses", "google"] as const) {
        const messages = [
            { type: "message", role: "assistant", content: WRAPPED_STATUS },
            { type: "message", role: "user", content: WRAPPED_STATUS },
        ];
        const body = wire === "google"
            ? { contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })) }
            : wire === "responses" ? { input: messages } : { messages };
        assert.equal(stripRawStage(body, wire).statusBodies, 1, wire);
        assert.equal(JSON.stringify(body).split("synthetic stale range").length - 1, 1, `${wire}: only current paste survives`);
    }
});

test("engine: wrapped-only assistant content becomes a space without rewriting tool calls", () => {
    const toolCalls = [{ id: "t1", type: "function", function: { name: "write", arguments: JSON.stringify({ text: WRAPPED_STATUS }) } }];
    for (const content of [WRAPPED_STATUS, WRAPPED_STATUS.slice(WRAPPED_STATUS.indexOf("[acp-status]"))]) {
        const body = { messages: [{ role: "assistant", content, tool_calls: toolCalls }] };
        const before = JSON.stringify(toolCalls);
        assert.equal(stripRawStage(body, "openai").statusBodies, 1);
        assert.equal(body.messages[0].content, " ");
        assert.equal(JSON.stringify(body.messages[0].tool_calls), before);
    }
});
