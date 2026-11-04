// #5664 fastpath v6 render-snapshot plane — the "render station" of the
// three-station model (owner ruling 2026-11-04):
//
//   station 1  inbound / identity finalize (per turn, existing #5652 lane)
//   station 2  this snapshot: steady rounds APPEND one captured row per new
//               element; compression rounds (arm/audit/fallback) DIFF against
//               the stored rows and either append or RECAST — and a recast
//               FORCES an S4-checksum checkpoint in the same transaction.
//   station 3  outbound emit: prefix rows pass through verbatim from disk;
//               only the bounded window tail runs a kernel pass per request.
//
// Governing guarantees (contract i5664-plan.md, locked):
//
//  G0 byte-equivalence is verified, not assumed — every fast round re-runs
//     a BOUNDED kernel pass (last W frozen cores + this turn's new cores)
//     under a scratch state clone and compares its mapped first-F elements
//     against the last F stored rows byte-for-byte. Any mismatch falls back
//     to the full legacy path for THIS turn only (P7: disk is the source of
//     truth; the mirror loss costs one re-read).
//  G1 conservative conjunction gate — ANY red condition (title-gen, active
//     blocks, pending fold usage, absorb, fold-mode on, pressure, CCR on,
//     non-zero markers, snapshot-lane substitution, caps mismatch, audit
//     due…) keeps the ENTIRE pre-#5664 code path verbatim. The fallback is
//     structurally identical to "this feature does not exist".
//  G2 capture point = the exact array the baseline emits (rebuiltMessages
//     before system/ephemeral injection); steady capture stores raw strings
//     + parsed caches so the prefix never gets re-parsed or re-stringified.
//  G3 S4 death verdict — a checksum-corrupt checkpoint kills the plane for
//     that sid at hydration; the next legacy turn's diff self-heals with a
//     fresh forced checkpoint. Never guess, never forward corrupt bytes.
//  P7 mirrors are caches (LRU byte budget); losing one = DB re-read.
import type { SessionStore } from "../persist.js";
import type { Session } from "../session.js";

type LogFn = (level: string, msg: string) => void;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Bounded render window W (frozen cores fed to the scratch kernel pass).
 *  Probe evidence (three strategies × mixed transcript × 28 turns): the
 *  suffix-only W-pass reproduces every element's outbound bytes exactly, so
 *  8 is plenty; env-tunable for operators. */
export const PF_RENDER_WINDOW: number = (() => {
    const n = Number(process.env["BILI_PF_RENDER_WINDOW"] ?? 8);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 64) : 8;
})();

/** Every N engaged hit-turns force ONE full legacy pass whose capture diff
 *  re-verifies the stored rows end-to-end (the scheduled audit). */
export const PF_RENDER_AUDIT_EVERY: number = (() => {
    const n = Number(process.env["BILI_PF_RENDER_AUDIT_EVERY"] ?? 8);
    return Number.isFinite(n) && n >= 2 ? Math.min(Math.floor(n), 1024) : 8;
})();

/** tokenCount ≥ ratio × modelContextLimit ⇒ emergency pressure ⇒ legacy
 *  (the fold/expand machinery must see the whole view when the model is
 *  anywhere near its ceiling). */
export const PF_RENDER_EMERGENCY_RATIO = 0.9;

/** In-memory mirror byte budget (raw row bytes summed); oldest world evicted
 *  first when over (P7 — re-hydrate from disk later, zero correctness cost). */
const MIRROR_BYTE_BUDGET = 256 * 1024 * 1024;
let mirrorBytes = 0;

/** Capabilities fingerprint — any change forces a recast (cheap, correct). */
export interface RenderCaps {
    v: 1;
    model: string;
    strategy: string;
    maxDim: number;
    toolArmed: boolean;
    droppable: boolean;
    multimodal: boolean;
}

function capsEqual(a: RenderCaps, b: RenderCaps): boolean {
    return (
        a.v === b.v &&
        a.model === b.model &&
        a.strategy === b.strategy &&
        a.maxDim === b.maxDim &&
        a.toolArmed === b.toolArmed &&
        a.droppable === b.droppable &&
        a.multimodal === b.multimodal
    );
}

interface RenderMeta {
    v: 1;
    caps: RenderCaps;
    rowCount: number;
    estCum: number;
    textCum: number;
    imgCum: number;
}

export interface RenderWorld {
    sid: string;
    /** Outbound JSON string per rendered ordinal, contiguous 0..n-1. */
    rows: string[];
    /** Parsed caches of `rows` (same index) — the splice reads these. */
    rowsParsed: unknown[];
    caps: RenderCaps;
    /** Cumulative Σ estimateCoreMessagesUpper over all current rows. */
    estCum: number;
    /** Cumulative Σ estimateCoreMessages over all current rows. */
    textCum: number;
    /** Cumulative image-reserve contribution of frozen rows. */
    imgCum: number;
    /** Engaged-turn tick — % PF_RENDER_AUDIT_EVERY === 0 ⇒ audit due. */
    auditTick: number;
}

const mirrors = new Map<string, RenderWorld>();
/** relay session id → pf sids owned by it (teardown sweep). */
const sessionSids = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Mirror lifecycle
// ---------------------------------------------------------------------------

function touchMirror(rw: RenderWorld): void {
    // LRU refresh: re-insert to move to the tail (iteration head = oldest).
    if (mirrors.has(rw.sid)) {
        mirrors.delete(rw.sid);
        mirrorBytes -= rw.rows.reduce((s, r) => s + r.length, 0);
    }
    mirrors.set(rw.sid, rw);
    mirrorBytes += rw.rows.reduce((s, r) => s + r.length, 0);
    while (mirrorBytes > MIRROR_BYTE_BUDGET && mirrors.size > 1) {
        const oldest = mirrors.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const victim = mirrors.get(oldest);
        mirrors.delete(oldest);
        if (victim) mirrorBytes -= victim.rows.reduce((s, r) => s + r.length, 0);
        // #5664 note: eviction is silent by design (P7 cache semantics).
    }
}

function registerSidForSession(sessionId: string, sid: string): void {
    let set = sessionSids.get(sessionId);
    if (!set) {
        set = new Set();
        sessionSids.set(sessionId, set);
    }
    set.add(sid);
}

export function clearWatermarkV6Render(sessionId: string): void {
    const set = sessionSids.get(sessionId);
    if (!set) return;
    for (const sid of set) {
        const rw = mirrors.get(sid);
        if (rw) {
            mirrors.delete(sid);
            mirrorBytes -= rw.rows.reduce((s, r) => s + r.length, 0);
        }
    }
    sessionSids.delete(sessionId);
}

/** Hydrate from disk (G3): ckpt integrity check first (S4 death verdict),
 *  then current-truth rows + post-ckpt log fold for the cumulative sums.
 *  Returns null on ANY inconsistency — caller serves the baseline path. */
function hydrateMirror(store: SessionStore, sid: string, log?: LogFn): RenderWorld | null {
    try {
        if (!store.pfRenderCkptIntact(sid)) {
            log?.("error", `[${sid}] #5664 render checkpoint S4 checksum mismatch — plane judged dead for this sid until a forced recast heals it`);
            return null;
        }
        const rowsRaw = store.pfRenderRows(sid);
        if (rowsRaw.length === 0) return null;
        const metaRead = store.pfRenderMeta(sid);
        let estCum = 0;
        let textCum = 0;
        let imgCum = 0;
        let expectedCount = -1;
        let capsJson = "";
        if (metaRead?.ckpt) {
            const m = JSON.parse(metaRead.ckpt.metaJson) as RenderMeta;
            estCum = m.estCum ?? 0;
            textCum = m.textCum ?? 0;
            imgCum = m.imgCum ?? 0;
            expectedCount = m.rowCount;
            capsJson = metaRead.ckpt.metaJson;
            for (const e of metaRead.log) {
                const p = JSON.parse(e.payloadJson) as { de?: number; dt?: number; di?: number; n?: number; capsJson?: string } & Partial<RenderMeta>;
                if (e.kind === "cast" || e.kind === "recast") {
                    estCum = p.estCum ?? 0;
                    textCum = p.textCum ?? 0;
                    imgCum = p.imgCum ?? 0;
                    expectedCount = p.rowCount ?? -1;
                    if (e.kind === "recast" && p.capsJson !== undefined) capsJson = p.capsJson;
                } else if (e.kind === "append") {
                    estCum += p.de ?? 0;
                    textCum += p.dt ?? 0;
                    imgCum += p.di ?? 0;
                    if (expectedCount >= 0) expectedCount += p.n ?? 0;
                }
            }
        } else {
            capsJson = "";
        }
        const rows: string[] = new Array(rowsRaw.length);
        const rowsParsed: unknown[] = new Array(rowsRaw.length);
        for (let i = 0; i < rowsRaw.length; i++) {
            const rj = rowsRaw[i].rowJson;
            if (rj === null || rowsRaw[i].pos !== i) return null; // tombstone/gap = inconsistent
            rows[i] = rj;
            try {
                rowsParsed[i] = JSON.parse(rj);
            } catch {
                return null;
            }
        }
        if (expectedCount !== -1 && expectedCount !== rows.length) {
            // Base sums no longer line up with the row table — the log fold
            // disagrees with truth. Caller will serve legacy; the next
            // capture diff (full arrays both sides) heals with a recast.
            return null;
        }
        let caps: RenderCaps | undefined;
        if (capsJson) {
            // The log payload stores caps VERBATIM (JSON.stringify(caps)); the
            // checkpoint meta wraps them as RenderMeta.caps.
            const parsed = JSON.parse(capsJson) as RenderCaps & Partial<RenderMeta>;
            // Two storage shapes coexist: render-log payloads carry caps
            // VERBATIM ({v,model,...}); the checkpoint meta WRAPS them as
            // {v,caps:{...},rowCount,...}. Accept both.
            const inner = (parsed.caps as RenderCaps | undefined);
            caps = inner && inner.v === 1 ? inner : (parsed.v === 1 ? parsed : undefined);
        } else {
            return null; // rows without capabilities = cannot gate safely
        }
        if (!caps || caps.v !== 1) return null;
        const rw: RenderWorld = { sid, rows, rowsParsed, caps, estCum, textCum, imgCum, auditTick: 0 };
        touchMirror(rw);
        return rw;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Gate (station entry — called once per engaged request, cheap probes only)
// ---------------------------------------------------------------------------

export interface RenderGateArgs {
    sessionId: string;
    session: Session;
    store: SessionStore;
    /** true iff this request is an engaged v6 HIT (v6Evaluated.hit !== null). */
    engagedHit: boolean;
    /** true on the arm turn (first registration) — always rides legacy. */
    armedTurn: boolean;
    isTitleGen: boolean;
    /** the render plane sid (x-bili-pf-session / probe owner). */
    sid: string;
    /** absolute position of the LAST identity element (plane 1 world.maxPos). */
    maxPos: number;
    tokenCount: number;
    modelContextLimit: number;
    caps: RenderCaps;
    /** #3756 snapshot lane substituted the kernel view for this turn. */
    snapshotLaneActive: boolean;
    absorbActive: boolean;
    ccrOn: boolean;
    foldUsagePending: boolean;
    markerNonZero: boolean;
    log?: LogFn;
}

export type RenderGateDecision =
    | { ok: false; reason: string }
    | { ok: true; rw: RenderWorld; F: number };

/** G1 conservative conjunction — every red condition returns the reason so
 *  the lane stays debuggable; the fallback path is unchanged baseline. */
export function renderPlaneGate(args: RenderGateArgs): RenderGateDecision {
    const off = (reason: string): RenderGateDecision => ({ ok: false, reason });
    if (!args.engagedHit) return off("not-engaged");
    if (args.armedTurn) return off("arm-turn");
    if (args.isTitleGen) return off("title-gen");
    if (!args.store.pfRenderAvailable()) return off("plane-unavailable");
    if (args.tokenCount >= PF_RENDER_EMERGENCY_RATIO * args.modelContextLimit) return off("pressure");
    if (args.snapshotLaneActive) return off("snapshot-lane");
    if (args.session.state.blocks.some((b) => b.active)) return off("blocks-active");
    if (args.foldUsagePending) return off("fold-pending");
    if (args.absorbActive) return off("absorb-active");
    if (args.ccrOn) return off("ccr-on");
    if (args.markerNonZero) return off("markers");
    let rw = mirrors.get(args.sid);
    if (rw === undefined) rw = hydrateMirror(args.store, args.sid, args.log) ?? undefined;
    if (rw === undefined) return off("hydrate-failed");
    if (!capsEqual(rw.caps, args.caps)) return off("caps-mismatch");
    if (rw.auditTick % PF_RENDER_AUDIT_EVERY === 0 && rw.auditTick > 0) return off("audit-due");
    if (rw.rows.length < 1) return off("no-rows");
    if (args.maxPos < 0) return off("no-plane-geometry");
    // Alignment invariant: rows are captured per engaged round and always
    // number one row per ledger element (row i ↔ pos i), so at GATE time —
    // which runs BEFORE this round's finalize advances the plane —
    // rows.length must equal maxPos+1. A mismatch means an earlier commit
    // failed soft (disk ahead/behind the mirror): fall back and let the
    // legacy diff+forced checkpoint self-heal rather than splice on a
    // misaligned window.
    if (rw.rows.length !== args.maxPos + 1) return off("rows-misaligned");
    registerSidForSession(args.sessionId, args.sid);
    const F = Math.min(PF_RENDER_WINDOW, rw.rows.length);
    // Window input = last F identity elements (+ new cores added by caller);
    // positions are contiguous because the ledger grows forward only (P3).
    if (args.maxPos < F - 1) return off("window-short");
    return { ok: true, rw, F };
}

/** Called AFTER the decision is consumed (keeps the audit cadence honest —
 *  a gated-off-for-pressure turn still counts as engaged). */
export function bumpAuditTick(sid: string): void {
    const rw = mirrors.get(sid);
    if (rw) rw.auditTick += 1;
}

// ---------------------------------------------------------------------------
// Fast-round verification + splice (station 3)
// ---------------------------------------------------------------------------

/** Compare the mapped first-F fast outputs against the stored suffix. The
 *  caller has already run the SAME mapping chain (rescale→harden→
 *  coreToOpenai→systemToUser voice fn) as the baseline capture, so this is
 *  a pure byte compare. Returns false on ANY difference (incl. length). */
export function verifyRenderWindow(fastEmitsJson: string[], rw: RenderWorld, F: number): boolean {
    if (fastEmitsJson.length < F) return false;
    const start = rw.rows.length - F;
    if (start < 0) return false;
    for (let i = 0; i < F; i++) {
        if (fastEmitsJson[i] !== rw.rows[start + i]) return false;
    }
    return true;
}

/** Splice: prefix parsed rows (cached — zero parse/stringify cost) + mapped
 *  fast tail. Row indices align with rendered ordinals (probe-verified
 *  positional determinism; the byte check above is the tripwire). */
export function spliceOutboundRows<T>(rw: RenderWorld, F: number, tail: T[]): T[] {
    const prefixLen = rw.rows.length - F;
    if (prefixLen < 0) throw new Error("#5664 splice prefix underflow");
    const out: T[] = [];
    // rowsParsed entries are JSON.parse of THIS plane's previously captured
    // rows — exactly T elements by construction (capture stores what egress
    // emitted, and egress emitted T).
    out.push(...(rw.rowsParsed.slice(0, prefixLen) as T[]));
    out.push(...tail);
    return out;
}

// ---------------------------------------------------------------------------
// Capture commits (station 2) — invoked at finalize on EVERY engaged turn
// ---------------------------------------------------------------------------

export interface CaptureSums {
    estCum: number;
    textCum: number;
    imgCum: number;
}

export type CaptureMode = "steady" | "legacy";

export interface CaptureArgs {
    sessionId: string;
    store: SessionStore;
    sid: string;
    mode: CaptureMode;
    caps: RenderCaps;
    /** steady: ONLY the new tail raw strings; legacy: the FULL captured rows. */
    rowStrings: string[];
    sums: CaptureSums; // steady: DELTAS for the tail; legacy: ABSOLUTE totals.
    log?: LogFn;
}

/** 'equal' | 'append' | 'recast' — prefix-identical growth vs rewrite. */
export function diffRowLists(prev: string[], cur: string[]): "equal" | "append" | "recast" {
    if (prev.length === cur.length) {
        for (let i = 0; i < prev.length; i++) if (prev[i] !== cur[i]) return "recast";
        return "equal";
    }
    if (cur.length > prev.length) {
        for (let i = 0; i < prev.length; i++) if (prev[i] !== cur[i]) return "recast";
        return "append";
    }
    return "recast";
}

export function commitRenderCapture(args: CaptureArgs): { committed: boolean; op: "none" | "append" | "cast" | "recast" } {
    const { store, sid, caps, log } = args;
    let rw = mirrors.get(sid);
    if (rw === undefined && !mirrors.has(sid)) {
        const hydrated = hydrateMirror(store, sid, log);
        if (hydrated !== null) {
            mirrors.set(sid, hydrated);
            rw = hydrated;
        }
    }
    const metaJson = (m: RenderMeta): string => JSON.stringify(m);
    if (rw === undefined || rw.rows.length === 0) {
        // No usable base: full cast with a FORCED checkpoint (self-healing
        // first use / post-death rebuild). Legacy turns only reach here with
        // full arrays, which is exactly what a cast needs.
        if (args.mode === "legacy") {
            const rows = args.rowStrings;
            const m: RenderMeta = { v: 1, caps, rowCount: rows.length, estCum: args.sums.estCum, textCum: args.sums.textCum, imgCum: args.sums.imgCum };
            const okSeq = store.pfRenderCommit(sid, {
                rows: rows.map((rj, pos) => ({ pos, rowJson: rj })),
                logEntries: [{ kind: "cast", payloadJson: JSON.stringify({ ...m, capsJson: JSON.stringify(caps) }) }],
                checkpointMetaJson: metaJson(m),
            });
            if (okSeq === null) return { committed: false, op: "none" };
            const parsed = rows.map((rj) => safeParse(rj));
            mirrors.set(sid, { sid, rows: [...rows], rowsParsed: parsed, caps: { ...caps }, estCum: args.sums.estCum, textCum: args.sums.textCum, imgCum: args.sums.imgCum, auditTick: 0 });
            registerSidForSession(args.sessionId, sid);
            return { committed: true, op: "cast" };
        }
        // Steady turns without a base cannot append into nothing: skip (the
        // identity lane already served; next legacy turn builds the base).
        return { committed: false, op: "none" };
    }
    if (args.mode === "steady") {
        const prevLen = rw.rows.length;
        const rows = args.rowStrings;
        const okSeq = store.pfRenderCommit(sid, {
            rows: rows.map((rj, i) => ({ pos: prevLen + i, rowJson: rj })),
            logEntries: [{ kind: "append", payloadJson: JSON.stringify({ de: args.sums.estCum, dt: args.sums.textCum, di: args.sums.imgCum, n: rows.length }) }],
        });
        if (okSeq === null) return { committed: false, op: "none" };
        const parsed = rows.map((rj) => safeParse(rj));
        rw.rows.push(...rows);
        rw.rowsParsed.push(...parsed);
        rw.estCum += args.sums.estCum;
        rw.textCum += args.sums.textCum;
        rw.imgCum += args.sums.imgCum;
        touchMirror(rw);
        return { committed: true, op: "append" };
    }
    // legacy full-capture: diff against truth, minimal commit.
    const verdict = diffRowLists(rw.rows, args.rowStrings);
    if (verdict === "equal") {
        rw.caps = { ...caps }; // keep caps fresh even when bytes match
        touchMirror(rw);
        return { committed: true, op: "none" };
    }
    if (verdict === "append") {
        const prevLen = rw.rows.length;
        const tail = args.rowStrings.slice(prevLen);
        const delta = {
            estCum: Math.max(0, args.sums.estCum - rw.estCum),
            textCum: Math.max(0, args.sums.textCum - rw.textCum),
            imgCum: Math.max(0, args.sums.imgCum - rw.imgCum),
        };
        const okSeq = store.pfRenderCommit(sid, {
            rows: tail.map((rj, i) => ({ pos: prevLen + i, rowJson: rj })),
            logEntries: [{ kind: "append", payloadJson: JSON.stringify({ de: delta.estCum, dt: delta.textCum, di: delta.imgCum, n: tail.length }) }],
        });
        if (okSeq === null) return { committed: false, op: "none" };
        const parsed = tail.map((rj) => safeParse(rj));
        rw.rows.push(...tail);
        rw.rowsParsed.push(...parsed);
        rw.estCum = args.sums.estCum;
        rw.textCum = args.sums.textCum;
        rw.imgCum = args.sums.imgCum;
        rw.caps = { ...caps };
        touchMirror(rw);
        return { committed: true, op: "append" };
    }
    // recast — client-side structural change (compaction & friends) or caps
    // flip: rewrite covered ordinals, physically drop the excess, and FORCE
    // the L1 checkpoint in the same transaction (owner ruling).
    const rows = args.rowStrings;
    const oldMaxPos = rw.rows.length - 1;
    const deletes = oldMaxPos >= rows.length ? Array.from({ length: oldMaxPos + 1 - rows.length }, (_, i) => rows.length + i) : [];
    const m: RenderMeta = { v: 1, caps, rowCount: rows.length, estCum: args.sums.estCum, textCum: args.sums.textCum, imgCum: args.sums.imgCum };
    const okSeq = store.pfRenderCommit(sid, {
        rows: rows.map((rj, pos) => ({ pos, rowJson: rj })),
        deletes: deletes.length > 0 ? deletes : undefined,
        logEntries: [{ kind: "recast", payloadJson: JSON.stringify({ ...m, capsJson: JSON.stringify(caps) }) }],
        checkpointMetaJson: metaJson(m),
    });
    if (okSeq === null) return { committed: false, op: "none" };
    const parsed = rows.map((rj) => safeParse(rj));
    mirrors.set(sid, { sid, rows: [...rows], rowsParsed: parsed, caps: { ...caps }, estCum: args.sums.estCum, textCum: args.sums.textCum, imgCum: args.sums.imgCum, auditTick: 0 });
    return { committed: true, op: "recast" };
}

function safeParse(json: string): unknown {
    try {
        return JSON.parse(json);
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Diagnostics / test surface
// ---------------------------------------------------------------------------

export interface RenderDebugWorld {
    sid: string;
    rows: number;
    caps: RenderCaps;
    estCum: number;
    textCum: number;
    imgCum: number;
    auditTick: number;
}

export function watermarkV6RenderDebugState(sessionId: string): { sids: RenderDebugWorld[] } {
    const set = sessionSids.get(sessionId);
    const sids: RenderDebugWorld[] = [];
    if (set) {
        for (const sid of set) {
            const rw = mirrors.get(sid);
            if (rw) sids.push({ sid, rows: rw.rows.length, caps: rw.caps, estCum: rw.estCum, textCum: rw.textCum, imgCum: rw.imgCum, auditTick: rw.auditTick });
        }
    }
    return { sids };
}

/** Test-only: reset every mirror (never call from production paths). */
export function _resetWatermarkV6RenderTestState(): void {
    mirrors.clear();
    sessionSids.clear();
    mirrorBytes = 0;
}
