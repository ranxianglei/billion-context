import { defaultCountTokens, type CoreMessage, type NudgeDecision } from "acp-kernel";
import { googleSystemText, type BiliMessage, type GoogleRequestBody } from "acp-kernel/wire";
import { estimateCoreMessages } from "../preflight.js";
import { applyEstimateCalibration } from "../util.js";
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

/** #2391: a budget view only; never forward this projection. OpenAI tool search
 * defers individual function schemas, while namespace descriptions stay visible.
 * https://developers.openai.com/api/docs/guides/tools-tool-search */
export function modelVisibleTools(tools: unknown): unknown {
    if (!Array.isArray(tools) || !tools.some((t) => t?.type === "tool_search")) return tools ?? [];
    const project = (tool: unknown): unknown => {
        if (!tool || typeof tool !== "object") return tool;
        const item = tool as Record<string, unknown>;
        if (item.type === "namespace" && Array.isArray(item.tools)) {
            return { ...item, tools: item.tools.map(project) };
        }
        if (item.type === "function" && typeof item.name === "string"
            && item.parameters && typeof item.parameters === "object"
            && !Array.isArray(item.parameters) && item.defer_loading === true) {
            return { type: item.type, name: item.name, defer_loading: true };
        }
        return tool;
    };
    return tools.map(project);
}

/** Loaded definitions count in full even if they still carry defer_loading. */
export function countLoadedToolTokens(body: Record<string, unknown>): number {
    if (!Array.isArray(body.input)) return 0;
    let tokens = 0;
    for (const item of body.input) {
        if (["additional_tools", "tool_search_call", "tool_search_output", "mcp_list_tools"].includes(item?.type)) {
            tokens += defaultCountTokens(JSON.stringify(item));
        }
    }
    return tokens;
}

/** chars/4 measure of the per-request overhead that lives OUTSIDE the kernel's
 *  fold space: the outbound system prompt (client text plus bili-injected parts)
 *  and the tool schemas. The kernel's contextBreakdown classifies messages only,
 *  so this is what the status panel's SysPrompt row must add back (#532). Same
 *  counting method as estimateInputTokens below. */
export function countSystemAndToolsTokens(systemText: string | undefined, tools: unknown): number {
    return defaultCountTokens(systemText ?? "") + defaultCountTokens(JSON.stringify(modelVisibleTools(tools)));
}

/** Conservative outbound-input estimate: the larger of the upstream-reported
 *  previous-turn input (real tokenizer count, already includes system+tools) and
 *  a fresh count of the rebuilt conversation text + system + tool definitions
 *  (needed on turn 1 / right after a shrink, when lastInputTokens lags).
 *  #1492: the reported baseline floors only when it is usage-grade — an
 *  estimate-grade baseline (raw-view poison from a transform-failure fallback
 *  arm) would mask the payload's own est through the max() and silently skip
 *  the #453 clamp (fail-open) while the poison persists.
 *  #2122: the LOCAL side is scaled by the per-route estimator calibration k̂
 *  (#1933 F1) before the max() — hosts/upstreams whose provider rendering runs
 *  below bili's local view (e.g. DSH web mode with --no-reasoning-preserve:
 *  raw chars/4 est ~137K vs provider-billed ~81K) used to win the max() raw
 *  and starve the output clamp (32768 -> 3357 with ample actual headroom).
 *  The usage-grade baseline is already provider-measured and is NEVER scaled. */
export function estimateInputTokens(processedMessages: CoreMessage[], systemText: string | undefined, tools: unknown, lastInputTokens: number, lastInputTokensSource?: string, kFactor?: number, kOrigin?: string, origin?: string, loadedToolTokens = 0): number {
    const est = applyEstimateCalibration(estimateCoreMessages(processedMessages) + countSystemAndToolsTokens(systemText, tools) + loadedToolTokens, kFactor, kOrigin, origin);
    const baseline = lastInputTokens > 0 && lastInputTokensSource === "usage" ? lastInputTokens : 0;
    return Math.max(baseline, est);
}

// #1320: Claude Code round-trips extended-thinking blocks as SIGNATURE-ONLY
// entries ({type:"thinking", signature} with no visible text). The provider
// restores and bills the underlying thinking tokens server-side, so its
// usage.input_tokens is correct — but locally the blocks convert to empty-text
// reasoning messages and every per-message meter (nudge compressible mass,
// block compressedTokens receipts, context breakdown) understates billed
// context by the entire thinking share: savings receipts report "~17k saved"
// when ~41k left the billing, and the growth nudge stays idle because the
// compressible mass never crosses the 50K threshold.
//
// Fix at the decision point, not a payload mask: attribute the unexplained
// residual between the provider-measured input total and the local estimate of
// everything else we can see (visible message text + system/tools overhead +
// images) to the signature-only reasoning messages, weighted by signature
// length, via the kernel's host-projected CoreMessage.thinkingTokens seam —
// countMessageTokens counts it at every metering site, so nudge mass,
// receipts, tags, and gauges all pick it up without further changes. Metering-
// only by construction: the wire bytes are untouched (coreToAnthropic already
// round-trips the signature faithfully), and no attribution happens unless a
// real usage report AND at least one signed thinking block exist, so sessions
// without hidden thinking are byte-for-byte unaffected.
export interface ThinkingMassInput {
    /** Provider-measured previous-turn input total (session.stats.lastInputTokens). */
    providerInputTokens: number;
    /** True only for "usage"-provenance totals. Local estimates already exclude
     *  thinking by construction; projecting onto them would double-count. */
    measured: boolean;
    systemText: string | undefined;
    tools: unknown;
    imageTokens: number;
    /** Previous turn's outbound system+tools overhead as measured at prepare
     *  time (session.metadata.systemPromptTokens) — preferred over recounting
     *  the inbound body because it captures the proxy-injected ACP content that
     *  was actually billed last turn. Ignored when not a positive finite number. */
    storedOverhead?: number;
}

/** Project the hidden thinking mass onto signature-only reasoning messages.
 *  Returns the total tokens projected (0 = nothing to do). Deterministic for a
 *  given (messages, inputs) pair; the shares sum exactly to the gap (floors go
 *  to earlier targets, remainder to the last one). */
export function projectThinkingMass(msgs: BiliMessage[], input: ThinkingMassInput): number {
    if (!input.measured || !(input.providerInputTokens > 0)) return 0;
    const targets: Array<{ msg: BiliMessage; sig: number }> = [];
    for (const m of msgs) {
        if (m.contentType !== "reasoning") continue;
        if (typeof m.thinkingSignature !== "string" || m.thinkingSignature.length === 0) continue;
        // Visible thinking text is already counted in the local estimate; only
        // signature-only blocks hide mass the estimator cannot see.
        if (typeof m.text === "string" && m.text.trim().length > 0) continue;
        targets.push({ msg: m, sig: m.thinkingSignature.length });
    }
    if (targets.length === 0) return 0;
    const overhead = typeof input.storedOverhead === "number" && Number.isFinite(input.storedOverhead) && input.storedOverhead > 0
        ? input.storedOverhead
        : countSystemAndToolsTokens(input.systemText, input.tools);
    const gap = Math.max(0, input.providerInputTokens - estimateCoreMessages(msgs) - overhead - Math.max(0, input.imageTokens));
    if (gap <= 0) return 0;
    const totalSig = targets.reduce((s, t) => s + t.sig, 0);
    let assigned = 0;
    for (let i = 0; i < targets.length; i++) {
        const t = targets[i]!;
        const share = i === targets.length - 1 ? gap - assigned : Math.floor((gap * t.sig) / totalSig);
        t.msg.thinkingTokens = share;
        assigned += share;
    }
    return gap;
}

/** #470: tokens the wire payload carries OUTSIDE the message array —
 * system/instructions text and tool definitions (including the proxy-injected
 * ACP tools). estimateCoreMessages only counts messages, so without this term
 * the preflight trigger fires ~10-20K late on agent clients with big tool
 * manifests: text alone "fits" while the real billed input already overflows
 * the window. Same term estimateInputTokens applies to the output clamp (#467). */
export function estimateWireOverhead(protocol: "anthropic" | "openai" | "responses" | "google", body: string | Buffer | Record<string, unknown>): number {
    let parsed: Record<string, unknown>;
    if (typeof body === "object" && !Buffer.isBuffer(body)) {
        parsed = body;
    } else {
        try {
            parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
        } catch {
            return 0;
        }
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
    return defaultCountTokens(sysText)
        + defaultCountTokens(JSON.stringify(protocol === "responses" ? modelVisibleTools(parsed.tools) : parsed.tools ?? []))
        + (protocol === "responses" ? countLoadedToolTokens(parsed) : 0);
}

/** Output-budget cap so input+output <= window. Returns the clamped budget, or
 *  undefined when no reduction is needed (requested already fits, or the cap
 *  drops below OUTPUT_CLAMP_FLOOR — i.e. input alone nearly fills the window,
 *  which is preflight/self-heal territory, not output starvation). */
export function clampOutputBudget(requested: number, inputEstimate: number, nativeWindow: number): number | undefined {
    const margin = Math.max(OUTPUT_CLAMP_MIN_MARGIN, Math.ceil(inputEstimate * OUTPUT_CLAMP_MARGIN_PCT));
    // #2011: max_tokens / max_completion_tokens / max_output_tokens are integer-typed on every
    // wire protocol. Since v0.1.181 inputEstimate can carry a fraction: #1843 L1's learned
    // per-route image cost (learnedImageReserve in cache-ledger.ts — an EMA over
    // observed/nImages usage samples) takes precedence over the integer pixel/byte priors
    // (#488) when fresh matching evidence exists, which made this cap fractional and strict
    // upstreams rejected the whole turn with `max_tokens: Input should be a valid integer`.
    // Floor at the decision point so the emitted budget is always an integer (floor <= exact
    // headroom, so input+output <= window still holds).
    const cap = Math.floor(nativeWindow - inputEstimate - margin);
    if (cap < OUTPUT_CLAMP_FLOOR || cap >= requested) return undefined;
    return cap;
}

// Only override genuine cadence silences — never the kernel's deliberate
// "nothing worth offering" suppressions. #2104: that includes the NON-empty
// kind: decideNudge suppresses while compressibleRanges still carries the raw
// list (reason "max compressible < threshold" / "max pending < min benefit" —
// every range below minCompressRange). "List non-empty" used to read as
// "worth advertising", so past the escalation line the override injected a
// nudge whose range list compress would atomically reject — the
// nudge-vs-compress/acp_status contradiction of #2104, which fed a
// compress-loop (4 rejected/burned calls in 9 steps). Gate the override on
// the SAME submit gate compress applies — tokens >= minCompressRange (#847,
// the postCompressTail/handleAcpStatus filter, mirroring the kernel's own
// pendingByTier expression): the emergency line may only advertise ranges
// that are executable. minCompressRange 0 (default) preserves the legacy
// any-non-empty-list semantics for direct callers.
export function emergencyNudge(nudge: NudgeDecision | null | undefined, escalationPct: number = EMERGENCY_NUDGE_ESCALATION_PCT, minCompressRange: number = 0): boolean {
    if (!nudge || nudge.shouldInject) return false;
    if (nudge.contextUsage < escalationPct) return false;
    return nudge.compressibleRanges.some((r) => minCompressRange <= 0 || r.tokens >= minCompressRange);
}

export function clampOutgoingOutput(
    rebuilt: Record<string, unknown>,
    field: OutputBudgetField,
    ctx: { systemText: string; tools: unknown; processedMessages: CoreMessage[]; lastInputTokens: number; lastInputTokensSource?: string; nativeWindow: number; imageTokens: number; /** #2096: the headroom-adjusted window nudge/preflight enforce
     *  (nativeWindow minus the output reservation). LOG HONESTY ONLY — the cap is
     *  deliberately computed against nativeWindow (the true upstream constraint
     *  input+out <= window), never against this one: when max_tokens > 25% of the
     *  window the overflow boundary lies BELOW the headroom target, so capping
      *  against it would no-op exactly when post-compression turns need the
      *  guarantee most (#453). */ headroomWindow?: number;
     /** #2122/#1933 F1: per-route estimator calibration — scales the local-est
      *  side of estimateInputTokens so the clamp judges the payload on the same
      *  provider-billed scale as preflight/nudge. Absent → legacy raw behavior. */ kFactor?: number; kOrigin?: string; origin?: string },
    sessionId: string,
    log: (level: string, msg: string) => void,
): void {
    const raw = readOutputBudget(rebuilt, field);
    if (typeof raw !== "number") return;
    // #488: images ride along in the rebuilt body but are invisible to the text model —
    // without them the cap is too generous and input+output can still overflow.
    const loadedToolTokens = field === "max_output_tokens" ? countLoadedToolTokens(rebuilt) : 0;
    const inputEstimate = estimateInputTokens(ctx.processedMessages, ctx.systemText, ctx.tools, ctx.lastInputTokens, ctx.lastInputTokensSource, ctx.kFactor, ctx.kOrigin, ctx.origin, loadedToolTokens) + ctx.imageTokens;
    const capped = clampOutputBudget(raw, inputEstimate, ctx.nativeWindow);
    if (capped !== undefined) {
        writeOutputBudget(rebuilt, field, capped);
        // #2096: in the band (headroom target, native window) the clamp can only
        // guarantee native-window fit — preflight/compression is what can pull
        // the input back under the enforced target. Say so instead of advertising
        // rescue right before the turn dies.
        const overTarget = ctx.headroomWindow !== undefined && ctx.headroomWindow < ctx.nativeWindow && inputEstimate >= ctx.headroomWindow;
        log("info", `[${sessionId}] output budget clamped ${raw} -> ${capped} (input~${inputEstimate}, window=${ctx.nativeWindow}); prevents input+output overflow (#453)${overTarget ? `; input already exceeds the headroom-adjusted target ~${ctx.headroomWindow} that nudge/preflight enforce — only compression can recover it, this clamp guarantees native-window fit only (#2096)` : ""}`);
    }
}
