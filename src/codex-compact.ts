import { randomUUID } from "node:crypto";
import { baseIdOf, type CompressionBlock } from "acp-kernel";
import type { ResponseInputItem, ResponsesProjection } from "acp-kernel/wire";
import { statusInputBaseline, type Session } from "./session.js";
import { codexCompactMode as knobCodexCompactMode } from "./knobs.js";

// #3686: the x-bili-plugin marker name is read DIRECTLY here instead of via
// plugin.js — plugin.ts reaches this module's top-level constants through
// loop/tag-echo-filter.ts, so importing it back would close an ESM cycle and
// crash on the TDZ of CODEX_FORGED_HANDOFF_HEADER. Same discipline as
// session-id.ts / anon-provenance.ts reading the wire literal.
const BILI_PLUGIN_MARKER = "x-bili-plugin";

function declaredPluginAgent(headers: Record<string, string | string[] | undefined>): string | undefined {
    const v = headers[BILI_PLUGIN_MARKER];
    const s = Array.isArray(v) ? v[0] : v;
    const t = typeof s === "string" ? s.trim() : undefined;
    return t !== undefined && t.length > 0 ? t : undefined;
}

export const CODEX_COMPACT_ID_PREFIX = "fc_bili_";
export const CODEX_COMPACT_SENTINEL = "bili:acp:";

const CODEX_UA_PREFIXES = ["codex_cli_rs/", "codex_exec/", "codex desktop/"];

export type CodexCompactMode = "intercept" | "pass";

// Read per-request (not cached at startup) so a running proxy can flip the
// kill-switch without a restart (env BILI_CODEX_COMPACT or config codexCompact).
export function codexCompactMode(): CodexCompactMode {
    return knobCodexCompactMode();
}

// The `originator` header is only sent for non-default thread originators, so
// the UA (DEFAULT_ORIGINATOR in codex's default_client.rs) is the reliable
// client signal. Codex ships multiple clients with different UA prefixes
// (codex_cli_rs/, codex_exec/, codex desktop/, ...); known prefixes match at
// the START of the UA case-insensitively because variants like Codex Desktop
// send an initial capital ("Codex Desktop/x.y.z", #1169). In addition, a
// lenient fallback covers unknown variants (#645): any whitespace-delimited
// UA component STARTING with lowercase "codex". Token-level, not substring:
// a bare "includes" misclassified non-codex clients whose UAs merely mention
// "codex" mid-token or in parens (e.g. "vendor/codex-wrapper", #1641), which
// then rode the full codex treatment (compaction forge + user-role summary
// replacement). The fallback stays CASE-SENSITIVE on purpose: a
// case-insensitive match would pull non-codex relays with "Codex"-shaped UAs
// into codex treatment and re-fork them mid-conversation (#1106). A new
// client variant must not silently fall out of detection (#645) — token-level
// keeps any future "codex_*/…" variant covered; register an exact prefix
// above only when the variant sends an initial capital.
export function isCodexClient(headers: Record<string, string | string[] | undefined>): boolean {
    const ua = headers["user-agent"];
    if (!ua) return false;
    const s = Array.isArray(ua) ? ua[0] : ua;
    if (typeof s !== "string") return false;
    if (CODEX_UA_PREFIXES.some((p) => s.toLowerCase().startsWith(p))) return true;
    return s.split(/\s+/).some((t) => t.startsWith("codex"));
}

/** #3686: HOST-POLICY codex identity — deliberately distinct from the
 *  wire-profile isCodexClient above. An explicit bili plugin marker declares
 *  the requesting host authoritatively: a native host that ships a
 *  codex-shaped UA for relay compatibility (pi over a strict codex relay) is
 *  still THAT host, and must not inherit codex-only compaction policy (the 0.9
 *  health bar, forge/reconcile lanes, CCR/image disarm, compact-trigger
 *  dispatch, codex-table window alignment, instructions-fingerprint keying).
 *  No marker → fall back to the UA guess exactly as before, so headerless
 *  clients keep their detection unchanged. Wire-shape decisions (the
 *  preflight summary payload's codex CLI signature, #2733) stay on the raw
 *  isCodexClient: the relay validates what the presented bytes claim, not who
 *  bili believes is home. */
export function isCodexHost(headers: Record<string, string | string[] | undefined>): boolean {
    const agent = declaredPluginAgent(headers);
    if (agent !== undefined) return agent === "codex";
    return isCodexClient(headers);
}

/** #3686: whether the codex-intercept health bar (CODEX_COMPACT_HEALTH_RATIO)
 *  applies to this request — the single gate behind every lowered-bar site
 *  (preflight overflow target, growth-fold nudge caps). */
export function codexHealthBarApplies(headers: Record<string, string | string[] | undefined>): boolean {
    return isCodexHost(headers) && codexCompactMode() === "intercept";
}

export function hasCompactionTrigger(input: unknown): boolean {
    if (!Array.isArray(input)) return false;
    const last = input[input.length - 1] as { type?: unknown } | undefined;
    return last?.type === "compaction_trigger";
}

// #3008: codex's local inline auto-compact (compact.rs
// run_inline_auto_compact_task, observed rust-v0.162.1) travels as an
// ORDINARY turn — full history + the SUMMARIZATION_PROMPT template as the
// last user message. No trigger field, no dedicated endpoint: the only wire
// signature is the prompt text itself. Anchor on the immutable first line of
// codex's built-in template (prompts/templates/compact/prompt.md, versioned
// here like the #2372 summary prefix). A user-overridden compact_prompt no
// longer matches and falls back to verbatim passthrough (documented, not
// silently wrong).
export const CODEX_COMPACT_PROMPT_ANCHOR = "You are performing a CONTEXT CHECKPOINT COMPACTION.";

function messageItemText(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const part of content) {
        const p = part as { type?: unknown; text?: unknown } | null;
        if (p && typeof p === "object" && typeof p.text === "string" &&
            (p.type === "input_text" || p.type === "output_text" || p.type === "text" || p.type === undefined)) {
            parts.push(p.text);
        }
    }
    return parts.length > 0 ? parts.join("") : undefined;
}

// True when the LAST message item in input[] is a user message opening with
// the built-in auto-compact template. Scanning backwards keeps mid-history
// quotes out: only the final user message can be the live compaction turn
// (the template is recorded as the last input item before the request is
// sent). A trailing non-user message (assistant/developer) disqualifies.
export function hasCompactionPrompt(input: unknown): boolean {
    if (!Array.isArray(input)) return false;
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i] as { type?: unknown; role?: unknown; content?: unknown } | undefined;
        if (!item || typeof item !== "object" || item.type !== "message") continue;
        if (item.role !== "user") return false;
        const text = messageItemText(item.content);
        return typeof text === "string" && text.trimStart().startsWith(CODEX_COMPACT_PROMPT_ANCHOR);
    }
    return false;
}

// #2372: codex's LOCAL auto-compaction (rollout event type:"compacted") never
// transits the proxy — no compaction_trigger item, no /responses/compact
// call. The proxy only sees the aftermath: the next request replays
// [compaction summary, retained tail…]. Codex's summary template opens with
// this fixed header (codex-rs core-coder); versioned here like the dsh
// instruction prefix (#970) — the drift test pins the exact bytes.
export const CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary";

// The #2372 signature is TWO content signals together: this template heading
// a resent message AND the fold coverage decimated below. Either alone is
// ambiguous (a user pasting template text, or ordinary #1195 churn); together
// they mean codex replaced the folded head locally and the ACP substrate must
// rebase onto the compacted view. 8 ≈ the resume-prefix floor; the majority
// arm keeps small tail-only gaps (client deletion, #1195) out.
export const CODEX_LOCAL_COMPACTION_MIN_MISSING = 8;

export function carriesCodexLocalCompactionSummary(msgs: readonly { text?: unknown }[]): boolean {
    return msgs.some((m) => typeof m.text === "string" && m.text.startsWith(CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX));
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

// #1634: exact handoff header the model sees on the responses wire; the
// output-side stripper keys off this constant (single source of truth).
export const CODEX_FORGED_HANDOFF_HEADER = "[bili] context summary after compaction:";

// #4035: forged blobs minted since this build carry the UNCOVERED tail
// alongside the block summaries in a v2 JSON envelope. Pre-v2 blobs stay
// sentinel-prefixed PLAINTEXT (older builds minted them) — expansion below
// keeps reading them byte-for-byte, so a mid-session upgrade never loses an
// already-echoed marker.
const CODEX_COMPACT_BLOB_V2_PREFIX = `${CODEX_COMPACT_SENTINEL}v2:`;

interface CodexForgePayload {
    v: 2;
    summaries: string[];
    tail: ResponseInputItem[];
}

function forgeBlob(payload: CodexForgePayload): string {
    return `${CODEX_COMPACT_BLOB_V2_PREFIX}${JSON.stringify(payload)}`;
}

function parseForgeV2Blob(blob: string): CodexForgePayload | undefined {
    try {
        const parsed = JSON.parse(blob.slice(CODEX_COMPACT_BLOB_V2_PREFIX.length)) as Partial<CodexForgePayload>;
        if (parsed.v !== 2 || !Array.isArray(parsed.summaries) || !parsed.summaries.every((s) => typeof s === "string") || !Array.isArray(parsed.tail)) return undefined;
        return { v: 2, summaries: parsed.summaries, tail: parsed.tail };
    } catch {
        return undefined;
    }
}

interface BiliForgeHandoff {
    summaryText: string;
    tail: ResponseInputItem[];
}

// The full handoff an echoed fc_bili_ blob carries: the fold summaries plus
// (#4035) the uncovered recent tail captured at forge time. Legacy plain-text
// blobs expand to summaries only; marker items with no extractable blob yield
// undefined (drop path).
function extractBiliForge(item: unknown): BiliForgeHandoff | undefined {
    const it = item as { encrypted_content?: unknown } | null;
    if (!it || typeof it.encrypted_content !== "string") return undefined;
    const blob = it.encrypted_content;
    if (!blob.startsWith(CODEX_COMPACT_SENTINEL)) return undefined;
    if (blob.startsWith(CODEX_COMPACT_BLOB_V2_PREFIX)) {
        const payload = parseForgeV2Blob(blob);
        if (!payload) return undefined;
        return { summaryText: payload.summaries.join("\n\n"), tail: payload.tail };
    }
    const text = blob.slice(CODEX_COMPACT_SENTINEL.length);
    return text.length > 0 ? { summaryText: text, tail: [] } : undefined;
}

// Key-order-insensitive fingerprint for the echo-time dedup below: the tail
// items were serialized by bili at forge time, the retained copies were
// (re)serialized by codex — same logical object, possibly different key
// order, so a naive stringify comparison would miss the overlap.
function stableFingerprint(value: unknown): string | undefined {
    try {
        const walk = (v: unknown): unknown =>
            Array.isArray(v) ? v.map(walk)
                : v !== null && typeof v === "object"
                    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, walk(val)]))
                    : v;
        return JSON.stringify(walk(value));
    } catch {
        return undefined;
    }
}

// An echoed fc_bili_ compaction item is REPLACED (in place) by a plain user
// message carrying the extracted summary — a history-borne handoff the kernel
// can fold again and codex's retention keeps — followed (#4035) by the
// uncovered tail items that ride behind it verbatim. Tail items codex ITSELF
// still carries verbatim in the same input (its retention keeps recent user
// messages) are skipped — carrying them too would double the newest turns
// until the next fold; only what codex dropped (assistant progress, tool
// drafts/results) is the gap this fills. Rare bounded duplication (a block
// whose anchors survived the truncation also renders) is accepted over data
// loss. Marker items without an extractable blob (id-prefix-only, e.g. minted
// by an older build) are still dropped; real OpenAI blobs pass through
// untouched.
export function replaceBiliCompactionItems<T>(input: T[]): { items: T[]; replaced: number; dropped: number; tailItems: number } {
    const present = new Set<string>();
    for (const item of input) {
        if (isBiliCompactionItem(item)) continue;
        const fp = stableFingerprint(item);
        if (fp !== undefined) present.add(fp);
    }
    const items: T[] = [];
    let replaced = 0;
    let dropped = 0;
    let tailItems = 0;
    for (const item of input) {
        if (!isBiliCompactionItem(item)) {
            items.push(item);
            continue;
        }
        const handoff = extractBiliForge(item);
        if (handoff === undefined) {
            dropped++;
            continue;
        }
        items.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `${CODEX_FORGED_HANDOFF_HEADER}\n${handoff.summaryText}` }],
        } as T);
        for (const t of handoff.tail) {
            const fp = stableFingerprint(t);
            if (fp !== undefined && present.has(fp)) continue;
            items.push(t as T);
            tailItems += 1;
        }
        replaced++;
    }
    return { items, replaced, dropped, tailItems };
}

// #4035: the resent-history items NO active fold covers — the recent work
// between the last fold and compaction time (assistant progress, tool drafts
// and results, reasoning). Codex's own retention keeps only USER messages
// (remote v2 form) or adopts a prose summary (inline prompt form), so without
// this carry the unfolded tail vanishes from the model's view after a local
// forge compaction — exactly the loss a real upstream compaction never makes
// (it summarizes the WHOLE input). Collection walks the projection LAYOUT
// (one slot per input item, in order):
//   - slots without a core id (preamble scaffolding, sys/dev, the trailing
//     compaction_trigger) are wire furniture, not conversation content;
//   - fully covered slots are already summarized by an active block —
//     carrying them would duplicate folded bytes;
//   - PARTIALLY covered multi-core slots (split user items #3642, demoted-
//     thinking splits) are skipped honestly: carrying the whole item would
//     resurrect bytes the kernel folded out of it;
//   - everything else rides byte-exact (slot.original), thinking-family bytes
//     included verbatim per the signature rule (KDD #10: move, never rewrite).
export function collectUncoveredTailItems(
    projection: Pick<ResponsesProjection, "layout">,
    blocks: readonly CompressionBlock[],
    opts?: { excludePromptTemplate?: boolean },
): ResponseInputItem[] {
    const covered = new Set<string>();
    for (const b of blocks) {
        if (!b.active) continue;
        for (const id of b.effectiveMessageIds) covered.add(baseIdOf(id));
    }
    const slots = Array.isArray(projection.layout) ? projection.layout : [];
    // Prompt form: the LAST user message IS codex's SUMMARIZATION_PROMPT
    // template (hasCompactionPrompt anchors on it) — it is the instruction,
    // not conversation content, and must not ride into future turns.
    let lastUserSlot = -1;
    for (let i = 0; i < slots.length; i++) {
        const original = slots[i].original as ResponseInputItem | null;
        if (original && original.type === "message" && original.role === "user") lastUserSlot = i;
    }
    const tail: ResponseInputItem[] = [];
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (opts?.excludePromptTemplate && i === lastUserSlot) continue;
        const ids = Array.isArray(slot.coreIds) && slot.coreIds.length > 0 ? slot.coreIds : slot.coreId !== undefined ? [slot.coreId] : [];
        if (ids.length === 0) continue;
        let anyCovered = false;
        for (const id of ids) {
            if (covered.has(baseIdOf(id))) {
                anyCovered = true;
                break;
            }
        }
        if (anyCovered) continue;
        tail.push(slot.original);
    }
    return tail;
}

// Prompt-form channel is prose: the forged assistant message is adopted as
// codex's summary TEXT, so the uncovered tail renders here as labeled lines
// instead of structured items (the trigger form carries the raw items). No
// truncation — the recent draft IS the content this fixes the loss of.
export const FORGED_TAIL_HEADER = "[Recent work since the last fold (not yet summarized)]";

function contentPartText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const p of content) {
        const part = p as { type?: unknown; text?: unknown } | null;
        if (!part || typeof part !== "object") continue;
        if (typeof part.text === "string" && (part.type === "input_text" || part.type === "output_text" || part.type === "text" || part.type === undefined)) parts.push(part.text);
        else if (part.type === "input_image" || part.type === "output_image") parts.push("[image]");
    }
    return parts.join("");
}

export function renderUncoveredTailText(tail: readonly ResponseInputItem[]): string {
    const lines: string[] = [];
    for (const item of tail) {
        const it = item as { type?: unknown; role?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown; output?: unknown; input?: unknown; summary?: unknown; content?: unknown };
        switch (it.type) {
            case "reasoning": {
                const s = it.summary;
                const text = Array.isArray(s)
                    ? s.map((p) => (p as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === "string").join("")
                    : "";
                if (text.trim().length > 0) lines.push(`[thinking]\n${text}`);
                break;
            }
            case "message": {
                const text = contentPartText(it.content ?? "");
                if (text.trim().length > 0) lines.push(`[${it.role === "assistant" ? "assistant" : "user"}]\n${text}`);
                break;
            }
            case "function_call":
                lines.push(`[tool call ${String(it.call_id)}] ${String(it.name)}(${typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? "")})`);
                break;
            case "function_call_output":
                lines.push(`[tool result ${String(it.call_id)}]\n${contentPartText(it.output)}`);
                break;
            case "custom_tool_call":
                lines.push(`[custom tool call ${String(it.call_id)}] ${JSON.stringify(it.input ?? "")}`);
                break;
            case "custom_tool_call_output":
                lines.push(`[custom tool result ${String(it.call_id)}]\n${contentPartText(it.output)}`);
                break;
            default:
                break;
        }
    }
    return lines.filter((l) => l.trim().length > 0).join("\n\n");
}

// Safety valve preconditions (#332): evaluable BEFORE the kernel transform so
// the pipeline can dispatch a compaction request (forge vs verbatim
// passthrough) before prepare/preflight touch payload or state. The client's
// own auto-compact point is NOT observable from the proxy and varies
// (78.7% of window observed in #3008); 90% stays bili's conservative backstop
// line, not a model of codex's internal threshold.
export const CODEX_COMPACT_HEALTH_RATIO = 0.9;

export function codexCompactGatePre(session: Session, effectiveLimit: number): boolean {
    if (effectiveLimit <= 0) return false;
    // Evidence-grade baseline only (#3008/#1492/#1839 discipline): raw
    // stats.lastInputTokens can be an uncalibrated estimate-grade value that
    // self-disables the valve at phantom pressure while real usage is far below.
    if (statusInputBaseline(session) >= effectiveLimit * CODEX_COMPACT_HEALTH_RATIO) return false;
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
    // #4035: uncovered recent tail to hand off. Non-empty switches the blob to
    // the v2 JSON envelope; empty keeps the legacy plain-sentinel byte shape
    // stable across builds (no-tail sessions see no wire change).
    tail?: readonly ResponseInputItem[],
): { body: string; contentType: string } {
    const encryptedContent = Array.isArray(tail) && tail.length > 0
        ? forgeBlob({ v: 2, summaries: summaryText.length > 0 ? [summaryText] : [], tail: [...tail] })
        : `${CODEX_COMPACT_SENTINEL}${summaryText}`;
    const compactionItem = {
        type: "compaction",
        id: `${CODEX_COMPACT_ID_PREFIX}${randomUUID()}`,
        encrypted_content: encryptedContent,
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

// Forged reply for the PROMPT form (#3008): the auto-compact request is a
// normal POST /v1/responses whose completion codex records item-by-item
// (session/turn.rs drain_to_completed — every output_item.done becomes a
// history item, then response.completed carries usage). The summary codex
// adopts = the last ASSISTANT message in that history, so we answer with
// exactly one assistant message item carrying bili's captured fold
// summaries. Codex then assembles its compacted payload as its own
// SUMMARY_PREFIX + this text — we must NOT pre-prefix it.
export function buildPromptForgeBody(
    summaryText: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    stream: boolean,
): { body: string; contentType: string } {
    const id = `resp_bili_${randomUUID()}`;
    const messageId = `msg_bili_${randomUUID()}`;
    const messageItem = {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: summaryText, annotations: [] }],
    };
    const usageJson = {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
    };
    if (!stream) {
        return {
            body: JSON.stringify({ id, object: "response", output: [messageItem], usage: usageJson }),
            contentType: "application/json",
        };
    }
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    let body = "";
    body += frame({ type: "response.created", response: { id, status: "in_progress" } });
    body += frame({ type: "response.output_item.added", output_index: 0, item: { ...messageItem, status: "in_progress" } });
    body += frame({ type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    body += frame({ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: summaryText });
    body += frame({ type: "response.output_text.done", item_id: messageId, output_index: 0, content_index: 0, text: summaryText });
    body += frame({ type: "response.content_part.done", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: summaryText, annotations: [] } });
    body += frame({ type: "response.output_item.done", output_index: 0, item: messageItem });
    body += frame({ type: "response.completed", response: { id, status: "completed", usage: usageJson } });
    body += "data: [DONE]\n\n";
    return { body, contentType: "text/event-stream" };
}

// The kernel renders block summaries as system messages with this header
// (acp-kernel SUMMARY_HEADER). Reuse the exact format so the model reads a
// captured handoff summary the same way it reads a live kernel-rendered one.
export const FORGED_SUMMARY_HEADER = "[Compressed conversation section]";

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
