import type { CoreMessage, CompressionState } from "acp-kernel";
import type { Session } from "./session.js";

/**
 * Orphan block garbage collection.
 *
 * WHY: With content-fingerprint message ids (see src/message-id.ts), a block's
 * `effectiveMessageIds` reference specific message identities. If a client
 * (or another plugin) deletes the original messages that a block compressed,
 * those ids no longer appear in the current visible context. The kernel's
 * rebuild then has no anchor for the block — its summary floats to the top
 * (`insertAt ?? 0`) as an orphan, polluting the model's view with stale
 * summaries of content the client has already discarded.
 *
 * WHAT: After each processTurn we check whether each active block still has at
 * least one effective message id present in the current context. A block that
 * has been *completely* orphaned (zero hits) for `THRESHOLD` consecutive turns
 * gets deactivated. Partial orphans (some ids still present) are left alone —
 * the block is still meaningfully anchored.
 *
 * LIMITS: This only detects *full* orphans. A block with 1 surviving id out of
 * 50 is still "anchored" and kept. That's a deliberate trade-off: deactivating
 * on partial matches would prematurely destroy blocks during normal incremental
 * edits. Full orphaning is the common dangerous case (client deleted a whole
 * summarized range) and the one we must catch.
 */

const ORPHAN_THRESHOLD = 3;

/**
 * Scan active blocks and deactivate those that have been fully orphaned (no
 * effective message id present in `visible`) for ORPHAN_THRESHOLD consecutive
 * turns. Mutates `state` via deactivateBlock when orphans are found.
 *
 * Returns the list of deactivated block ids (for logging).
 */
export function reapOrphanBlocks(
    session: Session,
    visible: CoreMessage[],
    deactivate: (state: CompressionState, blockIds: string[]) => CompressionState,
): { reaped: string[] } {
    if (session.state.blocks.length === 0) return { reaped: [] };
    const presentIds = new Set(visible.map((m) => m.id));
    const reaped: string[] = [];
    for (const block of session.state.blocks) {
        if (!block.active) continue;
        const hasHit = block.effectiveMessageIds.some((id) => presentIds.has(id));
        if (hasHit) {
            if ((block as unknown as { orphanStreak?: number }).orphanStreak) {
                (block as unknown as { orphanStreak?: number }).orphanStreak = 0;
            }
            continue;
        }
        const streak = ((block as unknown as { orphanStreak?: number }).orphanStreak ?? 0) + 1;
        (block as unknown as { orphanStreak?: number }).orphanStreak = streak;
        if (streak >= ORPHAN_THRESHOLD) {
            reaped.push(block.blockId);
        }
    }
    if (reaped.length === 0) return { reaped: [] };
    session.state = deactivate(session.state, reaped);
    for (const id of reaped) session.blockContents.delete(id);
    return { reaped };
}

export type { Session };
