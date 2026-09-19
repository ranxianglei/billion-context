import type { CompressionCore, Config, CoreMessage } from "acp-kernel";
import type { GooglePart } from "acp-kernel/wire";
import type { Session } from "./session.js";
import { isProxyToolFor } from "./absorb.js";
import { executeProxyTool } from "./loop/core.js";
import type { RewriteCtx } from "./stream.js";
import { containsMarkerLineText, containsRenderTagText, stripAcpTags } from "./loop/tag-echo-filter.js";

export function rewriteGoogleJsonResponse(body: unknown, ctx: RewriteCtx): unknown {
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
    for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const fc = part.functionCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
        if (fc && typeof fc.name === "string" && isProxyToolFor(fc.name, ctx.session, ctx.config)) {
            converted = true;
            const args = fc.args !== null && typeof fc.args === "object" ? (fc.args as Record<string, unknown>) : {};
            noteParts.push(executeProxyTool(fc.name, args, ctx, typeof fc.id === "string" ? fc.id : undefined));
            continue;
        }
        if (fc) sawReal = true;
        if (typeof part.text === "string" && (containsRenderTagText(part.text) || containsMarkerLineText(part.text))) {
            ctx.log(`[warn: tag echo] non-stream google output contains ACP echo (render tags/markers), stripped: ${part.text.slice(0, 120).replace(/\n/g, " ")}`);
            part.text = stripAcpTags(part.text);
        }
        keptParts.push(part);
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
