import {
    buildStatusReport,
    defaultCountTokens,
    formatRanges,
    viableRanges,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { conflictEventsOf, formatConflictSection } from "./conflict-watch.js";
import { getBlindTunnelStats } from "./mitm.js";
import { getUnrecognizedPathStats } from "./server/observability.js";
import { ccrEnabled, ccrLoopConfig, contentStoreOf } from "./store.js";
import { coveredRefSpan } from "./decompress-shared.js";
import { preCompactionArchiveOf, type Session } from "./session.js";
import { VERSION } from "./version.js";

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
function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MiB`;
}

export function handleAcpStatus(args: Record<string, unknown>, ctx: AcpStatusCtx): string {
    const scope = typeof args.scope === "string" ? (args.scope as "compressed" | "uncompressed") : undefined;
    const view = typeof args.view === "string" ? (args.view as "ranges" | "messages") : undefined;
    const tool = typeof args.tool === "string" ? args.tool : undefined;
    const sort = typeof args.sort === "string" ? (args.sort as "size" | "time" | "tool" | "age") : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const base = buildStatusReport(ctx.session.state, ctx.messages, defaultCountTokens, {
        scope,
        view,
        tool,
        sort,
        limit,
        meta: {
            pack: ctx.session.meta.activePack ?? "default",
            host: `billion-context ${VERSION}`,
        },
    });
    if (scope) return base;
    const extra: string[] = [];
    try {
        const turn = ctx.core.processTurn({
            messages: ctx.messages,
            state: ctx.session.state,
            config: ccrLoopConfig(ctx.session, ctx.config),
            tokenCount: ctx.session.stats.lastInputTokens,
            renderTags: "none",
            contentStore: contentStoreOf(ctx.session),
        });
        const nudge = turn.nudge;
        if (nudge) {
            extra.push("");
            extra.push(nudge.shouldInject ? `Nudge: ACTIVE — ${nudge.reason}` : `Nudge: idle — ${nudge.reason}`);
            // #847: only advertise ranges the submit gate accepts — the gate
            // counts raw chars (minCompressRange), not tokens, so a range can
            // be "viable" yet deterministically uncompressible.
            const minChars = ctx.config.compress.minCompressRange;
            const ranges = viableRanges(nudge.compressibleRanges).filter((r) => minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars);
            const protectedRanges = nudge.protectedRanges ?? [];
            if (ranges.length > 0 || protectedRanges.length > 0) {
                extra.push("");
                extra.push(formatRanges(ranges, protectedRanges));
            }
        }
    } catch {
        // Base-only report; never fall back to a stale snapshot.
    }
    // #1097: the processTurn above already resolved the envelope when armed
    // (contentStoreOf is idempotent); when disarmed skip the disk read.
    const ccrArmed = ccrEnabled(ctx.session);
    const storeCount = ccrArmed ? Object.keys(contentStoreOf(ctx.session).byRef).length : 0;
    if (ccrArmed && (storeCount > 0 || (ctx.session.stats.retrieveCalls ?? 0) > 0)) {
        const st = ctx.session.stats;
        const calls = st.retrieveCalls ?? 0;
        const hits = st.retrieveHits ?? 0;
        const rate = calls > 0 ? Math.round((hits / calls) * 100) : 0;
        extra.push("");
        const rangeRestores = st.rangeRestores ?? 0;
        const delivered = st.retrieveDelivered ?? 0;
        const dropped = st.retrieveDropped ?? 0;
        extra.push(`STORE (CCR) — ${storeCount} item(s) · ${fmtBytes(st.storedBytes ?? 0)} stored · ${fmtBytes(st.storeBytesSaved ?? 0)} saved on wire · retrieved ${hits}/${calls}${calls > 0 ? ` (${rate}%)` : ""}${delivered > 0 ? ` · delivered ${delivered}` : ""}${dropped > 0 ? ` · dropped ${dropped}` : ""}${rangeRestores > 0 ? ` · range-restored ${rangeRestores}` : ""}`);
    }
    // #1179 CCR v2: block → covered message-ref linkage, so the model can
    // target acp_retrieve / range decompress at individual messages. Gated on
    // arming (#1207 review): with CCR off those refs are unretrievable, so
    // listing them would advertise a capability that doesn't exist.
    if (ccrArmed) {
        const spans: string[] = [];
        for (const b of ctx.session.state.blocks) {
            if (!b.active) continue;
            const s = coveredRefSpan(ctx.session.state, b);
            if (s) spans.push(`${b.blockId}=${s.text}`);
        }
        if (spans.length > 0) {
            extra.push("");
            extra.push(`BLOCK SPANS — ${spans.slice(0, 12).join(" · ")}${spans.length > 12 ? ` (+${spans.length - 12} more)` : ""}`);
        }
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
    // #1206: conflict evidence (third-party compression plugin detected, or
    // runtime signs another compressor rewrote history) — visible here so the
    // user sees it while the session is still recoverable.
    const cevents = conflictEventsOf(ctx.session);
    if (cevents.length > 0) {
        extra.push("");
        extra.push(...formatConflictSection(cevents));
    }
    const blind = getBlindTunnelStats();
    if (blind.total > 0) {
        // #897: CONNECT traffic to non-MITM hosts was blind-relayed — it never
        // entered any session, so "no compressed blocks" can be a routing
        // misconfiguration, not just a short conversation. Surface it here
        // where an operator actually looks when compression appears dead.
        const hosts = Object.entries(blind.hosts)
            .sort((a, b) => b[1] - a[1])
            .map(([h, n]) => `${h}×${n}`)
            .join(", ");
        extra.push("");
        extra.push(`UNDECRYPTED TRAFFIC (instance-level): ${blind.total} CONNECT tunnel(s) to host(s) outside the MITM whitelist were blind-relayed since instance start — that traffic was never decrypted, so it never entered any session and CANNOT be compressed (${hosts}). To compress such a client: add its model domain to "mitm".domains in billion-context.json, restart bili, and make the client trust bili's root CA. Exact counts: GET /__bili/stats → blindTunnels.`);
    }
    const unrec = getUnrecognizedPathStats();
    if (unrec.total > 0) {
        // #1290: requests whose path matched no known protocol were relayed
        // byte-for-byte and never entered a session — a second reason "no
        // compressed blocks" can mean misrouting rather than a short chat.
        const top = Object.entries(unrec.paths)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([p, n]) => `${p}×${n}`)
            .join(", ");
        extra.push("");
        extra.push(`UNRECOGNIZED PATHS (instance-level): ${unrec.total} request(s) to ${Object.keys(unrec.paths).length} path(s) matched no known protocol (/chat/completions, /llm_raw_chat, /v1/messages, /responses, …) since instance start — they were relayed byte-for-byte and CANNOT be compressed (${top}). If you expected compression here, that endpoint's path is not in bili's protocol table. Exact counts: GET /__bili/stats → unrecognizedPaths.`);
    }
    return extra.length > 0 ? `${base}\n${extra.join("\n")}` : base;
}
