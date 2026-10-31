import {
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { lastCompressSuffix, withSessionLock, type Session } from "./session.js";
import { extractResponsesTextTriggers, PROXY_TOOL_NAMES, MUTATING_PROXY_TOOLS } from "./compress-tool.js";
import { log as loggerLog } from "./logger.js";
import { drainPendingRetrievals, imageRescaleToolArmed } from "./store.js";
import { imageRescaleMaxDim } from "./knobs.js";
import { applyImageRescaleItems } from "./image-rescale.js";
import { executeProxyToolAsync, buildVisibilityMarker } from "./loop/core.js";
import { hoistTrappedToolItems } from "./tool-pair-order.js";
import { mergeAdjacentConfigurationUpdates } from "./responses-tool-output.js";
import { type ResponseInputItem } from "acp-kernel/wire";
import { MAX_LOOP_ROUNDS } from "./loop/index.js";
import { stripResponsesText } from "./loop/tag-echo-filter.js";
import { fetchWithRetry, UpstreamHttpError } from "./fetch-util.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { safePrefix, safeSuffix } from "./text-safe.js";
import { resolveVisibilityMode, type VisibilityMode } from "./compress-settings.js";

interface CompressLoopResponsesCtx {
    signal?: AbortSignal;
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    /** Resolved upstream proxy URL (http://host:port) or undefined for direct. */
    proxyUrl?: string;
    textProtocol?: boolean;
    /** #862/#1701: visibility-marker delivery mode — same tri-state contract as
     *  LoopCtx.visibilityMode (`stream` | `model-only` | `off`). */
    visibilityMode?: VisibilityMode;
}

interface RequestOptions {
    url: string;
    headers: Record<string, string>;
    /** Final-stage wire transform (compat.roles, #552) — same contract as the
     *  unified loop's RequestOptions.wireTransform. */
    wireTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
    /** #1884: re-sign hook for the armed tunnel — same contract as the unified
     *  loop's RequestOptions.resign (loop/core.ts): invoked with the outgoing
     *  headers and the final round body right before egress. */
    resign?: (headers: Record<string, string>, body: string | Buffer) => void;
}

interface FunctionCallAccumulator {
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
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

// #1459: executes + surfaces EVERY proxy call in a round that does not
// re-request — read-only AND mutating. Mirrors the streaming loop
// (loop/core.ts), which executes proxy tools before its `realCalls === 0`
// re-request gate: a mixed round (e.g. compress text trigger + real tool
// call) executes the compress, surfaces the marker, and relays the response
// instead of silently dropping the trigger. Mutating calls run under
// withSessionLock, same as the re-request branch below and the streaming loop.
async function surfaceProxyJson(
    current: Record<string, unknown>,
    proxyCalls: FunctionCallAccumulator[],
    ctx: CompressLoopResponsesCtx,
): Promise<Record<string, unknown>> {
    const clientMarkers = resolveVisibilityMode(ctx.visibilityMode) === "stream";
    const markers: string[] = [];
    for (const call of proxyCalls) {
        const mutating = MUTATING_PROXY_TOOLS.has(call.name);
        let args: Record<string, unknown> = {};
        let rawArgs: string | undefined;
        try {
            args = JSON.parse(call.arguments) as Record<string, unknown>;
        } catch {
            // #1502: same root cause as loop/core.ts — keep the raw string so corrupt compress arguments reach the kernel's lenient salvage ladder instead of {}.
            rawArgs = call.arguments;
            loggerLog("warn", `[acp-compress-args] ${call.name} JSON.parse failed (len=${call.arguments.length}, head=${safePrefix(call.arguments, 200)}, tail=${safeSuffix(call.arguments, 200)})`);
        }
        let result: string;
        try {
            const toolResult = mutating
                ? await withSessionLock(ctx.session, () => executeProxyToolAsync(call.name, args, ctx, call.callId, rawArgs, ctx.signal))
                : await executeProxyToolAsync(call.name, args, ctx, call.callId, rawArgs, ctx.signal);
            result = toolResult.text;
            ctx.log(`[acp-proxy: responses JSON ${call.name}${mutating ? "" : " (read-only)"} → ${result.slice(0, 120).replace(/\n/g, " ")}]`);
        } catch (e) {
            result = `\u274c [ACP] ${call.name} FAILED: ${String(e)}`;
            ctx.log(`[acp-proxy: responses JSON ${call.name}${mutating ? "" : " (read-only)"} FAILED: ${String(e)}]`);
        }
        if (clientMarkers) markers.push(buildVisibilityMarker(call.name, result));
    }
    if (markers.length === 0) return current;
    const out = Array.isArray(current.output) ? [...(current.output as unknown[])] : [];
    const markerItem = { type: "message", id: `msg_acp_proxy_${Date.now()}_${markers.length}`, role: "assistant", content: [{ type: "output_text", text: markers.join("\n") }] };
    // #766: append AFTER a function_call wedges the marker between the call and
    // its output once the client records it → strict backends reject ("No tool
    // output found"). Insert before the first tool call so pairs stay adjacent.
    let insertAt = out.length;
    for (let i = 0; i < out.length; i++) {
        const t = (out[i] as { type?: string })?.type;
        if (t === "function_call" || t === "custom_tool_call") { insertAt = i; break; }
    }
    out.splice(insertAt, 0, markerItem);
    return { ...current, output: out };
}

export async function compressLoopResponsesJson(
    initialResponse: Record<string, unknown>,
    ctx: CompressLoopResponsesCtx,
    requestBody: Record<string, unknown>,
    requestOptions: RequestOptions,
): Promise<Record<string, unknown>> {
    let current = initialResponse;
    let terminalFailed: { name: string; result: string } | undefined;
    for (let loopCount = 1; loopCount <= MAX_LOOP_ROUNDS; loopCount++) {
        current = stripResponsesText(current);
        const output = responsesJsonOutput(current);
        const extracted = extractResponsesTextTriggers(output.text);
        const allCalls = [...output.calls, ...extracted.calls.map((c): FunctionCallAccumulator => ({ itemId: `fc_${c.callId}`, callId: c.callId, name: c.name, arguments: c.arguments }))].filter((call) => call.name.length > 0);
        const proxyCalls = allCalls.filter((call) => PROXY_TOOL_NAMES.has(call.name));
        const realCalls = allCalls.filter((call) => !PROXY_TOOL_NAMES.has(call.name));
        const mutatingProxy = proxyCalls.filter((call) => MUTATING_PROXY_TOOLS.has(call.name));
        // #1459: the gate decides ONLY whether to re-request. Proxy tools are
        // executed in BOTH branches — mirroring the streaming loop, which runs
        // every proxy call before its `realCalls === 0` decision. A mixed
        // round (compress trigger + real tool call) executes the compress and
        // relays the response WITHOUT re-requesting, same as streaming.
        if (mutatingProxy.length === 0 || realCalls.length > 0) {
            if (proxyCalls.length > 0) {
                replaceResponsesJsonText(output.textParts, extracted.clean);
                current = await surfaceProxyJson(current, proxyCalls, ctx);
            }
            return current;
        }
        let inputItems: ResponseInputItem[] = Array.isArray(requestBody.input) ? [...requestBody.input] : [];
        // #3400: the loop re-request resends the client's RAW input items (big
        // images intact) — run the same egress pass the steady path applies so
        // the upstream keeps seeing the identical downscaled bytes (the shared
        // encode cache makes this byte-stable across rounds).
        inputItems = (await applyImageRescaleItems(inputItems, {
            session: ctx.session,
            sessionId: ctx.session.id,
            log: (lvl, msg) => ctx.log(`[${lvl}] ${msg}`),
            maxDim: imageRescaleMaxDim(),
            toolArmed: imageRescaleToolArmed(ctx.session),
        })) as ResponseInputItem[];
        if (extracted.clean.trim()) {
            inputItems.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: extracted.clean }] });
        }
        for (const call of proxyCalls) {
            let args: Record<string, unknown> = {};
            let rawArgs: string | undefined;
            try {
                args = JSON.parse(call.arguments) as Record<string, unknown>;
            } catch (error) {
                // #1502: keep the raw string so corrupt compress arguments reach the kernel's lenient salvage ladder instead of {}.
                loggerLog("warn", `[acp-compress-args] ${call.name} JSON.parse failed: ${String(error)} (len=${call.arguments.length}, head=${safePrefix(call.arguments, 200)}, tail=${safeSuffix(call.arguments, 200)})`);
                rawArgs = call.arguments;
            }
            const toolResult = await withSessionLock(ctx.session, () => executeProxyToolAsync(call.name, args, ctx, call.callId, rawArgs, ctx.signal));
            ctx.log(`[acp-proxy: responses JSON ${call.name} → ${toolResult.text.slice(0, 120).replace(/\n/g, " ")}]`);
            if ((call.name === "compress" || call.name === "decompress") && toolResult.text.includes("FAILED")) terminalFailed = { name: call.name, result: toolResult.text };
            if (resolveVisibilityMode(ctx.visibilityMode) !== "off") inputItems.push({ type: "message", role: "user", content: buildVisibilityMarker(call.name, toolResult.text) });
        }
        // #1097: retrieval injections ride the re-request after their ack —
        // as user items (bili's own artifacts take the #377-sanctioned user
        // voice from birth; input_text is the user-side part convention).
        for (const injection of drainPendingRetrievals(ctx.session)) {
            inputItems.push({ type: "message", role: "user", content: [{ type: "input_text", text: injection.text }] });
        }
        // #4166: no blanket re-voicing on this path. Everything bili pushes
        // above is born user; the resent client items keep their own voices —
        // client-origin mid system/developer is conversation data now (it
        // re-rides verbatim exactly as the client sent it; a strict backend's
        // rejection of it is the client's own shape, honestly forwarded). The
        // #1999 carrier concern does not apply here: this re-request is built
        // from the RAW client input, which never contains kernel carriers.
        requestBody.input = mergeAdjacentConfigurationUpdates(hoistTrappedToolItems(inputItems));
        const roundBody = JSON.stringify(requestOptions.wireTransform ? requestOptions.wireTransform(requestBody) : requestBody);
        requestOptions.resign?.(requestOptions.headers, roundBody);
        const result = await fetchWithRetry(requestOptions.url, {
            method: "POST",
            headers: requestOptions.headers,
            body: roundBody,
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
    // #1701: mirrors the streaming loop's MAX_LOOP_ROUNDS break — a terminal compression failure left zero client-visible trace in model-only mode, so surface exactly one marker line.
    if ((ctx.visibilityMode ?? "stream") === "model-only" && terminalFailed) {
        const output = Array.isArray(current.output) ? [...(current.output as unknown[])] : [];
        output.push({ type: "message", id: `msg_acp_terminal_${Date.now()}`, role: "assistant", content: [{ type: "output_text", text: buildVisibilityMarker(terminalFailed.name, terminalFailed.result) }] });
        return { ...current, output };
    }
    return current;
}
