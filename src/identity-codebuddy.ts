// #5825 identity-channel wiring — codebuddy harvest source.
//
// Measured on 2.181.0 (three-process fresh/-c/-r runs): X-Conversation-ID is
// the persisted conversation object id, stable across restarts; per-message
// wire ids do NOT exist, but the local transcript does:
//   $CODEBUDDY_CONFIG_DIR/projects/<escaped-cwd>/<conversation-id>.jsonl
// (filename == conversation id), append-only; every message entry carries a
// stable UUID `id` + a `parentId` chain + providerData{conversationRequestId,
// messageId}. The three layers cross-validate (wire turn header == providerData
// of the entry). /compact rewrites history but keeps entry ids — same degrade-
 // on-count-mismatch discipline applies.
//
// Role mapping is deliberately loose here (the exact entry schema varies by
// build): an entry counts when it carries a string id AND a string parentId;
// if BOTH sides expose a role at a boundary position it must agree — otherwise
// the position is simply not checked. The strict canonical msgid validation in
// the registry is the final gate either way.
//
// Turn-level X-Conversation-Request-ID stays UNCONSUMED (owner decision A in
// #5825 comments: new human-gated semantics, not this PR).
//
// WorkBuddy Desktop (#7456, wb 5.11.4 decompiled): the app embeds a CodeBuddy
// CLI fork that reuses this exact persistence code path (getHomeProjectsDir +
// compressPath(canonicalizeStorePath(cwd)) + `${conversationId}.jsonl`), with
// the config root at $WORKBUDDY_CONFIG_DIR / ~/.workbuddy instead of
// $CODEBUDDY_CONFIG_DIR / ~/.codebuddy — so the same X-Conversation-ID header
// (measured on WorkBuddy traffic per #5488/#5526) resolves to the same layout
// under the workbuddy config dirs added to configDirs() below. A conversation
// id present under BOTH config roots yields two files and the snapshot
// degrades to null (no ids) — conservative by construction.

import os from "node:os";
import path from "node:path";
import { alignTailIds, findProjectJsonlFiles, headerFirst, readJsonlTail, registerIdentitySource, type IdentityHarvestCtx } from "./identity-harvest.js";

function configDirs(env: NodeJS.ProcessEnv = process.env): string[] {
    const dirs: string[] = [];
    // CodeBuddy CLI + its WorkBuddy Desktop fork (#7456): same header, same
    // transcript layout, two config roots.
    for (const v of [env.CODEBUDDY_CONFIG_DIR, path.join(os.homedir(), ".codebuddy"), env.WORKBUDDY_CONFIG_DIR, path.join(os.homedir(), ".workbuddy")]) {
        if (typeof v !== "string" || v.trim().length === 0) continue;
        const r = v.trim();
        if (!dirs.includes(r)) dirs.push(r);
    }
    return dirs;
}

export function codebuddyVisibleRows(lines: readonly string[]): Array<{ id: string; role?: string }> {
    const out: Array<{ id: string; role?: string }> = [];
    for (const line of lines) {
        let obj: unknown;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }
        const o = obj as { id?: unknown; parentId?: unknown; role?: unknown } | null;
        if (typeof o?.id !== "string") continue;
        if (typeof o.parentId !== "string") continue;
        const r = typeof o.role === "string" ? o.role : undefined;
        if (r === "system" || r === "developer") continue;
        out.push({ id: o.id, role: r });
    }
    return out;
}


export function registerCodebuddyIdentitySource(): void {
    registerIdentitySource({
        id: "codebuddy",
        matches(ctx: IdentityHarvestCtx): boolean {
            const h = headerFirst(ctx, "x-conversation-id");
            return !!h && h.length > 0 && h.length <= 512 && h.toLowerCase() === ctx.sessionId.toLowerCase();
        },
        snapshot(ctx: IdentityHarvestCtx): string[] | null {
            const files = findProjectJsonlFiles(configDirs(), ctx.sessionId);
            if (files.length !== 1) return null;
            return alignTailIds(ctx, codebuddyVisibleRows(readJsonlTail(files[0])));
        },
    });
}
