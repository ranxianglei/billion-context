/**
 * #5874 — snapshot-table compression foundation: the server-side glue.
 *
 * This module is the ONLY place where the six stages meet:
 *
 *   0. identity  — the host's per-element msgid envelope (biliMsgIds #4491) is
 *      matched against the session's L1 world (l1_world): echo / probe /
 *      scatter / issue / diverge (§4.0). A cohort session that carries no
 *      usable envelope is a red-gate R3 fault: HARD REJECT (400), zero kernel
 *      side effects, and the per-session breaker latches the plane red after
 *      repeated faults so a broken client degrades instead of bricking.
 *   1. convert   — the same public wire codec the legacy lane uses
 *      (openaiToCore) plus the #4491 msgid pin; the table is NEVER the source
 *      of ids.
 *   2. rewrite   — the kernel is zero-change (processTurn / applyCompression);
 *      its evidence (block coverage + the model view) is what reconcile
 *      addresses the ledger with.
 *   3. commit    — ONE storage transaction per turn (commitSnapshot): upsert
 *      rows → append log events → optional checkpoint fold. The fold path
 *      (plugin endpoint) commits through the same primitive.
 *   4. egress    — the outbound prefix renders from the ACTIVE ROWS in host
 *      envelope order (the table bytes, not the client's re-sent bytes); the
 *      tail is this turn's new elements. This is the byte-stability property
 *      the whole foundation exists for (T4: A/B parity modulo time attrs).
 *   5. out       — the decision token rides the client-visible
 *      x-bili-snapshot response header; a sampled tripwire byte-compares the
 *      foundation egress against the legacy view and latches the plane red on
 *      any mismatch (the permanent fail-safe).
 *
 * Red gates (proposal §7):
 *   R1  S4 aggregate / kernel-state checksum bad → the session's plane is
 *       PERMANENTLY dead (legacy forever; re-derived from the tables after a
 *       restart — no in-memory state can revive it).
 *   R2  the evidence join chain is broken (an element's fate is
 *       unexplainable) → NO events are committed this turn and the whole turn
 *       runs legacy. The plane survives (per-turn, self-healing).
 *   R3  cohort envelope fault → hard 400 + zero side effects + breaker.
 *   R4  a structural pending marker is found on hydrate (a commit that never
 *       landed) → conservatively dead. The current design makes every commit
 *       re-derivable (rows + state + envelope ⇒ the same events), so a
 *       crashed commit self-heals on the next reconcile; the path is kept as
 *       defense in depth.
 *
 * Coexistence (§8 / ruling K): watermark fastpath and the foundation are a
 * flag mutex per session — a foundation-gated turn suppresses the watermark
 * block and the #3756 snapshot-render lane; both planes keep running for all
 * other sessions (the tables are shared, the rollout flags are independent).
 */
import type { CompressionBlock, CompressionState } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { featureEnabled } from "./rollout.ts";
import { getStore } from "./persist.ts";
import { loadConfigFile } from "./config.ts";
import { listSessions, type Session } from "./session.ts";
import {
    buildEgressView,
    hydratePlane,
    matchWorld,
    reconcile,
} from "./snapshot/index.ts";
import type {
    PlaneState,
    SnapshotRowView,
    WorldDecision,
    WorldEnvelopeEntry,
    WorldMode,
} from "./snapshot/types.ts";
import type { L1WorldRow } from "./storage/store.ts";
import type { StorageBackend } from "./storage/backend.ts";
import type { RewriteCtx } from "./stream.ts";

const SNAPSHOT_MASTER = "snapshotFoundation";
const SNAPSHOT_LANE = "snapshotLane";

type FoundationLog = (lvl: "debug" | "info" | "warn" | "error", msg: string) => void;

/** The 400 control channel (R3). Thrown from prepare, answered in handle. */
export class FoundationRejectError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(code: string, message: string, status = 400) {
        super(message);
        this.name = "FoundationRejectError";
        this.status = status;
        this.code = code;
    }
}

interface FoundationKnobs {
    /** File-tier master switch (the rollout flags decide independently). */
    enabled: boolean;
    /** D4: the cohort roster — which plugin hosts may enroll. */
    cohortHosts: string[];
    /** §4.5: fraction of green turns sampled by the tripwire (0 disables). */
    tripwireRate: number;
    /** Checkpoint (log-absorbing fold) cadence in turns, in addition to folds. */
    ckptEveryNTurns: number;
}

const DEFAULT_COHORT = ["pi"];

/** Config-file tier for the foundation (no new env knobs — the rollout env
 *  overrides BILI_ROLLOUT_SNAPSHOT_FOUNDATION / BILI_ROLLOUT_SNAPSHOT_LANE
 *  already exist through the generic rollout mechanism). */
function snapshotKnobs(): FoundationKnobs {
    const snap = (loadConfigFile() as { snapshot?: Record<string, unknown> } | undefined)?.snapshot;
    const cohort = Array.isArray(snap?.cohortHosts)
        ? (snap.cohortHosts as unknown[]).filter((h): h is string => typeof h === "string")
        : DEFAULT_COHORT;
    const rate = typeof snap?.tripwireRate === "number" ? (snap.tripwireRate as number) : 0.05;
    const cadence = typeof snap?.ckptEveryNTurns === "number" ? (snap.ckptEveryNTurns as number) : 16;
    return {
        enabled: snap?.enabled !== false,
        cohortHosts: cohort,
        tripwireRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.05,
        ckptEveryNTurns: Number.isFinite(cadence) && cadence >= 1 ? Math.floor(cadence) : 16,
    };
}

/** Enrollment gate (pure sync): both rollout flags (lane is base-nested on
 *  the master, so this is the two-level switch) + the file-tier enabled
 *  override + the cohort roster. Decided BEFORE any store access, so a
 *  non-cohort session never touches the tables. */
export function foundationLaneActive(session: Session): boolean {
    if (!featureEnabled(SNAPSHOT_MASTER)) return false;
    if (!featureEnabled(SNAPSHOT_LANE)) return false;
    const knobs = snapshotKnobs();
    if (!knobs.enabled) return false;
    const agent = session.metadata["pluginAgent"];
    return typeof agent === "string" && knobs.cohortHosts.includes(agent);
}

type FoundationPhase = "off" | "arm" | "hit" | "diverge" | "red";

export interface FoundationTurn {
    phase: FoundationPhase;
    /** Decision token — the x-bili-snapshot response header value. */
    token: string;
    /** The green plane (phase "hit") — its rows seed the commit diff. */
    plane: PlaneState | null;
    /** This turn's host msgid envelope (wire order). */
    envelope: string[];
    /** msgid → APPEND-ONLY pos (never reused; the world's standing canon). */
    posMap: Record<string, number>;
    /** This turn's ordinal (arm = 1). */
    turnCount: number;
    worldMode: WorldMode;
    session: Session;
}

const PLANE_LATCH_KEY = "snapshot:plane";
const DIVERGE_KEY = "snapshot:diverge";
const R3_KEY = "snapshot:r3";
/** Committed model-turn counter (session_ext, flat JSON number). The ckpt
 *  cadence (turnCount % ckptEveryNTurns) is driven by it — the row ledger
 *  itself cannot count turns (no-op turns append no events). */
const TURNS_KEY = "snapshot:turns";

/** R3 breaker: 3 envelope faults within 10 minutes → latch the plane red
 *  (subsequent turns degrade to legacy instead of 400-ing). In-memory until
 *  it trips — zero side effects per fault, exactly as the gate demands. */
const r3Faults = new Map<string, { count: number; windowStart: number }>();

function foundationStore(): StorageBackend | null {
    return getStore().foundationStore();
}

function worldToRow(world: WorldDecision, sessionId: string, now: number): L1WorldRow {
    void now; // issuedAt/armedAt come from the match decision itself
    return {
        sessRaw: sessionId,
        sessionId,
        ledgerId: world.issuedLedgerId ?? sessionId,
        // The canon is the ordered {id,pos} entry list (append-only pos,
        // never reused) — the world IS the msgid→pos map.
        envelopeJson: JSON.stringify(world.envelope),
        envelopeChecksum: world.envelopeChecksum,
        witnessProbe: world.witness ?? null,
        issuedAt: world.issuedAt,
        armedAt: world.armedAt ?? null,
    };
}

function posMapOf(envelope: WorldEnvelopeEntry[]): Record<string, number> {
    const m: Record<string, number> = {};
    for (const e of envelope) m[e.id] = e.pos;
    return m;
}

function serializeKernelState(state: CompressionState): Record<string, unknown> {
    // The kstate persistence path round-trips the same object through JSON,
    // so a JSON round-trip here is the canonical plain form (Maps/undefined
    // cannot occur in a persisted state by construction).
    return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

/**
 * Stages 0+1: world match for an enrolled session. Runs BEFORE processTurn —
 * a thrown FoundationRejectError therefore carries zero kernel side effects.
 *
 * Returns the turn's plane state; callers with phase "off"/"red"/"diverge"
 * run the whole turn legacy (no table reads or writes happened that could
 * change the egress).
 */
export async function foundationPrepare(args: {
    session: Session;
    incomingMsgIds: string[] | null;
    log: FoundationLog;
}): Promise<FoundationTurn> {
    const { session, incomingMsgIds, log } = args;
    const store = foundationStore();
    if (store === null) {
        // No unified sidecar (storage disabled / open failed): the tables do
        // not exist, the foundation cannot run. Legacy — a degrade, not a red
        // gate (the plane simply has no substrate).
        log("warn", `[snapshot] ${session.id}: foundation enrolled but the unified store is unavailable — lane degraded to legacy`);
        return { phase: "off", token: "degrade", plane: null, envelope: incomingMsgIds ?? [], posMap: {}, turnCount: 0, worldMode: "issue", session };
    }
    // R3: an enrolled session MUST carry the envelope. (Length/validity is
    // checked against the parsed count by the caller — see prepare-openai —
    // and faults land here through the same throw path.)
    if (incomingMsgIds === null || incomingMsgIds.length === 0) {
        const tripped = recordR3Fault(session.id, log);
        if (tripped) {
            await store.setSessionExt(session.id, PLANE_LATCH_KEY, "red:R3");
            return { phase: "red", token: "red:R3", plane: null, envelope: [], posMap: {}, turnCount: 0, worldMode: "issue", session };
        }
        throw new FoundationRejectError(
            "SNAPSHOT_ENVELOPE_FAULT",
            "enrolled snapshot-foundation session missing the inbound msgid envelope (biliMsgIds) — hard-rejected per #5874 R3; the session plane latches to legacy after repeated faults",
        );
    }
    const now = Date.now();
    // Sticky red latch (breaker R3 / tripwire / R1 / R4) — checked before
    // any table read: a latched plane never runs again in this install.
    const latch = await store.getSessionExt(session.id, PLANE_LATCH_KEY);
    if (typeof latch === "string" && latch.startsWith("red:")) {
        return { phase: "red", token: latch, plane: null, envelope: incomingMsgIds, posMap: {}, turnCount: 0, worldMode: "issue", session };
    }
    // Hydrate the plane (stage 3 read side). ALL rows (active + inactive)
    // are read: the green plane keeps the active ones, and the INACTIVE
    // covered rows (coverRef set) are the fold evidence that explains a
    // post-fold head shrink to the world match (the live-head rule).
    const worldRow = await store.getL1World(session.id);
    const rows = await store.getSnapRows(session.id, { includeInactive: true });
    const ckpt = await store.getSnapCkpt(session.id);
    const frontier = await store.snapLogMaxSeq(session.id);
    // A missing world row on an EMPTY plane is a fresh session → the match
    // below issues it (phase arm). A missing world with RESIDUE (rows or a
    // checkpoint) is an inconsistent substrate — the canon is gone but data
    // claiming it remains: red, legacy egress, re-evaluated every turn (no
    // latch: cleaning the residue restores the session, never bricks it).
    const plane: PlaneState = worldRow === null
        ? (rows.length > 0 || ckpt !== null)
            ? { health: "red", reason: "no-tables", frontier, turnCount: 0 }
            : { health: "green", rows: new Map<number, SnapshotRowView>(), meta: undefined, frontier, turnCount: 0 }
        : hydratePlane({
            sessionId: session.id,
            flagOn: true,
            world: worldRow,
            rows,
            ckpt,
            frontier,
            structuralPending: false,
        });
    // The committed-turn counter (see TURNS_KEY): every turn that commits
    // lands it, so the checkpoint cadence counts committed turns, not
    // requests (R2/diverge turns append nothing and stay uncounted).
    const committedTurns = Math.max(0, Math.floor(Number(await store.getSessionExt(session.id, TURNS_KEY) ?? 0) || 0));
    if (plane.health === "red") {
        if (plane.reason === "R1" || plane.reason === "R4") {
            // Make the death sticky so the latch survives even if a later
            // partial repair makes the tables read "green" again.
            await store.setSessionExt(session.id, PLANE_LATCH_KEY, `red:${plane.reason}`);
            log("error", `[snapshot] ${session.id}: plane RED ${plane.reason} (permanent) — session pinned to legacy egress`);
        }
        return { phase: "red", token: `red:${plane.reason}`, plane: null, envelope: incomingMsgIds, posMap: {}, turnCount: 0, worldMode: "issue", session };
    }
    // Stage 0: world match (the §4.0 order: echo → probe/scatter → issue;
    // divergence is per-turn legacy with an auto-resync after two in a row).
    // A gone id whose row is inactive with a coverRef is fold-explained:
    // the head may legally move past it (post-fold shrink).
    const explainedGone = new Set<string>();
    for (const r of rows) {
        if (r.active || r.coverRef === null) continue;
        try {
            for (const id of JSON.parse(r.coreIds) as string[]) explainedGone.add(id);
        } catch {
            // corrupt coreIds on an inactive row: treat as unexplained (safe side)
        }
    }
    const world = matchWorld({
        stored: plane.world ?? null,
        incoming: incomingMsgIds,
        explainedGone,
        sessRaw: session.id,
        ledgerId: session.id,
        now,
        resync: false,
    });
    if (world.mode === "diverge") {
        const prev = Number(await store.getSessionExt(session.id, DIVERGE_KEY) ?? 0) + 1;
        if (prev >= 2) {
            // Auto-resync: the stored canon no longer describes the client.
            // Re-issue the world (fresh ledger epoch) and re-cast THIS turn —
            // the fail-safe the baseline promises (no fuzzy adoption).
            await store.deleteSnapshotSession(session.id);
            const fresh = matchWorld({
                stored: null,
                incoming: incomingMsgIds,
                sessRaw: session.id,
                ledgerId: session.id,
                now,
                resync: true,
            });
            await store.upsertL1World(worldToRow(fresh, session.id, now));
            await store.setSessionExt(session.id, DIVERGE_KEY, 0);
            await store.setSessionExt(session.id, TURNS_KEY, 0); // new world epoch: the turn count restarts
            log("warn", `[snapshot] ${session.id}: world divergence repeated — auto-resync (new world epoch, this turn re-casts)`);
            return {
                phase: "arm",
                token: "resync",
                plane: null,
                envelope: incomingMsgIds,
                posMap: posMapOf(fresh.envelope),
                turnCount: committedTurns + 1,
                worldMode: "resync",
                session,
            };
        }
        await store.setSessionExt(session.id, DIVERGE_KEY, prev);
        log("warn", `[snapshot] ${session.id}: world divergence (${world.witness ?? "unknown"}) — this turn legacy (no table writes); a second consecutive divergence re-syncs`);
        return { phase: "diverge", token: "miss", plane: null, envelope: incomingMsgIds, posMap: {}, turnCount: 0, worldMode: "diverge", session };
    }
    // Persist the world on issue / probe / scatter (echo = the stored canon
    // already equals the envelope; nothing to write).
    if (world.mode !== "echo") {
        await store.upsertL1World(worldToRow(world, session.id, now));
        await store.setSessionExt(session.id, DIVERGE_KEY, 0);
    }
    if (world.mode === "issue") {
        // B1: the arming turn — egress stays legacy for exactly this turn;
        // the rows are cast at turn end (the world origin is fixed now and
        // never moves again except through an explicit resync).
        log("info", `[snapshot] ${session.id}: world issued (envelope ${incomingMsgIds.length} element(s), armed) — arming turn, rows cast at commit`);
        return {
            phase: "arm",
            token: "arm",
            plane: null,
            envelope: incomingMsgIds,
            posMap: posMapOf(world.envelope),
            turnCount: committedTurns + 1,
            worldMode: "issue",
            session,
        };
    }
    return {
        phase: "hit",
        token: "hit",
        plane,
        envelope: incomingMsgIds,
        posMap: posMapOf(world.envelope),
        turnCount: committedTurns + 1,
        worldMode: world.mode,
        session,
    };
}

/** R3 breaker bookkeeping. Returns true when the breaker trips. */
function recordR3Fault(sessionId: string, log: FoundationLog): boolean {
    const now = Date.now();
    const WINDOW_MS = 10 * 60 * 1000;
    const maxFaults = 3;
    let rec = r3Faults.get(sessionId);
    if (rec === undefined || now - rec.windowStart > WINDOW_MS) rec = { count: 0, windowStart: now };
    rec.count += 1;
    r3Faults.set(sessionId, rec);
    if (rec.count >= maxFaults) {
        log("error", `[snapshot] ${sessionId}: R3 breaker tripped (${rec.count} envelope faults in the window) — plane latched red (legacy) until restart/resync`);
        r3Faults.delete(sessionId);
        return true;
    }
    log("error", `[snapshot] ${sessionId}: R3 envelope fault ${rec.count}/${maxFaults} — hard reject (400), zero side effects`);
    return false;
}

interface FoundationCommitResult {
    /** The egress view, or null when the turn stays legacy (R2 / degrade). */
    egress: BiliMessage[] | null;
    token: string;
    joined: boolean;
    events: number;
    ckptFolded: boolean;
    /** Tripwire outcome for observability (green turns only). */
    tripwire: "off" | "skip" | "pass" | "fail";
}

/**
 * Stages 2–5: reconcile the turn against the row ledger, commit the
 * single transaction, and build the table-sourced egress.
 *
 * `msgs` is the PINNED client view (1:1 with `turn.envelope` — the #4491
 * pin guarantees element i ↔ envelope[i]); `modelView` is the processed
 * model view (post stripKernelSummaries + reasoning drop, pre nudge); the
 * blocks are the CURRENT session state's blocks with the pre-turn active
 * set for the fold detection.
 */
export async function foundationCommitTurn(args: {
    turn: FoundationTurn;
    msgs: BiliMessage[];
    modelView: BiliMessage[];
    blocks: CompressionBlock[];
    activeBefore: Set<string>;
    state: CompressionState;
    log: FoundationLog;
}): Promise<FoundationCommitResult> {
    const { turn, msgs, modelView, blocks, activeBefore, state, log } = args;
    if (turn.phase === "off" || turn.phase === "red" || turn.phase === "diverge") {
        return { egress: null, token: turn.token, joined: false, events: 0, ckptFolded: false, tripwire: "off" };
    }
    if (msgs.length !== turn.envelope.length) {
        // Defense in depth: the pin already guarantees parity; if it ever
        // does not, the join is unaddressable → R2 (this turn legacy).
        log("error", `[snapshot] ${turn.session.id}: envelope/model count parity lost (${turn.envelope.length} vs ${msgs.length}) — R2, turn legacy`);
        return { egress: null, token: "miss", joined: false, events: 0, ckptFolded: false, tripwire: "off" };
    }
    const store = foundationStore();
    if (store === null) {
        return { egress: null, token: "degrade", joined: false, events: 0, ckptFolded: false, tripwire: "off" };
    }
    const parsedCores = msgs.map((m) => [{ id: m.id, toolName: m.toolName, toolCallId: m.toolCallId }]);
    // The PINNED HEAD (kernel rebuildMessages never hides the first user core
    // run, even when a fold covers it — same-wireIndex run): those core ids
    // stay in the egress, so the reconcile must keep their rows active.
    const pinnedHeadIds: string[] = [];
    {
        const fi = msgs.findIndex((m) => m.role === "user");
        if (fi >= 0) {
            const first = msgs[fi]!;
            const wi = first.wireIndex;
            for (let j = fi; j < msgs.length; j++) {
                const m = msgs[j]!;
                if (m.role !== "user" || m.wireIndex !== wi) break;
                pinnedHeadIds.push(m.id);
            }
        }
    }
    const activeBlocks = blocks.filter((b) => b.active);
    // `compressCallId` is the hidden-carrier evidence: the kernel drops the
    // fold's tool-call/result pair from the model view, and the pair's call
    // id === the block's compressCallId (reconcile turns such 0-core
    // elements into no-egress carrier rows instead of an R2).
    const blockCoverage = activeBlocks.map((b) => ({ blockId: b.blockId, coreIds: b.effectiveMessageIds, compressCallId: b.compressCallId ?? null }));
    const newBlockIds = activeBlocks.filter((b) => !activeBefore.has(b.blockId)).map((b) => b.blockId);
    const currentRows = new Map<number, SnapshotRowView>();
    if (turn.plane !== null) for (const [pos, row] of (turn.plane.rows ?? [])) currentRows.set(pos, row);
    const out = reconcile({
        sessionId: turn.session.id,
        currentRows,
        envelope: turn.envelope,
        posMap: turn.posMap,
        parsedCores,
        blockCoverage,
        modelView: modelView.map((m) => ({ ...m, id: m.id })),
        pinnedHeadIds,
        foldedThisTurn: newBlockIds.length > 0,
        kernelState: serializeKernelState(state),
        now: Date.now(),
        turnCount: turn.turnCount,
        ckptEveryNTurns: snapshotKnobs().ckptEveryNTurns,
    });
    if (!out.joinOk) {
        // R2: NO events this turn — the caller commits nothing and egresses
        // legacy. The plane survives (per-turn gate, self-healing).
        log("warn", `[snapshot] ${turn.session.id}: R2 join failure — evidence unaddressable, this turn commits nothing and egresses legacy`);
        return { egress: null, token: "miss", joined: false, events: 0, ckptFolded: false, tripwire: "off" };
    }
    const now = Date.now();
    if (out.rows.length > 0 || out.events.length > 0 || out.ckpt !== undefined) {
        // The ckpt absorbs the log up to the LAST entry this commit appends
        // (frontier + n, read immediately before the commit — a racing fold
        // commit can only push the frontier up, which delays the absorption
        // to the next ckpt; it can never under-absorb past a written row).
        const frontier = await store.snapLogMaxSeq(turn.session.id);
        // The coverage map is the ABSORBED history: the ckpt currently in the
        // store (which the awaited fold flush has already advanced) plus this
        // fold's ranges. Reading it from the store (not the turn's plane,
        // hydrated earlier) closes the fold→model gap.
        let metaJson = JSON.stringify(out.ckpt?.meta ?? null);
        if (out.ckpt !== undefined) {
            const cur = await store.getSnapCkpt(turn.session.id);
            let prior: Record<string, { lo: number; hi: number; blockId: string }> = {};
            if (cur !== null) {
                try {
                    prior = (JSON.parse(cur.metaJson) as { coverage?: typeof prior }).coverage ?? {};
                } catch {
                    prior = {}; // corrupt prior meta: start the map fresh (S4 will catch the drift next hydrate)
                }
            }
            metaJson = JSON.stringify({ ...out.ckpt.meta, coverage: { ...prior, ...out.ckpt.meta.coverage } });
        }
        await store.commitSnapshot({
            sessionId: turn.session.id,
            preContents: out.preContents,
            rows: out.rows.map((r) => ({
                pos: r.pos,
                coreIds: JSON.stringify(r.coreIds),
                preJson: r.preJson ?? null,
                postJson: r.postJson,
                tokensEst: r.tokensEst,
                active: r.active,
                coverRef: r.coverRef ?? null,
            })),
            logEntries: out.events.map((e) => ({ kind: e.kind, payload: JSON.stringify(e), createdAt: now })),
            ckpt: out.ckpt !== undefined
                ? {
                      ckptSeq: Math.max(frontier, turn.turnCount - 1) + out.events.length,
                      metaJson,
                      checksum: out.ckpt.s4,
                      updatedAt: now,
                  }
                : undefined,
            now,
        });
        // The turn is now committed: advance the committed-turn counter
        // (checkpoint cadence driver). A crash between the two writes costs
        // at most one ckpt-cadence tick — the cadence is advisory.
        await store.setSessionExt(turn.session.id, TURNS_KEY, turn.turnCount);
    }
    // Egress (stage 4): the active rows in HOST ENVELOPE order. Every
    // envelope element has a row after the commit (tail rows are active;
    // covered rows are inactive and render as their block's summary element
    // — the host's own element, already in the envelope).
    const merged = new Map<number, SnapshotRowView>(currentRows);
    for (const r of out.rows) {
        merged.set(r.pos, {
            pos: r.pos,
            coreIds: r.coreIds,
            preJson: r.preJson ?? null,
            postJson: r.postJson,
            tokensEst: r.tokensEst,
            active: r.active,
            coverRef: r.coverRef ?? null,
            updatedAt: now,
        });
    }
    const egressRows: { pos: number; postJson: string }[] = [];
    for (let i = 0; i < turn.envelope.length; i++) {
        const pos = turn.posMap[turn.envelope[i]!];
        const row = pos !== undefined ? merged.get(pos) : undefined;
        if (row !== undefined && row.active) egressRows.push({ pos, postJson: row.postJson });
    }
    let egress: BiliMessage[] | null;
    try {
        egress = buildEgressView({ activeRows: egressRows, tailCores: [] }).cores as BiliMessage[];
    } catch (err) {
        // Corrupt stored bytes reaching the egress: the last-line tripwire.
        // Latch the plane red (permanent) and egress legacy this turn.
        log("error", `[snapshot] ${turn.session.id}: egress build failed (${String(err)}) — plane latched red (corrupt table form), turn legacy`);
        await store.setSessionExt(turn.session.id, PLANE_LATCH_KEY, "red:R1").catch(() => { /* best effort */ });
        return { egress: null, token: "red:R1", joined: true, events: out.events.length, ckptFolded: out.ckpt !== undefined, tripwire: "off" };
    }
    // Stage 5: the sampled tripwire — the foundation egress must carry the
    // same core-id sequence as the legacy view (a stable host's re-send is
    // byte-identical by construction; any divergence is the cohort
    // assumption breaking → permanent red, per the baseline).
    let tripwire: FoundationCommitResult["tripwire"] = "off";
    const rate = snapshotKnobs().tripwireRate;
    if (turn.phase === "hit" && rate > 0 && Math.random() < rate) {
        tripwire = idSeq(egress) === idSeq(modelView) ? "pass" : "fail";
        if (tripwire === "fail") {
            await store.setSessionExt(turn.session.id, PLANE_LATCH_KEY, "red:tripwire").catch(() => { /* best effort */ });
            log("error", `[snapshot] ${turn.session.id}: TRIPWIRE FAIL — table egress diverged from the model view; plane latched red (permanent), session pinned to legacy`);
            return { egress: null, token: "red:tripwire", joined: true, events: out.events.length, ckptFolded: out.ckpt !== undefined, tripwire };
        }
    } else if (turn.phase === "hit") {
        tripwire = "skip";
    }
    if (out.events.length > 0 || out.ckpt !== undefined) {
        log("debug", `[snapshot] ${turn.session.id}: committed ${out.events.length} event(s)${out.ckpt !== undefined ? " + checkpoint" : ""} (egress ${egressRows.length} row(s), fold=${newBlockIds.length > 0})`);
    }
    return { egress, token: turn.token, joined: true, events: out.events.length, ckptFolded: out.ckpt !== undefined, tripwire };
}

function idSeq(cores: BiliMessage[]): string {
    return cores.map((c) => c.id).join("\n");
}

/**
 * The fold commit (stage 3, fold path): called from applyRanges right after
 * the kernel state commit, on BOTH carriers (plugin endpoint first scene +
 * proxy compress loop). It is fire-and-forget at the call site but queued
 * per session so commits keep their order; the caller (endpoint / loop)
 * additionally awaits `ctx.pendingSnapshotFlush` before responding so the
 * next model request always sees the folded rows.
 *
 * Fold-only: there is no envelope at the endpoint, so this commit carries
 * the compact events + the checkpoint (the ckpt boundary at the fold is the
 * #3752 bounded-lifetime guarantee) and NO tail rows. A model request that
 * reconciles from stale rows re-derives the SAME events (evidence-driven,
 * idempotent) — a late or crashed fold commit therefore self-heals.
 */
const foldQueue = new Map<string, Promise<void>>();

export function foundationFoldHook(ctx: RewriteCtx, newBlockIds: string[]): void {
    if (newBlockIds.length === 0) return;
    if (!foundationLaneActive(ctx.session)) return;
    const sid = ctx.session.id;
    const prev = foldQueue.get(sid) ?? Promise.resolve();
    const next = prev
        .then(() => foundationCommitFold(ctx, newBlockIds))
        .catch((err) => {
            ctx.log(`[snapshot] fold commit failed for ${sid}: ${String(err)} — the next model request re-derives the fold (evidence-driven, self-healing)`);
        });
    foldQueue.set(sid, next);
    ctx.pendingSnapshotFlush = next;
}

async function foundationCommitFold(ctx: RewriteCtx, newBlockIds: string[]): Promise<void> {
    const { session } = ctx;
    const store = foundationStore();
    if (store === null) return;
    const latch = await store.getSessionExt(session.id, PLANE_LATCH_KEY);
    if (typeof latch === "string" && latch.startsWith("red:")) return;
    const worldRow = await store.getL1World(session.id);
    const rows = await store.getSnapRows(session.id);
    const ckpt = await store.getSnapCkpt(session.id);
    const frontier = await store.snapLogMaxSeq(session.id);
    const plane = hydratePlane({
        sessionId: session.id,
        flagOn: true,
        world: worldRow,
        rows,
        ckpt,
        frontier,
        structuralPending: false,
    });
    if (plane.health !== "green" || plane.world === undefined) return; // arm/red: the model request owns the rows
    // FULL row set (incl. inactive): a re-fold's coverage resolves against
    // the covered rows' stored coreIds, which live on inactive rows.
    const allRows = await store.getSnapRows(session.id, { includeInactive: true });
    const currentRows = new Map<number, SnapshotRowView>();
    for (const row of allRows) {
        currentRows.set(row.pos, {
            pos: row.pos,
            coreIds: JSON.parse(row.coreIds) as string[],
            postJson: row.postJson,
            preJson: row.preJson ?? null,
            tokensEst: row.tokensEst,
            active: row.active, // SnapRow.active is already a boolean (store.ts converts 0/1)
            coverRef: row.coverRef ?? null,
            updatedAt: row.updatedAt,
        });
    }
    const state = ctx.session.state;
    // Pinned head for the fold commit: the first user core RUN in the
    // endpoint's message view (role-run — CoreMessage carries no wireIndex
    // sidecar; single-part elements make the run exactly one core). The
    // model request re-derives the exact wireIndex run anyway (re-pin
    // branch), so a role-run here is only an optimization.
    const pinnedHeadIds: string[] = [];
    {
        const fi = ctx.messages.findIndex((m) => m.role === "user");
        if (fi >= 0) {
            for (let j = fi; j < ctx.messages.length && ctx.messages[j]!.role === "user"; j++) {
                pinnedHeadIds.push(ctx.messages[j]!.id);
            }
        }
    }
    const activeBlocks = state.blocks.filter((b) => b.active).map((b) => ({ blockId: b.blockId, coreIds: b.effectiveMessageIds, compressCallId: b.compressCallId ?? null }));
    if (activeBlocks.length === 0) return;
    const out = reconcile({
        sessionId: session.id,
        currentRows,
        envelope: [],
        posMap: {},
        parsedCores: [],
        blockCoverage: activeBlocks,
        modelView: [],
        pinnedHeadIds,
        foldedThisTurn: true,
        kernelState: serializeKernelState(state),
        now: Date.now(),
        turnCount: plane.turnCount + 1,
        ckptEveryNTurns: 1, // every fold is a ckpt boundary (the design invariant)
        scopeFull: false, // fold-only: no envelope → the tail is carried forward, not swept
    });
    if (!out.joinOk) {
        ctx.log(`[snapshot] ${session.id}: fold join failed (R2) — no fold commit; the model request re-derives`);
        return;
    }
    if (out.events.length === 0 && out.rows.length === 0) return; // already folded (duplicate hook)
    // Merge the prior coverage map into the fold's meta (absorbed history).
    let ckptInput = out.ckpt;
    if (ckptInput !== undefined && plane.meta !== undefined) {
        ckptInput = {
            meta: { ...ckptInput.meta, coverage: { ...plane.meta.coverage, ...ckptInput.meta.coverage } },
            s4: ckptInput.s4,
        };
    }
    await store.commitSnapshot({
        sessionId: session.id,
        preContents: out.preContents,
        rows: out.rows.map((r) => ({
            pos: r.pos,
            coreIds: JSON.stringify(r.coreIds),
            preJson: r.preJson ?? null,
            postJson: r.postJson,
            tokensEst: r.tokensEst,
            active: r.active,
            coverRef: r.coverRef ?? null,
        })),
        logEntries: out.events.map((e) => ({ kind: e.kind, payload: JSON.stringify(e), createdAt: Date.now() })),
        ckpt: ckptInput !== undefined
            ? {
                  ckptSeq: frontier + Math.max(1, out.events.length),
                  metaJson: JSON.stringify(ckptInput.meta),
                  checksum: ckptInput.s4,
                  updatedAt: Date.now(),
              }
            : undefined,
        now: Date.now(),
    });
    ctx.log(`[snapshot] ${session.id}: fold committed (${out.events.length} compact event(s) + checkpoint, blocks ${newBlockIds.join(",")})`);
}

/** /__bili/status attribution: the per-session plane summary. */
async function foundationStatus(sessionId: string): Promise<Record<string, unknown>> {
    const store = foundationStore();
    if (store === null) return { enrolled: foundationLaneActiveId(sessionId), store: false };
    const latch = await store.getSessionExt(sessionId, PLANE_LATCH_KEY);
    const world = await store.getL1World(sessionId);
    const rows = await store.getSnapRows(sessionId, { includeInactive: true });
    const ckpt = await store.getSnapCkpt(sessionId);
    const frontier = await store.snapLogMaxSeq(sessionId);
    const active = rows.filter((r) => r.active).length;
    return {
        enrolled: foundationLaneActiveId(sessionId),
        store: true,
        plane: typeof latch === "string" ? latch : world !== null ? "green" : "unissued",
        rows: rows.length,
        rowsActive: active,
        frontier,
        ckptSeq: ckpt?.ckptSeq ?? null,
        envelopeElements: world !== null ? (safeEnvelopeLen(world.envelopeJson)) : 0,
    };
}

/** /__bili/status + /__bili/overview parity section (#2152 discipline): the
 *  install-level enrollment flags plus a bounded per-session plane summary
 *  over the LIVE enrolled sessions (the status endpoint is on-demand, so a
 *  few extra reads here are free; the cap keeps a pathological pool cheap). */
export async function foundationStatusWire(): Promise<Record<string, unknown>> {
    const master = featureEnabled(SNAPSHOT_MASTER);
    const lane = featureEnabled(SNAPSHOT_LANE);
    const knobs = snapshotKnobs();
    const enrolled = master && lane && knobs.enabled;
    const wire: Record<string, unknown> = {
        enrolled,
        master,
        lane,
        enabled: knobs.enabled,
        cohortHosts: knobs.cohortHosts,
        store: foundationStore() !== null,
    };
    if (!enrolled) return wire;
    const sessions = listSessions().filter((s) => foundationLaneActive(s));
    const per: unknown[] = [];
    for (const s of sessions.slice(0, 50)) {
        per.push({ sessionId: s.id, ...(await foundationStatus(s.id)) });
    }
    wire.sessions = per;
    return wire;
}

function foundationLaneActiveId(sessionId: string): boolean {
    void sessionId;
    // The cohort check needs the session's pluginAgent; the status page
    // calls this per-session with the session in hand — this helper reports
    // the install-level enrollment (both rollout flags + config switch).
    return featureEnabled(SNAPSHOT_MASTER) && featureEnabled(SNAPSHOT_LANE) && snapshotKnobs().enabled;
}

function safeEnvelopeLen(envelopeJson: string): number {
    try {
        const parsed: unknown = JSON.parse(envelopeJson);
        return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
        return 0;
    }
}
