import { randomUUID } from "node:crypto";
import type { CompressionBlock } from "acp-kernel";
import type { Session } from "./session.js";

export const CODEX_COMPACT_ID_PREFIX = "fc_bili_";
export const CODEX_COMPACT_SENTINEL = "bili:acp:";

const CODEX_UA_PREFIXES = ["codex_cli_rs/", "codex_exec/"];

export type CodexCompactMode = "intercept" | "pass";

// Read per-request (not cached at startup) so a running proxy can flip the
// kill-switch without a restart.
export function codexCompactMode(): CodexCompactMode {
    const v = process.env.BILI_CODEX_COMPACT?.trim().toLowerCase();
    return v === "pass" ? "pass" : "intercept";
}

// The `originator` header is only sent for non-default thread originators, so
// the UA prefix (DEFAULT_ORIGINATOR in codex's default_client.rs) is the
// reliable client signal.
export function isCodexClient(headers: Record<string, string | string[] | undefined>): boolean {
    const ua = headers["user-agent"];
    if (!ua) return false;
    const s = Array.isArray(ua) ? ua[0] : ua;
    return typeof s === "string" && CODEX_UA_PREFIXES.some((p) => s.startsWith(p));
}

export function hasCompactionTrigger(input: unknown): boolean {
    if (!Array.isArray(input)) return false;
    const last = input[input.length - 1] as { type?: unknown } | undefined;
    return last?.type === "compaction_trigger";
}

// Recognize a compaction item WE generated (id prefix or sentinel in the blob).
// Codex echoes it back in the next request; stripping it keeps the summary
// sourced from state (no double-count). Real OpenAI blobs carry neither marker,
// so they are left untouched.
export function isBiliCompactionItem(item: unknown): boolean {
    const it = item as { type?: unknown; id?: unknown; encrypted_content?: unknown } | null;
    if (!it || it.type !== "compaction") return false;
    if (typeof it.id === "string" && it.id.startsWith(CODEX_COMPACT_ID_PREFIX)) return true;
    if (typeof it.encrypted_content === "string" && it.encrypted_content.startsWith(CODEX_COMPACT_SENTINEL)) return true;
    return false;
}

export function stripBiliCompactionItems<T>(input: T[]): T[] {
    return input.filter((item) => !isBiliCompactionItem(item));
}

// The summary text a forged blob carries (sentinel-prefixed plaintext).
export function extractBiliSummary(item: unknown): string | undefined {
    const it = item as { encrypted_content?: unknown } | null;
    if (!it || typeof it.encrypted_content !== "string") return undefined;
    if (!it.encrypted_content.startsWith(CODEX_COMPACT_SENTINEL)) return undefined;
    const text = it.encrypted_content.slice(CODEX_COMPACT_SENTINEL.length);
    return text.length > 0 ? text : undefined;
}

// An echoed fc_bili_ compaction item is REPLACED (in place) by a plain user
// message carrying the extracted summary — a history-borne handoff the kernel
// can fold again and codex's retention keeps. Rare bounded duplication (a
// block whose anchors survived the truncation also renders) is accepted over
// data loss. Marker items without an extractable blob (id-prefix-only, e.g.
// minted by an older build) are still dropped; real OpenAI blobs pass through
// untouched.
export function replaceBiliCompactionItems<T>(input: T[]): { items: T[]; replaced: number; dropped: number } {
    const items: T[] = [];
    let replaced = 0;
    let dropped = 0;
    for (const item of input) {
        if (!isBiliCompactionItem(item)) {
            items.push(item);
            continue;
        }
        const summary = extractBiliSummary(item);
        if (summary === undefined) {
            dropped++;
            continue;
        }
        items.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `[bili] context summary after compaction:\n${summary}` }],
        } as T);
        replaced++;
    }
    return { items, replaced, dropped };
}

// Safety valve preconditions (#332): evaluable BEFORE the kernel transform so
// the pipeline can dispatch a compaction request (forge vs verbatim
// passthrough) before prepare/preflight touch payload or state. 90% is codex's
// own auto-compact point — above it, native compaction must backstop.
export function codexCompactGatePre(session: Session, effectiveLimit: number): boolean {
    if (effectiveLimit <= 0) return false;
    if (session.stats.lastInputTokens >= effectiveLimit * 0.9) return false;
    return session.state.blocks.some((b) => b.active);
}

// Full safety valve: forge only when the kernel transform also succeeded.
export function codexCompactGate(session: Session, effectiveLimit: number, transformOk: boolean): boolean {
    return transformOk && codexCompactGatePre(session, effectiveLimit);
}

// Minimal legal forged reply for the trigger form. Streaming: exactly one
// compaction output item + response.completed (codex's parser,
// codex-api/src/sse/responses.rs, ignores every other event kind and requires
// response.completed to parse with id + usage). Non-streaming: the JSON
// response shape {id, output, usage}.
export function buildTriggerForgeBody(
    summaryText: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    stream: boolean,
): { body: string; contentType: string } {
    const compactionItem = {
        type: "compaction",
        id: `${CODEX_COMPACT_ID_PREFIX}${randomUUID()}`,
        encrypted_content: `${CODEX_COMPACT_SENTINEL}${summaryText}`,
    };
    const usageJson = {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
    };
    const id = `resp_bili_${randomUUID()}`;
    if (!stream) {
        return {
            body: JSON.stringify({ id, output: [compactionItem], usage: usageJson }),
            contentType: "application/json",
        };
    }
    const frame1 = `data: ${JSON.stringify({ type: "response.output_item.done", item: compactionItem })}\n\n`;
    const frame2 = `data: ${JSON.stringify({ type: "response.completed", response: { id, usage: usageJson } })}\n\n`;
    return { body: frame1 + frame2, contentType: "text/event-stream" };
}

// The kernel renders block summaries as system messages with this header
// (acp-kernel SUMMARY_HEADER). Reuse the exact format so the model reads a
// captured handoff summary the same way it reads a live kernel-rendered one.
const FORGED_SUMMARY_HEADER = "[Compressed conversation section]";

export function renderForgedSummary(block: Pick<CompressionBlock, "summary" | "topic">): string {
    const body = block.summary.trim();
    const topicLine = block.topic ? `${FORGED_SUMMARY_HEADER} — ${block.topic}` : FORGED_SUMMARY_HEADER;
    return body.length === 0 ? topicLine : `${topicLine}\n${body}`;
}

// The forged compaction item is opaque to the model and codex truncates its
// history to [compaction_item, tail…], so the kernel deactivates the blocks
// covering the truncated prefix on the next replay and their summaries would
// vanish from the model's view. Capture them (kernel render format) at forge
// time; the server re-injects them into the developer message every turn
// (endpoint-form semantics). Append-only + exact-text dedup: a second forge
// accumulates, re-capture of deactivated blocks adds nothing.
export function mergeForgedSummaries(existing: string[] | undefined, blocks: readonly CompressionBlock[]): string[] {
    const merged = existing ? [...existing] : [];
    for (const block of blocks) {
        if (!block.active) continue;
        const rendered = renderForgedSummary(block);
        if (!merged.includes(rendered)) merged.push(rendered);
    }
    return merged;
}
