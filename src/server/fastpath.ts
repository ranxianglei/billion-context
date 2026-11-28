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
import type { CoreMessage } from "acp-kernel";
import type { OpenAIRequestBody } from "acp-kernel/wire";
import { openaiToCore } from "acp-kernel/wire";
import type http from "node:http";
import { featureEnabled } from "../rollout.js";
import { egressPlaneGateOn } from "../knobs.js";
import { getStore } from "../persist.js";
import type { Session } from "../session.js";
import { type RawStripCounts, stripRawStage } from "../marker/engine.js";
import { INCREMENTAL_TURN_MARKER_HEADER } from "../incremental-lane.js";
import { watermarkGateAllowed } from "./lane-decisions.js";
import { scanMessagesSpans, type RawSpan } from "./fastpath-scan.js";

export const PF_COUNT_HEADER = "x-bili-pf-count";
export const PF_SEQ_HEADER = "x-bili-pf-seq";
export const PF_TAIL_IDS_HEADER = "x-bili-pf-tail-ids";
// #5403 family, delta arm: the client sends body.messages as the NEW
// elements [stampT .. T-1] ONLY — the anchor (element stampT-1) stays in
// the server ledger and is NOT re-sent — with the full logical count in
// x-bili-pf-count and per-element ids in x-bili-pf-tail-ids (width exactly
// L+1 = anchor + the L new ids, L = T - stampT). The server rebuilds the
// view from the seed prefix cores + the re-parsed slice — the same
// FastpathHit the full-body lane produces, so every downstream stage
// (stage0 pin, kernel, ingest, snapshot) is untouched.
// Any unsatisfiable claim is a 400 re-anchor (DeltaReanchorError): the body
// CANNOT be processed by the legacy path (the prefix bytes are absent), so the
// only honest answer is "resend this turn in full form"; the client converges
// within one round (the same one-round contract as every pf miss).
export const PF_DELTA_HEADER = "x-bili-pf-delta";

/** Thrown from prepare-openai when a delta request cannot be satisfied —
 *  handle.ts maps it to the 400 re-anchor response (no pf-seq stamp, mode full). */
export class DeltaReanchorError extends Error {
    readonly reason: string;
    constructor(reason: string) {
        super(`pf delta re-anchor (${reason})`);
        this.name = "DeltaReanchorError";
        this.reason = reason;
    }
}

/** A satisfiable delta claim: the verified hit plus the tail-id list it rode on. */
interface DeltaVerdict {
    readonly hit: FastpathHit;
    readonly receivedTailIds?: string[];
}

const DELTA_WINDOW_MAX = 2048;
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
/** #7064 §8: the INCREMENTAL pin (stage0) parses the same header it pins
 *  from — one parser, one rule, parity-pinned via _parseTailIdsForTest. */
export function parseTailIdsForPin(raw: string): string[] | null { return parseTailIds(raw); }
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
    const miss = (decision: string, credited: boolean, receivedTailIds?: string[]): FastpathOutcome => {
        if (credited) noteCreditedMiss(session.id, decision, log);
        log("info", `[${session.id}] watermark fastpath miss (${decision}) — legacy full-parse this turn`);
        return { hit: null, measuredT: T, decision, creditedMiss: credited, receivedTailIds };
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
                if (prevKnown !== undefined && prevKnown !== PF_SLOT_UNKNOWN && tailIds[0] !== prevKnown) return miss("tail-ids-prev", false);
            }
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
        // In-place head EDIT detection. The system-text check alone would miss
        // an in-place rewrite of any non-system head element (dsh message-edit
        // flows): counts stay equal, the stamp stays honest, and the stale
        // seed byte would ride the outbound again — the costliest divergence
        // class. Compare every stashed prefix core against its freshly parsed
        // counterpart: openaiToCore is deterministic per element bytes, so
        // structural inequality (cluster id / role / content) marks a rewrite.
        // Uncredited: a genuine client edit is not a lying stamp, so the
        // breaker must not arm on it; finalizeWatermarkTurn reseeds from the
        // legacy full parse of THIS turn, so the very next turn hits against
        // the new baseline (self-healing). Shape mismatch covers small
        // histories where the head fragment reaches past seed coverage —
        // those turns legitimately go legacy.
        // Compare ONLY the part of the head still under seed coverage: on small
        // histories the 8-element head fragment legitimately reaches INTO the
        // fresh tail region, whose content differs from nothing stashed yet —
        // positions >= coverage are verified by the window conversion itself.
        // #7064 2×2 (2026-11-20 perf, 100k-session field data): the id field
        // is EXCLUDED from the comparison. The stash re-seeds from the
        // post-pin cores (prepare-openai rebinds originalMessages to
        // s0.pinned before finalizeWatermarkTurn), whose ids live in the
        // host-msgid/ledger namespace — structurally different from the
        // fresh content-hash ids openaiToCore mints, on EVERY turn of a
        // pinned session. Comparing ids therefore produced a permanent
        // head-prefix-drift miss: the watermark fastpath never hit exactly
        // for the 2×2 traffic it was designed for, and every turn paid the
        // full legacy parse + re-anchor. Content drift is still caught: the
        // same-body comparison below covers role/content, shape/length via
        // head-shape, and remint-with-identical-bytes is not a rewrite.
        const headElements = Array.isArray((headFragment as { messages?: unknown }).messages)
            ? ((headFragment as { messages: unknown[] }).messages.filter((m): m is { role?: unknown } => typeof m === "object" && m !== null && (m as { role?: unknown }).role !== "system")).length
            : -1;
        if (headElements >= 0 && seed.cores.length > 0) {
            const compareUpTo = Math.min(headElements, headCores.msgs.length, seed.cores.length);
            const seedHead = seed.cores.slice(0, compareUpTo);
            if (headCores.msgs.length < seedHead.length) return miss("head-shape", false, tailIds);
            for (let hi = 0; hi < seedHead.length; hi++) {
                const a = headCores.msgs[hi];
                const b = seedHead[hi];
                if (headCoreContentDiffers(a, b)) return miss("head-prefix-drift", false, tailIds);
            }
        }
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

/** In-place head-edit check, IGNORING the `id` field. In a pinned session
 *  (pluginLaneServerHistory) the seed cores carry host/ledger msgids while a
 *  fresh openaiToCore parse mints content-hash ids, so the id namespace differs
 *  structurally on every turn (#7345) — the id is not a content signal here.
 *  Content/role/shape inequality is still caught via the full JSON minus the
 *  id; a remint with identical bytes is not a rewrite. */
function headCoreContentDiffers(a: CoreMessage, b: CoreMessage): boolean {
    const strip = (c: CoreMessage): Record<string, unknown> => {
        const rest: Record<string, unknown> = { ...c };
        delete rest.id;
        return rest;
    };
    return JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
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
    const cur = readSaved(sessionId) ?? { t: 0, m: "", misses: 0 };
    // an EXPIRED hold has already paid its penalty — count fresh from zero,
    // or the very first verified miss after the TTL would instantly re-arm
    // (the persisted counter sits at PF_BREAKER_MISSES from the original trip).
    const staleHold = cur.disabledAt !== undefined && Date.now() - cur.disabledAt >= PF_DISABLED_TTL_MS;
    const misses = (staleHold ? 0 : cur.misses) + 1;
    if (misses >= PF_BREAKER_MISSES) {
        writeSaved(sessionId, { t: cur.t, m: cur.m, misses, disabledAt: Date.now() });
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
        seeds.set(session, {
            cores: outcome.hit.view,
            systemText: outcome.hit.systemText,
            stampT: T,
            model: input.model,
            stripCounts: outcome.hit.markerCounts,
            lastTailIds: outcome.receivedTailIds,
            multimodal: outcome.hit.seedMultimodal,
        });
        writeSaved(session.id, { t: T, m: input.model, misses: 0, l: outcome.receivedTailIds });
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
    writeSaved(session.id, { t: T, m: input.model, misses: saved?.misses ?? 0, disabledAt: saved?.disabledAt, l: outcome.receivedTailIds });
    headers[PF_SEQ_HEADER] = String(T);
    return headers;
}

/**
 * #5403 family, delta arm — evaluate ONE chat-completions request whose client
 * declared `x-bili-pf-delta: 1` (body.messages = tail slice, full count in
 * x-bili-pf-count). Returns null when the request does not claim delta (the
 * full-body lane owns it), {hit} when every gate passes, or {reanchor} when
 * the claim is unsatisfiable (the caller must 400 — the legacy path cannot
 * process a prefix-less body).
 *
 * Gates (all must hold — any doubt is a re-anchor, never a partial trust):
 *   rollout pluginDeltaResend on; plugin mode, not title-gen; a seed exists
 *   for THIS model and is not multimodal-tainted; x-bili-pf-count is an
 *   integer T; L = T - seed.stampT + 1 satisfies 1 ≤ L ≤ DELTA_WINDOW_MAX;
 *   body.messages has EXACTLY L elements; x-bili-pf-tail-ids is shape-valid
 *   with width exactly L and the anchor id continuous with the seed's last
 *   tail-id list ("?" exempt); the structural scan of the (small) body agrees
 *   on L; the anchor element re-parses byte-identical (id-excluded, #7064 2×2
 *   namespace rule) to the stashed core at position stampT-1; no system/developer
 *   element rides the slice (system lives in the seed's verified head).
 *
 * On a hit the window is re-parsed + rekeyed exactly like the full-body hit
 * (K = stampT-1: the slice INCLUDES the anchor), the anchor's strip counts
 * stay with the seed ledger (it was stripped on the previous turn — same
 * convention as the full path's head fragment), and view = stashed prefix
 * [0..stampT-2] + rekeyed slice = the canonical T-element array.
 */
export function evaluateDeltaResend(
    parsed: OpenAIRequestBody,
    bodyText: string,
    req: http.IncomingMessage,
    session: Session,
    input: { pluginMode: boolean; titleGen: boolean; model: string },
    log: (level: string, msg: string) => void,
): DeltaVerdict | { readonly reanchor: string } | null {
    const rawDelta = req.headers[PF_DELTA_HEADER];
    if (rawDelta === undefined) return null;
    const reanchor = (reason: string): { reanchor: string } => {
        log("info", `[${session.id}] watermark delta re-anchor (${reason}) — 400, the client resends this turn in full form`);
        return { reanchor: reason };
    };
    if (String(rawDelta) !== "1") return reanchor("delta-bad-value");
    if (!featureEnabled("pluginDeltaResend")) return reanchor("rollout-off");
    // #7875 (owner ruling 2026-11-28, regression-conservative): the delta arm is
    // scoped to the egress plane - active only under eg-on. An eg-off instance
    // 400-reanchors a delta claim so the client resends this turn in full form
    // (no new code path touches a legacy deployment).
    if (!egressPlaneGateOn()) return reanchor("eg-off");
    if (!input.pluginMode || input.titleGen) return reanchor("gate");
    const tail: unknown[] | null = Array.isArray(parsed.messages) ? parsed.messages : null;
    const seed = seeds.get(session);
    if (seed === undefined) return reanchor("unseeded");
    if (seed.model !== input.model) return reanchor("model");
    if (seed.multimodal) return reanchor("seeded-multimodal");
    // Stashed cores are CORE-space: openaiToCore hoists the leading
    // system/developer run OUT of them, so cores.length = stampT − S (S =
    // hoisted systems), never positionally indexable by wire element.
    if (seed.cores.length === 0) return reanchor("seed-empty");
    const rawStamp = req.headers[PF_COUNT_HEADER];
    const T = typeof rawStamp === "string" && /^\d+$/.test(rawStamp.trim()) ? parseInt(rawStamp.trim(), 10) : NaN;
    if (!Number.isInteger(T) || T < 1) return reanchor("no-count");
    // The body carries the NEW elements [stampT .. T-1] ONLY (KDD#22 wire:
    // tail-ids carry anchor+new, the body carries what the client is appending).
    // L = T - stampT; the anchor is element stampT-1, already in the ledger.
    const L = T - seed.stampT;
    if (L < 1) return reanchor("behind");
    if (L > DELTA_WINDOW_MAX) return reanchor("window-too-large");
    if (tail === null || tail.length !== L) return reanchor("body-length");
    const rawTailIds = req.headers[PF_TAIL_IDS_HEADER];
    const tailIds = rawTailIds === undefined ? null : typeof rawTailIds === "string" ? parseTailIds(rawTailIds) : null;
    // tail-ids = anchor + the L new ids (the real client's steady-state form).
    if (tailIds === null || tailIds.length !== L + 1) return reanchor("tail-ids-shape");
    // Anchor continuity: once the previous turn stamped a tail list, the
    // list MUST open with the id it ended on — the same identity the full
    // lane's overlap row verifies against the ledger. A tail-less seed (the
    // first request of the session carries no pf headers by design) has no
    // stamped prev: the FIRST delta turn opens unverified, and from then on
    // every list is chained. An edited/deleted last message by construction
    // forces the full form too (the client's declared anchor id would not
    // match the ledger on the pin side).
    const prevKnown = seed.lastTailIds !== undefined && seed.lastTailIds.length > 0 ? seed.lastTailIds[seed.lastTailIds.length - 1] : undefined;
    if (prevKnown !== undefined && prevKnown !== PF_SLOT_UNKNOWN && tailIds[0] !== prevKnown) return reanchor("tail-ids-prev");
    const scan = scanMessagesSpans(bodyText, "all");
    if (scan === null || scan.total !== L) return reanchor("scan-broken");
    // Strip + convert the new elements exactly as the full-body lane decodes
    // its window (K = stampT); the anchor's strip counts stay with the seed
    // ledger (they were counted on the previous turn). Rekey against the FULL
    // stashed prefix so cluster ordinals and wireIndex match the legacy
    // single full-body parse.
    const windowFragment: { messages: unknown } = { messages: tail };
    const windowCounts = stripRawStage(windowFragment, "openai");
    const windowRaw = openaiToCore(windowFragment as OpenAIRequestBody);
    if (windowRaw.systemText.trim() !== "") return reanchor("window-system-head");
    if (windowRaw.msgs.length !== L) return reanchor("window-shape");
    const rekeyedWindow = rekeyWindowCores(windowRaw.msgs, seed.stampT, seed.cores);
    const view = [...seed.cores, ...rekeyedWindow] as CoreMessage[];
    return {
        hit: {
            view,
            windowCores: rekeyedWindow as CoreMessage[],
            systemText: seed.systemText,
            totalT: T,
            fieldSpans: scan.fieldSpans,
            windowMessages: windowFragment.messages as unknown[],
            seedMultimodal: JSON.stringify(tail).includes('"image_url"'),
            markerCounts: addStripCounts(seed.stripCounts, windowCounts),
        },
        receivedTailIds: tailIds,
    };
}

/** Stamp-only turn (flag off, #7367): the x-bili-pf-seq heartbeat is the
 *  client's watermark advance, NOT fastpath-only state. When
 *  pluginFullResendWatermark is gated off the fastpath never evaluates, so
 *  finalizeWatermarkTurn never runs and the stamp stops — the client's k2
 *  freezes and its x-bili-pf-tail-ids grows one id per turn until it crosses
 *  Node's 16 KB header limit and wedges the session. Emit the stamp whenever
 *  T is measurable (the structural scan is the same zero-allocation pass the
 *  fastpath uses) so the client's tail stays bounded. No seed, no saved
 *  state: the fastpath re-establishes both on its first evaluated turn. */
export function stampOnlyWatermarkTurn(bodyText: string): Record<string, string> {
    const scan = scanMessagesSpans(bodyText, "all");
    if (scan === null) return {};
    return { [PF_SEQ_HEADER]: String(scan.total) };
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
