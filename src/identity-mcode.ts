// #5825 identity-channel wiring — mcode (MiniMax Code) harvest source.
//
// The session half is already live on the wire: mcode stamps X-Mavis-Session-Id
// on every model request (BYOK/custom-provider path included) and bili already
// recognizes it (#1050). Session ids are minted `mvs_${uuid-no-dashes}` and the
// client documents cross-turn/restart stability. This module adds the message
// half from the local runtime store:
//   ~/.minimax/v2/sqlite/runtime-state.sqlite  (or $MINIMAX_DATA_DIR/v2/...)
//   table local_runtime_message_rows:
//     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
//     msg_id TEXT NOT NULL, role TEXT, turn_id TEXT, ...
//     UNIQUE(session_id, msg_id)
// msg_id is an explicit stable id or a deterministic content hash
// (`msg-<ts>-<sha256[:20]>`) minted once at write time — never reused, so the
// whole-turn-degrade discipline applies exactly like the JSONL sources.
// Bulk-replace paths exist in the client (clear / legacy import / replace-batch
// / rewind pre-delete), so the snapshot is re-taken EVERY turn (this module is
// stateless by design — nothing is cached across turns).
//
// Role spot-check: wire roles (user/assistant/tool/...) are compared only where
// the stored row exposes a role; normalization differences beyond case would
// degrade the turn rather than guess.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alignTailIds, headerFirst, registerIdentitySource, type IdentityHarvestCtx } from "./identity-harvest.js";
import { openSqliteDatabase } from "./storage/driver.js";

const MCODE_SESSION_RE = /^mvs_[0-9a-f]{32}$/i;

function dbCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
    const out: string[] = [];
    for (const base of [env.MINIMAX_DATA_DIR, path.join(os.homedir(), ".minimax")]) {
        if (typeof base !== "string" || base.trim().length === 0) continue;
        out.push(path.join(base.trim(), "v2", "sqlite", "runtime-state.sqlite"));
    }
    return out;
}

export function registerMcodeIdentitySource(): void {
    registerIdentitySource({
        id: "mcode",
        matches(ctx: IdentityHarvestCtx): boolean {
            const h = headerFirst(ctx, "x-mavis-session-id");
            return !!h && MCODE_SESSION_RE.test(h) && h.toLowerCase() === ctx.sessionId.toLowerCase();
        },
        snapshot(ctx: IdentityHarvestCtx): string[] | null {
            for (const file of dbCandidates()) {
                let exists: boolean;
                try {
                    exists = fs.existsSync(file);
                } catch {
                    continue;
                }
                if (!exists) continue;
                let opened;
                try {
                    opened = openSqliteDatabase(file);
                } catch {
                    return null; // engine unavailable or file locked → degrade
                }
                try {
                    const rows = opened.db
                        .prepare("SELECT msg_id AS id, role FROM local_runtime_message_rows WHERE session_id = ? ORDER BY id")
                        .all(ctx.sessionId) as Array<{ id?: unknown; role?: unknown }>;
                    const vis = rows
                        .filter((r) => typeof r.id === "string" && r.id.length > 0)
                        .map((r) => ({ id: String(r.id), role: typeof r.role === "string" ? r.role : undefined }));
                    return alignTailIds(ctx, vis);
                } finally {
                    try {
                        opened.db.close();
                    } catch { /* closing a read probe — best effort */ }
                }
            }
            return null;
        },
    });
}
