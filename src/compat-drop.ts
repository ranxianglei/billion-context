// #1757: opt-in removal of client-fixed request fields that strict-schema
// upstreams reject. SenseNova's Responses gateway (token.sensenova.cn/v1/responses)
// 400s pi-ai's fixed `reasoning.summary` with 'json: unknown field "summary"'
// (2026-09-30 per-field matrix: reasoning.effort accepted, summary alone 400s;
// the full pi-ai body 200s once the field is gone). Same species as
// compat.roles (#552): a field the CLIENT sends that the upstream won't take —
// applied at the same final-forward boundary.
//
// Contract (owner-decided shape A, 2026-10-01):
// - Paths are dot-separated PLAIN-OBJECT key paths: no wildcards, no array
//   indices ("tools[0].x" is invalid). Each segment matches [A-Za-z0-9_-]+.
// - Merge is ADDITIVE: per-provider dropFields ∪ global dropFields. A provider
//   entry can add paths but never retract a global one (unlike roles' per-key
//   override — there is no per-path "off" state).
// - Structural deletion only: object keys are removed from the parsed body;
//   string leaves (tool-call arguments, prose) are never read or written, so
//   user-intent payloads stay byte-exact (§7.3 wire fidelity).
// - Unconfigured, or nothing matched ⇒ the original bytes come back unchanged:
//   no re-stringify, so the default path stays byte-for-byte identical and
//   #661's fingerprinting contract is untouched.

import { findRoute, type ProviderRoutes } from "./config.js";

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function isPlainObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePath(p: string): boolean {
    for (const s of p.split(".")) if (!SEGMENT_RE.test(s)) return false;
    return true;
}

/** Validate a `compat.dropFields` value (global or per-provider): an array of
 *  dot-separated plain-object key paths. Non-string / empty / malformed
 *  entries are dropped individually — one bad entry never breaks the proxy —
 *  and duplicates collapse. Returns undefined when nothing usable remains. */
export function parseCompatDropFields(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    let out: string[] | undefined;
    for (const entry of v) {
        if (typeof entry !== "string") continue;
        const p = entry.trim();
        if (!parsePath(p)) continue;
        if (!out) out = [];
        if (!out.includes(p)) out.push(p);
    }
    return out;
}

/** Resolve the effective drop-field list for one request destination:
 *  global ∪ per-provider (additive union, see module contract). An empty
 *  array means "nothing configured" — callers treat it as a byte-for-byte
 *  no-op. */
export function resolveCompatDropFields(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    globalPaths: readonly string[] | undefined,
): string[] {
    const providerPaths = findRoute(routes, upstreamUrl)?.compat?.dropFields;
    const g = globalPaths ?? [];
    if (g.length === 0 && !providerPaths?.length) return [];
    const out = [...g];
    for (const p of providerPaths ?? []) if (!out.includes(p)) out.push(p);
    return out;
}

/** Structurally delete dot-paths from a parsed JSON object. Intermediate
 *  nodes that are missing or not plain objects are skipped silently (a
 *  configured path simply doesn't exist on this wire); only actual key
 *  deletions count. Returns the number of keys deleted. Never throws. */
export function dropCompatFieldsJson(parsed: Record<string, unknown>, paths: readonly string[]): number {
    if (paths.length === 0) return 0;
    let dropped = 0;
    for (const raw of paths) {
        const segs = raw.split(".");
        let node: unknown = parsed;
        for (let i = 0; i < segs.length - 1; i++) {
            node = isPlainObj(node) ? node[segs[i]] : undefined;
        }
        const leaf = segs[segs.length - 1];
        if (isPlainObj(node) && Object.prototype.hasOwnProperty.call(node, leaf)) {
            delete node[leaf];
            dropped++;
        }
    }
    return dropped;
}

/** Apply the drop list to a serialized request body. Returns `{ body,
 *  dropped }`; `body` is the ORIGINAL string whenever nothing was configured
 *  or nothing matched (no re-stringify), otherwise the re-serialized JSON. */
export function applyCompatDropFields(body: string, paths: readonly string[]): { body: string; dropped: number } {
    if (paths.length === 0 || body.length === 0) return { body, dropped: 0 };
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { body, dropped: 0 };
    }
    if (!isPlainObj(parsed)) return { body, dropped: 0 };
    const dropped = dropCompatFieldsJson(parsed, paths);
    if (dropped === 0) return { body, dropped: 0 };
    return { body: JSON.stringify(parsed), dropped };
}
