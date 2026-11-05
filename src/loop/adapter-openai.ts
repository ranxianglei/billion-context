import type { CoreMessage } from "acp-kernel";
import { isRenderedSummaryMessage } from "acp-kernel";
import { coreToOpenai, injectOpenaiSystem } from "acp-kernel/wire";
import { buildVisibilityMarker } from "./core.js";
import { composeStreamFilters, createBiliArtifactFilter, createIdentityStreamFilter, createMarkerLineFilter, createTagEchoFilter } from "./tag-echo-filter.js";
import { degenerateTurnWarning } from "../degenerate-turn.js";
import { log as loggerLog } from "../logger.js";
import { normalizeSseLineEndings, finalizeSseLineEndings } from "../sse-util.js";
import { hardenOpenaiAssistantContent, systemToUser } from "../util.js";

import type {
    CompressLoopAdapter,
    EmitCompletionOpts,
    ParsedStreamEvent,
    ToolCallEmit,
} from "./core.js";

const PROXY_TOOL_SET = new Set([
    "compress", "decompress", "search_context", "acp_status",
    "bili_compress", "bili_decompress", "bili_search_context", "bili_status",
]);

// Given a raw SSE chunk that carries tool_call fragments, decide how to
// replay it for a real-tool round: "keep" = every fragment belongs to a real
// call (forward verbatim), null = nothing real in it (drop), or a rewritten
// copy keeping only the real fragments (mixed chunk).
function filterRealToolFragments(
    parsed: Record<string, unknown>,
    realIndexes: Set<number>,
): "keep" | null | Record<string, unknown> {
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    const tcs = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!tcs || tcs.length === 0) return "keep";
    let anyReal = false;
    let anyProxy = false;
    for (const tc of tcs) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        if (realIndexes.has(idx)) anyReal = true;
        else anyProxy = true;
    }
    if (!anyProxy) return "keep";
    if (!anyReal) return null;
    const filtered: Record<string, unknown> = { ...parsed };
    const filteredChoices: Array<Record<string, unknown>> = [...(choices as Array<Record<string, unknown>>)];
    const filteredChoice: Record<string, unknown> = { ...(choice as Record<string, unknown>) };
    const filteredDelta: Record<string, unknown> = { ...(delta as Record<string, unknown>) };
    filteredDelta.tool_calls = tcs.filter((tc) => realIndexes.has(typeof tc.index === "number" ? tc.index : 0));
    filteredChoice.delta = filteredDelta;
    filteredChoices[0] = filteredChoice;
    filtered.choices = filteredChoices;
    return filtered;
}

// #1881: settle drops proxy-only frames without forwarding their sibling prose.
// Rebuild such a frame without tool_calls so that prose still reaches the
// client. The stored copy already carries cleaned values; null when nothing
// visible is left after filtering (those fields were deleted at push time).
function withheldProseFrame(parsed: Record<string, unknown>): Buffer | null {
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (!choice || !delta) return null;
    const ct = typeof delta.content === "string" ? delta.content : "";
    const rc = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    if (ct.length === 0 && rc.length === 0) return null;
    const cleanDelta = { ...delta };
    delete cleanDelta.tool_calls;
    return Buffer.from("data: " + JSON.stringify({ ...parsed, choices: [{ ...choice, delta: cleanDelta }, ...(choices ?? []).slice(1)] }) + "\n\n", "utf8");
}

interface ToolCallBuffer {
    index: number;
    id: string;
    name: string;
    arguments: string;
    frags: number;
    /** Set on first fragment: did THAT fragment carry the (first part of) the name? */
    nameInFirst?: boolean;
}

async function* iterSseChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
        while (true) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
                ({ done, value } = await reader.read());
            } catch {
                break;
            }
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            buf = normalizeSseLineEndings(buf);
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (raw.trim().length > 0) yield raw;
            }
        }
        buf = finalizeSseLineEndings(buf);
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (raw.trim().length > 0) yield raw;
        }
        if (buf.trim().length > 0) yield buf;
    } finally {
        reader.releaseLock();
    }
}

// Rebuild one SSE frame's choices[0].delta with cleaned field values (#1881):
// a filtered frame must reach the client with the CLEANED bytes — forwarding
// the original raw frame leaks the echo the filter just removed. Fields that
// filtered down to empty are dropped from the delta rather than sent as "".
function applyDeltaFields(parsed: Record<string, unknown>, fields: Record<string, string>): Record<string, unknown> {
    const clone = { ...parsed } as { choices?: Array<Record<string, unknown>> };
    if (clone.choices && clone.choices.length > 0) {
        const choice = { ...(clone.choices[0] as Record<string, unknown>) };
        const delta = { ...(choice.delta as Record<string, unknown>) };
        for (const [k, v] of Object.entries(fields)) {
            if (v === "") delete delta[k];
            else delta[k] = v;
        }
        choice.delta = delta;
        clone.choices = [choice, ...clone.choices.slice(1)];
    }
    return clone;
}
function rewriteDeltaFields(parsed: Record<string, unknown>, fields: Record<string, string>): Buffer {
    return Buffer.from(`data: ${JSON.stringify(applyDeltaFields(parsed, fields))}\n\n`, "utf8");
}

// A chunk forwarded verbatim must never carry finish_reason: the ACP loop may run
// another upstream round after this one (core.ts reRequest), and the completion is
// emitted once, at the end, by emitCompletion. Leaking an early finish makes every
// later token "content after the finish reason" to the client.
function stripFinishReasonChunk(buf: Buffer): Buffer {
    const m = /^data: (.*)\n\n$/s.exec(buf.toString("utf8"));
    if (!m) return buf;
    try {
        const parsed = JSON.parse(m[1]) as { choices?: Array<Record<string, unknown>> };
        if (!Array.isArray(parsed.choices)) return buf;
        parsed.choices = parsed.choices.map((c) => ({ ...c, finish_reason: null }));
        return Buffer.from(`data: ${JSON.stringify(parsed)}\n\n`, "utf8");
    } catch {
        return buf;
    }
}

// OpenAI-wire upstreams disagree on where the cached-prompt count lives: the
// standard field is prompt_tokens_details.cached_tokens, while DeepSeek reports
// KV-cache hits as top-level prompt_cache_hit_tokens (#779). Both mean "input
// tokens served from cache", so normalize to one number.
function openaiCachedTokens(u: Record<string, unknown>): number | undefined {
    const pd = u.prompt_tokens_details as Record<string, unknown> | undefined;
    if (typeof pd?.cached_tokens === "number") return pd.cached_tokens;
    if (typeof u.prompt_cache_hit_tokens === "number") return u.prompt_cache_hit_tokens;
    return undefined;
}

export function createOpenaiAdapter(requestBody: Record<string, unknown>, clientSystem?: string, absorbName?: string, notes?: string[], errorShape: "protocol" | "completion" = "protocol"): CompressLoopAdapter {
    const model = (requestBody.model as string) ?? "unknown";
    let responseId = `chatcmpl-proxy-${Date.now()}`;
    let toolIndex = 0;

    const makeBase = () => ({
        id: responseId,
        object: "chat.completion.chunk" as const,
        created: Date.now(),
        model,
    });

    const buildContent = (content: string): Buffer =>
        Buffer.from(
            `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Date.now(),
                model,
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`,
            "utf8",
        );

    const buildReasoning = (content: string): Buffer =>
        Buffer.from(
            `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Date.now(),
                model,
                choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
            })}\n\n`,
            "utf8",
        );

    const buildToolCall = (call: ToolCallEmit): Buffer => {
        const idx = toolIndex++;
        return Buffer.from(
            `data: ${JSON.stringify({
                ...makeBase(),
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: idx,
                            id: call.callId,
                            type: "function",
                            function: { name: call.name, arguments: call.arguments },
                        }],
                    },
                    finish_reason: null,
                }],
            })}\n\n`,
            "utf8",
        );
    };

    const buildFinish = (finishReason: string, usage: Record<string, unknown> | null): Buffer =>
        Buffer.from(
            `data: ${JSON.stringify({
                ...makeBase(),
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                ...(usage ? { usage } : {}),
            })}\n\n`,
            "utf8",
        );

    return {
        buildRequest(coreMessages, systemPrompt, body) {
            // Kernel 0.0.37 hoists the leading system/developer prefix out of
            // the openai fold space (fingerprints must not depend on host
            // runtime state), so coreMessages no longer carries it — re-inject
            // the CLIENT's original system ahead of the compress prompt,
            // mirroring the anthropic adapter's anthropicSystem path.
            // #4166: re-voice ONLY bili's own summary carriers; client-origin
            // mid system/developer cores re-emit verbatim (rawOpenaiMessage
            // sidecar) and must match the prepare lane byte-for-byte.
            const messages = hardenOpenaiAssistantContent(coreToOpenai(systemToUser(coreMessages, (m) => isRenderedSummaryMessage(m))));
            const withSys = injectOpenaiSystem(messages, [clientSystem, systemPrompt].filter((p): p is string => typeof p === "string" && p.length > 0));
            const withNotes = notes && notes.length > 0
                ? [...withSys, ...notes.map((text) => ({ role: "user" as const, content: text }))]
                : withSys;
            return { ...body, messages: withNotes };
        },

        async *parseStream(upstream, round) {
            const pending = new Map<number, ToolCallBuffer>();
            // #206: strip model-imitated render tags from PROSE deltas; the
            // filter may hold back a short tail, flushed at finish/[DONE].
            // #1881: one instance PER TEXT FIELD — content and
            // reasoning_content interleave across one stream's deltas, so a
            // shared instance would hold a tag-shaped tail against the wrong
            // field's bytes (residue leak or content loss). Tool-call
            // arguments never enter any filter (#1039 invariant).
            // Unified ACP invariant: the reasoning channel rides an IDENTITY
            // filter — thinking is never rewritten (matches signed-thinking
            // treatment in the anthropic/google adapters, #1960/KDD#10).
            // m00885: whole-field absorb-emission drop is armed only when this
            // request instructed the model about absorb (server-side provenance
            // — the absorb section exists on this request's wire iff absorbName
            // was resolved for it).
            const absorbArmedLocal = absorbName !== undefined;
            // m00885: the shipped request text lets the filter keep an
            // emission-shaped span the user asked to be output verbatim.
            const requestText = JSON.stringify(requestBody);
            const makeFieldFilter = () => composeStreamFilters(
                composeStreamFilters(
                    createTagEchoFilter((snippet) => {
                        loggerLog("warn", `[tag-echo] stripped model-emitted render tag: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }, (snippet) => {
                        // #2190: residue audit — log-only, see plugin.ts twins.
                        loggerLog("warn", `[tag-echo] filter released echo-residue-shaped bytes (#2190): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }, absorbArmedLocal, requestText),
                    createMarkerLineFilter((snippet) => {
                        loggerLog("warn", `[marker-echo] stripped model-emitted ACP confirmation marker: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                    }),
                ),
                createBiliArtifactFilter((snippet) => {
                    loggerLog("warn", `[bili-artifact] stripped model-emitted internal artifact: ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
                }),
            );
            // Both instances exist up front: the degenerate gate below reads
            // the CONTENT filter's stats only (visible prose), and a reasoning-
            // only turn must still report an empty text channel, not a missing
            // one. Thinking/reasoning presence reaches the gate via sawReasoning.
            const contentFilter = makeFieldFilter();
            const reasoningFilter = createIdentityStreamFilter();
            const flushFilter = function* (): Generator<ParsedStreamEvent> {
                const ct = contentFilter.flush();
                if (ct.length > 0) yield { kind: "text", delta: ct, raw: buildContent(ct) } as ParsedStreamEvent;
                const rt = reasoningFilter.flush();
                if (rt.length > 0) yield { kind: "reasoning", delta: rt, raw: buildReasoning(rt) } as ParsedStreamEvent;
            };
            let sawReasoning = false;
            let toolCallsEmitted = 0;
            let degenerateWarned = false;
            const maybeWarnDegenerate = (reason: string | undefined) => {
                if (degenerateWarned) return;
                // #1881: the gate reads the CONTENT channel only — reasoning
                // presence is reported via sawReasoning, and counting thinking
                // chars as visible output would silence a tag-echo-only turn.
                const msg = degenerateTurnWarning({ reason, terminalReason: "stop", toolCalls: toolCallsEmitted, text: contentFilter.stats(), sawThinking: sawReasoning, wire: "openai" });
                if (msg) {
                    degenerateWarned = true;
                    loggerLog("warn", msg);
                }
            };
            // #2405(c): per-response strip total — see plugin.ts twin. n==1 is
            // covered by its one-shot detail line, so stay silent there.
            let stripSummarized = false;
            const maybeSummarizeStrips = () => {
                if (stripSummarized) return;
                stripSummarized = true;
                const total = contentFilter.stats().dropCount;
                if (total > 1) loggerLog("warn", `[tag-echo] stripped ${total} occurrence(s) total in this response`);
            };
            // Raw tool_call chunks in arrival order. Backends (SGLang/vLLM)
            // stream a tool name across MULTIPLE deltas — the first fragment
            // carries the name, continuation fragments carry empty names.
            // Deciding "proxy vs real" per-chunk loses the name entirely (the
            // name chunk gets buffered while an empty-name continuation flips
            // the stream into passthrough mode, and the flush is then skipped).
            // So: buffer EVERYTHING, decide once at finish.
            const rawToolChunks: { json: string; parsed: Record<string, unknown> }[] = [];
            let sawRealToolCall = false;
            // #1306: pure accumulation of one frame's tool_call fragments. Runs
            // BEFORE the finish_reason settle so arguments sharing a chunk with
            // finish_reason reach the settle (a settle-first order flushed the
            // call with truncated args, cleared pending, and re-buffered the
            // fragment as a nameless orphan the [DONE] settle dropped).
            const absorbToolCallDeltas = (tcs: Array<Record<string, unknown>>): void => {
                for (const tc of tcs) {
                    const idx = typeof tc.index === "number" ? tc.index : 0;
                    const fn = tc.function as Record<string, unknown> | undefined;
                    const name = typeof fn?.name === "string" ? fn.name : "";
                    const id = typeof tc.id === "string" ? tc.id : "";
                    const rawArgs = fn?.arguments;
                    const args = typeof rawArgs === "string" ? rawArgs : (rawArgs !== null && typeof rawArgs === "object" ? JSON.stringify(rawArgs) : "");
                    let buf = pending.get(idx);
                    if (!buf) {
                        buf = { index: idx, id, name, arguments: args, frags: 1, nameInFirst: name.length > 0 };
                        pending.set(idx, buf);
                    } else {
                        if (id) buf.id = id;
                        buf.name += name;
                        buf.arguments += args;
                        buf.frags += 1;
                    }
                }
            };
            const flushPendingAsStructured = function* (): Generator<ParsedStreamEvent> {
                for (const [idx, tc] of pending) {
                    if (tc.name.length > 0 || tc.id.length > 0) {
                        toolCallsEmitted++;
                        // #1039 invariant: arguments are user intent, verbatim — see tag-echo-filter.ts header.
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.arguments,
                        } as ParsedStreamEvent;
                    } else if (tc.arguments.length > 0) {
                        loggerLog("warn", `[acp-openai] dropping orphan tool_call buffer idx=${idx} argsLen=${tc.arguments.length} (#1306)`);
                    }
                }
                pending.clear();
            };
            // Decide proxy-vs-real from the ACCUMULATED names and emit events:
            // real calls → raw replay (verbatim chunks, original ids/order) +
            // passthrough-flagged structured events so the loop counts them;
            // proxy calls → structured events (server-side execution).
            const settleToolCalls = function* (): Generator<ParsedStreamEvent> {
                if (pending.size === 0) return;
                const realIndexes = new Set<number>();
                for (const [idx, tc] of pending) {
                    // absorb joins PROXY_TOOL_SET dynamically: its name is configurable per session,
                    // and misclassifying it as real would raw-replay its chunks to the client.
                    if (tc.name.length > 0 && !PROXY_TOOL_SET.has(tc.name) && tc.name !== absorbName) realIndexes.add(idx);
                }
                sawRealToolCall = realIndexes.size > 0;
                // #1484: per-call frame summary at the transform boundary so an
                // upstream-vs-proxy bisection is possible when a client reports a
                // malformed tool frame. Warn when any settled call has no accumulated
                // name — exactly the shape clients reject at assembly.
                {
                    const parts: string[] = [];
                    let anyNameless = false;
                    for (const idx of [...pending.keys()].sort((a, b) => a - b)) {
                        const tc = pending.get(idx)!;
                        if (tc.name.length === 0) anyNameless = true;
                        const disp = realIndexes.has(idx) ? "replayed" : tc.name.length === 0 ? "nameless" : "proxy";
                        parts.push(`idx=${idx} name=${tc.name.length > 0 ? JSON.stringify(tc.name) : "<none>"}${tc.id ? ` id=${tc.id}` : ""} argsLen=${tc.arguments.length} frags=${tc.frags}${tc.nameInFirst === false ? " name-split" : ""} → ${disp}`);
                    }
                    yield {
                        kind: "diag",
                        level: anyNameless ? "warn" : "info",
                        message: `[acp-openai] round ${round} tool-frame settle (${parts.length}): ${parts.join(" | ")}`,
                    } as ParsedStreamEvent;
                }
                if (!sawRealToolCall) {
                    yield* flushPendingAsStructured();
                    // #1881: nothing is replayed here, so deliver each frame's
                    // withheld sibling prose instead of losing it on round 1.
                    for (const { parsed } of rawToolChunks) {
                        const prose = withheldProseFrame(parsed);
                        if (prose) yield { kind: "meta", chunk: prose } as ParsedStreamEvent;
                    }
                    return;
                }
                for (const [idx, tc] of pending) {
                    if (realIndexes.has(idx) && (tc.name.length > 0 || tc.id.length > 0)) {
                        toolCallsEmitted++;
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.arguments,
                            passthrough: true,
                        } as ParsedStreamEvent;
                    }
                }
                for (const { json, parsed } of rawToolChunks) {
                    const filtered = filterRealToolFragments(parsed, realIndexes);
                    if (filtered === "keep") {
                        yield { kind: "meta", chunk: Buffer.from("data: " + json + "\n\n", "utf8") } as ParsedStreamEvent;
                    } else if (filtered !== null) {
                        yield { kind: "meta", chunk: Buffer.from("data: " + JSON.stringify(filtered) + "\n\n", "utf8") } as ParsedStreamEvent;
                    } else {
                        // #1881: proxy-only frame dropped — deliver its withheld sibling prose inline (wire order).
                        const prose = withheldProseFrame(parsed);
                        if (prose) yield { kind: "meta", chunk: prose } as ParsedStreamEvent;
                    }
                }
                for (const [idx, tc] of pending) {
                    if (!realIndexes.has(idx) && tc.name.length > 0) {
                        toolCallsEmitted++;
                        yield {
                            kind: "tool_call",
                            name: tc.name,
                            callId: tc.id,
                            arguments: tc.arguments,
                        } as ParsedStreamEvent;
                    }
                }
                pending.clear();
            };
            for await (const eventStr of iterSseChunks(upstream)) {
                const dataLine = eventStr.split("\n").find((l) => l.startsWith("data:"));
                if (!dataLine) continue;
                const jsonStr = dataLine.slice(5).trim();
                if (jsonStr === "[DONE]") {
                    yield* flushFilter();
                    if (sawRealToolCall) {
                        yield { kind: "meta", chunk: Buffer.from(eventStr + "\n\n", "utf8") } as ParsedStreamEvent;
                        continue;
                    }
                    yield* settleToolCalls();
                    if (sawRealToolCall) {
                        yield { kind: "meta", chunk: Buffer.from(eventStr + "\n\n", "utf8") } as ParsedStreamEvent;
                    }
                    maybeWarnDegenerate("stop");
                    maybeSummarizeStrips();
                    yield { kind: "done", finishReason: "stop", thinking: sawReasoning, ...(sawRealToolCall ? { suppressCompletion: true } : {}) } as ParsedStreamEvent;
                    continue;
                }
                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(jsonStr);
                } catch {
                    continue;
                }
                const rawBuf = Buffer.from(eventStr + "\n\n", "utf8");
                // OpenAI-compatible gateways may report an upstream failure as
                // an in-band error frame while the HTTP response remains 200.
                // Do not ignore it just because it has no choices: if parsing
                // continues to [DONE], the loop would synthesize a successful
                // empty stop turn and the client could stall or lose retry
                // semantics. Surface the error through the normal error path,
                // which emits a protocol error without a fabricated completion.
                const streamError = parsed.error;
                if (streamError !== undefined && streamError !== null) {
                    let message: string;
                    if (typeof streamError === "string") {
                        message = streamError;
                    } else if (typeof streamError === "object") {
                        const error = streamError as Record<string, unknown>;
                        const detail = typeof error.message === "string" ? error.message : JSON.stringify(streamError);
                        const code = typeof error.code === "string" ? error.code : undefined;
                        message = code && detail ? `${code}: ${detail}` : detail;
                    } else {
                        message = String(streamError);
                    }
                    yield { kind: "error", message } as ParsedStreamEvent;
                    return;
                }
                const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
                const choice = choices?.[0];
                if (!choice) {
                    if (parsed.usage) {
                        const u = parsed.usage as Record<string, unknown>;
                        yield {
                            kind: "usage",
                            inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
                            outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
                            cachedTokens: openaiCachedTokens(u),
                        } as ParsedStreamEvent;
                        // #589: include_usage clients (dsh, OpenAI SDK) read usage
                        // from this trailing empty-choices frame; raw tool-call rounds
                        // must forward it verbatim, not swallow it into the internal
                        // ledger.
                        if (sawRealToolCall) {
                            yield { kind: "meta", chunk: rawBuf } as ParsedStreamEvent;
                        }
                    }
                    continue;
                }
                const delta = choice.delta as Record<string, unknown> | undefined;
                const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
                // #4466: some gateways (Tencent CodeBuddy) stamp `tool_calls: []`
                // on every chunk of a plain text response — an empty array is
                // truthy, so a bare truthiness check would route text frames
                // into the tool absorb path and withhold their client-visible
                // bytes forever. Only a NON-empty array is a tool-call frame
                // (same predicate as filterRealToolFragments below).
                const frameToolCalls = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0
                    ? (delta.tool_calls as Array<Record<string, unknown>>)
                    : undefined;
                if (frameToolCalls) absorbToolCallDeltas(frameToolCalls);

                // #4488: include_usage relays may deliver usage on a trailing frame whose
                // choices array stays NON-empty — one choice with an EMPTY delta and no
                // finish_reason (OpenAI's own include_usage final-chunk shape, or a gateway
                // variant of it). It matches neither the !choice branch above nor the
                // finishReason branch below, so its usage never reached the internal ledger
                // (settleUsageReport) and nudge froze on the last stale sample (growth=0,
                // context grows until 502) even though the raw frame was still forwarded to
                // the client. Harvest it here; the guards (no finish_reason, empty delta
                // object) keep every content / finish / tool-call frame out. Deliberately no
                // `continue`: the frame falls through to the empty-delta meta forward below
                // unchanged, so the client-visible stream stays byte-identical to pre-fix and
                // only the ledger gains the sample.
                if (parsed.usage && !finishReason && delta && Object.keys(delta).length === 0) {
                    const u = parsed.usage as Record<string, unknown>;
                    yield {
                        kind: "usage",
                        inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
                        outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
                        cachedTokens: openaiCachedTokens(u),
                    } as ParsedStreamEvent;
                }

                if (finishReason) {
                    yield* flushFilter();
                    const hadToolCalls = [...pending.values()].some((tc) => tc.name.length > 0 || tc.id.length > 0);
                    yield* settleToolCalls();
                    const u = parsed.usage as Record<string, unknown> | undefined;
                    yield {
                        kind: "usage",
                        inputTokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : undefined,
                        outputTokens: typeof u?.completion_tokens === "number" ? u.completion_tokens : undefined,
                        cachedTokens: u ? openaiCachedTokens(u) : undefined,
                    } as ParsedStreamEvent;
                    if (sawRealToolCall) {
                        // The raw finish chunk (provider-measured usage) reaches
                        // the host verbatim — no rewriting.
                        const chunk = rawBuf;
                        // This verbatim chunk IS the round's authoritative completion
                        // (suppressCompletion); write it once and never fall through
                        // to the text/reasoning branches (which would re-emit the same
                        // bytes after the finish reason).
                        yield { kind: "meta", chunk } as ParsedStreamEvent;
                        maybeWarnDegenerate(finishReason);
                        maybeSummarizeStrips();
                        yield { kind: "done", finishReason, suppressCompletion: true, thinking: sawReasoning } as ParsedStreamEvent;
                        continue;
                    } else {
                        maybeWarnDegenerate(finishReason);
                        maybeSummarizeStrips();
                        yield {
                            kind: "done",
                            finishReason: hadToolCalls && finishReason === "stop" ? "tool_calls" : finishReason,
                            thinking: sawReasoning,
                        } as ParsedStreamEvent;
                    }
                }

                if (!delta) continue;

                // #1881: filter BOTH prose fields up front so one frame is
                // forwarded exactly once with its cleaned bytes. The old order
                // forwarded the raw frame on the reasoning event before content
                // was filtered — a dual-field frame leaked unfiltered content
                // to the client while the filtered text event suppressed its
                // raw to avoid double-sending.
                const rcIn = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0 ? delta.reasoning_content : null;
                const ctIn = typeof delta.content === "string" && delta.content.length > 0 ? delta.content : null;
                let rcOut = rcIn;
                let ctOut = ctIn;
                if (rcIn !== null) {
                    sawReasoning = true;
                    rcOut = reasoningFilter.push(rcIn);
                }
                if (ctIn !== null) {
                    ctOut = contentFilter.push(ctIn);
                }
                const rcChanged = rcIn !== null && rcOut !== rcIn;
                const ctChanged = ctIn !== null && ctOut !== ctIn;

                if (frameToolCalls) {
                    // The settle-time raw replay is this frame's client-visible
                    // bytes: when a filtered field diverged, buffer a rebuilt
                    // copy carrying the cleaned values instead of the original
                    // echo (#1881). Structured events stay internal here.
                    let json = jsonStr;
                    let obj = parsed;
                    if (rcChanged || ctChanged) {
                        const fields: Record<string, string> = {};
                        if (ctIn !== null) fields["content"] = ctOut ?? "";
                        if (rcIn !== null) fields["reasoning_content"] = rcOut ?? "";
                        obj = applyDeltaFields(parsed, fields);
                        json = JSON.stringify(obj);
                    }
                    rawToolChunks.push({ json, parsed: obj });
                    if (rcOut !== null && rcOut.length > 0) {
                        yield { kind: "reasoning", delta: rcOut } as ParsedStreamEvent;
                    }
                    if (ctOut !== null && ctOut.length > 0) {
                        yield { kind: "text", delta: ctOut } as ParsedStreamEvent;
                    }
                    continue;
                }

                const fin = (b: Buffer): Buffer => (finishReason ? stripFinishReasonChunk(b) : b);
                if (rcIn !== null && ctIn !== null) {
                    const raw = rcChanged || ctChanged
                        ? rewriteDeltaFields(parsed, { content: ctOut ?? "", reasoning_content: rcOut ?? "" })
                        : rawBuf;
                    const fwd = fin(raw);
                    const hasText = ctOut !== null && ctOut.length > 0;
                    const hasReason = rcOut !== null && rcOut.length > 0;
                    // Both structured events feed the loop's internal state;
                    // the client-visible frame rides on exactly ONE of them —
                    // the reasoning event when present (pinned allocation,
                    // tests/openai-reasoning-content.test.ts #8), else the text
                    // event. Never both (no double-forwarding).
                    if (hasReason && hasText) {
                        yield { kind: "reasoning", delta: rcOut!, raw: fwd } as ParsedStreamEvent;
                        yield { kind: "text", delta: ctOut! } as ParsedStreamEvent;
                    } else if (hasReason) {
                        yield { kind: "reasoning", delta: rcOut!, raw: fwd } as ParsedStreamEvent;
                    } else if (hasText) {
                        yield { kind: "text", delta: ctOut!, raw: fwd } as ParsedStreamEvent;
                    }
                } else if (rcIn !== null) {
                    const raw = rcChanged ? rewriteDeltaFields(parsed, { reasoning_content: rcOut ?? "" }) : rawBuf;
                    yield { kind: "reasoning", delta: rcOut ?? "", raw: fin(raw) } as ParsedStreamEvent;
                } else if (ctIn !== null) {
                    const raw = ctChanged ? rewriteDeltaFields(parsed, { content: ctOut ?? "" }) : rawBuf;
                    yield { kind: "text", delta: ctOut ?? "", raw: fin(raw) } as ParsedStreamEvent;
                } else if (delta.role || (Object.keys(delta).length === 0 && !finishReason)) {
                    yield { kind: "meta", chunk: fin(rawBuf), firstRoundOnly: true } as ParsedStreamEvent;
                }
            }
        },

        emitText(delta) {
            return buildContent(delta);
        },

        emitReasoning(delta) {
            return buildReasoning(delta);
        },

        emitToolCall(call) {
            return buildToolCall(call);
        },

        emitMarker(toolName, result) {
            return buildContent(buildVisibilityMarker(toolName, result));
        },

        emitCompletion(opts?: EmitCompletionOpts) {
            const finishReason = opts?.finishReason ?? "stop";
            // Numeric fields must never serialize to absent/undefined: strict
            // clients (dsh's mapUsage) compute over prompt_tokens/completion_tokens
            // and a usage object missing them yields NaN (non-JSON-serializable).
            const usage = opts?.usage
                ? {
                      prompt_tokens: opts.usage.inputTokens ?? 0,
                      completion_tokens: opts.usage.outputTokens ?? 0,
                      total_tokens: (opts.usage.inputTokens ?? 0) + (opts.usage.outputTokens ?? 0),
                      ...(typeof opts.usage.cachedTokens === "number"
                          ? { prompt_tokens_details: { cached_tokens: opts.usage.cachedTokens } }
                          : {}),
                  }
                : null;
            return Buffer.concat([buildFinish(finishReason, usage), Buffer.from("data: [DONE]\n\n", "utf8")]);
        },

        emitError(message) {
            // #1455: present the failure AS a failure (see the anthropic twin). The
            // legacy shape — error text + finish_reason "stop" + [DONE] — read as a
            // normal completion to clients and suppressed their retry logic. The
            // default now rides the top-level `error` frame bili's own parser already
            // recognizes (same shape #721's truncation path emits); compat.
            // streamErrorShape="completion" restores the legacy shape.
            if (errorShape === "completion") {
                return Buffer.concat([
                    buildContent(`\n[acp-proxy: ${message}]\n`),
                    buildFinish("stop", null),
                    Buffer.from("data: [DONE]\n\n", "utf8"),
                ]);
            }
            return Buffer.concat([
                Buffer.from(`data: ${JSON.stringify({ error: { type: "server_error", code: "upstream_error", message: `[acp-proxy: ${message}]` } })}\n\n`, "utf8"),
                Buffer.from("data: [DONE]\n\n", "utf8"),
            ]);
        },
    };
}
