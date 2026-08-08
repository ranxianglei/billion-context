import { hashId } from "./util.js";

/**
 * Derive a stable, content-based message id.
 *
 * PROBLEM: none of the three wire protocols (Anthropic Messages, OpenAI Chat
 * Completions, OpenAI Responses) attach a stable id to request-side message
 * items. Historically each converter used `raw-${idx}` — a *position* index,
 * not an identity. As soon as a client deletes/reorders messages (other plugins
 * summarizing away old turns, multi-agent setups, etc.) the index drifts:
 * downstream ids shift, so
 *   - assignRefs reuses stale `byRaw` entries, hiding new messages, and
 *   - compression `effectiveMessageIds` start pointing at the *wrong* messages,
 *     silently swallowing live content under an unrelated summary.
 *
 * FIX: derive the id from a SHA-256 of the message identity:
 *   role + contentType + toolCallId + toolName + text
 * Two messages with identical identity collide. To keep duplicates distinct
 * (and avoid `covered` sets collapsing unrelated turns onto one id) we append a
 * within-conversation *cluster index* `_N`: the Nth occurrence of the same
 * identity, counting from 0 in arrival order.
 *
 * Trade-off vs a real client id:
 *   - deleting a duplicated message only disturbs the cluster of that identity
 *     (local damage), never the whole downstream (global damage like position).
 *   - fully distinct messages are completely immune to reordering/deletion.
 *
 * `idx` is passed purely to break ties *within a single conversion pass*; it is
 * not part of the identity, so two passes over the same content produce the
 * same cluster numbering (deterministic).
 */
export function deriveMessageId(
    role: string,
    contentType: string,
    text: string,
    options: {
        toolCallId?: string;
        toolName?: string;
    } = {},
): string {
    const seed = `${role}|${contentType}|${options.toolCallId ?? ""}|${options.toolName ?? ""}|${text}`;
    return "h_" + hashId(seed);
}

/**
 * Stateful cluster counter. Each converter instantiates one per conversion
 * pass; it tracks how many times each base identity has been seen so that the
 * Nth duplicate gets a `_${N}` suffix.
 */
export class ClusterCounter {
    private counts = new Map<string, number>();

    next(baseId: string): string {
        const n = this.counts.get(baseId) ?? 0;
        this.counts.set(baseId, n + 1);
        return n === 0 ? baseId : `${baseId}_${n}`;
    }
}
