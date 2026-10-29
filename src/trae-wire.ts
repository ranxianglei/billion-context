// #1295: codec for the TRAE SOLO wire family — an openai-completions
// conversation inside a Trae IDE envelope (\`function: "solo_agent"\`, model id
// echoed in \`config_name\`, Max mode expressed purely in the body through
// \`mode_type\` / \`context_window_size\` / \`prompt_max_tokens\`). Messages differ
// from OpenAI in four places: content is always an array of text parts (tool
// results included), tool calls rename the payload key \`function\` →
// \`function_call\`, and an assistant turn that carries tool calls sets
// \`content: null\`. unwrap turns one into a flat OpenAI chat body so the
// standard pipeline (kernel, preflight, window resolution, session binding)
// runs unchanged; rewrap restores the envelope at the final forward boundary.
//
// Strict fidelity (#1284 precedent): ANY shape this codec cannot convert is
// rejected (undefined) and the caller relays the original bytes verbatim —
// never a partial conversion. See WIRE-CONTRACTS.md (WC-12*).

export interface TraeEnvelopeMeta {
    /** The original request body, verbatim. Every envelope key the flat body
     *  cannot carry (\`function\`, \`config_name\`, \`mode_type\`, planner limits,
     *  auto-selection blocks) is replayed from here on rewrap. */
    envelope: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Trae text parts → plain string. Returns undefined for any non-text part
 *  (image/audio payloads this codec does not re-encode). */
function partsToText(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const p of content) {
        if (!isObj(p) || p.type !== "text" || typeof p.text !== "string") return undefined;
        parts.push(p.text as string);
    }
    return parts.join("\n");
}

function textToParts(text: string): Array<Record<string, unknown>> {
    return [{ type: "text", text }];
}

function convertToolCalls(raw: unknown): Array<Record<string, unknown>> | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: Array<Record<string, unknown>> = [];
    for (const c of raw) {
        if (!isObj(c)) return undefined;
        if (typeof c.id !== "string") return undefined;
        const fn = isObj(c.function_call) ? c["function_call"] : isObj(c.function) ? c.function : undefined;
        if (fn === undefined) return undefined;
        if (typeof fn.name !== "string" || fn.name.length === 0) return undefined;
        let args = "";
        if (typeof fn.arguments === "string") {
            args = fn.arguments;
        } else if (fn.arguments !== undefined) {
            args = JSON.stringify(fn.arguments);
        }
        out.push({ id: c.id, type: "function", function: { name: fn.name, arguments: args } });
    }
    return out;
}

function convertMessages(messages: unknown): Array<Record<string, unknown>> | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const out: Array<Record<string, unknown>> = [];
    for (const m of messages) {
        if (!isObj(m)) return undefined;
        const role = m.role;
        if (role === "system" || role === "user") {
            const text = partsToText(m.content);
            if (text === undefined) return undefined;
            if (text.length === 0 && role === "system") continue;
            out.push({ role, content: text });
            continue;
        }
        if (role === "assistant") {
            const hasContent = m.content !== null && m.content !== undefined;
            const text = hasContent ? partsToText(m.content) : undefined;
            if (hasContent && text === undefined) return undefined;
            const msg: Record<string, unknown> = { role: "assistant", content: text === undefined ? null : text };
            if (m.reasoning_content !== undefined && typeof m.reasoning_content === "string" && m.reasoning_content.length > 0) {
                msg.reasoning_content = m.reasoning_content;
            }
            if (m.tool_calls !== undefined) {
                const calls = convertToolCalls(m.tool_calls);
                if (calls === undefined) return undefined;
                if (calls.length > 0) msg.tool_calls = calls;
            }
            if (msg.content === null && msg.tool_calls === undefined) continue;
            out.push(msg);
            continue;
        }
        if (role === "tool") {
            if (typeof m.tool_call_id !== "string") return undefined;
            const text = partsToText(m.content);
            if (text === undefined) return undefined;
            out.push({ role: "tool", tool_call_id: m.tool_call_id, content: text });
            continue;
        }
        return undefined;
    }
    return out.length > 0 ? out : undefined;
}

/** Convert a parsed Trae body to a flat OpenAI chat body. Returns undefined
 *  when the body is not a convertible streaming Trae conversation — the caller
 *  relays the original bytes verbatim. */
export function unwrapTraeBody(parsed: Record<string, unknown>): { body: Record<string, unknown>; meta: TraeEnvelopeMeta } | undefined {
    // v1 is streaming-only: the endpoint always answers an SSE dialect and the
    // response codec assumes it (WC-12c).
    if (parsed.stream !== true) return undefined;
    if (typeof parsed.model !== "string" || parsed.model.length === 0) return undefined;
    const messages = convertMessages(parsed.messages);
    if (messages === undefined) return undefined;

    const body: Record<string, unknown> = { model: parsed.model, messages };
    if (parsed.tools !== undefined) {
        if (!Array.isArray(parsed.tools)) return undefined;
        body.tools = parsed.tools;
    }
    if (typeof parsed.tool_choice === "string" || isObj(parsed.tool_choice)) body.tool_choice = parsed.tool_choice;
    if (typeof parsed.max_tokens === "number") body.max_tokens = parsed.max_tokens;
    if (typeof parsed.temperature === "number") body.temperature = parsed.temperature;
    if (typeof parsed.top_p === "number") body.top_p = parsed.top_p;
    if (parsed.stop !== undefined) body.stop = parsed.stop;
    if (typeof parsed.reasoning_effort === "string") body.reasoning_effort = parsed.reasoning_effort;
    if (typeof parsed.parallel_tool_calls === "boolean") body.parallel_tool_calls = parsed.parallel_tool_calls;
    body.stream = true;

    return { body, meta: { envelope: { ...parsed } } };
}

function messageToTrae(m: Record<string, unknown>): Record<string, unknown> | undefined {
    const role = m.role;
    if (role === "system" || role === "user" || role === "tool") {
        const text = typeof m.content === "string" ? m.content : m.content === null || m.content === undefined ? "" : undefined;
        if (text === undefined) return undefined;
        const msg: Record<string, unknown> = { role, content: textToParts(text) };
        if (role === "tool" && typeof m.tool_call_id === "string") msg.tool_call_id = m.tool_call_id;
        return msg;
    }
    if (role === "assistant") {
        const calls = m.tool_calls === undefined ? undefined : convertToolCalls(m.tool_calls);
        const text = typeof m.content === "string" ? m.content : undefined;
        if (m.content !== null && m.content !== undefined && text === undefined) return undefined;
        const msg: Record<string, unknown> = {
            role: "assistant",
            content: calls !== undefined && calls.length > 0 && (text === undefined || text.length === 0) ? null : textToParts(text ?? ""),
        };
        if (calls !== undefined && calls.length > 0) {
            msg.tool_calls = calls.map((c) => ({
                id: c.id,
                type: "function",
                function_call: (c.function as Record<string, unknown>),
            }));
        }
        if (typeof m.reasoning_content === "string" && m.reasoning_content.length > 0) msg.reasoning_content = m.reasoning_content;
        return msg;
    }
    // Compat-roles rewrites can target roles this wire has no slot for; degrade
    // to user text rather than dropping content mid-forward (WC-12d).
    if (typeof m.content === "string") return { role: "user", content: textToParts(m.content) };
    return undefined;
}

/** Restore the Trae envelope around a (possibly rebuilt) flat OpenAI body.
 *  Envelope keys the flat body does not own are replayed verbatim from meta. */
export function rewrapTraeBody(flat: Record<string, unknown>, meta: TraeEnvelopeMeta): Record<string, unknown> {
    const msgs = Array.isArray(flat.messages) ? flat.messages : [];
    const converted: Array<Record<string, unknown>> = [];
    for (const m of msgs) {
        if (!isObj(m)) continue;
        const next = messageToTrae(m);
        if (next !== undefined) converted.push(next);
    }
    const body: Record<string, unknown> = { ...meta.envelope };
    body.messages = converted;
    if (typeof flat.model === "string") body.model = flat.model;
    if (flat.tools !== undefined) body.tools = flat.tools; else delete body.tools;
    if (flat.tool_choice !== undefined) body.tool_choice = flat.tool_choice; else delete body.tool_choice;
    if (typeof flat.max_tokens === "number") body.max_tokens = flat.max_tokens;
    if (typeof flat.temperature === "number") body.temperature = flat.temperature;
    if (typeof flat.top_p === "number") body.top_p = flat.top_p;
    if (flat.stop !== undefined) body.stop = flat.stop;
    if (typeof flat.reasoning_effort === "string") body.reasoning_effort = flat.reasoning_effort;
    if (typeof flat.parallel_tool_calls === "boolean") body.parallel_tool_calls = flat.parallel_tool_calls;
    body.stream = true;
    return body;
}
