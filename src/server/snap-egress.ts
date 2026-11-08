/**
 * #5874 P2 — mapEgress (proposal stages 4→5): serve the OUTBOUND compressed
 * context from the verified snap plane instead of the in-memory
 * lastMessages AST.
 *
 * Chain position (six-segment fixed chain):
 *   inbound → convert (kernel, untouched) → compress (kernel, untouched)
 *   → snap plane (P0/P1 shadow write) → **mapEgress (this file)** → wire out.
 *
 * Safety doctrine — the tripwire: the plane view is assembled FIRST and
 * compared against the legacy-computed egress view (normalized: role /
 * contentType / toolName / toolCallId / text / image-hash — ids are
 * intentionally ignored because the plane carries fold-time ids). ONLY an
 * exact match switches the outbound source; any mismatch keeps the legacy
 * bytes. No failure mode ever sends plane-sourced bytes the legacy path
 * would not have sent. After {@link EGRESS_EXCLUDE_AFTER} mismatches the
 * session is sticky-excluded for the process lifetime (honest degrade,
 * mirrors the plane's R1/R2 latches).
 *
 * The plane reflects the last LANDED save (previous turn's end; saves are
 * ~500ms debounced), so this turn's fresh messages are NOT in it: the view
 * is prefix (plane rows, pos order) + real summary anchors at each covered
 * region + tail (the client's genuinely-new messages, derived by the same
 * backward seam walk D-lane uses — id fast path, identity-signature fallback,
 * one reply-lag gap tolerated, #3812/#4052 semantics preserved).
 */
import { defaultCountTokens, renderVisibleRefs, SUMMARY_HEADER, summaryMessageId, type CompressionState, type RenderStrategy } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { createHash } from "node:crypto";
import { loadConfigFile, resolveMessageTimestamps } from "../config.js";
import { getStore } from "../persist.js";
import { isSnapPlaneDead, type SnapView } from "../storage/snap.js";
import { identitySig } from "./snapshot-render.js";

/** Same seam discipline as D-lane (#3756): the walk only touches the tail
 *  region, and a seam shorter than two matched messages is never a seam. */
const MAX_CHAIN_WALK = 8192;
const MIN_SEAM_RUN = 2;
/** Tripwire verdict budget before a session is sticky-excluded. */
const EGRESS_EXCLUDE_AFTER = 3;

export type SnapEgressProtocol = "openai" | "anthropic" | "google" | "responses";

interface SnapEgressDeps {
    sessionId: string;
    /** Wire-protocol family, gates the cohort check. */
    protocol: SnapEgressProtocol;
    /** The lane's render strategy (knobRenderNone() gate) — the kernel's
     *  render-refs node is the LAST pipeline node, so the plane view must
     *  run the same renderer to reach byte parity on the rendered tags. */
    renderTags: RenderStrategy;
    log: (level: string, msg: string) => void;
    /** Lane-identical post-processing for the plane view (strip → drop →
     *  repair, exactly what the lane applied to the legacy view). */
    transform: (msgs: BiliMessage[]) => BiliMessage[];
}

// ---------------------------------------------------------------------------
// Gate (config-file only — #2030: no env knob; soak default ON at 100%,
// flip to opt-in before the release cut).
// ---------------------------------------------------------------------------

const DEFAULT_COHORTS: ReadonlySet<SnapEgressProtocol> = new Set(["openai", "anthropic", "google", "responses"]);

export function snapEgressFlags(): { egress: boolean; cohorts: ReadonlySet<SnapEgressProtocol>; timestamps: boolean } {
    const file = loadConfigFile();
    const v = file.storage?.snapBase;
    // SOAK (#5874 P2): default ON at 100% for the soak + full-CI run.
    // Release cut: change to `v?.egress === true` (opt-in).
    const egress = v?.egress !== false;
    const cohorts = Array.isArray(v?.egressCohorts) && v.egressCohorts.length > 0
        ? new Set<SnapEgressProtocol>(v.egressCohorts as SnapEgressProtocol[])
        : DEFAULT_COHORTS;
    // Same resolution the proxy core was built with (server.ts createCore):
    // env override first, then the file's compress block, default ON.
    const timestamps = resolveMessageTimestamps(file.compress);
    return { egress, cohorts, timestamps };
}

// ---------------------------------------------------------------------------
// Sticky exclusion + counters (process-lifetime, mirroring the plane's
// in-memory latches; surfaced via /__bili/status).
// ---------------------------------------------------------------------------

const egressExcluded = new Set<string>();
const fallbackCounts = new Map<string, number>();
const degradeReasons = new Map<string, number>();
const egressStats = { cutover: 0, fallback: 0, planeMiss: 0 };

interface SnapEgressStatusWire {
    cutover: number;
    fallback: number;
    planeMiss: number;
    excludedSids: number;
    degradeReasons: Record<string, number>;
}

export function snapEgressStatusWire(): SnapEgressStatusWire {
    return {
        ...egressStats,
        excludedSids: egressExcluded.size,
        degradeReasons: Object.fromEntries(degradeReasons),
    };
}

export function _resetSnapEgressForTests(): void {
    egressExcluded.clear();
    fallbackCounts.clear();
    degradeReasons.clear();
    egressStats.cutover = 0;
    egressStats.fallback = 0;
    egressStats.planeMiss = 0;
}

function noteDegrade(reason: string): void {
    degradeReasons.set(reason, (degradeReasons.get(reason) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Tripwire (proposal stage 5): normalized element-wise comparison. Ids,
// ledgerSeq/ts stamps and wireIndex are metadata — the model-visible
// payload must be identical.
// ---------------------------------------------------------------------------

const TRIPWIRE_FIELDS = ["role", "contentType", "toolName", "toolCallId", "text", "image"] as const;

function normTuple(m: BiliMessage): string[] {
    const img = m.imagePart === true
        ? createHash("sha256").update(m.imageBase64 ?? "").digest("hex").slice(0, 24)
        : "";
    return [m.role, m.contentType, m.toolName ?? "", m.toolCallId ?? "", typeof m.text === "string" ? m.text : "", img];
}

export function tripwireCompare(plane: BiliMessage[], legacy: BiliMessage[]): { ok: true } | { ok: false; reason: string; firstDiff?: string } {
    if (plane.length !== legacy.length) {
        return { ok: false, reason: `length(plane=${plane.length},legacy=${legacy.length})` };
    }
    for (let i = 0; i < plane.length; i++) {
        const a = normTuple(plane[i]);
        const b = normTuple(legacy[i]);
        for (let f = 0; f < a.length; f++) {
            if (a[f] !== b[f]) {
                const head = (v: unknown) => JSON.stringify(String(v ?? "")).slice(0, 400);
                const tail = (v: unknown) => JSON.stringify(String(v ?? "")).slice(-200);
                return { ok: false, reason: `shape@${i}:${TRIPWIRE_FIELDS[f]}`, firstDiff: `${TRIPWIRE_FIELDS[f]} plane(len=${String(a[f] ?? "").length})=${head(a[f])} …tail=${tail(a[f])} | legacy(len=${String(b[f] ?? "").length})=${head(b[f])} …tail=${tail(b[f])}` };
            }
        }
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// View assembly (proposal stage 4). Plane rows are pos-ordered and S4-
// verified (readSnapView); block coverage NEVER trusts startSeq/endSeq
// (1-based ledgerSeq, only recorded when provable) — it is derived from
// effectiveMessageIds mapped onto row positions, exactly like D-lane's
// blockSeeds.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Render parity. The `<acp tokens=… type=… time=…>mNNNNN</acp>` tags are NOT
// client resend data — they are system metadata rendered by the kernel's
// render-refs node (the LAST pipeline node, compress.ts buildNodes) over
// turn.messages. Plane rows store the clean, pre-render text, so byte parity
// is reached by re-running the kernel's own renderer over the assembled
// plane view with the SAME state (refs map, token snapshot domain), strategy
// and timestamp mode the live turn used. The tag's ref number comes from
// state.messageRefs, the token count from the deterministic default counter
// (deterministic recount == the pipeline's frozen snapshot for unchanged
// text), and the immutable first-sight time from state.tsStamps — all
// carried on the post-turn state the caller passes in.
// ---------------------------------------------------------------------------

const ACP_ENVELOPE_RE = /^<acp\s[^>]*>[^<]*<\/acp>\n/;

function stripEnvelope(text: string | undefined): string {
    return typeof text === "string" && ACP_ENVELOPE_RE.test(text) ? text.replace(ACP_ENVELOPE_RE, "") : (text ?? "");
}

/** identitySig with the resend envelope normalized away (both sides). */
function sigOf(m: BiliMessage): string {
    if (typeof m.text === "string" && ACP_ENVELOPE_RE.test(m.text)) {
        return identitySig({ ...m, text: stripEnvelope(m.text) } as BiliMessage);
    }
    return identitySig(m);
}

interface EgressRow {
    pos: number;
    ids: Set<string>;
    msg: BiliMessage | null; // parsed post_json (active rows only; covered rows never render)
}

interface AnchorSeed {
    insertAt: number; // adjusted full-list row index (prune pairing parity)
    msg: BiliMessage;
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

/** renderSummary parity (kernel/src/prune.ts): topic header line + body. */
function renderAnchor(b: CompressionState["blocks"][number]): BiliMessage {
    const body = b.summary.trim();
    const topicLine = b.topic ? `${SUMMARY_HEADER} — ${b.topic}` : SUMMARY_HEADER;
    const text = body.length === 0 ? topicLine : `${topicLine}\n${body}`;
    return { id: summaryMessageId(b.blockId), role: "system", contentType: "text", text } as BiliMessage;
}

export function buildSnapEgressView(
    view: SnapView,
    clientMsgs: BiliMessage[],
    state: CompressionState,
): { ok: true; msgs: BiliMessage[]; tailCount: number } | { ok: false; reason: string } {
    if (!view.rows.length) return { ok: false, reason: "no-plane" };

    const rows: EgressRow[] = view.rows.map((r) => {
        let msg: BiliMessage | null = null;
        if (r.active === 1 && typeof r.postJson === "string") {
            try {
                msg = JSON.parse(r.postJson) as BiliMessage;
            } catch {
                msg = null;
            }
        }
        return { pos: r.pos, ids: new Set(r.coreIds), msg };
    });

    // Block coverage: effectiveMessageIds → row positions (id mapping, the
    // only authoritative domain — startSeq/endSeq are 1-based and
    // only-when-provable, never trusted here). A block anchoring ZERO rows
    // is a coverage claim the plane cannot prove ⇒ degrade (legacy knows).
    const posById = new Map<string, number>();
    for (const r of rows) for (const id of r.ids) if (!posById.has(id)) posById.set(id, r.pos);
    const coveredPos = new Set<number>();
    const anchors: AnchorSeed[] = [];
    for (const b of state.blocks) {
        if (!b.active) continue;
        let minPos = -1;
        let any = false;
        for (const id of b.effectiveMessageIds) {
            const p = posById.get(id);
            if (p === undefined) continue;
            any = true;
            coveredPos.add(p);
            if (minPos === -1 || p < minPos) minPos = p;
        }
        if (!any) return { ok: false, reason: "block-unanchored" };
        // The summary takes the EARLIEST covered message's position (prune
        // semantics), adjusted past pairing boundaries over the FULL row list.
        const firstRow = rows.findIndex((r) => r.pos === minPos);
        anchors.push({ insertAt: pairSafeAnchorIndex(rows, Math.max(firstRow, 0)), msg: renderAnchor(b) });
    }
    anchors.sort((a, b) => a.insertAt - b.insertAt);

    // Plane-retired rows (delete events, #3285 sweep) never render either.
    const suppressed = (r: EgressRow): boolean => r.msg === null || coveredPos.has(r.pos);

    // Backward seam walk (D-lane buildView parity): id fast path over ALL
    // rows (an exact id is unambiguous — ids never reused), identity
    // signature over live rows only (#4052: covered rows take no sig binds).
    const byId = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) for (const id of rows[i].ids) byId.set(id, i);
    const bySig = new Map<string, number[]>();
    for (let i = rows.length - 1; i >= 0; i--) {
        if (suppressed(rows[i])) continue;
        const sig = sigOf(rows[i].msg!);
        const list = bySig.get(sig);
        if (list) list.push(i);
        else bySig.set(sig, [i]);
    }
    let joinRow = -1;
    let clientJoin = clientMsgs.length;
    {
        let cursor = rows.length; // exclusive upper bound for matches
        let started = false;
        let run = 0;
        let gapped = false;
        for (let k = clientMsgs.length - 1; k >= 0 && clientMsgs.length - 1 - k < MAX_CHAIN_WALK; k--) {
            const m = clientMsgs[k];
            let hit = -1;
            const byIdHit = byId.get(m.id);
            if (byIdHit !== undefined && byIdHit < cursor) hit = byIdHit;
            else {
                const cands = bySig.get(sigOf(m));
                if (cands) {
                    for (const idx of cands) {
                        if (idx < cursor) {
                            hit = idx;
                            break;
                        }
                    }
                }
            }
            if (hit < 0) {
                if (started) {
                    if (gapped) break; // second consecutive miss: chain over
                    gapped = true; // reply lag tolerance (#3812)
                    continue;
                }
                continue; // live tail (this turn's fresh user message etc.)
            }
            gapped = false;
            if (!started) {
                started = true;
                clientJoin = k + 1;
                joinRow = hit;
            }
            run++;
            cursor = hit;
        }
        if (!started) return { ok: false, reason: "chain-not-started" };
        if (run < MIN_SEAM_RUN) return { ok: false, reason: "seam-too-short" };
    }

    // Assemble: prefix rows[0..d) minus suppressed, each block's anchor at
    // its pair-safe position over the full row list, then the client tail
    // verbatim. Hosts legitimately TRIM bulky old tool results in their
    // resends (the kernel passes the trimmed text through — that is what the
    // legacy egress serves); a paired resend whose text is a strict PREFIX of
    // the plane's stored text is adopted so the plane egress serves the same
    // trimmed bytes. Anything else (edits, expansions) stays plane-sourced
    // and the byte-strict tripwire judges the divergence.
    const d = joinRow + 1;
    let ci = 0;
    const clientText = new Map<number, string>();
    for (let i = 0; i < d && ci < clientJoin; i++) {
        const r = rows[i];
        if (suppressed(r)) continue;
        const planeText = r.msg!.text;
        for (let k = ci; k < clientJoin; k++) {
            const c = clientMsgs[k];
            // Tool results carry no host-echoed message id (openai wire keys
            // them by tool_call_id) and a trimmed body fails sigOf — pair them
            // by toolCallId, which both sides always carry.
            const sameCall = typeof c.toolCallId === "string" && c.toolCallId === r.msg!.toolCallId;
            const paired = r.ids.has(c.id) || sameCall || sigOf(c) === sigOf(r.msg!);
            if (!paired) continue;
            if (typeof c.text === "string" && typeof planeText === "string" && trimDerived(c.text, planeText)) {
                clientText.set(i, c.text);
            }
            ci = k + 1;
            break;
        }
    }
    const merged: BiliMessage[] = [];
    let ai = 0;
    for (let i = 0; i < d; i++) {
        while (ai < anchors.length && anchors[ai].insertAt <= i) merged.push(anchors[ai++].msg);
        const r = rows[i];
        if (suppressed(r)) continue;
        const out = r.msg!;
        const trimmed = clientText.get(i);
        const base: BiliMessage = trimmed === undefined ? out : ({ ...out, text: trimmed } as BiliMessage);
        if (base.ledgerSeq === undefined) base.ledgerSeq = r.pos + 1; // 1-based ledgerSeq stamp (D-lane parseRow parity)
        merged.push(base);
    }
    while (ai < anchors.length) merged.push(anchors[ai++].msg);
    const tail = clientMsgs.slice(clientJoin);
    for (const m of tail) merged.push(m);
    return { ok: true, msgs: merged, tailCount: tail.length };
}

// ---------------------------------------------------------------------------
/** dsh's @deepseek-ai/dsh-compaction-tool-result-pruner replaces an
 *  over-budget tool-result middle with this exact marker, keeping
 *  headChars/tailChars code points at the ends. */
const TOOL_PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";

/** A client body derived from the plane text by trimming: head-only cut, or
 *  the dsh pruner's head + marker + tail shape. Anything else is an edit and
 *  stays plane-sourced (the byte-strict tripwire judges it). */
function trimDerived(clientText: string, planeText: string): boolean {
    if (planeText.startsWith(clientText)) return true;
    const mi = clientText.indexOf(TOOL_PRUNE_MARKER);
    if (mi < 0) return false;
    const head = clientText.slice(0, mi);
    const tail = clientText.slice(mi + TOOL_PRUNE_MARKER.length);
    return planeText.startsWith(head) && planeText.endsWith(tail) && head.length + tail.length < planeText.length;
}

// Entry point — called by each protocol lane right after the lane computed
// its legacy processedMessages. Returns the plane view on an exact tripwire
// match, else the legacy array untouched.
// ---------------------------------------------------------------------------

export function applySnapEgress(
    clientMsgs: BiliMessage[],
    state: CompressionState,
    legacyProcessed: BiliMessage[],
    deps: SnapEgressDeps,
): BiliMessage[] {
    const flags = snapEgressFlags();
    if (!flags.egress || !flags.cohorts.has(deps.protocol)) return legacyProcessed;
    if (egressExcluded.has(deps.sessionId)) return legacyProcessed;
    if (isSnapPlaneDead(deps.sessionId)) return legacyProcessed;

    let view: SnapView | null;
    try {
        view = getStore()?.snapEgressView(deps.sessionId) ?? null;
    } catch {
        view = null;
    }
    if (!view) {
        egressStats.planeMiss++;
        return legacyProcessed; // plane not initialized for this sid yet — nothing to observe
    }

    const built = buildSnapEgressView(view, clientMsgs, state);
    if (!built.ok) {
        noteDegrade(built.reason);
        return legacyProcessed;
    }

    // Kernel render parity: hydrate the immutable first-sight timestamps
    // (plane rows are stored pre-render and carry no ts), then run the
    // kernel's own render-refs pass over the view with the same state and
    // strategy the live turn used. renderMessage strips its own stale tag
    // before re-stamping, so the pass is idempotent for tail messages that
    // already carry one from a previous render. The token counts recomputed
    // by the deterministic default counter equal the pipeline's frozen
    // snapshot values for unchanged text. Any throw here is an honest
    // degrade — never unverified bytes.
    let rendered: BiliMessage[];
    try {
        const tsStamps = (state as { tsStamps?: Record<string, number> }).tsStamps;
        const hydrated = tsStamps === undefined
            ? built.msgs
            : built.msgs.map((m) => m.ts === undefined && typeof m.id === "string" && tsStamps[m.id] !== undefined
                ? ({ ...m, ts: tsStamps[m.id] } as BiliMessage)
                : m);
        rendered = renderVisibleRefs(hydrated, state, defaultCountTokens, deps.renderTags, flags.timestamps) as BiliMessage[];
    } catch (err) {
        noteDegrade("render-error");
        deps.log("warn", `[snaplane] sid=${deps.sessionId} decision=degrade:egress:render-error (${err instanceof Error ? err.message : String(err)})`);
        return legacyProcessed;
    }
    const planeProcessed = deps.transform(rendered);
    const verdict = tripwireCompare(planeProcessed, legacyProcessed);
    if (verdict.ok) {
        egressStats.cutover++;
        deps.log("info", `[snaplane] sid=${deps.sessionId} egress=cutover n=${planeProcessed.length} tail=${built.tailCount}`);
        return planeProcessed;
    }
    egressStats.fallback++;
    const n = (fallbackCounts.get(deps.sessionId) ?? 0) + 1;
    fallbackCounts.set(deps.sessionId, n);
    if (n >= EGRESS_EXCLUDE_AFTER) {
        egressExcluded.add(deps.sessionId);
        deps.log("warn", `[snaplane] sid=${deps.sessionId} decision=dead:egress sticky exclude after ${n} mismatches (last: ${verdict.reason})`);
    } else {
        deps.log("warn", `[snaplane] sid=${deps.sessionId} decision=red:egress:${verdict.reason} — legacy egress kept (${n}/${EGRESS_EXCLUDE_AFTER})${verdict.firstDiff ? ` — ${verdict.firstDiff}` : ""}`);
    }
    return legacyProcessed;
}
