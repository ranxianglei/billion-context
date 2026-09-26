// Shared contract + helpers for the per-protocol prepare pipelines
// (extracted verbatim from src/server.ts — #1440 P2 four-cut disassembly,
// cut 2). The Prepared type is the wire contract between prepare*() and
// forward()/preflight.

import { resolveAbsorbSettings } from "../compress-settings.js";
import { CompressSettings, ProxyOptions, findRoute } from "../config.js";
import { recordConflict } from "../conflict-watch.js";
import { ResolvedImageBilling, resolveImageBilling } from "../image-tokens.js";
import { reapOrphanBlocks } from "../orphan-gc.js";
import { estimateCoreMessagesUpper } from "../preflight.js";
import { CompressReasoningConfig, dropCompressReasoning } from "../reasoning-drop.js";
import { PendingRetrieval, Session } from "../session.js";
import { WireProtocol } from "../util.js";
import { AbsorbConfig, CompressionState, Config, CoreMessage, NudgeDecision, PackSurface, Prompts, deactivateBlock } from "acp-kernel";
import { AnthropicRequestBody, BiliMessage, ResponsesProjection } from "acp-kernel/wire";

export type Prepared = {
    body: string | Buffer;
    session: Session;
    processedMessages: CoreMessage[];
    /** Original CoreMessages from the protocol conversion, BEFORE processTurn
     *  folded/replaced anything. compress/decompress/acp_status need the raw
     *  text (collectBlockContent reads message text by id); processedMessages
     *  has compressed messages replaced with placeholders → empty content. */
    originalMessages: CoreMessage[];
    protocol: WireProtocol;
    stream: boolean;
    compressInjected: boolean;
    /** True when the session is driven by a cooperative agent-side plugin
     *  (x-bili-plugin header, see src/plugin.ts): tools are native, the
     *  response must pass through verbatim, and usage is sniffed instead of
     *  captured by the compress loop. */
    pluginMode?: boolean;
    responsesTextProtocol?: boolean;
    resetAfterSuccess?: boolean;
    responsesProjection?: ResponsesProjection;
    anthropicSystem?: AnthropicRequestBody["system"];
    /** Original leading system/developer prefix text captured by the kernel's
     *  openai hoist (0.0.37). The fold space no longer carries it, so every
     *  rebuilt payload and compress-loop round must re-inject it. */
    openaiSystemText?: string;
    /** Google wire: the client's own `systemInstruction` text (the kernel hoists
     *  it out of the fold space) and the path-derived model. Both are needed to
     *  rebuild `systemInstruction` and to synthesize chunks on every compress
     *  loop round. */
    google?: { system?: string; model?: string };
    /** #1085: stable-system-anchor update notes for this turn — re-injected
     *  as trailing user messages so compress-loop rounds see the same
     *  updated-instructions context the main request did. */
    systemNotes?: string[];
    /** [#1343] Plugin-lane retrievals snapshotted onto THIS request's body.
     *  Carried so forward() commits them on upstream success or drops them
     *  (logged + corrective note) on failure — the ack is already out, so the
     *  full text must never vanish silently. */
    attachedRetrievals?: PendingRetrieval[];
    nudge?: NudgeDecision;
    /** Render strategy the prepare used for processTurn ("none" for codex
     *  compaction triggers / ACP_RENDER_NONE). The #422 fold-refresh hook in
     *  forward() re-runs processTurn with the same strategy so the re-request
     *  renders tags exactly like the request that produced it. */
    renderTags?: "text-only" | "none";
     /** Effective compression prompts for this request (three-level cascade,
      *  defaults to the kernel's defaultPrompts). Carried so the compress loop
      *  in forward() rebuilds the SAME system prompt the request was prepared
      *  with. */
    prompts?: Prompts;
    /** Effective pack surface (promptPack) for this request: tool prompts,
      *  system-prompt sections, nudge sections. Same carrying rationale as
      *  prompts — the compress loop must rebuild the identical surface. */
    surface?: PackSurface;
    /** #388: side request (title-gen etc.) — transport with render-tag strip
     *  only. Skips preflight (handle() returns before it), the fake-completion
     *  retry wrapper, the compress loop, and every usage-sniffing pipe; the
     *  #460 strip pipes in forward() run with session=undefined. */
    sidePassthrough?: boolean;
    /** Set when a codex native-compaction request was intercepted and a
     *  success response was forged locally (BILI_CODEX_COMPACT=intercept +
     *  gate passed). forward() serves `body` without contacting upstream. */
    codexForge?: { kind: "endpoint" | "trigger"; body: string; contentType: string };
};

// #767: per-request image billing mode — env BILI_IMAGE_BILLING (live, like
// BILI_IMAGE_TOKEN_CAP) wins over the per-provider route entry, which wins over
// the global config level; "auto"/unset classifies known first-party pixel-tile
// hosts by upstream URL. Every payload-size decision below consults this so one
// over-estimate cannot block all of them at once.
export function imageBillingFor(opts: ProxyOptions, upstreamUrl: string | undefined): ResolvedImageBilling {
    const env = process.env.BILI_IMAGE_BILLING;
    const configured = env === "pixels" || env === "bytes" ? env : findRoute(opts.routes, upstreamUrl)?.imageBilling ?? opts.imageBilling ?? "auto";
    return resolveImageBilling(configured, upstreamUrl);
}

const ACP_TAG_MARK = "\x3cacp ";

// acp-kernel injects an in-place `acp_summary_*` at the compressed range as a
// generic-library fallback. This host strips it ONLY when it is redundant: the
// block's compress tool-call also carries the summary (hideConsumedCompressCalls
// keeps active-block calls), and a mid-stream insertion would shift the upstream
// prefix-cache breakpoint. Blocks created without a tool call (preflight
// compression, src/preflight.ts — #247) have NO other carrier: their anchor is
// the only place the summary reaches the model, so it must survive.
//
// Per mode (see README "Two compression modes"): in plugin/launcher mode the
// tool call is ALWAYS in the re-sent history (the agent owns compression), so
// this strips every acp_summary and the carrier is the tool call; in proxy mode
// the tool call is usually absent (ephemeral server-side execution) or
// nonexistent (preflight), so acp_summary survives as the carrier and
// systemToUser later re-voices the survivors as USER messages (leaving them at
// their anchors) for strict backends (#377).
/** [#651] Strip oversized reasoning from closed compress turns (see
 *  src/reasoning-drop.ts) with an ops log line when anything was dropped. */
export function withReasoningDrop(
    msgs: BiliMessage[],
    reasoning: CompressReasoningConfig | undefined,
    log: (level: string, msg: string) => void,
    sessionId: string,
    strictEcho: boolean,
): BiliMessage[] {
    // [#684] strict-echo upstreams: reasoning must round-trip with tool_calls,
    // so #651's drop must not fire. Learned/static strictness both land here.
    if (strictEcho) return msgs;
    const out = dropCompressReasoning(msgs, reasoning);
    if (out.length !== msgs.length) {
        log("info", `[${sessionId}] compress-reasoning: dropped ${msgs.length - out.length} reasoning message(s) from closed compress turns (#651)`);
    }
    return out;
}

export function stripKernelSummaries(messages: BiliMessage[], state: CompressionState): BiliMessage[] {
    const carried = new Set<string>();
    for (const b of state.blocks) {
        if (!b.active || !b.compressCallId) continue;
        if (messages.some((m) => m.contentType === "tool-call" && m.toolCallId === b.compressCallId)) {
            carried.add(`acp_summary_${b.blockId}`);
        }
    }
    return messages.filter((m) => !(m.id ?? "").startsWith("acp_summary_") || !carried.has(m.id));
}

export function diagTagSummary(messages: CoreMessage[], sessionId: string, strategy: string): string {
    let textTagged = 0;
    let toolTagged = 0;
    for (const m of messages) {
        const hasTag = (m.text ?? "").includes(ACP_TAG_MARK);
        if (!hasTag) continue;
        if (m.contentType === "tool-call" || m.contentType === "tool-result") toolTagged++;
        else textTagged++;
    }
    return `[${sessionId}] processTurn: ${messages.length} msgs, renderTags=${strategy}, ${textTagged} text tagged, ${toolTagged} tool tagged (should be 0 with text-only)`;
}

export function diagNudge(turn: { nudge?: { shouldInject: boolean; reason: string; contextUsage: number; tier: number | null; breakdown?: Record<string, number> } | null }, sessionId: string, tokenCount: number, limit: number, model: string | undefined, willInject: boolean): string {
    const n = turn.nudge;
    if (!n) return `[${sessionId}] nudge: unavailable`;
    const b = n.breakdown ?? {};
    const pct = limit > 0 ? `${Math.round((tokenCount / limit) * 100)}%` : "?";
    const growth = b["growth"] ?? 0;
    const floor = b["growthFloor"] ?? 0;
    const interval = b["nudgeGrowthTokens"] ?? 0;
    const pendingT1 = b["pendingT1"] ?? 0;
    const ref = b["growthReference"] ?? 0;
    // "INJECT" only when the nudge actually reaches the upstream payload. When
    // armed but suppressed by config/mode, say so explicitly so the log never
    // lies about delivery (#451, same class as #413).
    const inject = willInject
        ? (n.shouldInject ? `INJECT T${n.tier ?? "?"}` : `INJECT-ESC T${n.tier ?? "?"}`)
        : (n.shouldInject ? `ARMED-SUPPRESSED T${n.tier ?? "?"}` : "idle");
    const modelTag = model ? ` model=${model}` : "";
    return `[${sessionId}] nudge ${inject}: usage=${pct} (${tokenCount}/${limit}), growth=${growth}/${floor} (ref=${ref}, interval=${interval}), pendingT1=${pendingT1}/${interval}${modelTag}, reason="${n.reason.slice(0, 120)}"`;
}

// Zero-baseline sessions are judged conservatively ONLY when they arrived
// anonymously (prefix-affinity forks/reloads, #553): they carry the full raw
// history but no measurement yet, so feeding 0 blinds the nudge (usage 0%,
// growth ref 0) and no compression trigger fires until overflow. Explicit-
// identity zero-baseline sessions previously stayed at 0 on the assumption
// that they "self-heal via the next measured usage report" — an assumption
// that breaks for upstreams that NEVER report usage (ChatGPT-login backends,
// #728): lastInputTokens stays 0 for the whole session, and the kernel's
// decideNudge is structurally unfireable at tokenCount == 0 (growth ref falls
// back to tokenCount itself → growth ≡ 0; firstSightMassReady/pressure bands
// all require usage >= their pct lines). #728 fix: such sessions fall back to
// the PREVIOUS turn's locally-measured outbound payload upper bound
// (session.stats.localInputEstimate, recorded in prepare* each turn). The
// estimator only errs EARLY (char-count upper bound → compress earlier, never
// later), is active only while lastInputTokens == 0 (a real usage report takes
// precedence immediately — same invariant as #604's armFailureShrink
// exception), and self-corrects after every fold (the post-fold payload
// shrinks → the next estimate drops). Turn 1 of a fresh explicit session
// still feeds 0 (nothing measured yet; nothing pending either), so
// first-turn behavior is byte-identical to pre-#728.
export function effectiveTokenCount(session: Session, msgs: CoreMessage[], inboundImageTokens = 0): number {
    if (session.stats.lastInputTokens > 0) return session.stats.lastInputTokens;
    // The inbound upper bound carries the image term in BOTH zero-baseline
    // regimes (#1119/#1137): the wire codecs move images out of
    // CoreMessage.text into sidecars, so a text-only bound drops them.
    // #1137: an anonymous prefix-affinity fork (#553) replays its FULL raw
    // history — images included — in this one request, so this request's
    // image mass IS the history's image mass; returning the text-only bound
    // there left image-heavy forks reading single-digit usage % and nudging
    // only at overflow.
    const raw = estimateCoreMessagesUpper(msgs) + inboundImageTokens;
    if (session.metadata.anonymousPrefixAffinity) return raw;
    const est = session.stats.localInputEstimate ?? 0;
    if (est <= 0) return 0;
    // Cap by THIS request's inbound upper bound: the recorded estimate lags by
    // one turn, so after a client-side shrink (native compaction echo, history
    // edit) the previous turn's payload can be larger than what is in front of
    // us now — never claim more context than the current request could hold.
    // In steady state est <= raw bound always (the outbound fold is never
    // larger than the inbound history), so this is a no-op there. A
    // client-side shrink still shrinks the bound (fewer messages AND fewer
    // images), preserving the stale-high invariant.
    return Math.min(est, raw);
}

// #1359: which absorb block governs a session, by lane. Proxy lane keeps the
// per-request merged block (provider/model overrides apply); plugin lane uses
// the base block so the manifest's advertised name and the gate's adjudicated
// name always agree — provider/model absorb.* overrides are proxy-lane-only.
export function effectiveAbsorbBlock(pluginMode: boolean, config: Config, baseAbsorb?: CompressSettings["absorb"]): AbsorbConfig | undefined {
    return pluginMode ? resolveAbsorbSettings(baseAbsorb) : config.absorb;
}

/** Derive a short human-readable title from the first user text message.
 *  Used so the web UI can show "Fix auth bug" instead of an opaque hash. */
export function deriveTitle(messages: CoreMessage[]): string | undefined {
    for (const m of messages) {
        if (m.role !== "user" || m.contentType !== "text") continue;
        const clean = (m.text ?? "").replace(/\s+/g, " ").trim();
        if (clean) return clean.length > 60 ? clean.slice(0, 57) + "\u2026" : clean;
    }
    return undefined;
}

// #1206: orphan reaping was silent — blocks deactivated because their source
// messages vanished from client history are the strongest runtime signal that
// something outside bili (client auto-compaction or another compression plugin)
// rewrote the conversation. Log it and record it in the session ledger.
export function reapOrphansLogged(session: Session, msgs: CoreMessage[], log: (level: string, msg: string) => void, sessionId: string): void {
    const { reaped } = reapOrphanBlocks(session, msgs, deactivateBlock);
    if (reaped.length === 0) return;
    log("warn", `[${sessionId}] orphan-gc deactivated ${reaped.length} block(s) whose source messages left the client history (${reaped.join(", ")}) — the client or another compression plugin deleted summarized content; those summaries can no longer be decompressed (#1206)`);
    recordConflict(session, "orphan-reap", `${reaped.length} block(s) deactivated: ${reaped.join(", ")}`);
}
