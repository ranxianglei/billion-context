import {
    buildStatusReport,
    collectBlockContent,
    deactivateBlock,
    estimateTokensFast,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import type { Session } from "./session.js";
import { parseCompressInput, PROXY_TOOL_NAMES, COMPRESS_TOOL_NAME, ACP_TEXT_OPEN, ACP_TEXT_CLOSE } from "./compress-tool.js";
import { log as loggerLog } from "./logger.js";
import { applyRanges } from "./stream.js";
import { resolveDecompress } from "./decompress-shared.js";
import { buildVisibilityMarker } from "./compress-loop.js";
import { fetchWithTimeout } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";

/** Text-protocol mode: the host (OpenAI Codex code_mode) cannot coexist with
 *  a declared `tools` array, so compression is triggered by a text marker the
 *  model emits in its output_text. Detected here in the compress loop. */
const TEXT_PROTOCOL = process.env.ACP_COMPRESS_PROTOCOL === "text";

/** Extract <acp_compress>{json}</acp_compress> triggers from assistant text.
 *  Returns the cleaned text (trigger removed) and synthesized function-call
 *  accumulators so the existing compress loop can execute them like real tool
 *  calls and loop again with the result. */
function extractTextTriggers(text: string): { clean: string; calls: FunctionCallAccumulator[] } {
    const calls: FunctionCallAccumulator[] = [];
    let clean = "";
    let i = 0;
    let n = 0;
    while (i < text.length) {
        const open = text.indexOf(ACP_TEXT_OPEN, i);
        if (open === -1) {
            clean += text.slice(i);
            break;
        }
        clean += text.slice(i, open);
        const after = open + ACP_TEXT_OPEN.length;
        const close = text.indexOf(ACP_TEXT_CLOSE, after);
        if (close === -1) {
            // malformed/incomplete trigger — pass through as plain text
            clean += text.slice(open);
            break;
        }
        const payload = text.slice(after, close).trim();
        if (payload) {
            const stamp = `${Date.now()}_${n++}`;
            calls.push({
                itemId: `fc_text_${stamp}`,
                callId: `call_text_${stamp}`,
                name: COMPRESS_TOOL_NAME,
                arguments: payload,
            });
        }
        i = close + ACP_TEXT_CLOSE.length;
    }
    return { clean, calls };
}

interface CompressLoopResponsesCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    /** Resolved upstream proxy URL (http://host:port) or undefined for direct. */
    proxyUrl?: string;
    textProtocol?: boolean;
}

interface RequestOptions {
    url: string;
    headers: Record<string, string>;
}

interface FunctionCallAccumulator {
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
}

function executeProxyTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: CompressLoopResponsesCtx,
): string {
    if (toolName === "compress") {
        return applyRanges(parseCompressInput(args), ctx);
    }
    if (toolName === "decompress") {
        return resolveDecompress(args, ctx);
    }
    if (toolName === "search_context") {
        const query = typeof args.query === "string" ? args.query : "";
        if (query.length === 0) return "[search_context FAILED: query is required]";
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
        const blocks = ctx.core.search(query, ctx.session.state).slice(0, limit);
        if (blocks.length === 0) return `[No blocks matched "${query}"]`;
        const lines = blocks.map((b) => {
            const topic = b.topic ?? "(no topic)";
            const preview = b.summary.length > 200 ? b.summary.slice(0, 200) + "..." : b.summary;
            return `${b.blockId} (T${b.tier}) "${topic}"\n  ${preview}`;
        });
        return `Found ${blocks.length} block(s) for "${query}":\n\n${lines.join("\n\n")}`;
    }
    if (toolName === "acp_status") {
        return buildStatusReport(ctx.session.state, ctx.messages, estimateTokensFast);
    }
    return `[Unknown proxy tool: ${toolName}]`;
}

function extractEventType(rawEvent: string): string | null {
    for (const l of rawEvent.split("\n")) {
        if (l.startsWith("event:")) return l.slice(6).trim();
    }
    return null;
}

function extractDataLine(rawEvent: string): string | null {
    // Per SSE spec, consecutive `data:` lines are joined with "\n" to form
    // the event data. A single leading space after "data:" is stripped.
    const parts: string[] = [];
    for (const l of rawEvent.split("\n")) {
        if (l.startsWith("data:")) {
            let v = l.slice(5);
            if (v.startsWith(" ")) v = v.slice(1);
            parts.push(v);
        }
    }
    return parts.length ? parts.join("\n") : null;
}

interface ResponsesEventDisposition {
    yieldChunk?: Buffer;
    contentDelta?: string;
    fcStart?: { itemId: string; callId: string; name: string };
    fcArgs?: { itemId: string; delta: string };
    fcDone?: { itemId: string };
    /** Set when this event terminates the response stream. */
    terminal?: boolean;
    /** Kind of terminal event; determines whether we synthesize completion or
     *  pass the original through (failed/incomplete must NOT be followed by a
     *  fabricated response.completed — that gives the client a contradictory
     *  state machine). */
    terminalKind?: "completed" | "incomplete" | "failed" | "error";
    /** Raw event text of a non-completed terminal, to replay verbatim. */
    terminalRaw?: string;
    responseObj?: Record<string, unknown> | null;
    isMeta?: boolean;
    /** Bypass the text-protocol realtime buffer for host tool calls (Codex
     *  code_mode `custom_tool_call`). They never carry an ACP compress trigger,
     *  so buffering only drops them — the end-of-turn rebuild re-emits output_text
     *  only. Required for Codex tools to work in text-protocol mode. */
    noBuffer?: boolean;
    /** A `custom_tool_call` output_item finalized this round (for [acp-diag];
     *  the function_call-only allCalls would otherwise hide code_mode usage). */
    customToolCallDone?: boolean;
}

function classifyResponsesSseEvent(eventStr: string): ResponsesEventDisposition {
    const type = extractEventType(eventStr);
    const dataLine = extractDataLine(eventStr);
    if (!type || !dataLine) return {};
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(dataLine);
    } catch {
        return {};
    }
    const out: ResponsesEventDisposition = {};
    switch (type) {
        case "response.created":
        case "response.in_progress":
            // Response-lifecycle meta events. Passed through only in round 1
            // (to open the stream); suppressed in later rounds so the merged
            // stream has exactly one response.created.
            out.isMeta = true;
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
        case "response.output_item.added": {
            const item = obj.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                const name = typeof item.name === "string" ? item.name : "";
                out.fcStart = {
                    itemId: typeof item.id === "string" ? item.id : "",
                    callId: typeof item.call_id === "string" ? item.call_id : "",
                    name,
                };
                return out;
            }
            if (item?.type === "custom_tool_call") out.noBuffer = true;
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
        }
        case "response.content_part.added":
        case "response.content_part.done":
        case "response.output_text.done":
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
        case "response.output_text.delta": {
            const delta = typeof obj.delta === "string" ? obj.delta : "";
            if (delta) {
                out.contentDelta = delta;
                out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            }
            return out;
        }
        case "response.function_call_arguments.delta": {
            const itemId = typeof obj.item_id === "string" ? obj.item_id : "";
            const delta = typeof obj.delta === "string" ? obj.delta : "";
            out.fcArgs = { itemId, delta };
            return out;
        }
        case "response.output_item.done": {
            const item = obj.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                out.fcDone = { itemId: typeof item.id === "string" ? item.id : "" };
                return out;
            }
            if (item?.type === "custom_tool_call") {
                out.noBuffer = true;
                out.customToolCallDone = true;
            }
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
        }
        case "response.completed":
            // Meta: never auto-yielded. We capture the response object and emit
            // our own single completion at the end of the merged stream.
            out.isMeta = true;
            out.terminal = true;
            out.terminalKind = "completed";
            out.responseObj = (obj.response as Record<string, unknown>) ?? null;
            return out;
        case "response.incomplete":
            // Terminal but NOT a success. Pass the original through; do NOT
            // synthesize a response.completed after it.
            out.isMeta = true;
            out.terminal = true;
            out.terminalKind = "incomplete";
            out.terminalRaw = eventStr;
            return out;
        case "response.failed":
        case "response.error":
            // Terminal failure. Same handling as incomplete — replay verbatim.
            out.isMeta = true;
            out.terminal = true;
            out.terminalKind = "failed";
            out.terminalRaw = eventStr;
            return out;
        default:
            if (type.startsWith("response.custom_tool_call.")) out.noBuffer = true;
            out.yieldChunk = Buffer.from(eventStr + "\n\n", "utf8");
            return out;
    }
}

function buildMessageItemSequence(itemId: string, outputIndex: number, text: string): string {
    // Full Responses message-item sequence: the client requires output_item.added
    // + content_part.added BEFORE any output_text.delta, otherwise it errors
    // "OutputTextDelta without active item".
    const item = { type: "message", id: itemId, role: "assistant", content: [] as unknown[] };
    const part = { type: "output_text", text: "" };
    const doneItem = { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text }] };
    return [
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: outputIndex, item })}\n\n`,
        `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: itemId, output_index: outputIndex, part })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: itemId, output_index: outputIndex, delta: text })}\n\n`,
        `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: itemId, output_index: outputIndex, text })}\n\n`,
        `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", item_id: itemId, output_index: outputIndex, part: { type: "output_text", text } })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: outputIndex, item: doneItem })}\n\n`,
    ].join("");
}

function buildFunctionCallEvents(
    fc: FunctionCallAccumulator,
    outputIndex: number,
): string {
    return [
        `event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { type: "function_call", id: fc.itemId, call_id: fc.callId, name: fc.name, arguments: "" },
        })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: fc.itemId,
            delta: fc.arguments,
        })}\n\n`,
        `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.done",
            item_id: fc.itemId,
            arguments: fc.arguments,
        })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: outputIndex,
            item: { type: "function_call", id: fc.itemId, call_id: fc.callId, name: fc.name, arguments: fc.arguments },
        })}\n\n`,
    ].join("");
}

function buildCompleted(responseObj: Record<string, unknown> | null): string {
    const resp = responseObj ?? { id: `resp-proxy-${Date.now()}`, status: "completed", output: [] };
    return `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: resp,
    })}\n\n`;
}

function buildFailed(responseObj: Record<string, unknown> | null): string {
    const id = responseObj?.id ?? `resp-failed-${Date.now()}`;
    const resp = { ...(responseObj ?? {}), id, status: "failed", error: { code: "server_error", message: "upstream returned empty response" } };
    return `event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: resp,
    })}\n\n`;
}

function responsesJsonOutput(response: Record<string, unknown>): {
    text: string;
    textParts: Array<Record<string, unknown>>;
    calls: FunctionCallAccumulator[];
} {
    const textParts: Array<Record<string, unknown>> = [];
    const calls: FunctionCallAccumulator[] = [];
    for (const item of Array.isArray(response.output) ? response.output : []) {
        if (!item || typeof item !== "object") continue;
        const value = item as Record<string, unknown>;
        if (value.type === "message") {
            for (const part of Array.isArray(value.content) ? value.content : []) {
                if (part && typeof part === "object" && (part as Record<string, unknown>).type === "output_text") {
                    textParts.push(part as Record<string, unknown>);
                }
            }
        } else if (value.type === "function_call") {
            calls.push({
                itemId: typeof value.id === "string" ? value.id : "",
                callId: typeof value.call_id === "string" ? value.call_id : "",
                name: typeof value.name === "string" ? value.name : "",
                arguments: typeof value.arguments === "string" ? value.arguments : "",
            });
        }
    }
    return {
        text: textParts.map((part) => typeof part.text === "string" ? part.text : "").join(""),
        textParts,
        calls,
    };
}

function replaceResponsesJsonText(parts: Array<Record<string, unknown>>, text: string): void {
    parts.forEach((part, index) => {
        part.text = index === 0 ? text : "";
    });
}

export async function compressLoopResponsesJson(
    initialResponse: Record<string, unknown>,
    ctx: CompressLoopResponsesCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): Promise<Record<string, unknown>> {
    let current = initialResponse;
    for (let loopCount = 1; loopCount <= 5; loopCount++) {
        const output = responsesJsonOutput(current);
        const extracted = extractTextTriggers(output.text);
        const allCalls = [...output.calls, ...extracted.calls].filter((call) => call.name.length > 0);
        const proxyCalls = allCalls.filter((call) => PROXY_TOOL_NAMES.has(call.name));
        const realCalls = allCalls.filter((call) => !PROXY_TOOL_NAMES.has(call.name));
        if (proxyCalls.length === 0 || realCalls.length > 0) {
            if (proxyCalls.length > 0) replaceResponsesJsonText(output.textParts, extracted.clean);
            return current;
        }
        const inputItems = Array.isArray(requestBody.input) ? [...(requestBody.input as unknown[])] : [];
        if (extracted.clean.trim()) {
            inputItems.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: extracted.clean }] });
        }
        for (const call of proxyCalls) {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(call.arguments) as Record<string, unknown>;
            } catch (error) {
                loggerLog("warn", `[acp-compress-args] ${call.name} JSON.parse failed: ${String(error)}`);
            }
            const result = executeProxyTool(call.name, args, ctx);
            ctx.log(`[acp-proxy: responses JSON ${call.name} → ${result.slice(0, 120).replace(/\n/g, " ")}]`);
            inputItems.push({ type: "message", role: "user", content: buildVisibilityMarker(call.name, result) });
        }
        requestBody.input = inputItems;
        const { response, clearTimer } = await fetchWithTimeout(requestOptions.url, {
            method: "POST",
            headers: requestOptions.headers,
            body: JSON.stringify(requestBody),
            ...(ctx.proxyUrl ? { dispatcher: proxyDispatcher(ctx.proxyUrl) } : {}),
        });
        try {
            if (!response.ok) {
                const detail = await response.text().catch(() => "upstream error");
                throw new Error(`responses compress loop upstream error ${response.status}: ${detail.slice(0, 200)}`);
            }
            current = await response.json() as Record<string, unknown>;
        } finally {
            clearTimer();
        }
    }
    ctx.log("[acp-proxy: responses JSON compress loop limit (5) reached]");
    return current;
}

export async function* compressLoopResponsesStream(
    initialUpstream: ReadableStream<Uint8Array>,
    ctx: CompressLoopResponsesCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): AsyncGenerator<Buffer> {
    const textProtocol = ctx.textProtocol ?? TEXT_PROTOCOL;
    let upstream = initialUpstream;
    let loopCount = 0;
    let responseObj: Record<string, unknown> | null = null;
    let activeClearTimer: (() => void) | null = null;
    let nextOutputIndex = 0;

    for (;;) {
        loopCount++;
        if (loopCount > 5) {
            ctx.log("[acp-proxy: responses compress loop limit (5) reached, forwarding completion as-is]");
            const limItemId = `msg_acp_limit_${Date.now()}`;
            yield Buffer.from(buildMessageItemSequence(limItemId, nextOutputIndex++, "\n[acp-proxy: compress loop limit reached]\n"), "utf8");
            yield Buffer.from(buildCompleted(responseObj), "utf8");
            return;
        }

        const fcByItemId = new Map<string, FunctionCallAccumulator>();
        let contentText = "";
        let customToolCalls = 0;
        let completed = false;
        let terminalKind: "completed" | "incomplete" | "failed" | "error" | null = null;
        let terminalRaw: string | null = null;
        const isFirstRound = loopCount === 1;

        const reader = upstream.getReader();
        const decoder = new TextDecoder("utf-8");
        let sseBuffer = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                // Normalize SSE line endings per spec: CRLF and lone CR are
                // valid terminators. Without this, \r\n\r\n event separators
                // would never match indexOf("\n\n") and whole events vanish.
                if (sseBuffer.indexOf("\r") !== -1) sseBuffer = sseBuffer.replace(/\r\n|\r/g, "\n");
                let sep: number;
                while ((sep = sseBuffer.indexOf("\n\n")) >= 0) {
                    const eventStr = sseBuffer.slice(0, sep);
                    sseBuffer = sseBuffer.slice(sep + 2);
                    if (!eventStr.trim()) continue;
                    const d = classifyResponsesSseEvent(eventStr);
                    // Unified passthrough: yield content events in all rounds;
                    // meta-start events (response.created/in_progress) only in
                    // round 1 so the merged stream opens once. response.completed
                    // is never auto-yielded (no yieldChunk) — we emit our own at
                    // the end.
                    // Text protocol: suppress real-time content yields so we can
                    // strip the <acp_compress> trigger before the client sees it;
                    // we re-emit a clean message item at round end. Meta-start
                    // events still open the stream in round 1.
                    if (d.yieldChunk && (isFirstRound || !d.isMeta) && !(textProtocol && !d.isMeta && !d.noBuffer)) {
                        yield d.yieldChunk;
                    }
                    if (d.contentDelta) contentText += d.contentDelta;
                    if (d.fcStart) {
                        fcByItemId.set(d.fcStart.itemId, {
                            itemId: d.fcStart.itemId,
                            callId: d.fcStart.callId,
                            name: d.fcStart.name,
                            arguments: "",
                        });
                    }
                    if (d.fcArgs) {
                        const existing = fcByItemId.get(d.fcArgs.itemId);
                        if (existing) existing.arguments += d.fcArgs.delta;
                    }
                    if (d.fcDone) {
                        const existing = fcByItemId.get(d.fcDone.itemId);
                        if (existing && !existing.arguments) {
                            const item = JSON.parse(extractDataLine(eventStr) ?? "{}").item as Record<string, unknown> | undefined;
                            const args = typeof item?.arguments === "string" ? item.arguments : "";
                            existing.arguments = args;
                        }
                    }
                    if (d.customToolCallDone) customToolCalls++;
                    if (d.terminal) {
                        completed = true;
                        terminalKind = d.terminalKind ?? null;
                        terminalRaw = d.terminalRaw ?? null;
                        responseObj = d.responseObj ?? responseObj;
                        const resp = d.responseObj ?? {};
                        const usage = (resp as Record<string, unknown>).usage as Record<string, unknown> | undefined;
                        if (usage && d.terminalKind === "completed") {
                            const prompt = usage.input_tokens ?? usage.prompt_tokens ?? "?";
                            const inDet = usage.input_tokens_details as Record<string, unknown> | undefined;
                            const prDet = usage.prompt_tokens_details as Record<string, unknown> | undefined;
                            const cached = inDet?.cached_tokens ?? prDet?.cached_tokens ?? "?";
                            const out = usage.output_tokens ?? "?";
                            loggerLog("info", `[acp-usage] round ${loopCount} input=${prompt} cached=${cached} output=${out}${cached !== "?" && cached !== 0 && prompt !== "?" ? ` (cache hit ${Math.round(Number(cached) / Number(prompt) * 100)}%)` : ""}`);
                            // Record into the session for the web UI / stats.
                            if (typeof prompt === "number") {
                                ctx.session.stats.inputTokens += prompt;
                                // tokenCount = TOTAL context (new + cached); see anthropic branch.
                                ctx.session.stats.lastInputTokens = prompt + (typeof cached === "number" ? cached : 0);
                                if (typeof cached === "number") ctx.session.stats.cachedTokens += cached;
                                if (typeof out === "number") ctx.session.stats.outputTokens += out;
                                ctx.session.stats.cacheSamples += 1;
                            }
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
            // Previous round's stream fully consumed → its fetch timer can go.
            if (activeClearTimer) {
                activeClearTimer();
                activeClearTimer = null;
            }
        }

        // Text protocol: pull <acp_compress> triggers out of the assistant
        // text and treat them as proxy compress calls so the loop executes
        // them and continues. The cleaned text replaces contentText so the
        // client never sees the raw trigger.
        if (textProtocol) {
            const extracted = extractTextTriggers(contentText);
            contentText = extracted.clean;
            for (const c of extracted.calls) {
                fcByItemId.set(c.itemId, c);
            }
            // Emit the cleaned assistant text as a single message item.
            if (contentText.trim()) {
                const textItemId = `msg_acp_text_r${loopCount}_${Date.now()}`;
                yield Buffer.from(buildMessageItemSequence(textItemId, nextOutputIndex++, contentText), "utf8");
            }
        }
        const allCalls = [...fcByItemId.values()].filter((c) => c.name.length > 0);
        const proxyCalls = allCalls.filter((c) => PROXY_TOOL_NAMES.has(c.name));
        const realCalls = allCalls.filter((c) => !PROXY_TOOL_NAMES.has(c.name));
        // DIAG: log what tools the upstream returned this round.
        loggerLog("debug", `[acp-diag] round ${loopCount} allCalls=[${allCalls.map((c) => c.name).join(",")}] realCalls=[${realCalls.map((c) => c.name).join(",")}] customToolCalls=${customToolCalls} text=${JSON.stringify(contentText.slice(0, 120))}`);
        const hasOnlyProxy = proxyCalls.length > 0 && realCalls.length === 0;

        if (!hasOnlyProxy) {
            let oi = nextOutputIndex;
            for (const fc of realCalls) {
                yield Buffer.from(buildFunctionCallEvents(fc, oi), "utf8");
                oi++;
            }
            nextOutputIndex = oi;
            // Terminal failure/incomplete: replay the original terminal event
            // verbatim. We must NOT append a fabricated response.completed —
            // that would tell the client both failed AND completed.
            if (terminalKind && terminalKind !== "completed" && terminalRaw) {
                yield Buffer.from(terminalRaw + "\n\n", "utf8");
                return;
            }
            // Empty upstream response (no text/tool_call/usage): inject
            // response.failed so the client retries instead of hanging.
            const hasUsage = !!(responseObj as Record<string, unknown> | undefined)?.usage;
            if (contentText.length === 0 && realCalls.length === 0 && customToolCalls === 0 && !hasUsage) {
                ctx.log("[acp-proxy: empty upstream response (no content/usage) — injecting response.failed for client retry]");
                yield Buffer.from(buildFailed(responseObj), "utf8");
                return;
            }
            if (!completed) {
                ctx.log("[acp-proxy: responses stream ended without completion]");
            }
            yield Buffer.from(buildCompleted(responseObj), "utf8");
            return;
        }

        const names = proxyCalls.map((c) => c.name).join(", ");
        ctx.log(`[acp-proxy: responses round ${loopCount} — ${proxyCalls.length} proxy call(s): ${names}]`);

        const inputItems = Array.isArray(requestBody.input) ? [...(requestBody.input as unknown[])] : [];
        if (contentText) {
            inputItems.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: contentText }],
            });
        }
        if (!textProtocol) {
            for (const fc of proxyCalls) {
                inputItems.push({
                    type: "function_call",
                    id: fc.itemId || `fc_${Date.now()}`,
                    call_id: fc.callId || `call_${Date.now()}`,
                    name: fc.name,
                    arguments: fc.arguments,
                });
            }
        }
        for (const fc of proxyCalls) {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(fc.arguments) as Record<string, unknown>;
            } catch (e) {
                loggerLog("warn", `[acp-compress-args] ${fc.name} JSON.parse failed: ${String(e)}. raw arguments (len=${fc.arguments.length}): ${fc.arguments.slice(0, 300)}`);
                args = {};
            }
            if (fc.name === "compress") {
                loggerLog("debug", `[acp-compress-args] compress args parsed: ${JSON.stringify(args).slice(0, 400)}`);
            }
            const result = executeProxyTool(fc.name, args, ctx);
            const preview = result.length > 120 ? result.slice(0, 120) + "..." : result;
            ctx.log(`[acp-proxy: responses ${fc.name} (${fc.callId}) → ${preview.replace(/\n/g, " ")}]`);
            const markerItemId = `msg_acp_${Date.now()}_${nextOutputIndex}`;
            yield Buffer.from(
                buildMessageItemSequence(markerItemId, nextOutputIndex++, buildVisibilityMarker(fc.name, result)),
                "utf8",
            );
            inputItems.push(textProtocol
                ? { type: "message", role: "user", content: buildVisibilityMarker(fc.name, result) }
                : { type: "function_call_output", call_id: fc.callId || `call_${Date.now()}`, output: result });
        }

        requestBody.input = inputItems;
        if (!("stream" in requestBody)) requestBody.stream = true;

        const { response: resp, clearTimer } = await fetchWithTimeout(requestOptions.url, {
            method: "POST",
            headers: requestOptions.headers,
            body: JSON.stringify(requestBody),
            ...(ctx.proxyUrl ? { dispatcher: proxyDispatcher(ctx.proxyUrl) } : {}),
        });

        if (!resp.ok || !resp.body) {
            clearTimer();
            const errText = await resp.text().catch(() => "upstream error");
            ctx.log(`[acp-proxy: responses compress loop upstream error ${resp.status}: ${errText.slice(0, 200)}]`);
            const errItemId = `msg_acp_err_${Date.now()}`;
            yield Buffer.from(
                buildMessageItemSequence(errItemId, nextOutputIndex++, `\n[acp-proxy: upstream error ${resp.status}: ${errText.slice(0, 200)}]\n`),
                "utf8",
            );
            yield Buffer.from(buildCompleted(responseObj), "utf8");
            return;
        }

        upstream = resp.body as ReadableStream<Uint8Array>;
        // Clear the PREVIOUS round's timer before overwriting — otherwise the
        // fetch-timeout timer from rounds 1..N-1 leaks (each would self-fire
        // harmlessly after 10min, but the handles accumulate in the event loop
        // over a long session). Only the final round's timer is cleared by the
        // outer finally.
        if (activeClearTimer) activeClearTimer();
        activeClearTimer = clearTimer;
    }
}
