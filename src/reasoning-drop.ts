import type { BiliMessage } from "acp-kernel/wire";

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
}

export const DEFAULT_COMPRESS_REASONING: Required<CompressReasoningConfig> = { drop: true, threshold: 2048 };

export function resolveReasoningDrop(cfg?: CompressReasoningConfig): Required<CompressReasoningConfig> {
    let threshold = DEFAULT_COMPRESS_REASONING.threshold;
    if (cfg?.threshold !== undefined) {
        const t = cfg.threshold;
        if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
            threshold = Math.floor(t);
        }
    }
    return { drop: cfg?.drop !== false, threshold };
}

/** Request-time pass: remove reasoning messages attached to a `compress`
 *  tool call only when ALL gates hold —
 *  1. closed round [#348 twin]: the compress call has its tool-result
 *     message (`contentType: "tool-result"`, matching `toolCallId`) at a
 *     LATER index, and at least one message exists after that result (the
 *     round has demonstrably moved on). No user message is required, so
 *     long agentic sessions do close rounds; a call without a result, or
 *     whose result is still the last message, is in flight and never
 *     touched;
 *  2. selector: `contentType: "tool-call"` with `toolName === "compress"`
 *     (other protected tools would need their own explicit config);
 *  3. size: the run of reasoning messages immediately preceding the call
 *     (contiguous, as emitted by anthropicToCore/openaiToCore/responsesToCore)
 *     totals strictly more than `threshold` chars.
 *  Pure: never mutates the input; idempotent; fail-safe (any error returns
 *  the input unchanged). */
export function dropCompressReasoning(messages: BiliMessage[], cfg?: CompressReasoningConfig): BiliMessage[] {
    const { drop, threshold } = resolveReasoningDrop(cfg);
    if (!drop || messages.length === 0) return messages;
    try {
        const last = messages.length - 1;
        const resultAt = new Map<string, number>();
        for (let i = 0; i <= last; i++) {
            const m = messages[i]!;
            if (m.contentType === "tool-result" && typeof m.toolCallId === "string" && !resultAt.has(m.toolCallId)) {
                resultAt.set(m.toolCallId, i);
            }
        }
        const dropIdx = new Set<number>();
        for (let i = 0; i <= last; i++) {
            const m = messages[i]!;
            if (m.contentType !== "tool-call" || m.toolName !== "compress") continue;
            const ri = typeof m.toolCallId === "string" ? resultAt.get(m.toolCallId) : undefined;
            if (ri === undefined || ri <= i || ri >= last) continue;
            let total = 0;
            let j = i - 1;
            while (j >= 0 && messages[j]!.contentType === "reasoning") {
                total += (messages[j]!.text ?? "").length;
                j--;
            }
            if (total > threshold) {
                for (let k = j + 1; k < i; k++) dropIdx.add(k);
            }
        }
        if (dropIdx.size === 0) return messages;
        return messages.filter((_, idx) => !dropIdx.has(idx));
    } catch {
        return messages;
    }
}
