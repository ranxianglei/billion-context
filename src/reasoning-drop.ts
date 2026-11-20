import type { BiliMessage } from "acp-kernel/wire";
import { isMcpBiliCompress } from "./config.js";

/** [#651] Drop oversized reasoning (thinking) from closed-round `compress`
 *  tool calls at request time — the billion-context twin of
 *  billion-context-pi #336/#339/#348, aligned with opencode-acp #377.
 *  `compress` tool messages are hard-exempt from compression (their tool
 *  results are the anchors that keep block summaries addressable), so the
 *  reasoning attached to those turns rides along EVERY forwarded request as
 *  an unreclaimable context floor — measured at ~83.5% of the never-covered
 *  residual on real long sessions, growing ~9 KB per compression round.
 *  This pass removes those reasoning messages from the OUTBOUND view only
 *  (persisted history and kernel state are never modified) once the round is
 *  closed and the reasoning run exceeds the size gate. A round is closed on
 *  ROUND EVIDENCE, not on user messages: the compress tool result must have
 *  arrived and at least one message must exist after it. The in-flight round
 *  (result still missing or still the last message) is never touched [#348
 *  twin]. */
export interface CompressReasoningConfig {
    /** Master switch. Default: true. `drop: false` disables the pass entirely
     *  (kill-switch — set it per-provider for models whose reasoning items
     *  are opaque and MUST round-trip unmodified, e.g. chat models that
     *  reject requests whose reasoning_content is not echoed back). */
    drop?: boolean;
    /** Size gate (chars): the reasoning run attached to a closed-turn
     *  `compress` call must total STRICTLY more than this to be dropped.
     *  Default: 2048. `0` drops any non-empty run. */
    threshold?: number;
    /** (#7144 follow-up) Extend the drop from compress turns to ANY closed round in
     *  the protected tail: a tool call whose result arrived with at least
     *  one message after it, or an assistant text turn that is no longer
     *  the view's last message. Those rounds leave the protected window
     *  (and their reasoning with it) at the next fold anyway — dropping
     *  early reclaims the tokens now. The in-flight round (result pending
     *  or still the last message) is NEVER touched, exactly like the base
     *  pass. Default: false. Requires `drop !== false`. On strict-echo
     *  upstreams the whole pass is disabled upstream of this gate
     *  (planReasoningDrop) and the #762/#2169 blank-echo normalization
     *  already covers any residual missing echo. */
    tail?: boolean;
}

export const DEFAULT_COMPRESS_REASONING: Required<CompressReasoningConfig> = { drop: true, threshold: 2048, tail: false };

export function resolveReasoningDrop(cfg?: CompressReasoningConfig): Required<CompressReasoningConfig> {
    let threshold = DEFAULT_COMPRESS_REASONING.threshold;
    if (cfg?.threshold !== undefined) {
        const t = cfg.threshold;
        if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
            threshold = Math.floor(t);
        }
    }
    return { drop: cfg?.drop !== false, threshold, tail: cfg?.tail === true };
}

/** Request-time pass: remove reasoning messages attached to a `compress`
 *  tool call (base) — and, with `tail`, to ANY closed round — only when ALL
 *  gates hold —
 *  1. closed round [#348 twin]: the compress call has its tool-result
 *     message (`contentType: "tool-result"`, matching `toolCallId`) at a
 *     LATER index, and at least one message exists after that result (the
 *     round has demonstrably moved on). No user message is required, so
 *     long agentic sessions do close rounds; a call without a result, or
 *     whose result is still the last message, is in flight and never
 *     touched;
 *  2. selector: `contentType: "tool-call"` whose name counts as bili's
 *     compress tool — bare `compress` OR the MCP-prefixed form
 *     (`isMcpBiliCompress`, #2970/#3222: hosts that surface the tool through
 *     MCP re-sent `mcp__bili__compress`, which this pass used to miss);
 *  3. size: the run of reasoning messages immediately preceding the call
 *     (contiguous, as emitted by anthropicToCore/openaiToCore/responsesToCore)
 *     totals strictly more than `threshold` chars.
 *  Pure: never mutates the input; idempotent; fail-safe (any error returns
 *  an empty set / the input unchanged). */
export function dropCompressReasoningIds(messages: BiliMessage[], cfg?: CompressReasoningConfig): Set<string> {
    const { drop, threshold, tail } = resolveReasoningDrop(cfg);
    const ids = new Set<string>();
    if (!drop || messages.length === 0) return ids;
    try {
        const last = messages.length - 1;
        const resultAt = new Map<string, number>();
        for (let i = 0; i <= last; i++) {
            const m = messages[i]!;
            if (m.contentType === "tool-result" && typeof m.toolCallId === "string" && !resultAt.has(m.toolCallId)) {
                resultAt.set(m.toolCallId, i);
            }
        }
        // Contiguous reasoning run ending at i-1 (message i is the first
        // non-reasoning after it); null when there is no such run.
        const runBefore = (i: number): number[] | null => {
            if (i === 0 || messages[i - 1]!.contentType !== "reasoning") return null;
            const idx: number[] = [];
            let j = i - 1;
            while (j >= 0 && messages[j]!.contentType === "reasoning") { idx.push(j); j--; }
            return idx;
        };
        const harvest = (i: number): void => {
            const idx = runBefore(i);
            if (idx === null) return;
            let total = 0;
            for (const k of idx) total += (messages[k]!.text ?? "").length;
            if (total > threshold) for (const k of idx) ids.add(messages[k]!.id);
        };
        for (let i = 0; i <= last; i++) {
            const m = messages[i]!;
            if (m.contentType !== "tool-call" || typeof m.toolName !== "string" || !isMcpBiliCompress(m.toolName)) continue;
            const ri = typeof m.toolCallId === "string" ? resultAt.get(m.toolCallId) : undefined;
            if (ri === undefined || ri <= i || ri >= last) continue;
            harvest(i);
        }
        // (#7144 follow-up) tail scope: any closed round, not only compress turns.
        // A tool call closes when its result arrived with at least one
        // message after it; an assistant text turn (a run's successor is
        // always model output) closes when it is no longer the last message.
        if (tail) {
            for (let i = 0; i <= last; i++) {
                const m = messages[i]!;
                if (m.contentType === "tool-call") {
                    const ri = typeof m.toolCallId === "string" ? resultAt.get(m.toolCallId) : undefined;
                    if (ri === undefined || ri <= i || ri >= last) continue;
                } else if (m.contentType === "text") {
                    if (i >= last) continue;
                } else {
                    continue;
                }
                harvest(i);
            }
        }
    } catch {
        // fail-safe: report nothing to drop rather than corrupt the view
    }
    return ids;
}

export function dropCompressReasoning(messages: BiliMessage[], cfg?: CompressReasoningConfig): BiliMessage[] {
    const ids = dropCompressReasoningIds(messages, cfg);
    if (ids.size === 0) return messages;
    return messages.filter((m) => !ids.has(m.id));
}
