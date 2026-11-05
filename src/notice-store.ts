// #5548: notice dismissal receipts live in the UNIFIED storage — the kv_store
// cross-session key/value table (#3069 v4), namespace "notices" — not in a
// bespoke JSON file. Design per owner ruling 2026-11-03 ("以后尽量不要存json
// 了，都用统一存储"):
//   * primary carrier = kv rows {key → {at}} on shadow/full instances;
//   * the legacy file (stateDir/upgrade-notices.json) stays as the read
//     fallback until hydration completes AND as the sole carrier on legacy-
//     only instances (no unified sidecar, e.g. BILI_ENCRYPTION_KEY opt-out);
//   * one-time migration: the first hydration imports any file keys into the
//     store, after which a unified instance never writes the file again (the
//     stale copy stays on disk, inert).
// Receipts are scoped to ONE install/state volume — a shared-volume cluster
// deployment sees every replica's dismissals without cross-node signalling.
// All persistence is best-effort (warn-once): an advisory surface must never
// fail a request or a page load, mirroring the pre-unified file discipline.

import fs from "node:fs";
import path from "node:path";
import { log as loggerLog } from "./logger.js";
import { stateDir } from "./paths.js";
import { getStore, unifiedKvActive } from "./persist.js";

export const PCK_NOTICE_ID = "pck-default-off";
// #5403 watermark fastpath experimental-grey intro (owner ruling 2026-11-02):
// own id so dismissal stays independent of pck's.
export const WM_FASTPATH_INTRO_ID = "wm-fastpath-intro";
// Owner report 2026-11-09: dsh's iot-thinking plugin fires one extra
// compress/rewrite request after every model reply, occupying the SAME
// session's proxy lane serially — the step keeps waiting seconds to tens of
// seconds after its first byte. Own id so its dismissal is independent.
export const IOT_INCOMPAT_NOTICE_ID = "iot-incompat";

const UPGRADE_NOTICE_IDS: ReadonlySet<string> = new Set([PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, IOT_INCOMPAT_NOTICE_ID]);
// #5548 P2: local announcements dismiss as `<id>@<content-hash16>` so edited
// content re-nags exactly once; the hash shape is the only dynamic form the
// store accepts (raw local ids never enter it — those use instance/always).
const HASHED_NOTICE_RE = /^[a-z0-9][a-z0-9-]{0,63}@[0-9a-f]{16}$/;
export const MAX_DISMISSED_KEYS = 200;

const NS = "notices";
const DISMISS_FILE = "upgrade-notices.json";

let cache: Map<string, number> | null = null;
let hydrating = false;
// #5761: independent of the lazy cache — cache !== null only means "some
// dismissal touched this process", NOT "hydration completed". Bailing on it
// (the old gate) let one pre-hydration receipt block the migration forever.
let hydrated = false;
let warned = false;

function warnOnce(tag: string, err: unknown): void {
    if (warned) return;
    warned = true;
    loggerLog("warn", `[notices] ${tag} failed — receipts stay in-memory for this process: ${err instanceof Error ? err.message : String(err)}`);
}

export function isValidDismissKey(key: string): boolean {
    return UPGRADE_NOTICE_IDS.has(key) || HASHED_NOTICE_RE.test(key);
}

export function isBuiltinNoticeId(key: string): boolean {
    return UPGRADE_NOTICE_IDS.has(key);
}

/** True once the EXISTING store singleton offers unified KV. Never creates
 *  the singleton (hot read path). */
export function unifiedReceiptsActive(): boolean {
    return unifiedKvActive();
}

function stateDirFor(env: NodeJS.ProcessEnv): string {
    const v = env.XDG_STATE_HOME;
    return v && v.length > 0 ? path.join(path.resolve(v), "billion-context") : stateDir();
}

function fileKeysOf(env: NodeJS.ProcessEnv): Set<string> {
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

/** Sync view of the hydrated receipts, or null before hydration completed
 *  (callers fall back to reading the legacy file). */
export function dismissedCache(): ReadonlySet<string> | null {
    return cache === null ? null : new Set(cache.keys());
}

/** Once per process (wired at cli start): load kv rows + import the legacy
 *  file one time. Legacy-only instances keep the pure-file path forever
 *  (cache intentionally left null). Never throws.
 *  #5761 (twin of the #5757 host-plugin fix): UNION into whatever cache a
 *  pre-hydration dismissal already lazily created instead of bailing — that
 *  early receipt used to block both the one-time file→kv migration and every
 *  sibling lane's rows for the whole process lifetime. */
export async function hydrateNoticeReceipts(): Promise<void> {
    if (hydrated || hydrating || !unifiedReceiptsActive()) return;
    hydrating = true;
    const now = Date.now();
    try {
        const dbRows = await getStore().listKvAsync(NS);
        const rowKeys = new Set(dbRows.map((r) => r.key));
        // One-time migration: file keys not yet in kv into kv (raw junk stays
        // file-only — the view below still honors it).
        const fileKeys = fileKeysOf(process.env);
        const toImport = [...fileKeys].filter((k) => !rowKeys.has(k));
        for (const k of toImport) {
            try {
                await getStore().setKvAsync(NS, k, { at: now });
            } catch (err) {
                warnOnce("migrate", err);
                break;
            }
        }
        if (toImport.length > 0) {
            loggerLog("info", `[notices] imported ${toImport.length} receipt(s) from the legacy JSON file into unified storage (kv_store namespace "notices")`);
        }
        // Snapshot the LIVE view only now: nothing awaits between here and the
        // publish below, so a dismissal landing any time up to this point
        // (pre-hydration lazy adoption included) survives the final
        // assignment instead of being clobbered until restart.
        const merged = new Map<string, number>(cache ?? []);
        for (const r of dbRows) merged.set(r.key, r.updatedAt);
        for (const k of fileKeys) {
            if (!merged.has(k)) merged.set(k, now);
        }
        cache = merged;
        hydrated = true;
    } catch (err) {
        warnOnce("hydrate", err);
    }
    hydrating = false;
}

/** Synchronous add (callers observe it immediately). Eviction keeps the map
 *  under the cap WITH BUILTIN IDS PROTECTED, oldest-insertion-first, exactly
 *  like the old file discipline; evicted keys converge out of kv lazily. */
export function addDismissedKeyInMemory(key: string): void {
    if (cache === null) {
        // First write before hydration finished: adopt the file view so this
        // process's receipts do not regress what earlier processes recorded.
        cache = new Map<string, number>([...fileKeysOf(process.env)].map((k) => [k, Date.now()]));
    }
    cache.set(key, Date.now());
    while (cache.size > MAX_DISMISSED_KEYS) {
        let victim = "";
        for (const k of cache.keys()) {
            if (!isBuiltinNoticeId(k)) { victim = k; break; }
        }
        if (victim === "") break;
        cache.delete(victim);
        try {
            void getStore().deleteKvAsync(NS, victim).catch(() => undefined);
        } catch {
            // kv unavailable mid-flight: the in-memory bound still holds
        }
    }
}

/** Fire-and-forget durable write for a key just added in memory. */
export function persistDismissedKey(key: string): void {
    if (!unifiedReceiptsActive()) return;
    void (async () => {
        try {
            await getStore().setKvAsync(NS, key, { at: Date.now() });
        } catch (err) {
            warnOnce("persist", err);
        }
    })();
}

/** Test seam: drop caches so the next hydrate re-reads the volume. */
export function _resetNoticeReceiptsForTest(): void {
    cache = null;
    hydrating = false;
    hydrated = false;
    warned = false;
}
