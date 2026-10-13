/**
 * #2612/#2728: Claude Code native compaction guard.
 *
 * Claude Code's own compaction — manual /compact, auto-compact (when the
 * managed block's DISABLE_AUTO_COMPACT=1 is not in force), and precomputed
 * compression — sends a summarize request whose FINAL user message carries the
 * fixed instruction template (CC 2.1.x): "Wrap your summary in
 * <summary></summary> tags" + "REMINDER: Do NOT call any tools. Respond with
 * plain text only — an <analysis> block followed by a <summary> block."
 * Letting that call execute through bili has no good outcome (#2612/#2728):
 *
 *   - Success → CC rewrites its local transcript to the summary while bili's
 *     fold ledger still anchors the raw history: an unannounced history
 *     rewrite. The three read faces split (status shows blocks that no longer
 *     match what CC sends, search misses, decompress returns text CC can no
 *     longer place) and the session drifts into the silent-desync family.
 *   - The moment users actually reach for it is the moment things are already
 *     broken (folds lost, context re-inflated): the request re-sends the FULL
 *     raw history (multi-M tokens upstream — 400 or real money) and even its
 *     compliant reply used to be broken by the #2303 draft-tail retry
 *     (fixed for the forwarding path by #2619).
 *
 * So the call is refused locally, mirroring the dsh twin (#1729/#2193,
 * src/server/dsh-compaction-guard.ts): never forwarded, kernel state
 * untouched, CC keeps its transcript verbatim and shows the refusal through
 * its own "Error during compaction" surface. The managed install block
 * already sets DISABLE_AUTO_COMPACT=1 (applyClaudeManagedBlock), so
 * auto-compact does not fire under a bili-managed CC; this guard is the wire
 * backstop covering manual /compact, precomputed compression, users who
 * re-enabled the env, and CC installs routed through bili without the
 * managed block (explicit ANTHROPIC_BASE_URL).
 *
 * STRICTNESS vs the #2619 retry-exemption detector (degenerate-turn.ts's
 * requestExpectsProseSummary, which matches EITHER phrase): the guard
 * requires BOTH instruction phrases in the final user message. The exemption
 * is fail-open by design (a missed exemption costs one wasted retry); this
 * guard refuses a turn outright, so a user legitimately ASKING for that
 * output format ("summarize this, use an <analysis> block followed by a
 * <summary> block") must not be 403'd. The full CC template always carries
 * both lines; one phrase alone is human paraphrase, not the machine
 * template. A reworded CC template degrades to a miss → the request
 * forwards and #2619's exemption still protects the retry path (fail-open,
 * same doctrine as the dsh marker tracker).
 *
 * PROTOCOL COVERAGE: openai + anthropic + responses, all marker-decisive on
 * the final user text (messages[] / input[]) — CC speaks anthropic natively,
 * but CC-behind-a-router installs (claude-code-router and friends) translate
 * to the other wires while keeping the template text. Google stays out of
 * scope (CC speaks no Google wire). The #1117 passthrough lane is
 * deliberately NOT guarded: it exists for unattributed in-process callers
 * (dsh's agentless background compaction, #2709), never for external HTTP
 * clients like CC.
 */

import { lastResponsesInputUserText, lastUserMessageText } from "./dsh-compaction-guard.js";

/** The two production phrases of CC's compaction instruction, tracked per CC
 *  release like MAIN_SYSTEM_PREFIXES (#970). Case-insensitive for
 *  #1731-style drift. Angle brackets hex-escaped per KDD #2. */
const CC_SUMMARY_TAG_PHRASE = /Wrap your summary in \x3csummary\x3e\x3c\/summary\x3e tags/i;
const CC_ANALYSIS_BLOCK_PHRASE = /an \x3canalysis\x3e block followed by a \x3csummary\x3e block/i;

/** True when the request's FINAL user message carries the full CC compaction
 *  instruction template (BOTH phrases — see STRICTNESS above). `parsed` is
 *  the parsed wire body; `protocol` the lane's wire protocol. */
export function isClaudeCompactionCall(protocol: string | null, parsed: unknown): boolean {
    let finalUser: string | undefined;
    if (protocol === "responses") finalUser = lastResponsesInputUserText(parsed);
    else if (protocol === "openai" || protocol === "anthropic") finalUser = lastUserMessageText(protocol, parsed);
    if (finalUser === undefined) return false;
    return CC_SUMMARY_TAG_PHRASE.test(finalUser) && CC_ANALYSIS_BLOCK_PHRASE.test(finalUser);
}

export type Refusal = { status: number; body: unknown };

const REFUSAL_MESSAGE =
    `Claude Code native compaction refused by billion-context: bili owns compression on this lane (#2612/#2728). ` +
    `A native <summary> rewrite desynchronizes Claude Code's transcript from bili's fold ledger and re-sends the full raw history upstream. ` +
    `Nothing was executed and your transcript is unchanged. ` +
    `bili folds context automatically at its threshold; for a manual fold, ask the model to run the compress tool. ` +
    `To allow Claude Code's native compaction anyway, opt in explicitly: "claude": { "allowNativeCompaction": true } in the bili config file, or env BILI_ALLOW_CLAUDE_COMPACTION=1.`;

/** Protocol-shaped refusal body (same shape contract as the #1729 dsh twin:
 *  anthropic error envelope for the anthropic wire, an openai-style error
 *  with a stable code otherwise). 403: a policy refusal, not a malformed
 *  request — CC's "Error during compaction" surface renders the message and
 *  the session continues; retry logic must not treat it as transient. */
export function claudeCompactionRefusal(protocol: string): Refusal {
    if (protocol === "anthropic") {
        return {
            status: 403,
            body: { type: "error", error: { type: "invalid_request_error", message: REFUSAL_MESSAGE } },
        };
    }
    return {
        status: 403,
        body: {
            error: {
                type: "server_error",
                code: "claude_compaction_refused",
                message: REFUSAL_MESSAGE,
                retryable: false,
            },
        },
    };
}
