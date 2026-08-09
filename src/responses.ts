import type { CoreMessage } from "acp-kernel";
import { hashId } from "./util.js";
import { ClusterCounter, deriveMessageId } from "./message-id.js";
import { parseDataUrl, type BiliMessage } from "./bili-message.js";

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
    /** Codex 0.147+ sends a per-conversation UUID here. This is the most
     *  explicit conversation identifier any client sends — prefer it over
     *  previous_response_id and content hashing. */
    session_id?: string;
    previous_response_id?: string;
    [key: string]: unknown;
};

type Flat = {
    msgs: BiliMessage[];
    systemParts: string[];
    preamble: ResponseInputItem[];
    /** call_ids that arrived as custom_tool_call / custom_tool_call_output.
     *  Used by coreToResponses to emit the correct item type on the way back
     *  out — a standard `function_call` must NOT be rewritten as
     *  `custom_tool_call` (different Responses API semantics). */
    customToolCallIds: Set<string>;
    /** Reasoning items dropped because ACP_REASONING_KEEP=none. 0 by default —
     *  reasoning is normally routed through the compression pipeline so it is
     *  hidden automatically once its turn is summarized. */
    droppedReasoning: number;
};

/** Item types that are opaque host directives (tool definitions, computer
 *  calls, ...) and must be preserved verbatim — they are NOT conversation
 *  history and must never be compressed or rewritten. `additional_tools` in
 *  particular carries the Codex code_mode exec/wait tool definitions and MUST
 *  stay at input[0] (see openai/codex client.rs splice(0..0, prefix)).
 *
 *  `reasoning` is intentionally NOT opaque: it IS conversation history (a
 *  prior response's chain-of-thought) and is converted to a tracked
 *  BiliMessage so the compression pipeline hides it once its turn is
 *  summarized — preventing the unbounded accumulation that broke Codex's
 *  prompt-cache prefix. See the `reasoning` case in responsesToCore. */
const OPAQUE_ITEM_TYPES = new Set([
    "additional_tools",
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

/** Escape hatch: when ACP_REASONING_KEEP=none, drop reasoning items entirely
 *  instead of routing them through compression. Default (any other value)
 *  keeps reasoning until its turn is summarized, preserving chain-of-thought
 *  continuity for the responses that are still live. */
function shouldDropAllReasoning(): boolean {
    return (process.env.ACP_REASONING_KEEP ?? "").trim().toLowerCase() === "none";
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

function findInputImage(c: string | ResponseContentPart[]): { mediaType?: string; base64?: string } | undefined {
    if (!Array.isArray(c)) return undefined;
    for (const p of c) {
        if (p && typeof p === "object" && p.type === "input_image") {
            const url = (p as { image_url?: string }).image_url;
            if (typeof url === "string") {
                const parsed = parseDataUrl(url);
                if (parsed) return { mediaType: parsed.mediaType, base64: parsed.base64 };
            }
            return {};
        }
    }
    return undefined;
}

export function responsesToCore(body: ResponsesRequestBody): Flat {
    const msgs: BiliMessage[] = [];
    const systemParts: string[] = [];
    const preamble: ResponseInputItem[] = [];
    const customToolCallIds = new Set<string>();
    let droppedReasoning = 0;
    if (typeof body.instructions === "string" && body.instructions.trim()) {
        systemParts.push(body.instructions);
    }
    let idx = 0;
    const clusters = new ClusterCounter();
    const items = Array.isArray(body.input) ? body.input : [];
    if (typeof body.input === "string") {
        const base = deriveMessageId("user", "text", body.input);
        msgs.push({ id: clusters.next(base), role: "user", contentType: "text", text: body.input });
        idx++;
        return { msgs, systemParts, preamble, customToolCallIds, droppedReasoning };
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
            case "reasoning": {
                // Route reasoning through the compression pipeline (like
                // Anthropic thinking) so it is hidden once its turn is
                // summarized — NOT preserved verbatim in the preamble, which
                // caused unbounded accumulation and broke the prompt-cache
                // prefix. encrypted_content is opaque to us, so we carry the
                // raw item in rawResponsesItem and re-emit it verbatim while
                // the turn is still live. The `text` is only a stable identity
                // for ref-id derivation (the reasoning item's own id).
                if (shouldDropAllReasoning()) {
                    droppedReasoning++;
                    break;
                }
                const rid =
                    typeof (it as { id?: unknown }).id === "string"
                        ? String((it as { id?: string }).id)
                        : hashId(JSON.stringify(it));
                const base = deriveMessageId("assistant", "reasoning", rid);
                msgs.push({
                    id: clusters.next(base),
                    role: "assistant",
                    contentType: "reasoning",
                    text: rid,
                    rawResponsesItem: it,
                });
                idx++;
                break;
            }
            case "message": {
                const m = it as ResponseInputMessage;
                const text = messageContent(m.content);
                if (m.role === "system" || m.role === "developer") {
                    systemParts.push(text);
                } else if (m.role === "user") {
                    const img = findInputImage(m.content);
                    const base = deriveMessageId("user", "text", text);
                    msgs.push({
                        id: clusters.next(base),
                        role: "user",
                        contentType: "text",
                        text,
                        ...(img
                            ? {
                                  rawResponsesItem: it,
                                  ...(img.mediaType && img.base64
                                      ? { imageMediaType: img.mediaType, imageBase64: img.base64 }
                                      : {}),
                              }
                            : {}),
                    });
                    idx++;
                } else if (m.role === "assistant") {
                    if (text) {
                        const base = deriveMessageId("assistant", "text", text);
                        msgs.push({ id: clusters.next(base), role: "assistant", contentType: "text", text });
                        idx++;
                    }
                }
                break;
            }
            case "function_call": {
                const fc = it as ResponseFunctionCall;
                const base = deriveMessageId("assistant", "tool-call", fc.arguments ?? "", {
                    toolCallId: fc.call_id,
                    toolName: fc.name,
                });
                msgs.push({
                    id: clusters.next(base),
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
                const outText = typeof fco.output === "string" ? fco.output : JSON.stringify(fco.output);
                const base = deriveMessageId("tool", "tool-result", outText, { toolCallId: fco.call_id });
                msgs.push({
                    id: clusters.next(base),
                    role: "tool",
                    contentType: "tool-result",
                    toolCallId: fco.call_id,
                    text: outText,
                });
                idx++;
                break;
            }
            case "custom_tool_call": {
                const ctc = it as { call_id?: string; name?: string; input?: string; arguments?: string };
                const callId = ctc.call_id ?? `call_${idx}`;
                customToolCallIds.add(callId);
                const argText = ctc.input ?? ctc.arguments ?? "";
                const base = deriveMessageId("assistant", "tool-call", argText, {
                    toolCallId: callId,
                    toolName: ctc.name ?? "custom",
                });
                msgs.push({
                    id: clusters.next(base),
                    role: "assistant",
                    contentType: "tool-call",
                    toolName: ctc.name ?? "custom",
                    toolCallId: callId,
                    text: argText,
                });
                idx++;
                break;
            }
            case "custom_tool_call_output": {
                const ctco = it as { call_id?: string; output?: string };
                const callId = ctco.call_id ?? `call_${idx}`;
                customToolCallIds.add(callId);
                const outText = typeof ctco.output === "string" ? ctco.output : JSON.stringify(ctco.output ?? "");
                const base = deriveMessageId("tool", "tool-result", outText, { toolCallId: callId });
                msgs.push({
                    id: clusters.next(base),
                    role: "tool",
                    contentType: "tool-result",
                    toolCallId: callId,
                    text: outText,
                });
                idx++;
                break;
            }
            default:
                // Unknown / future item type (forward-compat): preserve verbatim
                // rather than drop. Placed in preamble so it stays in the
                // request uncompressed. Reordering is acceptable vs data loss.
                preamble.push(it);
                break;
        }
    }
    return { msgs, systemParts, preamble, customToolCallIds, droppedReasoning };
}

export function coreToResponses(
    messages: BiliMessage[],
    customToolCallIds: Set<string> = new Set(),
): ResponseInputItem[] {
    const out: ResponseInputItem[] = [];
    for (const m of messages) {
        if (m.role === "system") {
            out.push({ type: "message", role: "developer", content: m.text ?? "" });
        } else if (m.role === "user") {
            if (m.rawResponsesItem) {
                out.push(m.rawResponsesItem as ResponseInputItem);
            } else {
                out.push({ type: "message", role: "user", content: m.text ?? "" });
            }
        } else if (m.role === "assistant") {
            if (m.contentType === "text") {
                out.push({ type: "message", role: "assistant", content: m.text ?? "" });
            } else if (m.contentType === "tool-call") {
                // Preserve the ORIGINAL item type by call_id membership: a host's
                // standard function tool (e.g. get_weather) must stay
                // function_call, not be rewritten as custom_tool_call (which
                // changes Responses API semantics and may be rejected).
                const callId = m.toolCallId ?? `call_${m.id}`;
                if (customToolCallIds.has(callId)) {
                    out.push({
                        type: "custom_tool_call",
                        call_id: callId,
                        name: m.toolName ?? "unknown",
                        input: m.text ?? "",
                        status: "completed",
                    } as ResponseInputItem);
                } else {
                    out.push({
                        type: "function_call",
                        call_id: callId,
                        name: m.toolName ?? "unknown",
                        arguments: m.text ?? "",
                    });
                }
            } else if (m.contentType === "reasoning") {
                // Re-emit the carried raw reasoning item verbatim (with its
                // encrypted_content). Only reached for reasoning whose turn has
                // NOT been compressed — compressed reasoning is hidden by the
                // kernel and never gets here.
                if (m.rawResponsesItem) {
                    out.push(m.rawResponsesItem as ResponseInputItem);
                }
            }
        } else if (m.role === "tool") {
            // Match the tool-call type by call_id so outputs pair correctly.
            const callId = m.toolCallId ?? "";
            if (customToolCallIds.has(callId)) {
                out.push({
                    type: "custom_tool_call_output",
                    call_id: callId,
                    output: m.text ?? "",
                } as ResponseInputItem);
            } else {
                out.push({
                    type: "function_call_output",
                    call_id: callId,
                    output: m.text ?? "",
                });
            }
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

/** Extract the conversation dimension for Responses: a client-provided
 *  session header if present, else the previous_response_id chain (Responses'
 *  native conversation linkage) if present, else a content fingerprint of
 *  the first user input. See conversationSignalAnthropic for the full
 *  rationale. */
export function conversationSignalResponses(body: ResponsesRequestBody, headerValue?: string): string {
    if (headerValue && headerValue.trim()) return headerValue.trim();
    // Codex 0.147+ sends body.session_id (a per-conversation UUID). Prefer it
    // over previous_response_id (may be absent on the first turn) and over
    // content hashing (collides on identical openers). See README "Session
    // identity" for the per-client story.
    if (typeof body.session_id === "string" && body.session_id.length > 0) {
        return `codex-${body.session_id}`;
    }
    if (typeof body.previous_response_id === "string" && body.previous_response_id.length > 0) {
        return `resp-${body.previous_response_id}`;
    }
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
