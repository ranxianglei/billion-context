import type { CoreMessage } from "acp-kernel";
import { condenseOldToolResults, type CondenseOptions, type CondenseResult } from "./anthropic.js";
import { hashId } from "./util.js";

export type OpenAIContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
    | { type: string; [k: string]: unknown };

export type OpenAIToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

export type OpenAIMessage = {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content?: string | null | OpenAIContentPart[];
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    name?: string;
};

export type OpenAITool = {
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
};

export type OpenAIRequestBody = {
    model?: string;
    messages: OpenAIMessage[];
    tools?: OpenAITool[];
    stream?: boolean;
    [key: string]: unknown;
};

type Flat = { msgs: CoreMessage[] };

export function openaiToCore(body: OpenAIRequestBody): Flat {
    const msgs: CoreMessage[] = [];
    let idx = 0;
    for (const m of body.messages) {
        switch (m.role) {
            case "system":
            case "developer": {
                msgs.push({ id: `raw-${idx}`, role: "system", contentType: "text", text: stringContent(m.content) });
                idx++;
                break;
            }
            case "user": {
                msgs.push({ id: `raw-${idx}`, role: "user", contentType: "text", text: stringContent(m.content) });
                idx++;
                break;
            }
            case "assistant": {
                const text = stringContent(m.content);
                if (text) {
                    msgs.push({ id: `raw-${idx}`, role: "assistant", contentType: "text", text });
                    idx++;
                }
                if (Array.isArray(m.tool_calls)) {
                    for (const tc of m.tool_calls) {
                        msgs.push({
                            id: `raw-${idx}`,
                            role: "assistant",
                            contentType: "tool-call",
                            toolName: tc.function.name,
                            toolCallId: tc.id,
                            text: tc.function.arguments ?? "",
                        });
                        idx++;
                    }
                }
                break;
            }
            case "tool": {
                msgs.push({
                    id: `raw-${idx}`,
                    role: "tool",
                    contentType: "tool-result",
                    toolCallId: m.tool_call_id ?? "",
                    text: stringContent(m.content),
                });
                idx++;
                break;
            }
        }
    }
    return { msgs };
}

export function coreToOpenai(messages: CoreMessage[]): OpenAIMessage[] {
    const out: OpenAIMessage[] = [];
    let pending: { text: string | null; toolCalls: OpenAIToolCall[] } | null = null;
    const flush = () => {
        if (!pending) return;
        if (pending.toolCalls.length > 0) {
            out.push({
                role: "assistant",
                content: pending.text ?? null,
                tool_calls: pending.toolCalls,
            });
        } else if (pending.text !== null) {
            out.push({ role: "assistant", content: pending.text });
        }
        pending = null;
    };
    for (const m of messages) {
        if (m.role === "assistant") {
            if (!pending) pending = { text: null, toolCalls: [] };
            if (m.contentType === "text") {
                pending.text = (pending.text ?? "") + (m.text ?? "");
            } else if (m.contentType === "tool-call") {
                pending.toolCalls.push({
                    id: m.toolCallId ?? `call_${m.id}`,
                    type: "function",
                    function: { name: m.toolName ?? "unknown", arguments: m.text ?? "" },
                });
            }
        } else {
            flush();
            if (m.role === "system") {
                out.push({ role: "system", content: m.text ?? "" });
            } else if (m.role === "user") {
                out.push({ role: "user", content: m.text ?? "" });
            } else if (m.role === "tool") {
                out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.text ?? "" });
            }
        }
    }
    flush();
    return out;
}

export function injectOpenaiSystem(messages: OpenAIMessage[], parts: string[]): OpenAIMessage[] {
    if (parts.length === 0) return messages;
    const extra = parts.join("\n\n");
    if (messages.length > 0 && (messages[0]?.role === "system" || messages[0]?.role === "developer")) {
        const head = messages[0] as OpenAIMessage;
        const base = stringContent(head.content);
        const merged = base ? `${base}\n\n---\n\n${extra}` : extra;
        return [{ ...head, content: merged }, ...messages.slice(1)];
    }
    return [{ role: "system", content: extra }, ...messages];
}

export { condenseOldToolResults, type CondenseOptions, type CondenseResult };

export function deriveSessionIdOpenai(body: OpenAIRequestBody, headerValue?: string): string {
    if (headerValue && headerValue.trim()) return headerValue.trim();
    const firstUser = body.messages.find((m) => m.role === "user");
    const seed = firstUser ? stringContent(firstUser.content).slice(0, 200) : "default";
    return hashId(seed);
}

function stringContent(content: OpenAIMessage["content"]): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => (typeof p === "string" ? p : p.type === "text" ? (p as { text?: string }).text ?? "" : ""))
            .join("\n");
    }
    return "";
}
