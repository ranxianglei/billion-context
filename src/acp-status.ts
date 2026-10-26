import {
    buildStatusReport,
    countMessageTokens,
    defaultCountTokens,
    formatRanges,
    viableRanges,
    type CompressionCore,
    type Config,
    type CoreMessage,
    type NudgeDecision,
    type CompressibleRange,
} from "acp-kernel";
import { keepaliveStatusFor } from "./cache-keepalive.js";
import { conflictClientOf, conflictEventsOf, formatConflictSection } from "./conflict-watch.js";
import { getOpenUpstreamCircuits } from "./upstream-alerts.js";
import { activeThrottleHolds } from "./upstream-throttle.js";
import { dshLedgerFloorTokens } from "./server/budget.js";
import { getBlindTunnelStats } from "./mitm.js";
import { pckAblations } from "./pck-probe.js";
import { getUnrecognizedPathStats } from "./server/observability.js";
import { ccrEnabled, ccrLoopConfig, contentStoreOf } from "./store.js";
import { coveredRefSpan } from "./decompress-shared.js";
import { describeUncoveredRuns, shortTokenCount, uncoveredHistoryRuns } from "./uncovered.js";
import { forkAdoptionSkippedOf } from "./fork-adoption.js";
import { preCompactionArchiveOf, statusInputBaseline, type Session } from "./session.js";
import { compressBreakerDetail, compressLastFailureCause } from "./stream.js";
import { describeAdvisory, getAdvisoryState } from "./advisory.js";
import { getUpdateVisibility, updateBannerPayload } from "./update-notes.js";
import { VERSION, BUILD_COMMIT } from "./version.js";
import { isExternalSummaryBlock } from "./external-summary-marker.js";
import { storageStatusLabel } from "./persist.js";
import { storageStatusWire } from "./storage/runtime-status.js";
import { toolOk, type ProxyToolResult } from "./proxy-tool-result.js";

interface AcpStatusCtx {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    // #3236: the exact array class applyCompression runs on for this lane.
    // Without it, processTurn's eligibility screening and the uncompressed
    // view's foldability flags judge a different array class than execute.
    // LoopCtx/RewriteCtx both carry it structurally; undefined when the lane
    // has no split view (messages IS the apply class).
    compressMessages?: CoreMessage[];
}

// #3192: the submit gate rejects any range that still cites a ref recorded DEAD
// (the client rewrote/dropped those messages), but the eligibility view
// (buildCompressibleRanges) never reads state.deadRefs — so without this filter
// the hint/acp_status advertise exactly the doomed ranges the gate then refuses,
// contradicting the "recorded as DEAD" receipt in the same message. Drop any
// advertised range whose [startRef..endRef] span contains a dead ref. No-op when
// deadRefs is empty; conservative — drops the whole span rather than splitting
// around the dead cell (the kernel-level split is the more fundamental home).
export function excludeDeadRefRanges<T extends { startRef: string; endRef: string }>(ranges: T[], deadRefs?: string[]): T[] {
    if (!deadRefs || deadRefs.length === 0) return ranges;
    const deadNumbers: number[] = [];
    for (const ref of deadRefs) {
        const m = /^m(\d+)$/i.exec(ref);
        if (m) deadNumbers.push(Number(m[1]));
    }
    if (deadNumbers.length === 0) return ranges;
    return ranges.filter((range) => {
        const s = /^m(\d+)$/i.exec(range.startRef);
        const e = /^m(\d+)$/i.exec(range.endRef);
        if (!s || !e) return true;
        const start = Number(s[1]);
        const end = Number(e[1]);
        return !deadNumbers.some((n) => n >= start && n <= end);
    });
}

export function liveCompressionRanges(ctx: AcpStatusCtx): { nudge: NudgeDecision; ranges: CompressibleRange[] } | undefined {
    const turn = ctx.core.processTurn({
        messages: ctx.messages,
        state: ctx.session.state,
        config: ccrLoopConfig(ctx.session, ctx.config),
        tokenCount: statusInputBaseline(ctx.session),
        renderTags: "none",
        contentStore: contentStoreOf(ctx.session),
        applyView: ctx.compressMessages,
    });
    if (!turn.nudge) return undefined;
    const minChars = ctx.config.compress.minCompressRange;
    return {
        nudge: turn.nudge,
        ranges: excludeDeadRefRanges(viableRanges(turn.nudge.compressibleRanges).filter((r) => minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars), ctx.session.state.deadRefs),
    };
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

// #2366: usage fraction at which the PRESSURE NOTE becomes worth showing —
// below it the window still has headroom and "stop folding" is noise.
const PRESSURE_NOTE_USAGE_FRACTION = 0.6;
// #2362: render dead refs as compact ref spans ("m09539, m09543–m09558").
function formatDeadRefSpans(refs: string[]): string {
    const nums = refs
        .map((r) => Number(r.replace(/\D/g, "")))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    const f = (n: number): string => `m${String(n).padStart(5, "0")}`;
    const spans: string[] = [];
    let start = -1;
    let prev = -1;
    const flush = (): void => {
        if (start < 0) return;
        spans.push(start === prev ? f(start) : `${f(start)}–${f(prev)}`);
    };
    for (const n of nums) {
        if (prev >= 0 && n === prev + 1) {
            prev = n;
            continue;
        }
        flush();
        start = n;
        prev = n;
    }
    flush();
    return spans.length > 8 ? `${spans.slice(0, 8).join(", ")} (+${spans.length - 8} more)` : spans.join(", ");
}

// #3105: one history rewrite can archive hundreds of blocks sharing one reason
// (#2695); an archived block can be neither compressed nor decompressed, so the
// default aggregates by reason (constant size) and per-block ids are opt-in +
// capped instead of listed verbatim (~20KB receipts before).
const PRE_COMPACT_ARCHIVE_DETAIL_CAP = 50;

function formatPreCompactionArchive(archive: Record<string, { at: number; reason: string }>, detail: boolean): string[] {
    const ids = Object.keys(archive);
    const lines: string[] = [
        `PRE-COMPACTION ARCHIVE — ${ids.length} block(s): content left the session history (client native compaction or an unannounced history rewrite) and decompress is unavailable.`,
    ];
    if (detail) {
        const shown = ids.slice(0, PRE_COMPACT_ARCHIVE_DETAIL_CAP);
        for (const id of shown) lines.push(`  ${id} — ${archive[id]!.reason}`);
        if (ids.length > shown.length) lines.push(`  (+${ids.length - shown.length} more; showing first ${shown.length} of ${ids.length})`);
        return lines;
    }
    const byReason = new Map<string, number>();
    for (const id of ids) {
        const reason = archive[id]!.reason;
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${count}: ${reason}`);
    }
    lines.push(`  per-block ids + reasons: acp_status({ archiveDetail: true })`);
    return lines;
}

export function handleAcpStatus(args: Record<string, unknown>, ctx: AcpStatusCtx): ProxyToolResult {
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
        // #3236: screen uncompressed rows through the same projection apply
        // executes — on the exact array class this lane applies on.
        config: ccrLoopConfig(ctx.session, ctx.config),
        originalMessages: ctx.compressMessages ?? ctx.messages,
        meta: {
            pack: ctx.session.meta.activePack ?? "default",
            host: `billion-context ${VERSION} (${BUILD_COMMIT})`,
        },
    });
    if (scope) return toolOk(base);
    const extra: string[] = [];
    // #3925 → #3011 C9: a fork that started with zero inherited blocks used to
    // be invisible here — "COMPRESSED BLOCKS — none" reads as "nothing folded
    // yet", not "inheritance was skipped". Name the gap and its recovery path:
    // the lineage link recorded at fork detection means a bili restart lets the
    // startup sweep inherit the parent's blocks. Suppressed once any active
    // block exists (the gap is closed by then, however it was closed).
    const forkSkipped = forkAdoptionSkippedOf(ctx.session);
    if (forkSkipped && !ctx.session.state.blocks.some((b) => b.active)) {
        extra.push("");
        extra.push(`FORK ADOPTION SKIPPED — this session forked from ${forkSkipped.parentId} with ${forkSkipped.blocks} parent block(s) (~${Math.round(forkSkipped.tokens / 1000)}K tokens) NOT inherited because forkAdoption is disabled; the parent's already-folded history replays raw and will re-fold from scratch. Set "forkAdoption": true (or BILI_FORK_ADOPTION=1) and restart bili — the recorded lineage link lets the startup sweep inherit those blocks.`);
    }
    // #2366: everything in the report above is LOCAL ESTIMATES (defaultCountTokens);
    // on CJK-heavy routes upstream billing runs 2–4× higher, so an agent judging
    // pressure from those figures misreads a filling window as healthy and folds
    // late, when little compressible mass is left. Surface the usage-grade reading
    // next to the estimate view — statusInputBaseline's provenance contract, the
    // same number the nudge decision runs on — and flag the ratio when it diverges
    // hard. Never-reporting upstreams have no anchor → no line.
    const billed = statusInputBaseline(ctx.session);
    if (billed > 0) {
        let estTotal = 0;
        // #2407: count host-projected thinking mass (countMessageTokens) so the
        // ratio stays honest on thinking routes — same caliber as the per-message
        // breakdown the kernel renders above.
        for (const m of ctx.messages) estTotal += countMessageTokens(m, defaultCountTokens);
        // Billed input covers system+tools too (and images); the est view must
        // carry the same overhead — every prepare site keeps
        // metadata.systemPromptTokens current — or every system-heavy session
        // reads as divergence with no tokenizer gap behind it.
        const sysOverhead = ctx.session.metadata?.systemPromptTokens;
        if (typeof sysOverhead === "number" && sysOverhead > 0) estTotal += sysOverhead;
        const srcLabel = ctx.session.stats.lastInputTokensSource === "overflow-arm" ? "overflow arm (bounded)" : "upstream usage";
        let billedLine = `BILLED INPUT (${srcLabel}): ${billed} tok`;
        const measuredAt = ctx.session.metadata?.contextTokensAt;
        if (typeof measuredAt === "number") {
            const ageMin = Math.round((Date.now() - measuredAt) / 60_000);
            if (ageMin >= 2) billedLine += `, measured ${ageMin}m ago`;
        }
        if (estTotal > 0) billedLine += ` · est-view total ${estTotal} tok · ratio ${(billed / estTotal).toFixed(1)}×`;
        extra.push("");
        extra.push(billedLine);
        if (estTotal > 0 && billed / estTotal >= 1.5) {
            extra.push("NOTE: the token figures in the report above are local estimates and run well below what upstream actually bills (tokenizer-dependent; CJK-heavy content is the usual cause). Judge context pressure from BILLED INPUT; use the breakdown only to locate what to compress.");
        }
    }
    // #3376: idle cache-keepalive state — only-when-observed (absent = zero
    // bytes), so a long-idle cache hit is explainable instead of reading as luck.
    const keepalive = keepaliveStatusFor(ctx.session.id);
    if (keepalive) {
        const cadLabel = keepalive.cadenceMs >= 60_000 ? `${Math.round(keepalive.cadenceMs / 60_000)}min` : `${Math.round(keepalive.cadenceMs / 1000)}s`;
        let kaLine = `CACHE KEEPALIVE: armed tier=${keepalive.tierLabel} cadence=${cadLabel} · pings=${keepalive.pingCount}`;
        if (keepalive.lastHitAt !== undefined) kaLine += ` · last-hit ${Math.max(0, Math.round((Date.now() - keepalive.lastHitAt) / 60_000))}m ago`;
        extra.push("");
        extra.push(kaLine);
    }
    // #2432: while the compress circuit breaker is armed, advertising ranges
    // here contradicts the breaker receipt ("STOP calling compress now") and
    // feeds the exact retry loop the breaker exists to kill — every model that
    // follows the list fails the same way and climbs the counter. The receipt
    // wording stays verbatim (#2146 owner decision); this surface gets the
    // armed state instead, with the counter visible (issue expected behavior 4).
    const breaker = compressBreakerDetail(ctx.session);
    // #2451 review (v2): the table is always reported — see the comment at
    // the formatRanges call site for the live-by-construction argument. These
    // flags only pick WHICH honest annotation rides along: a substrate-
    // destruction attribution arms the receipt's single recovery step ("run
    // acp_status once, then compress ONLY a range it currently reports as
    // compressible; one success clears this breaker"), so the armed note must
    // point at the live table; every other cause mirrors the receipt's STOP
    // order instead of inventing a second command (#2360 two-orders shape).
    const lastCause = compressLastFailureCause(ctx.session);
    const staleRef = lastCause !== undefined && lastCause.startsWith("stale-ref");
    const substrateDestroyed = lastCause !== undefined && lastCause.startsWith("substrate-destruction");
    let offeredSpans: Array<{ startRef: string; endRef: string }> | undefined;
    try {
        const live = liveCompressionRanges(ctx);
        if (live) {
            const { nudge, ranges } = live;
            offeredSpans = ranges;
            extra.push("");
            extra.push(nudge.shouldInject ? `Nudge: ACTIVE — ${nudge.reason}` : `Nudge: idle — ${nudge.reason}`);
            // #2366: high billed pressure + exhausted compressible mass is the
            // deadlock invisible from the estimate view alone — tell the agent
            // further folding is futile (each fold rewrites the prefix and
            // forfeits the cache hit for almost-nothing reclaimed).
            if (!nudge.shouldInject && nudge.contextUsage >= PRESSURE_NOTE_USAGE_FRACTION && nudge.breakdown.maxPending < nudge.breakdown.nudgeGrowthTokens) {
                extra.push(`PRESSURE NOTE: billed input sits at ${Math.round(nudge.contextUsage * 100)}% of the ${ctx.config.modelContextLimit}-token limit while max compressible mass is only ~${nudge.breakdown.maxPending} tokens — little left to fold. Repeated small folds rewrite the prefix (forfeiting cache hits) while reclaiming almost nothing; continue the task instead of folding again unless pressure climbs further.`);
            }
            // #847: only advertise ranges the submit gate accepts — the gate
            // counts raw chars (minCompressRange), not tokens, so a range can
            // be "viable" yet deterministically uncompressible.
            const protectedRanges = nudge.protectedRanges ?? [];
            // #2451 review (v2): the table is ALWAYS reported. It is live by
            // construction — buildCompressibleRanges (kernel/src/recommend.ts)
            // derives refs from the CURRENT resent view only (byRaw[msg.id]),
            // after screening covered/media/protected/withdrawn messages — so
            // an advertised range always anchors. Hiding it behind
            // cause-string policy is how the receipt-vs-status contradiction
            // (#2451 M2) was born; anti-loop pressure belongs to the receipts
            // (which carry the STOP order), not to lying by omission here.
            if (ranges.length > 0 || protectedRanges.length > 0) {
                extra.push("");
                extra.push(formatRanges(ranges, protectedRanges));
            }
        }
    } catch {
        // Base-only report; never fall back to a stale snapshot.
    }
    // #4331: uncovered history — contiguous runs outside every active block AND
    // outside the live offer above (older than the protected recent window).
    // They keep going upstream raw while no surface names them; additive
    // section, rendered only when non-trivial. Advisory: any failure skips it.
    try {
        const runs = uncoveredHistoryRuns({
            core: ctx.core,
            messages: ctx.messages,
            state: ctx.session.state,
            config: ccrLoopConfig(ctx.session, ctx.config),
            tokenCount: billed,
            contentStore: contentStoreOf(ctx.session),
            applyView: ctx.compressMessages,
            actionableSpans: offeredSpans ?? [],
            normalRanges: offeredSpans,
        });
        if (runs.length > 0) {
            const totalMsgs = runs.reduce((s, r) => s + r.count, 0);
            const totalTok = runs.reduce((s, r) => s + r.tokens, 0);
            extra.push("");
            extra.push(`UNCOVERED HISTORY — ${totalMsgs} msg(s) across ${runs.length} run(s), ${shortTokenCount(totalTok)} tok, sit outside every active block and are absent from the Compressible-ranges list above (older than the protected recent window): ${describeUncoveredRuns(runs)}. They keep going upstream raw (runs may sit below the fold-size gate — named for visibility, not as fold suggestions); inspect their rows with scope:"uncompressed".`);
        }
    } catch {
        // Advisory section; never break the status report.
    }
    // #2362: dead refs — known to the session but no longer backed by any
    // visible or folded message (client history rewrite / host-native
    // compaction). Failure receipts point the model at acp_status, so this is
    // the canonical surface where the dead set must be visible.
    const deadRefs = ctx.session.state.deadRefs;
    if (deadRefs !== undefined && deadRefs.length > 0) {
        extra.push("");
        extra.push(`DEAD REFS — ${deadRefs.length} ref(s) no longer back any visible or folded message (the client history no longer carries them — host-native compaction or a bulk rewrite). Ranges citing them can NEVER compress; target only the live refs listed above: ${formatDeadRefSpans(deadRefs)}`);
    }
    // #4458: host-native compaction landed under this session — an explicit per-session
    // marker so an operator/agent can tell "the host compacted this conversation" from
    // "bili folded it" BEFORE a follow-up call burns a ref minted before the boundary.
    // Display-only; the boundary record is set server-side by every prepare/relay path in
    // BOTH compression modes, so the marker is lane-neutral (hermes/codex/omp/...).
    const nativeBnd = ctx.session.metadata.nativeCompactionBoundary;
    if (nativeBnd && typeof nativeBnd === "object") {
        const bnd = nativeBnd as { at?: number; pendingRebase?: boolean; rebasedAt?: number };
        if (typeof bnd.at === "number") {
            const lane = conflictClientOf(ctx.session);
            const atIso = new Date(bnd.at).toISOString();
            if (bnd.pendingRebase === true) {
                extra.push("");
                extra.push(`HOST-NATIVE COMPACTION — the client (${lane ?? "unknown lane"}) compacted this conversation natively at ${atIso}; bili has NOT yet rebased onto the compacted view (the rebase lands on the next turn). Refs minted before this boundary stop resolving once it completes — compress only live refs.`);
            } else {
                const rebasedIso = typeof bnd.rebasedAt === "number" ? new Date(bnd.rebasedAt).toISOString() : "?";
                extra.push("");
                extra.push(`HOST-NATIVE COMPACTION — the client (${lane ?? "unknown lane"}) compacted this conversation natively at ${atIso} and bili rebased onto it at ${rebasedIso}. Refs minted before that boundary no longer resolve — compress only the live refs listed above (DEAD REFS names which ones died).`);
            }
        }
    }
    if (breaker) {
        extra.push("");
        extra.push(`COMPRESS CIRCUIT BREAKER: ARMED — consecutiveFailures: ${breaker.n} / ${breaker.threshold}. Disarms on one successful compress or ${breaker.decayMinutes} min without further failures.`);
        if (substrateDestroyed) {
            extra.push("Last failures were attributed to substrate-destruction (an out-of-band history rewrite). The Compressible-ranges list above was re-derived from the CURRENT resent view: per the receipt, compress ONLY a range listed there — one success clears this breaker. If no ranges are listed, continue the task without compressing.");
        } else {
            extra.push("The Compressible-ranges list above was re-derived from the current view — the table is live; it is the earlier attempts that failed, not these ranges. Per the failure receipt: do not attempt to compress now; continue the task.");
        }
    }
    // #2451 review (v2): the standalone paragraphs state the failure CAUSE and
    // its recovery path; they no longer claim the list is suppressed (it never
    // is now). The fresh-conversation advice stays pre-arming only — when the
    // breaker is armed on substrate-destruction the tailored armed line above
    // IS the recovery order, and a second order would recreate the
    // two-orders-in-one-output #2360 shape.
    if (staleRef || (substrateDestroyed && breaker === undefined)) {
        extra.push("");
        if (staleRef) {
            // #3302: "stale-ref" covers earlier-generation refs, typos AND
            // sparse-space gaps — the per-failure cause above names the sub-case;
            // don't over-assert generation here.
            extra.push(`FOLD BASE GENERATION MISMATCH — last compress failure: ${lastCause}. The refs that failed do not exist in this session's current ref space; the Compressible-ranges list above was re-derived from the current view — compress only ranges it lists. If refs keep failing, start a fresh conversation.`);
        } else {
            extra.push(`FOLD SUBSTRATE INVALID — last compress failure was attributed to ${lastCause}. The Compressible-ranges list above was re-derived from the current view; if folding a listed range fails again, start a fresh conversation — the folded base no longer matches what the client resends.`);
        }
    }
    // #3148: upstream-failure state used to live only in bili.log — surface the
    // circuit, the emergency-shrink baseline and the sticky planning-floor clamp
    // here so hosts/models can see WHY rounds fail or output is capped.
    // Display-only; none of this touches a wire decision.
    const openCircuits = getOpenUpstreamCircuits();
    if (openCircuits.length > 0) {
        for (const c of openCircuits.slice(0, 4)) {
            extra.push("");
            extra.push(`UPSTREAM CIRCUIT OPEN — ${c.host}: ${c.consecutiveFailures} consecutive pre-response failures since ${c.openedAt !== null ? new Date(c.openedAt).toISOString() : "?"} · last failure ${c.lastFailure ? `${c.lastFailure.kind}${c.lastFailure.detail ? ` (${c.lastFailure.detail})` : ""} @ ${new Date(c.lastFailure.at).toISOString()}` : "?"}; next probe ${c.nextProbeAt !== null ? new Date(c.nextProbeAt).toISOString() : "soon"}. Requests to this host fail fast until the probe succeeds.`);
        }
        if (openCircuits.length > 4) extra.push(`UPSTREAM CIRCUIT OPEN — (+${openCircuits.length - 4} more host(s))`);
    }
    // #4204: display counterpart of the egress-side 429 governor — holds are
    // per origin+credential and answer locally (zero egress) while armed, so
    // hosts/models can see WHY sends are held back and when the next probe
    // fires. Display-only; no wire decision lives here.
    const throttleHolds = activeThrottleHolds();
    if (throttleHolds.length > 0) {
        for (const h of throttleHolds.slice(0, 4)) {
            extra.push("");
            extra.push(`UPSTREAM 429 HOLD — ${h.host}: ${h.streak} consecutive upstream 429(s); outbound sends answered locally until ${new Date(h.nextAttemptAt).toISOString()} (${h.terminal ? "TERMINAL — local 424 outside SDK retry sets until a probe succeeds" : "backoff window"}); zero egress while held, clears on the next non-429 response (#4204).`);
        }
        if (throttleHolds.length > 4) extra.push(`UPSTREAM 429 HOLD — (+${throttleHolds.length - 4} more origin+credential key(s))`);
    }
    const shrinkAt = ctx.session.stats.emergencyShrinkAt;
    if (typeof shrinkAt === "number") {
        const ageMin = Math.max(0, Math.round((Date.now() - shrinkAt) / 60000));
        extra.push("");
        extra.push(`EMERGENCY SHRINK ARMED — baseline raised to local estimate ${ctx.session.stats.emergencyShrinkEstimate ?? "?"} tokens after a failed round with no usage report (${ageMin}m ago); truncation band active until the next real usage report.`);
    }
    const ledgerFloor = dshLedgerFloorTokens(ctx.session.metadata);
    const lastClamp = ctx.session.stats.lastOutputClamp;
    if (ledgerFloor > 0 || lastClamp !== undefined) {
        extra.push("");
        extra.push(`OUTPUT BUDGET CLAMP —${lastClamp !== undefined ? ` last: max_tokens ${lastClamp.raw} -> ${lastClamp.capped} (window ${lastClamp.window}, input~${Math.round(lastClamp.planningInput)}) @ ${new Date(lastClamp.at).toISOString()}` : ""} · planning floor ${ledgerFloor} tok from the refused dsh compaction replay (#2490, sticky for the session lifetime). Only compression can recover the input; this clamp guarantees native-window fit.`);
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
    // #1336: retrieve-quality proxy — whole-block restores where a cheaper
    // precise path existed at restore time. Independent of CCR arming (the
    // whole-block restore path works with or without the content store).
    const wbRestores = ctx.session.stats.wholeBlockRestores ?? 0;
    if (wbRestores > 0) {
        const precise = ctx.session.stats.wholeBlockRestoresPreciseAvailable ?? 0;
        extra.push("");
        extra.push(`RETRIEVAL QUALITY — whole-block restores: ${wbRestores} total${precise > 0 ? `, ${precise} had a cheaper precise path available (${Math.round((precise / wbRestores) * 100)}%)` : ""}`);
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
            if (s) spans.push(`${b.blockId}=${s.text}${isExternalSummaryBlock(b) ? " ⚡ext" : ""}`);
        }
        if (spans.length > 0) {
            extra.push("");
            extra.push(`BLOCK SPANS — ${spans.slice(0, 12).join(" · ")}${spans.length > 12 ? ` (+${spans.length - 12} more)` : ""}`);
        }
    }
    // #2671: effective storage mode right in the tool output, so "which mode
    // am I on" never requires shell access to the lane log.
    extra.push("");
    extra.push(`STORAGE — ${storageStatusLabel()}`);
    // #3385 (owner directive 3, acp_status surface): when the unified store is
    // degraded (engine missing, self-download cooldown, ...), surface the SAME
    // reason string the web banner and diagnostics carry — on Node < 22.5 it
    // contains the explicit Node upgrade lever, so the MODEL can tell the
    // user instead of the fact living only in lane logs the user never opens.
    const storageWire = storageStatusWire();
    if (storageWire.degraded && storageWire.reason) {
        extra.push(`  ⚠ degraded — ${storageWire.reason} (relay this to the user)`);
    }
    const archive = preCompactionArchiveOf(ctx.session);
    if (Object.keys(archive).length > 0) {
        extra.push("");
        extra.push(...formatPreCompactionArchive(archive, args.archiveDetail === true));
    }
    // #1206: conflict evidence (third-party compression plugin detected, or
    // runtime signs another compressor rewrote history) — visible here so the
    // user sees it while the session is still recoverable.
    const cevents = conflictEventsOf(ctx.session);
    if (cevents.length > 0) {
        // #2219: key the remediation hint on THIS session's resolved client so
        // the model can relay per-client steps without digging out the docs.
        extra.push("");
        extra.push(...formatConflictSection(cevents, Date.now(), conflictClientOf(ctx.session)));
    }
    const adv = getAdvisoryState();
    if (adv.active) {
        // #1577: native/plugin lanes spawn the proxy with stdio→log file on an
        // ephemeral port, so the stderr warn and web banner never reach the
        // user's terminal. acp_status is the one surface they actually look at
        // — surface the active advisory here (instance-level, like #897).
        extra.push("");
        extra.push(`CRITICAL ADVISORY (instance-level): bili is auto-updating through the self-updater's safety chain — ${describeAdvisory(adv.active, adv.lastError)}. Live state: the advisory field of GET /__bili/status.`);
    }
    const upd = getUpdateVisibility(VERSION);
    const updateAction = updateBannerPayload(upd);
    if (updateAction) {
        // #1870 + #1977: the self-updater is a silent courier on native
        // lanes — the "Restart to finish" log line never reaches
        // pi/opencode/dsh users, so disk runs new while the process runs old.
        // This is the surface agents actually poll — but by default it is
        // SILENT (#1977: not every release deserves the user's attention);
        // it only speaks when the span carries a critical-tier entry,
        // telling them a restart is actionable NOW, or that a critical fix
        // exists while auto-update is off.
        extra.push("");
        const lines: string[] = [];
        if (updateAction.kind === "ready") {
            lines.push(`CRITICAL UPDATE READY (instance-level): ${updateAction.version} downloaded — restart this agent's proxy to finish (running ${upd.runningVersion}).`);
        } else {
            lines.push(`CRITICAL UPDATE AVAILABLE (instance-level): release with a critical-tier fix on the channel — running ${upd.runningVersion}.`);
        }
        for (const e of upd.span) {
            lines.push(`  · ${e.version} [${e.tier}] ${e.summary}`);
        }
        // No install command on purpose: hosts differ (npm -g / opencode
        // plugin / dsh / pi) — naming the version is host-neutral advice.
        lines.push("Live state: the update field of GET /__bili/status.");
        extra.push(...lines);
    }
    // #2645 probe-and-remember: bili learned (via A/B retry at egress) which
    // upstream origin+model pair(s) reject prompt_cache_key and now withholds
    // the key there until proxy restart. The memory is process-local and
    // config-free, so this is where an operator can see that their
    // relay/account pool's prefix-cache affinity may have degraded — naming
    // the destination, model, and affected sessions.
    const pckAbled = pckAblations();
    if (pckAbled.length > 0) {
        extra.push("");
        const lines: string[] = [];
        for (const a of pckAbled.slice(0, 5)) {
            const model = a.model ? ` (model ${a.model})` : "";
            const sessions = a.sessions.length > 0 ? ` Affected session(s): ${a.sessions.join(", ")}.` : "";
            lines.push(`CACHE ROUTING KEY BLOCKED (instance-level): upstream ${a.origin}${model} rejects OpenAI's prompt_cache_key body field — confirmed ${a.confirmations}× by A/B retry since process start (request with the key \u2192 400, identical request without it \u2192 accepted); bili withholds the key there until restart.${sessions}`);
        }
        if (pckAbled.length > 5) {
            lines.push(`\u2026${pckAbled.length - 5} more destination(s): GET /__bili/status field pckSuppressions.`);
        }
        lines.push("If this destination is your relay/account pool, its prefix-cache affinity for the listed sessions may degrade until restart.");
        extra.push(...lines);
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
        extra.push(`UNDECRYPTED TRAFFIC (instance-level): ${blind.total} CONNECT tunnel(s) to host(s) outside the MITM whitelist were blind-relayed since instance start — that traffic was never decrypted, so it never entered any session and CANNOT be compressed (${hosts}). To compress such a client: add its model domain to "mitm".domains in billion-context.json, restart bili, and make the client trust bili's root CA. Exact per-host counts: the blindTunnels field of GET /__bili/stats.`);
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
        extra.push(`UNRECOGNIZED PATHS (instance-level): ${unrec.total} request(s) to ${Object.keys(unrec.paths).length} path(s) matched no known protocol (/chat/completions, /llm_raw_chat, /v1/messages, /responses, …) since instance start — they were relayed byte-for-byte and CANNOT be compressed (${top}). If you expected compression here, that endpoint's path is not in bili's protocol table. Exact per-path counts: the unrecognizedPaths field of GET /__bili/stats.`);
    }
    return toolOk(extra.length > 0 ? `${base}\n${extra.join("\n")}` : base);
}
