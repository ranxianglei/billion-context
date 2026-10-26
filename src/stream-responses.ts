import type { CompressionCore, Config, CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput } from "./compress-tool.js";
import { applyRanges, runJsonRewrite, runJsonRewriteAsync, type JsonToolCall, type RewriteCtx } from "./stream.js";
import { applyConfiguredCompression } from "./external-summary-compress.js";
import { effectiveAbsorbConfig } from "./absorb.js";
import { containsBiliInternalText, containsMarkerLineText, containsRenderTagText, containsToolCallEmissionText, stripResponsesText } from "./loop/tag-echo-filter.js";

/**
 * Responses API (non-streaming) JSON rewriter: strips compress function_call
 * items from `output` and surfaces their result as a leading assistant message
 * item. The streaming variant previously lived here too but was unreachable
 * (server.ts routes streams through the compress-loop adapter, which emits a
 * correct output_item.added → delta → done sequence); it has been removed.
 */
export function rewriteResponsesJsonResponse(body: unknown, ctx: RewriteCtx): unknown {
    return runJsonRewrite(rewriteResponsesJsonSteps(body, ctx), (call) => applyRanges(parseCompressInput(call.args, call.id), ctx).text);
}

export async function rewriteResponsesJsonResponseAsync(body: unknown, ctx: RewriteCtx, signal?: AbortSignal): Promise<unknown> {
    return runJsonRewriteAsync(rewriteResponsesJsonSteps(body, ctx), async (call) => (await applyConfiguredCompression(call.args, ctx, call.id, signal)).text);
}

function* rewriteResponsesJsonSteps(body: unknown, ctx: RewriteCtx): Generator<JsonToolCall, unknown, string> {
    if (!body || typeof body !== "object") return body;
    const b = body as {
        output?: Array<Record<string, unknown>>;
        status?: string;
    };
    if (!Array.isArray(b.output)) return body;
    const probe = JSON.stringify(b.output);
    // #460 residual: the other two wires' JSON rewriters strip model-emitted
    // render tags from prose (stream.ts on content[].text, stream-openai.ts on
    // message.content); this wire must too. Strip the upstream items here, on
    // every body — before the compress note is synthesized (so the record we
    // inject is never edited) and before the !converted early return below
    // (which previously handed a tag-bearing body back untouched).
    // Absorb signature in whole text (m00885): drop only when the request
    // actually instructed the model about absorb.
    const absorbArmed = effectiveAbsorbConfig(ctx.session, ctx.config)?.enabled === true;
    const requestText = JSON.stringify(ctx.messages);
    if (containsRenderTagText(probe) || containsMarkerLineText(probe) || containsBiliInternalText(probe) || (absorbArmed && containsToolCallEmissionText(probe))) {
        ctx.log(`[tag-echo] stripped: non-stream responses output ACP echo (render tags/markers/internal artifacts): ${probe.slice(0, 120).replace(/\n/g, " ")}`);
        stripResponsesText(b, absorbArmed, requestText);
    }
    let converted = false;
    let sawReal = false;
    const noteParts: string[] = [];
    const keep: Record<string, unknown>[] = [];
    for (const item of b.output) {
        if (item.type === "function_call" && item.name === COMPRESS_TOOL_NAME) {
            converted = true;
            noteParts.push(yield { name: COMPRESS_TOOL_NAME, args: String(item.arguments ?? ""), id: typeof item.call_id === "string" ? item.call_id : undefined });
        } else {
            if (item.type === "function_call") sawReal = true;
            keep.push(item);
        }
    }
    if (!converted) return body;
    const note = noteParts.join("\n");
    if (note) {
        keep.unshift({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: note }],
        });
    }
    b.output = keep;
    if (!sawReal) b.status = "completed";
    return body;
}

export type { CompressionCore, Config, CoreMessage, Session };
