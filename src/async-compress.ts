// Delayed same-model compression: the main model queues a pass with an empty
// compress({ content: [] }); the next outbound request carrying that tool
// result is captured and replayed once more (same target, same headers, one
// appended directive) while the main request proceeds; the fork's single
// compress call is validated against the capture snapshot and applied under
// the session lock at a later request. Internal only: inert until
// configureAsyncCompress() is called (no config/env/CLI surface).
import { randomUUID } from "node:crypto";
import { activeBlockSpans, viableRanges, type BlockSpan, type CompressionCore, type CompressionState, type Config, type CoreMessage, type NudgeDecision } from "acp-kernel";
import { parseCompressInput } from "./compress-tool.js";
import { withoutFetchTransport } from "./fetch-transport.js";
import { fetchWithTimeout } from "./fetch-util.js";
import { googleModelFromPath } from "./google-model-path.js";
import { log as loggerLog } from "./logger.js";
import { createAnthropicAdapter } from "./loop/adapter-anthropic.js";
import { createGoogleAdapter } from "./loop/adapter-google.js";
import { createOpenaiAdapter } from "./loop/adapter-openai.js";
import { createResponsesAdapter } from "./loop/adapter-responses.js";
import type { CompressLoopAdapter } from "./loop/core.js";
import type { ProxyToolResult } from "./proxy-tool-result.js";
import { markDirty, type Session } from "./session.js";
import { applyRanges, normalizeRangeOrder } from "./stream.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import type { WireProtocol } from "./util.js";

export const ASYNC_COMPRESS_CALL_ID_PREFIX = "async_compress_";

interface AsyncCompressPolicy {
    captureTimeoutMs: number;
    forkTimeoutMs: number;
    readyTtlMs: number;
    failureBackoffMs: number;
}

const DEFAULT_POLICY: AsyncCompressPolicy = {
    captureTimeoutMs: 2 * 60_000,
    forkTimeoutMs: 5 * 60_000,
    readyTtlMs: 30 * 60_000,
    failureBackoffMs: 10 * 60_000,
};

type ParsedCompress = ReturnType<typeof parseCompressInput>;
type ParsedRanges = ParsedCompress["ranges"];

interface Capture {
    url: string;
    headers: Record<string, string>;
    body: string;
    proxyUrl?: string;
    protocol: WireProtocol;
    model?: string;
    ids: string[];
    byRef: Record<string, string>;
    blocks: string[];
}

interface Job {
    id: string;
    tag: string;
    sessionId: string;
    phase: "awaiting-capture" | "running" | "ready";
    /** The model's own call id (proxy mode); undefined when the call never rides the wire (plugin tool endpoint). */
    callId?: string;
    resultText: string;
    timer?: ReturnType<typeof setTimeout>;
    controller: AbortController;
    capture?: Capture;
    parsed?: ParsedCompress;
}

interface Note {
    id: string;
    text: string;
}

interface OutboundSend {
    url: string;
    headers: Record<string, string>;
    body: string;
    proxyUrl?: string;
    protocol: WireProtocol | undefined;
    messages: readonly CoreMessage[];
    signed: boolean;
    /** Capture-effective config (its compress.minCompressRange is the floor the directive states). */
    config: Config;
    /** The kernel's prepare-time offer for the request this send was built from; omitted when unknown. In proxy mode it
     *  predates the in-loop compress pair, so it can lag the captured wire. */
    offer?: NudgeDecision;
}

let policy: AsyncCompressPolicy | undefined;
const jobs = new Map<string, Job>();
const notes = new Map<string, Note>();
const backoff = new Map<string, { until: number; reason: string }>();
const attachedNotes = new WeakMap<object, { sessionId: string; noteId: string }>();

/** Internal wiring (tests / private boot harness). `false` disables and disposes. */
export function configureAsyncCompress(next: Partial<AsyncCompressPolicy> | false): void {
    disposeAsyncCompress("reconfigured");
    policy = next === false ? undefined : { ...DEFAULT_POLICY, ...next };
}

export function asyncCompressEnabled(): boolean {
    return policy !== undefined;
}

export function disposeAsyncCompress(reason = "disposed"): void {
    for (const job of jobs.values()) dropJob(job, reason, false);
    jobs.clear();
    notes.clear();
    backoff.clear();
}

export function _asyncCompressStateForTest(): { jobs: Map<string, Job>; notes: Map<string, Note>; backoff: Map<string, { until: number; reason: string }> } {
    return { jobs, notes, backoff };
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Exactly `content: []` (array or JSON string) and nothing range-shaped. */
export function isAsyncCompressTrigger(input: unknown): boolean {
    let value = input;
    if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return false; }
    }
    if (!isRecord(value)) return false;
    let content = value.content;
    if (typeof content === "string") {
        try { content = JSON.parse(content); } catch { return false; }
    }
    if (!Array.isArray(content) || content.length !== 0) return false;
    return !["startId", "endId", "startRef", "endRef", "summary", "ranges"].some((k) => k in value);
}

export const ASYNC_COMPRESS_TOOL_NOTE = "\n\n[Background compression is enabled for this session. Clarification of the content requirement above: compress({ content: [] }) — an empty content array and no other fields — is a valid call here. It queues a separate pass of this same model that picks the ranges and writes the summaries while you continue; its result is applied at a later request. compress with explicit ranges works as usual.]";

/** Appends the async note to the compress declaration when enabled; otherwise returns the input unchanged. */
export function withAsyncCompressTools<T>(tools: readonly T[]): T[] {
    if (!policy) return [...tools];
    return tools.map((tool) => {
        if (!isRecord(tool)) return tool;
        const copy = structuredClone(tool);
        const declaration = isRecord(copy.function) ? copy.function : copy;
        if (declaration.name !== "compress" || typeof declaration.description !== "string") return tool;
        declaration.description += ASYNC_COMPRESS_TOOL_NOTE;
        return copy as T;
    });
}

function queueNote(sessionId: string, tag: string, reason: string): void {
    notes.set(sessionId, {
        id: randomUUID(),
        text: `[billion-context] Background compression job ${tag} did not apply (${reason}); nothing was compressed by it. If the context still needs compressing, compress ranges yourself with compress({ content: [{ startId, endId, summary }] }) or queue again with compress({ content: [] }).`,
    });
}

function dropJob(job: Job, reason: string, owesNote: boolean, backoffFor = false): void {
    if (jobs.get(job.sessionId) === job) jobs.delete(job.sessionId);
    if (job.timer) clearTimeout(job.timer);
    job.controller.abort();
    job.capture = undefined;
    job.parsed = undefined;
    if (owesNote) queueNote(job.sessionId, job.tag, reason);
    if (backoffFor && policy) backoff.set(job.sessionId, { until: Date.now() + policy.failureBackoffMs, reason });
    loggerLog("info", `[${job.sessionId}] [async-compress] job ${job.tag} dropped (${reason})`);
}

function arm(job: Job, ms: number, reason: string, backoffFor: boolean): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => dropJob(job, reason, true, backoffFor), ms);
    job.timer.unref?.();
}

/** Under the session lock (tool execution). Returns the tool result, or undefined when async is off. */
export function triggerAsyncCompress(session: Session, callId?: string): ProxyToolResult | undefined {
    if (!policy) return undefined;
    const now = Date.now();
    for (const [sid, off] of backoff) if (off.until <= now) backoff.delete(sid);
    const existing = jobs.get(session.id);
    if (existing) return { text: `Background compression is already queued (job ${existing.tag}). Continue the task.` };
    const off = backoff.get(session.id);
    if (off) {
        return { text: `Background compression is unavailable right now (${off.reason}). Compress ranges yourself: compress({ content: [{ startId, endId, summary }] }).` };
    }
    const id = randomUUID();
    const tag = `bg-${id.slice(0, 8)}`;
    const resultText = `Background compression queued (job ${tag}): a separate pass of this same model picks the ranges and writes the summaries; the result is applied at a later request. Continue the task; do not call compress for this again.`;
    const job: Job = { id, tag, sessionId: session.id, phase: "awaiting-capture", controller: new AbortController(), ...(callId ? { callId } : {}), resultText };
    jobs.set(session.id, job);
    arm(job, policy.captureTimeoutMs, "no follow-up request captured in time", true);
    loggerLog("info", `[${session.id}] [async-compress] job ${job.tag} queued`);
    return { text: resultText };
}

/** A successful synchronous fold makes any pending job's snapshot obsolete. */
export function supersedeAsyncCompress(session: Session): void {
    const job = jobs.get(session.id);
    if (job) dropJob(job, "superseded by a direct compress", true);
}

const SERVER_STATE_KEYS = ["previous_response_id", "conversation", "context_management"];

function keepAllThinkingOnly(value: unknown): boolean {
    if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.edits) || value.edits.length === 0) return false;
    return value.edits.every((e) => isRecord(e) && Object.keys(e).length === 2 && e.type === "clear_thinking_20251015" && e.keep === "all");
}

function itemsOf(protocol: WireProtocol, body: Record<string, unknown>): unknown[] | undefined {
    const list = protocol === "responses" ? body.input : protocol === "google" ? body.contents : body.messages;
    return Array.isArray(list) ? list : undefined;
}

function isAssistantItem(protocol: WireProtocol, item: unknown): boolean {
    if (!isRecord(item)) return false;
    if (protocol === "google") return item.role === "model";
    if (protocol === "responses") return item.role === "assistant" || item.type === "function_call" || item.type === "reasoning" || item.type === "custom_tool_call";
    return item.role === "assistant";
}

interface ToolResultRef { index: number; callId?: string; name?: string; texts: string[] }

function stringLeaves(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
    else if (isRecord(value)) for (const v of Object.values(value)) stringLeaves(v, out);
    return out;
}

function toolResults(protocol: WireProtocol, items: readonly unknown[], from: number): ToolResultRef[] {
    const out: ToolResultRef[] = [];
    for (let index = from; index < items.length; index++) {
        const item = items[index];
        if (!isRecord(item)) continue;
        if (protocol === "openai" && item.role === "tool") {
            out.push({ index, callId: typeof item.tool_call_id === "string" ? item.tool_call_id : undefined, texts: stringLeaves(item.content) });
        } else if (protocol === "anthropic" && item.role === "user" && Array.isArray(item.content)) {
            for (const block of item.content) {
                if (isRecord(block) && block.type === "tool_result") out.push({ index, callId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined, texts: stringLeaves(block.content) });
            }
        } else if (protocol === "responses" && (item.type === "function_call_output" || item.type === "custom_tool_call_output")) {
            out.push({ index, callId: typeof item.call_id === "string" ? item.call_id : undefined, texts: stringLeaves(item.output) });
        } else if (protocol === "google" && item.role === "user" && Array.isArray(item.parts)) {
            for (const part of item.parts) {
                const fr = isRecord(part) && isRecord(part.functionResponse) ? part.functionResponse : undefined;
                if (fr) out.push({ index, callId: typeof fr.id === "string" && fr.id ? fr.id : undefined, name: typeof fr.name === "string" ? fr.name : undefined, texts: stringLeaves(fr.response) });
            }
        }
    }
    return out;
}

/** Trigger-shaped compress calls in the assistant turn that the final tool-result batch answers. */
function triggerCalls(protocol: WireProtocol, items: readonly unknown[], last: number): Array<{ callId?: string }> {
    const out: Array<{ callId?: string }> = [];
    const turn = protocol === "responses" ? items.slice(0, last + 1) : [items[last]];
    for (const item of turn) {
        if (!isRecord(item)) continue;
        if (protocol === "openai" && Array.isArray(item.tool_calls)) {
            for (const c of item.tool_calls) {
                const f = isRecord(c) && isRecord(c.function) ? c.function : undefined;
                if (f?.name === "compress" && isAsyncCompressTrigger(f.arguments) && typeof c.id === "string") out.push({ callId: c.id });
            }
        } else if (protocol === "anthropic" && Array.isArray(item.content)) {
            for (const b of item.content) {
                if (isRecord(b) && b.type === "tool_use" && b.name === "compress" && isAsyncCompressTrigger(b.input) && typeof b.id === "string") out.push({ callId: b.id });
            }
        } else if (protocol === "responses" && item.type === "function_call" && item.name === "compress" && isAsyncCompressTrigger(item.arguments) && typeof item.call_id === "string") {
            out.push({ callId: item.call_id });
        } else if (protocol === "google" && Array.isArray(item.parts)) {
            for (const p of item.parts) {
                const fc = isRecord(p) && isRecord(p.functionCall) ? p.functionCall : undefined;
                if (fc?.name === "compress" && isAsyncCompressTrigger(fc.args)) out.push({ callId: typeof fc.id === "string" && fc.id ? fc.id : undefined });
            }
        }
    }
    return out;
}

/** The final tool-result batch answers this job's own trigger call: a tool result carrying the exact
 *  generated result text, paired by call id with a trigger-shaped compress call in the assistant turn
 *  it answers (and, when the call id is known, that exact id). Text anywhere else never matches. */
export function carriesTriggerResult(protocol: WireProtocol, body: Record<string, unknown>, job: { callId?: string; resultText: string }): boolean {
    const items = itemsOf(protocol, body);
    if (!items || items.length === 0) return false;
    let last = -1;
    items.forEach((item, i) => { if (isAssistantItem(protocol, item)) last = i; });
    if (last < 0) return false;
    const calls = triggerCalls(protocol, items, last);
    return toolResults(protocol, items, last + 1).some((r) => {
        if (!r.texts.some((t) => t.includes(job.resultText))) return false;
        if (protocol === "google" && r.name !== "compress") return false;
        if (job.callId !== undefined && r.callId !== job.callId) return false;
        return calls.some((c) => (r.callId === undefined && c.callId === undefined) ? protocol === "google" : c.callId === r.callId);
    });
}

function toolNames(protocol: WireProtocol, body: Record<string, unknown>): string[] {
    const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : [];
    if (protocol === "google") {
        return tools.flatMap((t) => (Array.isArray(t.functionDeclarations) ? t.functionDeclarations.filter(isRecord).map((d) => String(d.name)) : []));
    }
    return tools.map((t) => String(isRecord(t.function) ? t.function.name : t.name));
}

const HOSTED_BODY_KEYS: Record<WireProtocol, readonly string[]> = {
    openai: ["web_search_options", "plugins"],
    responses: ["background"],
    anthropic: ["mcp_servers", "container"],
    google: ["cachedContent"],
};

/** Deny-by-default: every tool must be an ordinary client-executed function declaration. */
function hostedCapability(protocol: WireProtocol, body: Record<string, unknown>): string | null {
    for (const key of HOSTED_BODY_KEYS[protocol]) if (key in body && body[key] !== null && body[key] !== false) return key;
    if (body.tools === undefined) return null;
    if (!Array.isArray(body.tools)) return "tools";
    for (const tool of body.tools) {
        if (!isRecord(tool)) return "tools";
        if (protocol === "google") {
            const extra = Object.keys(tool).find((k) => k !== "functionDeclarations");
            if (extra) return extra;
            continue;
        }
        const type = tool.type;
        const ok = protocol === "anthropic" ? type === undefined || type === "custom"
            : protocol === "openai" ? type === "function" || type === "custom"
            : type === "function" || type === "custom";
        if (!ok) return `tool type ${typeof type === "string" ? type : "unknown"}`;
    }
    return null;
}

/** Why this body cannot be replayed as a fork, or null. */
export function declineReason(protocol: WireProtocol, body: Record<string, unknown>, url: string, signed: boolean): string | null {
    if (signed) return "body-signed request";
    if (!/^https?:\/\//i.test(url)) return "non-http upstream";
    for (const key of SERVER_STATE_KEYS) {
        if (!(key in body)) continue;
        if (key === "context_management" && protocol === "anthropic" && keepAllThinkingOnly(body.context_management)) continue;
        return `server-side state (${key})`;
    }
    if (protocol === "anthropic" && isRecord(body.thread) && body.thread.type === "continue") return "server-side state (thread)";
    if (!itemsOf(protocol, body)) return "unrecognized body shape";
    const hosted = hostedCapability(protocol, body);
    if (hosted) return `provider-hosted capability (${hosted})`;
    if (!toolNames(protocol, body).includes("compress")) return "compress tool not declared";
    const choice = body.tool_choice;
    if (choice !== undefined) {
        const kind = typeof choice === "string" ? choice : isRecord(choice) ? String(choice.type) : "";
        if (kind !== "auto") return `tool_choice ${kind || "forced"}`;
    }
    if (protocol === "responses" && !forcedCompressChoice(protocol, body)) return "compress declaration cannot be named in tool_choice";
    if (protocol === "google") {
        const mode = isRecord(body.toolConfig) && isRecord(body.toolConfig.functionCallingConfig) ? body.toolConfig.functionCallingConfig.mode : undefined;
        if (mode !== undefined && mode !== "AUTO") return `function calling mode ${String(mode)}`;
    }
    return null;
}

const DROPPED_HEADERS = /^(content-length|transfer-encoding|connection|host|content-md5|digest|x-amz-content-sha256|.*signature.*|.*idempotency.*)$/i;

export function forkHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (!DROPPED_HEADERS.test(k)) out[k] = v;
    return out;
}

function activeBlockKeys(session: Session): string[] {
    return session.state.blocks.filter((b) => b.active).map((b) => `${b.blockId}:${b.runId}`).sort();
}

interface FoldHint {
    startRef: string;
    endRef: string;
}

type FoldSuggestion = { hint: FoldHint; reason?: undefined } | { hint?: undefined; reason: "no-offer" | "stale-offer" | "none-offered" };

function sameSpans(a: readonly BlockSpan[], b: readonly BlockSpan[]): boolean {
    if (a.length !== b.length) return false;
    const key = (s: BlockSpan) => `${s.blockId}|${s.startRef}|${s.endRef}`;
    const seen = new Set(a.map(key));
    return b.every((s) => seen.has(key(s)));
}

/** Optional guidance for the background pass, read from the kernel's prepare-time offer: the largest viable range
 *  clearing the capture config's minimum (earliest on ties). Used only when the offer's active block layout matches
 *  the current one and both endpoints are live refs; that is a compatibility check, not proof the whole history is
 *  unchanged. No kernel calls; apply-time validation stays the only gate. Absent or incompatible offer -> no suggestion. */
export function suggestFromOffer(offer: NudgeDecision | undefined, config: Config, state: CompressionState): FoldSuggestion {
    if (!offer) return { reason: "no-offer" };
    if (!offer.activeBlockSpans || !sameSpans(offer.activeBlockSpans, activeBlockSpans(state))) return { reason: "stale-offer" };
    const minChars = config.compress.minCompressRange;
    const dead = new Set(state.deadRefs ?? []);
    const live = (ref: string) => state.messageRefs.byRef[ref] !== undefined && !dead.has(ref);
    let best: { startRef: string; endRef: string; chars: number; start: number } | undefined;
    for (const r of viableRanges(offer.compressibleRanges)) {
        const chars = r.chars ?? r.tokens * 4;
        if ((minChars > 0 && chars < minChars) || !live(r.startRef) || !live(r.endRef)) continue;
        const start = Number(r.startRef.replace(/\D/g, ""));
        if (!best || chars > best.chars || (chars === best.chars && start < best.start)) best = { startRef: r.startRef, endRef: r.endRef, chars, start };
    }
    return best ? { hint: { startRef: best.startRef, endRef: best.endRef } } : { reason: "none-offered" };
}

function directiveText(tag: string, minChars: number, hint: FoldHint | undefined): string {
    const suggestion = hint ? ` Kernel-offered suggestion (optional guidance, not a guarantee; final validation still happens when the fold is applied): startId ${hint.startRef}, endId ${hint.endRef}.` : "";
    return `Background compression pass (job ${tag}), queued by the main conversation, which carries on with the user's task separately. Do NOT continue or answer that task. The tools declared above are not executed in this pass: any call other than \`compress\` voids the whole pass. Make exactly ONE \`compress\` call with a non-empty \`content\` array: choose consumed ranges to fold and write a faithful, self-contained summary for each. Cite startId/endId as mNNNNN message ids; tool calls and tool results lying between the cited ids are folded with them and count toward the size even though they show no id tag. Together the ranges must cover at least ${minChars} characters, or the fold is rejected. Leave the most recent messages and any in-progress work unfolded.${suggestion}`;
}

/** Appends one user message in the wire's own shape; every existing item is left as-is.
 *  Gemini rejects consecutive user turns, so there the text joins a trailing user turn as one extra part. */
export function appendUserText(protocol: WireProtocol, body: Record<string, unknown>, text: string): Record<string, unknown> {
    const items = itemsOf(protocol, body) ?? [];
    const tail = items[items.length - 1];
    if (protocol === "google" && isRecord(tail) && tail.role === "user" && Array.isArray(tail.parts)) {
        return { ...body, contents: [...items.slice(0, -1), { ...tail, parts: [...tail.parts, { text }] }] };
    }
    const item = protocol === "anthropic" ? { role: "user", content: [{ type: "text", text }] }
        : protocol === "openai" ? { role: "user", content: text }
        : protocol === "responses" ? { type: "message", role: "user", content: [{ type: "input_text", text }] }
        : { role: "user", parts: [{ text }] };
    const key = protocol === "responses" ? "input" : protocol === "google" ? "contents" : "messages";
    return { ...body, [key]: [...items, item] };
}

/** Responses only: a tool_choice naming the declared `compress` tool (its own declaration type), or undefined. */
export function forcedCompressChoice(protocol: WireProtocol, body: Record<string, unknown>): Record<string, unknown> | undefined {
    if (protocol !== "responses" || !Array.isArray(body.tools)) return undefined;
    const decl = body.tools.find((t) => isRecord(t) && t.name === "compress");
    if (!isRecord(decl) || (decl.type !== "function" && decl.type !== "custom")) return undefined;
    return { type: decl.type, name: "compress" };
}

/** The background request: the captured body plus the directive item; on Responses, tool_choice also names `compress`. */
export function forkRequestBody(protocol: WireProtocol, body: Record<string, unknown>, directive: string): Record<string, unknown> {
    const appended = appendUserText(protocol, body, directive);
    const choice = forcedCompressChoice(protocol, body);
    return choice ? { ...appended, tool_choice: choice } : appended;
}

/** Send chokepoints call this for every outbound request; returns a settle callback when it captured a job. */
export function observeOutboundSend(session: Session, send: OutboundSend): ((status: number | undefined) => void) | undefined {
    if (!policy) return undefined;
    const job = jobs.get(session.id);
    if (!job || job.phase !== "awaiting-capture" || !send.body.includes(job.tag)) return undefined;
    if (!send.protocol) return undefined;
    let body: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(send.body);
        if (!isRecord(parsed)) return undefined;
        body = parsed;
    } catch {
        return undefined;
    }
    if (!carriesTriggerResult(send.protocol, body, job)) return undefined;
    const declined = declineReason(send.protocol, body, send.url, send.signed);
    if (declined) {
        dropJob(job, `request not replayable: ${declined}`, true, true);
        return undefined;
    }
    const suggestion = suggestFromOffer(send.offer, send.config, session.state);
    const minChars = send.config.compress.minCompressRange;
    job.capture = {
        url: send.url,
        headers: forkHeaders(send.headers),
        body: send.body,
        proxyUrl: send.proxyUrl,
        protocol: send.protocol,
        model: modelOf(send.protocol, body, send.url),
        ids: send.messages.map((m) => m.id),
        byRef: { ...session.state.messageRefs.byRef },
        blocks: activeBlockKeys(session),
    };
    job.phase = "running";
    loggerLog("info", `[${session.id}] [async-compress] job ${job.tag} captured (${send.protocol}, ${job.capture.ids.length} messages, suggestion ${suggestion.hint ? `${suggestion.hint.startRef}-${suggestion.hint.endRef}` : `none(${suggestion.reason})`})`);
    let settled = false;
    return (status) => {
        if (settled) return;
        settled = true;
        if (jobs.get(job.sessionId) !== job) return;
        if (status === undefined || status < 200 || status >= 300) {
            dropJob(job, `main request ${status === undefined ? "failed before a response" : `answered HTTP ${status}`}`, true);
            return;
        }
        void withoutFetchTransport(() => runFork(job, directiveText(job.tag, minChars, suggestion.hint)));
    };
}

function modelOf(protocol: WireProtocol, body: Record<string, unknown>, url: string): string | undefined {
    if (typeof body.model === "string") return body.model;
    if (protocol !== "google") return undefined;
    try { return googleModelFromPath(new URL(url).pathname); } catch { return undefined; }
}

interface ForkCall { name: string; arguments: string }

function adapterFor(protocol: WireProtocol, body: Record<string, unknown>): CompressLoopAdapter {
    if (protocol === "anthropic") return createAnthropicAdapter(body);
    if (protocol === "openai") return createOpenaiAdapter(body);
    if (protocol === "responses") return createResponsesAdapter();
    return createGoogleAdapter(body);
}

function jsonCalls(protocol: WireProtocol, json: unknown): ForkCall[] {
    if (!isRecord(json)) return [];
    if (protocol === "anthropic") {
        const content = Array.isArray(json.content) ? json.content.filter(isRecord) : [];
        return content.filter((b) => b.type === "tool_use").map((b) => ({ name: String(b.name), arguments: JSON.stringify(b.input ?? {}) }));
    }
    if (protocol === "openai") {
        const choice = Array.isArray(json.choices) && isRecord(json.choices[0]) ? json.choices[0] : undefined;
        const message = choice && isRecord(choice.message) ? choice.message : undefined;
        const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
        return calls.map((c) => { const f = isRecord(c.function) ? c.function : {}; return { name: String(f.name), arguments: typeof f.arguments === "string" ? f.arguments : JSON.stringify(f.arguments ?? {}) }; });
    }
    if (protocol === "responses") {
        const output = Array.isArray(json.output) ? json.output.filter(isRecord) : [];
        return output.filter((o) => o.type === "function_call" || o.type === "custom_tool_call").map((o) => ({ name: String(o.name), arguments: typeof o.arguments === "string" ? o.arguments : String(o.input ?? "") }));
    }
    const candidate = Array.isArray(json.candidates) && isRecord(json.candidates[0]) ? json.candidates[0] : undefined;
    const parts = candidate && isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts.filter(isRecord) : [];
    return parts.filter((p) => isRecord(p.functionCall)).map((p) => { const fc = p.functionCall as Record<string, unknown>; return { name: String(fc.name), arguments: JSON.stringify(fc.args ?? {}) }; });
}

const ALLOWED_OUTPUT: Record<Exclude<WireProtocol, "openai" | "google">, ReadonlySet<string>> = {
    anthropic: new Set(["text", "thinking", "redacted_thinking", "tool_use"]),
    responses: new Set(["message", "reasoning", "function_call", "custom_tool_call"]),
};
const ALLOWED_GOOGLE_PART_KEYS = new Set(["text", "thought", "thoughtSignature", "functionCall"]);

/** A reply item the client could not have executed (provider-run tool, grounding), or null. */
export function hostedOutput(protocol: WireProtocol, payload: unknown): string | null {
    if (!isRecord(payload) || protocol === "openai") return null;
    if (protocol === "google") {
        const candidates = Array.isArray(payload.candidates) ? payload.candidates.filter(isRecord) : [];
        for (const c of candidates) {
            for (const key of ["groundingMetadata", "urlContextMetadata"]) if (c[key] !== undefined) return key;
            const parts = isRecord(c.content) && Array.isArray(c.content.parts) ? c.content.parts : [];
            for (const p of parts) {
                const extra = isRecord(p) ? Object.keys(p).find((k) => !ALLOWED_GOOGLE_PART_KEYS.has(k)) : "part";
                if (extra) return extra;
            }
        }
        return null;
    }
    const allowed = ALLOWED_OUTPUT[protocol];
    const items: unknown[] = protocol === "anthropic"
        ? [payload.content_block, ...(Array.isArray(payload.content) ? payload.content : [])]
        : [payload.item, ...(Array.isArray(payload.output) ? payload.output : []), ...(isRecord(payload.response) && Array.isArray(payload.response.output) ? payload.response.output : [])];
    for (const item of items) {
        if (item === undefined) continue;
        const type = isRecord(item) ? item.type : undefined;
        if (typeof type !== "string" || !allowed.has(type)) return `output ${typeof type === "string" ? type : "unknown"}`;
    }
    return null;
}

const MAX_FORK_REPLY_BYTES = 8 * 1024 * 1024;

function sseData(text: string): unknown[] {
    const out: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { out.push(JSON.parse(data)); } catch { /* the adapter reports malformed streams */ }
    }
    return out;
}

/** Reads at most `limit` bytes; past it the stream is cancelled at once and null is returned. */
export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
                await reader.cancel().catch(() => {});
                return null;
            }
            chunks.push(value);
        }
    } catch (err) {
        await reader.cancel().catch(() => {});
        throw err;
    } finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
}

const KNOWN_MEDIA_TYPES = new Set(["text/event-stream", "application/json", "text/html", "text/plain", "application/problem+json", "application/x-ndjson", "application/octet-stream"]);

/** Diagnostic label only: a known media type, "none", or "other" — never the raw header value. */
export function mediaTypeClass(header: string | null): string {
    if (header === null) return "none";
    const token = header.split(";")[0]!.trim().toLowerCase();
    return KNOWN_MEDIA_TYPES.has(token) ? token : "other";
}

type ReplyFraming = "sse" | "json" | "html" | "empty" | "other";

/** Classifies a decoded reply by its first non-blank characters (a BOM is already removed by TextDecoder). */
function replyFraming(text: string): ReplyFraming {
    const head = text.slice(0, 4096).trimStart();
    if (head.length === 0) return text.trim().length === 0 ? "empty" : "other";
    if (/^(?::|(?:data|event|id|retry)[ \t]*:)/.test(head)) return "sse";
    if (head[0] === "{" || head[0] === "[") return "json";
    if (head[0] === "<") return "html";
    return "other";
}

export async function readForkCalls(protocol: WireProtocol, body: Record<string, unknown>, response: Response, limit = MAX_FORK_REPLY_BYTES): Promise<ForkCall[] | string> {
    const media = mediaTypeClass(response.headers.get("content-type"));
    if (!response.body) return "empty fork response";
    const raw = await readBounded(response.body, limit);
    if (!raw) return "fork reply too large";
    const text = new TextDecoder().decode(raw);
    const framing = replyFraming(text);
    if (media === "text/event-stream" || framing === "sse") {
        for (const event of sseData(text)) {
            const hosted = hostedOutput(protocol, event);
            if (hosted) return `fork reply carried a provider-hosted item (${hosted})`;
        }
        const calls: ForkCall[] = [];
        for await (const event of adapterFor(protocol, body).parseStream(new Response(text).body as ReadableStream<Uint8Array>, 2)) {
            if (event.kind === "tool_call") calls.push({ name: event.name, arguments: event.arguments });
            else if (event.kind === "error") return "fork stream error";
            else if (event.kind === "done" && event.truncated) return "fork output truncated";
        }
        return calls;
    }
    let json: unknown;
    try { json = JSON.parse(text); } catch { return `fork reply was neither a stream nor JSON (type=${media} framing=${framing} bytes=${raw.byteLength})`; }
    const hosted = hostedOutput(protocol, json);
    if (hosted) return `fork reply carried a provider-hosted item (${hosted})`;
    return jsonCalls(protocol, json);
}

const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Diagnostic label: names of declared tools only (anything else is "other"), deduped, at most four. */
function otherCallNames(calls: readonly ForkCall[], declared: readonly string[]): string {
    const known = new Set(declared);
    const names: string[] = [];
    for (const c of calls) {
        if (c.name === "compress") continue;
        const name = SAFE_TOOL_NAME.test(c.name) && known.has(c.name) ? c.name : "other";
        if (!names.includes(name)) names.push(name);
    }
    return `${names.slice(0, 4).join(",")}${names.length > 4 ? ",..." : ""}`;
}

/** Exactly one compress call, every entry valid; anything else rejects the whole reply. */
export function rangesFromForkCalls(calls: readonly ForkCall[], declared: readonly string[] = []): ParsedCompress | string {
    const compressCalls = calls.filter((c) => c.name === "compress").length;
    if (calls.length === 0) return "fork made no compress call";
    if (compressCalls !== calls.length) return `fork called a non-compress tool (names=${otherCallNames(calls, declared)}; compress calls=${compressCalls})`;
    if (calls.length > 1) return `fork made more than one compress call (${compressCalls})`;
    const parsed = parseCompressInput(calls[0]!.arguments);
    if (parsed.ranges.length === 0) return "fork compress call carried no valid range";
    if (parsed.diagnostics.invalidItems > 0 || parsed.diagnostics.kind === "truncated") return "fork compress call had invalid entries";
    return parsed;
}

async function runFork(job: Job, directive: string): Promise<void> {
    const active = policy;
    const capture = job.capture;
    if (!active || !capture) return;
    arm(job, active.forkTimeoutMs, "background pass timed out", true);
    let outcome: ParsedCompress | string;
    try {
        const original = JSON.parse(capture.body) as Record<string, unknown>;
        const forkBody = forkRequestBody(capture.protocol, original, directive);
        const dispatcher = proxyDispatcher(capture.proxyUrl);
        const { response, clearTimer } = await fetchWithTimeout(capture.url, {
            method: "POST",
            headers: capture.headers,
            body: JSON.stringify(forkBody),
            ...(dispatcher ? { dispatcher } : {}),
        }, active.forkTimeoutMs, job.controller.signal);
        try {
            outcome = response.ok ? await readForkCalls(capture.protocol, original, response).then((calls) => typeof calls === "string" ? calls : rangesFromForkCalls(calls, toolNames(capture.protocol, original)))
                : `background pass answered HTTP ${response.status}`;
            if (!response.ok) await response.body?.cancel().catch(() => {});
        } finally {
            clearTimer();
        }
    } catch (err) {
        outcome = job.controller.signal.aborted ? "background pass cancelled" : `background pass failed (${err instanceof Error ? err.name : "error"})`;
    }
    if (jobs.get(job.sessionId) !== job) return;
    if (typeof outcome === "string") {
        dropJob(job, outcome, true, true);
        return;
    }
    job.parsed = outcome;
    job.phase = "ready";
    capture.headers = {};
    capture.body = "";
    arm(job, active.readyTtlMs, "result expired before a later request arrived", false);
    loggerLog("info", `[${job.sessionId}] [async-compress] job ${job.tag} ready (${outcome.ranges.length} range(s))`);
}

function staleReason(capture: Capture, session: Session, messages: readonly CoreMessage[], ranges: ParsedRanges): string | null {
    const blocks = activeBlockKeys(session);
    if (blocks.length !== capture.blocks.length || blocks.some((b, i) => b !== capture.blocks[i])) return "compression state changed since the snapshot";
    const current = messages.map((m) => m.id);
    for (const range of ranges) {
        const start = capture.byRef[range.startRef];
        const end = capture.byRef[range.endRef];
        if (start === undefined || end === undefined) return `range ${range.startRef}-${range.endRef} cites ids outside the snapshot`;
        if (session.state.messageRefs.byRef[range.startRef] !== start || session.state.messageRefs.byRef[range.endRef] !== end) return `ref ${range.startRef}/${range.endRef} rebound`;
        const from = capture.ids.indexOf(start);
        const to = capture.ids.indexOf(end);
        if (from < 0 || to < from) return `range ${range.startRef}-${range.endRef} not in the snapshot view`;
        const at = current.indexOf(start);
        if (at < 0 || capture.ids.slice(from, to + 1).some((id, i) => current[at + i] !== id)) return `range ${range.startRef}-${range.endRef} changed in the current view`;
    }
    return null;
}

interface AsyncApplyContext {
    core: CompressionCore;
    config: Config;
    protocol: WireProtocol;
    upstreamUrl: string;
    model: string | undefined;
    originalMessages: CoreMessage[];
    processedMessages: CoreMessage[];
    log: (msg: string) => void;
}

/** Under the session lock, after prepare. True when blocks were committed (caller re-prepares). */
export function applyReadyAsyncCompress(session: Session, ctx: AsyncApplyContext): boolean {
    const job = jobs.get(session.id);
    if (!policy || !job || job.phase !== "ready" || !job.capture || !job.parsed) return false;
    const capture = job.capture;
    const diagnostics = job.parsed.diagnostics;
    const ranges = job.parsed.ranges.map((r) => ({ ...r, compressCallId: `${ASYNC_COMPRESS_CALL_ID_PREFIX}${job.id}` }));
    normalizeRangeOrder(ranges);
    const origin = (url: string): string => { try { return new URL(url).origin; } catch { return url; } };
    const switched = capture.protocol !== ctx.protocol ? "wire changed"
        : origin(capture.url) !== origin(ctx.upstreamUrl) ? "upstream changed"
        : capture.model !== ctx.model ? "model changed" : null;
    if (switched) {
        dropJob(job, `discarded: ${switched}`, true);
        return false;
    }
    const stale = staleReason(capture, session, ctx.originalMessages, ranges);
    if (stale) {
        dropJob(job, `discarded as stale: ${stale}`, true);
        return false;
    }
    const before = new Map(session.state.blocks.map((b) => [b.blockId, b.runId] as const));
    let dry;
    try {
        dry = ctx.core.applyCompression({ ranges, messages: ctx.originalMessages, state: structuredClone(session.state), config: ctx.config });
    } catch (err) {
        dropJob(job, `discarded: validation threw (${err instanceof Error ? err.name : "error"})`, true, true);
        return false;
    }
    const refolded = dry.state.blocks.filter((b) => before.has(b.blockId) && before.get(b.blockId) !== b.runId);
    const invalid = dry.result.errors.length > 0 ? `kernel rejected: ${dry.result.errors.slice(0, 2).join("; ")}`
        : dry.result.blocksCreated === 0 ? "no block would be created"
        : refolded.length > 0 ? "would refold an existing block in place" : null;
    if (invalid) {
        dropJob(job, `discarded: ${invalid}`, true, true);
        return false;
    }
    const result = applyRanges({ ranges, diagnostics }, {
        core: ctx.core, config: ctx.config, messages: ctx.processedMessages.length > 0 ? ctx.processedMessages : ctx.originalMessages,
        compressMessages: ctx.originalMessages, session, log: ctx.log,
    }, { loopTracking: false });
    jobs.delete(session.id);
    if (job.timer) clearTimeout(job.timer);
    job.capture = undefined;
    job.parsed = undefined;
    if (result.outcome === "refused" || (result.blocksCreated ?? 0) === 0) {
        queueNote(session.id, job.tag, "discarded: the fold was refused at commit");
        return false;
    }
    markDirty(session);
    loggerLog("info", `[${session.id}] [async-compress] job ${job.tag} applied (${result.blocksCreated} block(s))`);
    return true;
}

/** Attaches the pending failure note (if any) as a trailing user message; the note stays pending until settled. */
export function attachAsyncNote(owner: object, session: Session, protocol: WireProtocol, body: string | Buffer): string | Buffer {
    const note = notes.get(session.id);
    if (!note || typeof body !== "string") return body;
    try {
        const parsed: unknown = JSON.parse(body);
        if (!isRecord(parsed) || !itemsOf(protocol, parsed)) return body;
        attachedNotes.set(owner, { sessionId: session.id, noteId: note.id });
        return JSON.stringify(appendUserText(protocol, parsed, note.text));
    } catch {
        return body;
    }
}

/** Upstream accepted the request that carried the note: consume exactly that note. */
export function settleAsyncNote(owner: object, ok: boolean): void {
    const attached = attachedNotes.get(owner);
    if (!attached || !ok) return;
    attachedNotes.delete(owner);
    if (notes.get(attached.sessionId)?.id === attached.noteId) notes.delete(attached.sessionId);
}
