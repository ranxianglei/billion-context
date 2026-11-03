// #5079/#5469 → #5548: shared dismissal store for upgrade notices. P1 moved the
// notice declarations into src/notices.ts (the registry); this module keeps only
// the persistence layer — the store file, the allowlist-checked writes, and the
// pck predicate (still consumed by acp-status.ts / server.ts startup log).
// #5548 P2: store keys upgrade from bare ids to `id@hash16(record)` (content
// edits re-show once), the array keeps insertion order under a 200-key FIFO cap,
// and instance-mode dismissals live in memory only.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";
import { BUILTIN_NOTICES, PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, dismissKeyOf, knownNoticeIds, type NoticeRecord } from "./notices.js";

export { PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID };

const DISMISS_FILE = "upgrade-notices.json";
const MAX_STORED_KEYS = 200; // #5548 §4.4 FIFO cap

function stateDirFor(env: NodeJS.ProcessEnv): string {
    const v = env.XDG_STATE_HOME;
    return v && v.length > 0 ? path.join(path.resolve(v), "billion-context") : stateDir();
}

export function dismissedUpgradeNotices(env: NodeJS.ProcessEnv = process.env): Set<string> {
    try {
        const raw = fs.readFileSync(path.join(stateDirFor(env), DISMISS_FILE), "utf8");
        const doc: unknown = JSON.parse(raw);
        if (doc && typeof doc === "object" && Array.isArray((doc as { dismissed?: unknown }).dismissed)) {
            return new Set((doc as { dismissed: unknown[] }).dismissed.filter((x): x is string => typeof x === "string"));
        }
    } catch {
        // absent/unreadable/corrupt → empty set (first run or fresh profile)
    }
    return new Set();
}

/** Ordered key list as persisted — insertion order IS the FIFO order. */
function readStoreKeys(env: NodeJS.ProcessEnv): string[] {
    return [...dismissedUpgradeNotices(env)];
}

function appendKey(key: string, env: NodeJS.ProcessEnv): void {
    const keys = readStoreKeys(env);
    if (!keys.includes(key)) keys.push(key);
    if (keys.length > MAX_STORED_KEYS) keys.splice(0, keys.length - MAX_STORED_KEYS);
    const dir = stateDirFor(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, DISMISS_FILE), JSON.stringify({ dismissed: keys }, null, 2) + "\n");
}

/** Legacy entry point (#5079/#5469 suites + pre-P2 stores): writes the bare id
 *  key, which noticeVisible() still honors so an upgrade never re-shows an
 *  already-closed banner. New callers write id@hash16 keys via
 *  dismissPersistentNotice(). */
export function dismissUpgradeNotice(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!knownNoticeIds().has(id)) return false;
    try {
        appendKey(id, env);
    } catch {
        // best-effort persistence: nothing to report if the state dir is unwritable
    }
    return true;
}

/** Persistent dismissal under the #5548 hash key (`id@hash16`); a content edit
 *  changes the hash and re-shows the banner once. */
export function dismissPersistentNotice(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const at = key.indexOf("@");
    if (at <= 0) return false;
    if (!knownNoticeIds().has(key.slice(0, at))) return false;
    try {
        appendKey(key, env);
    } catch {
        // best-effort persistence: nothing to report if the state dir is unwritable
    }
    return true;
}

// Instance-mode dismissals (§4.4): process memory only — they re-show on restart.
const instanceDismissed = new Set<string>();

export function instanceDismissedNotices(): ReadonlySet<string> {
    return instanceDismissed;
}

export function recordInstanceNoticeDismissal(id: string): void {
    instanceDismissed.add(id);
}

function builtinWireRecord(id: string): NoticeRecord | undefined {
    const b = BUILTIN_NOTICES.find((x) => x.id === id);
    if (!b) return undefined;
    const { active: _active, ...wire } = b;
    return wire;
}

/** True when the prompt-cache routing default-flip notice should surface:
 *  routing is disabled and the user has not dismissed it (legacy bare-id key
 *  or the #5548 hash key). */
export function pckNoticeActive(routing: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (routing !== "disabled") return false;
    const store = dismissedUpgradeNotices(env);
    if (store.has(PCK_NOTICE_ID)) return false;
    const wire = builtinWireRecord(PCK_NOTICE_ID);
    if (wire && store.has(dismissKeyOf(wire))) return false;
    return true;
}
