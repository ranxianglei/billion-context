// #1085: sticky head-system anchor — best-effort wire-layer fallback for
// upstream prefix caching (owner-scoped 2026-09-21: proxy-side stopgap only;
// the root fix belongs client-side, cf. anomalyco/opencode). Clients embed
// ambient instructions (AGENTS.md & co.) in the HEAD of every request; when
// those files change mid-session the head bytes change and the provider's
// prefix cache misses the ENTIRE conversation. When enabled (server.ts gates
// this to plain-proxy mode only), the first-seen head text becomes a sticky
// per-session anchor forwarded byte-stable; each LOCALIZED change appends one
// trailing user note carrying a compact line diff against the version in
// effect so far (each note composes sequentially onto the previous one).
// Non-localized changes (structural reshuffle, tool-def churn, timestamped
// banners) are NOT annotated — they adopt the new head outright: one
// deliberate cache miss beats appending noise (diffs of unrelated content
// would mislead the model about what its instructions now say). Notes are
// wire-ephemeral like the nudge (#451): re-injected from session state every
// turn, never part of the kernel fold space, so they survive restarts and
// compaction without consuming message refs. Past ANCHOR_MAX_NOTES localized
// changes the anchor is likewise replaced outright (opencode's Replace parity).

import type { Session } from "./session.js";

type SystemSurface = "anthropic" | "openai" | "google" | "responses";

interface SurfaceState {
    anchor: string;
    lastSeen: string;
    notes: string[];
}

interface AnchorOutcome {
    outbound: string;
    notes: string[];
    changed: boolean;
}

/** Volatile-head guard: beyond this many logged changes the head content is
 *  live state by nature (a client baking runtime data into its system prompt)
 *  and anchoring costs more than it saves. */
export const ANCHOR_MAX_NOTES = 8;

/** Localized-edit eligibility: at least this fraction of lines (in order)
 *  must be shared between the previous and the new head for the change to be
 *  treated as a file-content edit worth annotating. Below it, the change is
 *  structural and gets the deliberate-miss treatment instead. */
const DIFF_MIN_SHARED = 0.7;

/** Above this many lines on either side we do not even compute a diff —
 *  huge heads are presumed structural. Keeps the O(n·m) LCS bounded. */
export const DIFF_MAX_LINES = 400;

const DIFF_CONTEXT = 2;

export const UPDATE_MARKER = "[System context update]";
const REMOVED_NOTE = `${UPDATE_MARKER} Previously loaded ambient instructions no longer apply.`;
const DIFF_HEADER = `${UPDATE_MARKER} The ambient instructions in the system prompt changed during this conversation. Each block below shows one changed region against the version in effect so far (- removed / + added); everything not shown is unchanged:\n\n`;

function key(surface: SystemSurface): string {
    return `stableSystem.${surface}`;
}

function readState(metadata: Record<string, unknown>, surface: SystemSurface): SurfaceState {
    const raw = metadata[key(surface)];
    if (typeof raw === "object" && raw !== null) {
        const r = raw as Record<string, unknown>;
        if (typeof r.anchor === "string" && typeof r.lastSeen === "string" && Array.isArray(r.notes)) {
            return {
                anchor: r.anchor,
                lastSeen: r.lastSeen,
                notes: r.notes.filter((n): n is string => typeof n === "string"),
            };
        }
    }
    return { anchor: "", lastSeen: "", notes: [] };
}

function writeState(session: Session, surface: SystemSurface, state: SurfaceState): void {
    session.metadata[key(surface)] = state;
}

type Op = { t: 0 | 1 | 2; i: number }; // 0 keep, 1 del(old), 2 ins(new)

/** Line-diff via LCS. Returns formatted hunk blocks (context lines prefixed
 *  with two spaces, deletions "-", additions "+") or null when the change is
 *  not a localized edit (too large to diff, or shared-line ratio below
 *  DIFF_MIN_SHARED). Deterministic; no dependencies. */
export function diffLines(oldText: string, newText: string): string[] | null {
    const a = oldText.split("\n");
    const b = newText.split("\n");
    const n = a.length;
    const m = b.length;
    if (n > DIFF_MAX_LINES || m > DIFF_MAX_LINES) return null;
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
    }
    if (dp[0] / Math.max(n, m) < DIFF_MIN_SHARED) return null;
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ t: 0, i });
            i++;
            j++;
        } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
            ops.push({ t: 1, i });
            i++;
        } else {
            ops.push({ t: 2, i: j });
            j++;
        }
    }
    while (i < n) { ops.push({ t: 1, i }); i++; }
    while (j < m) { ops.push({ t: 2, i: j }); j++; }
    // Collect maximal change runs, extend each by DIFF_CONTEXT keep-lines,
    // merge overlapping/touching regions, render.
    const starts: Array<[number, number]> = [];
    let k = 0;
    while (k < ops.length) {
        if (ops[k].t !== 0) {
            let e = k;
            while (e < ops.length && ops[e].t !== 0) e++;
            starts.push([Math.max(0, k - DIFF_CONTEXT), Math.min(ops.length - 1, e + DIFF_CONTEXT)]);
            k = e;
        } else k++;
    }
    const merged: Array<[number, number]> = [];
    for (const s of starts) {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
        else merged.push([...s] as [number, number]);
    }
    const out: string[] = [];
    for (const [lo, hi] of merged) {
        const block: string[] = [];
        for (let q = lo; q <= hi; q++) {
            const op = ops[q];
            if (op.t === 0) block.push(`  ${a[op.i]}`);
            else if (op.t === 1) block.push(`-${a[op.i]}`);
            else block.push(`+${b[op.i]}`);
        }
        out.push(block.join("\n"));
    }
    return out;
}

function formatNote(prev: string, incoming: string): string {
    if (incoming === "") return REMOVED_NOTE;
    const hunks = diffLines(prev, incoming)!;
    return `${DIFF_HEADER}${hunks.join("\n\n")}`;
}

/** Strict byte comparison — no normalization: prefix caching is a byte game,
 *  normalizing would desync what we forward from what we recorded. Empty heads
 *  are skipped, never anchored. A removed head keeps flowing as the anchor
 *  (stale-but-labeled beats a broken cache); consecutive repeats are no-ops.
 * State persists under session.metadata[`stableSystem.<surface>`]. */
export function reconcileSystemAnchor(
    session: Session,
    surface: SystemSurface,
    incoming: string,
    sessionId: string,
    log: (level: string, msg: string) => void,
): AnchorOutcome {
    const st = readState(session.metadata, surface);
    if (st.anchor === "" && st.lastSeen === "" && st.notes.length === 0) {
        if (incoming === "") return { outbound: "", notes: [], changed: false };
        writeState(session, surface, { anchor: incoming, lastSeen: incoming, notes: [] });
        log("info", `[${sessionId}] stable-system-anchor[${surface}] captured ${incoming.length} chars`);
        return { outbound: incoming, notes: [], changed: false };
    }
    if (incoming === st.lastSeen) {
        return { outbound: st.anchor, notes: st.notes, changed: false };
    }
    // Removal counts as localized: it keeps the anchor flowing with a
    // removal note (see docstring above) instead of breaking the cache.
    const localized = incoming === "" || diffLines(st.lastSeen, incoming) !== null;
    if (!localized) {
        writeState(session, surface, { anchor: incoming, lastSeen: incoming, notes: [] });
        log("warn", `[${sessionId}] stable-system-anchor[${surface}] non-localized head change (structural reshuffle or oversized) — replacing anchor outright, one deliberate cache miss`);
        return { outbound: incoming, notes: [], changed: true };
    }
    const notes = [...st.notes, formatNote(st.lastSeen, incoming)];
    if (notes.length > ANCHOR_MAX_NOTES) {
        writeState(session, surface, { anchor: incoming, lastSeen: incoming, notes: [] });
        log("warn", `[${sessionId}] stable-system-anchor[${surface}] churn guard tripped (${st.notes.length + 1} change(s) > ${ANCHOR_MAX_NOTES}) — replacing anchor outright, one deliberate cache miss`);
        return { outbound: incoming, notes: [], changed: true };
    }
    writeState(session, surface, { ...st, lastSeen: incoming, notes });
    log("info", `[${sessionId}] stable-system-anchor[${surface}] localized head-system change — forwarding ${st.anchor.length}-char anchor, appending diff note (${notes.length} total)`);
    return { outbound: st.anchor, notes, changed: true };
}
