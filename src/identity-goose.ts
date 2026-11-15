// #5825 identity-channel wiring — goose harvest source.
//
// goose stamps `agent-session-id` on EVERY model request with its sqlite
// sessions.id (const SESSION_ID_HEADER, crates/goose/src/session_context.rs:6;
// request decorator scoped to the OpenAI-compatible client that also serves
// the OPENAI_BASE_URL/BYOK path — provider/openai_def.rs:122). The value is
// `YYYYMMDD_<n>` by default minting and is stable across restarts; a
// user-configurable header-override name (session_id_header_override) exists,
// so an overridden install simply misses this lane and degrades — never a
// wrong join.
//
// Store: sessions.db under $GOOSE_PATH_ROOT/data | $XDG_DATA_HOME/goose |
// ~/.local/share/goose (macOS: ~/Library/Application Support/Block/goose).
// Rows: messages(id INTEGER PK AUTOINCREMENT, message_id TEXT = msg_<uuidv4>
// minted once per message, session_id FK, role, created_timestamp) read
// ORDER BY created_timestamp, id. message ids are never reused. Compaction
// does NOT tombstone message rows (it is accounted in usage_ledger), so a
// post-compaction turn whose wire prefix diverges from the stored tail fails
// parity and degrades whole-turn — self-healing on the next fresh tail,
// and a miss can only ever cost pinning, never misbind. Subagent turns live
// in child session rows (sessions.parent_session_id), already excluded by
// the session_id scoping below.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alignTailIds, headerFirst, registerIdentitySource, type IdentityHarvestCtx } from "./identity-harvest.js";
import { openSqliteDatabase } from "./storage/driver.js";

function dbCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
    const out: string[] = [];
    const push = (p: string | undefined): void => {
        if (typeof p !== "string" || p.trim().length === 0) return;
        const r = p.trim();
        if (!out.includes(r)) out.push(r);
    };
    if (env.GOOSE_PATH_ROOT?.trim()) push(path.join(env.GOOSE_PATH_ROOT.trim(), "data", "sessions.db"));
    if (env.XDG_DATA_HOME?.trim()) push(path.join(env.XDG_DATA_HOME.trim(), "goose", "sessions.db"));
    const home = os.homedir();
    push(path.join(home, ".local", "share", "goose", "sessions.db"));
    if (process.platform === "darwin") push(path.join(home, "Library", "Application Support", "Block", "goose", "sessions.db"));
    return out;
}

export function registerGooseIdentitySource(): void {
    registerIdentitySource({
        id: "goose",
        matches(ctx: IdentityHarvestCtx): boolean {
            // The recognized conversation key IS the header value when it came
            // from agent-session-id, so exact equality proves the join.
            const h = headerFirst(ctx, "agent-session-id");
            return !!h && h === ctx.sessionId;
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
                        .prepare("SELECT message_id AS id, role FROM messages WHERE session_id = ? AND message_id IS NOT NULL ORDER BY created_timestamp, id")
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
