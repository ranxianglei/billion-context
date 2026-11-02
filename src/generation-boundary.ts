// #4305: standing generation-boundary note. When the client switches model or
// upstream mid-conversation, the conversation's ref ledger restarts (a fresh
// session generation; refs re-keyed from m00001) while the client's persisted
// history — old compress receipts, acp_status outputs, block summaries, the
// model's own earlier replies — keeps citing refs from the previous generation.
// Those citations are permanently inert above this session's frontier yet look
// exactly like live refs, so the model keeps aiming compress at dead ranges
// until the circuit breaker fires (#4305 incident: five gates in a row on one
// request burst). The reactive receipts already name the frontier
// (beyondFrontierNote #2146, currentRefsSnapshot #1029), but the incident shows
// the model flails through them — so the fix has to be a STANDING part of the
// context, present from the first request of the new generation.
//
// Detection is one-shot and evidence-based: scan the visible core history for
// message-ref citations STRICTLY ABOVE the session's highest mapped ref — the
// provably-dead class (this session allocates no future refs, so an
// above-frontier citation can only come from another generation). Require ≥2
// DISTINCT such refs: one stray m-shaped token in prose is not evidence. Once
// detected the verdict is recorded in persisted session metadata and the note
// renders for the session's lifetime — static text, byte-stable across turns,
// prefix-cache safe after the (typically never-visible) one-time append.
//
// #5542 adds WITNESSED seeding: the two host-side split points where a new
// ref-ledger generation is born under an already-running conversation (a
// persona fork onto a suffixed session key, and the native-compaction rebase)
// call witnessGenerationReset AT THE MOMENT OF THE SPLIT. Residue detection
// alone is blind to exactly the worst case — a reset that cut off an execution
// tail discards the citing text too, so nothing ever triggers detection and
// the model reports completion of steps whose execution was lost, with zero
// trace of the reset anywhere user-visible. Witnessing makes the note ride
// from the first turn of the new generation, stamps the [acp-gen-reset] log
// marker at the split moment, and feeds the acp_status GENERATION BOUNDARY
// section. First-wins: the earliest boundary of a generation is the one the
// model must reason about.
//
// Deliberately display-only: no storage rewrite, no ref-space surgery, no gate
// changes. The text carries no numbers: the frontier advances as the session
// allocates, and a fixed ceiling would go stale within turns. Concrete ceilings
// stay with the reactive notes (beyondFrontierNote / frontierClampNote), which
// fire on the actual failure and always quote the live value.

import { markDirty, peekSession, type Session } from "./session.js";
import { getStore } from "./persist.js";
import type { CoreMessage } from "acp-kernel";

/** Session-metadata key for the one-shot detection record. */
const STORAGE_KEY = "generationBoundary";

/** Distinct above-frontier citations required before declaring a boundary:
 *  one stray m-shaped token in prose is not evidence, two distinct ones are. */
const MIN_DISTINCT_STALE_REFS = 2;

/** Message-ref citation in visible text — bare (`refs m05448–m05465`) or inside
 *  a surviving ACP tag (tag delimiters are non-word chars, so the inner id
 *  still matches). 4+ digits mirrors the kernel's m\d{4,} convention. */
const REF_CITATION_RE = /\bm(\d{4,})\b/g;

/** byRef key shape guard (mirrors stream.ts M_REF_NUM_RE usage). */
const BYREF_KEY_RE = /^m(\d+)$/;

interface GenerationBoundaryRecord {
    /** First-detection/witness time (ms epoch). */
    at: number;
    /** The previous generation's highest ref ("mNNNNN" or "" when none) — evidence anchor, log/display surface only. */
    frontier: string;
    /** Highest stale citation seen at detection — log surface only. Absent on witnessed records (no residue scan ran). */
    maxStaleRef?: string;
    /** How the boundary came to be known ("persona-fork" / "native-compaction-rebase"); absent = residue-detected. */
    reason?: string;
    /** One-line human context for the witness (keys involved etc.) — display surface only. */
    detail?: string;
}

export function readGenerationBoundary(session: Session): GenerationBoundaryRecord | undefined {
    const raw = session.metadata?.[STORAGE_KEY];
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r.at !== "number" || typeof r.frontier !== "string") return undefined;
    const rec: GenerationBoundaryRecord = { at: r.at, frontier: r.frontier };
    if (typeof r.maxStaleRef === "string") rec.maxStaleRef = r.maxStaleRef;
    if (typeof r.reason === "string") rec.reason = r.reason;
    if (typeof r.detail === "string") rec.detail = r.detail;
    return rec;
}

/** Highest allocated mNNNNN number in the session's ref map (0 when empty).
 *  Mirrors stream.ts' private highestMappedRef — kept local as a tiny pure
 *  helper rather than widening stream.ts' export surface for one number. */
function highestMappedIndex(state: Pick<Session["state"], "messageRefs">): number {
    let highest = 0;
    for (const ref of Object.keys(state.messageRefs?.byRef ?? {})) {
        const m = BYREF_KEY_RE.exec(ref);
        if (m) highest = Math.max(highest, Number(m[1]));
    }
    return highest;
}

const indexToRef = (i: number): string => `m${String(i).padStart(5, "0")}`;

/**
 * One-shot generation-boundary detection (#4305). Scans the visible core
 * history for message-ref citations strictly above this session's highest
 * mapped ref and records the verdict in persisted session metadata when ≥2
 * distinct such citations exist. Returns true when the standing note should
 * ride THIS request (already detected, or freshly detected now).
 */
export function detectGenerationBoundary(
    session: Session,
    messages: readonly CoreMessage[],
    log?: (level: string, msg: string) => void,
): boolean {
    if (readGenerationBoundary(session)) return true;
    if (messages.length === 0) return false;
    const frontier = highestMappedIndex(session.state);
    const stale = new Set<number>();
    let found = false;
    for (const m of messages) {
        const text = m.text;
        if (!text) continue;
        REF_CITATION_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = REF_CITATION_RE.exec(text)) !== null) {
            const n = Number(match[1]);
            if (n > frontier) {
                stale.add(n);
                if (stale.size >= MIN_DISTINCT_STALE_REFS) { found = true; break; }
            }
        }
        if (found) break;
    }
    if (!found) return false;
    let maxStale = 0;
    for (const n of stale) maxStale = Math.max(maxStale, n);
    const record: GenerationBoundaryRecord = {
        at: Date.now(),
        frontier: frontier > 0 ? indexToRef(frontier) : "",
        maxStaleRef: indexToRef(maxStale),
    };
    (session.metadata ?? (session.metadata = {}))[STORAGE_KEY] = record;
    markDirty(session);
    log?.("info", `[${session.id}] [acp-gen-boundary] ${stale.size} distinct ref citation(s) above this session's frontier (${record.frontier || "no mapped refs yet"}) found in visible history — previous-generation residue confirmed; standing generation-boundary note active (highest stale ${record.maxStaleRef}) (#4305)`);
    return true;
}

/** #5542: witness a ref-ledger generation reset AT THE MOMENT IT HAPPENS. The
 *  two host-side split points call this (a persona fork onto a suffixed session
 *  key, and the native-compaction rebase) so the standing note rides from the
 *  FIRST turn of the new generation instead of waiting for residue detection —
 *  which never fires when the reset discarded the citing text too. First-wins:
 *  an already-recorded boundary (witnessed or detected) is never overwritten.
 *  Returns true when the record was seeded by this call. */
export function witnessGenerationReset(
    session: Session,
    witness: { reason: string; detail?: string; frontier: number },
    log?: (level: string, msg: string) => void,
): boolean {
    if (readGenerationBoundary(session)) return false;
    const record: GenerationBoundaryRecord = {
        at: Date.now(),
        frontier: witness.frontier > 0 ? indexToRef(witness.frontier) : "",
        reason: witness.reason,
    };
    if (witness.detail) record.detail = witness.detail;
    (session.metadata ?? (session.metadata = {}))[STORAGE_KEY] = record;
    markDirty(session);
    log?.("info", `[${session.id}] [acp-gen-reset] ref-ledger generation reset witnessed (${witness.reason}${witness.detail ? ` — ${witness.detail}` : ""}; previous-generation frontier ${record.frontier || "unknown"}) — refs minted before this session's ledger are inert here; standing generation-boundary note active from this turn (#5542)`);
    return true;
}

/** #5542: persona-fork variant of the witness, called from the conversation-
 *  resolution seam where a request lands on a FRESH suffixed-key session while
 *  its conversation id already owns a session. Witnesses only when there is a
 *  previous generation to lose: the forked session is still empty AND the raw
 *  session has minted refs (a fork born before any main turn — #2156 title-gen
 *  sidecar — has none). Returns true when the record was seeded. */
export function witnessForkedGeneration(
    session: Session,
    rawSessionId: string,
    conversationKey: string,
    log?: (level: string, msg: string) => void,
): boolean {
    if (session.state.blocks.length > 0 || highestMappedIndex(session.state) > 0) return false;
    const rawSess = peekSession(rawSessionId) ?? getStore().loadSync(rawSessionId) ?? undefined;
    const rawFrontier = rawSess ? highestMappedIndex(rawSess.state) : 0;
    if (rawFrontier <= 0) return false;
    return witnessGenerationReset(session, {
        reason: "persona-fork",
        detail: `conversation ${rawSessionId} forked onto ${conversationKey}`,
        frontier: rawFrontier,
    }, log);
}

/** Standing model-visible note, appended to the ACP standing system block once
 *  detected OR witnessed. Static by design (see module header) — it must never
 *  embed moving values or the prefix cache breaks every allocation. */
export const GENERATION_BOUNDARY_NOTE = "Generation boundary: this conversation's message-ref ledger was reset mid-conversation (a model or upstream switch restarted refs at m00001). Refs quoted earlier in your visible history — tool results, summaries, your own earlier replies — may belong to the previous generation: some are permanently inert (compress/decompress targeting them always fails), and any number that happens to exist in the current ledger now points at a DIFFERENT message than before. Before calling compress, verify every ref you plan to target against the current acp_status report; do not trust refs quoted in older tool results or summaries. If your last instruction before this boundary involved EXECUTING steps (writing files, running commands, pushing, syncing, deploying), treat any earlier 'done'/'completed' report as UNVERIFIED — the execution tail may have been lost across the boundary while its planning and reporting survived in summaries. Check the real state (disk, git, remotes) before claiming completion.";
