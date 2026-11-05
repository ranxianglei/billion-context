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

import fs from "node:fs";
import path from "node:path";
import { dshProfileDirs, parseDshPatchEntries } from "./dsh-channel.js";

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

// Enabled top-level patch-entry loader ids across every dsh profile's
// cordis.patch.yml — entries carrying `disabled: true` in their own block do
// NOT count (#3838: presence of the id line alone used to fire the advisory
// for explicitly disabled plugins). Parsed by the shared dsh-channel entry
// scanner so this gate and the #2861 disable check share one discipline.
function dshEnabledPatchIds(env: NodeJS.ProcessEnv): Set<string> {
    const ids = new Set<string>();
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return ids;
    }
    for (const dir of dirs) {
        let text: string;
        try {
            text = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
        } catch {
            continue;
        }
        for (const e of parseDshPatchEntries(text)) {
            if (!e.disabled) ids.add(e.id);
        }
    }
    return ids;
}

export function detectCostAdvisories(env: NodeJS.ProcessEnv = process.env): CostAdvisory[] {
    const key = `${env.DSH_HOME ?? ""}|${env.HOME ?? ""}|${env.USERPROFILE ?? ""}`;
    if (cache && cache.key === key && Date.now() - cache.at < SCAN_TTL_MS) return cache.result;
    const found: CostAdvisory[] = [];
    const enabled = KNOWN_COST_PLUGINS.some((p) => p.client === "dsh") ? dshEnabledPatchIds(env) : undefined;
    for (const p of KNOWN_COST_PLUGINS) {
        if (p.client !== "dsh") continue;
        if (!p.patchIds.some((pid) => enabled?.has(pid))) continue;
        found.push({ id: p.id, name: p.name, client: p.client, issueUrl: p.issueUrl });
    }
    cache = { key, at: Date.now(), result: found };
    return found;
}

export function _clearCostAdvisoryCache(): void {
    cache = undefined;
}
