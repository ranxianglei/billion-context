// #5571 M1 (observation layer): native identity profile table for model-API
// clients.
//
// bili relays traffic from heterogeneous agent clients. Each client exposes
// its own native identity surface (session/message ids as headers or body
// fields) and its re-baseline signals (explicit compaction headers vs summary
// user-turn prefixes) on the wire. This table pins those facts per client so
// the observation layer (#5571 M1), the binding layer (M2 tail slot) and the
// re-baseline layer (M3) share ONE source instead of ad-hoc string checks.
//
// Provenance: binary forensics + local sample capture 2026-11-02/03 — issue
// #5571 collection table (WorkBuddy dsh / codex 0.147.0 / Claude Code /
// opencode 1.14.42 / Gemini CLI 0.3.66). The compaction prefix WORDING is a
// client-version surface: it may drift upstream. When that happens, fix the
// row here (+ unit tests) — do not hard-code literals anywhere else.
export type NidvClientId = "wb" | "codex" | "cc" | "opencode" | "gemini" | "unknown";

export interface NidvProfile {
    readonly id: NidvClientId;
    /** Header carrying the SESSION id (lowercase name). */
    readonly sessHeader?: string;
    /** Header carrying a PER-MESSAGE host id (strongest future tail-slot signal). */
    readonly msgHeader?: string;
    /** Header carrying a PER-REQUEST id. */
    readonly reqHeader?: string;
    /** Fork/lineage header. */
    readonly parentHeader?: string;
    /** Additional headers to capture — dynamic-capture items, spelling TBC. */
    readonly extraHeaders?: readonly string[];
    /** Body JSON paths for session-id cross-channel verification. */
    readonly bodySessPaths?: ReadonlyArray<readonly (string | number)[]>;
    /** User-turn text prefixes marking a client-side re-baseline (compaction). */
    readonly compactionPrefixes?: readonly string[];
    /** Explicit compaction indicator headers (presence = signal, strongest class). */
    readonly compactionHeaders?: readonly string[];
    /** URL path suffixes naming a dedicated compaction endpoint. */
    readonly compactPathSuffixes?: readonly string[];
    /** Marker substrings that must NOT appear in the request body
     *  (shape assertion; presence = protocol-drift event, never fatal here). */
    readonly shapeAssertAbsent?: readonly string[];
}

export type NidvCompactionSignal = "explicit-header" | "prefix-match" | "compact-endpoint" | null;

/** Per-request extraction result. Raw values live in MEMORY ONLY for the
 *  lifetime of this call — persistence stores sha1 digests (h8), logs never
 *  print full values. */
export interface NidvObservation {
    profileId: NidvClientId;
    /** Session id as seen on the primary channel (header or body path). */
    sessVal?: string;
    /** Cross-channel session value (e.g. cc metadata.user_id.session_id). */
    dualBodySessVal?: string;
    /** Per-message host id (wb only today). */
    msgVal?: string;
    /** Per-request id. */
    reqVal?: string;
    /** Fork/lineage marker (opencode x-parent-session-id, codex x-codex-parent-thread-id). */
    parentVal?: string;
    /** Count of intra-message tool anchors (cc `toolu_` occurrences; capped). */
    toolAnchorCount?: number;
    compactionSignal: NidvCompactionSignal;
    /** Which rule fired (header name / prefix text / suffix) — ≤64 chars. */
    compactionEvidence?: string;
    /** Shape assertion failure: marker that wrongly appeared in the body. */
    shapeAssertFail?: string;
}

const WB: NidvProfile = {
    id: "wb",
    sessHeader: "x-conversation-id",
    msgHeader: "x-conversation-message-id",
    reqHeader: "x-request-id",
    // Strongest re-baseline class in the fleet: explicit headers.
    compactionHeaders: ["x-compacted", "x-context-compacted"],
};

const CODEX: NidvProfile = {
    id: "codex",
    // Installation id is stable per machine (file ~/.codex/installation_id);
    // the thread/window header spellings are FORENSIC GUESSES pending a live
    // capture — capture them all when present, do not filter on them yet.
    extraHeaders: [
        "x-codex-installation-id",
        "x-client-request-id",
        "x-codex-window-id",
        "x-codex-turn-metadata",
        "x-codex-parent-thread-id",
        "x-openai-subagent",
    ],
    parentHeader: "x-codex-parent-thread-id",
    // Re-baseline: fixed lead sentence prepended after a local compact, plus
    // the dedicated server endpoint POST /responses/compact.
    compactionPrefixes: ["Another language model started to solve this problem"],
    compactPathSuffixes: ["/responses/compact"],
};

const CC: NidvProfile = {
    id: "cc",
    sessHeader: "x-claude-code-session-id",
    // Dual channel: metadata.user_id carries the same session id — encoded
    // either as a JSON STRING ("{\"session_id\":...}") or as a plain object,
    // depending on dialect/version. Path stops at user_id; extraction below
    // handles both encodings. Disagreement with the header is an incident
    // event, not a fallback.
    bodySessPaths: [["metadata", "user_id"]],
    compactionPrefixes: ["This session is being continued from a previous conversation"],
};

const OPENCODE: NidvProfile = {
    id: "opencode",
    sessHeader: "x-session-affinity",
    parentHeader: "x-parent-session-id",
    compactionPrefixes: ["What did we do so far?", "<previous-summary>"],
    // Research asserts ZERO message ids on the OpenAI-compatible wire; a
    // non-zero count means upstream changed its wire shape.
    shapeAssertAbsent: ["ses_", "msg_", "prt_"],
};

const GEMINI: NidvProfile = {
    // Generic path exposes no ids at all — the observation IS the absence.
    id: "gemini",
    compactionPrefixes: ["<state_snapshot>"],
};

const UNKNOWN: NidvProfile = { id: "unknown" };

function firstHeader(headers: Record<string, unknown>, name: string): string | undefined {
    const raw = headers[name];
    if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
    if (Array.isArray(raw) && typeof raw[0] === "string" && (raw[0] as string).length > 0) return raw[0] as string;
    return undefined;
}

/** Deterministic profile detection. Order matters and is pinned by tests:
 *  explicit per-client session headers outrank family markers, which outrank
 *  protocol inference. Never throws on odd inputs. */
export function detectNativeProfile(
    headers: Record<string, unknown>,
    urlPath: string,
    protocol: string | null,
): NidvProfile {
    void urlPath; // reserved for path-based markers (none needed at launch)
    if (WB.sessHeader && firstHeader(headers, WB.sessHeader)) return WB;
    if (CC.sessHeader && firstHeader(headers, CC.sessHeader)) return CC;
    if (OPENCODE.sessHeader && firstHeader(headers, OPENCODE.sessHeader)) return OPENCODE;
    if (firstHeader(headers, "x-codex-installation-id")) return CODEX;
    if (protocol === "responses" && firstHeader(headers, "x-client-request-id")) return CODEX;
    if (protocol === "google") return GEMINI;
    return UNKNOWN;
}

function walkPath(body: unknown, path: readonly (string | number)[]): unknown {
    let cur: unknown = body;
    for (const key of path) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string | number, unknown>)[key];
    }
    return cur;
}

/** Up to this many leading user texts are scanned for compaction prefixes —
 *  bounds cost on megabyte bodies while covering the real shape (the summary
 *  turn always sits near the head after a re-baseline). */
const USER_TEXT_SCAN_CAP = 3;
/** Max counted `toolu_` occurrences before we stop counting (value is an
 *  observation, not a ledger — capping is harmless). */
const TOOL_ANCHOR_CAP = 4096;

function extractUserTexts(parsedBody: unknown, protocol: string | null, cap: number): string[] {
    const out: string[] = [];
    if (!parsedBody || typeof parsedBody !== "object") return out;
    const b = parsedBody as Record<string, unknown>;
    const arr = protocol === "responses" ? b.input : b.messages;
    if (!Array.isArray(arr)) return out;
    for (const el of arr) {
        if (!el || typeof el !== "object") continue;
        const m = el as Record<string, unknown>;
        let text: unknown;
        if (protocol === "responses") {
            if (m.type !== "message" || m.role !== "user" || !Array.isArray(m.content)) continue;
            text = (m.content as Record<string, unknown>[]).map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
        } else {
            if (m.role !== "user") continue;
            if (typeof m.content === "string") text = m.content;
            else if (Array.isArray(m.content)) text = (m.content as Record<string, unknown>[]).map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
            else continue;
        }
        out.push(typeof text === "string" ? text : "");
        if (out.length >= cap) break;
    }
    return out;
}

function countOccurrences(haystack: string, needle: string, cap: number): number {
    let n = 0;
    let i = haystack.indexOf(needle);
    while (i !== -1 && n < cap) {
        n += 1;
        i = haystack.indexOf(needle, i + needle.length);
    }
    return n;
}

/** Pure per-request extraction. Total cost: a constant number of header
 *  lookups + bounded body walks; on a 1MB body well under a millisecond.
 *  Never throws. */
export function extractNativeIdentity(
    profile: NidvProfile,
    headers: Record<string, unknown>,
    urlPath: string,
    protocol: string | null,
    parsedBody: unknown,
    bodyText: string | undefined,
): NidvObservation {
    const obs: NidvObservation = { profileId: profile.id, compactionSignal: null };
    try {
        if (profile.id !== "unknown") {
            if (profile.sessHeader) obs.sessVal = firstHeader(headers, profile.sessHeader);
            if (profile.msgHeader) obs.msgVal = firstHeader(headers, profile.msgHeader);
            if (profile.reqHeader) obs.reqVal = firstHeader(headers, profile.reqHeader);
            if (profile.parentHeader) obs.parentVal = firstHeader(headers, profile.parentHeader);
            for (const p of profile.bodySessPaths ?? []) {
                const v = walkPath(parsedBody, p);
                if (typeof v === "string" && v.length > 0) {
                    if (v.startsWith("{")) {
                        try {
                            const inner = (JSON.parse(v) as Record<string, unknown>)?.session_id;
                            if (typeof inner === "string" && inner) obs.dualBodySessVal = inner;
                        } catch { /* malformed dual channel: ignore, header stands alone */ }
                    } else {
                        obs.dualBodySessVal = v;
                    }
                    break;
                }
                if (v !== null && typeof v === "object") {
                    const sid = (v as Record<string, unknown>).session_id;
                    if (typeof sid === "string" && sid.length > 0) { obs.dualBodySessVal = sid; break; }
                }
            }
        }

        // Re-baseline signal class 1 (strongest): explicit compaction header.
        for (const h of profile.compactionHeaders ?? []) {
            if (firstHeader(headers, h)) {
                obs.compactionSignal = "explicit-header";
                obs.compactionEvidence = h;
                return obs;
            }
        }
        // Class 2: dedicated compaction endpoint on the path.
        if (obs.compactionSignal === null) {
            for (const suf of profile.compactPathSuffixes ?? []) {
                if (urlPath.toLowerCase().endsWith(suf)) {
                    obs.compactionSignal = "compact-endpoint";
                    obs.compactionEvidence = suf;
                    return obs;
                }
            }
        }
        // Class 3: summary user-turn PREFIX — anchored at text START only. A
        // copy of the wording embedded mid-text must NOT fire (adversarial
        // case pinned by tests).
        if (obs.compactionSignal === null && profile.compactionPrefixes && profile.compactionPrefixes.length > 0) {
            for (const text of extractUserTexts(parsedBody, protocol, USER_TEXT_SCAN_CAP)) {
                if (!text) continue;
                for (const pref of profile.compactionPrefixes) {
                    if (text.startsWith(pref)) {
                        obs.compactionSignal = "prefix-match";
                        obs.compactionEvidence = pref.slice(0, 64);
                        break;
                    }
                }
                if (obs.compactionSignal !== null) break;
            }
        }

        // Client-specific assertions/counters.
        if (profile.id === "cc" && typeof bodyText === "string") {
            obs.toolAnchorCount = countOccurrences(bodyText, '"toolu_', TOOL_ANCHOR_CAP);
        }
        if (profile.shapeAssertAbsent && typeof bodyText === "string") {
            for (const marker of profile.shapeAssertAbsent) {
                if (bodyText.includes(marker)) {
                    obs.shapeAssertFail = marker;
                    break;
                }
            }
        }
    } catch {
        // Fail-open by construction: a broken profile row degrades to "no
        // observation", never to a failed request.
        obs.profileId = profile.id === "unknown" ? "unknown" : obs.profileId;
        obs.compactionSignal = obs.compactionSignal ?? null;
    }
    return obs;
}

/** Header view kept intentionally structural (not node:http-typed) so tests
 *  can feed plain objects and handle.ts can pass req.headers directly —
 *  IncomingHttpHeaders is structurally assignable to Record<string, unknown>. */
export type NidvHeaders = Record<string, unknown>;
