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
    return v === "intercept" ? "intercept" : "pass";
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

// Safety valve: forge ONLY when the transform succeeded, the steady-state
// context is below the 90% threshold (codex's own auto-compact point — above
// it, bili's ACP has failed to keep up and native compaction must backstop),
// and there is at least one active block (a real summary to hand off).
export function codexCompactGate(session: Session, effectiveLimit: number, transformOk: boolean): boolean {
    if (!transformOk || effectiveLimit <= 0) return false;
    if (session.stats.lastInputTokens >= effectiveLimit * 0.9) return false;
    return session.state.blocks.some((b) => b.active);
}

// Minimal legal forged SSE stream for the trigger form: exactly one compaction
// output item + response.completed. Codex's parser (codex-api/src/sse/responses.rs)
// ignores every other event kind and requires response.completed to parse with
// id + usage{input_tokens,output_tokens,total_tokens}.
export function buildTriggerForgeSse(
    summaryText: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
): string {
    const compactionItem = {
        type: "compaction",
        id: `${CODEX_COMPACT_ID_PREFIX}${randomUUID()}`,
        encrypted_content: `${CODEX_COMPACT_SENTINEL}${summaryText}`,
    };
    const completed = {
        id: `resp_bili_${randomUUID()}`,
        usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
        },
    };
    const frame1 = `data: ${JSON.stringify({ type: "response.output_item.done", item: compactionItem })}\n\n`;
    const frame2 = `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`;
    return frame1 + frame2;
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
