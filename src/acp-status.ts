import {
    buildStatusReport,
    estimateTokensFast,
    formatRanges,
    viableRanges,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { preCompactionArchiveOf, type Session } from "./session.js";

export interface AcpStatusCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
}

// The ranges/nudge section is recomputed from live session state on every
// call instead of reading the prepare-time nudge snapshot: a successful
// compress mutates state mid-turn without re-running prepare, so the snapshot
// goes stale and lists already-compressed refs as compressible (#389).
// processTurn is pure (nodes return new objects), so the returned state is
// intentionally NOT adopted — this is a read-only recompute.
export function handleAcpStatus(args: Record<string, unknown>, ctx: AcpStatusCtx): string {
    const scope = typeof args.scope === "string" ? (args.scope as "compressed" | "uncompressed") : undefined;
    const view = typeof args.view === "string" ? (args.view as "ranges" | "messages") : undefined;
    const tool = typeof args.tool === "string" ? args.tool : undefined;
    const sort = typeof args.sort === "string" ? (args.sort as "size" | "time" | "tool" | "age") : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const base = buildStatusReport(ctx.session.state, ctx.messages, estimateTokensFast, { scope, view, tool, sort, limit });
    if (scope) return base;
    const extra: string[] = [];
    try {
        const turn = ctx.core.processTurn({
            messages: ctx.messages,
            state: ctx.session.state,
            config: ctx.config,
            tokenCount: ctx.session.stats.lastInputTokens,
            renderTags: "none",
        });
        const nudge = turn.nudge;
        if (nudge) {
            extra.push("");
            extra.push(nudge.shouldInject ? `Nudge: ACTIVE — ${nudge.reason}` : `Nudge: idle — ${nudge.reason}`);
            const ranges = viableRanges(nudge.compressibleRanges);
            const protectedRanges = nudge.protectedRanges ?? [];
            if (ranges.length > 0 || protectedRanges.length > 0) {
                extra.push("");
                extra.push(formatRanges(ranges, protectedRanges));
            }
        }
    } catch {
        // Base-only report; never fall back to a stale snapshot.
    }
    const archive = preCompactionArchiveOf(ctx.session);
    const archivedIds = Object.keys(archive);
    if (archivedIds.length > 0) {
        extra.push("");
        extra.push(`PRE-COMPACTION ARCHIVE — ${archivedIds.length} block(s): content was replaced by the client's native compaction summary, so it is no longer in the session history and decompress is unavailable.`);
        for (const id of archivedIds) {
            extra.push(`  ${id} — ${archive[id].reason}`);
        }
    }
    return extra.length > 0 ? `${base}\n${extra.join("\n")}` : base;
}
