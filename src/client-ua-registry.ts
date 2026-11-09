// #4649: recently observed client user-agents, per client family. The
// diagnostics blob used to carry ONLY dsh profile-bundle versions, so a
// conflict report from a non-dsh client (e.g. codex, #4648) had neither the
// client's own version nor — before the codex entries in CONFLICT_LOG_PATTERNS
// landed — any log evidence to adjudicate with, forcing a manual round-trip
// for `codex --version` and hand-picked log lines.
//
// The proxy sees the requesting UA on every model request; this module keeps
// a bounded in-memory map of what was observed and the "host client versions"
// section of the report publishes it. Process-scoped by design: a restart
// starts fresh, and a report generated while traffic flows reflects live
// clients. In-memory only — nothing here is persisted or sent upstream.
//
// Publish discipline: the values are raw client-supplied header bytes, but
// they only leave the process through buildDiagnostics' sink-level
// redactForPublish (#4427), which scrubs credential shapes, masks private
// hosts, and ~-normalizes home paths across the whole blob. Length is bounded
// at ingest (UA_MAX_CHARS) so one hostile UA cannot bloat the pasteable blob.

import { isCodexClient } from "./codex-compact.js";
import { sniffScanClient } from "./thirdparty-scan.js";

// Read directly (wire literal) instead of via plugin.ts — same discipline as
// codex-compact.ts / session-id.ts: importing plugin.ts back into the request
// path would close an ESM cycle through loop/tag-echo-filter.ts.
const BILI_PLUGIN_MARKER = "x-bili-plugin";

const FAMILY_CAP = 24;
const UA_CAP_PER_FAMILY = 8;
const UA_MAX_CHARS = 120;
const OTHER_FAMILY = "other";

interface FamilyEntry {
    uas: Map<string, number>;
}

const families = new Map<string, FamilyEntry>();

function headerString(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const v = headers[name];
    if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
    return typeof v === "string" ? v : undefined;
}

/** Client family for UA bookkeeping — mirrors conflictClientOf's resolution
 * ladder (declared plugin agent > header sniff > codex UA shape) keyed off
 * the raw request headers. "mcp" is not a client name (MCP evidence flip,
 * #760b), so it falls through like in conflict-watch. */
export function clientFamilyOf(headers: Record<string, string | string[] | undefined>): string {
    const agent = headerString(headers, BILI_PLUGIN_MARKER);
    if (agent && agent !== "mcp") return agent;
    const sniffed = sniffScanClient(headers);
    if (sniffed) return sniffed;
    const ua = headerString(headers, "user-agent");
    if (ua && isCodexClient({ "user-agent": ua })) return "codex";
    return OTHER_FAMILY;
}

/** Latest-wins per exact UA string; evicts the oldest UA inside a family past
 * UA_CAP_PER_FAMILY, and the least-recently-seen family past FAMILY_CAP, so a
 * hostile or churning client can only occupy bounded slots. */
export function recordClientUa(headers: Record<string, string | string[] | undefined>): void {
    const raw = headerString(headers, "user-agent");
    if (!raw || !raw.trim()) return;
    const ua = raw.trim().slice(0, UA_MAX_CHARS);
    const now = Date.now();
    let fam = families.get(clientFamilyOf(headers));
    if (!fam) {
        if (families.size >= FAMILY_CAP) {
            let oldestKey: string | undefined;
            let oldestAt = Infinity;
            for (const [k, v] of families) {
                let newest = -Infinity;
                for (const t of v.uas.values()) if (t > newest) newest = t;
                if (newest < oldestAt) { oldestAt = newest; oldestKey = k; }
            }
            if (oldestKey !== undefined) families.delete(oldestKey);
        }
        fam = { uas: new Map() };
        families.set(clientFamilyOf(headers), fam);
    }
    fam.uas.set(ua, now);
    while (fam.uas.size > UA_CAP_PER_FAMILY) {
        let oldestUa: string | undefined;
        let oldestAt = Infinity;
        for (const [u, t] of fam.uas) {
            // strict < keeps first-inserted on timestamp ties (FIFO eviction)
            if (t < oldestAt) { oldestAt = t; oldestUa = u; }
        }
        if (oldestUa === undefined) break;
        fam.uas.delete(oldestUa);
    }
}

interface ObservedUa {
    family: string;
    ua: string;
}

/** All recorded observations — families alphabetical, newest-first within a
 * family — for the diagnostics section to render under its own display cap. */
export function recentClientUas(): ObservedUa[] {
    const out: ObservedUa[] = [];
    const sortedFamilies = [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [family, fam] of sortedFamilies) {
        const sortedUas = [...fam.uas.entries()].sort((a, b) => b[1] - a[1]);
        for (const [ua] of sortedUas) out.push({ family, ua });
    }
    return out;
}

export function _resetClientUaRegistryForTest(): void {
    families.clear();
}
