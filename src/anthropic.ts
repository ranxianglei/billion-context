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

const CONDENSED_TAG = "[acp-proxy: condensed";

export function extractSystem(system: AnthropicRequestBody["system"]): string {
    if (!system) return "";
    if (typeof system === "string") return system;
    return system.map((b) => b.text).join("\n\n");
}

export function buildSystem(text: string, original: AnthropicRequestBody["system"]): string | AnthropicTextBlock[] {
    if (Array.isArray(original) && original.length > 0) {
        const cc = original[0]?.cache_control;
        return [{ type: "text", text, ...(cc ? { cache_control: cc } : {}) }];
    }
    return text;
}

type Flat = { msgs: CoreMessage[] };

export function anthropicToCore(body: AnthropicRequestBody): Flat {
    const msgs: CoreMessage[] = [];
    const clusters = new ClusterCounter();
    for (const m of body.messages) {
        const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
        for (const b of blocks) {
            switch (b.type) {
                case "text": {
                    const base = deriveMessageId(m.role, "text", b.text);
                    msgs.push({ id: clusters.next(base), role: m.role, contentType: "text", text: b.text });
                    break;
                }
                case "tool_use": {
                    const base = deriveMessageId("assistant", "tool-call", safeStringify(b.input), {
                        toolCallId: b.id,
                        toolName: b.name,
                    });
                    msgs.push({
                        id: clusters.next(base),
                        role: "assistant",
                        contentType: "tool-call",
                        toolName: b.name,
                        toolCallId: b.id,
                        text: safeStringify(b.input),
                    });
                    break;
                }
                case "tool_result": {
                    const text = typeof b.content === "string" ? b.content : b.content.map((c) => c.text).join("\n");
                    const base = deriveMessageId("tool", "tool-result", text, { toolCallId: b.tool_use_id });
                    msgs.push({
                        id: clusters.next(base),
                        role: "tool",
                        contentType: "tool-result",
                        toolCallId: b.tool_use_id,
                        text,
                    });
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
    return { msgs };
}

export function coreToAnthropic(messages: CoreMessage[]): AnthropicMessage[] {
    const out: AnthropicMessage[] = [];
    let current: { role: "user" | "assistant"; blocks: AnthropicBlock[] } | null = null;
    const flush = () => {
        if (current && current.blocks.length > 0) {
            out.push({ role: current.role, content: current.blocks });
        }
        current = null;
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
                current.blocks.push({ type: "text", text: m.text ?? "" });
                break;
            case "tool-call":
                current.blocks.push({
                    type: "tool_use",
                    id: m.toolCallId ?? `call_${m.id}`,
                    name: m.toolName ?? "unknown",
                    input: safeParse(m.text),
                });
                break;
            case "tool-result":
                current.blocks.push({
                    type: "tool_result",
                    tool_use_id: m.toolCallId ?? "",
                    content: m.text ?? "",
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

export type CondenseOptions = {
    keepRecent: number;
    minChars: number;
    maxKeptChars: number;
    enabled: boolean;
};

export type CondenseResult = {
    messages: CoreMessage[];
    condensedCount: number;
    charsSaved: number;
};

export function condenseOldToolResults(messages: CoreMessage[], opts: CondenseOptions): CondenseResult {
    if (!opts.enabled) return { messages, condensedCount: 0, charsSaved: 0 };
    const toolResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m && m.contentType === "tool-result") toolResultIndices.push(i);
    }
    if (toolResultIndices.length <= opts.keepRecent) {
        return { messages, condensedCount: 0, charsSaved: 0 };
    }
    const toCondense = new Set(toolResultIndices.slice(0, toolResultIndices.length - opts.keepRecent));
    let condensedCount = 0;
    let charsSaved = 0;
    const out = messages.map((m, i) => {
        if (!toCondense.has(i)) return m;
        const text = m.text ?? "";
        if (text.length < opts.minChars) return m;
        const head = text.slice(0, opts.maxKeptChars);
        const stub = `${CONDENSED_TAG} ${text.length.toLocaleString()} chars]\n${head}\n[/acp-proxy]`;
        charsSaved += text.length - stub.length;
        condensedCount++;
        return { ...m, text: stub };
    });
    return { messages: out, condensedCount, charsSaved };
}

export function deriveSessionId(body: AnthropicRequestBody, headerValue?: string): string {
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
