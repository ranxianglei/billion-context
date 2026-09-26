// #1295: codec for the commandcode CLI wire family — the nested CLI envelope
// ({config, memory, taste, skills, params{model, messages, tools, system, ...},
// threadId}) around an openai-completions-shaped conversation. unwrap turns
// one into a flat OpenAI chat body so the standard pipeline (kernel, preflight,
// window resolution, session binding) runs unchanged; rewrap restores the
// envelope at the final forward boundary AFTER compat-roles/output-steering
// mutations have applied to the flat body.
//
// Strict fidelity (#1284 precedent): ANY shape this codec cannot convert is
// rejected (undefined) and the caller relays the original bytes verbatim —
// never a partial conversion. See WIRE-CONTRACTS.md (WC-* entries).

export interface CommandcodeEnvelopeMeta {
    /** Every original top-level envelope key except `params`, verbatim. */
    rest: Record<string, unknown>;
    /** Original params.system string ("" when the slot was absent). */
    systemText: string;
    hadSystem: boolean;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
    /** Unknown params.* keys, passed through both directions. */
    extraParams: Record<string, unknown>;
    /** Assistant tool-call id → name, for tool-result rewrap fidelity. */
    toolNames: Map<string, string>;
    /** Tool-result ids whose original output type was "error-text". */
    errorResultIds: Set<string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function convertMessages(
    messages: unknown,
    toolNames: Map<string, string>,
    errorResultIds: Set<string>,
): Array<Record<string, unknown>> | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const out: Array<Record<string, unknown>> = [];
    let systemParts: string[] = [];
    for (const m of messages) {
        if (!isObj(m)) return undefined;
        const role = m.role;
        if (role === "system") {
            if (typeof m.content !== "string") return undefined;
            systemParts.push(m.content);
            continue;
        }
        if (role === "user") {
            if (typeof m.content === "string") {
                out.push({ role: "user", content: m.content });
                continue;
            }
            if (!Array.isArray(m.content)) return undefined;
            const parts: string[] = [];
            for (const b of m.content) {
                if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") return undefined;
                parts.push(b.text as string);
            }
            if (parts.length === 0) continue;
            out.push({ role: "user", content: parts.join("\n") });
            continue;
        }
        if (role === "assistant") {
            const texts: string[] = [];
            const reasonings: string[] = [];
            const toolCalls: Array<Record<string, unknown>> = [];
            if (typeof m.content === "string") {
                texts.push(m.content);
            } else if (m.content !== undefined) {
                if (!Array.isArray(m.content)) return undefined;
                for (const b of m.content) {
                    if (!isObj(b)) return undefined;
                    if (b.type === "text") {
                        if (typeof b.text !== "string") return undefined;
                        texts.push(b.text as string);
                    } else if (b.type === "reasoning") {
                        if (typeof b.text !== "string") return undefined;
                        reasonings.push(b.text as string);
                    } else if (b.type === "tool-call") {
                        if (typeof b.toolCallId !== "string" || typeof b.toolName !== "string") return undefined;
                        const input = b.input === undefined ? {} : b.input;
                        if (!isObj(input)) return undefined;
                        toolNames.set(b.toolCallId, b.toolName);
                        toolCalls.push({
                            id: b.toolCallId,
                            type: "function",
                            function: { name: b.toolName, arguments: JSON.stringify(input) },
                        });
                    } else {
                        return undefined;
                    }
                }
            }
            if (texts.length === 0 && reasonings.length === 0 && toolCalls.length === 0) continue;
            const msg: Record<string, unknown> = { role: "assistant", content: texts.length > 0 ? texts.join("\n") : null };
            if (reasonings.length > 0) msg.reasoning_content = reasonings.join("\n");
            if (toolCalls.length > 0) msg.tool_calls = toolCalls;
            out.push(msg);
            continue;
        }
        if (role === "tool") {
            if (!Array.isArray(m.content)) return undefined;
            for (const b of m.content) {
                if (!isObj(b) || b.type !== "tool-result") return undefined;
                if (typeof b.toolCallId !== "string") return undefined;
                if (typeof b.toolName === "string") toolNames.set(b.toolCallId, b.toolName);
                const o = b.output;
                if (!isObj(o) || (o.type !== "text" && o.type !== "error-text") || typeof o.value !== "string") return undefined;
                if (o.type === "error-text") errorResultIds.add(b.toolCallId);
                out.push({ role: "tool", tool_call_id: b.toolCallId, content: o.value });
            }
            continue;
        }
        return undefined;
    }
    if (systemParts.length > 0) out.unshift({ role: "system", content: systemParts.join("\n\n") });
    return out.length > 0 ? out : undefined;
}

/** Convert a parsed CLI envelope to a flat OpenAI chat body. Returns undefined
 *  when the body is not a convertible streaming CLI conversation — the caller
 *  relays the original bytes verbatim. */
export function unwrapCommandcodeBody(parsed: Record<string, unknown>): { body: Record<string, unknown>; meta: CommandcodeEnvelopeMeta } | undefined {
    const params = parsed.params;
    if (!isObj(params)) return undefined;
    // v1 is streaming-only: the provider hardcodes stream:true and the bare
    // JSONL response codec assumes it (WC-6).
    if (params.stream !== true) return undefined;
    if (typeof params.model !== "string" || params.model.length === 0) return undefined;
    const toolNames = new Map<string, string>();
    const errorResultIds = new Set<string>();
    const messages = convertMessages(params.messages, toolNames, errorResultIds);
    if (messages === undefined) return undefined;
    // The CLI system slot rides as the leading system message so the
    // pipeline (kernel, preflight, window) sees it; rewrap folds every
    // system message back into the single params.system slot.
    const outerSystem = typeof params.system === "string" ? params.system : "";
    if (outerSystem.length > 0) {
        const first = messages[0];
        if (first.role === "system" && typeof first.content === "string") {
            first.content = `${outerSystem}\n\n${first.content}`;
        } else {
            messages.unshift({ role: "system", content: outerSystem });
        }
    }
    if (!messages.some((m) => m.role !== "system")) return undefined;

    let tools: unknown = undefined;
    if (params.tools !== undefined) {
        if (!Array.isArray(params.tools)) return undefined;
        const converted: Array<Record<string, unknown>> = [];
        for (const t of params.tools) {
            if (!isObj(t) || t.type !== "function" || typeof t.name !== "string") return undefined;
            const fn: Record<string, unknown> = { name: t.name };
            if (typeof t.description === "string") fn.description = t.description;
            if (t.input_schema !== undefined) {
                if (!isObj(t.input_schema)) return undefined;
                fn.parameters = t.input_schema;
            }
            converted.push({ type: "function", function: fn });
        }
        tools = converted;
    }

    const KNOWN = new Set(["model", "messages", "tools", "system", "max_tokens", "temperature", "stream"]);
    const extraParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
        if (!KNOWN.has(k)) extraParams[k] = v;
    }
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
        if (k !== "params") rest[k] = v;
    }

    const body: Record<string, unknown> = { model: params.model, messages };
    if (tools !== undefined) body.tools = tools;
    if (typeof params.max_tokens === "number") body.max_tokens = params.max_tokens;
    if (typeof params.temperature === "number") body.temperature = params.temperature;
    Object.assign(body, extraParams);
    body.stream = true;

    const meta: CommandcodeEnvelopeMeta = {
        rest,
        systemText: typeof params.system === "string" ? params.system : "",
        hadSystem: typeof params.system === "string",
        maxTokens: typeof params.max_tokens === "number" ? params.max_tokens : undefined,
        temperature: typeof params.temperature === "number" ? params.temperature : undefined,
        reasoningEffort: typeof params.reasoning_effort === "string" ? params.reasoning_effort : undefined,
        extraParams,
        toolNames,
        errorResultIds,
    };
    return { body, meta };
}

function safeParseArgs(args: unknown): Record<string, unknown> {
    if (isObj(args)) return args;
    if (typeof args === "string") {
        try {
            const v = JSON.parse(args);
            if (isObj(v)) return v;
        } catch { /* malformed → {} (WC-4) */ }
    }
    return {};
}

/** Restore the CLI envelope around a (possibly rebuilt) flat OpenAI body.
 *  System-role messages are folded back into the single params.system slot
 *  (joined "\n\n"); every other message converts block-for-block. Roles this
 *  codec does not know (e.g. a compat-roles rewrite target) degrade to user
 *  text rather than dropping content mid-forward (WC-2). */
export function rewrapCommandcodeBody(flat: Record<string, unknown>, meta: CommandcodeEnvelopeMeta): Record<string, unknown> {
    const msgs = Array.isArray(flat.messages) ? flat.messages : [];
    const localNames = new Map<string, string>(meta.toolNames);
    const cc: Array<Record<string, unknown>> = [];
    const systems: string[] = [];
    for (const m of msgs) {
        if (!isObj(m)) continue;
        const role = m.role;
        if (role === "system") {
            if (typeof m.content === "string" && m.content.length > 0) systems.push(m.content);
            continue;
        }
        if (role === "user") {
            const text = typeof m.content === "string" ? m.content : "";
            cc.push({ role: "user", content: [{ type: "text", text }] });
            continue;
        }
        if (role === "assistant") {
            const blocks: Array<Record<string, unknown>> = [];
            if (typeof m.content === "string" && m.content.length > 0) blocks.push({ type: "text", text: m.content });
            if (typeof m.reasoning_content === "string" && m.reasoning_content.length > 0) {
                blocks.push({ type: "reasoning", text: m.reasoning_content });
            }
            const tcs = m.tool_calls;
            if (Array.isArray(tcs)) {
                for (const tc of tcs) {
                    if (!isObj(tc)) continue;
                    const fn = tc.function;
                    if (!isObj(fn) || typeof tc.id !== "string" || typeof fn.name !== "string") continue;
                    localNames.set(tc.id, fn.name);
                    blocks.push({ type: "tool-call", toolCallId: tc.id, toolName: fn.name, input: safeParseArgs(fn.arguments) });
                }
            }
            cc.push({ role: "assistant", content: blocks });
            continue;
        }
        if (role === "tool") {
            if (typeof m.tool_call_id === "string" && typeof m.content === "string") {
                cc.push({
                    role: "tool",
                    content: [{
                        type: "tool-result",
                        toolCallId: m.tool_call_id,
                        toolName: localNames.get(m.tool_call_id) ?? "unknown",
                        output: { type: meta.errorResultIds.has(m.tool_call_id) ? "error-text" : "text", value: m.content },
                    }],
                });
            }
            continue;
        }
        // Unknown role (compat-roles rewrite target we do not map): keep the
        // text as a user message instead of losing it (WC-2).
        if (typeof m.content === "string" && m.content.length > 0) {
            cc.push({ role: "user", content: [{ type: "text", text: m.content }] });
        }
    }

    const params: Record<string, unknown> = { model: flat.model, messages: cc };
    if (flat.tools !== undefined) {
        if (Array.isArray(flat.tools)) {
            const converted: Array<Record<string, unknown>> = [];
            for (const t of flat.tools) {
                if (!isObj(t) || t.type !== "function") continue;
                const fn = t.function;
                if (!isObj(fn) || typeof fn.name !== "string") continue;
                const out: Record<string, unknown> = { type: "function", name: fn.name };
                if (typeof fn.description === "string") out.description = fn.description;
                if (fn.parameters !== undefined) out.input_schema = fn.parameters;
                converted.push(out);
            }
            params.tools = converted;
        }
    }
    const systemText = systems.length > 0 ? systems.join("\n\n") : meta.hadSystem ? meta.systemText : "";
    if (systemText.length > 0 || meta.hadSystem) params.system = systemText;
    const maxTokens = typeof flat.max_tokens === "number" ? flat.max_tokens : meta.maxTokens;
    if (maxTokens !== undefined) params.max_tokens = maxTokens;
    const temperature = typeof flat.temperature === "number" ? flat.temperature : meta.temperature;
    if (temperature !== undefined) params.temperature = temperature;
    Object.assign(params, meta.extraParams);
    params.stream = true;

    return { ...meta.rest, params };
}
