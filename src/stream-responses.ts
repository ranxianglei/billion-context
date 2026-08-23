import type { CompressionCore, Config, CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";
import { COMPRESS_TOOL_NAME, BILI_TOOL_NAMES, parseCompressInput } from "./compress-tool.js";
import { applyRanges, type RewriteCtx } from "./stream.js";
import { safeJsonParse } from "./util.js";

/**
 * Responses API (non-streaming) JSON rewriter: strips compress function_call
 * items from `output` and surfaces their result as a leading assistant message
 * item. The streaming variant previously lived here too but was unreachable
 * (server.ts routes streams through the compress-loop adapter, which emits a
 * correct output_item.added → delta → done sequence); it has been removed.
 */
export function rewriteResponsesJsonResponse(body: unknown, ctx: RewriteCtx): unknown {
    if (!body || typeof body !== "object") return body;
    const b = body as {
        output?: Array<Record<string, unknown>>;
        status?: string;
    };
    if (!Array.isArray(b.output)) return body;
    let converted = false;
    let sawReal = false;
    const noteParts: string[] = [];
    const keep: Record<string, unknown>[] = [];
    for (const item of b.output) {
        if (item.type === "function_call" && (item.name === COMPRESS_TOOL_NAME || item.name === BILI_TOOL_NAMES.compress)) {
            converted = true;
            noteParts.push(applyRanges(parseCompressInput(safeJsonParse(String(item.arguments ?? ""))), ctx));
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
