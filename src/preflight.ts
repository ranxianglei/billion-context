import {
    defaultCountTokens,
    viableRanges,
    type CompressionCore,
    type Config,
    type CoreMessage,
    type Prompts,
} from "acp-kernel";
import { buildCompressSystemPrompt, parseCompressInput } from "./compress-tool.js";
import { applyRanges, type RewriteCtx } from "./stream.js";
import { fetchWithRetry, UpstreamHttpError } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { lastCompressSuffix, type Session } from "./session.js";

// #247: proactive pre-forward compression. When the session's real context
// (previous turn's upstream input_tokens) exceeds the current model's window
// (e.g. the user switched from a 1M-context model to a 260k one), the payload
// overflows at forward time and the reactive nudge can never fire — the
// request itself is rejected by the upstream, so the model never sees the
// nudge and every subsequent request overflows identically (stuck session).
// This module compresses the oldest compressible ranges first, via dedicated
// summarization calls sized to fit the smaller window, before the payload is
// forwarded.

const MAX_PREFLIGHT_ROUNDS = 8;
const CHUNK_FRACTION = 0.6;
const MIN_CHUNK_TOKENS = 2000;
const MIN_SUMMARY_CHARS = 50;
const MAX_SUMMARY_OUTPUT_TOKENS = 8192;

export type PreflightProtocol = "anthropic" | "openai" | "responses";

export interface PreflightDeps {
    core: CompressionCore;
    session: Session;
    config: Config;
    prompts: Prompts;
    protocol: PreflightProtocol;
    url: string;
    headers: Record<string, string>;
    model: string;
    proxyUrl?: string;
    signal?: AbortSignal;
    log: (level: string, msg: string) => void;
    /** Constant floor on the forwarded-payload size for this request (image bytes, #488). Folding only ever removes images, so adding this to every text estimate keeps the fit decision sound for multimodal payloads. */
    imageFloor?: number;
}

export type PreflightFailureKind = "upstream" | "exhausted" | "aborted";

export interface PreflightFailure {
    kind: PreflightFailureKind;
    /** Upstream HTTP status when kind === "upstream" and the failure was an HTTP response. */
    status?: number;
    /** Human-readable cause (safe to surface to the client). */
    detail: string;
}

export interface PreflightResult {
    compressedRanges: number;
    savedTokens: number;
    /** Token estimate of the final (post-fold) payload, from the payload
     *  itself — NOT floored on the session's lastInputTokens, which can be
     *  stale (e.g. a double-counted usage report, #300). The caller uses it
     *  to decide whether forwarding as-is is actually safe. */
    payloadEstimate: number;
    /** Why the loop stopped while the payload still overflows the window.
     *  Undefined when the payload fits. */
    failure?: PreflightFailure;
}

function refMaps(messages: CoreMessage[], state: Session["state"]): { refToIdx: Map<string, number>; idxToRef: Map<number, string> } {
    const refToIdx = new Map<string, number>();
    const idxToRef = new Map<number, string>();
    const byRaw = state.messageRefs?.byRaw ?? {};
    messages.forEach((m, i) => {
        const ref = byRaw[m.id];
        if (!ref) return;
        if (!refToIdx.has(ref)) refToIdx.set(ref, i);
        idxToRef.set(i, ref);
    });
    return { refToIdx, idxToRef };
}

function refNum(ref: string): number {
    return Number(ref.replace(/\D/g, "")) || 0;
}

// CJK-aware: the fast chars/4 estimator undercounts CJK ~4× (CJK is ~1
// token/char), which made the fit check believe an oversized CJK payload
// already fit and skip compression. defaultCountTokens counts CJK per-char.
export function estimateCoreMessages(messages: CoreMessage[]): number {
    let tokens = 0;
    for (const m of messages) tokens += defaultCountTokens(m.text ?? "");
    return tokens;
}

function rangeChars(messages: CoreMessage[], startIdx: number, endIdx: number): number {
    let chars = 0;
    for (let i = startIdx; i <= endIdx && i < messages.length; i++) {
        chars += (messages[i].text ?? "").length;
    }
    return chars;
}

function renderRange(messages: CoreMessage[], startIdx: number, endIdx: number): string {
    const parts: string[] = [];
    for (let i = startIdx; i <= endIdx && i < messages.length; i++) {
        const m = messages[i];
        const text = (m.text ?? "").trim();
        if (!text) continue;
        const label =
            m.contentType === "tool-call"
                ? `assistant tool-call ${m.toolName ?? "?"}`
                : m.contentType === "tool-result"
                  ? `tool result ${m.toolName ?? "?"}`
                  : m.contentType === "reasoning"
                    ? "assistant reasoning"
                    : m.role;
        parts.push(`[${label}]\n${text}`);
    }
    return parts.join("\n\n");
}

function splitChunks(messages: CoreMessage[], startIdx: number, endIdx: number, budgetTokens: number): Array<[number, number]> {
    const chunks: Array<[number, number]> = [];
    let cur = startIdx;
    while (cur <= endIdx) {
        let tokens = 0;
        let last = cur;
        for (let i = cur; i <= endIdx; i++) {
            const t = defaultCountTokens(messages[i].text ?? "");
            if (tokens + t > budgetTokens && i > cur) break;
            tokens += t;
            last = i;
        }
        chunks.push([cur, last]);
        cur = last + 1;
    }
    return chunks;
}

function summaryPayload(protocol: PreflightProtocol, model: string, system: string, content: string): Record<string, unknown> {
    if (protocol === "anthropic") {
        return { model, max_tokens: MAX_SUMMARY_OUTPUT_TOKENS, system, messages: [{ role: "user", content }], stream: false };
    }
    if (protocol === "openai") {
        return { model, max_tokens: MAX_SUMMARY_OUTPUT_TOKENS, messages: [{ role: "system", content: system }, { role: "user", content }], stream: false };
    }
    // #488: codex relays reject Responses calls without store:false ("Store must be set to false").
    return { model, max_output_tokens: MAX_SUMMARY_OUTPUT_TOKENS, instructions: system, input: [{ role: "user", content }], stream: false, store: false };
}

function extractSummaryText(protocol: PreflightProtocol, json: Record<string, unknown>): string {
    if (protocol === "anthropic") {
        const content = json.content;
        if (!Array.isArray(content)) return "";
        return content
            .map((c) => (c && typeof c === "object" && (c as Record<string, unknown>).type === "text" && typeof (c as Record<string, unknown>).text === "string" ? (c as Record<string, string>).text : ""))
            .join("");
    }
    if (protocol === "openai") {
        const choices = json.choices;
        if (!Array.isArray(choices) || choices.length === 0) return "";
        const msg = (choices[0] as Record<string, unknown>).message;
        if (!msg || typeof msg !== "object") return "";
        const c = (msg as Record<string, unknown>).content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
            return c.map((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, string>).text : "")).join("");
        }
        return "";
    }
    if (typeof json.output_text === "string") return json.output_text;
    const output = json.output;
    if (!Array.isArray(output)) return "";
    return output
        .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>).content : undefined))
        .filter((c): c is unknown[] => Array.isArray(c))
        .flatMap((c) => c)
        .map((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, string>).text : ""))
        .join("");
}

async function summarizeRange(deps: PreflightDeps, content: string, startRef: string, endRef: string): Promise<string | null> {
    const system =
        buildCompressSystemPrompt(deps.prompts) +
        `\n\nTASK: The conversation segment below (messages ${startRef}–${endRef}) must be compressed because the session context exceeds the current model's window. Write a tier-1 compression summary of the segment following every rule above. Output ONLY the summary text — no preamble, no closing remarks, no tool calls.`;
    const { response, clearTimer } = await fetchWithRetry(
        deps.url,
        {
            method: "POST",
            headers: { "content-type": "application/json", ...deps.headers },
            body: JSON.stringify(summaryPayload(deps.protocol, deps.model, system, content)),
            dispatcher: proxyDispatcher(deps.proxyUrl),
        },
        undefined,
        deps.signal,
        (info) => {
            // #189: correlate the rejection with the rewrite that preceded it.
            deps.log("warn", `[preflight] summary attempt ${info.attempt} got HTTP ${info.status}; retrying in ${info.delayMs}ms${lastCompressSuffix(deps.session.lastCompress)}`);
        },
    );
    try {
        const text = await response.text();
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            deps.log("warn", `[preflight] summary response was not JSON: ${text.slice(0, 200)}`);
            return null;
        }
        if (!json || typeof json !== "object") return null;
        const summary = extractSummaryText(deps.protocol, json as Record<string, unknown>).trim();
        if (summary.length < MIN_SUMMARY_CHARS) {
            deps.log("warn", `[preflight] summary too short (${summary.length} chars); skipping range`);
            return null;
        }
        return summary;
    } finally {
        clearTimer();
    }
}

const ABORTED_FAILURE: PreflightFailure = { kind: "aborted", detail: "the client disconnected during preflight compression" };

export async function preflightCompress(deps: PreflightDeps, messages: CoreMessage[]): Promise<PreflightResult> {
    const limit = deps.config.modelContextLimit;
    const result: PreflightResult = { compressedRanges: 0, savedTokens: 0, payloadEstimate: estimateCoreMessages(messages) + (deps.imageFloor ?? 0) };
    if (limit <= 0) return result;
    const budget = Math.max(MIN_CHUNK_TOKENS, Math.floor(limit * CHUNK_FRACTION));
    // applyCompression rejects ranges below config.compress.minCompressRange
    // chars, so never spend a summarization call on a chunk that can't apply.
    const minChars = deps.config.compress.minCompressRange;
    // The fit check runs on the real post-fold payload size, not on
    // stats.lastInputTokens: a fresh session (its id rotated, e.g. after a
    // model switch) starts at 0 while still carrying a full raw history that
    // overflows the smaller window.
    let currentTokens = deps.session.stats.lastInputTokens;
    let startTokens = -1;
    let failure: PreflightFailure | undefined;
    for (let round = 0; round < MAX_PREFLIGHT_ROUNDS; round++) {
        if (deps.signal?.aborted) {
            failure = ABORTED_FAILURE;
            break;
        }
        // Re-run the pipeline each round: every successful compress renumbers
        // the surviving refs, so the previous round's range refs are stale.
        const turn = deps.core.processTurn({
            messages,
            state: deps.session.state,
            config: deps.config,
            tokenCount: currentTokens,
            renderTags: "text-only",
        });
        deps.session.state = turn.state;
        // Floor on the session's measured input baseline: the upstream's
        // input_tokens also covers the system prompt + tool definitions, which
        // are not in turn.messages, so the direct estimate can undershoot.
        currentTokens = Math.max(deps.session.stats.lastInputTokens, estimateCoreMessages(turn.messages) + (deps.imageFloor ?? 0));
        // The caller's forward/fail-fast gate uses the payload's own estimate
        // (the floor can be stale — see PreflightResult.payloadEstimate).
        result.payloadEstimate = estimateCoreMessages(turn.messages) + (deps.imageFloor ?? 0);
        if (startTokens < 0) startTokens = currentTokens;
        if (currentTokens < limit) break;
        const ranges = viableRanges(turn.nudge?.compressibleRanges ?? []);
        if (ranges.length === 0) {
            failure = { kind: "exhausted", detail: "no compressible ranges remain in the conversation" };
            break;
        }
        const range = [...ranges].sort((a, b) => refNum(a.startRef) - refNum(b.startRef))[0];
        const { refToIdx } = refMaps(messages, deps.session.state);
        const startIdx = refToIdx.get(range.startRef);
        const endIdx = refToIdx.get(range.endRef);
        if (startIdx === undefined || endIdx === undefined || startIdx > endIdx) {
            failure = { kind: "exhausted", detail: "the compressible range no longer resolves to payload messages" };
            break;
        }
        let appliedThisRound = 0;
        for (const [cs, ce] of splitChunks(messages, startIdx, endIdx, budget)) {
            if (currentTokens < limit) break;
            if (deps.signal?.aborted) {
                failure = ABORTED_FAILURE;
                break;
            }
            const maps = refMaps(messages, deps.session.state);
            const startRef = maps.idxToRef.get(cs);
            const endRef = maps.idxToRef.get(ce);
            if (!startRef || !endRef) continue;
            if (rangeChars(messages, cs, ce) < minChars) continue;
            const content = renderRange(messages, cs, ce);
            if (content.length === 0) continue;
            let summary: string | null;
            try {
                summary = await summarizeRange(deps, content, startRef, endRef);
            } catch (err) {
                if (err instanceof UpstreamHttpError) {
                    failure = {
                        kind: "upstream",
                        status: err.status,
                        detail: err.status === 429
                            ? `the summarization call was rate-limited by the upstream (HTTP 429)`
                            : `the summarization call was rejected by the upstream (HTTP ${err.status})`,
                    };
                    deps.log("warn", `[preflight] summarization failed: HTTP ${err.status} ${err.body.slice(0, 200)}`);
                } else if (deps.signal?.aborted) {
                    failure = ABORTED_FAILURE;
                    deps.log("warn", `[preflight] summarization aborted: client disconnected`);
                } else {
                    failure = { kind: "upstream", detail: `the summarization call failed: ${String(err)}` };
                    deps.log("warn", `[preflight] summarization failed: ${String(err)}`);
                }
                break;
            }
            if (!summary) continue;
            const ctx: RewriteCtx = {
                core: deps.core,
                config: deps.config,
                messages,
                session: deps.session,
                log: (msg) => deps.log("info", msg),
            };
            const creditBefore = deps.session.stats.compressCreditTokens;
            const applied = applyRanges(parseCompressInput({ content: [{ startId: startRef, endId: endRef, summary, topic: "preflight overflow compress" }] }), ctx);
            if (applied.startsWith("[Compression FAILED")) {
                deps.log("warn", `[preflight] ${applied}`);
                continue;
            }
            // The summary itself re-enters the payload; net its cost against
            // both the folded size and the session's input baseline.
            const compressed = deps.session.stats.compressCreditTokens - creditBefore;
            currentTokens = Math.max(0, currentTokens - compressed + defaultCountTokens(summary));
            deps.session.stats.lastInputTokens += defaultCountTokens(summary);
            appliedThisRound += 1;
            result.compressedRanges += 1;
        }
        if (appliedThisRound === 0) {
            if (!failure) {
                failure = { kind: "exhausted", detail: "no range could be compressed (chunks below minCompressRange or the summarization responses were unusable)" };
            }
            break;
        }
    }
    if (!failure && currentTokens >= limit) {
        failure = { kind: "exhausted", detail: `the compress budget was exhausted after ${MAX_PREFLIGHT_ROUNDS} rounds` };
    }
    if (result.compressedRanges > 0) deps.session.stats.lastInputTokens = currentTokens;
    result.savedTokens = Math.max(0, startTokens - currentTokens);
    if (currentTokens >= limit) result.failure = failure;
    return result;
}
