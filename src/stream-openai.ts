import type { CompressionCore, Config, CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";
import { COMPRESS_TOOL_NAME, parseCompressInput } from "./compress-tool.js";
import { applyRanges, runJsonRewrite, runJsonRewriteAsync, type JsonToolCall, type RewriteCtx } from "./stream.js";
import { applyConfiguredCompression } from "./external-summary-compress.js";
import { effectiveAbsorbConfig } from "./absorb.js";
import { containsBiliInternalText, containsMarkerLineText, containsRenderTagText, containsToolCallEmissionText, stripAcpTags } from "./loop/tag-echo-filter.js";

export function rewriteOpenaiJsonResponse(body: unknown, ctx: RewriteCtx): unknown {
    return runJsonRewrite(rewriteOpenaiJsonSteps(body, ctx), (call) => applyRanges(parseCompressInput(call.args, call.id), ctx).text);
}

export async function rewriteOpenaiJsonResponseAsync(body: unknown, ctx: RewriteCtx, signal?: AbortSignal): Promise<unknown> {
    return runJsonRewriteAsync(rewriteOpenaiJsonSteps(body, ctx), async (call) => (await applyConfiguredCompression(call.args, ctx, call.id, signal)).text);
}

function* rewriteOpenaiJsonSteps(body: unknown, ctx: RewriteCtx): Generator<JsonToolCall, unknown, string> {
    if (!body || typeof body !== "object") return body;
    const b = body as {
        choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>;
    };
    const choice = b.choices?.[0];
    const msg = choice?.message;
    if (!choice || !msg) return body;
    let converted = false;
    let sawReal = false;
    const noteParts: string[] = [];
    const keepToolCalls: unknown[] = [];
    let existingText = typeof msg.content === "string" ? msg.content : "";
    const toolCalls = msg.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }> | undefined;
    if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
            if (tc.function?.name === COMPRESS_TOOL_NAME) {
                converted = true;
                noteParts.push(yield { name: COMPRESS_TOOL_NAME, args: tc.function?.arguments ?? "", id: tc.id });
            } else {
                sawReal = true;
                keepToolCalls.push(tc);
            }
        }
        // #1501 option C: a tool_call whose name never arrived is undeliverable
        // (#1484 class). Non-compress calls are forwarded verbatim on this lane,
        // so warn once per response instead of altering bytes. Runs before the
        // !converted early return: nameless real calls pass through in both cases.
        const namelessToolCallIdx: number[] = [];
        for (let i = 0; i < toolCalls.length; i++) {
            const nm = (toolCalls[i] ?? {})?.function?.name;
            if (typeof nm !== "string" || nm.length === 0) namelessToolCallIdx.push(i);
        }
        if (namelessToolCallIdx.length > 0) {
            ctx.log(`[warn: nameless tool call] non-stream openai response carries ${namelessToolCallIdx.length} nameless tool_call(s) at index ${namelessToolCallIdx.join(",")} — forwarded verbatim (#1501 observe-only)`);
        }
    }
    // Absorb signature in whole text (m00885): drop only when the request
    // actually instructed the model about absorb — the shape check alone
    // cannot tell an emission from a user-quoted fragment.
    const absorbArmed = effectiveAbsorbConfig(ctx.session, ctx.config)?.enabled === true;
    const requestText = JSON.stringify(ctx.messages);
    if (existingText && (containsRenderTagText(existingText) || containsMarkerLineText(existingText) || containsBiliInternalText(existingText) || (absorbArmed && containsToolCallEmissionText(existingText)))) {
        ctx.log(`[tag-echo] stripped: non-stream openai output ACP echo (render tags/markers/internal artifacts): ${existingText.slice(0, 120).replace(/\n/g, " ")}`);
        existingText = stripAcpTags(existingText, absorbArmed, requestText);
        msg.content = existingText;
    }
    if (!converted) return body;
    const note = noteParts.join("\n");
    msg.content = existingText ? `${existingText}\n${note}` : note;
    if (keepToolCalls.length > 0) {
        msg.tool_calls = keepToolCalls;
    } else {
        delete msg.tool_calls;
    }
    if (!sawReal) {
        choice.finish_reason = "stop";
    }
    return body;
}

export type { CompressionCore, Config, CoreMessage, Session };
