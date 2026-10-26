import type { CompressionCore, Config, CoreMessage } from "acp-kernel";
import type { GooglePart } from "acp-kernel/wire";
import type { Session } from "./session.js";
import { effectiveAbsorbConfig, isProxyToolFor } from "./absorb.js";
import { executeProxyToolAsync } from "./loop/core.js";
import { drainPendingRetrievals } from "./store.js";
import { runJsonRewriteAsync, type JsonToolCall, type RewriteCtx } from "./stream.js";
import { containsBiliInternalText, containsMarkerLineText, containsRenderTagText, containsToolCallEmissionText, stripAcpTags } from "./loop/tag-echo-filter.js";

export async function rewriteGoogleJsonResponseAsync(body: unknown, ctx: RewriteCtx, signal?: AbortSignal): Promise<unknown> {
    return runJsonRewriteAsync(rewriteGoogleJsonSteps(body, ctx), async (call) => (await executeProxyToolAsync(call.name, call.args as Record<string, unknown>, ctx, call.id, undefined, signal)).text);
}

function* rewriteGoogleJsonSteps(body: unknown, ctx: RewriteCtx): Generator<JsonToolCall, unknown, string> {
    if (!body || typeof body !== "object") return body;
    const b = body as {
        candidates?: Array<{ content?: { role?: string; parts?: GooglePart[] }; finishReason?: string }>;
    };
    const candidate = b.candidates?.[0];
    const content = candidate?.content;
    const parts = content?.parts;
    if (!candidate || !content || !Array.isArray(parts)) return body;
    let converted = false;
    let sawReal = false;
    const noteParts: string[] = [];
    const keptParts: GooglePart[] = [];
    // Absorb signature in whole text (m00885): drop only when the request
    // actually instructed the model about absorb.
    const absorbArmed = effectiveAbsorbConfig(ctx.session, ctx.config)?.enabled === true;
    const requestText = JSON.stringify(ctx.messages);
    for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const fc = part.functionCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
        if (fc && typeof fc.name === "string" && isProxyToolFor(fc.name, ctx.session, ctx.config)) {
            converted = true;
            const args = fc.args !== null && typeof fc.args === "object" ? (fc.args as Record<string, unknown>) : {};
            noteParts.push(yield { name: fc.name, args, id: typeof fc.id === "string" ? fc.id : undefined });
            continue;
        }
        if (fc) sawReal = true;
        // #1960/KDD#10: a thought part carries a thoughtSignature the client
        // echoes back verbatim — rewriting its text desyncs the signature and
        // bricks replay. Strip prose only from non-thought parts.
        if ((part as { thought?: boolean }).thought !== true && typeof part.text === "string" && (containsRenderTagText(part.text) || containsMarkerLineText(part.text) || containsBiliInternalText(part.text) || (absorbArmed && containsToolCallEmissionText(part.text)))) {
            ctx.log(`[tag-echo] stripped: non-stream google output ACP echo (render tags/markers/internal artifacts): ${part.text.slice(0, 120).replace(/\n/g, " ")}`);
            part.text = stripAcpTags(part.text, absorbArmed, requestText);
        }
        keptParts.push(part);
    }
    // #1097: non-stream has no re-request to ride — retrieval full text rides
    // inline after the ack, same as the anthropic rewrite twin.
    for (const injection of drainPendingRetrievals(ctx.session)) {
        if (typeof injection.text === "string") noteParts.push(injection.text);
    }
    if (!converted) return body;
    // The tool result is a NEW text part: an existing text part may carry a
    // thoughtSignature the client echoes back, and appending to its text would
    // leave the signature describing a string that no longer exists.
    content.parts = [...keptParts, { text: noteParts.join("\n") }];
    if (!sawReal) {
        candidate.finishReason = "STOP";
    }
    return body;
}

export type { CompressionCore, Config, CoreMessage, Session };
