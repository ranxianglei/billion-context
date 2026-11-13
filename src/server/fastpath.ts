// #5403/#5418 watermark fastpath — plugin-lane full-resend turns (the dsh
// threads model: the host re-sends the ENTIRE history plus the new tail on
// every request). The legacy path JSON.parses and re-converts the identical
// multi-hundred-MiB prefix every turn, materializing an AST that
// snapshotMessages then pins in session.lastMessages across turns — the
// #5403 OOM producer pair. This lane ASSERTS the prefix is unchanged via a
// watermark (x-bili-pf-count) that the PREVIOUS response stamped with the
// server-measured element count T, and on a hit decodes only:
//   * the head fragment (first HEAD_CHECK_ELEMENTS elements) — verifies the
//     leading system run still matches what the stashed cores were built from
//   * the tail fragment [k..T) — the only genuinely new content
//   * each remaining top-level field individually (scalars + tools)
// Prefix CORES come from the in-memory seed: the previous turn's canonical
// openaiToCore output, SHARED across model projections (contract R6): one
// logical ledger (`pf:state.lg`) per session, one derived projection per
// (model × wire format) — the first request for a new model pays one full
// legacy pass building that projection, subsequent turns are pure
// incremental appends. Reuse is sound because wire identity is deterministic
// (content-hash canonical ids, #3642): the legacy re-parse would mint exactly
// the same cores for unchanged bytes.
//
// v6 canonical-ledger unification (owner rulings 2026-11-03, contract
// R1–R8): the HIT DECISION derives from the canonical transcript ALIGNMENT,
// not from parallel byte gates. Mechanically, snapshot-render's id fast-path
// IS this channel's set-diff: host msgids are unique forever, so a list that
// is a PURE APPEND to the session's cumulative ledger (`pf:state.lg`) is
// equivalent to the backward id-chain anchored on the transcript succeeding.
// Consuming snapshot-render's full walk here would pay the very O(N) parse
// this lane exists to avoid (guidance item 2) — the set-diff fronts the same
// semantic contract as the primary cheap gate; snapshot-render confirms on
// the free turns (miss turns already pay the full parse; see
// probeTranscriptAlignment).
//
// Fail-soft contract (anti-deviation lock): the legacy pipeline is UNTOUCHED
// code — this module only swaps the inputs the caller feeds it when EVERY
// gate agrees. Any doubt (missing/garbage stamp — UNLESS a ledger-proven
// tail-id list carries the request, #5403/#5418 v4 count relaxation —
// model switch, head-system drift, a system/developer element at the window
// head — hoist hazard — broken scan, armed breaker) falls back to the
// legacy path for that turn, and the response re-stamps the freshly measured
// T so the client converges within one round-trip.
//
// Declared trust boundary (§7.4 human review required): a client that edits
// prefix bytes while keeping the element count constant is NOT detected (the
// cost of skipping byte-level re-verification). v6: the verdict rides the
// CANONICAL LEDGER instead of byte comparison — the list must be a pure
// append to pf:state.lg (host msgids unique forever); a structural rewrite
// that survives the shape gates takes ONE conservative credited legacy pass
// and the increment rides passthrough-as-new-message from the next turn
// (watermarkCompactionPassthrough knob, default ON; R4/O3), never a
// speculative rebuild. The remaining pre-v6 gates survive WHERE ALIGNMENT
// CANNOT COVER THEM: width arithmetic = shim-protocol shape validity +
// server-side window-origin K (it re-verifies the exact width the ids assert);
// the origin pin = a gap-tolerant alignment would ride a re-minted origin
// slot the client no longer claims; the head SYSTEM-text gate = a prompt has
// no msgid (flagged deviation: serving a stale prompt beats saving one
// parse); model switch = physical projection partition (R6) over ONE logical
// ledger. Count-only turns stay byte-identical to pre-v6 in every branch.
import type { CoreMessage } from "acp-kernel";
import type { OpenAIRequestBody } from "acp-kernel/wire";
import { openaiToCore } from "acp-kernel/wire";
import type http from "node:http";
import { createHash } from "node:crypto";
import { featureEnabled } from "../rollout.js";
import { getStore } from "../persist.js";
import type { Session } from "../session.js";
import { type RawStripCounts, stripRawStage } from "../marker/engine.js";
import { INCREMENTAL_TURN_MARKER_HEADER } from "../incremental-lane.js";
import { watermarkGateAllowed } from "./lane-decisions.js";
import { scanMessagesSpans, type RawSpan } from "./fastpath-scan.js";

export const PF_COUNT_HEADER = "x-bili-pf-count";
export const PF_SEQ_HEADER = "x-bili-pf-seq";
export const PF_TAIL_IDS_HEADER = "x-bili-pf-tail-ids";

// #5571 v5 (owner ruling 2026-11-03): identity-only verification takes the
// client's NATIVE session id as an identity input alongside host msgids.
// Canonical table lives in #5571's native-identity-profiles; these three
// spellings are byte-duplicated here (#3482 precedent) so this module stays
// dependency-free of the observation layer.
const CLIENT_SESS_HEADERS = ["x-conversation-id", "x-claude-code-session-id", "x-session-affinity"] as const;

/** h8 digest of whichever known client session header carries a value
 *  (first hit wins); undefined when none does — absence claims nothing. */
function clientSessDigest(req: http.IncomingMessage): string | undefined {
    for (const h of CLIENT_SESS_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string" && v.length > 0) return createHash("sha1").update(v).digest("hex").slice(0, 8);
    }
    return undefined;
}
// #5418 v3: UNIDENTIFIED slot marker — an element that carries no host id
// (native-compaction summary, persona sidecar, foreign shape) travels as "?".
// Wire literal duplicated per #3482 (agent bundles stay import-free leaves).
export const PF_SLOT_UNKNOWN = "?";
const HEAD_CHECK_ELEMENTS = 8;
const PF_BREAKER_MISSES = 5;
const PF_DISABLED_TTL_MS = 60 * 60 * 1000;
const PF_EXT_KEY = "pf:state";
// #5403/#5418 v6 (contract R2): bounds for the cumulative host-id ledger
// (`lg`). Entry shape mirrors parseTailIds screening (len 1..512, no '?');
// the FIFO drop and serialized-size guard follow the obs layer's ≤4KB-style
// discipline scaled to the watermark cohort's realistic history depth.
const PF_LEDGER_CAP = 2048;
const PF_LEDGER_MAX_BYTES = 48 * 1024;

interface PFSavedState {
    t: number;
    m: string;
    misses: number;
    disabledAt?: number;
    /** Last received tail-id list (#5418 v2) — survives restarts so the
     *  prevId continuity check is live on the first turn back. */
    l?: string[];
    /** #5403/#5418 v6 (contract R2): CUMULATIVE host-id ledger for THIS
     *  session — every real id ever observed on the channel, in order,
     *  FIFO-capped (oldest dropped past PF_LEDGER_CAP / serialized-size
     *  guard); '?' slots never recorded. MODEL-INDEPENDENT by design (R6):
     *  projections partition on (model × wire format), the logical ledger
     *  does not — a model flip rebuilds the projection but inherits the
     *  id bookkeeping. Grown ONLY in finalizeWatermarkTurn from this
     *  turn's shape-valid list (no server-authored text ever enters);
     *  consumed as the set-diff baseline for the v6 rewrite classification.
     *  Bootstrap/migration: sessions predating v6 fall back to `l`. */
    lg?: string[];
    /** #5571 v5: client-native session id digest recorded with this state
     *  (h8, never raw — privacy parity with #5571); sess-change gate input. */
    cs?: string;
}

interface PFSeed {
    readonly cores: readonly CoreMessage[];
    /** Verified head system run the stash was built under (real bytes). */
    readonly systemText: string;
    readonly stampT: number;
    /** Projection-cache key (v6/R6): the seed is ONE (model × wire-format)
     *  projection over the shared logical ledger — a model flip rebuilds the
     *  projection via one legacy pass but keeps the id bookkeeping (`lg`). */
    readonly model: string;
    /** Full-body marker-strip ledger carried from the seed turn — the middle
     * region is never re-scanned, so its stripped-marker accounting rides
     * with the seed (unchanged-by-assertion). */
    readonly stripCounts: RawStripCounts;
    /** Host message ids of elements [stampT_prev-1 .. stampT-1] as sent by
     *  our shim last turn (#5418 v2) — its LAST entry is the prevId the next
     *  request's list must open with. Undefined until one was received. */
    readonly lastTailIds?: string[];
    /** Some stashed core came from a content-array element (e.g.
     * image_url). openaiToCore renders the LAST such element differently
     * from a mid-history one (verified kernel positional rule), so once the
     * stash has absorbed a multimodal tail it can no longer reproduce
     * legacy byte-for-byte: the lane degrades to full legacy turns for the
     * rest of the history (honest fallback, no parity risk). */
    readonly multimodal: boolean;
}

/** In-memory per-session prefix stash — deliberately OUTSIDE the Session
 * object: it is only a re-parse cache, not session truth. */
const seeds = new WeakMap<Session, PFSeed>();

export interface FastpathHit {
    /** Full view cores: stashed prefix + this turn's window (renderMsgs source). */
    readonly view: CoreMessage[];
    /** Only this turn's window cores — the tail that gets pinned resident. */
    readonly windowCores: CoreMessage[];
    /** Verified head system run (REAL current bytes, not the seed's copy). */
    readonly systemText: string;
    /** Server-measured element count T of this request. */
    readonly totalT: number;
    /** Raw spans of every top-level field except messages (parsed individually by the caller). */
    readonly fieldSpans: ReadonlyMap<string, RawSpan>;
    /** Post-strip raw window messages (already run through stripRawStage). */
    readonly windowMessages: unknown[];
    /** Whether the seed must be remembered as multimodal-tainted after this
     * hit (see PFSeed.multimodal). */
    readonly seedMultimodal: boolean;
    /** Seed-carried middle + this turn's head/window fragments = what a full-body
     * strip would have counted; feeds the same markerStripped input as legacy. */
    readonly markerCounts: RawStripCounts;
}

export interface FastpathOutcome {
    readonly hit: FastpathHit | null;
    /** Measured T whenever the structural scan succeeded (stampable regardless of verdict). */
    readonly measuredT: number | undefined;
    readonly decision: string;
    readonly creditedMiss: boolean;
    /** Tail-id list received THIS turn, shape-valid — finalize carries it
     *  into the (re)seeded state either way so continuity holds across both.
     *  Absent (undefined) for count-only turns or shape-invalid lists. */
    readonly receivedTailIds?: string[];
    /** #5571 v5: client-native session id digest of THIS request
     *  (undefined when no known header carried a value). Persisted by
     *  finalize as state `cs`; feeds the sess-change identity gate. */
    readonly clientSess?: string;
    /** #5403/#5418 v6 (contract R7): set when the cs (sess-change) gate
     *  fired — the incoming conversation SWAPPED. finalize honors it by
     *  holding the cumulative ledger: a swapped-in conversation's ids must
     *  never fold into this session's ledger (they describe different
     *  clients' history and would poison the set-diff baseline). */
    readonly ledgerHold?: boolean;
}

/** #5418 v2: decode the shim's x-bili-pf-tail-ids value.
 *  Wire form is ids.map(encodeURIComponent).join(","): each SEGMENT is
 *  individually percent-encoded, so any comma inside an id travels as %2C
 *  while separator commas stay literal — split(",") then per-segment
 *  decode is unambiguous for arbitrary id alphabets. All-or-nothing
 *  screening mirroring the host-side collector — a bad entry voids the
 *  WHOLE list, never a subset (partial identity claims are how
 *  mis-attribution starts, #2821 discipline). */
function parseTailIds(raw: string): string[] | null {
    const segs = raw.split(",");
    if (segs.length === 0 || segs.length > 2048) return null;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const seg of segs) {
        let id: string;
        try { id = decodeURIComponent(seg); } catch { return null; }
        if (id.length === 0 || id.length > 512) return null;
        if (id.startsWith("acp_summary_")) return null; // kernel anchor namespace (#5826 review parity: every other copy screens it; emitters pre-screen today, but the single server-side chokepoint enforces the full canonical set)
        if (/[\s\p{C}]/u.test(id)) return null;
        // #5418 v3 (owner ruling): "?" repeats are EXPECTED — hosts compress/
        // rewrite histories and those elements carry no host id. REAL ids
        // stay uniqueness-screened.
        if (id !== PF_SLOT_UNKNOWN) {
            if (seen.has(id)) return null;
            seen.add(id);
        }
        ids.push(id);
    }
    return ids;
}

/** Test-only accessor (#5826 review): pins tests/msgid-rule-parity.test.ts.
 *  Production callers use parseTailIds directly. */
export function _parseTailIdsForTest(raw: string): string[] | null { return parseTailIds(raw); }

function readSaved(sessionId: string): PFSavedState | null {
    try {
        const store = getStore();
        if (!store.replicasAvailable()) return null;
        const raw = store.getSessionExt(sessionId, PF_EXT_KEY);
        if (raw === undefined || raw === null) return null;
        const p = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
        if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
        const o = p as Partial<PFSavedState>;
        if (typeof o.t !== "number" || !Number.isInteger(o.t) || o.t < 0) return null;
        return {
            t: o.t,
            m: typeof o.m === "string" ? o.m : "",
            misses: typeof o.misses === "number" && Number.isInteger(o.misses) ? o.misses : 0,
            disabledAt: typeof o.disabledAt === "number" ? o.disabledAt : undefined,
            l: Array.isArray(o.l) && o.l.length > 0 && o.l.length <= 2048
                && (o.l as unknown[]).every((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 512)
                ? (o.l as string[]) : undefined,
            lg: Array.isArray(o.lg) && o.lg.length > 0 && o.lg.length <= PF_LEDGER_CAP
                && (o.lg as unknown[]).every((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 512)
                ? (o.lg as string[]) : undefined,
            cs: typeof o.cs === "string" && o.cs.length === 8 ? o.cs : undefined,
        };
    } catch {
        return null;
    }
}

function writeSaved(sessionId: string, state: PFSavedState): void {
    try {
        const store = getStore();
        if (!store.replicasAvailable()) return;
        store.setSessionExt(sessionId, PF_EXT_KEY, JSON.stringify(state));
    } catch { /* state is advisory — losing it degrades to verify-next-turn */ }
}

/** #5403/#5418 v6 (contract R2): grow the cumulative host-id ledger from
 *  one shape-valid tail-id list. Real ids append in list order, deduped;
 *  '?' slots never enter (unknown identity claims nothing); the result is
 *  FIFO-trimmed to PF_LEDGER_CAP entries / PF_LEDGER_MAX_BYTES serialized
 *  (oldest dropped first). Append-only — server-authored text is NEVER
 *  injected here (R2), the list is the client's own id surface as screened
 *  by parseTailIds. No-op turns (nothing new) return the previous ledger so
 *  the persisted state is untouched. */
function growPfLedger(
    saved: PFSavedState | null,
    list: readonly string[],
): string[] | undefined {
    // Bootstrap/migration: pre-v6 sessions carry only `l` (last list).
    const base = saved?.lg ?? saved?.l ?? [];
    const known = new Set(base);
    const out: string[] = [];
    for (const id of base) {
        if (!known.has(id)) known.add(id); // defensive dedupe of hand-edited state
        out.push(id);
    }
    for (const id of list) {
        if (id === PF_SLOT_UNKNOWN || known.has(id)) continue;
        known.add(id);
        out.push(id);
    }
    // Serialized-size estimate: two quotes + one separator per entry
    // (JSON escapes in exotic id alphabets only inflate a little; the
    // per-entry len cap bounds the worst case).
    const jsonLen = (arr: string[]): number => arr.reduce((n, s) => n + s.length + 3, 1);
    while (out.length > PF_LEDGER_CAP || jsonLen(out) > PF_LEDGER_MAX_BYTES) {
        const dropped = out.shift();
        if (dropped !== undefined) known.delete(dropped);
        if (out.length === 0) return undefined; // pathological — start fresh next list
    }
    return out.length > 0 ? out : undefined;
}

function breakerArmed(saved: PFSavedState | null): boolean {
    return saved?.disabledAt !== undefined && Date.now() - saved.disabledAt < PF_DISABLED_TTL_MS;
}

/**
 * Evaluate the watermark fastpath for one chat-completions request. Pure w.r.t.
 * the legacy pipeline: on ANY miss the caller proceeds exactly as before; only
 * the `hit` shape carries replacement inputs.
 */
export function evaluateWatermarkFastpath(
    bodyText: string,
    req: http.IncomingMessage,
    session: Session,
    input: { pluginMode: boolean; titleGen: boolean; model: string },
    log: (level: string, msg: string) => void,
): FastpathOutcome {
    const saved = readSaved(session.id);
    const armed = breakerArmed(saved);
    const gate = watermarkGateAllowed({
        featureOn: featureEnabled("pluginFullResendWatermark"),
        pluginMode: input.pluginMode,
        titleGen: input.titleGen,
        incrementalTurn: req.headers[INCREMENTAL_TURN_MARKER_HEADER] !== undefined,
        breakerArmed: armed,
    });
    if (!gate) {
        if (armed) {
            // #5418 breaker semantics: while held we NEVER take a hit, but we
            // keep MEASURING T and restamping the response. A stampless hold
            // strands the client's stale watermark forever (held ⇒ no stamp ⇒
            // identical verdict next turn ⇒ rearms in an infinite loop). The
            // cost is the structural scan only (≪ a full parse); no credit
            // accrues while held.
            const scan = scanMessagesSpans(bodyText, "all");
            return scan === null
                ? { hit: null, measuredT: undefined, decision: "breaker-held-noscan", creditedMiss: false }
                : { hit: null, measuredT: scan.total, decision: "breaker-armed", creditedMiss: false };
        }
        return { hit: null, measuredT: undefined, decision: "gate-off", creditedMiss: false };
    }
    const scan = scanMessagesSpans(bodyText, "all");
    if (scan === null) return { hit: null, measuredT: undefined, decision: "scan-broken", creditedMiss: false };
    const T = scan.total;
    const rawStamp = req.headers[PF_COUNT_HEADER];
    const stamped = typeof rawStamp === "string" && /^\d+$/.test(rawStamp.trim()) ? parseInt(rawStamp.trim(), 10) : NaN;
    // #5571 v5: captured ONCE per evaluated turn — feeds the sess-change gate
    // below and rides the outcome so finalize persists it as state `cs`.
    const nowCs = clientSessDigest(req);
    const miss = (decision: string, credited: boolean, receivedTailIds?: string[], ledgerHold?: boolean): FastpathOutcome => {
        if (credited) noteCreditedMiss(session.id, decision, log);
        log("info", `[${session.id}] watermark fastpath miss (${decision}) — legacy full-parse this turn`);
        return { hit: null, measuredT: T, decision, creditedMiss: credited, receivedTailIds, clientSess: nowCs, ...(ledgerHold !== undefined ? { ledgerHold } : {}) };
    };
    const seed = seeds.get(session);
    const rawTailIds = req.headers[PF_TAIL_IDS_HEADER];
    // three states: undefined = header absent (pure count mode); null =
    // present but malformed; array = shape-valid.
    const parsedTailIds = rawTailIds === undefined ? undefined : typeof rawTailIds === "string" ? parseTailIds(rawTailIds) : null;
    // #5403/#5418 v4 count relaxation (owner ruling 2026-11-02): once a
    // session carries a ledger-proven tail-id list whose WIDTH matches its own
    // bookkeeping (len = T - seed.stampT + 1), msgid continuity proves the
    // window origin — the echoed x-bili-pf-count stops gating the hit and
    // demotes to diagnostic (a desynced echo self-heals via the restamp).
    // The length arithmetic is server-side: it re-verifies the exact width
    // count used to assert, so trusting ids instead of the echo widens NO
    // trust hole — prefix-shrink turns (compaction/truncation) yield a
    // negative width, fail it, and fall into the untouched ahead/seed-stale
    // verdicts. Zero delta (T === seed.stampT) keeps the no-progress miss:
    // an empty window would pin an empty lastMessages baseline.
    const idActive = parsedTailIds !== undefined && parsedTailIds !== null
        && seed !== undefined && seed.model === input.model
        && parsedTailIds.length === T - seed.stampT + 1;
    if (Number.isNaN(stamped)) {
        if (!idActive) return miss("no-stamp", false);
    } else if (!idActive) {
        if (stamped > T) return miss("ahead", true);
        if (stamped === T) return miss("no-progress", false);
    } else if (T === seed.stampT) {
        return miss("no-progress", false);
    }
    if (seed !== undefined && seed.model === input.model && (idActive || seed.stampT === stamped)) {
        // --- hit candidate: verify head + decode window ---------------------
        // K comes from the LEDGER (server-measured stampT), never from the
        // client echo — identical in pure count mode, where the entry above
        // proves stamped === stampT.
        const K = seed.stampT;
        // #5418 v3 (owner ruling 2026-11-02): hosts compress/rewrite, so no
        // alignment proof may gate this channel — msgids are unique forever,
        // ORDER binds them inside the verified delta, and the byte-level head
        // check below stays the boundary truth. A "?" slot rides an id-less
        // element; a "?" anchor merely means identity-unverified (no penalty).
        // Shape faults are shim/proxy drift — SILENTLY uncredited, never
        // toward the breaker (the legacy path + restamp self-heal). Absent
        // header = pure count mode (every pre-v2 behavior unchanged).
        let tailIds: string[] | undefined;
        if (parsedTailIds !== undefined) {
            if (parsedTailIds === null || parsedTailIds.length !== T - K + 1) return miss("tail-ids-shape", false);
            tailIds = parsedTailIds;
            if (tailIds[0] !== PF_SLOT_UNKNOWN) {
                const prevKnown = seed.lastTailIds !== undefined && seed.lastTailIds.length > 0 ? seed.lastTailIds[seed.lastTailIds.length - 1] : undefined;
                // "?" on EITHER side = no identity claim — no penalty; the
                // byte-level head checks below remain the boundary truth
                if (prevKnown !== undefined && prevKnown !== PF_SLOT_UNKNOWN && tailIds[0] !== prevKnown) return miss("tail-ids-prev", false, tailIds);
            }
        }
        // #5571 v5 (owner ruling 2026-11-03): session continuity joins the
        // identity proof. State carrying a client-native session id digest
        // means an earlier turn claimed an identity; this request must keep
        // claiming the SAME one — a swapped conversation riding one bili
        // session is an identity event, not a byte question. Neutral when
        // either side claims nothing (header-less clients unchanged);
        // asserted only when both sides do. Id mode only (no valid list
        // reached here without one).
        if (tailIds !== undefined && saved?.cs !== undefined) {
            if (nowCs !== undefined && nowCs !== saved.cs) return miss("sess-change", false, tailIds, true);
        }
        // --- v6 canonical-ledger classification (contract R1/R2/R4/R5) -----
        // Runs LAST among identity gates: width (shape/origin K) and the
        // origin pin above have already proven the window anchors on the
        // verified range, and the cs gate has ruled out conversation swaps.
        // The list spans slots [K-1 .. T-1], so every REAL id in it is either
        // (a) the window origin — pinned above, neutralized there when the
        // client re-mints it with no claim (#5418 v3) — or (b) inside the
        // verified range [K .. T-1]. Ids OUTSIDE [K-1..] legitimately never
        // reappear (pure-append traffic), so "vanishing from traffic" is NOT
        // a signal — the only thing detectable HERE is a REAL id that arrived
        // MID-LIST before a still-known id: history was structurally mutated
        // (client compaction summary inserted between two ids this session
        // already saw, or rows inserted/reordered) — the stashed prefix cores
        // describe a world the client no longer resends. With
        // watermarkCompactionPassthrough ON (default, R4/O3): ONE conservative
        // legacy pass (CREDITED — parity with the pre-v6 credited `ahead`/
        // head-drift catches; bounded by the 1h breaker on pathological
        // cycles), then the increment rides PASSTHROUGH-AS-NEW-MESSAGE from
        // the next turn — the summary block carries fresh host ids, the
        // finalize set-diff appends them naturally, NO suppression logic, and
        // never a speculative rebuild. OFF: skipped entirely — pre-v6
        // semantics (such a list passes everything below and rides the
        // stashed prefix under the v5 identity-only ruling, byte-compare
        // demoted to the diagnostic warn further down).
        let v6UnidentifiableIncrement = false;
        if (tailIds !== undefined && featureEnabled("watermarkCompactionPassthrough")) {
            const baseline = saved?.lg ?? saved?.l ?? [];
            const known = new Set(baseline);
            // Trailing region = maximal suffix holding NO known real id:
            // exactly the fresh increment ('?' counts as trailing-neutral;
            // an unknown real id claims NEWNESS, a known one ends the region).
            let cursor = tailIds.length;
            let newRealCount = 0;
            while (cursor > 0) {
                const s = tailIds[cursor - 1];
                if (s !== PF_SLOT_UNKNOWN && known.has(s)) break;
                if (s !== PF_SLOT_UNKNOWN) newRealCount += 1;
                cursor -= 1;
            }
            // Mid-list check over indices [1, cursor): index 0 is the window
            // ORIGIN — handled by the origin pin above (an unknown origin is
            // explicitly neutralized there, #5418 v3/#5571 v5). PROOF REQUIREMENT:
            // an unknown real id must be FOLLOWED by at least one still-known
            // slot (cursor > i) — "unknown before known" is the only shape
            // that proves in-range mutation from ids alone. A pure trailing run
            // of fresh ids (incl. a full-history compaction summary with fresh
            // ids) is NOT distinguishable from ordinary appends ⇒ rides by
            // default per R4/O3: the summary passes THROUGH AS A NEW MESSAGE,
            // its fresh ids enter the ledger via finalize, no suppression.
            let midInsertion = false;
            for (let i = 1; i < cursor; i++) {
                if (tailIds[i] !== PF_SLOT_UNKNOWN && !known.has(tailIds[i])) { midInsertion = true; break; }
            }
            if (!midInsertion) v6UnidentifiableIncrement = T > K && newRealCount === 0;
            if (midInsertion) {
                return miss("rewrite-passthrough", true, tailIds);
            }
            log("debug", `[${session.id}] [pf-v6] set-diff ok: ${newRealCount} new real id(s), trailing region ${tailIds.length - cursor}/${tailIds.length} slots, ledger ${baseline.length}`);
        }
        if (seed.multimodal) return miss("seeded-multimodal", false, tailIds);
        const headEnd = Math.min(HEAD_CHECK_ELEMENTS, T);
        const headFragment: { messages: unknown } = { messages: [] };
        const windowFragment: { messages: unknown } = { messages: [] };
        headFragment.messages = parseElementSlices(bodyText, scan.messageSpans.slice(0, headEnd));
        windowFragment.messages = parseElementSlices(bodyText, scan.messageSpans.slice(K));
        if (!Array.isArray(headFragment.messages) || !Array.isArray(windowFragment.messages)) return miss("fragment-parse", false, tailIds);
        stripRawStage(headFragment, "openai"); // legacy convention: strip before convert; head counts stay with the seed ledger
        const windowCounts = stripRawStage(windowFragment, "openai");
        const headCores = openaiToCore(headFragment as OpenAIRequestBody);
        if (headCores.systemText !== seed.systemText) return miss("head-drift", true, tailIds);
        // In-place head EDIT detection (pre-v5 history): the system-text
        // check alone misses an in-place rewrite of any non-system head
        // element (dsh message-edit flows) — counts stay equal, stamp stays
        // honest, stale seed byte rides outbound again. Pre-v5 that
        // comparison GATED: openaiToCore is deterministic per element bytes,
        // structural inequality marked a rewrite, uncredited self-healing
        // legacy turn (a genuine client edit is not a lying stamp).
        // v5 (owner ruling 2026-11-03, identity-only verification): with a
        // shape-valid HOST msgid list the identity chain IS the proof —
        // width arithmetic re-derives the count SERVER-side (never from a
        // client echo), the prevId chain pins the window origin, sess-change
        // rules out conversation swaps, model equality rules out cross-model
        // reuse. Bili INTERNAL core ids are content-derived
        // (deriveCanonicalMessageId(role,text)) — they carry no identity
        // beyond the byte check itself. So under id mode BOTH the id-
        // equality and byte-equality loops demote to a diagnostic warn: host
        // rewrites ride the stashed prefix cores; the warn stream feeds M3
        // smart re-seeding should the rides ever prove harmful. Pure-COUNT
        // clients have no ids at all — their byte check remains the sole
        // truth and behaves exactly as pre-v5. System text has no msgid
        // (flagged deviation in the ruling thread): head-drift above STAYS
        // gating in both modes — serving a stale prompt beats saving one
        // parse. Compare ONLY the part of the head still under seed coverage:
        // on small histories the 8-element head fragment legitimately reaches
        // INTO the fresh tail region, whose content differs from nothing
        // stashed yet — positions >= coverage are verified by the window
        // conversion itself.
        let contentDrifts = 0;
        let driftTotal = 0;
        const headElements = Array.isArray((headFragment as { messages?: unknown }).messages)
            ? ((headFragment as { messages: unknown[] }).messages.filter((m): m is { role?: unknown } => typeof m === "object" && m !== null && (m as { role?: unknown }).role !== "system")).length
            : -1;
        if (headElements >= 0 && seed.cores.length > 0) {
            const compareUpTo = Math.min(headElements, headCores.msgs.length, seed.cores.length);
            const seedHead = seed.cores.slice(0, compareUpTo);
            if (headCores.msgs.length < seedHead.length) return miss("head-shape", false, tailIds);
            driftTotal = seedHead.length;
            for (let hi = 0; hi < seedHead.length; hi++) {
                const a = headCores.msgs[hi];
                const b = seedHead[hi];
                if (a.id !== b.id || JSON.stringify(a) !== JSON.stringify(b)) {
                    if (tailIds === undefined) return miss("head-prefix-drift", false, tailIds);
                    contentDrifts += 1;
                }
            }
        }
        if (contentDrifts > 0) log("warn", `[${session.id}] watermark v5: ${contentDrifts}/${driftTotal} head element(s) differ from the seed under stable host ids — riding the stashed prefix per owner ruling 2026-11-03 (diagnostic only; feeds M3 re-seeding signals)`);
        const windowRaw = openaiToCore(windowFragment as OpenAIRequestBody);
        if (windowRaw.systemText.trim() !== "") return miss("window-system-head", true, tailIds);
        // R5: the body GREW (T > K) yet the increment carries NO host id —
        // an unidentifiable delta. We do NOT speculate: replay the stashed
        // snapshot (hit proceeds normally — every verifiable gate agreed)
        // and leave the ledger untouched (growth below is a natural no-op);
        // the structured diagnostic marks the gap for M3. Model-switch / fork
        // id-space questions live in research holds O1/O2 (contract) — no
        // speculative rebuild behavior may land ahead of them.
        if (v6UnidentifiableIncrement) log("warn", `[${session.id}] [pf-v6] unidentifiable-increment: T=${T} K=${K} — body grew but the increment carries no host id; replaying the stashed snapshot WITHOUT ledger append (R5; model-switch/fork id behavior pending research holds O1/O2)`);
        const rekeyedWindow = rekeyWindowCores(windowRaw.msgs, K, seed.cores);
        // v4 diagnostics ride the decision string (the debug/panel surfaces
        // already print it): pure count mode stays byte-identical "hit" —
        // off-string variants are unreachable there (entry proved stamped===K).
        const hitDecision = Number.isNaN(stamped) ? "hit(no-count)" : stamped === K ? "hit" : `hit(count-off=${stamped})`;
        return {
            hit: {
                view: [...seed.cores, ...rekeyedWindow] as CoreMessage[],
                windowCores: rekeyedWindow as CoreMessage[],
                systemText: headCores.systemText,
                totalT: T,
                fieldSpans: scan.fieldSpans,
                windowMessages: windowFragment.messages,
                seedMultimodal: seed.multimodal || JSON.stringify(windowFragment.messages).includes('"image_url"'),
                markerCounts: addStripCounts(seed.stripCounts, windowCounts),
            },
            measuredT: T,
            decision: hitDecision,
            creditedMiss: false,
            receivedTailIds: tailIds,
            clientSess: nowCs,
        };
    }
    return miss(seed === undefined ? "unseeded" : "seed-stale", false);
}

/** #3642 identity continuity. openaiToCore mints cluster ids (base, or base_N
 * by INTRA-CALL occurrence order) and stamps wireIndex from the array position
 * it was given. The window fragment was parsed alone, so both are
 * fragment-relative: a content base that also occurs in the stashed prefix
 * would be numbered from zero here while the ledger/fold coverage expect the
 * FULL-array ordinal the legacy single parse would have minted, and the seam
 * between prefix (absolute indices) and window (0..n-1) breaks run/adjacency
 * logic at small K (the prune first-user pin extends runs on equal
 * wireIndex; with K=1 both sides read 0 and two distinct wire messages would
 * merge into one rebuilt message). Restore both:
 *  - base = id minus the _N suffix — RAW ids are `h_` + 16 sha256-hex
 *    (kernel hashId), so the strip is unambiguous; non-raw shapes pass
 *    through untouched.
 *  - wireIndex += k — exactly the index the legacy full-body parse stamped.
 */
function rekeyWindowCores(
    cores: readonly CoreMessage[],
    k: number,
    prefix: readonly CoreMessage[],
): CoreMessage[] {
    const counts = new Map<string, number>();
    for (const c of prefix) {
        const base = baseOfRawId(c.id);
        counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    const out: CoreMessage[] = [];
    for (const c of cores) {
        const base = baseOfRawId(c.id);
        const n = counts.get(base) ?? 0;
        counts.set(base, n + 1);
        const wi = (c as { wireIndex?: number }).wireIndex;
        out.push({
            ...c,
            id: n === 0 ? base : `${base}_${n}`,
            ...(wi !== undefined ? { wireIndex: wi + k } : {}),
        } as CoreMessage);
    }
    return out;
}

function baseOfRawId(id: string): string {
    const m = /^h_[0-9a-f]{16}(?:_\d+)?$/u.exec(id);
    return m === null ? id : id.slice(0, 18);
}

/** openaiToCore materializes user content-array images as distinct cores
 * carrying an `imagePart`/`rawOpenaiContent` pair — used to detect
 * multimodal tails from already-converted cores (legacy-side seeding). */
function coresHaveImagePart(cores: readonly CoreMessage[]): boolean {
    for (const c of cores) {
        const o = c as { imagePart?: unknown; rawOpenaiContent?: { type?: unknown } };
        if (o.imagePart === true || o.rawOpenaiContent?.type === "image_url") return true;
    }
    return false;
}

function parseElementSlices(bodyText: string, spans: readonly RawSpan[]): unknown[] | null {
    if (spans.length === 0) return [];
    try {
        let s = `{"messages":[`;
        for (const sp of spans) s += bodyText.slice(sp.start, sp.end) + ",";
        s = s.endsWith(",") ? s.slice(0, -1) : s;
        s += "]}";
        const p = JSON.parse(s) as { messages?: unknown };
        return Array.isArray(p.messages) ? p.messages : null;
    } catch {
        return null;
    }
}

function addStripCounts(a: RawStripCounts, b: RawStripCounts): RawStripCounts {
    return {
        panels: a.panels + b.panels,
        statusBodies: a.statusBodies + b.statusBodies,
        statusBodyLines: a.statusBodyLines + b.statusBodyLines,
        markerLines: a.markerLines + b.markerLines,
        nudges: a.nudges + b.nudges,
        carriers: a.carriers + b.carriers,
        // both fragments were really walked — the sum is this request's strip wall time
        strippedMs: Number((a.strippedMs + b.strippedMs).toFixed(1)),
    };
}

function noteCreditedMiss(sessionId: string, decision: string, log: (level: string, msg: string) => void): void {
    const cur = readSaved(sessionId) ?? ({ t: 0, m: "", misses: 0 } as PFSavedState);
    // an EXPIRED hold has already paid its penalty — count fresh from zero,
    // or the very first verified miss after the TTL would instantly re-arm
    // (the persisted counter sits at PF_BREAKER_MISSES from the original trip).
    const staleHold = cur.disabledAt !== undefined && Date.now() - cur.disabledAt >= PF_DISABLED_TTL_MS;
    const misses = (staleHold ? 0 : cur.misses) + 1;
    if (misses >= PF_BREAKER_MISSES) {
        writeSaved(sessionId, { t: cur.t, m: cur.m, misses, disabledAt: Date.now(), l: cur.l, lg: cur.lg, cs: cur.cs });
        log("warn", `[${sessionId}] watermark fastpath disabled for ${Math.round(PF_DISABLED_TTL_MS / 60000)}m after ${misses} consecutive verified misses (last: ${decision}) — legacy full-parse continues`);
    } else {
        writeSaved(sessionId, { ...cur, misses, disabledAt: staleHold ? undefined : cur.disabledAt });
    }
}

/**
 * Call ONCE per EVALUATED turn (scan succeeded), AFTER the pipeline ran.
 * `legacyCores` must be this turn's canonical cores over the REAL bytes
 * (originalMessages) and `rawSystemText`/`turnStripCounts` the pre-anchor,
 * full-body values captured by the caller (openaiToCore output BEFORE
 * reconcileSystemAnchor mutates it; the full-body stripRawStage result for
 * legacy turns, or the hit's combined ledger) — together they are the next
 * turn's seed truth on both hit (view reuse) and miss (reseed) outcomes.
 * Returns extra success-response headers (the x-bili-pf-seq stamp for client
 * convergence; empty when the breaker holds the lane or nothing was measurable).
 */
export function finalizeWatermarkTurn(
    session: Session,
    outcome: FastpathOutcome,
    input: { model: string; legacyCores: readonly CoreMessage[]; rawSystemText: string; turnStripCounts: RawStripCounts },
): Record<string, string> {
    const headers: Record<string, string> = {};
    if (outcome.measuredT === undefined) return headers;
    const T = outcome.measuredT;
    const saved = readSaved(session.id);
    // #5403/#5418 v6 (R2/R7): sole ledger growth site. Grow when this turn
    // delivered a shape-valid list, the v6 knob is on, and the conversation
    // did not swap (cs gate fired ⇒ ledgerHold — a swapped-in conversation's
    // ids must not fold into this session's baseline). Non-grow turns carry
    // the stored ledger forward unchanged (never wipe).
    const lg = outcome.receivedTailIds !== undefined && !outcome.ledgerHold && featureEnabled("watermarkCompactionPassthrough")
        ? growPfLedger(saved, outcome.receivedTailIds)
        : saved?.lg;
    if (outcome.hit) {
        seeds.set(session, {
            cores: outcome.hit.view,
            systemText: outcome.hit.systemText,
            stampT: T,
            model: input.model,
            stripCounts: outcome.hit.markerCounts,
            lastTailIds: outcome.receivedTailIds,
            multimodal: outcome.hit.seedMultimodal,
        });
        writeSaved(session.id, { t: T, m: input.model, misses: 0, l: outcome.receivedTailIds, lg, cs: outcome.clientSess ?? saved?.cs });
        headers[PF_SEQ_HEADER] = String(T);
        return headers;
    }
    if (input.legacyCores.length > 0) {
        seeds.set(session, {
            cores: input.legacyCores,
            systemText: input.rawSystemText,
            stampT: T,
            model: input.model,
            stripCounts: input.turnStripCounts,
            lastTailIds: outcome.receivedTailIds,
            multimodal: coresHaveImagePart(input.legacyCores),
        });
    }
    // Held (breaker-armed) turns flow through here too and DO restamp: the
    // stamp is how a client converges on truth while the lane stays hit-less.
    writeSaved(session.id, { t: T, m: input.model, misses: saved?.misses ?? 0, disabledAt: saved?.disabledAt, l: outcome.receivedTailIds, lg, cs: outcome.clientSess ?? saved?.cs });
    headers[PF_SEQ_HEADER] = String(T);
    return headers;
}

/** Drop the in-process seed (e.g. an announced compaction was detected while
 *  the fastpath was silent on later turns). Cheap and idempotent; the next
 *  turn simply re-verifies via the legacy path. */
export function clearWatermarkSeed(session: Session): void {
    seeds.delete(session);
}

/** Introspection for panel/tests: whether a live prefix stash exists. */
export function watermarkDebugState(session: Session): { seeded: boolean; stampT?: number; model?: string; missCount?: number } {
    const seed = seeds.get(session);
    const saved = readSaved(session.id);
    return { seeded: seed !== undefined, stampT: seed?.stampT, model: seed?.model, missCount: saved?.misses };
}
