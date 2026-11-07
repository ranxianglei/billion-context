import { randomUUID } from "node:crypto";
import { baseIdOf, summaryMessageId, type CompressionBlock } from "acp-kernel";
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

// The summary text a forged blob carries (sentinel-prefixed plaintext).
function extractBiliSummary(item: unknown): string | undefined {
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
// #1634: exact handoff header the model sees on the responses wire; the
// output-side stripper keys off this constant (single source of truth).
export const CODEX_FORGED_HANDOFF_HEADER = "[bili] context summary after compaction:";

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
            content: [{ type: "input_text", text: `${CODEX_FORGED_HANDOFF_HEADER}\n${summary}` }],
        } as T);
        replaced++;
    }
    return { items, replaced, dropped };
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

// #4600: one handoff-ledger entry. `blockId` carries provenance so superseded
// entries can be pruned; legacy persisted states hold plain strings (entries
// without provenance) that stay conservative forever.
interface ForgedSummaryEntry {
    text: string;
    blockId?: string;
}

// Accepts every shape the ledger has ever persisted (undefined, legacy
// string[], object entries, mixed garbage) into normalized entries, keeping
// the append-only exact-text dedup invariant.
export function normalizeForgedEntries(raw: unknown): ForgedSummaryEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: ForgedSummaryEntry[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        let text: string | undefined;
        let blockId: string | undefined;
        if (typeof item === "string") {
            text = item;
        } else if (item !== null && typeof item === "object") {
            const rec = item as { text?: unknown; blockId?: unknown };
            if (typeof rec.text === "string") {
                text = rec.text;
                if (typeof rec.blockId === "string" && rec.blockId.length > 0) blockId = rec.blockId;
            }
        }
        if (text === undefined || seen.has(text)) continue;
        seen.add(text);
        out.push(blockId !== undefined ? { text, blockId } : { text });
    }
    return out;
}

// The forged compaction item is opaque to the model and codex truncates its
// history to [compaction_item, tail…], so the kernel deactivates the blocks
// covering the truncated prefix on the next replay and their summaries would
// vanish from the model's view. Capture them (kernel render format) at forge
// time; the server re-injects them into the developer message whenever the
// echo is absent (#1064). Exact-text dedup: re-capture of an already-listed
// block adds nothing; each NEW active block appends one entry per forge.
export function mergeForgedSummaries(existing: unknown, blocks: readonly CompressionBlock[]): ForgedSummaryEntry[] {
    const merged = normalizeForgedEntries(existing);
    const byText = new Set(merged.map((e) => e.text));
    for (const block of blocks) {
        if (!block.active) continue;
        const rendered = renderForgedSummary(block);
        if (byText.has(rendered)) continue;
        byText.add(rendered);
        merged.push({ text: rendered, blockId: block.blockId });
    }
    return merged;
}

// #4600: drop ledger entries that are provably redundant. An entry is
// redundant once a newer-generation block folded the message carrying its
// summary (summaryMessageId ∈ consumer.effectiveMessageIds) AND that consumer
// is itself represented — still active (its summary renders live in the
// conversation) or holding its own ledger entry. Entries whose block was
// merely deactivated by the post-forge truncation have no consumer: they are
// the load-bearing fallback debt and stay. Unknown-provenance entries (legacy
// strings), blocks absent from state, and still-active blocks are kept —
// pruning is strictly shrinking and never speculative. Returns the same array
// reference when nothing changed.
export function pruneForgedEntries(entries: ForgedSummaryEntry[], blocks: readonly CompressionBlock[]): ForgedSummaryEntry[] {
    if (entries.length === 0) return entries;
    const byBlockId = new Map(blocks.map((b) => [b.blockId, b]));
    const represented = new Set(entries.filter((e) => e.blockId !== undefined).map((e) => e.blockId as string));
    // Only summary ids the ledger actually references need coverage lookups.
    const consumers = new Map<string, CompressionBlock[]>();
    for (const e of entries) {
        if (e.blockId === undefined) continue;
        const self = byBlockId.get(e.blockId);
        if (!self || self.active) continue;
        consumers.set(summaryMessageId(e.blockId), []);
    }
    if (consumers.size > 0) {
        for (const b of blocks) {
            for (const id of b.effectiveMessageIds ?? []) {
                const list = consumers.get(baseIdOf(id));
                if (list) list.push(b);
            }
        }
    }
    let changed = false;
    const kept: ForgedSummaryEntry[] = [];
    for (const e of entries) {
        if (e.blockId === undefined) { kept.push(e); continue; }
        const self = byBlockId.get(e.blockId);
        if (!self || self.active) { kept.push(e); continue; }
        const superseded = (consumers.get(summaryMessageId(e.blockId)) ?? []).some((c) => c.active || represented.has(c.blockId));
        if (superseded) { changed = true; continue; }
        kept.push(e);
    }
    return changed ? kept : entries;
}

// #4600: evidence that a request replays an actual conversation (completed
// turns) rather than context-only auxiliary traffic (prewarms, sidecars,
// probes — the #4594 shape). The fallback re-injection exists to protect
// replayed history from losing its pre-compaction handoff; a request that
// replays no conversation has nothing to protect and must not pay the
// accumulated-ledger tax — which used to fail such requests outright with a
// 413 once the ledger grew past the window.
const CONVERSATION_ITEM_TYPES = new Set([
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "computer_call",
    "mcp_call",
    "reasoning",
]);

export function carriesConversationTurns(input: unknown): boolean {
    if (!Array.isArray(input)) return false;
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        const it = item as { type?: unknown; role?: unknown };
        // Type-less assistant roles count too (OpenAI easy-input shorthand):
        // a false positive only wastes tokens, a false negative loses the
        // handoff — the predicate errs toward injecting.
        if ((it.type === "message" || it.type === undefined) && it.role === "assistant") return true;
        if (typeof it.type === "string" && CONVERSATION_ITEM_TYPES.has(it.type)) return true;
    }
    return false;
}

// #4600: observability threshold — warn when the fallback re-injection eats a
// significant slice of the window (the field case hit ~1.2M tokens against a
// 375K window before failing preflight). 10% keeps ordinary sessions quiet.
export const FORGED_SUMMARY_INJECT_WARN_PCT = 0.1;
