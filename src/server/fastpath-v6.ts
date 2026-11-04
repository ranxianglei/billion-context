// #5643 fastpath v6 — (sessionid,msgid) composite-identity-driven incremental
// fast lane. Full rework of the #5403 watermark line; PR #5576 lineage void
// (owner ruling 2026-11-04). Governing principles (contract §2, locked):
//
//  P1 identity uniqueness — the composite pair (client sessionid, msgid) is
//     THE identity marker regardless of carrier; bili-minted ids (kernel h_*)
//     belong to the render layer and NEVER enter hit judgement; the snapshot
//     partition key is server-minted pf_sid, decoupled from any client header.
//  P2 incremental parse only — hit turns transform ONLY the NEW element
//     spans (set difference, ANY positions in the body); the frozen prefix
//     is materialized from stored cores, raw request bytes leave memory at
//     end of turn (zero residency between turns).
//  P3 snapshot authority — every client-side structural change (compaction,
//     in-family model switch, reorder, in-place rewrite, renumbering) is
//     IGNORED; the view grows forward only; no single client event triggers
//     a global rebase.
//  P4 front-segment passthrough — the leading system run is freshly decoded
//     from each turn's own bytes (FRONT_REREAD_ELEMENTS head fragment); top-
//     level fields ride fieldSpans (caller parses individually); nothing
//     front-segment ever gets frozen.
//  P5 no full re-parse — hard red line; the ONLY legal full-registration
//     entrances are the cold-start arm turn and a fresh pf_sid mint (they
//     coincide). The arm turn's COMPUTATION rides the baseline pipeline; its
//     LEDGER REGISTRATION (once per world, at finalize) transforms each
//     element individually — the P5 exception covers both.
//  P7 data plane is metadata-derived — current state =
//     fold(ckpt, log-after-ckpt); in-memory mirrors are caches, losing one
//     costs a DB re-read, nothing more.
//  P9 no truncation — raw host ids travel and are stored verbatim; digests
//     may only appear in warn-level diagnostics.
//
//  Client compaction (B version, owner ruling 2026-11-04): when the dual
//  channels reconcile (complete, width sound, members sound) compaction is
//  IGNORED entirely — NEW elements are registered and converted wherever
//  they sit in the body; a compaction summary arriving as an ordinary
//  element is admitted with ZERO special treatment. The view keeps growing
//  forward; the token bill does not follow the client's /compact down
//  (explicitly accepted trade).
//
//  Wire form = FIXED TAIL WINDOW (F1, owner ruling in the #5652 review,
//  2026-11-04): x-bili-pf-tail-ids carries only the LAST PF_TAIL_WINDOW
//  element ids (body order), never the full history — header bytes stay
//  bounded by construction, so stock Node maxHeaderSize needs no tuning
//  and the old "list grows with history" 431 class cannot exist.
//  HONEST COVERAGE BOUNDARY (contract §3): judgement covers exactly the
//  tail-window identities plus the ledger chain. Prefix content older than
//  the window that the client rewrote/compacted away is NOT promised
//  detectable — same known boundary tier as "mid-history change at stable
//  total"; it rides the forward-append view (P3) instead of being faked.
//  x-bili-pf-count RETIRES from this lane (v6 never reads it); v5 lanes
//  keep their count logic untouched — two worlds, no cross-contamination.
//
//  Identity hard gate (§3.2): lane entry requires BOTH channels complete and
//  sound — a request-level carrier id AND an element-level tail-window list
//  of exactly min(PF_TAIL_WINDOW, T) members, every one a real unique id.
//  The four fault
//  classes (channel missing / width mismatch / malformed member /
//  consistency break) REJECT the request (400, structured body) with zero
//  data-plane side effects. Three prohibitions: no silent legacy fallback,
//  no counting-based attribution, no content-signature guessing. The ONE
//  sanctioned relief valve (§8 line 12): five CONSECUTIVE faults park v6
//  for 60 minutes — traffic then rides the baseline lanes (served, not
//  refused) so a stable client-unfixable fault cannot become a 400 loop;
//  parking and recovery are loudly logged. Configuration-level cohort
//  exclusion (non-shim carriers, plane-down nodes, parked sessions) is NOT
//  a fault: it passes silently to the v5/legacy lanes.
import type { CoreMessage } from "acp-kernel";
import type { OpenAIRequestBody } from "acp-kernel/wire";
import { openaiToCore } from "acp-kernel/wire";
import type http from "node:http";
import { randomBytes } from "node:crypto";
import { featureEnabled } from "../rollout.js";
import { getStore } from "../persist.js";
import type { SessionStore } from "../persist.js";
import type { Session } from "../session.js";
import { type RawStripCounts, stripRawStage } from "../marker/engine.js";
import { INCREMENTAL_TURN_MARKER_HEADER } from "../incremental-lane.js";
import { PF_SEQ_HEADER, PF_TAIL_IDS_HEADER } from "./fastpath.js";
import { scanMessagesSpans, type RawSpan } from "./fastpath-scan.js";

/** #5643: the O(1) echo channel. Every v6-engaged response carries the minted
 *  pf_sid here; clients learn it and re-send it. Server-side it ACCELERATES
 *  matching (rule ①, skips ambiguity) — correctness additionally spot-checks
 *  any id the global probe resolves (a claim contradicted by the plane is a
 *  consistency-break fault). */
export const PF_SESSION_HEADER = "x-bili-pf-session";

const PF_SID_RE = /^pf_[0-9a-f]{12}$/u;
/** P4 front re-read width: leading system run decoded fresh per turn. */
const FRONT_REREAD_ELEMENTS = 8;
/** Breaker cadence (contract §8 line 12; same numbers the v5 line proved). */
const PF_V6_BREAKER_FAULTS = 5;
const PF_V6_DISABLED_TTL_MS = 60 * 60 * 1000;
/** F1 (owner ruling 2026-11-04, PR #5652 review): fixed TAIL-WINDOW size —
 *  Mirror of src/agent/pf-channel.ts PF_TAIL_WINDOW (wire owner declares it
 *  over there; both sides carry the literal with cross-references).
 *  the emit side sends ONLY the last N captured element ids; the server
 *  expects exactly min(N, T). Byte budget derivation (the ruling's formula
 *  budget = N × measured-max-segment × margin 2): measured fleet segment
 *  lengths are uuid-hex32 (wb X-Conversation-Message-ID), msg_<12hex>
 *  (opencode), hex/dotted kernel ids (dsh/pi/omp lanes); the screening cap
 *  above stays 512 raw chars worst case. With N = 64 even adversarial
 *  maximum-length ids encode to ≤ ~33 KB… which exceeds stock Node's
 *  ≈16 KB default maxHeaderSize — so the realistic measured distribution
 *  (≤ ~70 encoded bytes per segment for every lane we ship today) bounds
 *  the header at ≈ 64 × 70 ≈ 4.5 KB, comfortably inside. A list LONGER
 *  than the window is a loud width/malformed reject, not a degrade. */
const PF_TAIL_WINDOW = 64;
/** Ledger working-copy cap (contract §4): in-memory SEEN index only. The
 *  DISK plane is unlimited — trimming drops just the shortcut; evicted ids
 *  take the DB probe path (still correct, one extra index lookup). */
const SEEN_WORK_COPY_CAP = 2048;
const MAX_ID_LEN = 512;
const BAD_ID_CHARS = /[\s\p{C}]/u;
const EMPTY_STRIP: RawStripCounts = { panels: 0, statusBodies: 0, statusBodyLines: 0, markerLines: 0, nudges: 0, carriers: 0 };

/** Terminal identity fault (§3.2): prepareOpenai lets it propagate,
 *  handle.ts maps it to a 400 JSON refusal. NO data-plane write ever
 *  precedes the throw — matching is read-only. The guard counter (separate
 *  ext key, protection layer) records the fault BEFORE the throw, because
 *  §8 line 12 requires the breaker to COUNT rejects; that bookkeeping lives
 *  deliberately outside the identity plane (three tables + world metadata). */
export class FastpathV6IdentityFault extends Error {
    readonly status = 400;
    constructor(readonly detail: string) {
        super(`fastpath v6 identity fault: ${detail}`);
        this.name = "FastpathV6IdentityFault";
    }
    toJSON(): { error: { message: string; type: string; code: string; detail: string } } {
        return { error: { message: "Request identity is incomplete or inconsistent for the incremental fast lane.", type: "invalid_request_error", code: "pf_v6_identity_fault", detail: this.detail } };
    }
}

// --- protection-layer guard (breaker state; advisory ext key "pf:v6-guard") --
// Memory-first mirror: the breaker must survive across calls WITHIN a process
// even without durable replicas (single-replica nodes are exactly where the
// OOM pairs bite). The ext copy adds cross-replica / cross-boot continuity;
// it is best-effort and never gates the lane by itself.
interface GuardState { faults: number; disabledAt?: number }

const GUARD_MEM_CAP = 4096;
const guardMem = new Map<string, GuardState>();

function readGuard(store: SessionStore, sessionId: string): GuardState {
    const m = guardMem.get(sessionId);
    if (m !== undefined) return m;
    try {
        const raw = store.getSessionExt(sessionId, "pf:v6-guard");
        const p = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
        if (typeof p !== "object" || p === null || Array.isArray(p)) return { faults: 0 };
        const o = p as Partial<GuardState>;
        return {
            faults: typeof o.faults === "number" && Number.isInteger(o.faults) && o.faults >= 0 ? o.faults : 0,
            disabledAt: typeof o.disabledAt === "number" ? o.disabledAt : undefined,
        };
    } catch {
        return { faults: 0 };
    }
}

function writeGuard(store: SessionStore, sessionId: string, g: GuardState): void {
    if (guardMem.size >= GUARD_MEM_CAP) guardMem.clear();
    guardMem.set(sessionId, g);
    try {
        store.setSessionExt(sessionId, "pf:v6-guard", { faults: g.faults, disabledAt: g.disabledAt });
    } catch { /* advisory */ }
}

function recordFault(store: SessionStore, sessionId: string, detail: string, log: (level: string, msg: string) => void): void {
    const cur = readGuard(store, sessionId);
    // An EXPIRED hold already paid its penalty — count fresh, or the first
    // fault right after the TTL would instantly re-trip (v5 lesson, kept).
    const staleHold = cur.disabledAt !== undefined && Date.now() - cur.disabledAt >= PF_V6_DISABLED_TTL_MS;
    const faults = (staleHold ? 0 : cur.faults) + 1;
    if (faults >= PF_V6_BREAKER_FAULTS) {
        writeGuard(store, sessionId, { faults, disabledAt: Date.now() });
        log("warn", `[${sessionId}] fastpath v6 PARKED ${Math.round(PF_V6_DISABLED_TTL_MS / 60000)}m after ${faults} consecutive identity faults (last: ${detail}) — traffic rides baseline lanes, data plane untouched`);
    } else {
        writeGuard(store, sessionId, { faults, disabledAt: staleHold ? undefined : cur.disabledAt });
        log("error", `[${sessionId}] fastpath v6 REJECTED (${faults}/${PF_V6_BREAKER_FAULTS}): ${detail}`);
    }
}

function creditReset(store: SessionStore, sessionId: string, prevDisabledAt: number | undefined): void {
    try {
        if (!store.replicasAvailable()) return;
        store.setSessionExt(sessionId, "pf:v6-guard", { faults: 0, disabledAt: prevDisabledAt });
    } catch { /* advisory */ }
}

/** Format-level soft miss (§5 step 7): non-identity judgement fell short
 *  this turn (unparseable span, hydrate hiccup…). The lane degrades quietly
 *  to baseline for this request but CREDITS the same breaker, so a
 *  persistently broken session parks just like a faulting one.
 *  §3.2 identity faults are louder (ERROR + 400) and use recordFault. */
function recordSoftMiss(store: SessionStore, sessionId: string, detail: string, log: (level: string, msg: string) => void): void {
    const cur = readGuard(store, sessionId);
    const staleHold = cur.disabledAt !== undefined && Date.now() - cur.disabledAt >= PF_V6_DISABLED_TTL_MS;
    const faults = (staleHold ? 0 : cur.faults) + 1;
    if (faults >= PF_V6_BREAKER_FAULTS) {
        writeGuard(store, sessionId, { faults, disabledAt: Date.now() });
        log("warn", `[${sessionId}] fastpath v6 PARKED ${Math.round(PF_V6_DISABLED_TTL_MS / 60000)}m after ${faults} consecutive misses/faults (last: ${detail}) — traffic rides baseline lanes`);
    } else {
        writeGuard(store, sessionId, { faults, disabledAt: staleHold ? undefined : cur.disabledAt });
        log("warn", `[${sessionId}] fastpath v6 soft miss (${faults}/${PF_V6_BREAKER_FAULTS}): ${detail} — baseline turn`);
    }
}

// --- in-memory world mirrors (P7: caches of fold(ckpt, log)) --------------
interface V6World {
    readonly sid: string;
    /** Last stamped total T — booking arithmetic only (§4): honest stamp,
     *  reconciliation basis, drift diagnostics. NEVER an interval trust. */
    t: number;
    /** Highest ledger pos minted under this sid. */
    maxPos: number;
    /** Last persisted front system run (until this turn's re-read lands). */
    systemText: string;
    stripCounts: RawStripCounts;
    multimodal: boolean;
    /** id → ledger pos working copy (capped; trims silently). */
    seen: Map<string, number>;
}

const worlds = new Map<string, V6World>();
/** relay-session → sids issued under it (teardown cascade + prune cap). */
const sessionWorlds = new Map<string, Set<string>>();

/** Resident-mirror bound. Mirrors are pure caches (P7): dropping ANY of
 *  them costs one plane reload on the next turn (loadWorldFromPlane + a
 *  ledger scan), never correctness. The cap keeps worst-case resident RAM
 *  flat regardless of how many worlds a long-lived node has ever seen. */
const MAX_WORLD_MIRRORS = 512;

function upsertWorld(w: V6World): void {
    if (!worlds.has(w.sid) && worlds.size >= MAX_WORLD_MIRRORS) {
        const oldest = worlds.keys().next().value as string | undefined;
        if (oldest !== undefined) {
            worlds.delete(oldest);
            pendingCommits.delete(oldest);
        }
    }
    worlds.delete(w.sid);
    worlds.set(w.sid, w); // insert order = recency
}

function touchSessionIndex(sessionId: string, sid: string): void {
    let s = sessionWorlds.get(sessionId);
    if (s === undefined) {
        if (sessionWorlds.size >= 1024) sessionWorlds.clear();
        s = new Set();
        sessionWorlds.set(sessionId, s);
    }
    s.add(sid);
}

/** Evaluate stashes each hit turn's exact commit plan (+ the mirror it will
 *  become) here so FINALIZE applies rows + log in ONE store transaction and
 *  only THEN promotes the cache — persistence failure leaves mirror and
 *  plane consistent with each other (both still at the prior world state;
 *  the client retries, the turn is served, nothing corrupt). */
interface PendingCommit {
    readonly rows: { pos: number; ledgerId: string; coreId: string; coreJson: string }[];
    readonly logEntries: { kind: string; payloadJson: string; bornPosHi: number }[];
    readonly proposed: V6World;
}
const pendingCommits = new Map<string, PendingCommit>();

export interface V6Hit {
    /** Frozen prefix cores (ledger order) + this turn's NEW cores. Empty
     *  array is LEGAL and meaningful: no-progress turns hydrate the frozen
     *  prefix HERE (see evaluate) — callers render from `view`. */
    readonly view: CoreMessage[];
    /** Only this turn's NEW cores (what gets pinned resident). EMPTY on
     *  no-progress turns — prepare-openai skips pinning in that case. */
    readonly windowCores: CoreMessage[];
    /** Freshly decoded leading system run (P4 — real current bytes). */
    readonly systemText: string;
    /** Scanned element count T. */
    readonly totalT: number;
    readonly fieldSpans: ReadonlyMap<string, RawSpan>;
    /** Post-strip raw NEW messages (the window the pipeline processes). */
    readonly windowMessages: unknown[];
    readonly seedMultimodal: boolean;
    /** Mirror-carried middle + this turn's fragments (markerStripped input). */
    readonly markerCounts: RawStripCounts;
}

export interface V6Outcome {
    readonly hit: V6Hit | null;
    /** Measured T whenever the structural scan succeeded (stampable). */
    readonly measuredT: number | undefined;
    readonly decision: string;
    /** The request-level carrier value used for matching (finalize fills
     *  sess_raw on registered rows). Always present when the outcome is. */
    readonly sessionCarrier: string;
    /** Present iff this turn MINTED a new pf_sid: finalize performs the
     *  per-element registration over the REAL arm-turn bytes. */
    readonly armed?: { sid: string; ids: string[]; spans: readonly RawSpan[] };
    /** Extra success-response headers (seq stamp + pf_sid echo). */
    readonly extraHeaders?: Record<string, string>;
}

// --- wire decoding ---------------------------------------------------------
/** Strict tail-window list decoder (§3.2 + Q4 ruling): every member carries
 *  a real unique well-formed id — the v3 "?" placeholder is GONE from this
 *  lane; an id-less slot IS the fault (recorded upstream of the call site
 *  check). All-or-nothing: one bad segment voids the whole list. Lists over
 *  the fixed window are malformed here (over-window = client bug; the width
 *  gate below handles the under-window side). */
function parseFullIdList(raw: string): string[] | null {
    const segs = raw.split(",");
    if (segs.length === 0 || segs.length > PF_TAIL_WINDOW) return null;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const seg of segs) {
        let id: string;
        try { id = decodeURIComponent(seg); } catch { return null; }
        if (id.length === 0 || id.length > MAX_ID_LEN || id === "?") return null;
        if (BAD_ID_CHARS.test(id)) return null;
        if (seen.has(id)) return null;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function isSingleHeaderValue(v: string | string[] | undefined): v is string {
    return typeof v === "string" && v.length > 0;
}

/** Parse exactly the given element spans (ANY positions) in ASCENDING order
 *  into a messages fragment object. Leaf-decoupled twin of the v5 private
 *  helper (#3482 precedent: these scanner-side leaves stay import-free of
 *  each other's internals). */
function parseElementFragment(bodyText: string, spans: readonly RawSpan[]): { messages: unknown[] } | null {
    if (spans.length === 0) return { messages: [] };
    try {
        let s = `{"messages":[`;
        for (const sp of spans) s += bodyText.slice(sp.start, sp.end) + ",";
        s = s.endsWith(",") ? s.slice(0, -1) : s;
        s += "]}";
        const p = JSON.parse(s) as { messages?: unknown };
        return Array.isArray(p.messages) ? { messages: p.messages } : null;
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

// --- #3642 identity continuity (generalized from the v5 rekey) ------------
// openaiToCore mints cluster ids — raw content-hash base (h_+16hex), or
// base_N by INTRA-CALL occurrence order — and stamps wireIndex from array
// position. Element-wise transforms therefore carry FRAGMENT-relative
// numbers; the ledger expects FULL-array ordinals (a legacy single parse
// would mint base_N continuing across ALL earlier elements). Bases are
// content hashes (#3642) and neighbour-independent, so determinism holds:
// count bases across every earlier-ledger row (pos order), continue _N, and
// fix wireIndex to the absolute element position.
function baseOfRawId(id: string): string {
    const m = /^h_[0-9a-f]{16}(?:_\d+)?$/u.exec(id);
    return m === null ? id : id.slice(0, 18);
}

function rekeyContinuing(
    prefixIds: readonly string[],
    appends: readonly { pos: number; cores: CoreMessage[] }[],
): { pos: number; coreIds: string[]; cores: CoreMessage[] }[] {
    const counts = new Map<string, number>();
    for (const cid of prefixIds) {
        const base = baseOfRawId(cid);
        counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    const out: { pos: number; coreIds: string[]; cores: CoreMessage[] }[] = [];
    for (const a of appends) {
        const ids: string[] = [];
        const cores: CoreMessage[] = [];
        for (const c of a.cores) {
            const base = baseOfRawId(c.id);
            const n = counts.get(base) ?? 0;
            counts.set(base, n + 1);
            ids.push(n === 0 ? base : `${base}_${n}`);
            cores.push({ ...c, id: n === 0 ? base : `${base}_${n}`, wireIndex: a.pos } as CoreMessage);
        }
        out.push({ pos: a.pos, coreIds: ids, cores });
    }
    return out;
}

/** Transform ONE element span into its cores (single-element fragment parse
 *  — the v6 atom of work). null = untransformable shape (caller falls back
 *  honestly, uncredited). */
function transformElement(bodyText: string, span: RawSpan): CoreMessage[] | null {
    const frag = parseElementFragment(bodyText, [span]);
    if (frag === null) return null;
    try {
        return [...openaiToCore(frag as OpenAIRequestBody).msgs];
    } catch {
        return null;
    }
}

function coresHaveImagePart(cores: readonly CoreMessage[]): boolean {
    for (const c of cores) {
        const o = c as { imagePart?: unknown; rawOpenaiContent?: { type?: unknown } };
        if (o.imagePart === true || o.rawOpenaiContent?.type === "image_url") return true;
    }
    return false;
}

/** Deserialize a sid's frozen cores from the DISK plane (per-turn
 *  materialization — freed at end of turn, P2 zero-residency). Stored core
 *  json is a PLAIN cores array; wireIndex is restored from the pos key. */
function loadWorldCores(store: SessionStore, sid: string, maxPos: number): CoreMessage[] | null {
    if (maxPos < 0) return [];
    const out: CoreMessage[] = [];
    for (let w = 0; w * 4096 <= maxPos; w++) {
        const win = store.pfHydrateWindow(sid, w * 4096, Math.min(maxPos, (w + 1) * 4096 - 1));
        for (const [pos, json] of [...win.entries()].sort((a, b) => a[0] - b[0])) {
            let arr: unknown;
            try { arr = JSON.parse(json); } catch { continue; }
            if (!Array.isArray(arr)) continue;
            for (const c of arr as CoreMessage[]) {
                if (typeof c !== "object" || c === null) continue;
                out.push(Object.assign(c, { wireIndex: pos }));
            }
        }
    }
    return out;
}

/** Hydrate the whole WORLD (metadata + id→pos index) from the plane:
 *  fold(ckpt.metaJson, log-after-ckpt) + one lightweight ledger scan.
 *  Returns null when the plane cannot produce a coherent state (corrupt
 *  checkpoint with an already-compacted log — nothing left to replay from). */
function loadWorldFromPlane(store: SessionStore, sid: string): V6World | null {
    const meta = store.pfMeta(sid);
    if (meta === null) return null;
    let folded: Record<string, unknown> = {};
    if (meta.ckpt !== null) {
        let p: unknown;
        try { p = JSON.parse(meta.ckpt.metaJson); } catch {
            // S4: checksum-bound bytes failed to parse back — treat as
            // unrecoverable rather than guess (guessing poisons forever).
            return null;
        }
        if (typeof p === "object" && p !== null) folded = p as Record<string, unknown>;
    }
    for (const e of meta.log) {
        let p: Record<string, unknown>;
        try { p = JSON.parse(e.payloadJson) as Record<string, unknown>; } catch { continue; }
        switch (e.kind) {
            case "geom":
                if (typeof p.t === "number") folded.t = p.t;
                if (typeof p.maxPos === "number") folded.maxPos = p.maxPos;
                break;
            case "front":
                if (typeof p.systemText === "string") folded.systemText = p.systemText;
                if (typeof p.stripCounts === "object" && p.stripCounts !== null) folded.stripCounts = p.stripCounts as RawStripCounts;
                if (typeof p.multimodal === "boolean") folded.multimodal = p.multimodal;
                break;
            default:
                // arm/unarm/block carry no folded-meta fields; unknown kinds
                // skipped — forward compatibility.
                break;
        }
    }
    if (typeof folded.maxPos !== "number") folded.maxPos = 0;
    const seen = new Map<string, number>();
    const idRows = store.pfLedgerIds(sid);
    if (idRows !== null) {
        for (const r of idRows) {
            if (seen.size >= SEEN_WORK_COPY_CAP) break;
            seen.set(r.ledgerId, r.pos);
        }
    }
    return {
        sid,
        t: typeof folded.t === "number" ? folded.t : 0,
        maxPos: typeof folded.maxPos === "number" ? folded.maxPos : 0,
        systemText: typeof folded.systemText === "string" ? folded.systemText : "",
        stripCounts: (typeof folded.stripCounts === "object" && folded.stripCounts !== null ? folded.stripCounts as RawStripCounts : EMPTY_STRIP),
        multimodal: folded.multimodal === true,
        seen,
    };
}

/** The one carrier admitting a request to the v6 cohort (§7-B lock: shim
 *  family first). Absent ⇒ cohort EXCLUDED (baseline lanes, no fault); the
 *  value is the request-level half of the composite identity key. */
function resolveCohortCarrier(headers: http.IncomingHttpHeaders): string | null {
    const v = headers["x-bili-plugin-conversation"];
    if (!isSingleHeaderValue(v) || v.length > MAX_ID_LEN) return null;
    return v;
}

function registerSidForSession(store: SessionStore, sessionId: string, sid: string): void {
    touchSessionIndex(sessionId, sid);
    try {
        if (!store.replicasAvailable()) return;
        const cur = store.getSessionExt(sessionId, store.PF_V6_SID_REGISTRY_EXT_KEY);
        const list = Array.isArray(cur) ? cur.filter((x): x is string => typeof x === "string") : [];
        if (!list.includes(sid)) {
            list.push(sid);
            store.setSessionExt(sessionId, store.PF_V6_SID_REGISTRY_EXT_KEY, list);
        }
    } catch { /* registry advisory: the probe index remains authoritative */ }
}

/**
 * Evaluate fastpath v6 for one chat-completions request. Positioned BEFORE
 * the v5 watermark evaluation in prepareOpenai:
 *   - return null       → v6 not engaged (off/excluded/parked/degraded):
 *                          the v5 lane decides exactly as before;
 *   - return an outcome  → v6 OWNS this turn (hit replaces inputs, arm hands
 *                          to the baseline pipeline, soft misses restamp):
 *                          the v5 lane is bypassed for this request;
 *   - throw              → identity fault: refuse 400 (handle.ts mapping),
 *                          guard counter already recorded, plane untouched.
 */
export function evaluateWatermarkV6(
    bodyText: string,
    req: http.IncomingMessage,
    session: Session,
    input: { pluginMode: boolean; titleGen: boolean; model: string },
    log: (level: string, msg: string) => void,
): V6Outcome | null {
    // --- configuration gate (silent pass-throughs) --------------------------
    if (!featureEnabled("watermarkV6MsgId")) return null;
    if (!input.pluginMode || input.titleGen) return null;
    if (req.headers[INCREMENTAL_TURN_MARKER_HEADER] !== undefined) return null;
    const store = getStore();
    if (!store.pfAvailable()) return null; // §7-A② soft-degrade node
    const guard = readGuard(store, session.id);
    const held = guard.disabledAt !== undefined && Date.now() - guard.disabledAt < PF_V6_DISABLED_TTL_MS;
    if (held) return null; // parked: baseline serves (parking was logged loud)
    if (guard.disabledAt !== undefined && !held) {
        // recovery edge: the hold expired — announce once, then proceed.
        creditReset(store, session.id, undefined);
        log("info", `[${session.id}] fastpath v6 BREAKER RELEASED after hold — re-entering the lane`);
    }
    const sessRaw = resolveCohortCarrier(req.headers);
    if (sessRaw === null) return null; // cohort exclusion ≠ fault

    // --- structure ------------------------------------------------------------
    const scan = scanMessagesSpans(bodyText, "all");
    if (scan === null || scan.total === 0) return null;
    const T = scan.total;

    // --- identity hard gate (§3.2): four fault classes -------------------------
    // Every fault is recordFault(then) throw inline: a direct throw is what
    // the type system honors as terminal (helper-indirected never-calls are
    // not narrows in this TS build).
    const rawIds = req.headers[PF_TAIL_IDS_HEADER];
    if (!isSingleHeaderValue(rawIds)) {
        const d = `identity channel incomplete: ${PF_TAIL_IDS_HEADER} absent`;
        recordFault(store, session.id, d, log);
        throw new FastpathV6IdentityFault(d);
    }
    const parsed = parseFullIdList(rawIds);
    if (parsed === null) {
        const d = "identity channel malformed: an element id fails strict screening (real, unique, well-formed required)";
        recordFault(store, session.id, d, log);
        throw new FastpathV6IdentityFault(d);
    }
    const R = parsed;
    // F1: expected width is the FIXED WINDOW, min(window, T) — not T itself.
    // Any other length means the channel drifted (stale slice form, foreign
    // encoder, over-window overflow) — refuse loudly.
    const expectLen = Math.min(PF_TAIL_WINDOW, T);
    if (R.length !== expectLen) {
        const d = `identity width mismatch: list=${R.length} vs expected min(window=${PF_TAIL_WINDOW}, T)=${expectLen}`;
        recordFault(store, session.id, d, log);
        throw new FastpathV6IdentityFault(d);
    }
    // R[i] binds to BODY element posStart+i; everything earlier than the
    // window rides the ledger (or the honest coverage boundary — see docs).
    const posStart = T - R.length;

    // --- matching (§3.1 rules ①②③) ---------------------------------------------
    const P = store.pfProbePairs(sessRaw, [...new Set(R)]);
    if (P === null) return null; // mid-call plane degradation: soft, this turn only
    const distinctSids = new Set<string>();
    for (const v of P.values()) distinctSids.add(v.sid);
    const echoRaw = req.headers[PF_SESSION_HEADER];
    const echo = isSingleHeaderValue(echoRaw) && PF_SID_RE.test(echoRaw) ? echoRaw : undefined;

    let sid: string | undefined;
    if (echo !== undefined) {
        // Rule ①: echo accelerates AND is verified against the plane. An
        // echoed sid the plane never heard of = fabrication/loopback =
        // consistency break (a forged echo is exactly how mis-attribution
        // starts — the same discipline that voids partial id claims, #2821).
        const mEcho = store.pfMeta(echo);
        // A compacted world keeps its state in the ckpt with an EMPTY log —
        // the ckpt row itself is plane knowledge (P8: a world is immortal
        // until session deletion, which removes all three tables), so it
        // must count as "known" or every post-restart echo of a compacted
        // world fault-loops into a park cycle.
        const knows = (mEcho?.log.length ?? 0) > 0 || mEcho?.ckpt !== null || worlds.has(echo);
        if (!knows) {
            const d = `echo references unknown pf_sid ${echo}`;
            recordFault(store, session.id, d, log);
            throw new FastpathV6IdentityFault(d);
        }
        for (const v of P.values()) {
            if (v.sid !== echo) {
                const d = `consistency break: echo claims ${echo}, probe resolves ${v.sid}`;
                recordFault(store, session.id, d, log);
                throw new FastpathV6IdentityFault(d);
            }
        }
        if (distinctSids.size === 0) {
            // An echo rides the SAME carrier it was learned under, so a
            // legitimate turn always carries at least one id the plane
            // resolves here (prior turns' rows are permanent, P8). ZERO
            // resolutions + a foreign echo = cross-conversation replay /
            // forgery attempt — refuse rather than append stranger content
            // into someone else's world.
            const d = `consistency break: echo ${echo} carries no resolvable identity under this session carrier`;
            recordFault(store, session.id, d, log);
            throw new FastpathV6IdentityFault(d);
        }
        sid = echo;
    } else if (distinctSids.size === 1) {
        sid = [...distinctSids][0]; // Rule ②: probe-only, single owner
    } else if (distinctSids.size > 1) {
        // One body probing across two worlds is design-impossible (kernel
        // msgids are globally unique forever; bodies are single-conversation
        // linear histories) — refuse loudly instead of choosing a side.
        const d = `consistency break: identity span crosses multiple worlds (${[...distinctSids].join(", ")})`;
        recordFault(store, session.id, d, log);
        throw new FastpathV6IdentityFault(d);
    }

    if (sid === undefined) {
        // Rule ③: brand-new world — the legal arm entrance (P5). Mint the
        // partition key, register, and hand the COMPUTATION to the baseline
        // pipeline: finalize performs the per-element registration from the
        // REAL arm-turn bytes. This turn pays one full parse — same cost the
        // v5/legacy lines pay today; it happens ONCE per world.
        const newSid = `pf_${randomBytes(6).toString("hex")}`;
        registerSidForSession(store, session.id, newSid);
        creditReset(store, session.id, undefined);
        const stamps: Record<string, string> = { [PF_SEQ_HEADER]: String(T), [PF_SESSION_HEADER]: newSid };
        log("info", `[${session.id}] v6 ARMD new world ${newSid} (T=${T}) — baseline computes, finalize registers`);
        return {
            hit: null,
            measuredT: T,
            decision: "arm",
            sessionCarrier: sessRaw,
            armed: { sid: newSid, ids: R, spans: scan.messageSpans },
            extraHeaders: stamps,
        };
    }
    touchSessionIndex(session.id, sid);
    let world = worlds.get(sid);
    if (world === undefined) world = loadWorldFromPlane(store, sid) ?? undefined;
    if (world === undefined) {
        // The plane answered a probe under this sid but cannot reproduce its
        // state (checkpoint corrupt AFTER its log was compacted away). A
        // stable 400 loop would be a disaster of our own making: PARK once
        // (loud) and let the baseline lanes serve; operators see the error.
        log("error", `[${session.id}] v6 world unrecoverable under ${sid} (plane state inconsistent) — parking the lane 60m for this session`);
        writeGuard(store, session.id, { faults: 0, disabledAt: Date.now() });
        return null;
    }

    // --- set difference: the ONLY judgement axis --------------------------------
    const newIdx: number[] = [];
    for (let i = 0; i < R.length; i++) {
        const probed = P.get(R[i]);
        if (probed === undefined && !world.seen.has(R[i])) newIdx.push(i);
    }
    const stamps: Record<string, string> = { [PF_SEQ_HEADER]: String(T), [PF_SESSION_HEADER]: sid };
    const frontEnd = Math.min(FRONT_REREAD_ELEMENTS, T);
    const frontFrag = parseElementFragment(bodyText, scan.messageSpans.slice(0, frontEnd));

    if (newIdx.length === 0) {
        // No new identities at all: the view IS the plane. Stamp + echo (the
        // client converges), re-read the FRONT fresh (P4), decode NOTHING of
        // the interior. Frozen prefix hydrates from disk into the turn-local
        // `view`; the window pins nothing (empty windowCores is the marker).
        const frozen = loadWorldCores(store, sid, world.maxPos);
        if (frontFrag === null || frozen === null) {
            // Degenerate corner (front unparseable / plane read hiccup): one
            // honest baseline turn, uncredited-into-nothing — breaker does
            // count format-level misses (§5 step 7).
            recordSoftMiss(store, session.id, frontFrag === null ? "front-unparseable (no-progress)" : "hydrate-failed (no-progress)", log);
            log("warn", `[${session.id}] v6 no-progress degrade (${frontFrag === null ? "front-unparseable" : "hydrate-failed"}) — baseline turn`);
            return { hit: null, measuredT: T, decision: "no-progress-degraded", sessionCarrier: sessRaw, extraHeaders: stamps };
        }
        stripRawStage(frontFrag, "openai");
        const frontConv = openaiToCore(frontFrag as OpenAIRequestBody);
        const pending: PendingCommit = {
            rows: [],
            logEntries: [
                { kind: "front", payloadJson: JSON.stringify({ systemText: frontConv.systemText, stripCounts: world.stripCounts, multimodal: world.multimodal }), bornPosHi: world.maxPos },
                { kind: "geom", payloadJson: JSON.stringify({ t: T, maxPos: world.maxPos }), bornPosHi: world.maxPos },
            ],
            proposed: { ...world, t: T, systemText: frontConv.systemText },
        };
        pendingCommits.set(sid, pending);
        creditReset(store, session.id, undefined); // healthy ride clears the streak
        return {
            hit: {
                view: frozen,
                windowCores: [],
                systemText: frontConv.systemText,
                totalT: T,
                fieldSpans: scan.fieldSpans,
                windowMessages: [],
                seedMultimodal: world.multimodal,
                markerCounts: world.stripCounts,
            },
            measuredT: T,
            decision: "no-progress",
            sessionCarrier: sessRaw,
            extraHeaders: stamps,
        };
    }

    // --- the NEW set: decode ONLY the new element spans (any positions) ---------
    const newFragment = parseElementFragment(bodyText, newIdx.map((i) => scan.messageSpans[posStart + i]));
    if (newFragment === null) {
        recordSoftMiss(store, session.id, "NEW-span fragment unparseable", log);
        log("warn", `[${session.id}] v6 NEW-span fragment unparseable — baseline turn (uncredited)`);
        return { hit: null, measuredT: T, decision: "newspans-unparseable", sessionCarrier: sessRaw, extraHeaders: stamps };
    }
    // Conservative layout rule (§2 P4 tail): a NEW element OPENING a
    // system/developer run INSIDE the body means the ledger boundary was
    // never established for that layout — route to baseline rather than
    // guess where the freeze frontier sits.
    let midSystem = false;
    for (let k = 0; k < newIdx.length; k++) {
        const absIdx = posStart + newIdx[k];
        const m = newFragment.messages[k];
        if (absIdx >= frontEnd && typeof m === "object" && m !== null) {
            const role = (m as { role?: unknown }).role;
            if (role === "system" || role === "developer") {
                midSystem = true;
                break;
            }
        }
    }
    if (midSystem) {
        recordSoftMiss(store, session.id, "mid-body system run opens at NEW element", log);
        log("warn", `[${session.id}] v6 NEW element opens a mid-body system run — baseline turn (uncredited)`);
        return { hit: null, measuredT: T, decision: "mid-system-new", sessionCarrier: sessRaw, extraHeaders: stamps };
    }

    // Per-element transforms (the atomic unit; numbering continued below).
    const positioned: { pos: number; ledgerId: string; elemIdx: number; cores: CoreMessage[] }[] = [];
    let startFail = false;
    for (let k = 0; k < newIdx.length; k++) {
        const absIdx = posStart + newIdx[k];
        const cores = transformElement(bodyText, scan.messageSpans[absIdx]);
        if (cores === null) {
            recordSoftMiss(store, session.id, `element ${absIdx} transform failed`, log);
            log("warn", `[${session.id}] v6 element ${absIdx} transform failed — baseline turn (uncredited)`);
            startFail = true;
            break;
        }
        positioned.push({ pos: world.maxPos + 1 + k, ledgerId: R[newIdx[k]], elemIdx: absIdx, cores });
    }
    if (startFail) return { hit: null, measuredT: T, decision: "element-transform-fail", sessionCarrier: sessRaw, extraHeaders: stamps };
    if (frontFrag === null) {
        recordSoftMiss(store, session.id, "front fragment unparseable", log);
        return { hit: null, measuredT: T, decision: "front-unparseable", sessionCarrier: sessRaw, extraHeaders: stamps };
    }
    stripRawStage(frontFrag, "openai");
    const frontConv = openaiToCore(frontFrag as OpenAIRequestBody);

    // Continue #3642 numbering across the WHOLE frozen ledger: prefix ids
    // come from the lightweight column scan (strings only, no payloads).
    const idRows = store.pfLedgerIds(sid);
    if (idRows === null) {
        recordSoftMiss(store, session.id, "ledger scan failed mid-evaluate", log);
        log("warn", `[${session.id}] v6 ledger scan failed mid-evaluate — baseline turn (uncredited)`);
        return { hit: null, measuredT: T, decision: "ledger-scan-fail", sessionCarrier: sessRaw, extraHeaders: stamps };
    }
    const prefixIds: string[] = [];
    for (const r of idRows) {
        if (r.coreId.length > 0) {
            const parts = r.coreId.split("|");
            for (const p of parts) prefixIds.push(p);
        }
    }
    const keyed = rekeyContinuing(prefixIds, positioned.map((p) => ({ pos: p.pos, cores: p.cores })));
    const windowCores: CoreMessage[] = [];
    for (const r of keyed) for (const c of r.cores) windowCores.push(c);

    const strippedNew = stripRawStage(newFragment, "openai");
    const stripCounts = addStripCounts(world.stripCounts, strippedNew);
    const multimodal = world.multimodal || coresHaveImagePart(windowCores);

    // Turn-local view assembly (prefix hydrated from disk + NEW cores) —
    // freed at end of turn; the CACHE is promoted only on successful commit.
    const frozen = loadWorldCores(store, sid, world.maxPos);
    if (frozen === null) {
        recordSoftMiss(store, session.id, "hydrate failed mid-evaluate", log);
        log("warn", `[${session.id}] v6 hydrate failed mid-evaluate — baseline turn (uncredited)`);
        return { hit: null, measuredT: T, decision: "hydrate-fail", sessionCarrier: sessRaw, extraHeaders: stamps };
    }
    const view = [...frozen, ...windowCores];
    const lastPos = world.maxPos + 1 + newIdx.length - 1;
    const proposedSeen = new Map(world.seen);
    for (let k = 0; k < positioned.length; k++) {
        if (proposedSeen.size >= SEEN_WORK_COPY_CAP) break;
        proposedSeen.set(positioned[k].ledgerId, positioned[k].pos);
    }
    pendingCommits.set(sid, {
        rows: keyed.map((r) => ({
            pos: r.pos,
            ledgerId: positioned[r.pos - (world.maxPos + 1)].ledgerId,
            coreId: r.coreIds.join("|"),
            coreJson: JSON.stringify(r.cores),
        })),
        logEntries: [
            { kind: "front", payloadJson: JSON.stringify({ systemText: frontConv.systemText, stripCounts, multimodal }), bornPosHi: lastPos },
            { kind: "geom", payloadJson: JSON.stringify({ t: T, maxPos: lastPos }), bornPosHi: lastPos },
        ],
        proposed: { ...world, t: T, maxPos: lastPos, systemText: frontConv.systemText, stripCounts, multimodal, seen: proposedSeen },
    });
    creditReset(store, session.id, undefined); // consecutive-fault streak clears on a sound turn

    log("debug", `[${session.id}] v6 HIT NEW=${newIdx.length}${newIdx.length <= 4 ? "@" + newIdx.join(".") : ""} T=${T} maxPos=${lastPos}`);
    return {
        hit: {
            view,
            windowCores,
            systemText: frontConv.systemText,
            totalT: T,
            fieldSpans: scan.fieldSpans,
            windowMessages: newFragment.messages,
            seedMultimodal: multimodal,
            markerCounts: stripCounts,
        },
        measuredT: T,
        decision: "hit",
        sessionCarrier: sessRaw,
        extraHeaders: stamps,
    };
}

/**
 * Call AFTER the pipeline ran for a v6-engaged turn (mirror of
 * finalizeWatermarkTurn). Persists the evaluate-stashed commit (single
 * transaction, rows + log together), promotes the cache, restamps. Every
 * failure degrades softly: the turn ALREADY served from coherent inputs,
 * and the next turn re-syncs from the plane (or, on a persistent gap, the
 * probe/equivalence checks route to baseline uncredited).
 * Returns the success-response headers (always at least the seq stamp).
 */
export function finalizeWatermarkV6(
    session: Session,
    evaluated: V6Outcome,
    input: {
        /** Arm turns only: the request bytes for per-element registration. */
        bodyText?: string;
        /** Arm turns only: the baseline pipeline's decoded front + its marker
         *  strip accounting for THIS real arm body (mirrors what a v6-hit
         *  turn would have written — the registry starts from truth, not
         *  zeros). */
        armSystemText?: string;
        armStripCounts?: RawStripCounts;
        armMultimodal?: boolean;
    },
    log: (level: string, msg: string) => void,
): Record<string, string> {
    const headers: Record<string, string> = {};
    if (evaluated.measuredT === undefined) return headers;
    const T = evaluated.measuredT;
    headers[PF_SEQ_HEADER] = String(T);
    if (evaluated.extraHeaders) Object.assign(headers, evaluated.extraHeaders);

    const store = getStore();
    try {
        if (evaluated.armed !== undefined) {
            // ARM registration: every element of THIS turn, wire order →
            // pos 0..T-1 (first world under the fresh sid). F1: the carried
            // ids cover only the tail window — prefix rows register with the
            // empty ledger marker (cores stored, identity unknown forever;
            // probes never query it, the honest boundary made concrete).
            // A FAILED registration must not hand the client the world id:
            // the plane holds nothing for it, so a next-turn echo would
            // fault-loop ("echo references unknown pf_sid") straight into a
            // breaker park. Drop the echo on every failure exit below; keep
            // the seq stamp.
            const failNoEcho = (): Record<string, string> => {
                delete headers[PF_SESSION_HEADER];
                return headers;
            };
            const { sid, ids, spans } = evaluated.armed;
            const armPosStart = T - ids.length;
            const armExpect = Math.min(PF_TAIL_WINDOW, T);
            if (input.bodyText === undefined || spans.length !== T || ids.length > T || ids.length < armExpect) {
                log("error", `[${session.id}] v6 arm: geometry mismatch at finalize — registration skipped (world stays empty; next turn arms fresh via probe-miss)`);
                return failNoEcho();
            }
            const positioned: { pos: number; ledgerId: string; cores: CoreMessage[] }[] = [];
            for (let i = 0; i < spans.length; i++) {
                const cores = transformElement(input.bodyText, spans[i]);
                if (cores === null) {
                    log("error", `[${session.id}] v6 arm: element ${i} transform failed — registration aborted (turn already served from baseline)`);
                    return failNoEcho();
                }
                positioned.push({ pos: i, ledgerId: i >= armPosStart ? ids[i - armPosStart] : "", cores });
            }
            const keyed = rekeyContinuing([], positioned.map((p) => ({ pos: p.pos, cores: p.cores })));
            const allCores = keyed.flatMap((r) => r.cores);
            const frontText = input.armSystemText ?? "";
            const frontStrips = input.armStripCounts ?? EMPTY_STRIP;
            const frontMultimodal = input.armMultimodal ?? coresHaveImagePart(allCores);
            // F1: window-relative ids → absolute pos via armPosStart; prefix rows ride the empty marker.
            const armLedgerByPos = new Map<number, string>();
            for (let i = armPosStart; i < T; i++) armLedgerByPos.set(i, ids[i - armPosStart]);
            const plan = {
                rows: keyed.map((r) => ({ pos: r.pos, ledgerId: armLedgerByPos.get(r.pos) ?? "", coreId: r.coreIds.join("|"), coreJson: JSON.stringify(r.cores) })),
                logEntries: [
                    { kind: "arm", payloadJson: JSON.stringify({ t: T }), bornPosHi: T - 1 },
                    { kind: "front", payloadJson: JSON.stringify({ systemText: frontText, stripCounts: frontStrips, multimodal: frontMultimodal }), bornPosHi: T - 1 },
                    { kind: "geom", payloadJson: JSON.stringify({ t: T, maxPos: T - 1 }), bornPosHi: T - 1 },
                ],
            };
            if (store.pfCommitTurn(sid, { rows: plan.rows.map((r) => ({ ...r, sessRaw: evaluated.sessionCarrier })), logEntries: plan.logEntries }) === null) {
                log("warn", `[${session.id}] v6 arm commit failed — world deferred to next turn`);
                return failNoEcho();
            }
            const seen = new Map<string, number>();
            for (let i = armPosStart; i < T; i++) seen.set(ids[i - armPosStart], i);
            upsertWorld({ sid, t: T, maxPos: T - 1, systemText: frontText, stripCounts: frontStrips, multimodal: frontMultimodal, seen });
            log("info", `[${session.id}] v6 armed world ${sid} (T=${T}, ${keyed.length} elements registered, ${seen.size} identities ledgred from the tail window)`);
            return headers;
        }
        // Hit-turn commits (including no-progress front/geom ledger moves).
        const sid = evaluated.extraHeaders?.[PF_SESSION_HEADER];
        if (sid === undefined) return headers;
        const pending = pendingCommits.get(sid);
        if (pending === undefined) return headers;
        pendingCommits.delete(sid);
        if (store.pfCommitTurn(sid, {
            rows: pending.rows.map((r) => ({ ...r, sessRaw: evaluated.sessionCarrier })),
            logEntries: pending.logEntries,
        }) === null) {
            // Plane hiccup: mirror NOT promoted — the NEXT turn reloads from
            // the plane (which lacks this turn's NEW rows) and re-registers
            // them as NEW AGAIN… which would duplicate. Prevent: mark the
            // world dirty-on-reload by keeping the proposal cached WITHOUT
            // committing; simplest correct move is to drop the cache so the
            // reload sees plane truth, and accept that this turn's NEW ids
            // get re-probed-and-registered next round IF the client resends
            // (hosts always resend full bodies — resends are the norm, so
            // the re-registration converges; pos advances, no overwrite).
            worlds.delete(sid);
            log("warn", `[${session.id}] v6 commit failed — cache dropped, plane truth restored; this turn's NEW elements re-register on the (guaranteed full-body) retry`);
            return headers;
        }
        upsertWorld({ ...pending.proposed });
        opportunisticCompact(store, sid, pending.proposed, log);
        return headers;
    } catch (err) {
        log("warn", `[${session.id}] v6 finalize degraded: ${String(err)}`);
        return headers;
    }
}

/** Opportunistic L0→L1 fold straight from finalize (contract §4.1.3: no
 *  background threads). The meta is folded from the SAME state the log
 *  records, so fold(new,∅) ≡ fold(old,oldLog) holds by construction; the
 *  checksum binds the exact metaJson bytes (S4: verify at hydrate, never
 *  guess). Thresholds per contract (owner may veto): ≥64 entries OR ≥64 KB
 *  OR 30 min idle. */
function opportunisticCompact(store: SessionStore, sid: string, world: V6World, log: (level: string, msg: string) => void): void {
    const meta = store.pfMeta(sid);
    if (meta === null || meta.log.length === 0) return;
    const last = meta.log[meta.log.length - 1];
    let bytes = 0;
    for (const e of meta.log) bytes += e.payloadJson.length + 32;
    if (!store.pfNeedsCompaction({ entriesAfterCkpt: meta.log.length, logBytesEstimate: bytes, lastEntryTsMs: last.ts })) return;
    const metaJson = JSON.stringify({
        v: 1,
        t: world.t,
        maxPos: world.maxPos,
        systemText: world.systemText,
        stripCounts: world.stripCounts,
        multimodal: world.multimodal,
    });
    store.pfCompact(sid, { metaJson, nextLsSeq: last.lsSeq });
    log("debug", `[v6:${sid}] pf_log folded to pf_ckpt @ ls_seq ${last.lsSeq} (${meta.log.length} entries)`);
}

/** Drop every in-memory mirror + pending commit for a relay session — pair
 *  of clearWatermarkSeed at teardown paths. The DISK plane survives until
 *  pfDeleteForSession (delete-time cascade). */
export function clearWatermarkV6(sessionId: string): void {
    const sids = sessionWorlds.get(sessionId);
    if (sids !== undefined) {
        for (const sid of sids) {
            worlds.delete(sid);
            pendingCommits.delete(sid);
        }
        sessionWorlds.delete(sessionId);
    }
}

/** Introspection for panels/tests: live mirrors of one relay session. */
export function watermarkV6DebugState(sessionId: string): { liveSids: string[]; worlds: Record<string, { t: number; maxPos: number; seen: number }> } {
    const sids = [...(sessionWorlds.get(sessionId) ?? [])];
    const out: Record<string, { t: number; maxPos: number; seen: number }> = {};
    for (const sid of sids) {
        const w = worlds.get(sid);
        if (w !== undefined) out[sid] = { t: w.t, maxPos: w.maxPos, seen: w.seen.size };
    }
    return { liveSids: sids, worlds: out };
}
