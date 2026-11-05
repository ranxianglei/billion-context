// #3733: bili-authored dsh client compaction — the answer side of the #1729
// guard. Post-#3644 (snapshot doctrine) a landed client checkpoint no longer
// destroys the server substrate, but a NATIVE dsh checkpoint is still a
// foreign summary: recognizable only fuzzily, and possibly inconsistent with
// what the upstream actually has. When the authored-compaction knob is on and
// the session holds active fold blocks, the guard site answers the compaction
// summarize call LOCALLY instead of refusing it — zero egress, the
// autoModeForge (#2740) discipline — with OUR folded snapshot as the payload:
//
//   \x3cbili-snapshot v1 conv="…" seq="…" blocks="…" \x3e
//   [Compressed conversation section] — …
//   <block summaries, kernel render format>
//
// dsh records the response text as its checkpoint (wrapped in its own
// preamble/<compacted-summary> framing), so the client file shrinks (fixes
// #3723's unbounded growth) while the recorded content is exactly what the
// model already sees upstream — client display, upstream context and server
// state agree for the first time. The identity header line rides in the
// message TEXT (clients resend message content verbatim), so recognition on
// replay is declarative (carriesBiliSnapshotCheckpoint below) instead of
// fuzzy; the #2432 landed-checkpoint rebase keeps handling the ACP-state side
// of the landing for ANY checkpoint, authored or foreign.
//
// Precedence at the guard site: authored (this module, knob + active blocks)
// replaces the default refusal. Since #3651 removed the #2028 allowDshCompaction
// opt-out there is no forward-native path left to take precedence — calls that
// do not qualify for authoring fall through to the refusal below. The
// passthrough-lane copy of the guard (handle.ts #1117/#2709 site) has no
// session and therefore no snapshot to author; it keeps refusing.
import { renderForgedSummary, buildPromptForgeBody } from "../codex-compact.js";

/** Identity header prefix of an authored checkpoint. Angle brackets
 *  hex-escaped per KDD #2 (see dsh-compaction-guard.ts). */
export const BILI_SNAPSHOT_TAG_PREFIX = "\x3cbili-snapshot v1 ";

/** Renders the full checkpoint text for a session: one identity header line
 *  (conversation id, canonical message count, active block ids — the exact
 *  server-side anchors the refs map to) followed by every ACTIVE block's
 *  summary in the kernel render format (renderForgedSummary — the same bytes
 *  the model reads for a live kernel-rendered block, so a captured checkpoint
 *  reads identically to a live one). `seq` counts the raw messages the server
 *  has ingested for the session (messageRefs.byRaw keys). */
export function renderDshAuthoredCheckpoint(session: { id: string; state: { messageRefs: { byRaw: Record<string, unknown> }; blocks: readonly { blockId: string; active: boolean; summary: string; topic?: string }[] } }): string {
    const active = session.state.blocks.filter((b) => b.active);
    const seq = Object.keys(session.state.messageRefs.byRaw).length;
    const header = `${BILI_SNAPSHOT_TAG_PREFIX}conv="${session.id}" seq="${seq}" blocks="${active.map((b) => b.blockId).join("+")}" />`;
    if (active.length === 0) return header;
    return [header, ...active.map((b) => renderForgedSummary(b))].join("\n\n");
}

/** Landing recognition: a freshly-landed AUTHORED checkpoint is a user-role
 *  plain-text message whose text contains the identity tag. Same carrier +
 *  novelty discipline as carriesDshLocalCompactionSummary (#2621): tool
 *  results, reasoning, assistant prose and OLD ids (historical quotes of the
 *  tag) are structurally incapable of being a fresh landing. */
export function carriesBiliSnapshotCheckpoint(
    msgs: readonly { id?: unknown; role?: unknown; contentType?: unknown; text?: unknown; content?: unknown }[],
    knownIds?: ReadonlySet<string>,
): boolean {
    for (const m of msgs) {
        if (m.role !== "user" || (m.contentType !== undefined && m.contentType !== "text")) continue;
        if (knownIds !== undefined && typeof m.id === "string" && knownIds.has(m.id)) continue;
        const text = typeof m.text === "string" && m.text !== "" ? m.text : contentText(m.content);
        if (text !== "" && text.includes(BILI_SNAPSHOT_TAG_PREFIX)) return true;
    }
    return false;
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let out = "";
    for (const part of content) {
        if (typeof part === "string") out += part;
        else if (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") out += (part as { text: string }).text;
    }
    return out;
}

type WireProtocol = "openai" | "anthropic" | "responses";

/** Forged reply for a dsh compaction summarize call. `stream` honors the
 *  request's own flag. openai: chat.completions chunk stream (or JSON);
 *  anthropic: the message event order CC's parser accepts (autoModeForge
 *  shape); responses: the codex prompt-forge body (a plain assistant message
 *  item — protocol-standard, codex-specific only in name). Returns null for
 *  any other protocol (caller falls through to the refusal — dsh speaks no
 *  Google wire, and an undecidable shape must never emit a malformed
 *  response). */
export function buildDshCompactionForgeBody(
    protocol: WireProtocol,
    text: string,
    usage: { inputTokens: number; outputTokens: number },
    stream: boolean,
): { body: string; contentType: string } | null {
    const total = Math.max(1, usage.inputTokens + usage.outputTokens);
    if (protocol === "responses") {
        return buildPromptForgeBody(text, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: total }, stream);
    }
    if (protocol === "openai") {
        const id = `chatcmpl_bili_${Date.now().toString(36)}`;
        if (!stream) {
            return {
                body: JSON.stringify({
                    id,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: "bili-authored-compaction",
                    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
                    usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: total },
                }),
                contentType: "application/json",
            };
        }
        const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
        let body = "";
        body += frame({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        body += frame({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        body += frame({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: total } });
        body += "data: [DONE]\n\n";
        return { body, contentType: "text/event-stream" };
    }
    if (protocol === "anthropic") {
        const id = `msg_bili_compact_${Date.now().toString(36)}`;
        const inputTokens = Math.max(1, usage.inputTokens);
        const outputTokens = Math.max(1, usage.outputTokens);
        if (!stream) {
            return {
                body: JSON.stringify({
                    id,
                    type: "message",
                    role: "assistant",
                    model: "bili-authored-compaction",
                    content: [{ type: "text", text }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
                }),
                contentType: "application/json",
            };
        }
        const sse = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        let body = "";
        body += sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "bili-authored-compaction", content: [], usage: { input_tokens: inputTokens, output_tokens: 0 } } });
        body += sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        body += sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
        body += sse("content_block_stop", { type: "content_block_stop", index: 0 });
        body += sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } });
        body += sse("message_stop", { type: "message_stop" });
        return { body, contentType: "text/event-stream" };
    }
    return null;
}
