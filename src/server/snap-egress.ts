/**
 * #5874 mapEgress — direct-authority egress from the verified snapshot plane.
 *
 * Owner ruling (2026-11-11): the snapshot plane is the DIRECT outbound
 * authority, not a "verified egress source" that gets compared against the
 * legacy bytes every round. In the uncompressed steady state a new message,
 * once converted, is appended to the snapshot and served from it — no
 * per-round diff, no tripwire, no seam-walk re-alignment.
 *
 * The plane stores the kernel's OWN tagged processTurn output (invariant v:
 * post_json is the post-rewrite core form — the kernel's render-refs output,
 * never wire bytes). The write side persists exactly the bytes the kernel
 * saw, so the egress stage mirrors the kernel's prune/rebuild step over the
 * plane rows (surviving ledger rows, including covered ones — the pair-safe
 * walk needs them — plus each active block's stored anchor row) and serves
 * the result through the lane's transform (absorb → attach → strip → drop,
 * identical to what the lane runs on the legacy view).
 *
 * The legacy processedMessages still exist for the ONE-round crash-grade
 * fallback: if the plane is dead, uninitialized for this sid, or the assembly
 * throws, this round serves the legacy bytes and the next round re-decides.
 * There is no sticky exclusion and no normalized comparison — the plane bytes
 * are the transform input, so the output is byte-identical to the legacy
 * egress by construction.
 */
import { baseIdOf, isRenderedSummaryMessage, SUMMARY_HEADER, summaryMessageId, type CompressionState } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { loadConfigFile } from "../config.js";
import { getStore } from "../persist.js";
import { isSnapPlaneDead, type SnapView } from "../storage/snap.js";

export type SnapEgressProtocol = "openai" | "anthropic" | "google" | "responses";

interface SnapEgressDeps {
    sessionId: string;
    /** Wire-protocol family, gates the cohort check. */
    protocol: SnapEgressProtocol;
    log: (level: string, msg: string) => void;
    /** Lane-identical post-processing for the plane view (absorb → attach →
     *  strip → drop, exactly what the lane applied to the legacy view). The
     *  plane rows ARE the lane's transform input, so applying this transform
     *  reproduces the legacy bytes by construction. */
    transform: (msgs: BiliMessage[]) => BiliMessage[];
    /** #4311: which tool names are compress calls (kernel config
     *  isCompressTool). Gates the visible-compress-call anchor skip. */
    isCompressTool?: (name: string) => boolean;
}

// ---------------------------------------------------------------------------
// Gate (config-file only — #2030: no env knob; soak default ON at 100%,
// flip to opt-in before the release cut).
// ---------------------------------------------------------------------------

const DEFAULT_COHORTS: ReadonlySet<SnapEgressProtocol> = new Set(["openai", "anthropic", "google", "responses"]);

function snapEgressFlags(): { egress: boolean; cohorts: ReadonlySet<SnapEgressProtocol> } {
    const file = loadConfigFile();
    const v = file.storage?.snapBase;
    // SOAK (#5874): default ON at 100% for the soak + full-CI run.
    // Release cut: change to `v?.egress === true` (opt-in).
    const egress = v?.egress !== false;
    const cohorts = Array.isArray(v?.egressCohorts) && v.egressCohorts.length > 0
        ? new Set<SnapEgressProtocol>(v.egressCohorts as SnapEgressProtocol[])
        : DEFAULT_COHORTS;
    return { egress, cohorts };
}

// ---------------------------------------------------------------------------
// Counters (process-lifetime; surfaced via /__bili/status → snaplane.egress).
// ---------------------------------------------------------------------------

const degradeReasons = new Map<string, number>();
const egressStats = { plane: 0, degrade: 0, planeMiss: 0 };

interface SnapEgressStatusWire {
    plane: number;
    degrade: number;
    planeMiss: number;
    degradeReasons: Record<string, number>;
}

export function snapEgressStatusWire(): SnapEgressStatusWire {
    return {
        ...egressStats,
        degradeReasons: Object.fromEntries(degradeReasons),
    };
}

export function _resetSnapEgressForTests(): void {
    degradeReasons.clear();
    egressStats.plane = 0;
    egressStats.degrade = 0;
    egressStats.planeMiss = 0;
}

function noteDegrade(reason: string): void {
    egressStats.degrade++;
    degradeReasons.set(reason, (degradeReasons.get(reason) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// View assembly (proposal stage 4). Mirrors the kernel's prune/rebuild step
// EXACTLY (kernel/src/prune.ts) over the S4-verified plane rows: the
// non-anchor rows (surviving ledger rows, covered ones included — the
// pair-safe walk and the coverage skips need them present, same as in the
// kernel input) are the walk list; each active block's stored anchor row is
// moved to the same position the kernel's renderSummary would take (earliest
// covered id → pair-safe over the walk list → pin/fallback clamp). Covered
// and stale-rendered-summary rows are skipped exactly as the kernel skips
// them (base-id coverage + #4316 layer-3 ledgerSeq intervals + known-summary
// drop), the pinned opening wire message is served even when covered
// (#2733/#3642), and the #4311 visible-compress-call skip applies.
// ---------------------------------------------------------------------------

interface EgressRow {
    pos: number;
    ids: Set<string>;
    msg: BiliMessage; // parsed post_json
    active: number;
    isAnchor: boolean; // coreIds carry an acp_summary_ id (the stored render)
    coverRef: string | null; // the block that compacted this row (plane-native coverage)
}

/** prune.ts pairing parity: an anchor takes the EARLIEST covered message's
 *  position, then moves back to the assistant-run start / past the paired
 *  tool result so it never splits a wire-validated unit. Walks the FULL row
 *  list — covered rows are still present there (same reasoning as prune:
 *  covered cores between wire-relevant cores are dropped and the runs merge). */
function pairSafeAnchorIndex(rows: EgressRow[], earliest: number): number {
    const n = rows.length;
    const at = (i: number) => rows[i].msg;
    // runStart: start of the maximal consecutive assistant-role run containing i.
    const runStart = new Int32Array(n).fill(-1);
    for (let i = 0; i < n;) {
        if (at(i)?.role !== "assistant") { i++; continue; }
        let j = i;
        while (j + 1 < n && at(j + 1)?.role === "assistant") j++;
        for (let k = i; k <= j; k++) runStart[k] = i;
        i = j + 1;
    }
    // prefixEnd[i]: farthest (first result index of an assistant tool-call
    // before i) + 1.
    const resultIndexByCallId = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        const m = at(i);
        if (m?.contentType === "tool-result" && typeof m.toolCallId === "string" && !resultIndexByCallId.has(m.toolCallId)) {
            resultIndexByCallId.set(m.toolCallId, i);
        }
    }
    const prefixEnd = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
        const m = at(i);
        let end = 0;
        if (m?.role === "assistant" && m.contentType === "tool-call" && typeof m.toolCallId === "string") {
            const r = resultIndexByCallId.get(m.toolCallId);
            if (r !== undefined) end = r + 1;
        }
        prefixEnd[i + 1] = Math.max(prefixEnd[i]!, end);
    }
    let safe = earliest;
    if (safe > 0 && safe < n) {
        const start = runStart[safe]!;
        if (start >= 0 && at(safe - 1)?.role === "assistant") safe = start;
    }
    if (safe < 0 || safe > n) return safe;
    for (let guard = 0; guard < n; guard++) {
        const next = Math.max(safe, prefixEnd[safe]!);
        if (next === safe) break;
        safe = next;
    }
    return safe;
}

/** renderSummary parity (kernel/src/prune.ts): topic header line + body.
 *  Fallback only — the plane normally stores the kernel's own anchor row and
 *  it is served verbatim; this is used when a block's anchor row is somehow
 *  absent from the plane. */
function renderAnchor(b: CompressionState["blocks"][number]): BiliMessage {
    const body = b.summary.trim();
    const topicLine = b.topic ? `${SUMMARY_HEADER} — ${b.topic}` : SUMMARY_HEADER;
    const text = body.length === 0 ? topicLine : `${topicLine}\n${body}`;
    return { id: summaryMessageId(b.blockId), role: "system", contentType: "text", text } as BiliMessage;
}

interface AnchorSeed {
    insertAt: number;
    unresolved: boolean;
    msg: BiliMessage;
}

/** Assemble the outbound view from the S4-verified plane (kernel prune/
 *  rebuild parity — see the section header). */
export function buildSnapEgressView(
    view: SnapView,
    state: CompressionState,
    isCompressTool: (name: string) => boolean,
): { ok: true; msgs: BiliMessage[]; n: number } | { ok: false; reason: string } {
    if (!view.rows.length) return { ok: false, reason: "no-plane" };

    // Parse EVERY row (active and covered): the covered rows stay in the walk
    // list for pairing + coverage parity, exactly as in the kernel input.
    const rows: EgressRow[] = [];
    for (const r of view.rows) {
        if (typeof r.postJson !== "string" || !r.postJson) {
            return { ok: false, reason: "row-unparsable" };
        }
        let msg: BiliMessage;
        try {
            msg = JSON.parse(r.postJson) as BiliMessage;
        } catch {
            return { ok: false, reason: "row-unparsable" };
        }
        const ids = new Set(r.coreIds);
        rows.push({ pos: r.pos, ids, msg, active: r.active, coverRef: r.coverRef, isAnchor: [...ids].some((id) => id.startsWith("acp_summary_")) });
    }
    // The kernel's input list (rows-sourced D views suppress covered rows,
    // client-sourced views carry them but the kernel prune drops them)
    // reduces to the plane's ACTIVE non-anchor rows: the write side maps
    // exactly the kernel output onto the plane and compacts everything the
    // kernel covered. Covered/inactive rows therefore take NO part in
    // pairing or serving — coverage suppression by active flag, not by
    // alias matching (an alias match mis-fired on a FRESH reminted row
    // whose core_ids carried a covered base id — the #4052 fresh-repeat
    // message vanished from egress while the kernel served it).
    const nonAnchor = rows.filter((r) => !r.isAnchor && r.active === 1);
    const anchorMsgById = new Map<string, BiliMessage>();
    for (const r of rows) {
        if (!r.isAnchor) continue;
        for (const id of r.ids) if (id.startsWith("acp_summary_")) anchorMsgById.set(id, r.msg);
    }

    const n = nonAnchor.length;
    const isCompress = isCompressTool;
    // Kernel parity: prune() returns the input UNTOUCHED (no anchors, no
    // coverage skips, no stale-summary drop) when no active block covers
    // any message — the whole pipeline is a no-op then.
    const coveredIds = new Set<string>();
    for (const b of state.blocks) if (b.active) for (const id of b.effectiveMessageIds) coveredIds.add(id);
    if (coveredIds.size === 0) {
        return { ok: true, msgs: nonAnchor.map((r) => r.msg), n };
    }
    // #4311: a compress tool-call visible in the input suppresses its block's
    // separate summary render.
    const visibleCompressCallIds = new Set<string>();
    for (const r of nonAnchor) {
        const m = r.msg;
        if (m.contentType === "tool-call" && typeof m.toolCallId === "string" && typeof m.toolName === "string" && isCompress(m.toolName)) {
            visibleCompressCallIds.add(m.toolCallId);
        }
    }
    // Stale rendered-summary copies: the kernel drops a resented summary of a
    // block it (re)renders itself — all blocks, active or consumed.
    const knownSummaryIds = new Set(state.blocks.map((b) => summaryMessageId(b.blockId)));
    const firstUserIndex = nonAnchor.findIndex((r) => r.msg.role === "user");
    let lastUserIndex = -1;
    for (let i = n - 1; i >= 0; i--) {
        if (nonAnchor[i]!.msg.role === "user") { lastUserIndex = i; break; }
    }
    // #3642: the pin run — the first user's wireIndex core run (the kernel
    // serves it even when covered).
    let firstUserPinEnd = firstUserIndex >= 0 ? firstUserIndex + 1 : -1;
    if (firstUserIndex >= 0) {
        // #3642: wireIndex is a runtime core field (codec-set, not on the
        // CoreMessage type) — kernel parity via local cast.
        const w = (nonAnchor[firstUserIndex]!.msg as { wireIndex?: number }).wireIndex;
        if (typeof w === "number") {
            let j = firstUserIndex + 1;
            while (j < n && nonAnchor[j]!.msg.role === "user" && (nonAnchor[j]!.msg as { wireIndex?: number }).wireIndex === w) j++;
            firstUserPinEnd = j;
        }
    }
    // base id → EARLIEST index (kernel baseIndexById parity, plane-extended:
    // every alias of a row seeds the index, so a reminted row — whose msg.id
    // no longer matches the fold-time block effIds — still resolves through
    // its old alias kept in core_ids).
    const baseIndexById = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        for (const id of nonAnchor[i]!.ids) {
            const base = baseIdOf(id);
            if (!baseIndexById.has(base)) baseIndexById.set(base, i);
        }
    }
    // Rendered summary id → index (LAST occurrence wins — kernel parity).
    const summaryIndexById = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        if (isRenderedSummaryMessage(nonAnchor[i]!.msg)) summaryIndexById.set(nonAnchor[i]!.msg.id, i);
    }
    // Covered run → anchor position (kernel parity: "a rendered summary
    // replaces the messages its block covers, so it takes the position of
    // the EARLIEST covered message" — prune.ts collectSummaryAnchors). A
    // folded block's rows are INACTIVE on the plane (the write side compacts
    // them with cover_ref = block id), so they are absent from the pairing
    // list above; the anchor takes the first pairing row strictly ABOVE the
    // covered run, and the pin clamp below moves it past the pinned run.
    //
    // The covered run is read from the rows' OWN cover_ref — the plane-native
    // ground truth the write side stamped at compact time. It is deliberately
    // NOT resolved through the block's effectiveMessageIds: on an
    // identity-seed upgrade the reconcile re-keys the block to the client's
    // re-minted ids (#3752), and those ids first-seen on the plane are the
    // re-appended covered DUPLICATES (fresh ledger seqs, above every live
    // row) — resolving through them parks the anchor at the tail instead of
    // after the original covered run. cover_ref is immune: the original
    // covered rows keep it across remints, and MIN over the run is the
    // earliest covered position (a fold covers one contiguous run, so min
    // and max give the same "first row above" for the original run; the
    // min is what disambiguates when remint duplicates exist).
    const coverRefMinPos = new Map<string, number>(); // block id → earliest covered pos
    for (const r of rows) {
        if (r.isAnchor || r.coverRef === null) continue;
        const prev = coverRefMinPos.get(r.coverRef);
        if (prev === undefined || r.pos < prev) coverRefMinPos.set(r.coverRef, r.pos);
    }
    // Anchor seeds (kernel collectSummaryAnchors parity: active blocks only;
    // direct range preferred over merged effective, #2733).
    const fallbackIndex = lastUserIndex >= 0 ? lastUserIndex : n;
    const anchors: AnchorSeed[] = [];
    for (const b of state.blocks) {
        if (!b.active) continue;
        // #5765 retire parity (kernel collectSummaryAnchors / D-lane render): a
        // retired block stays active but its summary is intentionally NOT
        // re-rendered — its covered rows stay covered (suppressed here by the
        // active flag, exactly as the D-lane does).
        if (b.retired === true) continue;
        if (b.compressCallId !== undefined && visibleCompressCallIds.has(b.compressCallId)) continue;
        const sid = summaryMessageId(b.blockId);
        const existing = summaryIndexById.get(sid);
        const msg = anchorMsgById.get(sid) ?? renderAnchor(b);
        if (existing !== undefined) {
            anchors.push({ insertAt: existing, unresolved: false, msg });
            continue;
        }
        const anchorIds = b.directMessageIds && b.directMessageIds.length > 0 ? b.directMessageIds : b.effectiveMessageIds;
        const covLo = coverRefMinPos.get(b.blockId);
        let insertAt: number;
        let unresolved: boolean;
        if (covLo !== undefined) {
            // First pairing (active) row strictly above the covered run.
            insertAt = 0;
            while (insertAt < n && nonAnchor[insertAt]!.pos <= covLo) insertAt++;
            unresolved = false;
        } else {
            let earliest: number | null = null;
            for (const id of anchorIds) {
                const idx = baseIndexById.get(baseIdOf(id));
                if (idx === undefined) continue;
                if (earliest === null || idx < earliest) earliest = idx;
            }
            insertAt = earliest ?? fallbackIndex;
            unresolved = earliest === null;
        }
        anchors.push({ insertAt, unresolved, msg });
    }
    // Pair-safe adjustment + pin/fallback clamp (kernel rebuildMessages
    // parity: non-head-anchors clamp past the pin when resolved, to the first
    // user when unresolved).
    for (const a of anchors) {
        a.insertAt = pairSafeAnchorIndex(nonAnchor, a.insertAt);
        const clamp = a.unresolved ? firstUserIndex : firstUserPinEnd;
        if (clamp >= 0) a.insertAt = Math.max(a.insertAt, clamp);
    }
    anchors.sort((a, b) => a.insertAt - b.insertAt);

    // The walk (kernel rebuildMessages parity): anchors at their index, the
    // pinned run verbatim, covered / positional / stale-summary skips.
    const merged: BiliMessage[] = [];
    let ai = 0;
    for (let i = 0; i < n; i++) {
        while (ai < anchors.length && anchors[ai]!.insertAt === i) merged.push(anchors[ai++]!.msg);
        if (i === firstUserIndex && firstUserIndex >= 0) {
            for (let k = i; k < firstUserPinEnd && k < n; k++) merged.push(nonAnchor[k]!.msg);
            i = firstUserPinEnd - 1;
            continue;
        }
        const r = nonAnchor[i]!;
        const m = r.msg;
        // nonAnchor is the active set already — covered rows never reach
        // the walk (see the filter above).
        if (isRenderedSummaryMessage(m) && knownSummaryIds.has(m.id)) continue;
        merged.push(m);
    }
    while (ai < anchors.length) merged.push(anchors[ai++]!.msg);
    return { ok: true, msgs: merged, n: merged.length };
}

// Entry point — called by each protocol lane right after the lane computed
// its legacy processedMessages (the one-round crash-grade fallback). The
// plane view, once assembled and transformed, is the outbound source
// directly — no per-round comparison against the legacy bytes.
// ---------------------------------------------------------------------------

export function applySnapEgress(
    state: CompressionState,
    legacyProcessed: BiliMessage[],
    deps: SnapEgressDeps,
): BiliMessage[] {
    const flags = snapEgressFlags();
    if (!flags.egress || !flags.cohorts.has(deps.protocol)) return legacyProcessed;
    if (isSnapPlaneDead(deps.sessionId)) return legacyProcessed;

    let view: SnapView | null;
    try {
        view = getStore()?.snapEgressView(deps.sessionId) ?? null;
    } catch {
        view = null;
    }
    if (!view) {
        egressStats.planeMiss++;
        return legacyProcessed; // plane not initialized for this sid yet — nothing to serve
    }

    // Never-fail contract: the plane path must degrade, never throw. A throw
    // escaping here reached the lane catch, which forwarded the UNPROCESSED
    // client bytes — kernel render, watermark and egress all skipped — and
    // corrupted the round (found in CI: a media-offload object fed to a hash).
    try {
        const built = buildSnapEgressView(view, state, deps.isCompressTool ?? ((name: string) => name === "compress"));
        if (!built.ok) {
            noteDegrade(built.reason);
            return legacyProcessed;
        }
        const planeProcessed = deps.transform(built.msgs);
        // DIRECT AUTHORITY: the plane view is the outbound source. The legacy
        // bytes exist only as the crash-grade fallback above.
        egressStats.plane++;
        deps.log("info", `[snaplane] sid=${deps.sessionId} egress=plane n=${planeProcessed.length}`);
        return planeProcessed;
    } catch (err) {
        noteDegrade("egress-assembly-error");
        deps.log("warn", `[snaplane] sid=${deps.sessionId} decision=degrade:egress:assembly-error (${err instanceof Error ? err.message : String(err)}) — legacy egress kept`);
        return legacyProcessed;
    }
}
