import type { CoreMessage } from "acp-kernel";
import { PROXY_TOOL_NAMES } from "./compress-tool.js";
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

type Flat = { msgs: CoreMessage[]; systemParts: string[]; preamble: ResponseInputItem[] };

/** Item types that are opaque host directives (tool definitions, reasoning,
 *  computer calls, ...) and must be preserved verbatim — they are NOT
 *  conversation history and must never be compressed or rewritten.
 *  `additional_tools` in particular carries the Codex code_mode exec/wait
 *  tool definitions and MUST stay at input[0] (see openai/codex client.rs
 *  splice(0..0, prefix)). */
const OPAQUE_ITEM_TYPES = new Set([
    "additional_tools",
    "reasoning",
    "computer_call",
    "computer_call_output",
    "file_search_call",
    "web_search_call",
    "image_generation_call",
    "code_interpreter_call",
    "mcp_list_tools",
    "mcp_call",
]);

function isOpaqueItem(it: ResponseInputItem): boolean {
    return OPAQUE_ITEM_TYPES.has(it.type);
}

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
    const preamble: ResponseInputItem[] = [];
    if (typeof body.instructions === "string" && body.instructions.trim()) {
        systemParts.push(body.instructions);
    }
    let idx = 0;
    const items = Array.isArray(body.input) ? body.input : [];
    if (typeof body.input === "string") {
        msgs.push({ id: `raw-${idx}`, role: "user", contentType: "text", text: body.input });
        idx++;
        return { msgs, systemParts, preamble };
    }
    for (const it of items) {
        // Preserve opaque host-directive items verbatim. They are never
        // conversation history: capture them so the caller re-prepends them
        // unchanged (additional_tools MUST stay at input[0]).
        if (isOpaqueItem(it)) {
            preamble.push(it);
            continue;
        }
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
            case "custom_tool_call": {
                // code_mode exec/wait calls. Carried as conversation history so
                // the model can see prior tool results and not loop. Fields are
                // per OpenAI Responses API (input or arguments; status).
                const ctc = it as { call_id?: string; name?: string; input?: string; arguments?: string };
                msgs.push({
                    id: `raw-${idx}`,
                    role: "assistant",
                    contentType: "tool-call",
                    toolName: ctc.name ?? "custom",
                    toolCallId: ctc.call_id ?? `call_${idx}`,
                    text: ctc.input ?? ctc.arguments ?? "",
                });
                idx++;
                break;
            }
            case "custom_tool_call_output": {
                const ctco = it as { call_id?: string; output?: string };
                msgs.push({
                    id: `raw-${idx}`,
                    role: "tool",
                    contentType: "tool-result",
                    toolCallId: ctco.call_id ?? `call_${idx}`,
                    text: typeof ctco.output === "string" ? ctco.output : JSON.stringify(ctco.output ?? ""),
                });
                idx++;
                break;
            }
            default:
                // Unknown conversational item type — drop from compression.
                break;
        }
    }
    return { msgs, systemParts, preamble };
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
                // code_mode exec/wait are `custom` tools → emit custom_tool_call
                // (with `input` field). Our injected compress tool is a function
                // tool → function_call (with `arguments`).
                if (PROXY_TOOL_NAMES.has(m.toolName ?? "")) {
                    out.push({
                        type: "function_call",
                        call_id: m.toolCallId ?? `call_${m.id}`,
                        name: m.toolName ?? "unknown",
                        arguments: m.text ?? "",
                    });
                } else {
                    out.push({
                        type: "custom_tool_call",
                        call_id: m.toolCallId ?? `call_${m.id}`,
                        name: m.toolName ?? "unknown",
                        input: m.text ?? "",
                        status: "completed",
                    } as ResponseInputItem);
                }
            }
        } else if (m.role === "tool") {
            // Match the tool-call format: function tools → function_call_output,
            // custom tools → custom_tool_call_output.
            out.push({
                type: "custom_tool_call_output",
                call_id: m.toolCallId ?? "",
                output: m.text ?? "",
            } as ResponseInputItem);
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
