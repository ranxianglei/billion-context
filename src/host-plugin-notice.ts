// #2861: known third-party host-side plugins whose context BREAKDOWN derives
// from the host's LOCAL session store. While bili compresses the wire, that
// store diverges from what the model actually sees: dsh's durable log stays
// lossless by architectural invariant and folds happen outside the host event
// stream (storage: shadow), so the per-category composition / timeline a meter
// computes from it is the PRE-COMPRESSION distribution even though every
// request carries far fewer tokens. (dsh-context's headline size is anchored on
// provider usage and tracks the effective volume — only its split is stale;
// #3303 measured the two equal within one sampling phase.) This module detects
// such plugins conservatively from the client's own registry (best-effort,
// read-only, cached) so the web UI tells users their segment composition is
// pre-compression instead of letting them read a stale split as the model's
// view. Every fs access is guarded — detection must NEVER fail a request
// or a page load.
//
// Detection keys off the dsh profile manifest (package.json): a bundle plugin
// is ON only when the profile declares it as a direct dependency AND lists it
// in the ordered `dsh.profile.bundles` selection — the harness plugin-manager's
// official install/on-off record (a bundle toggle edits exactly that list). A
// profile-level `disabled: true` override on its loader id in
// cordis.patch.yml suppresses the notice. The bili-lane gate keeps detection
// conservative end-to-end: a profile without bili never compresses, so its
// local meter is accurate there and a notice would be a false alarm.

import fs from "node:fs";
import path from "node:path";
import { dshProfileDirs, parseDshPatchEntries } from "./dsh-channel.js";
import { stateDir } from "./paths.js";

interface HostPluginNotice {
    /** Stable notice key — also the dismissal key. */
    id: string;
    /** npm package name, grep-able by the user. */
    name: string;
    /** Which host registry was scanned. */
    client: string;
    /** Profile name that triggered detection (first hit wins). */
    profile: string;
}

interface HostPluginEntry {
    client: string;
    id: string;
    depName: string;
    loaderId: string;
    requiresBiliLane: boolean;
}

// One row per known host-side metering plugin — adding the next one adds one
// entry here.
const KNOWN_HOST_PLUGINS: readonly HostPluginEntry[] = [
    // #2837/#3303: dsh-context's segment composition / timeline derive from
    // dsh's durable (lossless) session log, so under active compression they are
    // the pre-compression distribution; its headline size is provider-usage-
    // anchored and tracks the effective volume.
    { client: "dsh", id: "dsh-context", depName: "dsh-context", loaderId: "dsh-context", requiresBiliLane: true },
];

/** bili's own dsh lane package name — present in the same profile's deps, or no compression happens there. */
const BILI_DSH_PACKAGE = "billion-context";

const SCAN_TTL_MS = 5 * 60 * 1000;
let cache: { key: string; at: number; result: HostPluginNotice[] } | undefined;

function depsOf(doc: Record<string, unknown>): Set<string> {
    const out = new Set<string>();
    const deps = doc["dependencies"];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
        for (const k of Object.keys(deps)) out.add(k);
    }
    return out;
}

function selectedBundlesOf(doc: Record<string, unknown>): Set<string> {
    const out = new Set<string>();
    const dsh = doc["dsh"];
    if (!dsh || typeof dsh !== "object" || Array.isArray(dsh)) return out;
    const profile = (dsh as Record<string, unknown>)["profile"];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return out;
    const bundles = (profile as Record<string, unknown>)["bundles"];
    if (!Array.isArray(bundles)) return out;
    for (const b of bundles) if (typeof b === "string") out.add(b);
    return out;
}

function readProfileManifest(dir: string): Record<string, unknown> | undefined {
    try {
        const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
        const doc: unknown = JSON.parse(raw);
        return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

// True when the profile patch layer carries `- id: <loaderId>` with a
// `disabled: true` line inside its block. Delegates to the shared dsh-channel
// entry scanner (#3838) so this gate and the #2462 cost-advisory scan share
// one parsing discipline instead of drifting apart.
function patchDisabled(patchFile: string, loaderId: string): boolean {
    let text: string;
    try {
        text = fs.readFileSync(patchFile, "utf8");
    } catch {
        return false;
    }
    return parseDshPatchEntries(text).some((e) => e.id === loaderId && e.disabled);
}

export function detectHostPluginNotices(env: NodeJS.ProcessEnv = process.env): HostPluginNotice[] {
    const key = `${env.DSH_HOME ?? ""}|${env.HOME ?? ""}|${env.USERPROFILE ?? ""}`;
    if (cache && cache.key === key && Date.now() - cache.at < SCAN_TTL_MS) return cache.result;
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        dirs = [];
    }
    const found: HostPluginNotice[] = [];
    for (const p of KNOWN_HOST_PLUGINS) {
        if (p.client !== "dsh") continue;
        for (const dir of dirs) {
            const doc = readProfileManifest(dir);
            if (!doc) continue;
            const deps = depsOf(doc);
            if (!deps.has(p.depName)) continue;
            if (!selectedBundlesOf(doc).has(p.depName)) continue;
            if (p.requiresBiliLane && !deps.has(BILI_DSH_PACKAGE)) continue;
            if (patchDisabled(path.join(dir, "cordis.patch.yml"), p.loaderId)) continue;
            found.push({ id: p.id, name: p.depName, client: p.client, profile: path.basename(dir) });
            break;
        }
    }
    cache = { key, at: Date.now(), result: found };
    return found;
}

export function _clearHostPluginNoticeCache(): void {
    cache = undefined;
}

// ---- Dismissal state ------------------------------------------------------
// Server-side on purpose (not per-browser localStorage): one close silences the
// notice for every browser against this proxy instance, across reloads and
// restarts. Runtime state file beside instances.json — not config surface.

const DISMISS_FILE = "host-plugin-notices.json";

function stateDirFor(env: NodeJS.ProcessEnv): string {
    const v = env.XDG_STATE_HOME;
    return v && v.length > 0 ? path.join(path.resolve(v), "billion-context") : stateDir();
}

export function dismissedHostPlugins(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
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

/** Idempotent. Returns false only for ids outside KNOWN_HOST_PLUGINS. */
export function dismissHostPlugin(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!KNOWN_HOST_PLUGINS.some((p) => p.id === id)) return false;
    const set = new Set(dismissedHostPlugins(env));
    set.add(id);
    try {
        const dir = stateDirFor(env);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, DISMISS_FILE), JSON.stringify({ dismissed: [...set].sort() }, null, 2) + "\n");
    } catch {
        // best effort: the in-memory answer below still reflects intent
    }
    return true;
}

/** Detection minus dismissed — what the admin payloads actually ship. */
export function visibleHostPluginNotices(env: NodeJS.ProcessEnv = process.env): HostPluginNotice[] {
    const dismissed = dismissedHostPlugins(env);
    return detectHostPluginNotices(env).filter((n) => !dismissed.has(n.id));
}
