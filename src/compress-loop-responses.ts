import {
    buildStatusReport,
    estimateTokensFast,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { lastCompressSuffix, type Session } from "./session.js";
import { parseCompressInput, PROXY_TOOL_NAMES, MUTATING_PROXY_TOOLS, COMPRESS_TOOL_NAME, ACP_TEXT_OPEN, ACP_TEXT_CLOSE } from "./compress-tool.js";
import { log as loggerLog } from "./logger.js";
import { applyRanges } from "./stream.js";
import { resolveDecompress } from "./decompress-shared.js";
import { handleSearchContext } from "./search-context.js";
import { buildVisibilityMarker } from "./compress-loop.js";
import { MAX_LOOP_ROUNDS } from "./loop/index.js";
import { stripResponsesText } from "./loop/tag-echo-filter.js";
import { fetchWithRetry, UpstreamHttpError } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";

/** Extract  triggers from assistant text.
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
        return handleSearchContext(args, ctx.session, ctx.messages);
    }
    if (toolName === "acp_status") {
        return buildStatusReport(ctx.session.state, ctx.messages, estimateTokensFast);
    }
    return `[Unknown proxy tool: ${toolName}]`;
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

function surfaceReadonlyJson(
    current: Record<string, unknown>,
    proxyCalls: FunctionCallAccumulator[],
    ctx: CompressLoopResponsesCtx,
): Record<string, unknown> {
    const markers: string[] = [];
    for (const call of proxyCalls) {
        if (MUTATING_PROXY_TOOLS.has(call.name)) continue;
        let args: Record<string, unknown> = {};
        try {
            args = JSON.parse(call.arguments) as Record<string, unknown>;
        } catch {
            args = {};
        }
        let result: string;
        try {
            result = executeProxyTool(call.name, args, ctx);
            ctx.log(`[acp-proxy: responses JSON ${call.name} (read-only) → ${result.slice(0, 120).replace(/\n/g, " ")}]`);
        } catch (e) {
            result = `\u274c [ACP] ${call.name} FAILED: ${String(e)}`;
            ctx.log(`[acp-proxy: responses JSON ${call.name} (read-only) FAILED: ${String(e)}]`);
        }
        markers.push(buildVisibilityMarker(call.name, result));
    }
    if (markers.length === 0) return current;
    const out = Array.isArray(current.output) ? [...(current.output as unknown[])] : [];
    out.push({ type: "message", id: `msg_acp_ro_${Date.now()}_${markers.length}`, role: "assistant", content: [{ type: "output_text", text: markers.join("\n") }] });
    return { ...current, output: out };
}

export async function compressLoopResponsesJson(
    initialResponse: Record<string, unknown>,
    ctx: CompressLoopResponsesCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): Promise<Record<string, unknown>> {
    let current = initialResponse;
    for (let loopCount = 1; loopCount <= MAX_LOOP_ROUNDS; loopCount++) {
        current = stripResponsesText(current);
        const output = responsesJsonOutput(current);
        const extracted = extractTextTriggers(output.text);
        const allCalls = [...output.calls, ...extracted.calls].filter((call) => call.name.length > 0);
        const proxyCalls = allCalls.filter((call) => PROXY_TOOL_NAMES.has(call.name));
        const realCalls = allCalls.filter((call) => !PROXY_TOOL_NAMES.has(call.name));
        const mutatingProxy = proxyCalls.filter((call) => MUTATING_PROXY_TOOLS.has(call.name));
        if (mutatingProxy.length === 0 || realCalls.length > 0) {
            if (proxyCalls.length > 0) {
                replaceResponsesJsonText(output.textParts, extracted.clean);
                current = surfaceReadonlyJson(current, proxyCalls, ctx);
            }
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
            inputItems.push({ type: "message", role: "developer", content: buildVisibilityMarker(call.name, result) });
        }
        requestBody.input = inputItems;
        const result = await fetchWithRetry(requestOptions.url, {
            method: "POST",
            headers: requestOptions.headers,
            body: JSON.stringify(requestBody),
            ...(ctx.proxyUrl ? { dispatcher: proxyDispatcher(ctx.proxyUrl) } : {}),
        }, undefined, undefined, (info) => {
            // #189: correlate the rejection with the rewrite that preceded it.
            const lc = lastCompressSuffix(ctx.session.lastCompress);
            ctx.log(`[acp-proxy: responses upstream rejected replay (HTTP ${info.status}: ${info.detail.slice(0, 120)}); likely provider risk-control — retrying in ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})${lc}]`);
            loggerLog("warn", `[acp-compress-responses] upstream rejected replay (HTTP ${info.status}); retrying in ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})${lc}`);
        }).catch((e) => {
            if (e instanceof UpstreamHttpError) {
                const suffix = e.attempts > 1 ? ` after ${e.attempts} attempt(s)` : "";
                ctx.log(`[acp-proxy: responses compress loop upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)}]`);
                loggerLog("error", `[acp-compress-responses] upstream error ${e.status}${suffix}: ${e.body.slice(0, 200)}`);
            }
            throw e;
        });
        try {
            current = await result.response.json() as Record<string, unknown>;
        } finally {
            result.clearTimer();
        }
    }
    ctx.log(`[acp-proxy: responses JSON compress loop limit (${MAX_LOOP_ROUNDS}) reached]`);
    return current;
}
