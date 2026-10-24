/**
 * #4242 / #4192: state hydration is the single source of truth for which
 * CompressionState fields survive persistence. mergeState() moved here so
 * both the JSON envelope loader (persist.ts) and the unified view builder
 * (storage/ingest.ts) consume ONE implementation, and the field list is
 * DERIVED from it mechanically — Object.keys(mergeState(fresh)) — so a field
 * added to the literal appears in kstate serialization, view rebuild and
 * digest hashing automatically. The hand-kept MERGE_STATE_FIELDS list is
 * gone; it had already drifted (sweptOrphanCallIds,
 * pendingOrphanSweepMinRef — the #2388 explicit-field-clone disease).
 */
// Relative kernel-source import, NOT the "acp-kernel" package: this module is
// in the storage seam's load graph, which the CI mysql-contract lane runs with
// an UNBUILT kernel (install --ignore-scripts, no build step) — the package
// form resolves to kernel/dist and crashes that lane at import time (#4249).
import { createInitialState } from "../kernel/src/state.js";
import type { CompressionState } from "../kernel/src/types.js";
import { scrubTurnSeparatorIds } from "./turn-separator.js";

/** Forward-compat: merge a parsed state with a fresh one so missing fields
 * (added in later versions) get sane defaults instead of `undefined`. */
export function mergeState(parsed: CompressionState): CompressionState {
    const fresh = createInitialState();
    return {
        // #2627: heal persisted state written before the turn-separator fix —
        // those blocks' coverage carries outbound-only acp_turn_sep_* ids that
        // no resent history can ever contain; scrubbing at hydration is what
        // stops live long sessions from alarming forever after an upgrade.
        blocks: (() => { const blocks = parsed.blocks ?? fresh.blocks; scrubTurnSeparatorIds(blocks); return blocks; })(),
        messageRefs: parsed.messageRefs ?? fresh.messageRefs,
        nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
        stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
        nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
        nextRunId: parsed.nextRunId ?? fresh.nextRunId,
        tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
        lastPassIds: parsed.lastPassIds ?? fresh.lastPassIds,
        hiddenOrphanRefs: parsed.hiddenOrphanRefs ?? fresh.hiddenOrphanRefs,
        // #2362: without this a restart forgets which refs are dead and the
        // model re-learns each one by failing a compress call again.
        deadRefs: parsed.deadRefs ?? fresh.deadRefs,
        refLedgerAligned: parsed.refLedgerAligned ?? fresh.refLedgerAligned,
        terminalStreak: parsed.terminalStreak ?? fresh.terminalStreak,
        nextRuleId: parsed.nextRuleId ?? fresh.nextRuleId,
        // Without this, a restart re-exposes absorbed tool outputs: state
        // resurrects with absorbed=[] and hideAbsorbedMessages has nothing to hide.
        absorbed: parsed.absorbed ?? fresh.absorbed,
        rules: parsed.rules ?? fresh.rules,
        // #3769: fold-gated orphan-sweep bookkeeping must survive hydration —
        // dropping sweptOrphanCallIds resurrects already-cleaned pairs after a
        // restart (mid-history rewrite = cache break); the pending marker is
        // transient, losing it only defers the sweep to the next fold.
        sweptOrphanCallIds: parsed.sweptOrphanCallIds ?? fresh.sweptOrphanCallIds,
        pendingOrphanSweepMinRef: parsed.pendingOrphanSweepMinRef ?? fresh.pendingOrphanSweepMinRef,
        // #3939 ③/#3691: the emergency-truncate latch must survive hydration —
        // dropping it re-exposes clipped bytes mid-history after a restart,
        // rewriting the still-cached prefix on the first post-restart turn.
        emergencyTruncateLatch: parsed.emergencyTruncateLatch ?? fresh.emergencyTruncateLatch,
        // #3939 ②/#3805: the render deferral must survive hydration — losing
        // it stamps migration tags onto still-cached carriers right after a
        // restart (a silent mid-history rewrite with no fold in sight).
        renderDeferredRefs: parsed.renderDeferredRefs ?? fresh.renderDeferredRefs,
        // #3939 ⑤: the view latch must survive hydration — losing it
        // re-derives transform output on still-cached carriers right after a
        // restart (silent mid-history rewrite, no fold in sight).
        viewLatches: parsed.viewLatches ?? fresh.viewLatches,
        viewLatchConfigDigest: parsed.viewLatchConfigDigest ?? fresh.viewLatchConfigDigest,
    };
}

/**
 * Every CompressionState field mergeState() emits, in literal order. Derived
 * at module load from the merge itself — no second list to keep in sync
 * (#4192). Consumers: kstate_json serialization order (storage/ingest.ts),
 * unified view rebuild, digest key order.
 */
export const COMPRESSION_STATE_FIELDS: readonly (keyof CompressionState)[] =
    Object.keys(mergeState(createInitialState())) as (keyof CompressionState)[];
