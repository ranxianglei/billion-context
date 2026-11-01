/**
 * #5418 — the full-resend watermark gate: a PURE decision over its inputs.
 *
 * The design replaces per-message identity re-reconciliation with a count
 * assertion and, on a match, parses only the uncovered tail window instead of
 * the whole resent body (see fastpath-scan.ts). Whether a request MAY take that
 * fastpath is a single yes/no judged here, BEFORE any parsing, so a miss costs
 * nothing and always falls through to the legacy full-parse path. Keeping the
 * decision pure over named inputs is what makes the bidirectional matrix test
 * (#3617) possible: every condition has a "triggers" row and a "does not
 * trigger" row, with no I/O hiding inside.
 *
 * PR#1 scope is deliberately narrow (dsh × chat-completions/openai wire). The
 * other lanes (anthropic/google/responses) are PR#2 and stay on full-resend.
 */

export const PF_COUNT_HEADER = "x-bili-pf-count";
export const PF_SEQ_HEADER = "x-bili-pf-seq";
/** session_ext key holding this session's authoritative count watermark (T). */
export const PF_SEQ_EXT_KEY = "wm:pfseq";
/** session_ext key holding consecutive mismatch streak (circuit-breaker state). */
export const PF_MISMATCH_EXT_KEY = "wm:pfmismatch";
/** Consecutive mismatches before the session is circuit-broken back to legacy. */
export const PF_BREAK_AFTER = 5;

/** A single request's fastpath-eligibility facts, resolved by the caller. */
export interface FastpathGateInput {
    /** rollout.features.pluginFullResendWatermark enabled for this install. */
    rolloutEnabled: boolean;
    /** pluginMode for this request (x-bili-plugin header / registered agent). */
    pluginMode: boolean;
    /** The plugin agent identity ("dsh" in PR#1 scope); undefined when absent. */
    agent: string | undefined;
    /** Resolved wire protocol ("openai" = chat-completions shape in PR#1 scope). */
    protocol: string | null;
    /** Raw x-bili-pf-count header value as received (undefined if absent). */
    pfCountHeader?: string;
    /** Stored authoritative watermark T for this session (null = never set). */
    storedWatermark: number | null;
    /** storage.unified readable (getStore().replicasAvailable()). */
    storageReadable: boolean;
    /** Another lane already claimed this request (incremental marker, side
     *  request, codex compaction trigger, …) — the fastpath must not stack. */
    divertConflict: boolean;
    /** This session's mismatch streak has already tripped the breaker. */
    circuitBroken: boolean;
    /** At least one active fold block exists (nothing covered ⇒ nothing to save). */
    hasActiveBlocks: boolean;
}

export type FastpathGateReason =
    | "take"
    | "circuit-broken"
    | "divert-conflict"
    | "rollout-off"
    | "not-plugin-mode"
    | "agent-out-of-scope"
    | "protocol-out-of-scope"
    | "no-active-blocks"
    | "header-missing"
    | "header-invalid"
    | "watermark-missing"
    | "watermark-mismatch"
    | "storage-unreadable";

export interface FastpathGateDecision {
    take: boolean;
    reason: FastpathGateReason;
}

/** Parse + validate the echoed count header. A valid value is a non-negative
 *  base-10 integer with no sign, no whitespace, no exponent — anything else is
 *  "invalid" and degrades to legacy. Returns null for missing/invalid. */
export function parsePfCount(raw: string | undefined): number | null {
    if (raw === undefined) return null;
    if (!/^\d+$/.test(raw)) return null;
    const v = Number(raw);
    if (!Number.isSafeInteger(v)) return null;
    return v;
}

/**
 * Decide whether this request takes the watermark fastpath. Precedence is fixed
 * and documented by the reason enum order: the FIRST failing check wins, so a
 * single-condition violation (all others satisfied) names exactly that
 * condition — which is what the bidirectional matrix asserts.
 */
export function decideFastpath(x: FastpathGateInput): FastpathGateDecision {
    const no = (reason: FastpathGateReason): FastpathGateDecision => ({ take: false, reason });
    if (x.circuitBroken) return no("circuit-broken");
    if (x.divertConflict) return no("divert-conflict");
    if (!x.rolloutEnabled) return no("rollout-off");
    if (!x.pluginMode) return no("not-plugin-mode");
    if (x.agent !== "dsh") return no("agent-out-of-scope");
    if (x.protocol !== "openai") return no("protocol-out-of-scope");
    if (!x.hasActiveBlocks) return no("no-active-blocks");
    if (x.pfCountHeader === undefined || x.pfCountHeader === "") return no("header-missing");
    const k = parsePfCount(x.pfCountHeader);
    if (k === null) return no("header-invalid");
    if (x.storedWatermark === null) return no("watermark-missing");
    if (k !== x.storedWatermark) return no("watermark-mismatch");
    if (!x.storageReadable) return no("storage-unreadable");
    return { take: true, reason: "take" };
}
