// #5079: one-time upgrade notice for the prompt_cache.routing default flip
// (auto → disabled). bili no longer writes its own prompt_cache_key by
// default; upstreams that ROUTE prefix cache by that field (body-keyed relays
// like the workbuddy panel, header-keyed ones like the workbuddy hub, and
// account-pool aggregators) lose their affinity signal unless the user turns
// the switch back on. The notice is shown until dismissed — once per proxy
// instance, persisted beside instances.json (same discipline as
// host-plugin-notice.ts: server-side, not per-browser, best-effort fs that
// never fails a request or a page load). It is only active while the EFFECTIVE
// routing is "disabled": users who already chose auto/enabled made the call
// themselves and are not nagged.
// #5548: this module is now just the shared dismissal store of the unified
// announcement surface — known ids and the built-in declarations live in
// notices.ts (registry), so lanes B/C register ids without touching this file.

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";
import { PCK_NOTICE_ID, knownNoticeIds } from "./notices.js";

export { PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID } from "./notices.js";

const DISMISS_FILE = "upgrade-notices.json";

function stateDirFor(env: NodeJS.ProcessEnv): string {
    const v = env.XDG_STATE_HOME;
    return v && v.length > 0 ? path.join(path.resolve(v), "billion-context") : stateDir();
}

export function dismissedUpgradeNotices(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
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

/** Idempotent. Returns false only for unknown notice ids. */
export function dismissUpgradeNotice(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!knownNoticeIds().has(id)) return false;
    const set = new Set(dismissedUpgradeNotices(env));
    set.add(id);
    try {
        const dir = stateDirFor(env);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, DISMISS_FILE), JSON.stringify({ dismissed: [...set].sort() }, null, 2) + "\n");
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
