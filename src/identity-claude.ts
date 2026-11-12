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
// in order. We require exact count parity on the TAIL plus a role spot-check
// over up to 4 boundary positions when both sides expose roles. A failed check
// degrades the whole turn (null) — uuids never being reused makes misbinding
// impossible; a miss only costs this turn's pinning.
//
// Loopback + trust boundaries are enforced by the registry (identity-harvest);
// the join key is x-claude-code-session-id (already recognized by session-id).

import os from "node:os";
import path from "node:path";
import { alignTailIds, findProjectJsonlFiles, headerFirst, readJsonlTail, registerIdentitySource, type IdentityHarvestCtx } from "./identity-harvest.js";

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
 *  parallel (uuid, role) tails; summary/system/queue/sidechain rows skipped. */
export function claudeVisibleRows(lines: readonly string[]): Array<{ id: string; role: string }> {
    const out: Array<{ id: string; role: string }> = [];
    for (const line of lines) {
        let obj: unknown;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }
        const o = obj as { uuid?: unknown; isSidechain?: unknown; type?: unknown; message?: { role?: unknown } | undefined } | null;
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
        out.push({ id: o.uuid, role });
    }
    return out;
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
            return alignTailIds(ctx, claudeVisibleRows(readJsonlTail(files[0])));
        },
    });
}
