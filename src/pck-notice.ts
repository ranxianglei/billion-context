// #5079: one-time upgrade notice for the prompt_cache.routing default flip
// (auto → disabled). bili no longer writes its own prompt_cache_key by
// default; upstreams that ROUTE prefix cache by that field (body-keyed relays
// like the workbuddy panel, header-keyed ones like the workbuddy hub, and
// account-pool aggregators) lose their affinity signal unless the user turns
// the switch back on. The notice is shown until dismissed — once per install,
// persisted server-side (not per-browser), best-effort persistence that never
// fails a request or a page load. It is only active while the EFFECTIVE
// routing is "disabled": users who already chose auto/enabled made the call
// themselves and are not nagged.
//
// #5548: the DISMISSAL RECEIPTS themselves moved into unified storage — see
// src/notice-store.ts (kv_store namespace "notices"; owner ruling 2026-11-03:
// state stops being carried in JSON files). This module keeps the public
// shape (sync reads, sync dismiss) and degrades to the legacy file whenever
// no unified sidecar exists.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";
import {
    addDismissedKeyInMemory,
    dismissedCache,
    isBuiltinNoticeId,
    isValidDismissKey,
    MAX_DISMISSED_KEYS,
    persistDismissedKey,
    unifiedReceiptsActive,
} from "./notice-store.js";
import { IOT_INCOMPAT_NOTICE_ID, PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID } from "./notice-store.js";

export { IOT_INCOMPAT_NOTICE_ID, PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID };

const DISMISS_FILE = "upgrade-notices.json";

function stateDirFor(env: NodeJS.ProcessEnv): string {
    const v = env.XDG_STATE_HOME;
    return v && v.length > 0 ? path.join(path.resolve(v), "billion-context") : stateDir();
}

/** Legacy-file read: the pre-hydration fallback AND the carrier for
 *  legacy-only instances. */
function fileDismissedKeys(env: NodeJS.ProcessEnv): ReadonlySet<string> {
    try {
        const raw = fs.readFileSync(path.join(stateDirFor(env), DISMISS_FILE), "utf8");
        const doc: unknown = JSON.parse(raw);
        const arr = doc && typeof doc === "object" && Array.isArray((doc as { dismissed?: unknown })["dismissed"])
            ? ((doc as { dismissed: unknown[] })["dismissed"])
            : [];
        return new Set(arr.filter((x): x is string => typeof x === "string"));
    } catch {
        return new Set();
    }
}

export function dismissedUpgradeNotices(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    if (unifiedReceiptsActive()) {
        const view = dismissedCache();
        if (view !== null) return view;
    }
    return fileDismissedKeys(env);
}

/** Idempotent. Returns false only for unknown notice ids. */
export function dismissUpgradeNotice(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!isValidDismissKey(id)) return false;
    if (unifiedReceiptsActive()) {
        // unified carrier: in-memory now, durable write fire-and-forget,
        // eviction enforced synchronously in the memory view (see store).
        addDismissedKeyInMemory(id);
        persistDismissedKey(id);
        return true;
    }
    const set = new Set(dismissedUpgradeNotices(env));
    set.add(id);
    // bound the file — built-in ids are protected; overflow evicts alphabetically
    // (the flat legacy file carries no insertion times, so true FIFO is not possible here)
    let keys = [...set].sort();
    while (keys.length > MAX_DISMISSED_KEYS) {
        const victim = keys.find((k) => !isBuiltinNoticeId(k));
        if (victim === undefined) break;
        keys = keys.filter((k) => k !== victim);
    }
    try {
        const dir = stateDirFor(env);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, DISMISS_FILE), JSON.stringify({ dismissed: keys }, null, 2) + "\n");
    } catch {
        // best effort: dismissal intent still holds for this process's answers
    }
    return true;
}

/** The notice is visible while self-stamping is off and the user has not closed it. */
export function pckNoticeActive(routing: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (routing !== "disabled") return false;
    return !dismissedUpgradeNotices(env).has(PCK_NOTICE_ID);
}
