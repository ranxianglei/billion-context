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
// Deliberately display-only: no storage rewrite, no ref-space surgery, no gate
// changes. The text carries no numbers: the frontier advances as the session
// allocates, and a fixed ceiling would go stale within turns. Concrete ceilings
// stay with the reactive notes (beyondFrontierNote / frontierClampNote), which
// fire on the actual failure and always quote the live value.

import { markDirty, type Session } from "./session.js";
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
    /** First-detection time (ms epoch). */
    at: number;
    /** This session's highest mapped ref at detection ("mNNNNN" or "" when none) — evidence anchor, log surface only. */
    frontier: string;
    /** Highest stale citation seen at detection — log surface only. */
    maxStaleRef: string;
}

export function readGenerationBoundary(session: Session): GenerationBoundaryRecord | undefined {
    const raw = session.metadata?.[STORAGE_KEY];
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r.at !== "number" || typeof r.frontier !== "string" || typeof r.maxStaleRef !== "string") return undefined;
    return { at: r.at, frontier: r.frontier, maxStaleRef: r.maxStaleRef };
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

/** Standing model-visible note, appended to the ACP standing system block once
 *  detected. Static by design (see module header) — it must never embed moving
 *  values or the prefix cache breaks every allocation. */
export const GENERATION_BOUNDARY_NOTE = "Generation boundary: this conversation's message-ref ledger was reset mid-conversation (a model or upstream switch restarted refs at m00001). Refs quoted earlier in your visible history — tool results, summaries, your own earlier replies — may belong to the previous generation: some are permanently inert (compress/decompress targeting them always fails), and any number that happens to exist in the current ledger now points at a DIFFERENT message than before. Before calling compress, verify every ref you plan to target against the current acp_status report; do not trust refs quoted in older tool results or summaries.";
