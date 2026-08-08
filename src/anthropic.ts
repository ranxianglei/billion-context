import type { CoreMessage } from "acp-kernel";
import { hashId } from "./util.js";
import { ClusterCounter, deriveMessageId } from "./message-id.js";

export type AnthropicTextBlock = { type: "text"; text: string; cache_control?: unknown };
export type AnthropicToolUse = {
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
    cache_control?: unknown;
};
export type AnthropicToolResult = {
    type: "tool_result";
    tool_use_id: string;
    content: string | AnthropicTextBlock[];
    is_error?: boolean;
    cache_control?: unknown;
};
export type AnthropicImage = { type: "image"; source: unknown };
export type AnthropicThinking = { type: "thinking"; thinking: string; signature?: string };
export type AnthropicBlock =
    | AnthropicTextBlock
    | AnthropicToolUse
    | AnthropicToolResult
    | AnthropicImage
    | AnthropicThinking;

export type AnthropicMessage = {
    role: "user" | "assistant";
    content: string | AnthropicBlock[];
};

export type AnthropicRequestBody = {
    model?: string;
    max_tokens?: number;
    system?: string | AnthropicTextBlock[];
    messages: AnthropicMessage[];
    tools?: unknown[];
    stream?: boolean;
    temperature?: number;
    [key: string]: unknown;
};


export function extractSystem(system: AnthropicRequestBody["system"]): string {
    if (!system) return "";
    if (typeof system === "string") return system;
    return system.map((b) => b.text).join("\n\n");
}

export function buildSystem(text: string, original: AnthropicRequestBody["system"]): string | AnthropicTextBlock[] {
    if (Array.isArray(original) && original.length > 0) {
        const ccBlock = original.find((b) => b.cache_control);
        return [{ type: "text", text, ...(ccBlock ? { cache_control: ccBlock.cache_control } : {}) }];
    }
    return text;
}

type Flat = { msgs: CoreMessage[]; cacheControls: Map<string, unknown> };

export function anthropicToCore(body: AnthropicRequestBody): Flat {
    const msgs: CoreMessage[] = [];
    const cacheControls = new Map<string, unknown>();
    const clusters = new ClusterCounter();
    for (const m of body.messages) {
        const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
        for (const b of blocks) {
            switch (b.type) {
                case "text": {
                    const base = deriveMessageId(m.role, "text", b.text);
                    const id = clusters.next(base);
                    msgs.push({ id, role: m.role, contentType: "text", text: b.text });
                    if (b.cache_control) cacheControls.set(id, b.cache_control);
                    break;
                }
                case "tool_use": {
                    const base = deriveMessageId("assistant", "tool-call", safeStringify(b.input), {
                        toolCallId: b.id,
                        toolName: b.name,
                    });
                    const id = clusters.next(base);
                    msgs.push({
                        id,
                        role: "assistant",
                        contentType: "tool-call",
                        toolName: b.name,
                        toolCallId: b.id,
                        text: safeStringify(b.input),
                    });
                    if (b.cache_control) cacheControls.set(id, b.cache_control);
                    break;
                }
                case "tool_result": {
                    const text = typeof b.content === "string" ? b.content : b.content.map((c) => c.text).join("\n");
                    const base = deriveMessageId("tool", "tool-result", text, { toolCallId: b.tool_use_id });
                    const id = clusters.next(base);
                    msgs.push({
                        id,
                        role: "tool",
                        contentType: "tool-result",
                        toolCallId: b.tool_use_id,
                        text,
                    });
                    if (b.cache_control) cacheControls.set(id, b.cache_control);
                    break;
                }
                case "thinking": {
                    const base = deriveMessageId("assistant", "reasoning", b.thinking);
                    msgs.push({ id: clusters.next(base), role: "assistant", contentType: "reasoning", text: b.thinking });
                    break;
                }
                case "image": {
                    const base = deriveMessageId(m.role, "text", "[image]");
                    msgs.push({ id: clusters.next(base), role: m.role, contentType: "text", text: "[image]" });
                    break;
                }
            }
        }
    }
    return { msgs, cacheControls };
}

export function coreToAnthropic(messages: CoreMessage[], cacheControls?: Map<string, unknown>): AnthropicMessage[] {
    const out: AnthropicMessage[] = [];
    let current: { role: "user" | "assistant"; blocks: AnthropicBlock[] } | null = null;
    const flush = () => {
        if (current && current.blocks.length > 0) {
            out.push({ role: current.role, content: current.blocks });
        }
        current = null;
    };
    const cc = (id: string): { cache_control?: unknown } => {
        const v = cacheControls?.get(id);
        return v ? { cache_control: v } : {};
    };
    for (const m of messages) {
        const target: "user" | "assistant" =
            m.role === "assistant" ? "assistant" : "user";
        if (!current || current.role !== target) {
            flush();
            current = { role: target, blocks: [] };
        }
        switch (m.contentType) {
            case "text":
                current.blocks.push({ type: "text", text: m.text ?? "", ...cc(m.id) });
                break;
            case "tool-call":
                current.blocks.push({
                    type: "tool_use",
                    id: m.toolCallId ?? `call_${m.id}`,
                    name: m.toolName ?? "unknown",
                    input: safeParse(m.text),
                    ...cc(m.id),
                });
                break;
            case "tool-result":
                current.blocks.push({
                    type: "tool_result",
                    tool_use_id: m.toolCallId ?? "",
                    content: m.text ?? "",
                    ...cc(m.id),
                });
                break;
            case "reasoning":
                current.blocks.push({ type: "thinking", thinking: m.text ?? "" });
                break;
        }
    }
    flush();
    return out;
}

/** Extract the conversation dimension for Anthropic: a client-provided
 *  session header if present, else a content fingerprint of the first user
 *  message. The protocol+upstream+key dimensions are mixed in by the caller
 *  (server.ts) via deriveSessionId() — this function contributes only the
 *  conversation axis. */
export function conversationSignalAnthropic(body: AnthropicRequestBody, headerValue?: string): string {
    if (headerValue && headerValue.trim()) return headerValue.trim();
    const firstUser = body.messages.find((m) => m.role === "user");
    const seed = firstUser ? JSON.stringify(firstUser.content).slice(0, 200) : "default";
    return hashId(seed);
}

function safeStringify(v: unknown): string {
    try {
        return JSON.stringify(v ?? {});
    } catch {
        return "{}";
    }
}

function safeParse(s: string | undefined): unknown {
    if (!s) return {};
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}
