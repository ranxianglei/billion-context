import type { CoreMessage } from "acp-kernel";
import { condenseOldToolResults, type CondenseOptions, type CondenseResult } from "./anthropic.js";
import { hashId } from "./util.js";

/**
 * OpenAI Responses API protocol shapes.
 *
 * The Responses API replaces the flat `messages` array with `input` — an
 * ordered list of typed items (message / function_call / function_call_output
 * / computer_call / ...). Each item carries an explicit `type` discriminator,
 * which actually maps closer to core messages than OpenAI chat completions
 * (where assistant text + tool_calls are fused into one message).
 *
 * See https://platform.openai.com/docs/api-reference/responses
 */

export type ResponseContentPart =
    | { type: "input_text"; text: string }
    | { type: "output_text"; text: string }
    | { type: "input_image"; image_url: string }
    | { type: string; [k: string]: unknown };

export type ResponseInputMessage = {
    type: "message";
    role: "system" | "developer" | "user" | "assistant";
    content: string | ResponseContentPart[];
};

export type ResponseFunctionCall = {
    type: "function_call";
    id?: string;
    call_id: string;
    name: string;
    arguments: string;
};

export type ResponseFunctionCallOutput = {
    type: "function_call_output";
    call_id: string;
    output: string;
};

export type ResponseInputItem =
    | ResponseInputMessage
    | ResponseFunctionCall
    | ResponseFunctionCallOutput
    | { type: string; [k: string]: unknown };

export type ResponsesRequestBody = {
    model?: string;
    input: string | ResponseInputItem[];
    instructions?: string;
    tools?: unknown[];
    stream?: boolean;
    previous_response_id?: string;
    [key: string]: unknown;
};

type Flat = { msgs: CoreMessage[]; systemParts: string[] };

function partText(p: ResponseContentPart): string {
    if (p.type === "input_text" || p.type === "output_text") {
        const t = (p as { text?: string }).text;
        return typeof t === "string" ? t : "";
    }
    return "";
}

function messageContent(c: string | ResponseContentPart[]): string {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map(partText).join("\n");
    return "";
}

export function responsesToCore(body: ResponsesRequestBody): Flat {
    const msgs: CoreMessage[] = [];
    const systemParts: string[] = [];
    if (typeof body.instructions === "string" && body.instructions.trim()) {
        systemParts.push(body.instructions);
    }
    let idx = 0;
    const items = Array.isArray(body.input) ? body.input : [];
    if (typeof body.input === "string") {
        msgs.push({ id: `raw-${idx}`, role: "user", contentType: "text", text: body.input });
        idx++;
        return { msgs, systemParts };
    }
    for (const it of items) {
        switch (it.type) {
            case "message": {
                const m = it as ResponseInputMessage;
                const text = messageContent(m.content);
                if (m.role === "system" || m.role === "developer") {
                    systemParts.push(text);
                } else if (m.role === "user") {
                    msgs.push({ id: `raw-${idx}`, role: "user", contentType: "text", text });
                    idx++;
                } else if (m.role === "assistant") {
                    if (text) {
                        msgs.push({ id: `raw-${idx}`, role: "assistant", contentType: "text", text });
                        idx++;
                    }
                }
                break;
            }
            case "function_call": {
                const fc = it as ResponseFunctionCall;
                msgs.push({
                    id: `raw-${idx}`,
                    role: "assistant",
                    contentType: "tool-call",
                    toolName: fc.name,
                    toolCallId: fc.call_id,
                    text: fc.arguments ?? "",
                });
                idx++;
                break;
            }
            case "function_call_output": {
                const fco = it as ResponseFunctionCallOutput;
                msgs.push({
                    id: `raw-${idx}`,
                    role: "tool",
                    contentType: "tool-result",
                    toolCallId: fco.call_id,
                    text: typeof fco.output === "string" ? fco.output : JSON.stringify(fco.output),
                });
                idx++;
                break;
            }
            default:
                // Unknown item type (computer_call, reasoning, etc.) — drop.
                break;
        }
    }
    return { msgs, systemParts };
}

export function coreToResponses(messages: CoreMessage[]): ResponseInputItem[] {
    const out: ResponseInputItem[] = [];
    for (const m of messages) {
        if (m.role === "system") {
            out.push({ type: "message", role: "developer", content: m.text ?? "" });
        } else if (m.role === "user") {
            out.push({ type: "message", role: "user", content: m.text ?? "" });
        } else if (m.role === "assistant") {
            if (m.contentType === "text") {
                out.push({ type: "message", role: "assistant", content: m.text ?? "" });
            } else if (m.contentType === "tool-call") {
                out.push({
                    type: "function_call",
                    call_id: m.toolCallId ?? `call_${m.id}`,
                    name: m.toolName ?? "unknown",
                    arguments: m.text ?? "",
                });
            }
        } else if (m.role === "tool") {
            out.push({
                type: "function_call_output",
                call_id: m.toolCallId ?? "",
                output: m.text ?? "",
            });
        }
    }
    return out;
}

export function injectResponsesInstructions(
    body: ResponsesRequestBody,
    extraParts: string[],
): ResponsesRequestBody {
    if (extraParts.length === 0) return body;
    const extra = extraParts.join("\n\n");
    const existing = typeof body.instructions === "string" ? body.instructions : "";
    return {
        ...body,
        instructions: existing ? `${existing}\n\n---\n\n${extra}` : extra,
    };
}

export { condenseOldToolResults, type CondenseOptions, type CondenseResult };

export function deriveSessionIdResponses(body: ResponsesRequestBody, headerValue?: string): string {
    if (headerValue && headerValue.trim()) return headerValue.trim();
    let seed = "default";
    if (Array.isArray(body.input)) {
        const firstUser = body.input.find(
            (i) => i.type === "message" && (i as ResponseInputMessage).role === "user",
        ) as ResponseInputMessage | undefined;
        if (firstUser) seed = messageContent(firstUser.content).slice(0, 200);
    } else if (typeof body.input === "string") {
        seed = body.input.slice(0, 200);
    }
    return hashId(seed);
}
