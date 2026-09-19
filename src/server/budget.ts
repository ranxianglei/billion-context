import { defaultCountTokens, type CoreMessage, type NudgeDecision } from "acp-kernel";
import { googleSystemText, type GoogleRequestBody } from "acp-kernel/wire";
import { estimateCoreMessages } from "../preflight.js";
import { readOutputBudget, writeOutputBudget, type OutputBudgetField } from "./side-request.js";

// #453 hard backstop: cap the forwarded output budget so input+output can never
// exceed the window on request-rebuilding upstreams (vLLM rejects an oversized
// total instead of clamping). Non-Anthropic only — Anthropic enforces its input
// limit independently of max_tokens (see shouldReserveOutputHeadroom). The proxy
// owns both sides of the sum, so capping output to (window - input - margin)
// makes the overflow impossible even when the agent ignores the compress nudge.
const OUTPUT_CLAMP_MARGIN_PCT = 0.05;
const OUTPUT_CLAMP_MIN_MARGIN = 2048;
const OUTPUT_CLAMP_FLOOR = 1024;
// #453 mitigation: host-side escalation line. The kernel already force-injects
// every turn once usage >= nudge.maxContextLimitPct (its pressure branch has no
// cadence gate), so the only cadence-silent zone is BELOW that line. Force the
// nudge each turn once usage reaches this — kept under the default 0.75
// over-limit line so it fills the pre-limit silent climb seen in #453/#14. Pure
// host-side: renderNudgeText does not depend on shouldInject.
const EMERGENCY_NUDGE_ESCALATION_PCT = 0.7;

/** chars/4 measure of the per-request overhead that lives OUTSIDE the kernel's
 *  fold space: the outbound system prompt (client text plus bili-injected parts)
 *  and the tool schemas. The kernel's contextBreakdown classifies messages only,
 *  so this is what the status panel's SysPrompt row must add back (#532). Same
 *  counting method as estimateInputTokens below. */
export function countSystemAndToolsTokens(systemText: string | undefined, tools: unknown): number {
    return defaultCountTokens(systemText ?? "") + defaultCountTokens(JSON.stringify(tools ?? []));
}

/** Conservative outbound-input estimate: the larger of the upstream-reported
 *  previous-turn input (real tokenizer count, already includes system+tools) and
 *  a fresh count of the rebuilt conversation text + system + tool definitions
 *  (needed on turn 1 / right after a shrink, when lastInputTokens lags). */
export function estimateInputTokens(processedMessages: CoreMessage[], systemText: string | undefined, tools: unknown, lastInputTokens: number): number {
    const est = estimateCoreMessages(processedMessages) + countSystemAndToolsTokens(systemText, tools);
    return Math.max(lastInputTokens > 0 ? lastInputTokens : 0, est);
}

/** #470: tokens the wire payload carries OUTSIDE the message array —
 * system/instructions text and tool definitions (including the proxy-injected
 * ACP tools). estimateCoreMessages only counts messages, so without this term
 * the preflight trigger fires ~10-20K late on agent clients with big tool
 * manifests: text alone "fits" while the real billed input already overflows
 * the window. Same term estimateInputTokens applies to the output clamp (#467). */
export function estimateWireOverhead(protocol: "anthropic" | "openai" | "responses" | "google", body: string | Buffer): number {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
    } catch {
        return 0;
    }
    const sysRaw = protocol === "responses"
        ? parsed.instructions
        : protocol === "google"
          ? googleSystemText(parsed as GoogleRequestBody)
          : parsed.system;
    let sysText = "";
    if (typeof sysRaw === "string") {
        sysText = sysRaw;
    } else if (Array.isArray(sysRaw)) {
        sysText = sysRaw
            .map((part) => (typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : ""))
            .join("\n");
    }
    // openai chat: the kernel hoists leading system/developer messages out of
    // the array into the rebuilt body's system field — but raw clients that
    // never went through a rebuild keep them in messages; count both shapes.
    if (protocol === "openai" && Array.isArray(parsed.messages)) {
        const hoisted = (parsed.messages as Array<Record<string, unknown>>)
            .filter((m) => m.role === "system" || m.role === "developer")
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join("\n");
        sysText = sysText ? `${sysText}\n${hoisted}` : hoisted;
    }
    // responses: codex sends its whole system prompt as role=developer items
    // inside input[] (top-level instructions stays empty). The kernel hoists
    // those out of the counted message view (projection.systemParts) and the
    // rebuild moves them back into input[] as a developer message while
    // stripping instructions — so the whole system prompt is invisible to
    // estimateCoreMessages AND to the instructions-only read above (#829).
    // Count the developer/system items in input[] (mirrors the openai branch);
    // content may be a plain string or an array of input_text/output_text parts.
    if (protocol === "responses" && Array.isArray(parsed.input)) {
        const hoisted = (parsed.input as Array<Record<string, unknown>>)
            .filter((item) => item.role === "system" || item.role === "developer")
            .map((item) => {
                const c = item.content;
                if (typeof c === "string") return c;
                if (Array.isArray(c)) {
                    return c
                        .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
                        .join("\n");
                }
                return "";
            })
            .filter((t) => t.length > 0)
            .join("\n");
        if (hoisted) sysText = sysText ? `${sysText}\n${hoisted}` : hoisted;
    }
    return defaultCountTokens(sysText) + defaultCountTokens(JSON.stringify(parsed.tools ?? []));
}

/** Output-budget cap so input+output <= window. Returns the clamped budget, or
 *  undefined when no reduction is needed (requested already fits, or the cap
 *  drops below OUTPUT_CLAMP_FLOOR — i.e. input alone nearly fills the window,
 *  which is preflight/self-heal territory, not output starvation). */
export function clampOutputBudget(requested: number, inputEstimate: number, nativeWindow: number): number | undefined {
    const margin = Math.max(OUTPUT_CLAMP_MIN_MARGIN, Math.ceil(inputEstimate * OUTPUT_CLAMP_MARGIN_PCT));
    const cap = nativeWindow - inputEstimate - margin;
    if (cap < OUTPUT_CLAMP_FLOOR || cap >= requested) return undefined;
    return cap;
}

// Only override genuine cadence silences: skip the kernel's deliberate
// "nothing compressible to offer" suppression (empty ranges).
export function emergencyNudge(nudge: NudgeDecision | null | undefined, escalationPct: number = EMERGENCY_NUDGE_ESCALATION_PCT): boolean {
    if (!nudge || nudge.shouldInject) return false;
    if (nudge.compressibleRanges.length === 0) return false;
    return nudge.contextUsage >= escalationPct;
}

export function clampOutgoingOutput(
    rebuilt: Record<string, unknown>,
    field: OutputBudgetField,
    ctx: { systemText: string; tools: unknown; processedMessages: CoreMessage[]; lastInputTokens: number; nativeWindow: number; imageTokens: number },
    sessionId: string,
    log: (level: string, msg: string) => void,
): void {
    const raw = readOutputBudget(rebuilt, field);
    if (typeof raw !== "number") return;
    // #488: images ride along in the rebuilt body but are invisible to the text model —
    // without them the cap is too generous and input+output can still overflow.
    const inputEstimate = estimateInputTokens(ctx.processedMessages, ctx.systemText, ctx.tools, ctx.lastInputTokens) + ctx.imageTokens;
    const capped = clampOutputBudget(raw, inputEstimate, ctx.nativeWindow);
    if (capped !== undefined) {
        writeOutputBudget(rebuilt, field, capped);
        log("info", `[${sessionId}] output budget clamped ${raw} -> ${capped} (input~${inputEstimate}, window=${ctx.nativeWindow}); prevents input+output overflow (#453)`);
    }
}
