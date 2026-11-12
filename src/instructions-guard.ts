/**
 * #6258: instructions size guard for unclaimed lanes.
 *
 * DSH's in-history system-prompt mode (supportsMidConvoSystemMessages)
 * appends a FULL copy of the system prompt on every prompt change instead of
 * replacing the old one (prefix-cache preservation is the intentional tradeoff).
 * pi-ai's getCurrentSystemMessage() then concatenates ALL copies with "\n\n"
 * into body.instructions. OpenAI's Responses API rejects the request when
 * instructions exceeds 1,048,576 characters — the whole session 400s from that
 * turn onward, with no recovery short of a new session.
 *
 * This module provides the shared detection + rescue logic for the two
 * unclaimed lanes where bili sees the body but performs no compression:
 *
 *   1. Passthrough lane (src/server/handle.ts, x-bili-passthrough: 1) —
 *      server-side, body is a Buffer; can decode, inspect, and modify.
 *   2. Direct send (src/agent/native-intercept.ts directSendOrRefuse) —
 *      client-side, body is a string; diagnostic only (the body may be a
 *      stream and modifying it on the fallback path is risky).
 *
 * The root fix belongs to DSH (replace semantics or dedupe in
 * getCurrentSystemMessage, submitted to
 * deepseek-ai/deepseek-harness discussions/13010). This guard is the bili-side
 * backstop: at minimum it makes the failure visible (terminal-level
 * diagnostic); on the passthrough lane it additionally dedupes (keep latest)
 * to rescue the session before the 400.
 */

/** OpenAI Responses API hard limit on the `instructions` field (characters).
 *  A request with instructions.length > this value is rejected with 400. */
export const RESPONSES_INSTRUCTIONS_CHAR_LIMIT = 1_048_576;

/** Result of the instructions size check. */
export interface InstructionsOverflow {
    /** The actual character length of body.instructions. */
    length: number;
    /** The limit that was exceeded. */
    limit: number;
}

/**
 * Check whether a parsed Responses body's `instructions` field exceeds the
 * OpenAI hard limit. Returns the overflow info if it does, null otherwise.
 *
 * Only inspects the top-level `instructions` string field. System content in
 * `body.input` items (role system/developer) is NOT checked here — the DSH
 * in-history mode puts all accumulated copies into `instructions` via
 * pi-ai's getCurrentSystemMessage, not into input items.
 */
export function checkInstructionsOverflow(parsed: unknown): InstructionsOverflow | null {
    if (parsed === null || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    const instructions = rec.instructions;
    if (typeof instructions !== "string") return null;
    if (instructions.length <= RESPONSES_INSTRUCTIONS_CHAR_LIMIT) return null;
    return { length: instructions.length, limit: RESPONSES_INSTRUCTIONS_CHAR_LIMIT };
}

/**
 * Dedupe the `instructions` field by keeping only the latest copy.
 *
 * DSH's in-history mode appends a full system-prompt copy on every change;
 * pi-ai concatenates all copies with "\n\n" into instructions. This function
 * splits on "\n\n" and keeps only the LAST part (the most recent copy), which
 * is the one that reflects the current system prompt state.
 *
 * Best-effort: if the copies themselves contain "\n\n" (paragraph breaks in
 * the system prompt), the split produces more parts than there are copies,
 * and the last part is just the final paragraph of the latest copy. Even so,
 * a truncated system prompt that fits under the limit is strictly better than
 * a 400 that kills the whole session. The root fix (DSH replace semantics or
 * pi-ai dedupe) makes this rescue unnecessary; this is the backstop.
 *
 * Returns a NEW object (the input is not mutated). If no dedup is needed
 * (instructions is not a string, or is under the limit, or has no "\n\n"
 * separator), returns the original object unchanged.
 */
export function dedupInstructionsKeepLatest(parsed: unknown): { body: unknown; modified: boolean } {
    if (parsed === null || typeof parsed !== "object") return { body: parsed, modified: false };
    const rec = parsed as Record<string, unknown>;
    const instructions = rec.instructions;
    if (typeof instructions !== "string") return { body: parsed, modified: false };
    if (instructions.length <= RESPONSES_INSTRUCTIONS_CHAR_LIMIT) return { body: parsed, modified: false };
    const parts = instructions.split("\n\n");
    if (parts.length <= 1) return { body: parsed, modified: false };
    const latest = parts[parts.length - 1];
    if (latest.length >= instructions.length) return { body: parsed, modified: false };
    const body: Record<string, unknown> = { ...rec, instructions: latest };
    return { body, modified: true };
}
