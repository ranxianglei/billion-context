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
// openaiToCore output. Reuse is sound because wire identity is deterministic
// (content-hash canonical ids, #3642): the legacy re-parse would mint exactly
// the same cores for unchanged bytes.
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
// cost of skipping byte-level re-verification). Destructive rewrites —
// announced compaction, truncation, reorders that add/remove elements —
// change the count and are caught by the k-behind/k-ahead verdicts before
// any stale core could feed the kernel; under v4 (count relaxation below)
// the catch moves from the client echo to the ledger width arithmetic itself.
//
// v6 canonical lane (#5576, owner ruling 2026-11-03, rollout-gated
// `watermarkCanonicalV6`, default OFF): the hit verdict comes SOLELY from
// unified-transcript row-chain alignment (alignClientAgainstTranscript —
// fold-time id fast path, identity-sig fallback, MIN_SEAM_RUN discipline).
// The byte-compare / width-arithmetic machinery survives ONLY as negative
// filters built from server-side arithmetic over client-declared ledger ids;
// nothing compares prefix BYTES anymore, the rows ARE the prefix proof.
// On a hit the view is served from stored rows (covered regions suppressed,
// synthetic anchors spliced) plus this turn's converted tail; NO prefix-
// shaped state is pinned in memory (the seed stash is bypassed entirely on
// canonical outcomes). Every doubt degrades to the untouched legacy path.
import type { CoreMessage } from "acp-kernel";
import type { BiliMessage, OpenAIRequestBody } from "acp-kernel/wire";
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
import { alignClientAgainstTranscript, MAX_CHAIN_WALK } from "./snapshot-render.js";

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

interface PFSavedState {
    t: number;
    m: string;
    misses: number;
    disabledAt?: number;
    /** Last received tail-id list (#5418 v2) — survives restarts so the
     *  prevId continuity check is live on the first turn back. */
    l?: string[];
    /** #5571 v5: client-native session id digest recorded with this state
     *  (h8, never raw — privacy parity with #5571); sess-change gate input. */
    cs?: string;
}

interface PFSeed {
    readonly cores: readonly CoreMessage[];
    /** Verified head system run the stash was built under (real bytes). */
    readonly systemText: string;
    readonly stampT: number;
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
    /** #5576 v6: produced on the canonical lane (hit AND miss). Finalize
     *  must NOT pin seed-stash cores for these outcomes — retaining prefix-
     *  shaped state in memory is exactly what the canonical lane removes; a
     *  lane toggle back to v5 self-heals with one legacy verification turn. */
    readonly canonical?: boolean;
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
    const miss = (decision: string, credited: boolean, receivedTailIds?: string[]): FastpathOutcome => {
        if (credited) noteCreditedMiss(session.id, decision, log);
        log("info", `[${session.id}] watermark fastpath miss (${decision}) — legacy full-parse this turn`);
        return { hit: null, measuredT: T, decision, creditedMiss: credited, receivedTailIds, clientSess: nowCs };
    };
    const seed = seeds.get(session);
    const rawTailIds = req.headers[PF_TAIL_IDS_HEADER];
    // three states: undefined = header absent (pure count mode); null =
    // present but malformed; array = shape-valid.
    const parsedTailIds = rawTailIds === undefined ? undefined : typeof rawTailIds === "string" ? parseTailIds(rawTailIds) : null;
    // #5576 v6 (owner ruling 2026-11-03): when the canonical lane is live for
    // this install the verdict comes from unified-transcript row-chain
    // alignment instead of the v4/v5 machinery below — that code runs UNTOUCHED
    // for everyone else (default OFF keeps v5 byte-behavior the default).
    if (featureEnabled("watermarkCanonicalV6")) {
        return evaluateCanonicalV6({ session, bodyText, scan, saved, stamped, parsedTailIds, nowCs, miss });
    }
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
                if (prevKnown !== undefined && prevKnown !== PF_SLOT_UNKNOWN && tailIds[0] !== prevKnown) return miss("tail-ids-prev", false);
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
            if (nowCs !== undefined && nowCs !== saved.cs) return miss("sess-change", false, tailIds);
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

// #5576 v6 companion switch (env-only in v1): host-side rewrites that survive
// every filter and break the row-chain are content-rewrite class. Default:
// self-healing UNcredited legacy turns — host compaction/rewrite is normal
// traffic, not misbehavior (the legacy rewrite-detection machinery then
// marks the boundary and subsequent turns align against the rebased view).
// Strict mode credits them toward the breaker for exotic hosts whose
// thrash-rewriting would otherwise ride one free legacy turn forever.
function rewriteStrict(): boolean {
    return process.env.BILI_PF_V6_REWRITE_STRICT === "1";
}

/**
 * #5576 v6 canonical lane. Decision authority = transcript row-chain
 * alignment ONLY; the surviving pre-filters are pure server-side arithmetic
 * over client-declared ledger ids (negative filters, no byte comparison):
 *   ahead          echoed stamp above our own measurement (lying upstream);
 *   tail-ids-shape ledger list width ≠ T - K + 1 (shrink/gap/misframe);
 *   no-progress    count-only zero delta (empty window would pin nothing);
 *   sess-change    swapped client-native session identity (R7, unchanged).
 * The expensive stage converts the body once with the REAL codec (openaiToCore
 * over the same bytes the legacy path would parse — zero codec mirroring,
 * so cluster numbering can only agree with stored rows, never drift from it)
 * and hands the cores to alignClientAgainstTranscript. On ok: view = stored
 * rows up to the seam (covered regions suppressed behind synthetic anchors)
 * + this turn's tail cores; system text is re-decoded from the CURRENT head
 * every turn (passthrough by construction — there is no stashed system copy
 * to drift from, which retires the v5 head-drift gate entirely). On any miss
 * reason the caller runs the untouched legacy full-parse path; chain-class
 * reasons (chain-not-started / seam-too-short) are content-rewrite class and
 * credit per BILI_PF_V6_REWRITE_STRICT.
 */
function evaluateCanonicalV6(args: {
    session: Session;
    bodyText: string;
    scan: { total: number; messageSpans: readonly RawSpan[]; fieldSpans: ReadonlyMap<string, RawSpan> };
    saved: PFSavedState | null;
    stamped: number;
    parsedTailIds: string[] | null | undefined;
    nowCs: string | undefined;
    miss: (decision: string, credited: boolean, receivedTailIds?: string[]) => FastpathOutcome;
}): FastpathOutcome {
    const { session, bodyText, scan, saved, stamped, parsedTailIds, nowCs, miss } = args;
    const mm = (decision: string, credited: boolean, receivedTailIds?: string[]): FastpathOutcome =>
        ({ ...miss(decision, credited, receivedTailIds), canonical: true });
    const T = scan.total;
    if (!Number.isNaN(stamped) && stamped > T) return mm("ahead", true);
    // Width arithmetic on the client-declared ledger list (server-side check;
    // count-only clients carry no list and skip to pure alignment — v6 is
    // ALSO their first watermark access, the stamp echo is not required).
    let tailIds: string[] | undefined;
    const K = saved?.t;
    if (parsedTailIds !== undefined) {
        if (parsedTailIds === null || (K !== undefined && parsedTailIds.length !== T - K + 1)) return mm("tail-ids-shape", false);
        tailIds = parsedTailIds;
    } else if (K !== undefined && T <= K) {
        return mm("no-progress", false);
    }
    // R7 (unchanged from v5): a swapped client-native session riding one bili
    // session is an identity event, asserted only when both sides claim one.
    if (saved?.cs !== undefined && nowCs !== undefined && nowCs !== saved.cs) return mm("sess-change", false, tailIds);
    // Cheap structural pre-gates before paying for a conversion:
    const store = getStore();
    if (!store || !store.replicasAvailable()) return mm("v6-store-unavailable", false, tailIds);
    // One prior fold anchors the rows (unified-lane doctrine, #3482 client-
    // authoritative pre-fold); pre-fold sessions run the untouched path.
    if (!session.state.blocks.some((b) => b.active)) return mm("v6-pre-fold", false, tailIds);
    // Conversion range: the WHOLE body when affordable — the intra-call
    // cluster counter must see exactly the same occurrence stream the legacy
    // single-parse minted (windowed conversion would renumber duplicate
    // contents and desync the id fast path); the walk budget caps how far
    // alignment ever looks, so beyond MAX_CHAIN_WALK elements we convert the
    // walk-reachable suffix only (documented residual: dup-content bodies
    // past the cap lean on the sig fallback there).
    const spans = scan.messageSpans;
    const lo = T > MAX_CHAIN_WALK ? T - MAX_CHAIN_WALK : 0;
    const midBody: { messages: unknown } = { messages: [] };
    midBody.messages = parseElementSlices(bodyText, spans.slice(lo));
    if (!Array.isArray(midBody.messages)) return mm("fragment-parse", false, tailIds);
    const midCounts = stripRawStage(midBody, "openai");
    const cores = openaiToCore(midBody as OpenAIRequestBody);
    const res = alignClientAgainstTranscript(session, cores.msgs as BiliMessage[]);
    if (!res.ok) {
        const rewriteClass = res.reason === "chain-not-started" || res.reason === "seam-too-short";
        return mm(`v6-${res.reason}`, rewriteClass && rewriteStrict(), tailIds);
    }
    const clientJoin = res.clientJoin;
    // A full-length join (every converted core "anchored", no unmatched
    // trailing tail) is the signature of the documented sig-fallback
    // residual: a FRESH trailing element whose content collides with stored
    // history false-matches an old row through the sig path and swallows the
    // new tail (view would silently drop it). Degrade to legacy instead —
    // never serve a hit that ends before the request does.
    if (typeof clientJoin !== "number" || clientJoin >= cores.msgs.length) return mm("v6-no-seam-origin", false, tailIds);
    // Element-space window origin: codecs stamp each core with wireIndex =
    // its source element ordinal in the converted array (kernel contract,
    // bili-message sidecar doc). Windowed conversions number relative to lo.
    const seamWi = (cores.msgs[clientJoin] as { wireIndex?: unknown }).wireIndex;
    let eStar: number;
    if (typeof seamWi === "number") eStar = lo + seamWi;
    else if (K !== undefined) eStar = K; // codec gap: fall back to the persisted anchor
    else return mm("v6-no-seam-origin", false, tailIds);
    if (!(eStar >= lo && eStar < T)) return mm("v6-no-seam-origin", false, tailIds);
    // System passthrough (R3): decoded fresh from the CURRENT head every
    // turn — rows exclude hoisted system by design, so this is runtime state
    // flow, not prefix identity. The ≤8-element fragment also carries the
    // strip counts for the pre-window region on capped conversions.
    const headEnd = Math.min(HEAD_CHECK_ELEMENTS, T);
    const headFragment: { messages: unknown } = { messages: [] };
    headFragment.messages = parseElementSlices(bodyText, spans.slice(0, headEnd));
    if (!Array.isArray(headFragment.messages)) return mm("fragment-parse", false, tailIds);
    const headCounts = stripRawStage(headFragment, "openai");
    const systemText = openaiToCore(headFragment as OpenAIRequestBody).systemText ?? "";
    const markerCounts = lo > 0 ? addStripCounts(headCounts, midCounts) : midCounts;
    return {
        hit: {
            view: res.view as CoreMessage[],
            windowCores: cores.msgs.slice(clientJoin) as CoreMessage[],
            systemText,
            totalT: T,
            fieldSpans: scan.fieldSpans,
            windowMessages: midBody.messages.slice(eStar - lo),
            // Canonical lanes serve ACTUALLY-ingested cores: sidecars
            // (imagePart/rawOpenaiContent) survive the fold pipeline intact
            // and the egress positional rule computes over the real array —
            // the v5 multimodal degradation exists solely because the seed
            // STASH could not reproduce legacy bytes, which v6 has none of.
            seedMultimodal: false,
            markerCounts,
        },
        measuredT: T,
        decision: "hit-v6",
        creditedMiss: false,
        receivedTailIds: tailIds,
        clientSess: nowCs,
        canonical: true,
    };
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
        writeSaved(sessionId, { t: cur.t, m: cur.m, misses, disabledAt: Date.now(), cs: cur.cs });
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
    if (outcome.hit) {
        // #5576 v6: canonical outcomes pin NOTHING prefix-shaped in memory —
        // retaining the view here would recreate the very OOM pair (#5403)
        // the lane removes. A lane toggle back to v5 self-heals in one turn.
        if (!outcome.canonical) {
            seeds.set(session, {
                cores: outcome.hit.view,
                systemText: outcome.hit.systemText,
                stampT: T,
                model: input.model,
                stripCounts: outcome.hit.markerCounts,
                lastTailIds: outcome.receivedTailIds,
                multimodal: outcome.hit.seedMultimodal,
            });
        }
        writeSaved(session.id, { t: T, m: input.model, misses: 0, l: outcome.receivedTailIds, cs: outcome.clientSess ?? saved?.cs });
        headers[PF_SEQ_HEADER] = String(T);
        return headers;
    }
    if (input.legacyCores.length > 0 && !outcome.canonical) {
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
    writeSaved(session.id, { t: T, m: input.model, misses: saved?.misses ?? 0, disabledAt: saved?.disabledAt, l: outcome.receivedTailIds, cs: outcome.clientSess ?? saved?.cs });
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
