import { defaultCountTokens, type CoreMessage, type NudgeDecision } from "acp-kernel";
import { googleSystemText, type BiliMessage, type GoogleRequestBody } from "acp-kernel/wire";
import { estimateCoreMessages } from "../preflight.js";
import { SELF_HEAL_SUPPRESS_CAP_MS, reductionKeyOf } from "../session-self-heal.js";
import type { Session } from "../session.js";
import { applyEstimateCalibration } from "../util.js";
import { readOutputBudget, writeOutputBudget, type OutputBudgetField } from "./side-request.js";

export { readOutputBudget };

// #453 hard backstop: cap the forwarded output budget so input+output can never
// exceed the window on request-rebuilding upstreams (vLLM rejects an oversized
// total instead of clamping). Wired into the openai/responses/google prepare
// lanes only — canonical Anthropic routes enforce their input limit
// independently of max_tokens, so they get no clamp call site. #4205 boundary:
// wrapper providers on the anthropic wire (completion billed against the same
// window) DO reserve headroom at the band layer but keep no egress clamp here;
// their residual over-requests ride the overflow self-heal (#4093) instead.
// The proxy owns both sides of the sum, so capping output to (window - input -
// margin) makes the overflow impossible even when the agent ignores the
// compress nudge.
const OUTPUT_CLAMP_MARGIN_PCT = 0.05;
const OUTPUT_CLAMP_MIN_MARGIN = 2048;
const OUTPUT_CLAMP_FLOOR = 1024;
// #3071/#2490: capability floor for the clamped budget — see clampOutputBudget.
const OUTPUT_CLAMP_MIN_OUTPUT = 4096;
// #3384: giant-request line for applying the refused-dsh-ledger planning floor
// (#2490). A requested output budget at or above this fraction of the native
// window can push a near-wall raw ledger past the window in ONE turn — the
// #2490 shape (384K requested against a 1M window / ~900K ledger produced the
// 7.5MB un-foldable turn). Below the line no single-turn output can overflow
// the ledger, so applying the floor there only reserves output budget against
// bytes bili never sends (its folds keep the wire small while the client's raw
// ledger grows because compaction is refused) — the #3384 starvation: folded
// wire at 8–11% of a 1M window, budget clamped 50670 -> 5909, every byte eaten
// by thinking on an onlyReasoning model -> stopReason=length -> blank turns.
// Aligned with the #896 default outputHeadroomMaxPct (0.25) and the #2096 note
// below ("when max_tokens > 25% of the window the overflow boundary lies BELOW
// the headroom target").
const OUTPUT_LEDGER_FLOOR_GIANT_REQUEST_PCT = 0.25;
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
export function estimateInputTokens(processedMessages: CoreMessage[], systemText: string | undefined, tools: unknown, lastInputTokens: number, lastInputTokensSource?: string, kFactor?: number, kOrigin?: string, origin?: string, loadedToolTokens = 0, imageTokens = 0): number {
    // #2558: price the image reserve onto the LOCAL-EST arm only. A usage-grade
    // baseline is the provider-reported input total, which already bills those
    // same images (#488) — adding the reserve to it double-counts every image and
    // starves the output clamp as they accumulate. This matches the preflight
    // trigger and outbound metering, both of which compute max(baseline, est +
    // reserve). Applied after calibration so the text k̂ never deflates the
    // separately-learned image cost (#1843 L1). #2391's deferred-tool tokens ride
    // INSIDE the calibrated arm instead — they are JSON payload text.
    const est = applyEstimateCalibration(estimateCoreMessages(processedMessages) + countSystemAndToolsTokens(systemText, tools) + loadedToolTokens, kFactor, kOrigin, origin) + imageTokens;
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

/** Billable text of ONE Responses system/developer message item: plain string
 *  content, or the .text fields of its input_text/output_text parts joined by
 *  newlines (codex sends its system prompt as such items; #1638 keeps
 *  mid-history developer notifications in input[] in exactly these shapes). */
function responsesSysDevItemText(item: Record<string, unknown>): string {
    const c = item.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
        return c
            .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
            .join("\n");
    }
    return "";
}

/** Parse a wire body for overhead extraction; null when unparseable (callers
 *  treat that as zero overhead — the legacy catch rule). */
function parsedWireBody(body: string | Buffer | Record<string, unknown>): Record<string, unknown> | null {
    if (typeof body === "object" && !Buffer.isBuffer(body)) return body;
    try {
        return JSON.parse(typeof body === "string" ? body : body.toString("utf8")) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** #5000: the exact text pieces a wire payload carries OUTSIDE the message
 * array — system/instructions text and tool definitions (including the
 * proxy-injected ACP tools, and responses' loaded-tool items). Single source
 * of truth for BOTH calibers of this mass: estimateWireOverhead (tokens —
 * trigger/clamp channel, #470) and estimateWireOverheadBytes (bytes — doom-
 * gate floor, #5000). They extract here and differ only in how they count, so
 * the two calibers can never drift apart. */
export function wireOverheadTexts(
    protocol: "anthropic" | "openai" | "responses" | "google",
    parsed: Record<string, unknown>,
): { sysText: string; toolsJson: string; loadedItemJsons: string[] } {
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
            .map(responsesSysDevItemText)
            .filter((t) => t.length > 0)
            .join("\n");
        if (hoisted) sysText = sysText ? `${sysText}\n${hoisted}` : hoisted;
    }
    const toolsJson = JSON.stringify(protocol === "responses" ? modelVisibleTools(parsed.tools) : parsed.tools ?? []);
    const loadedItemJsons: string[] = [];
    if (protocol === "responses" && Array.isArray(parsed.input)) {
        for (const item of parsed.input as Array<Record<string, unknown>>) {
            if (["additional_tools", "tool_search_call", "tool_search_output", "mcp_list_tools"].includes(item?.type as string)) {
                loadedItemJsons.push(JSON.stringify(item));
            }
        }
    }
    return { sysText, toolsJson, loadedItemJsons };
}

/** #470: tokens the wire payload carries OUTSIDE the message array —
 * system/instructions text and tool definitions (including the proxy-injected
 * ACP tools). estimateCoreMessages only counts messages, so without this term
 * the preflight trigger fires ~10-20K late on agent clients with big tool
 * manifests: text alone "fits" while the real billed input already overflows
 * the window. Same term estimateInputTokens applies to the output clamp (#467). */
export function estimateWireOverhead(protocol: "anthropic" | "openai" | "responses" | "google", body: string | Buffer | Record<string, unknown>): number {
    const parsed = parsedWireBody(body);
    if (parsed === null) return 0;
    const { sysText, toolsJson, loadedItemJsons } = wireOverheadTexts(protocol, parsed);
    return defaultCountTokens(sysText) + defaultCountTokens(toolsJson)
        + loadedItemJsons.reduce((sum, j) => sum + defaultCountTokens(j), 0);
}

// #5000: byte twin of estimateWireOverhead for the doomed-gate floor
// (#2490/#4079). The gates priced ONLY core message bytes while the trigger
// priced messages PLUS this overhead — a payload whose multi-MB tool manifest
// makes the billed total cross the window could still clear the floor on the
// residual caliber. Bytes rather than tokens×density: the floor's invariant
// (bytes ÷ densest observed density > window ⇒ no tokenizer fits it) holds
// only for content that IS billed — everything extracted here renders into the
// prompt on every provider (system text, tool schemas, loaded-tool items).
// Media stays excluded (separate learned channel), and the JSON envelope is
// deliberately NOT counted: transport syntax no tokenizer bills — counting it
// would false-positive dense-but-fitting payloads (#3617 both-ways).
export function estimateWireOverheadBytes(protocol: "anthropic" | "openai" | "responses" | "google", body: string | Buffer | Record<string, unknown>): number {
    const parsed = parsedWireBody(body);
    if (parsed === null) return 0;
    const { sysText, toolsJson, loadedItemJsons } = wireOverheadTexts(protocol, parsed);
    let bytes = Buffer.byteLength(sysText, "utf8") + Buffer.byteLength(toolsJson, "utf8");
    for (const j of loadedItemJsons) bytes += Buffer.byteLength(j, "utf8");
    return bytes;
}

/** Output-budget cap so input+output <= window. Returns the clamped budget, or
 *  undefined when no reduction is needed (requested already fits, or the cap
 *  drops below OUTPUT_CLAMP_FLOOR — i.e. input alone nearly fills the window,
 *  which is preflight/self-heal territory, not output starvation).
 *  #2490 ledger regime: when the planning basis is the refused dsh raw ledger
 *  (dshLedgerFloorTokens), cap < 1024 means the HOST's own counter already
 *  sits at the window wall — bili's folds cannot shrink it (refused
 *  checkpoints never land), so no output budget recovers the session; a
 *  sub-floor clamp would only starve a terminal turn. That surrender is
 *  deliberate, not a gap (pinned in
 *  tests/issue2490-ledger-floor-doomed-probe.test.ts).
 *  #3071: where a clamp DOES fire (cap >= OUTPUT_CLAMP_FLOOR), the 5% margin drags
 *  cap into the low thousands near the window (observed 1479/2623), starving the
 *  reply to an empty finish=length turn even though raw headroom still fits a normal
 *  reply. Floor the reduction target at min(OUTPUT_CLAMP_MIN_OUTPUT, window - input)
 *  — always <= window - input, so input+output can never exceed the window
 *  (fail-closed preserved). The sub-floor surrender above (cap < OUTPUT_CLAMP_FLOOR)
 *  stays byte-identical. */
export function clampOutputBudget(requested: number, inputEstimate: number, nativeWindow: number, knownOutputCeiling?: number): number | undefined {
    const margin = Math.max(OUTPUT_CLAMP_MIN_MARGIN, Math.ceil(inputEstimate * OUTPUT_CLAMP_MARGIN_PCT));
    // #2011: max_tokens / max_completion_tokens / max_output_tokens are integer-typed on every
    // wire protocol. Since v0.1.181 inputEstimate can carry a fraction: #1843 L1's learned
    // per-route image cost (learnedImageReserve in cache-ledger.ts — an EMA over
    // observed/nImages usage samples) takes precedence over the integer pixel/byte priors
    // (#488) when fresh matching evidence exists, which made this cap fractional and strict
    // upstreams rejected the whole turn with `max_tokens: Input should be a valid integer`.
    // Floor at the decision point so the emitted budget is always an integer (floor <= exact
    // headroom, so input+output <= window still holds).
    // #3833: the window headroom cap can still sit ABOVE the model's declared
    // output ceiling (window - input - margin > ceiling) — a 1M-window model with
    // a 131072 output ceiling and ~827K input yields headroom 131577 > 131072.
    // The ceiling is a hard upstream bound (strict providers reject max_tokens above
    // it with 400), so cap BOTH the headroom and the #3071 floor to min(·, ceiling);
    // absent a known ceiling (Infinity) every term is byte-identical to before.
    const ceilingBound = typeof knownOutputCeiling === "number" && Number.isFinite(knownOutputCeiling) ? knownOutputCeiling : Number.POSITIVE_INFINITY;
    const cap = Math.min(Math.floor(nativeWindow - inputEstimate - margin), ceilingBound);
    if (cap < OUTPUT_CLAMP_FLOOR || cap >= requested) return undefined;
    // #3071: cap >= OUTPUT_CLAMP_FLOOR here. Never reduce below the capability
    // floor, bounded by raw headroom so input+output <= window still holds.
    const floorOut = Math.min(OUTPUT_CLAMP_MIN_OUTPUT, Math.floor(nativeWindow - inputEstimate), ceilingBound);
    const clamped = Math.max(cap, floorOut);
    if (clamped >= requested) return undefined;
    return clamped;
}

/** #2490: translate the refused dsh compaction replay size (recorded on the
 *  session by the guard in handle.ts) into a token floor for the clamp's
 *  planning basis. bytes/4 mirrors the default estimator's chars/4 caliber
 *  (the replay is JSON text riding the same wires). 0 when nothing was
 *  recorded — legacy behavior.
 *  STICKY BY DESIGN: the guard records a high-water mark and nothing decays
 *  or clears it while the session lives. While compaction stays refused the
 *  raw ledger only grows (refused checkpoints never land), so the max bounds
 *  every future re-send; decaying the floor would re-open the #2490 kill
 *  chain. Lifetime ends with the session (metadata eviction). Known
 *  conservative residue: if a checkpoint lands anyway (direct-bypass path;
 *  the #2028 opt-out was removed, #3666) and shrinks the ledger, the floor
 *  stays at its old high until eviction — fail-closed over-tightening,
 *  accepted.
 *  Note (#3384): recording stays sticky; what changed is APPLICATION — the
 *  clamp gates where this floor may drive planning (see clampOutgoingOutput),
 *  so a stale high-water mark can no longer starve a healthy session. */
export function dshLedgerFloorTokens(metadata: Record<string, unknown> | undefined | null): number {
    const bytes = metadata?.["dshCompactionRefusedBytes"];
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return 0;
    return Math.ceil(bytes / 4);
}

// Only override genuine cadence silences — never the kernel's deliberate
// "nothing worth offering" suppressions. Two independent grounds, each pinned
// by its own issue:
//
// #2104 (submit-gate feasibility): decideNudge suppresses while
// compressibleRanges still carries the raw list (reason "max compressible <
// threshold" / "max pending < min benefit" — every range below
// minCompressRange). "List non-empty" used to read as "worth advertising", so
// past the escalation line the override injected a nudge whose range list
// compress would atomically reject — the nudge-vs-compress/acp_status
// contradiction of #2104, which fed a compress-loop (4 rejected/burned calls
// in 9 steps). Gate the override on the SAME submit gate compress applies —
// chars >= minCompressRange (#847, the postCompressTail/handleAcpStatus
// filter, mirroring the kernel's own pendingByTier expression): the emergency
// line may only advertise ranges that are executable. minCompressRange 0
// (default) preserves the legacy any-non-empty-list semantics for direct
// callers.
//
// #3006 (net-benefit floor): this line sits INSIDE the kernel's non-pressure
// band (below its maxContextLimitPct over-limit line), where the kernel's
// refusal grounds are cadence/mass ("growth < floor", "max compressible <
// threshold") rather than benefit — so "shouldInject=false + an executable
// range exists" read as "worth forcing" even when the largest executable
// range was below the kernel's OWN minimum-benefit floor, the one it applies
// even in its pressure band (#198). Near-boundary sessions then folded in
// zero-yield loops: each sub-benefit fold rewrites the prefix from the fold
// anchor onward (observed ~65k tokens / ~60s of cache-miss reprocessing per
// fold), reclaims almost nothing, drops usage just under the line, and
// re-arms within a few turns. The override now requires the SAME pair the
// kernel's pressure branch compares — breakdown.maxPending vs
// breakdown.minPressureBenefit: the host may only advertise early what the
// kernel itself would accept under pressure. Hand-built decisions without
// those breakdown fields keep the pre-fix semantics (legacy fallback).
export function emergencyNudge(nudge: NudgeDecision | null | undefined, escalationPct: number = EMERGENCY_NUDGE_ESCALATION_PCT, minCompressRange: number = 0): boolean {
    if (!nudge || nudge.shouldInject) return false;
    if (nudge.contextUsage < escalationPct) return false;
    if (!nudge.compressibleRanges.some((r) => minCompressRange <= 0 || (r.chars ?? r.tokens * 4) >= minCompressRange)) return false;
    const b = nudge.breakdown;
    const minBenefit = b?.minPressureBenefit;
    return !(typeof minBenefit === "number" && Number.isFinite(minBenefit) && minBenefit > 0 && (b.maxPending ?? 0) < minBenefit);
}

/** #3461 problem 2: backoff for the EMERGENCY override. The pure check above
 * has no cadence of its own — once usage sits over the escalation line it
 * re-arms on EVERY request, so a headless client retrying a doomed request
 * injected the tier-1 nudge ~7×/second (field measurement, dsh/pi lanes). A
 * repeat injection carries no new information unless something changed that
 * could make compression newly viable or newly needed, so this wrapper adds a
 * per-session gate stamped on every ALLOWED injection. Re-arm grounds:
 *   - first injection under the current state (no gate yet / corrupt shape);
 *   - a reduction landed since (reductionKeyOf moved — same evidence self-heal
 *     D1 watches: committed fold → nextBlockId advanced, or plugin-lane
 *     compress tool stamped lastCompress): the payload shrank and still needs
 *     the prompt;
 *   - input grew by ≥ the flat growth step since (KDD #8 discipline; the step
 *     is loopConfig.nudge.growthFloor, flat 50K by default — NOT rescaled with
 *     the window): new content worth advising about;
 *   - wall-clock safety valve (SELF_HEAL_SUPPRESS_CAP_MS precedent, 10 min):
 *     one more injection so a permanently stuck session gets periodic reminders
 *     instead of silence forever.
 * Kernel-driven injections (nudge.shouldInject=true) never pass through here —
 * call sites OR them in BEFORE the emergency arm, so normal cadence is
 * untouched. State lives in session.metadata.emergencyNudgeGate (survives
 * restarts with the snapshot, visible on /__bili/sessions like selfHeal). */
export function emergencyNudgeArmed(
    session: Session,
    nudge: NudgeDecision | null | undefined,
    minCompressRange: number,
    tokenCount: number,
    growthStep?: number,
): boolean {
    if (!emergencyNudge(nudge, undefined, minCompressRange)) return false;
    const now = Date.now();
    const key = reductionKeyOf(session);
    const raw = session.metadata["emergencyNudgeGate"];
    if (raw === null || typeof raw !== "object") {
        session.metadata["emergencyNudgeGate"] = { at: now, tokens: tokenCount, reductionKey: key };
        return true;
    }
    const g = raw as Record<string, unknown>;
    const prevAt = typeof g["at"] === "number" ? g["at"] : NaN;
    const prevTokens = typeof g["tokens"] === "number" ? g["tokens"] : NaN;
    const prevKey = typeof g["reductionKey"] === "string" ? g["reductionKey"] : undefined;
    const step = typeof growthStep === "number" && Number.isFinite(growthStep) && growthStep > 0 ? growthStep : 50_000;
    let arm = false;
    if (!Number.isFinite(prevAt) || !Number.isFinite(prevTokens) || prevKey === undefined) {
        arm = true; // corrupt/legacy shape → re-stamp
    } else if (prevKey !== key) {
        arm = true; // a reduction landed since the last injection
    } else if (tokenCount - prevTokens >= step) {
        arm = true; // a full flat-growth step of new content
    } else if (now - prevAt >= SELF_HEAL_SUPPRESS_CAP_MS) {
        arm = true; // wall-clock safety valve
    }
    if (arm) session.metadata["emergencyNudgeGate"] = { at: now, tokens: tokenCount, reductionKey: key };
    return arm;
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
      /** #2490: floor for the PLANNING input when the host (dsh native compaction)
      *  keeps a raw ledger bili's folded view cannot see. The guard's refusals
      *  record the replayed envelope size on the session; that ledger will be
      *  re-sent whole after this turn (and after every turn — the compaction
      *  never lands), so a turn planned only against the folded input invites
      *  output-sized overhang the next raw replay cannot survive. Raising the
      *  planning basis only ever tightens the cap (fail-closed direction).
      *  #3384: APPLIED ONLY WHEN GATED — the floor engages iff the folded view
      *  already sits at the enforced headroom target OR the requested budget is
      *  giant (>= OUTPUT_LEDGER_FLOOR_GIANT_REQUEST_PCT of the window); below
      *  both lines it would reserve output budget against bytes never sent and
      *  starve healthy sessions (see clampOutgoingOutput). */
    ledgerFloorTokens?: number;
      /** #2122/#1933 F1: per-route estimator calibration — scales the local-est
        *  side of estimateInputTokens so the clamp judges the payload on the same
        *  provider-billed scale as preflight/nudge. Absent → legacy raw behavior. */ kFactor?: number; kOrigin?: string; origin?: string;
      /** #3833: the model's declared output ceiling (resolveKnownOutputCeiling, the
        *  same source chain as the #546 restore floor). Binds the clamp's cap so an
        *  outgoing max_tokens never exceeds it even when window headroom allows more
        *  — the hard upstream bound strict providers enforce with a 400. Absent →
        *  byte-identical legacy window-only cap. */ knownOutputCeiling?: number },
    sessionId: string,
    log: (level: string, msg: string) => void,
    /** #3148: optional visibility hook — invoked with the exact clamp event when
     *  a cap is applied (callers record it on session.stats for acp_status).
     *  Never affects the wire decision. */
    onClamped?: (info: { raw: number; capped: number; window: number; planningInput: number; ledgerFloor: number }) => void,
): void {
    const raw = readOutputBudget(rebuilt, field);
    if (typeof raw !== "number") return;
    // #488/#2558: images ride along in the rebuilt body but are invisible to the text
    // model — without them the cap is too generous and input+output can still overflow.
    // estimateInputTokens prices them onto the local-est arm only (a usage-grade baseline
    // already bills them), so the clamp judges the payload on the same max(baseline, est +
    // reserve) caliber as preflight/metering instead of double-counting every image.
    const loadedToolTokens = field === "max_output_tokens" ? countLoadedToolTokens(rebuilt) : 0;
    const inputEstimate = estimateInputTokens(ctx.processedMessages, ctx.systemText, ctx.tools, ctx.lastInputTokens, ctx.lastInputTokensSource, ctx.kFactor, ctx.kOrigin, ctx.origin, loadedToolTokens, ctx.imageTokens);
    // #2490: judge headroom against the larger of the folded view and the refused
    // raw ledger — see ctx.ledgerFloorTokens. Keeps the shape of estimateInputTokens'
    // internal max() (usage baseline never scales DOWN), so all three calibers stay
    // conservative in the same direction.
    const ledgerFloor = typeof ctx.ledgerFloorTokens === "number" && Number.isFinite(ctx.ledgerFloorTokens) ? Math.max(0, Math.floor(ctx.ledgerFloorTokens)) : 0;
    // #3384: the floor only applies where it can still defend something — two
    // independent grounds, either suffices:
    //   - viewAtEnforcedTarget: bili's OWN folded view has reached the
    //     headroom-adjusted target nudge/preflight enforce — the session really
    //     is at the wall, so planning against the worst-case ledger is right;
    //   - giantRequestedBudget: the requested output alone can push a near-wall
    //     ledger past the window in one turn (the #2490 shape).
    // Otherwise the floor is pure over-reservation: the client's raw ledger only
    // grows because bili refuses compaction, while the wire bili actually sends
    // stays small via its folds — reserving output budget against bytes never
    // sent starves the session's own replies (#3384: folded wire 8–11% of a 1M
    // window, budget clamped to 5909, all eaten by thinking -> blank turns).
    // Both pinned protection regimes survive: the #2490 incident request (384K
    // >= 25% of 1M) takes giantRequestedBudget; near-wall sessions take
    // viewAtEnforcedTarget.
    const viewAtEnforcedTarget = typeof ctx.headroomWindow === "number" && Number.isFinite(ctx.headroomWindow) && ctx.headroomWindow > 0 && inputEstimate >= ctx.headroomWindow;
    const giantRequestedBudget = ctx.nativeWindow > 0 && raw >= OUTPUT_LEDGER_FLOOR_GIANT_REQUEST_PCT * ctx.nativeWindow;
    const planningInput = viewAtEnforcedTarget || giantRequestedBudget ? Math.max(inputEstimate, ledgerFloor) : inputEstimate;
    const capped = clampOutputBudget(raw, planningInput, ctx.nativeWindow, ctx.knownOutputCeiling);
    if (capped !== undefined) {
        writeOutputBudget(rebuilt, field, capped);
        // #2096: in the band (headroom target, native window) the clamp can only
        // guarantee native-window fit — preflight/compression is what can pull
        // the input back under the enforced target. Say so instead of advertising
        // rescue right before the turn dies.
        const overTarget = ctx.headroomWindow !== undefined && ctx.headroomWindow < ctx.nativeWindow && planningInput >= ctx.headroomWindow;
        log("info", `[${sessionId}] output budget clamped ${raw} -> ${capped} (input~${inputEstimate}${ledgerFloor > inputEstimate ? `, planning floor ${ledgerFloor} from the refused dsh compaction replay (#2490)` : ""}, window=${ctx.nativeWindow}); prevents input+output overflow (#453)${overTarget ? `; input already exceeds the headroom-adjusted target ~${ctx.headroomWindow} that nudge/preflight enforce — only compression can recover it, this clamp guarantees native-window fit only (#2096)` : ""}`);
        onClamped?.({ raw, capped, window: ctx.nativeWindow, planningInput, ledgerFloor });
    }
}
