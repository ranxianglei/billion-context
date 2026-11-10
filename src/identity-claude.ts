// #5825 identity-channel wiring — claude-code harvest source.
//
// claude-code mints a v4 UUID per transcript entry at creation (never reused;
// forkSession copies rows keeping uuids + adds forkedFrom — already consumed by
// src/claude-transcript-lineage.ts / #1486). The transcript is append-only
// JSONL at `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<encoded-cwd>/<sessionId>.jsonl`;
// resume re-reads the same file, rewind truncates only the pending queue,
// /compact appends a type:"summary" row WITHOUT touching original rows ⇒ the
// visible user/assistant rows are a stable identity space for the whole session.
//
// Alignment contract (whole-turn or nothing): the outbound request is a full
// resend, so its message tail MUST equal the transcript's last N visible rows
// in order. We require exact count parity on the TAIL plus a FULL role-sequence
// check over every position where both sides expose a role. A failed check
// degrades the whole turn (null) — uuids never being reused makes cross-session
// misbinding impossible; a miss only costs this turn's pinning.
//
// #6011 sidechain attribution: Task subagents write their OWN threads into the
// SAME session file (isSidechain rows, interleaved between parallel runs), and
// every run resends a history whose tail is role-pattern-identical to the MAIN
// conversation's tail (user/assistant alternation) — a role-only alignment
// would bind a subagent request to the main conversation's tail ids (or vice
// versa), and the resolver's raw-lane rescue would then RE-ANCHOR one
// conversation onto the other's lane. Once sidechain rows exist in the file,
// BOTH directions therefore demand content verification: the request's
// per-message fingerprints (ctx.messageFingerprints) must equal the candidate
// thread's tail text fingerprints at EVERY position. Outcomes:
//   - exactly one candidate verifies (a sidechain thread, or the main tail) → bind;
//   - none verifies, several shape-match, or main+thread both verify → null
//     (never guess — a miss costs pinning, a wrong bind corrupts a lane);
//   - no fingerprints supplied by the caller → null (attribution impossible).
// Files with NO sidechain rows stay on the exact legacy main pass (single-
// thread world — no misbinding partner exists there).
//
// Loopback + trust boundaries are enforced by the registry (identity-harvest);
// the join key is x-claude-code-session-id (already recognized by session-id).

import os from "node:os";
import path from "node:path";
import { alignTailIds, findProjectJsonlFiles, fingerprintText, headerFirst, plainTextOfContent, readJsonlTail, registerIdentitySource, rolesAlign, type IdentityHarvestCtx } from "./identity-harvest.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    const dirs: string[] = [];
    for (const v of [env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude")]) {
        if (typeof v !== "string" || v.trim().length === 0) continue;
        const r = v.trim();
        if (!dirs.includes(r)) dirs.push(r);
    }
    return dirs;
}

/** Visible-row projection: non-sidechain user/assistant entries only. Returns
 *  parallel (uuid, role, text) tails; summary/system/queue/sidechain rows
 *  skipped. `text` (#6011) carries the comparable plain-text projection for
 *  content verification; pre-#6011 consumers read only id/role. */
export function claudeVisibleRows(lines: readonly string[]): ClaudeVisibleRow[] {
    const out: ClaudeVisibleRow[] = [];
    for (const line of lines) {
        let obj: unknown;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }
        const o = obj as { uuid?: unknown; isSidechain?: unknown; type?: unknown; message?: { role?: unknown; content?: unknown } | undefined } | null;
        if (typeof o?.uuid !== "string") continue;
        if (o.isSidechain === true) continue;
        const t = typeof o.type === "string" ? o.type : undefined;
        const role = typeof o.message?.role === "string" ? o.message.role : undefined;
        if (role !== "user" && role !== "assistant") continue;
        // A typed summary/system/queue row carrying a message.role would also
        // be excluded here only when it lacks user/assistant typing — keep the
        // strict rule: typed rows must say user/assistant, untyped rows ride
        // their message.role alone.
        if (t !== undefined && t !== role) continue;
        out.push({ id: o.uuid, role, text: plainTextOfContent(o.message?.content) });
    }
    return out;
}

/** #6011: sidechain-row projection — the Task-subagent threads interleaved in
 *  the same session file. `parentUuid` links a row to its predecessor inside
 *  its own thread (the dispatch's main-conversation row anchors the first
 *  sidechain row); `text` is the comparable plain-text projection. Rows
 *  without a usable user/assistant role are skipped, mirroring the visible
 *  projection's strict typing rule. */
interface ClaudeSidechainRow {
    id: string;
    parentUuid?: string;
    role: string;
    text: string;
}

export function claudeSidechainRows(lines: readonly string[]): ClaudeSidechainRow[] {
    const out: ClaudeSidechainRow[] = [];
    for (const line of lines) {
        let obj: unknown;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }
        const o = obj as { uuid?: unknown; isSidechain?: unknown; type?: unknown; parentUuid?: unknown; message?: { role?: unknown; content?: unknown } | undefined } | null;
        if (typeof o?.uuid !== "string") continue;
        if (o.isSidechain !== true) continue;
        const t = typeof o.type === "string" ? o.type : undefined;
        const role = typeof o.message?.role === "string" ? o.message.role : undefined;
        if (role !== "user" && role !== "assistant") continue;
        if (t !== undefined && t !== role) continue;
        out.push({
            id: o.uuid,
            parentUuid: typeof o.parentUuid === "string" ? o.parentUuid : undefined,
            role,
            text: plainTextOfContent(o.message?.content),
        });
    }
    return out;
}

/** #6011: group sidechain rows into per-thread chains by walking parentUuid
 *  links backwards from each TAIL row (a row no later row references).
 *  Parallel runs interleave in file order, so contiguity is NOT a thread
 *  boundary — only the link structure is. Returns [] when no row carries a
 *  parentUuid at all (older clients: no chain evidence — the caller degrades
 *  attribution instead of guessing). Chains may share ancestors (forks);
 *  each tail yields its own maximal available segment, which is all
 *  tail-alignment ever consumes. */
export function sidechainChains(rows: readonly ClaudeSidechainRow[]): ClaudeSidechainRow[][] {
    if (rows.length === 0) return [];
    const byId = new Map<string, ClaudeSidechainRow>();
    for (const r of rows) {
        if (!byId.has(r.id)) byId.set(r.id, r);
    }
    const referenced = new Set<string>();
    let structured = false;
    for (const r of rows) {
        if (r.parentUuid === undefined) continue;
        structured = true;
        referenced.add(r.parentUuid);
    }
    if (!structured) return [];
    const chains: ClaudeSidechainRow[][] = [];
    for (const r of rows) {
        if (referenced.has(r.id)) continue; // not a tail — some later row continues it
        const chain: ClaudeSidechainRow[] = [r];
        let cur = r;
        while (cur.parentUuid !== undefined && byId.has(cur.parentUuid)) {
            cur = byId.get(cur.parentUuid)!;
            chain.push(cur);
        }
        chain.reverse();
        chains.push(chain);
    }
    return chains;
}

/** #6011: does the candidate tail's text fingerprint sequence equal the
 *  request's fingerprints at EVERY position? Strict full-tail equality — a
 *  single drifted message degrades the turn instead of risking a wrong bind. */
function tailFpsEqual(tail: readonly ClaudeSidechainRow[], fps: readonly string[]): boolean {
    return tail.every((r, i) => fingerprintText(r.text) === fps[i]);
}

type ClaudeVisibleRow = { id: string; role: string; text: string };

function tailFpsEqualVisible(tail: readonly ClaudeVisibleRow[], fps: readonly string[]): boolean {
    return tail.every((r, i) => fingerprintText(r.text) === fps[i]);
}

/** #6011: attribute the request in a file that CONTAINS sidechain threads —
 *  the world where role-only alignment can misbind in either direction.
 *  See the module header for the outcome matrix. */
function attributeSidechainWorld(ctx: IdentityHarvestCtx, visible: ClaudeVisibleRow[], scRows: ClaudeSidechainRow[]): string[] | null {
    const fps = ctx.messageFingerprints;
    if (fps === undefined || fps.length !== ctx.expectedLen) return null; // no content evidence → never guess
    const mainTailOk = visible.length >= ctx.expectedLen
        && (() => {
            const tail = visible.slice(-ctx.expectedLen);
            return rolesAlign(ctx, tail) && tailFpsEqualVisible(tail, fps);
        })();
    const candidates = sidechainChains(scRows)
        .filter((c) => c.length >= ctx.expectedLen && rolesAlign(ctx, c.slice(-ctx.expectedLen)))
        .filter((c) => tailFpsEqual(c.slice(-ctx.expectedLen), fps));
    if (candidates.length === 1 && !mainTailOk) {
        // The one verified thread owns this request. Continuity state is kept
        // PER THREAD (composite key anchored on the chain head — stable across
        // rounds while the bounded tail-read covers the head; a truncated head
        // merely skips one check and re-arms) and fed the FULL chain so the
        // shared-store-index overlap math stays exact.
        const anchor = candidates[0][0].id;
        return alignTailIds(
            { ...ctx, sessionId: `${ctx.sessionId}|sc:${anchor}` },
            candidates[0].map((r) => ({ id: r.id, role: r.role })),
        );
    }
    if (candidates.length === 0 && mainTailOk) {
        // Verified to be the MAIN conversation — the legacy main pass, whose
        // raw-key continuity state is untouched.
        return alignTailIds(ctx, visible);
    }
    // Ambiguous (several shape-matching threads), unverified (content drifted),
    // or conflicting (both main and a thread verify — disjoint tails cannot
    // both equal the request): degrade the whole turn. Never fall through to
    // the role-only main pass here — that is the misbinding path.
    return null;
}

export function registerClaudeIdentitySource(): void {
    registerIdentitySource({
        id: "claude",
        matches(ctx: IdentityHarvestCtx): boolean {
            const h = headerFirst(ctx, "x-claude-code-session-id");
            return !!h && UUID_RE.test(h) && h.toLowerCase() === ctx.sessionId.toLowerCase();
        },
        snapshot(ctx: IdentityHarvestCtx): string[] | null {
            const files = findProjectJsonlFiles(configDirs(), ctx.sessionId);
            // Ambiguity (same id under two project dirs) is treated as "none",
            // mirroring the lineage reader: no guessing between stores.
            if (files.length !== 1) return null;
            const lines = readJsonlTail(files[0]);
            const visible = claudeVisibleRows(lines);
            const scRows = claudeSidechainRows(lines);
            if (scRows.length === 0) {
                // Single-thread world: the exact legacy main pass (its
                // role-only check has no misbinding partner to confuse with).
                return alignTailIds(ctx, visible);
            }
            return attributeSidechainWorld(ctx, visible, scRows);
        },
    });
}
