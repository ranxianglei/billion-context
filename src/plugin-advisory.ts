// #2462: known third-party plugins that are NOT compressors but measurably
// degrade the upstream prefix cache — each fires a full-conversation re-send
// under a separate system prompt before every tool call. bili isolates them
// into a sub-session so they no longer pollute the main session, but the token
// cost is host-side and invisible to the compression-conflict ledger (#1206),
// which tracks double-compression only. This module detects such plugins from
// the client registry (best-effort, read-only, cached) so the web UI surfaces a
// notice pointing at the owning issue instead of silently burning cache. Every
// fs access is guarded — detection must NEVER fail a request or a page load.
//
// Detection keys off whether the plugin is actually ENABLED, not merely
// installed: a dsh plugin turns on when its loader id appears as a top-level
// entry in the profile's cordis.patch.yml (the same file dsh-channel.ts treats
// as the id-targeted override/disable/insert layer). Presence in package.json
// deps is NOT a reliable on/off signal — the plugin usually arrives through a
// bundle rather than a direct dep, and installed-but-disabled would be a false
// alarm — so we scan the patch layer instead.
//
// The loader id alone is NOT package identity (#7068: the second false
// positive — community plugin PerryLink/dsh-auto-review ships `id: auto-review`
// and the advisory named the official package it never installed). The entry's
// `name` line is the package dsh actually loads for that id: identity = name
// match when the entry carries a name (a present-but-different name is a
// verdict — the entry loads another package), on-disk presence in a profile
// bundle when it does not (entries predating the name convention).

import fs from "node:fs";
import path from "node:path";
import { dshProfileDirs, parseDshPatchEntries, type DshPatchEntry } from "./dsh-channel.js";

interface CostAdvisory {
    id: string;
    name: string;
    client: string;
    issueUrl: string;
}

const DSH_AUTO_REVIEW_ISSUE = "https://github.com/ranxianglei/billion-context/issues/2462";

// One entry per known cost-affecting plugin. `client` scopes which registry to
// scan, `id`/`name` is the npm package name (grep-able by the user), `patchIds`
// are the dsh loader ids whose presence in cordis.patch.yml means the plugin is
// turned ON, and `issueUrl` is the owning issue the web banner links to.
const KNOWN_COST_PLUGINS: ReadonlyArray<{ client: string; id: string; name: string; issueUrl: string; patchIds: readonly string[] }> = [
    { client: "dsh", id: "@deepseek-ai/dsh-experimental-auto-review", name: "@deepseek-ai/dsh-experimental-auto-review", issueUrl: DSH_AUTO_REVIEW_ISSUE, patchIds: ["auto-review"] },
];

const SCAN_TTL_MS = 5 * 60 * 1000;
let cache: { key: string; at: number; result: CostAdvisory[] } | undefined;

// Enabled top-level patch entries across every dsh profile's cordis.patch.yml
// — entries carrying `disabled: true` in their own block do NOT count (#3838:
// presence of the id line alone used to fire the advisory for explicitly
// disabled plugins). Parsed by the shared dsh-channel entry scanner so this
// gate and the #2861 disable check share one discipline.
function dshEnabledPatchEntries(env: NodeJS.ProcessEnv): DshPatchEntry[] {
    const entries: DshPatchEntry[] = [];
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return entries;
    }
    for (const dir of dirs) {
        let text: string;
        try {
            text = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
        } catch {
            continue;
        }
        for (const e of parseDshPatchEntries(text)) {
            if (!e.disabled) entries.push(e);
        }
    }
    return entries;
}

// #7068: the entry's `name` line is the package dsh loads for that loader id.
// Full package-name match, or the unscoped tail (a hand-written entry may omit
// the @scope/ prefix). A present-but-different name is a verdict — it never
// falls through to the disk check.
function patchEntryLoadsPackage(name: string | undefined, pkg: string): boolean {
    if (name === undefined) return false;
    if (name === pkg) return true;
    const slash = pkg.indexOf("/");
    return slash > 0 && name === pkg.slice(slash + 1);
}

// #7068: fallback for entries without a name line — the package must actually
// be installed in some profile bundle (same on-disk probe shape as
// probeDshIotThinking in notices.ts).
function dshPackageInstalled(env: NodeJS.ProcessEnv, pkg: string): boolean {
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return false;
    }
    for (const dir of dirs) {
        try {
            if (fs.existsSync(path.join(dir, "node_modules", ...pkg.split("/"), "package.json"))) return true;
        } catch {
            // unreadable profile: keep scanning the rest
        }
    }
    return false;
}

export function detectCostAdvisories(env: NodeJS.ProcessEnv = process.env): CostAdvisory[] {
    const key = `${env.DSH_HOME ?? ""}|${env.HOME ?? ""}|${env.USERPROFILE ?? ""}`;
    if (cache && cache.key === key && Date.now() - cache.at < SCAN_TTL_MS) return cache.result;
    const found: CostAdvisory[] = [];
    const entries = KNOWN_COST_PLUGINS.some((p) => p.client === "dsh") ? dshEnabledPatchEntries(env) : undefined;
    for (const p of KNOWN_COST_PLUGINS) {
        if (p.client !== "dsh") continue;
        const hit = entries?.some((e) =>
            p.patchIds.includes(e.id) &&
            // #7068: an id match alone is not enough — the entry must load the
            // official package (name match, or on-disk presence when the entry
            // predates the name convention).
            (patchEntryLoadsPackage(e.name, p.id) || (e.name === undefined && dshPackageInstalled(env, p.id)))
        );
        if (hit) found.push({ id: p.id, name: p.name, client: p.client, issueUrl: p.issueUrl });
    }
    cache = { key, at: Date.now(), result: found };
    return found;
}

export function _clearCostAdvisoryCache(): void {
    cache = undefined;
}
