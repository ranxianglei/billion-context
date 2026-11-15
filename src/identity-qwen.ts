// #5825 identity-channel wiring — qwen-code harvest source (opt-in join key).
//
// qwen-code keeps a claude-style git-log transcript at
// $QWEN_HOME/projects/<sanitized-cwd>/chats/<sessionId>.jsonl (default root
// ~/.qwen; the older tmp/ path in doc comments is stale — code wins). Records
// carry a stable per-message `uuid` (randomUUID), `sessionId`, `type`
// (user | assistant | tool_result | system) and `isSidechain`; compaction is
// an inserted system/chat_compression checkpoint that re-parents the tail
// (original text is kept), rewind appends subtype:"rewind" records without
// deleting rows, subagent transcripts are separate files. All of those cases
// either fail the exact tail-parity check or the role spot-check below and
// degrade whole-turn — a miss can only ever cost pinning, never misbind.
//
// JOIN IS OPT-IN ON THE USER'S SIDE: the automatic correlation headers only
// fire for alibaba routify endpoints; BYOK/custom-provider users opt in with
// a customHeaders entry whose value embeds ${session_id} — the official docs
// example is literally `"x-opencode-session": "${session_id}"`, a name bili
// already recognizes, which is what matches() pins below. Users who choose a
// different custom name degrade (no harvest) until that name joins the
// recognition tier. No client patch needed on the common path.

import os from "node:os";
import path from "node:path";
import { alignTailIds, findProjectJsonlFiles, headerFirst, readJsonlTail, registerIdentitySource, type IdentityHarvestCtx } from "./identity-harvest.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function qwenVisibleRows(lines: string[]): Array<{ id: string; role?: string }> {
    const out: Array<{ id: string; role?: string }> = [];
    for (const line of lines) {
        let r: unknown;
        try {
            r = JSON.parse(line);
        } catch {
            continue; // torn trailing line already dropped upstream; corrupt interior line → skip
        }
        if (!r || typeof r !== "object") continue;
        const o = r as Record<string, unknown>;
        if (o.isSidechain === true) continue;
        if (typeof o.uuid !== "string" || !UUID_RE.test(o.uuid)) continue;
        if (o.type !== "user" && o.type !== "assistant") continue;
        out.push({ id: o.uuid, role: o.type });
    }
    return out;
}

export function registerQwenIdentitySource(): void {
    registerIdentitySource({
        id: "qwen",
        matches(ctx: IdentityHarvestCtx): boolean {
            // The documented ${session_id} customHeader example is x-opencode-session —
            // require exact equality so an unrelated opencode session value never joins.
            const h = headerFirst(ctx, "x-opencode-session");
            return !!h && h === ctx.sessionId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(ctx.sessionId);
        },
        snapshot(ctx: IdentityHarvestCtx): string[] | null {
            const roots = [process.env.QWEN_HOME?.trim() || "", path.join(os.homedir(), ".qwen")].filter(Boolean);
            const files = findProjectJsonlFiles(roots, ctx.sessionId, "chats");
            if (files.length !== 1) return null; // absent OR ambiguous → none, like the lineage reader
            return alignTailIds(ctx, qwenVisibleRows(readJsonlTail(files[0])));
        },
    });
}
