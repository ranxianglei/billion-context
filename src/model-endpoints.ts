// #1295: declarable custom-wire model endpoints. The single source of truth
// for "this URL IS a model API" — read by BOTH gates that previously kept
// their own hardcoded, mutually inconsistent path tables (#1290):
//   - proxy side:  src/server.ts protocol classifier
//   - client side: src/agent/native-intercept.ts isModelApiUrl (fetch claim)
// A declaration is explicit and per-provider — there is no auto-detection of
// arbitrary wires. Each entry maps an absolute URL prefix to a wire family;
// standard families reuse the existing pipelines untouched, "commandcode" is
// the first custom family (openai-completions request shape inside a nested
// CLI envelope + bare-JSONL event-stream response).

import { readFile } from "node:fs/promises";
import { configFile } from "./paths.js";
import type { WireProtocol } from "./util.js";

export const MODEL_ENDPOINT_WIRES = ["anthropic", "openai", "responses", "google", "commandcode"] as const;
export type ModelEndpointWire = (typeof MODEL_ENDPOINT_WIRES)[number];

export interface ModelEndpointPattern {
    /** Normalized absolute URL prefix: scheme://host[:port]/path (no trailing slash). */
    match: string;
    wire: ModelEndpointWire;
}

function normalizeMatch(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return undefined;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (!u.hostname) return undefined;
    if (u.search || u.hash) return undefined;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** Parse + validate raw config entries. Throws on malformed input: a typo'd
 *  declaration must fail loudly at startup — silently dropping it would put
 *  the endpoint back in the unclaimed-and-invisible state #1290 reported. */
export function parseModelEndpointPatterns(raw: unknown): ModelEndpointPattern[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error("modelEndpointPatterns must be an array of {match, wire} objects");
    const out: ModelEndpointPattern[] = [];
    for (let i = 0; i < raw.length; i++) {
        const entry = raw[i];
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`modelEndpointPatterns[${i}] must be an object with "match" and "wire"`);
        }
        const e = entry as Record<string, unknown>;
        const match = normalizeMatch(e.match);
        if (match === undefined) {
            throw new Error(`modelEndpointPatterns[${i}].match must be an absolute http(s) URL prefix (got ${JSON.stringify(e.match)})`);
        }
        const wire = e.wire;
        if (typeof wire !== "string" || !(MODEL_ENDPOINT_WIRES as readonly string[]).includes(wire)) {
            throw new Error(`modelEndpointPatterns[${i}].wire must be one of ${MODEL_ENDPOINT_WIRES.join(" | ")} (got ${JSON.stringify(wire)})`);
        }
        out.push({ match, wire: wire as ModelEndpointWire });
    }
    return out;
}

/** Longest-prefix match of an absolute request URL against the declared
 *  patterns. Matching is per-URL-segment on the path (a pattern
 *  /alpha/generate does NOT claim /alpha/generate2) and requires an exact
 *  origin (scheme + host + port) match. Query strings are ignored. */
// Tolerates null/undefined: tests and embedders construct ProxyOptions-style
// objects by hand without going through loadOptions; a missing field must
// degrade to "no declarations", never throw on the hot request path.
export function matchModelEndpoint(patterns: readonly ModelEndpointPattern[] | null | undefined, url: string): ModelEndpointPattern | undefined {
    if (!patterns || patterns.length === 0) return undefined;
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return undefined;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
    let best: ModelEndpointPattern | undefined;
    let bestLen = -1;
    for (const p of patterns) {
        let m: URL;
        try {
            m = new URL(p.match);
        } catch {
            continue; // pre-validated by parseModelEndpointPatterns; defensive
        }
        if (m.origin !== target.origin) continue;
        const mp = m.pathname.replace(/\/+$/, "");
        const tp = target.pathname.replace(/\/+$/, "");
        if (tp !== mp && !tp.startsWith(mp + "/")) continue;
        if (p.match.length > bestLen) {
            best = p;
            bestLen = p.match.length;
        }
    }
    return best;
}

// Client-side (in-host process) loader. Unlike the proxy's loadOptions this
// NEVER throws: a missing or unreadable config file is the normal state for
// hosts that never configure custom endpoints, and a broken config must not
// take down the host process. Best-effort + one warning on failure.
let loadWarned = false;
export async function loadDeclaredModelEndpoints(): Promise<ModelEndpointPattern[]> {
    try {
        const text = await readFile(configFile(), "utf8");
        const json = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
        return parseModelEndpointPatterns(json.modelEndpointPatterns);
    } catch {
        if (!loadWarned) {
            loadWarned = true;
            console.error(`bili-native: could not resolve modelEndpointPatterns from ${configFile()}; declared endpoints stay unclaimed until the host restarts with a readable config`);
        }
        return [];
    }
}

/** Test hook: reset the one-shot warning flag. */
export function _resetLoadWarningForTest(): void {
    loadWarned = false;
}
