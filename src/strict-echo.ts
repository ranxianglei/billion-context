import type { Session } from "./session.js";
import type { OpenAIMessage, ResponseInputItem } from "acp-kernel/wire";
import type { Logger } from "./logger.js";

/** [#684] Strict-echo reasoning upstreams: DeepSeek documents that
 *  thinking-mode "reasoning_content ... must be passed back to the API" —
 *  a rebuilt request whose assistant tool-call turns lost their reasoning is
 *  rejected with 400. Learned flag first (set on first 400 whose body mentions
 *  reasoning_content or reasoning_text — the Responses wire spells it
 *  reasoning_text, #2169 — see the loop's UpstreamHttpError handler), then static
 *  detection: the upstream origin OR the request's own model id (#1027 —
 *  DeepSeek models served from non-deepseek gateways never trip the host
 *  check, so every fresh session re-paid the 400 through the learned flag). */
export function isStrictReasoningEcho(session: Session, upstreamOrigin: string | undefined, model?: string): boolean {
    if (session.metadata.strictReasoningEcho === true) return true;
    if (upstreamOrigin !== undefined && /deepseek/i.test(upstreamOrigin)) return true;
    return typeof model === "string" && model.length > 0 && /deepseek/i.test(model);
}

/** [#1027] The request body's model id for the static strict-echo criterion
 *  (undefined when absent or not a string). */
export function modelIdOf(body: { model?: unknown } | null | undefined): string | undefined {
    const m = body?.model;
    return typeof m === "string" ? m : undefined;
}

/** [#762] Strict-echo normalization: DeepSeek thinking mode accepts a BLANK
 *  reasoning_content echo but rejects an ABSENT field on assistant tool-call
 *  turns ("reasoning_content ... must be passed back"). The kernel round-trip
 *  drops blank echoes (an empty string carries no core message), so any
 *  rebuild can ship absent fields into a thinking session — the residual 400
 *  of #762. Inject "" on assistant tool-call messages lacking the field so the
 *  rejection class cannot reach the wire; hermes-agent PR #15527 (openclaw
 *  #71455) confirms DeepSeek accepts the blank form. Returns the input array
 *  unchanged when disabled or when nothing needed patching. */
export function normalizeStrictEchoReasoning(
    messages: OpenAIMessage[],
    enabled: boolean,
    log: Logger,
    sessionId: string,
): OpenAIMessage[] {
    if (!enabled) return messages;
    let patched = 0;
    const out = messages.map((m) => {
        if (m.role !== "assistant") return m;
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return m;
        if (typeof m.reasoning_content === "string") return m;
        patched++;
        return { ...m, reasoning_content: "" };
    });
    if (patched > 0) {
        log("info", `[${sessionId}] strict-echo: injected blank reasoning_content on ${patched} assistant tool-call message(s) (#762)`);
    }
    return patched > 0 ? out : messages;
}

/** [#2169] A reasoning item whose `content` array consists EXCLUSIVELY of
 *  whitespace-only `reasoning_text` parts — a blank echo that strict-echo
 *  upstreams (DeepSeek thinking mode) reject with "reasoning_text must be passed
 *  back": their validation accepts content-less / summary-only items but rejects
 *  ANY content they did not issue, whitespace included (replacing the blank text
 *  with real text still 400s — #2169 control experiments). Whitespace carries no
 *  information, so clearing is lossless. Conservative by design: a missing or
 *  non-array content, an empty array, any non-reasoning_text part, any
 *  non-string text, or one part with real text all leave the item untouched. */
function hasBlankReasoningContent(item: ResponseInputItem): boolean {
    if ((item as { type?: unknown }).type !== "reasoning") return false;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length === 0) return false;
    let sawTextPart = false;
    for (const part of content) {
        if (part === null || typeof part !== "object") return false;
        const p = part as { type?: unknown; text?: unknown };
        if (p.type !== "reasoning_text" || typeof p.text !== "string") return false;
        sawTextPart = true;
        if (p.text.trim().length > 0) return false;
    }
    return sawTextPart;
}

/** [#1479,#2169] Responses-wire twin of [#762]: a strict-echo gateway rejects an
 *  assistant RUN (maximal consecutive stretch of reasoning / assistant message
 *  / function_call / custom_tool_call items) that carries a tool call but no
 *  reasoning item. Fold + kernel round-trip leave exactly that shape (the turn's
 *  echo dies inside its fold range while a sibling call survives), and no
 *  Responses equivalent of normalizeStrictEchoReasoning existed — the #762
 *  repair only ever ran on chat-completions messages. Insert one blank reasoning
 *  item at the start of each orphaned run; blank is what DeepSeek thinking mode
 *  accepts (hermes-agent PR #15527). Second duty (#2169): clear the `content` of
 *  reasoning items whose content is whitespace-only reasoning_text — such items
 *  ride the client's resent history into the request (bili never fabricates them:
 *  the kernel round-trip re-emits raw items verbatim) and are rejected on the
 *  wire as-is. Gated on at least one reasoning item existing anywhere in the
 *  input so non-thinking sessions are never touched. Returns the input array
 *  unchanged when disabled or nothing needed patching. */
export function normalizeStrictEchoResponsesInput(
    input: ResponseInputItem[],
    enabled: boolean,
    log: Logger,
    sessionId: string,
): ResponseInputItem[] {
    if (!enabled) return input;
    let hasReasoning = false;
    for (const it of input) {
        if ((it as { type?: unknown })?.type === "reasoning") { hasReasoning = true; break; }
    }
    if (!hasReasoning) return input;
    const insertAt = new Set<number>();
    let runStart = -1;
    let runCalls = 0;
    let runReasoning = 0;
    const closeRun = (): void => {
        if (runStart >= 0 && runCalls > 0 && runReasoning === 0) insertAt.add(runStart);
        runStart = -1;
        runCalls = 0;
        runReasoning = 0;
    };
    for (let i = 0; i < input.length; i++) {
        const it = input[i] as { type?: unknown; role?: unknown } | undefined;
        const t = typeof it?.type === "string" ? it.type : undefined;
        // a call's output belongs to the same assistant turn as the call
        const inRun = t === "reasoning" || t === "function_call" || t === "custom_tool_call" || t === "function_call_output" || t === "custom_tool_call_output" || (t === "message" && it?.role === "assistant");
        if (!inRun) { closeRun(); continue; }
        if (runStart < 0) runStart = i;
        if (t === "function_call" || t === "custom_tool_call") runCalls++;
        else if (t === "reasoning") runReasoning++;
    }
    closeRun();
    const clearAt = new Set<number>();
    for (let i = 0; i < input.length; i++) {
        if (hasBlankReasoningContent(input[i]!)) clearAt.add(i);
    }
    if (insertAt.size === 0 && clearAt.size === 0) return input;
    const out: ResponseInputItem[] = [];
    for (let i = 0; i < input.length; i++) {
        if (insertAt.has(i)) out.push({ type: "reasoning", summary: [{ type: "summary_text", text: "" }] });
        if (clearAt.has(i)) {
            const copy: Record<string, unknown> = { ...(input[i]! as Record<string, unknown>) };
            delete copy.content;
            out.push(copy as ResponseInputItem);
        } else {
            out.push(input[i]!);
        }
    }
    if (clearAt.size > 0) log("info", `[${sessionId}] strict-echo-responses: cleared whitespace-only reasoning content on ${clearAt.size} item(s) — blank reasoning_text echoes are rejected by strict-echo upstreams (#2169)`);
    if (insertAt.size > 0) log("info", `[${sessionId}] strict-echo-responses: injected ${insertAt.size} blank reasoning item(s) before tool-call run(s) missing their echo (#1479)`);
    return out;
}

/** [#762,#1479] Body-level twin for outbound paths that build the body WITHOUT
 *  going through prepareOpenai/prepareResponses (the compress-loop re-request,
 *  src/loop/core.ts): the main-path repairs never see those bodies. Handles BOTH
 *  wire shapes — chat-completions `messages[]` and Responses `input[]`. Returns
 *  the same body object when disabled or when nothing needed patching. */
export function normalizeStrictEchoBody(
    body: Record<string, unknown>,
    enabled: boolean,
    log: Logger,
    sessionId: string,
): Record<string, unknown> {
    if (!enabled) return body;
    let out = body;
    if (Array.isArray(body.messages)) {
        const patched = normalizeStrictEchoReasoning(body.messages as OpenAIMessage[], true, log, sessionId);
        if (patched !== body.messages) out = { ...out, messages: patched };
    }
    if (Array.isArray(body.input)) {
        const patched = normalizeStrictEchoResponsesInput(body.input as ResponseInputItem[], true, log, sessionId);
        if (patched !== body.input) out = { ...out, input: patched };
    }
    return out;
}
